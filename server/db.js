'use strict';

// ONE async query interface over two SQLite backends, so server/repo.js (and
// every route above it) is written exactly once:
//
//   createD1Db(d1Binding)  — Cloudflare D1, for the Pages Functions.
//   createLocalDb(path)    — node:sqlite DatabaseSync, for the Express dev
//                            server and tests (':memory:' supported).
//
// Both return { all, first, run, batch, applyMigrations }: promises
// everywhere (the local backend just wraps its sync calls), rows as plain
// objects, run() -> { changes }. SQL/param errors are honest — they throw to
// the caller, which is the repo/route layer's cue that a GUARD is missing;
// client input never reaches raw SQL without repo.js sanitising it first.
//
// Bundling contract: this module requires only ./migrations (pure data).
// node:sqlite is required inside createLocalDb behind a try/catch, which makes
// esbuild treat it as an OPTIONAL require — so bundling for the Workers runtime
// (Cloudflare Pages / wrangler esbuild) does not fail to resolve the Node-only
// builtin. The Functions path imports createD1Db and never calls createLocalDb,
// so node:sqlite is only ever loaded on Node (dev server, tests).

const { MIGRATIONS } = require('./migrations');

// SQLite binds neither undefined nor booleans (node:sqlite throws on both,
// D1 is looser) — normalise here once so both backends accept the same
// params array: undefined -> NULL, true/false -> 1/0.
function bindable(params) {
  return (Array.isArray(params) ? params : []).map((p) => {
    if (p === undefined) return null;
    if (p === true) return 1;
    if (p === false) return 0;
    return p;
  });
}

// Split a migration file into single statements: a ';' at end-of-line ends a
// statement (so ';' inside a line — e.g. in a future seed string — would NOT
// split; migration files rule out string-literal ';' entirely, see the .sql
// header). Pieces that are only whitespace/'--' comments are dropped; leading
// comments attached to a real statement are fine, SQLite's parser skips them.
function splitStatements(sql) {
  return String(sql || '')
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.replace(/--[^\n]*/g, '').trim());
}

// Shared migration runner, expressed against the db interface itself so both
// backends get identical behaviour: a _migrations(name) ledger, each
// { name, sql } applied at most once, statements run in file order. Returns
// the names applied THIS call (so "twice = []" is observable). Passing
// nothing applies the embedded MIGRATIONS; tests pass their own arrays.
async function applyMigrationsTo(db, migrations) {
  const list = migrations === undefined ? MIGRATIONS : (Array.isArray(migrations) ? migrations : []);
  await db.run('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const rows = await db.all('SELECT name FROM _migrations');
  const done = new Set(rows.map((r) => r.name));
  const applied = [];
  for (const migration of list) {
    if (!migration || !migration.name || done.has(migration.name)) continue;
    for (const statement of splitStatements(migration.sql)) {
      await db.run(statement);
    }
    await db.run('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
      [migration.name, new Date().toISOString()]);
    applied.push(migration.name);
  }
  return applied;
}

// ---- Cloudflare D1 ----------------------------------------------------------
function createD1Db(d1) {
  const db = {
    async all(sql, params) {
      const result = await d1.prepare(sql).bind(...bindable(params)).all();
      return (result && result.results) || [];
    },
    async first(sql, params) {
      const row = await d1.prepare(sql).bind(...bindable(params)).first();
      // D1 returns null for no-row; guard undefined too so the contract is
      // exactly "row | null" on both backends.
      return row === undefined || row === null ? null : row;
    },
    async run(sql, params) {
      const result = await d1.prepare(sql).bind(...bindable(params)).run();
      const meta = (result && result.meta) || {};
      return { changes: typeof meta.changes === 'number' ? meta.changes : 0 };
    },
    // D1's native batch is a single atomic round-trip — the reason repo.js
    // funnels multi-write operations through batch instead of loops.
    async batch(statements) {
      const prepared = (statements || []).map((s) => d1.prepare(s.sql).bind(...bindable(s.params)));
      const results = await d1.batch(prepared);
      return (results || []).map((r) => ({
        changes: r && r.meta && typeof r.meta.changes === 'number' ? r.meta.changes : 0,
      }));
    },
    async applyMigrations(migrations) {
      return applyMigrationsTo(db, migrations);
    },
  };
  return db;
}

// ---- local node:sqlite --------------------------------------------------------
function createLocalDb(filePath) {
  // Lazy require in a try/catch ON PURPOSE: this is the only place in the
  // shared server/ tree that touches a Node-only builtin. The try/catch is
  // what lets the Workers bundle compile — esbuild treats a require() inside
  // try/catch as OPTIONAL and won't hard-fail to resolve node:sqlite (which
  // Cloudflare's wrangler esbuild otherwise does). The Functions path uses
  // createD1Db and never reaches here; on Node (dev server, tests) the require
  // succeeds — Node >= 22.5 ships node:sqlite unflagged (this repo targets 24).
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    throw new Error('createLocalDb needs node:sqlite (Node >= 22.5) — the '
      + 'Cloudflare Functions path uses createD1Db instead. '
      + (e && e.message ? '(' + e.message + ')' : ''));
  }
  const conn = new DatabaseSync(filePath || ':memory:');
  const db = {
    async all(sql, params) {
      // Spread each row into a fresh plain object: node:sqlite row prototypes
      // are an implementation detail, and plain objects keep deepStrictEqual
      // and JSON serialisation behaving like the D1 side.
      return conn.prepare(sql).all(...bindable(params)).map((row) => ({ ...row }));
    },
    async first(sql, params) {
      const row = conn.prepare(sql).get(...bindable(params));
      return row === undefined ? null : { ...row };
    },
    async run(sql, params) {
      const result = conn.prepare(sql).run(...bindable(params));
      return { changes: Number(result.changes) };
    },
    // Mirrors D1 batch semantics the cheap way: one transaction, all-or-
    // nothing. A failing statement rolls the whole batch back and rethrows.
    async batch(statements) {
      conn.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements || []) {
          const result = conn.prepare(s.sql).run(...bindable(s.params));
          out.push({ changes: Number(result.changes) });
        }
        conn.exec('COMMIT');
        return out;
      } catch (e) {
        try { conn.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    },
    async applyMigrations(migrations) {
      return applyMigrationsTo(db, migrations);
    },
    // Tests (and a tidy dev-server shutdown) can release the file handle;
    // no-op-safe if already closed.
    close() {
      try { conn.close(); } catch { /* already closed */ }
    },
  };
  return db;
}

module.exports = { createD1Db, createLocalDb, MIGRATIONS, splitStatements };
