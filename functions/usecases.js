// POST /usecases — the v3 ideation front door. One endpoint, three moves,
// dispatched by body shape so the wizard needs a single URL:
//   { brand, notes? }                       -> research only (dossier + a first proposal)
//   { brand, brief?, count?, feedback?, prior? } -> propose/reroll use-cases
//   { brand, idea }                          -> shape the team's own idea into one use-case
// The dossier is built (and KV-cached as dossier:<slug>) on every call, so the
// expensive research happens once per brand and every move stays grounded in it.

import brandResearchMod from '../server/brand-research.js';
import usecaseEngineMod from '../server/usecase-engine.js';
import storeMod from '../server/store.js';
import { applyEnv } from './_lib/env.js';
import { json, readJson } from './_lib/http.js';

const { buildDossier, hasResearchProvider } = brandResearchMod;
const { proposeUseCases, shapeUserIdea } = usecaseEngineMod;
// normalizeBrief comes from store.js, NOT server/history.js — history touches
// __dirname/fs at module load, which does not exist in the Workers bundle.
const { normalizeBrief, brandSlug, getBrandKit } = storeMod;

// The wire-shape is intentional, not a pass-through — new dossier internals
// (hashes, cache bookkeeping) must not leak into the UI contract by accident.
function publicDossier(d) {
  return {
    name: d.name,
    slug: d.slug,
    site: d.site || null,
    summary: d.summary || '',
    products: d.products || [],
    categories: d.categories || [],
    audiences: d.audiences || [],
    voice: d.voice || { adjectives: [], donts: [] },
    currentCampaigns: d.currentCampaigns || [],
    vertical: d.vertical || 'Generic',
    confidence: d.confidence,
    researchedAt: d.researchedAt,
  };
}

export async function onRequestPost({ request, env }) {
  applyEnv(env); // provider API keys reach the engines via process.env
  try {
    const b = await readJson(request);
    const brandName = (b.brand || '').trim() || 'Acme';
    const notes = typeof b.notes === 'string' ? b.notes.slice(0, 4000) : null;
    const dossier = await buildDossier({
      brandName, notes, kv: env.HISTORY, force: !!b.forceResearch,
    });
    // The brand kit (if the team saved one) lends its pasted voice sample to
    // every ideation prompt, and the response carries two boolean UI hints —
    // never the kit record itself, which stays a server-side concern.
    const kit = await getBrandKit(env.HISTORY, brandSlug(brandName));
    const voiceSample = (kit && typeof kit.voiceSample === 'string') ? kit.voiceSample : null;
    const kitFlags = {
      hasKit: !!kit,
      kitHasAssets: !!(kit && (kit.logoUrl || kit.heroUrl || voiceSample
        || (Array.isArray(kit.products) && kit.products.length))),
      // lets the UI tell "heuristic because no key" from "heuristic because
      // the LLM call didn't land this time" — the label was lying before.
      llmConfigured: hasResearchProvider(),
    };

    if (typeof b.idea === 'string' && b.idea.trim()) {
      const useCase = await shapeUserIdea({ idea: b.idea, dossier, voiceSample });
      return json({ useCase, dossier: { ...publicDossier(dossier), ...kitFlags } });
    }

    const { useCases, source } = await proposeUseCases({
      dossier,
      brief: normalizeBrief(b.brief),
      count: b.count,
      feedback: typeof b.feedback === 'string' ? b.feedback.slice(0, 500) : null,
      prior: Array.isArray(b.prior) ? b.prior.slice(0, 16).map(String) : null,
      voiceSample,
    });
    return json({ useCases, source, dossier: { ...publicDossier(dossier), ...kitFlags } });
  } catch (e) {
    return json({ error: e.message }, 400);
  }
}
