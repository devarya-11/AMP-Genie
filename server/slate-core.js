'use strict';

// The slate is the pitch deliverable: one brand + one brief fanned out into
// up to six validated builds — one per distinct interactive module — grouped
// under a single slate record the /s/<id> share page renders as a phone-frame
// grid. This lives beside (not inside) build-pipeline.js because a slate is
// pure orchestration: every per-build concern (brand kit, routing, LLM copy,
// generate(), validation, the persisted build record) already happens exactly
// once per createBuild call.
//
// Runtime-agnostic like the rest of server/: no HTTP types, no waitUntil —
// persistence goes through the injected kv handle, and the legacy history
// entries stay the CALLER's job (both /slate front doors derive them from the
// returned build records via buildHistoryEntry).

const { createBuild } = require('./build-pipeline');
const { MODULES, MODULE_IDS } = require('./generate');
const { routeBrief } = require('./brief-router');
const { normalizeBrief } = require('./history');
const { newId, putSlate } = require('./store');

// body: the parsed /slate request body (untrusted client JSON) —
//   { brand, brief?, count?, currency?, colorOverride?, vertical?, tone?,
//     copy?, author? }. Everything build-shaped is passed through to
//     createBuild unchanged, so an explicit vertical/tone/copy steers every
//     build in the slate the same way it steers a single /generate build.
// deps: { validate, kv } with the same meaning as createBuild's.
//   deps.createBuildImpl is a TEST-ONLY seam: it lets tests inject per-module
//   build failures without monkey-patching build-pipeline internals (the
//   builds run in parallel, so a call-counting wrapper would depend on
//   completion order). Production callers never set it.
// Returns { slate, builds, response }: slate is the grouping record, builds
// are the full per-module build records (already persisted when kv is live),
// response is the wire shape both /slate routes return.
async function createSlate(body, deps = {}) {
  const b = (body && typeof body === 'object') ? body : {};
  const { kv = null } = deps;
  const validate = deps.validate;
  if (typeof validate !== 'function') {
    throw new Error('createSlate requires a validate(ampHtml) dependency');
  }
  const build = deps.createBuildImpl || createBuild;

  const brand = (b.brand || '').trim() || 'Acme';
  const brief = normalizeBrief(b.brief);
  const author = typeof b.author === 'string' ? b.author.slice(0, 60) : null;

  // Module order: the brief's routed module leads the slate — it's the
  // concept the client actually asked for, so it must be the first phone on
  // the share page — and the rest follow in canonical MODULE_IDS order, so a
  // full slate covers every module exactly once with no duplicates.
  const routed = brief ? routeBrief(brief) : null;
  const order = routed
    ? [routed.moduleId, ...MODULE_IDS.filter((id) => id !== routed.moduleId)]
    : MODULE_IDS.slice();
  const count = Math.max(1, Math.min(Number(b.count) || 6, MODULE_IDS.length));
  const moduleIds = order.slice(0, count);

  // Minted before the builds so each build record carries its slateId from
  // birth — no second write to stitch the grouping on afterwards.
  const slateId = newId();

  // All builds run in parallel. Each createBuild may fan out to LLM providers
  // for brief copy, so a keys-configured deploy pays `count` compositions at
  // once — acceptable: a slate is generated live in a pitch, and demo-time
  // latency beats a sequential 6x wait.
  const settled = await Promise.allSettled(moduleIds.map((moduleId, i) => build({
    brand: b.brand,
    brief: b.brief,
    currency: b.currency,
    colorOverride: b.colorOverride,
    vertical: b.vertical,
    tone: b.tone,
    copy: b.copy,
    moduleId,
    counter: i,
    author,
  }, {
    validate, kv, author, slateId, useCase: MODULES[moduleId].name,
  })));

  // One failed build (provider meltdown, validator crash) must not sink the
  // slate — a pitch page with n-1 phones still pitches. Zero survivors is
  // different: nothing to show means the request itself failed.
  const builds = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') builds.push(s.value.build);
  }
  if (!builds.length) {
    const reason = settled[0] && settled[0].reason;
    throw new Error('createSlate: every build failed'
      + (reason && reason.message ? ` (first error: ${reason.message})` : ''));
  }

  const slate = {
    id: slateId,
    ts: new Date().toISOString(),
    author,
    brand,
    brief,
    title: brand + ' — pitch slate',
    buildIds: builds.map((x) => x.id),
    moduleIds: builds.map((x) => x.moduleId),
  };
  // Best-effort like every store write: putSlate never throws, and a failed
  // write only costs the share page, never the builds already returned.
  await putSlate(kv, slate);

  const response = {
    slateId,
    sharePath: '/s/' + slateId,
    brand,
    title: slate.title,
    builds: builds.map((x) => ({
      id: x.id,
      moduleId: x.moduleId,
      moduleName: x.moduleName,
      useCase: x.useCase,
      validation: { pass: x.validation.pass, errorCount: x.validation.errorCount },
      sharePath: '/b/' + x.id,
    })),
  };
  return { slate, builds, response };
}

module.exports = { createSlate };
