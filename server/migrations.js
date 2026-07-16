'use strict';

// GENERATED MIRROR of migrations/*.sql — the Workers runtime has no fs, so
// server/db.js applies migrations from these embedded strings while wrangler
// and local tooling can keep using the .sql files directly. The two copies
// MUST stay byte-identical: tests/db-repo.test.js compares them, so a schema
// edit that touches only one side fails the suite. Regenerate by pasting the
// .sql file verbatim between the backticks (it contains no backslashes,
// backticks or ${ by rule — see the header of the .sql file).
//
// Pure data module: no requires, nothing Node-only — bundles for Workers.

const MIGRATION_0001_INIT = `-- GENIE 2.0 phase 0 — initial schema (BRAND -> PITCHES -> EXAMPLES, plus the
-- brand-owned satellites: products, contacts, assets; app-wide settings and
-- an activity feed). D1-compatible SQLite: TEXT ids cut from
-- crypto.randomUUID (server/store.js newId — never AUTOINCREMENT), ISO-8601
-- TEXT timestamps, and no PRAGMAs (D1 owns its own journal settings).
--
-- MIRROR: server/migrations.js embeds this file as a JS string so the
-- Workers runtime can apply it without fs. tests/db-repo.test.js asserts the
-- two copies are byte-identical — edit BOTH or that test fails.
--
-- server/db.js splits migration files on ';' at end-of-line — keep one
-- statement per ';'-terminated block and never put a ';' inside a string
-- literal in a migration.

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  primary_hex TEXT,
  accent_hex TEXT,
  vertical TEXT,
  site TEXT,
  logo_url TEXT,
  hero_url TEXT,
  voice_sample TEXT,
  dossier_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  price INTEGER,
  image_url TEXT,
  asset_id TEXT,
  pos INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pitches (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  title TEXT NOT NULL,
  goal TEXT,
  brief TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- examples.brand_id is denormalised (stamped from the pitch at insert) so
-- brand-level counts and feeds never join through pitches; deliberately no
-- REFERENCES on it — pitch_id is the real parent. root_id/parent_id carry
-- the tweak-version lineage (v3.1 contract): a fresh example is its own
-- root, every accepted tweak is a new row pointing back.
CREATE TABLE IF NOT EXISTS examples (
  id TEXT PRIMARY KEY,
  pitch_id TEXT NOT NULL REFERENCES pitches(id),
  brand_id TEXT NOT NULL,
  title TEXT,
  module_id TEXT,
  params_json TEXT,
  doc_json TEXT,
  amp_html TEXT,
  validation_pass INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  root_id TEXT,
  tweak_prompt TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- storage_key points into the swappable byte store (KV today, R2 once the
-- account enables it); this row is the metadata source of truth either way.
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  kind TEXT NOT NULL DEFAULT 'image',
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  uploaded_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT,
  brand_id TEXT,
  pitch_id TEXT,
  verb TEXT NOT NULL,
  detail TEXT
);

-- brands.slug already carries the implicit UNIQUE index; these cover the
-- foreign-key lookups, the version-chain walk and the newest-first feed.
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_contacts_brand ON contacts(brand_id);
CREATE INDEX IF NOT EXISTS idx_pitches_brand ON pitches(brand_id);
CREATE INDEX IF NOT EXISTS idx_examples_pitch ON examples(pitch_id);
CREATE INDEX IF NOT EXISTS idx_examples_brand ON examples(brand_id);
CREATE INDEX IF NOT EXISTS idx_examples_root ON examples(root_id);
CREATE INDEX IF NOT EXISTS idx_assets_brand ON assets(brand_id);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);
CREATE INDEX IF NOT EXISTS idx_activity_brand ON activity(brand_id);
`;

const MIGRATION_0002_BRAND_IMAGES = `-- GENIE 2.0 phase 1 — brand_images: a brand's OWN curated pictures, and the
-- TOP rung of the image ladder (they win over the scraped og:image, the
-- Openverse CC0 floor and the loremflickr floor beneath them). Every row is a
-- real https URL: source 'manual' is a pasted link, source 'upload' is a file
-- put in R2 and served back as a URL — ONE table so the ladder and the UI
-- never care how a picture arrived. kind buckets a row as 'hero', 'product'
-- or 'other'; pos orders the list; alt is optional description text. Additive
-- and safe: CREATE ... IF NOT EXISTS only, no existing table is touched.
--
-- MIRROR: server/migrations.js embeds this file as a JS string so the Workers
-- runtime can apply it without fs. tests/db-repo.test.js asserts the two
-- copies are byte-identical — edit BOTH or that test fails.
--
-- server/db.js splits migration files on ';' at end-of-line — keep one
-- statement per ';'-terminated block and never put a ';' inside a string
-- literal in a migration.

CREATE TABLE IF NOT EXISTS brand_images (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  alt TEXT,
  pos INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brand_images_brand ON brand_images(brand_id);
`;

// Ordered list of every migration, in the { name, sql } shape
// db.applyMigrations() consumes. Append-only: a shipped migration is never
// edited, schema changes arrive as 0002, 0003, ...
const MIGRATIONS = [
  { name: '0001_init', sql: MIGRATION_0001_INIT },
  { name: '0002_brand_images', sql: MIGRATION_0002_BRAND_IMAGES },
];

module.exports = { MIGRATIONS };
