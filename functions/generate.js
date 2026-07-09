// POST /generate — the single source of truth for AMP output. Direct port of
// the Express /generate route (server/index.js): concurrent brand colour + logo
// lookup, deterministic keyword routing, optional LLM brief composition, then
// generate() + real validation, with the build appended to KV history.

import generateMod from '../server/generate.js';
import brandMod from '../server/brand.js';
import briefContentMod from '../server/brief-content.js';
import briefRouterMod from '../server/brief-router.js';
import { validate } from './_lib/validator.js';
import { appendHistory, normalizeBrief } from './_lib/history.js';
import { applyEnv } from './_lib/env.js';
import { json, readJson } from './_lib/http.js';

const { generate, pickModuleId } = generateMod;
const { resolveBrandColor, resolveBrandLogo } = brandMod;
const { composeContent } = briefContentMod;
const {
  routeBrief, briefSignals, inferVertical, inferTone,
} = briefRouterMod;

export async function onRequestPost({ request, env, waitUntil }) {
  applyEnv(env); // provider API keys reach brief-content/llm-providers via process.env
  try {
    const b = await readJson(request);
    const brand = (b.brand || '').trim() || 'Acme';
    // Colour and logo are independent live-fetch lookups — run concurrently so a
    // real-logo lookup never adds latency on top of the colour resolver's. Each
    // has its own timeout budget and degrades to null/placeholder independently.
    const [colorResolved, logoResolved] = await Promise.all([
      resolveBrandColor({ brandName: brand, hexOverride: b.colorOverride }),
      resolveBrandLogo({ brandName: brand }),
    ]);
    const brief = normalizeBrief(b.brief);
    // Industry and tone are no longer supplied by the UI — infer them from the
    // brand + brief so the backend understands the brand on its own. An explicit
    // b.vertical / b.tone (e.g. from an API caller) still overrides.
    const vertical = b.vertical || inferVertical(brand, brief);
    const tone = b.tone || inferTone(brief);
    // Tier-1 deterministic keyword routing: a brief's wording picks the module
    // unless the caller set an explicit b.moduleId (which always wins).
    const routed = brief ? routeBrief(brief, vertical) : null;
    const moduleId = pickModuleId({ brand, counter: b.counter, moduleId: b.moduleId || (routed && routed.moduleId) });
    const plan = brief
      ? await composeContent(brief, {
        moduleId, vertical, brandName: brand, tone,
      })
      : null;
    // Real fetched logo/site is the base layer; brief-driven plan overrides it;
    // an explicit manual copy override always wins, field by field.
    const logoCopy = logoResolved ? { logoUrl: logoResolved.logoUrl, site: logoResolved.site } : {};
    // Deterministic numbers the brief states outright (e.g. "40%") — the LLM
    // plan is structurally barred from setting these, so the headline it writes
    // and the big "X% OFF" the module renders would otherwise disagree.
    const briefSig = brief ? briefSignals(brief) : {};
    const manualCopy = (b.copy && typeof b.copy === 'object' && !Array.isArray(b.copy)) ? b.copy : {};
    const copy = { ...logoCopy, ...briefSig, ...(plan || {}), ...manualCopy };
    const g = generate({
      brand,
      vertical,
      tone,
      currency: b.currency,
      color: colorResolved.primary,
      moduleId,
      counter: b.counter,
      copy,
    });
    const validation = await validate(g.ampHtml);
    // `applied: false` marks the case where an explicit b.moduleId overrode the
    // router's suggestion — kept for audit even though it didn't win.
    const routedFromBrief = routed
      ? {
        moduleId: routed.moduleId, confidence: routed.confidence, matchedTerms: routed.matchedTerms, applied: !b.moduleId,
      }
      : null;
    const out = {
      ...g, colorSource: colorResolved.source, validation, brief, routedFromBrief,
    };
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      ts: new Date().toISOString(),
      brand: g.brand,
      vertical: g.vertical,
      tone: g.tone,
      moduleId: g.moduleId,
      moduleName: g.moduleName,
      colorSource: colorResolved.source,
      palette: g.palette,
      brief,
      routedFromBrief,
      validationPass: validation.pass,
      ampHtml: g.ampHtml,
    };
    // Persist to KV without blocking the response (history is a review aid; a
    // write failure must never fail the build).
    const write = appendHistory(env.HISTORY, entry);
    if (waitUntil) waitUntil(write); else await write;
    return json(out);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
}
