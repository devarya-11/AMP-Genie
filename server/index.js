'use strict';

const path = require('path');
const express = require('express');

// Loads .env (gitignored, local-only) into process.env if present — this is
// how GEMINI_API_KEY / GROQ_API_KEY / OLLAMA_BASE_URL etc. reach
// server/brief-content.js's provider auto-detection without needing to be
// exported in the shell every time. A no-op (never throws) when .env is
// absent, so nothing breaks for anyone who sets real env vars another way.
// Resolved relative to this file (not process.cwd()) so it still finds the
// repo's .env when the process is launched from a different working
// directory (e.g. an external tool that starts `node <abs-path>/server/index.js`
// from elsewhere) — dotenv's default is cwd-relative and silently loads 0
// vars in that case, degrading brief-content generation without any error.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { generate, pickModuleId, MODULE_IDS, MODULES, VERTICALS, CURRENCIES, derivePalette } = require('./generate');
const { TONES } = require('./content');
const { validate } = require('./validator');
const { resolveBrandColor, resolveBrandLogo, libVertical } = require('./brand');
const { dispatch } = require('./dispatch');
const { readHistory, appendHistory, normalizeBrief, MAX_ENTRIES } = require('./history');
const { composeContent } = require('./brief-content');
const {
  routeBrief, briefSignals, inferVertical, inferTone,
} = require('./brief-router');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- CORS locked to the genie's own origin ---------------------------------
const PORT = Number(process.env.PORT) || 4000;
const SELF_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && SELF_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- metadata for the UI's dropdowns ---------------------------------------
app.get('/api/meta', (req, res) => {
  res.json({
    verticals: VERTICALS,
    tones: Object.keys(TONES),
    currencies: Object.keys(CURRENCIES),
    modules: MODULE_IDS.map((id) => ({ id, name: MODULES[id].name, kind: MODULES[id].kind })),
  });
});

// ---- brand colour / guideline resolution -----------------------------------
app.post('/brand', async (req, res) => {
  try {
    const { brandName, hexOverride } = req.body || {};
    const resolved = await resolveBrandColor({ brandName, hexOverride });
    const palette = derivePalette(resolved.primary);
    const vertical = libVertical(brandName);
    res.json({ ...resolved, palette, vertical });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- generate: the single source of truth for AMP output ------------------
app.post('/generate', async (req, res) => {
  try {
    const b = req.body || {};
    const brand = (b.brand || '').trim() || 'Acme';
    // Colour and logo are independent live-fetch lookups against the same
    // guessed brand domain(s) — run them concurrently rather than back to
    // back so a real-logo lookup never adds its own extra latency on top of
    // the colour resolver's (each already has its own timeout budget and
    // degrades to null/placeholder independently, so a failure in one can't
    // affect the other).
    const [colorResolved, logoResolved] = await Promise.all([
      resolveBrandColor({ brandName: brand, hexOverride: b.colorOverride }),
      resolveBrandLogo({ brandName: brand }),
    ]);
    // "" / whitespace-only is normalized to null (no brief given).
    const brief = normalizeBrief(b.brief);
    // Industry and tone are no longer supplied by the UI — infer them from the
    // brand + brief so the backend understands the brand on its own. An explicit
    // b.vertical / b.tone (e.g. from an API caller) still overrides.
    const vertical = b.vertical || inferVertical(brand, brief);
    const tone = b.tone || inferTone(brief);
    // Tier-1 deterministic keyword routing: when a brief is given and the
    // caller didn't explicitly pick a module, the brief's own wording decides
    // which module gets built (an explicit b.moduleId always still wins).
    const routed = brief ? routeBrief(brief, vertical) : null;
    // Resolved once, up front, so the same module a plain generate() call
    // would pick is known before asking the LLM to write copy for it.
    const moduleId = pickModuleId({ brand, counter: b.counter, moduleId: b.moduleId || (routed && routed.moduleId) });
    const plan = brief
      ? await composeContent(brief, {
        moduleId, vertical, brandName: brand, tone,
      })
      : null;
    // Real fetched logo/site is the base layer — never a first choice over
    // brief-driven or manual copy (neither of which currently sets logoUrl,
    // but this ordering keeps that guarantee true if either ever does), and
    // falls all the way back to generate.js's own placeholder image when
    // logoResolved is null (unreachable site, no og:image/favicon found, or
    // blank brand name).
    const logoCopy = logoResolved ? { logoUrl: logoResolved.logoUrl, site: logoResolved.site } : {};
    // Deterministic numbers the brief states outright (e.g. "40%"): the LLM
    // plan is structurally barred from setting the offer amount, so without
    // this the headline it writes and the big "X% OFF" the module renders
    // would disagree. Sits above logo/below manual copy — an explicit
    // b.copy.discount still wins.
    const briefSig = brief ? briefSignals(brief) : {};
    // An explicit manual copy override (if the caller sent one) always wins
    // over the LLM's plan, field by field.
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
    // `applied: false` marks the case where an explicit b.moduleId overrode
    // the router's suggestion — kept in the response/history for audit even
    // though it didn't win.
    const routedFromBrief = routed
      ? { moduleId: routed.moduleId, confidence: routed.confidence, matchedTerms: routed.matchedTerms, applied: !b.moduleId }
      : null;
    const out = { ...g, colorSource: colorResolved.source, validation, brief, routedFromBrief };
    appendHistory({
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
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- history: past builds, newest first, for later review -----------------
// A pure review aid — read-only, capped, never affects generation.
app.get('/history', (req, res) => {
  res.json({ items: readHistory(), max: MAX_ENTRIES });
});

// ---- validate: re-run the real validator on (possibly edited) AMP ---------
app.post('/validate', async (req, res) => {
  try {
    const v = await validate(req.body.ampHtml || '');
    res.json(v);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- dispatch: real send-to-inbox path -------------------------------------
app.post('/dispatch', async (req, res) => {
  const result = await dispatch(req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

// ---- static web UI ----------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'web')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`AMP Genie on http://localhost:${PORT}`));
}

module.exports = { app };
