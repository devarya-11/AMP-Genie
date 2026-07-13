'use strict';

// Express bindings for the Genie 2.0 pitch-workspace API. Node-only by
// charter (this file knows req/res); ALL behaviour lives in
// server/pitch-api.js's pure handlers, so these routes are parse -> handler
// -> res.status(...).json(...) and nothing else — the Pages Functions under
// functions/api/** perform the exact same mapping, which is what keeps the
// two runtimes wire-identical by construction.
//
// registerPitchRoutes(app, ctx): app is an Express app (json body parsing
// already mounted, as server/index.js does), ctx is createPitchApi's context
// ({ repo, storage, kv, validate, llmProviders }).

const { createPitchApi } = require('./pitch-api');

function registerPitchRoutes(app, ctx) {
  const api = createPitchApi(ctx);
  const send = (res, out) => res.status(out.status).json(out.json);
  const body = (req) => ((req.body && typeof req.body === 'object') ? req.body : {});

  // ---- brands -----------------------------------------------------------------
  app.get('/api/brands', async (req, res) => send(res, await api.listBrandsH()));
  app.post('/api/brands', async (req, res) => {
    const b = body(req);
    send(res, await api.createBrandH({ name: b.name, notes: b.notes, author: b.author }));
  });
  // by-slug is declared BEFORE /api/brands/:id — Express matches in order,
  // and 'by-slug' must never be read as an :id.
  app.get('/api/brands/by-slug/:slug', async (req, res) => {
    send(res, await api.getBrandBySlugH({ slug: req.params.slug }));
  });
  app.get('/api/brands/:id', async (req, res) => send(res, await api.getBrandH({ id: req.params.id })));
  app.post('/api/brands/:id/kit', async (req, res) => {
    const b = body(req);
    send(res, await api.updateBrandKitH({
      id: req.params.id, patch: b.patch, products: b.products, author: b.author,
    }));
  });
  app.get('/api/brands/:id/activity', async (req, res) => {
    send(res, await api.brandActivityH({ brandId: req.params.id }));
  });

  // ---- contacts ---------------------------------------------------------------
  // The contact may arrive wrapped ({ contact: {...}, author }) or bare
  // ({ name, role, ... }) — both are accepted, identically in both runtimes.
  app.post('/api/brands/:id/contacts', async (req, res) => {
    const b = body(req);
    send(res, await api.addContactH({
      brandId: req.params.id,
      contact: b.contact !== undefined ? b.contact : b,
      author: b.author,
    }));
  });
  app.patch('/api/contacts/:id', async (req, res) => {
    const b = body(req);
    send(res, await api.updateContactH({
      id: req.params.id,
      contact: b.contact !== undefined ? b.contact : b,
    }));
  });
  app.delete('/api/contacts/:id', async (req, res) => {
    send(res, await api.deleteContactH({ id: req.params.id }));
  });

  // ---- pitches ----------------------------------------------------------------
  app.get('/api/pitches', async (req, res) => send(res, await api.listPitchesH()));
  app.post('/api/pitches', async (req, res) => {
    const b = body(req);
    send(res, await api.createPitchH({
      brandId: b.brandId, title: b.title, goal: b.goal, brief: b.brief, author: b.author,
    }));
  });
  app.get('/api/pitches/:id', async (req, res) => send(res, await api.getPitchH({ id: req.params.id })));
  // Same wrapped-or-bare tolerance as contacts: { patch: {...} } or the
  // patch fields at the top level.
  app.patch('/api/pitches/:id', async (req, res) => {
    const b = body(req);
    send(res, await api.updatePitchH({
      id: req.params.id,
      patch: b.patch !== undefined ? b.patch : b,
    }));
  });
  app.post('/api/pitches/:id/examples', async (req, res) => {
    const b = body(req);
    send(res, await api.createExampleH({
      pitchId: req.params.id,
      title: b.title,
      moduleId: b.moduleId,
      brief: b.brief,
      contentPlan: b.contentPlan,
      author: b.author,
    }));
  });

  // ---- examples ---------------------------------------------------------------
  app.get('/api/examples/:id', async (req, res) => send(res, await api.getExampleH({ id: req.params.id })));
  // Resolve ANY example to an editable block doc (a doc example returns its
  // doc; a legacy interactive example is synthesized into one). GET, so it is a
  // SEPARATE path from the PATCH /api/examples/:id/doc save-edit route.
  app.get('/api/examples/:id/as-doc', async (req, res) => {
    send(res, await api.exampleToDocH({ id: req.params.id }));
  });
  app.post('/api/examples/:id/tweak', async (req, res) => {
    const b = body(req);
    send(res, await api.tweakExampleH({
      id: req.params.id, prompt: b.prompt, author: b.author,
    }));
  });

  // ---- doc editor (phase 4) ---------------------------------------------------
  // The visual block-email editor's backend: a pure live-preview renderer, a
  // save-new + save-edit for doc examples, and an AI starter-doc drafter.
  app.post('/api/docs/render', async (req, res) => {
    const b = body(req);
    send(res, await api.renderDocH({ doc: b.doc !== undefined ? b.doc : b, anchors: b.anchors }));
  });
  app.post('/api/docs/custom-amp', async (req, res) => {
    const b = body(req);
    send(res, await api.customAmpH({ raw: b.raw }));
  });
  app.post('/api/pitches/:id/doc-examples', async (req, res) => {
    const b = body(req);
    send(res, await api.createDocExampleH({
      pitchId: req.params.id, title: b.title, doc: b.doc, author: b.author,
    }));
  });
  app.patch('/api/examples/:id/doc', async (req, res) => {
    const b = body(req);
    send(res, await api.updateDocExampleH({
      id: req.params.id, doc: b.doc, author: b.author,
    }));
  });
  app.post('/api/pitches/:id/ai-doc', async (req, res) => {
    const b = body(req);
    send(res, await api.aiDocH({
      pitchId: req.params.id, brief: b.brief, useCase: b.useCase, moduleId: b.moduleId, author: b.author,
    }));
  });
}

module.exports = { registerPitchRoutes };
