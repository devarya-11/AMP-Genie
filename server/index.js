'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const { generate, derivePalette, MODULES, MODULE_IDS, VERTICALS, CURRENCIES } = require('./generate');
const { validate } = require('./validator');
const { brandRead } = require('./brand');
const { dispatch } = require('./dispatch');
const { checkDeliverability } = require('./deliverability');
const { preflight } = require('./preflight');
const visual = require('./visual');
const assets = require('./assets');
const build = require('./build');
// Composition root only: the server wires the Vertical Reference System in here,
// so server/build.js itself stays reference-agnostic (it takes opts.form +
// opts.aesthetic and nothing else). reference/ knows server/; not the reverse.
const { generateWithForm } = require('../reference/integrate');

const app = express();
app.use(express.json({ limit: '2mb' }));
// amp-form posts its fields as application/x-www-form-urlencoded, so parse that
// too — lets the demo echo read the real submitted wishlist_count/skus.
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ---- CORS locked to the genie's own origin ---------------------------------
const PORT = Number(process.env.PORT) || 4000;
const SELF_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && SELF_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  // AMP-form CORS handshake: the amp-form runtime appends __amp_source_origin to
  // every action-xhr request and only accepts the response if it echoes that
  // value back in AMP-Access-Control-Allow-Source-Origin (exposed via
  // Access-Control-Expose-Headers). This lets the local wishlist demo complete a
  // real select→submit→thank-you cycle in the browser. Harmless to other routes.
  const ampSrc = req.query && req.query.__amp_source_origin;
  if (ampSrc) {
    res.setHeader('AMP-Access-Control-Allow-Source-Origin', ampSrc);
    res.setHeader('Access-Control-Expose-Headers', 'AMP-Access-Control-Allow-Source-Origin');
    if (!res.getHeader('Access-Control-Allow-Origin')) {
      res.setHeader('Access-Control-Allow-Origin', ampSrc);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- profile -> generate opts bridge ---------------------------------------
function paletteFromProfile(profile) {
  if (!profile || !profile.palette || !profile.palette.primary) return null;
  const pal = derivePalette(profile.palette.primary);
  if (profile.palette.accent) {
    const a = derivePalette(profile.palette.accent).primary;
    pal.accent = a;
  }
  return pal;
}
function optsFromBody(body) {
  const p = body.brandProfile;
  const opts = {
    brand: body.brand || (p && p.name) || 'Acme',
    vertical: body.vertical || (p && p.vertical) || 'Generic',
    tone: body.tone || (p && p.tone) || 'Playful',
    currency: body.currency || (p && p.currency) || 'INR',
    counter: Number.isFinite(body.counter) ? body.counter : 0,
    moduleId: body.moduleId,
  };
  if (body.color) opts.color = body.color;
  const pal = paletteFromProfile(p);
  if (pal && !body.color) opts.palette = pal;
  return opts;
}

// ---- routes ----------------------------------------------------------------
app.get('/api/meta', (req, res) => {
  res.json({
    verticals: VERTICALS,
    tones: ['Playful', 'Premium', 'Urgent', 'Informative'],
    currencies: Object.keys(CURRENCIES),
    modules: MODULE_IDS.map((id) => ({ id, name: MODULES[id].name, kind: MODULES[id].kind })),
    prodModules: build.PROD_MODULE_IDS.map((id) => ({ id, name: build.MODULES[id].name, kind: build.MODULES[id].kind, group: build.MODULES[id].group || 'Other' })),
  });
});

// ---- Stage 2: asset-driven production builder ------------------------------
app.post('/resolve-assets', async (req, res) => {
  try { res.json(await assets.resolveAssets(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/build', async (req, res) => {
  try {
    const b = req.body || {};
    const need = b.need || { logo: true, products: 3 };
    const resolved = await assets.resolveAssets({
      brandUrl: b.brandUrl, brandName: b.brandName,
      vertical: b.vertical, tone: b.tone, currency: b.currency,
      user: b.user || {}, need,
    });
    let moduleId = b.moduleId;
    if (!moduleId || moduleId === 'auto') moduleId = build.chooseModule(resolved.brand.vertical, (resolved.brand.name || '') + (b.reroll || 0));
    const built = build.buildProduction({ moduleId, resolved, currency: b.currency, copy: b.copy, reroll: b.reroll, endpoint: b.endpoint, fulfillmentPath: b.fulfillmentPath });
    const validation = await validate(built.ampHtml);
    res.json({
      ampHtml: built.ampHtml,
      htmlFallback: built.htmlFallback, textFallback: built.textFallback,
      subject: built.subject, preheader: built.preheader, fromName: built.fromName,
      moduleId: built.moduleId, moduleName: built.moduleName, kind: built.kind,
      brand: resolved.brand, palette: resolved.palette,
      provenance: resolved.provenance, summary: resolved.summary,
      context: built.context,
      accessibility: built.accessibility,
      validation,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- the "new genie": build THROUGH the Vertical Design Reference System -----
// Same response shape as /build, but the email's section order + form directives
// come from the client's vertical (FORM), while every concrete value still comes
// from the resolved client context (IDENTITY). The orchestrator runs both
// assertion guards, so a 200 here PROVES no reference value rode along.
app.post('/build-vertical', async (req, res) => {
  try {
    const b = req.body || {};
    const built = await generateWithForm({
      brandUrl: b.brandUrl, brandName: b.brandName, clientName: b.clientName || b.brandName,
      vertical: b.vertical, tone: b.tone, currency: b.currency,
      user: b.user || {}, need: b.need || { logo: true, products: 3 },
      moduleId: b.moduleId, intent: b.intent, copy: b.copy, reroll: b.reroll, endpoint: b.endpoint,
      fulfillmentPath: b.fulfillmentPath,
    });
    const validation = await validate(built.ampHtml);
    res.json({
      ampHtml: built.ampHtml,
      htmlFallback: built.htmlFallback, textFallback: built.textFallback,
      subject: built.subject, preheader: built.preheader, fromName: built.fromName,
      moduleId: built.moduleId, moduleName: built.moduleName, kind: built.kind,
      context: built.context,
      form: built.form, formMeta: built.formMeta,
      accessibility: built.accessibility,
      validation,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/brand-read', async (req, res) => {
  try {
    const profile = await brandRead(req.body.url || req.body.brand || '');
    res.json(profile);
  } catch (e) {
    res.status(200).json({ error: 'brand-read failed', detail: e.message });
  }
});

app.post('/generate', async (req, res) => {
  try {
    const g = generate(optsFromBody(req.body));
    const v = await validate(g.ampHtml);
    res.json({ ...g, validation: v });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/validate', async (req, res) => {
  try {
    const v = await validate(req.body.ampHtml || '');
    res.json(v);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/render-visuals', async (req, res) => {
  try {
    const out = await visual.renderVisuals(req.body);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/dispatch', async (req, res) => {
  const result = await dispatch(req.body);
  res.status(result.ok ? 200 : 400).json(result);
});

// ---- Phase 1.3: deliverability (real SPF/DKIM/DMARC) + registration --------
app.post('/deliverability', async (req, res) => {
  try {
    const out = await checkDeliverability(req.body.domain || req.body.email || req.body.brandUrl || '');
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e) { res.status(400).json({ ok: false, error: 'Deliverability check failed: ' + e.message }); }
});

// ---- Phase 1.3: pre-send checks (spam estimate, size, image weight, HTTPS) -
app.post('/preflight', async (req, res) => {
  try {
    const out = await preflight(req.body || {});
    res.json(out);
  } catch (e) { res.status(400).json({ ok: false, error: 'Pre-send check failed: ' + e.message }); }
});

// ---- lightweight local history --------------------------------------------
const HISTORY_FILE = path.join(__dirname, '..', '.history.json');
function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function writeHistory(list) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2)); } catch { /* ignore */ }
}
app.get('/history', (req, res) => res.json(readHistory()));
app.post('/history', (req, res) => {
  const list = readHistory();
  const entry = { id: Date.now().toString(36), starred: false, createdAt: new Date().toISOString(), ...req.body };
  list.unshift(entry);
  writeHistory(list.slice(0, 100));
  res.json(entry);
});
app.post('/history/:id', (req, res) => {
  const list = readHistory();
  const i = list.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  if (req.body.trash) { list.splice(i, 1); writeHistory(list); return res.json({ ok: true }); }
  list[i] = { ...list[i], ...req.body };
  writeHistory(list);
  res.json(list[i]);
});

// ---- demo-only echo backend (live wishlist flow proof) ---------------------
// A safe, no-op endpoint so the local demo can complete a real amp-form cycle:
// submit -> submitting -> success (thank-you), and ?fail=1 -> error (retry).
// It never stores anything; it only echoes the AMP-CORS handshake (handled by
// the global middleware above) and returns the JSON shape the wishlist module's
// on="submit-success/submit-error" handlers expect.
// amp-form posts as multipart/form-data, which neither express.json nor
// express.urlencoded parses. We don't want to pull in a multipart dependency for
// a demo route, so this minimal extractor pulls the simple text fields out of a
// raw multipart body — enough to confirm, server-side, exactly what the email
// transmitted (count + the real SKUs + tracking inputs).
function parseMultipart(buf, contentType) {
  const out = {};
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m || !Buffer.isBuffer(buf) || !buf.length) return out;
  const boundary = '--' + (m[1] || m[2]).trim();
  for (const part of buf.toString('latin1').split(boundary)) {
    const nameM = /content-disposition:\s*form-data;[^\r\n]*\bname="([^"]+)"/i.exec(part);
    if (!nameM || /\bfilename="/i.test(part)) continue; // skip file parts
    const idx = part.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const val = part.slice(idx + 4).replace(/\r\n--\s*$/, '').replace(/\r\n$/, '');
    out[nameM[1]] = Buffer.from(val, 'latin1').toString('utf8');
  }
  return out;
}
function demoEcho(req, res) {
  if (req.query && req.query.fail) {
    return res.status(500).json({
      status: 'error',
      message: 'Demo backend forced an error. Please try again.',
    });
  }
  // Body may arrive as a raw multipart Buffer (amp-form) or as already-parsed
  // JSON/urlencoded (direct callers). Normalise both.
  const b = Buffer.isBuffer(req.body)
    ? parseMultipart(req.body, req.headers['content-type'])
    : (req.body || {});
  const count = Number(b.wishlist_count) || 0;
  const skus = String(b.wishlist_skus || '').split(',').filter(Boolean);
  // Echo back what we received so the proof is end-to-end (the email's success
  // panel uses its own client-derived count; this confirms server receipt).
  res.json({
    status: 'success',
    message: count ? `Wishlist saved — ${count} item(s) received.` : 'Wishlist saved.',
    count,
    skus,
    received: { subscriber_email: b.subscriber_email || null, campaign_id: b.campaign_id || null, request_form_type: b.request_form_type || null },
  });
}
// Route-scoped raw parser for the multipart amp-form body (other routes keep
// their json/urlencoded parsing; multipart bodies slip past those untouched).
app.post('/_demo/wishlist-echo', express.raw({ type: 'multipart/form-data', limit: '2mb' }), demoEcho);

// Demo open/click tracking collectors so the live page's open-track amp-list and
// click_form complete a real round-trip (200) instead of failing against the
// placeholder default host. Open-track is an amp-list → must return { items }.
app.get('/_demo/track-open', (req, res) => res.json({ items: [{ ok: true }] }));
app.post('/_demo/track-click', express.raw({ type: 'multipart/form-data', limit: '2mb' }), (req, res) => res.json({ status: 'success' }));

// ---- static web UI ---------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'web')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`AMP Genie on http://localhost:${PORT}`));
}

module.exports = { app, paletteFromProfile, optsFromBody };
