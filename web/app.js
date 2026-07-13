(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // ---------- state: one object, one source of truth ----------
  const S = {
    meta: null,            // /api/meta (module id -> friendly name)
    pitches: [],
    // new-pitch wizard
    wBrand: null,          // brand row from POST /api/brands
    wContacts: [],
    // workspace
    pitch: null, examples: [], brand: null, assets: [], contacts: [],
    example: null, versions: [], proposals: [],
    keysLoaded: false,
  };

  // ---------- identity: attribution, not auth ----------
  const AUTHOR_KEY = 'genieAuthor';
  function author() { try { return (localStorage.getItem(AUTHOR_KEY) || '').trim() || null; } catch (e) { return null; } }

  // ---------- fetch helpers ----------
  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  }
  async function req(method, path, body) {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }
  async function getJson(path) { const r = await fetch(path); return r.json(); }
  // Tolerant list extraction — the API wraps lists as {ok, <name>: []}.
  function listOf(data, keys) {
    for (const k of keys) if (data && Array.isArray(data[k])) return data[k];
    return Array.isArray(data) ? data : [];
  }

  // ---------- tiny dom helpers ----------
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function chip(box, k, v) { const c = el('span', 'chip'); c.innerHTML = '<b>' + escapeHtml(String(k)) + '</b> ' + escapeHtml(String(v)); box.appendChild(c); return c; }
  function setLine(id, t, loading) {
    const s = $(id); if (!s) return;
    s.innerHTML = ''; s.classList.toggle('err', !loading && /^error/i.test(t || ''));
    if (loading) { const sp = document.createElement('span'); sp.className = 'spinner'; s.appendChild(sp); }
    if (t) s.appendChild(document.createTextNode(t));
  }
  // Generic button loading state: spinner in, label back out.
  function busy(btn, on, label) {
    if (on) {
      if (!btn.dataset.orig) btn.dataset.orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + (label ? ' ' + escapeHtml(label) : '');
    } else {
      btn.disabled = false;
      if (btn.dataset.orig) { btn.innerHTML = btn.dataset.orig; delete btn.dataset.orig; }
    }
  }
  function flash(node, msg) {
    const isBtn = node.tagName === 'BUTTON';
    if (isBtn) { const o = node.innerHTML; node.innerHTML = '<svg class="ic"><use href="#i-check"/></svg> ' + escapeHtml(msg); setTimeout(() => { node.innerHTML = o; }, 1600); }
    else { node.textContent = msg; setTimeout(() => { if (node.textContent === msg) node.textContent = ''; }, 2400); }
  }
  async function toClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta); return ok;
    }
  }
  function shortDate(x) {
    if (!x) return '';
    const d = new Date(x); if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function timeAgo(x) {
    if (!x) return '';
    const t = new Date(x).getTime(); if (isNaN(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return shortDate(x);
  }
  function moduleName(id) {
    const m = ((S.meta && S.meta.modules) || []).find((x) => x.id === id);
    return m ? m.name : (id || 'module');
  }
  function slugify(s) { return String(s || 'example').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'example'; }

  // ---------- file -> base64 -> /assets ----------
  function readFileB64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); }; // strip data:*;base64, prefix
      r.onerror = () => reject(new Error('could not read ' + file.name));
      r.readAsDataURL(file);
    });
  }
  async function uploadAsset(file, kind, brandId) {
    const dataBase64 = await readFileB64(file);
    const out = await api('/assets', {
      brandId, kind, filename: file.name, mime: file.type || 'image/png', dataBase64, author: author(),
    });
    if (out && out.error) throw new Error(out.error);
    const a = (out && out.asset) || out || {};
    return { id: a.id, url: a.url || (a.id ? '/assets/' + a.id : ''), filename: a.filename || file.name };
  }
  function wireDropzone(zone, input, onFiles) {
    input.onchange = () => { if (input.files && input.files.length) onFiles(Array.from(input.files)); input.value = ''; };
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
    zone.addEventListener('drop', (e) => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /^image\//.test(f.type));
      if (files.length) onFiles(files);
    });
  }

  // ---------- shell: view routing ----------
  function switchView(name) {
    const navKey = (name === 'settings') ? 'settings' : 'pitches';
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.view === navKey));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + name));
    if (name === 'pitches') loadPitches();
    if (name === 'settings' && !S.keysLoaded) loadKeys();
  }

  // ======================================================================
  // VIEW 1 — PITCHES HOME
  // ======================================================================
  async function loadPitches() {
    try {
      const data = await getJson('/api/pitches');
      if (data && data.error) { setLine('pitchesStatus', 'Error: ' + data.error); return; }
      S.pitches = listOf(data, ['pitches', 'items']);
      setLine('pitchesStatus', '');
      renderPitches();
    } catch (e) { setLine('pitchesStatus', 'Error: ' + e.message); }
  }
  function renderPitches() {
    const box = $('pitchesList'); box.innerHTML = '';
    if (!S.pitches.length) {
      box.appendChild(el('div', 'pitch-card empty', 'No pitches yet — create the first one.'));
      return;
    }
    S.pitches.forEach((p) => {
      const card = el('button', 'pitch-card'); card.type = 'button';
      card.appendChild(el('div', 'pc-brand', p.brandName || p.brand_name || p.brand || '?'));
      card.appendChild(el('div', 'pc-title', p.title || 'Untitled pitch'));
      const chips = el('div', 'chips');
      const n = (p.exampleCount != null) ? p.exampleCount : (p.example_count != null ? p.example_count : 0);
      chip(chips, 'examples', n);
      if (p.status) chip(chips, 'status', p.status);
      if (p.created_by || p.author) chip(chips, 'by', p.created_by || p.author);
      card.appendChild(chips);
      const upd = p.updated_at || p.created_at;
      if (upd) card.appendChild(el('div', 'pc-foot', 'Updated ' + shortDate(upd)));
      card.onclick = () => openPitch(p.id);
      box.appendChild(card);
    });
  }

  // ======================================================================
  // VIEW 2 — NEW PITCH WIZARD
  // ======================================================================
  function resetWizard() {
    S.wBrand = null; S.wContacts = [];
    ['npBrand', 'npNotes', 'npLogoUrl', 'npHeroUrl', 'npColor', 'npVoice', 'npTitle', 'npBrief'].forEach((id) => { $(id).value = ''; });
    $('npGoal').value = '';
    ['npStatus1', 'npStatus2', 'npStatus3'].forEach((id) => setLine(id, ''));
    ['npDossier', 'npStep2', 'npStep3'].forEach((id) => $(id).classList.add('hidden'));
    $('npLogo').classList.add('hidden');
    $('npUploads').innerHTML = '';
    $('npProducts').innerHTML = '';
    addProductRow($('npProducts'));
    renderWizardContacts();
  }

  async function researchBrand() {
    const name = $('npBrand').value.trim();
    if (!name) { setLine('npStatus1', 'Type a brand name first.'); $('npBrand').focus(); return; }
    const btn = $('npResearch');
    busy(btn, true, 'Researching…');
    setLine('npStatus1', 'Researching ' + name + ' — site, products, voice…', true);
    try {
      const out = await api('/api/brands', { name, notes: $('npNotes').value.trim() || null, author: author() });
      if (out && out.error) { setLine('npStatus1', 'Error: ' + out.error); return; }
      const brand = (out && out.brand) || out;
      if (!brand || !brand.id) { setLine('npStatus1', 'Error: research returned no brand.'); return; }
      S.wBrand = brand;
      renderWizardDossier(brand);
      prefillKit(brand);
      $('npDossier').classList.remove('hidden');
      $('npStep2').classList.remove('hidden');
      $('npStep3').classList.remove('hidden');
      setLine('npStatus1', '');
      $('npDossier').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setLine('npStatus1', 'Error: ' + e.message);
    } finally { busy(btn, false); }
  }

  function dossierChips(box, d) {
    box.innerHTML = '';
    if (d.vertical) chip(box, 'vertical', d.vertical);
    ((d.voice && d.voice.adjectives) || []).slice(0, 4).forEach((a) => chip(box, 'voice', a));
    (d.currentCampaigns || []).slice(0, 3).forEach((c) => chip(box, 'campaign', c));
  }
  function confLabel(d) { return (d && d.confidence === 'llm') ? 'LLM-researched' : 'heuristic'; }

  function renderWizardDossier(brand) {
    const d = brand.dossier || {};
    $('npConf').textContent = confLabel(d);
    $('npSummary').textContent = d.summary || 'No public summary found — notes above outrank scraped guesses; you can still continue.';
    dossierChips($('npChips'), d);
    const logo = $('npLogo');
    if (brand.logo_url) { logo.src = brand.logo_url; logo.classList.remove('hidden'); }
    else logo.classList.add('hidden');
  }

  function prefillKit(brand) {
    $('npLogoUrl').value = brand.logo_url || '';
    $('npHeroUrl').value = brand.hero_url || '';
    $('npColor').value = brand.primary_hex || brand.primary || '';
    $('npVoice').value = brand.voice_sample || '';
    const box = $('npProducts'); box.innerHTML = '';
    const prods = Array.isArray(brand.products) ? brand.products : [];
    prods.slice(0, 8).forEach((p) => addProductRow(box, typeof p === 'string' ? { name: p } : p));
    if (!box.children.length) addProductRow(box);
  }

  // Product editor row: name / price / image-url / Upload / remove.
  function addProductRow(box, p) {
    if (box.children.length >= 8) return;
    const row = el('div', 'kit-product-row');
    const name = el('input'); name.placeholder = 'Product name'; name.value = (p && p.name) || '';
    const price = el('input'); price.placeholder = '₹ price'; price.value = (p && p.price != null) ? p.price : '';
    const image = el('input'); image.placeholder = 'https://…/product.jpg'; image.value = (p && p.image) || '';
    const up = el('button', 'ghost sm', 'Upload'); up.type = 'button'; up.title = 'Upload an image for this product';
    const file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp,image/gif'; file.style.display = 'none';
    up.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files && file.files[0]; file.value = '';
      if (!f) return;
      if (!S.wBrand && !S.brand) { setLine('npStatus2', 'Research the brand first — uploads need a brand to land in.'); return; }
      busy(up, true);
      try {
        const asset = await uploadAsset(f, 'product', (S.wBrand || S.brand).id);
        image.value = asset.url;
      } catch (e) { setLine('npStatus2', 'Error: upload failed — ' + e.message); }
      finally { busy(up, false); }
    };
    const rm = el('button', 'uc-remove', '✕'); rm.type = 'button'; rm.title = 'Remove product';
    rm.onclick = () => row.remove();
    [name, price, image, up, file, rm].forEach((n) => row.appendChild(n));
    box.appendChild(row);
  }
  function readProducts(box) {
    return Array.from(box.querySelectorAll('.kit-product-row')).map((row) => {
      const [name, price, image] = Array.from(row.querySelectorAll('input[type="text"], input:not([type])')).map((i) => i.value.trim());
      const out = { name };
      if (price) out.price = Number(price.replace(/[^0-9.]/g, '')) || undefined;
      if (image) out.image = image;
      return out;
    }).filter((p) => p.name);
  }

  // Wizard gallery dropzone: files land as brand 'image' assets.
  async function wizardUpload(files) {
    if (!S.wBrand) { setLine('npStatus2', 'Research the brand first.'); return; }
    for (let i = 0; i < files.length; i++) {
      setLine('npStatus2', 'Uploading ' + (i + 1) + '/' + files.length + ' — ' + files[i].name + '…', true);
      try {
        const asset = await uploadAsset(files[i], 'image', S.wBrand.id);
        chip($('npUploads'), 'uploaded', asset.filename);
      } catch (e) { setLine('npStatus2', 'Error: ' + e.message); return; }
    }
    setLine('npStatus2', files.length + ' image' + (files.length > 1 ? 's' : '') + ' in the brand gallery.');
  }

  // Wizard quick contacts: one input row; Add posts immediately.
  function renderWizardContacts() {
    const box = $('npContacts'); box.innerHTML = '';
    S.wContacts.forEach((c) => box.appendChild(contactItem(c, null)));
    const row = el('div', 'contact-row');
    const name = el('input'); name.placeholder = 'Name'; name.id = 'npCtName';
    const role = el('input'); role.placeholder = 'Role'; role.id = 'npCtRole';
    const email = el('input'); email.placeholder = 'Email'; email.type = 'email'; email.id = 'npCtEmail';
    [name, role, email].forEach((n) => row.appendChild(n));
    box.appendChild(row);
  }
  function contactItem(c, onDelete) {
    const item = el('div', 'contact-item');
    item.appendChild(el('span', 'who', c.name || '?'));
    item.appendChild(el('span', 'meta', [c.role, c.email].filter(Boolean).join(' · ')));
    if (onDelete) {
      const rm = el('button', 'uc-remove', '✕'); rm.type = 'button'; rm.title = 'Remove contact';
      rm.onclick = onDelete;
      item.appendChild(rm);
    }
    return item;
  }
  async function wizardAddContact() {
    if (!S.wBrand) { setLine('npStatus2', 'Research the brand first.'); return; }
    const c = { name: $('npCtName').value.trim(), role: $('npCtRole').value.trim(), email: $('npCtEmail').value.trim() };
    if (!c.name) { setLine('npStatus2', 'A contact needs at least a name.'); $('npCtName').focus(); return; }
    const btn = $('npAddContact');
    busy(btn, true);
    try {
      const out = await api('/api/brands/' + encodeURIComponent(S.wBrand.id) + '/contacts', { contact: c, author: author() });
      if (out && out.error) { setLine('npStatus2', 'Error: ' + out.error); return; }
      S.wContacts.push((out && out.contact) || c);
      renderWizardContacts();
      setLine('npStatus2', '');
    } catch (e) { setLine('npStatus2', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }

  async function saveWizardKit() {
    if (!S.wBrand) { setLine('npStatus2', 'Research the brand first.'); return; }
    const colour = $('npColor').value.trim();
    if (colour && !/^#[0-9a-f]{6}$/i.test(colour)) { setLine('npStatus2', 'Brand colour must look like #e78129.'); $('npColor').focus(); return; }
    const btn = $('npSave2');
    busy(btn, true, 'Saving…');
    try {
      const out = await api('/api/brands/' + encodeURIComponent(S.wBrand.id) + '/kit', {
        patch: {
          logoUrl: $('npLogoUrl').value.trim(),
          heroUrl: $('npHeroUrl').value.trim(),
          primary: colour,
          voiceSample: $('npVoice').value.trim(),
        },
        products: readProducts($('npProducts')),
        author: author(),
      });
      if (out && out.error) { setLine('npStatus2', 'Error: ' + out.error); return; }
      if (out && out.brand) S.wBrand = out.brand;
      setLine('npStatus2', 'Kit saved — every example for this brand uses it.');
      $('npStep3').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { setLine('npStatus2', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }

  async function createPitch() {
    if (!S.wBrand) { setLine('npStatus3', 'Research a brand in step 1 first.'); return; }
    const title = $('npTitle').value.trim();
    if (!title) { setLine('npStatus3', 'Give the pitch a title.'); $('npTitle').focus(); return; }
    const btn = $('npCreate');
    busy(btn, true, 'Creating…');
    setLine('npStatus3', 'Creating the pitch…', true);
    try {
      const out = await api('/api/pitches', {
        brandId: S.wBrand.id, title,
        goal: $('npGoal').value || null,
        brief: $('npBrief').value.trim() || null,
        author: author(),
      });
      if (out && out.error) { setLine('npStatus3', 'Error: ' + out.error); return; }
      const pitch = (out && out.pitch) || out;
      if (!pitch || !pitch.id) { setLine('npStatus3', 'Error: the pitch was not created.'); return; }
      setLine('npStatus3', '');
      openPitch(pitch.id);
    } catch (e) { setLine('npStatus3', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }

  // ======================================================================
  // VIEW 3 — PITCH WORKSPACE
  // ======================================================================
  async function openPitch(id) {
    switchView('pitch');
    switchWTab('examples');
    showExDetail(false);
    $('genPanel').classList.add('hidden');
    $('exGrid').innerHTML = '';
    setLine('exStatus', 'Opening the pitch…', true);
    try {
      const data = await getJson('/api/pitches/' + encodeURIComponent(id));
      if (data && data.error) { setLine('exStatus', 'Error: ' + data.error); return; }
      S.pitch = data.pitch || data;
      S.examples = listOf(data, ['examples']);
      await refreshBrand();
      renderWorkspace();
      // The brand loads asynchronously, so a fast switch to Details (or the
      // e2e suite) can hit loadActivity before S.brand exists and get an
      // empty feed — re-run it now that the brand is in hand.
      if (S.wtab === 'details') loadActivity();
      setLine('exStatus', '');
    } catch (e) { setLine('exStatus', 'Error: ' + e.message); }
  }
  async function refreshPitch() {
    if (!S.pitch) return;
    try {
      const data = await getJson('/api/pitches/' + encodeURIComponent(S.pitch.id));
      if (data && data.pitch) { S.pitch = data.pitch; S.examples = listOf(data, ['examples']); renderGallery(); renderHeader(); }
    } catch (e) { /* refresh is best-effort */ }
  }
  async function refreshBrand() {
    const brandId = S.pitch && (S.pitch.brand_id || S.pitch.brandId);
    if (!brandId) { S.brand = null; S.assets = []; S.contacts = []; return; }
    const data = await getJson('/api/brands/' + encodeURIComponent(brandId));
    if (data && data.error) throw new Error(data.error);
    S.brand = data.brand || data;
    S.assets = listOf(data, ['assets']).length ? listOf(data, ['assets']) : listOf(S.brand, ['assets']);
    S.contacts = listOf(data, ['contacts']).length ? listOf(data, ['contacts']) : listOf(S.brand, ['contacts']);
  }

  function renderWorkspace() {
    renderHeader();
    renderGallery();
    renderAssets();
    renderContacts();
    renderDetails();
  }
  function renderHeader() {
    const b = S.brand || {}, p = S.pitch || {};
    const logo = $('pwLogo');
    if (b.logo_url) { logo.src = b.logo_url; logo.classList.remove('hidden'); } else logo.classList.add('hidden');
    $('pwBrand').textContent = b.name || p.brandName || p.brand_name || '';
    $('pwTitle').textContent = p.title || 'Untitled pitch';
    const st = $('pwStatus');
    if (p.status) { st.textContent = p.status; st.classList.remove('hidden'); } else st.classList.add('hidden');
  }

  // Inline rename: click the title, Enter/blur commits, Escape cancels.
  function startRename() {
    const inp = $('pwTitleInput');
    inp.value = (S.pitch && S.pitch.title) || '';
    $('pwTitle').classList.add('hidden');
    inp.classList.remove('hidden');
    inp.focus(); inp.select();
  }
  async function commitRename() {
    const inp = $('pwTitleInput');
    const v = inp.value.trim();
    inp.classList.add('hidden');
    $('pwTitle').classList.remove('hidden');
    if (!v || !S.pitch || v === S.pitch.title) return;
    try {
      const out = await req('PATCH', '/api/pitches/' + encodeURIComponent(S.pitch.id), { patch: { title: v }, author: author() });
      if (out && out.error) { setLine('exStatus', 'Error: ' + out.error); return; }
      S.pitch.title = v;
      renderHeader();
    } catch (e) { setLine('exStatus', 'Error: ' + e.message); }
  }

  function switchWTab(name) {
    S.wtab = name;
    document.querySelectorAll('[data-wtab]').forEach((b) => b.classList.toggle('on', b.dataset.wtab === name));
    document.querySelectorAll('[data-wpane]').forEach((p) => p.classList.toggle('on', p.dataset.wpane === name));
    if (name === 'details') loadActivity();
  }

  // ---- examples: proposals + your idea ----
  async function propose(reroll) {
    if (!S.brand) return;
    const btn = reroll ? $('genReroll') : $('genPropose');
    busy(btn, true, 'Thinking…');
    setLine('genStatus', 'Drafting use-cases for ' + S.brand.name + '…', true);
    try {
      const body = { brand: S.brand.name, brief: (S.pitch && S.pitch.brief) || undefined, count: 6 };
      if (reroll && S.proposals.length) body.prior = S.proposals.map((u) => u.title);
      const out = await api('/usecases', body);
      if (out && out.error) { setLine('genStatus', 'Error: ' + out.error); return; }
      S.proposals = out.useCases || [];
      const src = $('genSource');
      if (out.source) { src.textContent = out.source === 'library' ? 'library playbook' : 'LLM-proposed'; src.classList.remove('hidden'); }
      renderProposals();
      $('genReroll').classList.remove('hidden');
      setLine('genStatus', S.proposals.length ? '' : 'No proposals this time — try again or type your own idea.');
    } catch (e) { setLine('genStatus', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }
  function renderProposals() {
    const list = $('genList'); list.innerHTML = '';
    S.proposals.forEach((u) => {
      const card = el('div', 'uc-card');
      const top = el('div', 'uc-top');
      top.appendChild(el('span', 'uc-title', u.title || 'Use-case'));
      card.appendChild(top);
      if (u.businessGoal) card.appendChild(el('div', 'uc-goal', u.businessGoal));
      const meta = el('div', 'chips');
      chip(meta, 'module', moduleName(u.moduleId));
      card.appendChild(meta);
      const actions = el('div', 'uc-actions');
      const go = el('button', 'primary sm'); go.type = 'button';
      go.innerHTML = '<svg class="ic"><use href="#i-sparkle"/></svg> Generate';
      go.onclick = () => generateFromProposal(u, go);
      actions.appendChild(go);
      card.appendChild(actions);
      list.appendChild(card);
    });
  }
  async function generateFromProposal(u, btn) {
    busy(btn, true, 'Generating…');
    setLine('genStatus', 'Building “' + (u.title || 'example') + '” — validated AMP takes a moment…', true);
    try {
      const out = await api('/api/pitches/' + encodeURIComponent(S.pitch.id) + '/examples', {
        title: u.title, moduleId: u.moduleId, contentPlan: u.contentPlan || {}, author: author(),
      });
      if (out && out.error) { setLine('genStatus', 'Error: ' + out.error); return; }
      setLine('genStatus', 'Built “' + (u.title || 'example') + '” — it’s in the gallery below.');
      await refreshPitch();
    } catch (e) { setLine('genStatus', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }
  async function generateFromIdea() {
    const text = $('ideaInput').value.trim();
    if (!text) { setLine('ideaStatus', 'Describe the email you want first.'); $('ideaInput').focus(); return; }
    const btn = $('ideaGo');
    busy(btn, true);
    setLine('ideaStatus', 'Building your idea — validated AMP takes a moment…', true);
    try {
      const out = await api('/api/pitches/' + encodeURIComponent(S.pitch.id) + '/examples', {
        title: text, brief: text, author: author(),
      });
      if (out && out.error) { setLine('ideaStatus', 'Error: ' + out.error); return; }
      $('ideaInput').value = '';
      setLine('ideaStatus', 'Built — it’s in the gallery below.');
      await refreshPitch();
    } catch (e) { setLine('ideaStatus', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }

  // ---- examples: gallery + detail ----
  function renderGallery() {
    const grid = $('exGrid'); grid.innerHTML = '';
    if (!S.examples.length) {
      grid.appendChild(el('div', 'empty-note', 'No examples yet — hit “New example” and let the genie propose.'));
      return;
    }
    S.examples.forEach((x) => {
      const card = el('button', 'ex-card'); card.type = 'button';
      card.appendChild(el('div', 'ex-name', x.title || 'Untitled example'));
      const chips = el('div', 'chips');
      if (x.module_id || x.moduleId) chip(chips, 'module', moduleName(x.module_id || x.moduleId));
      if (x.validation_pass || x.validationPass) { const c = el('span', 'chip pass', 'PASS'); chips.appendChild(c); }
      card.appendChild(chips);
      const bits = [x.created_by || x.author, shortDate(x.created_at || x.createdAt)].filter(Boolean).join(' · ');
      if (bits) card.appendChild(el('div', 'ex-foot', bits));
      card.onclick = () => openExample(x.id);
      grid.appendChild(card);
    });
  }
  function showExDetail(on) {
    $('exDetail').classList.toggle('hidden', !on);
    $('exGrid').classList.toggle('hidden', on);
    $('exToolbar').classList.toggle('hidden', on);
    if (on) $('genPanel').classList.add('hidden');
  }

  function exampleParams(x) {
    const raw = x.params_json != null ? x.params_json : (x.params != null ? x.params : null);
    if (raw == null) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }

  async function openExample(id) {
    setLine('exStatus', '');
    try {
      const data = await getJson('/api/examples/' + encodeURIComponent(id));
      if (data && data.error) { setLine('exStatus', 'Error: ' + data.error); return; }
      S.example = data.example || data;
      S.versions = listOf(data, ['versions']);
      renderExampleDetail();
      showExDetail(true);
      switchDTab('preview');
    } catch (e) { setLine('exStatus', 'Error: ' + e.message); }
  }

  function renderExampleDetail() {
    const x = S.example;
    const t = $('exTitle'); t.innerHTML = '';
    t.appendChild(document.createTextNode(x.title || 'Untitled example'));
    t.appendChild(el('small', '', moduleName(x.module_id || x.moduleId)));

    const meta = $('exMeta'); meta.innerHTML = '';
    if (x.validation_pass || x.validationPass) meta.appendChild(el('span', 'chip pass', 'PASS — valid AMP4EMAIL'));
    if (x.created_by || x.author) chip(meta, 'by', x.created_by || x.author);
    if (x.created_at) chip(meta, 'created', shortDate(x.created_at));
    if (x.tweak_prompt || x.tweakPrompt) chip(meta, 'tweak', x.tweak_prompt || x.tweakPrompt);

    // The exact generated AMP, byte-identical to the download, in the phone.
    $('exFrame').srcdoc = x.amp_html || x.ampHtml || '';
    $('exCode').value = x.amp_html || x.ampHtml || '';

    // Share page derives from the linked build record.
    const buildId = exampleParams(x).buildId;
    const open = $('exOpenShare'), share = $('exShare');
    if (buildId) {
      open.href = '/b/' + encodeURIComponent(buildId);
      open.classList.remove('hidden');
      share.classList.remove('hidden');
    } else {
      open.classList.add('hidden');
      share.classList.add('hidden');
    }
    $('exMsg').textContent = '';
    $('exTweakMsg').textContent = ''; $('exTweakMsg').className = 'dispatch-msg';
    $('exTweak').value = '';
    renderVersions();
  }

  function renderVersions() {
    const row = $('exVersions'); row.innerHTML = '';
    const list = S.versions.slice().sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    if (list.length < 2) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    list.forEach((v, i) => {
      const c = el('button', 'chip', 'v' + (i + 1)); c.type = 'button';
      if (v.tweak_prompt || v.tweakPrompt) c.title = v.tweak_prompt || v.tweakPrompt;
      if (S.example && v.id === S.example.id) c.classList.add('pass');
      c.onclick = () => openExample(v.id);
      row.appendChild(c);
    });
  }

  async function tweakExample() {
    const prompt = $('exTweak').value.trim();
    const msg = $('exTweakMsg');
    if (!prompt) { $('exTweak').focus(); return; }
    if (!S.example) return;
    const btn = $('exTweakGo');
    busy(btn, true);
    msg.className = 'dispatch-msg'; msg.innerHTML = '<span class="spinner"></span> Rebuilding&hellip;';
    try {
      const out = await api('/api/examples/' + encodeURIComponent(S.example.id) + '/tweak', { prompt, author: author() });
      if (!out || out.error || out.ok === false) { msg.className = 'dispatch-msg err'; msg.textContent = (out && out.error) || 'Tweak failed.'; return; }
      msg.className = 'dispatch-msg ok'; msg.textContent = 'Applied — new validated version.';
      $('exTweak').value = '';
      const next = out.example || (out.json && out.json.example);
      if (next && next.id) await openExample(next.id);
      refreshPitch();
    } catch (e) { msg.className = 'dispatch-msg err'; msg.textContent = 'Tweak failed: ' + e.message; }
    finally { busy(btn, false); }
  }

  function downloadExample() {
    if (!S.example) return;
    const code = S.example.amp_html || S.example.ampHtml || '';
    const blob = new Blob([code], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'amp-genie-' + slugify(S.example.title) + '.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function copyExampleAmp() {
    if (!S.example) return;
    const ok = await toClipboard(S.example.amp_html || S.example.ampHtml || '');
    flash($('exMsg'), ok ? 'AMP copied to clipboard.' : 'Copy failed — use Download instead.');
  }
  async function copyShareLink() {
    const buildId = S.example && exampleParams(S.example).buildId;
    if (!buildId) return;
    const ok = await toClipboard(location.origin + '/b/' + encodeURIComponent(buildId));
    flash($('exMsg'), ok ? 'Share link copied.' : 'Copy failed.');
  }

  function switchDTab(name) {
    document.querySelectorAll('[data-dtab]').forEach((b) => b.classList.toggle('on', b.dataset.dtab === name));
    document.querySelectorAll('[data-dpane]').forEach((p) => p.classList.toggle('on', p.dataset.dpane === name));
  }

  // ---- assets pane ----
  function assetUrl(a) { return a.url || ('/assets/' + a.id); }
  async function assetsUpload(files) {
    if (!S.brand) return;
    const kind = $('assetKind').value || 'image';
    for (let i = 0; i < files.length; i++) {
      setLine('assetStatus', 'Uploading ' + (i + 1) + '/' + files.length + ' — ' + files[i].name + '…', true);
      try { await uploadAsset(files[i], kind, S.brand.id); }
      catch (e) { setLine('assetStatus', 'Error: ' + e.message); return; }
    }
    setLine('assetStatus', files.length + ' file' + (files.length > 1 ? 's' : '') + ' uploaded.');
    try { await refreshBrand(); renderAssets(); } catch (e) { /* grid refresh is best-effort */ }
  }
  function renderAssets() {
    const grid = $('assetGrid'); grid.innerHTML = '';
    if (!S.assets.length) {
      grid.appendChild(el('div', 'empty-note', 'No assets yet — drop the brand’s logo, heroes and product shots here.'));
      return;
    }
    S.assets.forEach((a) => {
      const card = el('div', 'asset-card');
      const img = el('img', 'asset-thumb');
      img.src = assetUrl(a); img.loading = 'lazy'; img.alt = a.filename || 'asset';
      card.appendChild(img);
      const meta = el('div', 'asset-meta');
      meta.appendChild(el('div', 'asset-name', a.filename || 'file'));
      const sub = el('div', 'asset-sub');
      sub.appendChild(el('span', 'chip', a.kind || 'image'));
      const by = a.uploadedBy || a.uploaded_by || a.created_by;
      if (by) sub.appendChild(document.createTextNode(by));
      meta.appendChild(sub);
      card.appendChild(meta);
      const actions = el('div', 'asset-actions');
      const copy = el('button', 'ghost sm', 'Copy URL'); copy.type = 'button';
      copy.onclick = async () => { const ok = await toClipboard(location.origin + assetUrl(a)); flash(copy, ok ? 'Copied' : 'Failed'); };
      const del = el('button', 'ghost sm danger', 'Delete'); del.type = 'button';
      del.onclick = async () => {
        if (!confirm('Delete ' + (a.filename || 'this asset') + '? Emails already built keep their copy.')) return;
        busy(del, true);
        try {
          const out = await req('DELETE', '/assets/' + encodeURIComponent(a.id));
          if (out && out.error) { setLine('assetStatus', 'Error: ' + out.error); return; }
          await refreshBrand(); renderAssets();
        } catch (e) { setLine('assetStatus', 'Error: ' + e.message); busy(del, false); }
      };
      actions.appendChild(copy); actions.appendChild(del);
      card.appendChild(actions);
      grid.appendChild(card);
    });
  }

  // ---- contacts (workspace assets pane) ----
  function renderContacts() {
    const list = $('ctList'); list.innerHTML = '';
    if (!S.contacts.length) { list.appendChild(el('div', 'empty-note', 'No contacts yet.')); return; }
    S.contacts.forEach((c) => {
      list.appendChild(contactItem(c, async () => {
        try {
          const out = await req('DELETE', '/api/contacts/' + encodeURIComponent(c.id));
          if (out && out.error) { setLine('ctStatus', 'Error: ' + out.error); return; }
          await refreshBrand(); renderContacts();
        } catch (e) { setLine('ctStatus', 'Error: ' + e.message); }
      }));
    });
  }
  async function addContact() {
    if (!S.brand) return;
    const c = { name: $('ctName').value.trim(), role: $('ctRole').value.trim(), email: $('ctEmail').value.trim() };
    if (!c.name) { setLine('ctStatus', 'A contact needs at least a name.'); $('ctName').focus(); return; }
    const btn = $('ctAdd');
    busy(btn, true);
    try {
      const out = await api('/api/brands/' + encodeURIComponent(S.brand.id) + '/contacts', { contact: c, author: author() });
      if (out && out.error) { setLine('ctStatus', 'Error: ' + out.error); return; }
      ['ctName', 'ctRole', 'ctEmail'].forEach((id) => { $(id).value = ''; });
      setLine('ctStatus', '');
      await refreshBrand(); renderContacts();
    } catch (e) { setLine('ctStatus', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }

  // ---- details pane ----
  function renderDetails() {
    const b = S.brand || {}, p = S.pitch || {};
    const d = b.dossier || {};
    const conf = $('dtConf');
    conf.textContent = confLabel(d); conf.classList.remove('hidden');
    $('dtSummary').textContent = d.summary || 'No dossier summary on file.';
    dossierChips($('dtChips'), d);
    $('dtVoice').value = b.voice_sample || b.voiceSample || '';
    $('dtGoal').value = p.goal || '';
    if ($('dtGoal').value !== (p.goal || '')) $('dtGoal').value = ''; // goal text not in the list -> Not sure yet
    $('dtBrief').value = p.brief || '';
    $('dtVoiceMsg').textContent = ''; $('dtPitchMsg').textContent = '';
  }
  async function saveVoice() {
    if (!S.brand) return;
    const btn = $('dtVoiceSave');
    busy(btn, true);
    try {
      const out = await api('/api/brands/' + encodeURIComponent(S.brand.id) + '/kit', {
        patch: { voiceSample: $('dtVoice').value.trim() }, author: author(),
      });
      if (out && out.error) { flash($('dtVoiceMsg'), 'Error: ' + out.error); return; }
      if (out && out.brand) S.brand = out.brand;
      flash($('dtVoiceMsg'), 'Voice saved.');
    } catch (e) { flash($('dtVoiceMsg'), 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }
  async function savePitchDetails() {
    if (!S.pitch) return;
    const btn = $('dtPitchSave');
    busy(btn, true);
    try {
      const out = await req('PATCH', '/api/pitches/' + encodeURIComponent(S.pitch.id), {
        patch: { goal: $('dtGoal').value || null, brief: $('dtBrief').value.trim() || null },
        author: author(),
      });
      if (out && out.error) { flash($('dtPitchMsg'), 'Error: ' + out.error); return; }
      S.pitch.goal = $('dtGoal').value || null;
      S.pitch.brief = $('dtBrief').value.trim() || null;
      flash($('dtPitchMsg'), 'Pitch saved.');
    } catch (e) { flash($('dtPitchMsg'), 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }
  async function loadActivity() {
    if (!S.brand) return;
    const box = $('dtActivity');
    try {
      const data = await getJson('/api/brands/' + encodeURIComponent(S.brand.id) + '/activity');
      const items = listOf(data, ['activity', 'items', 'events']);
      box.innerHTML = '';
      if (!items.length) { box.appendChild(el('div', 'empty-note', 'Nothing yet — research, uploads and builds land here.')); return; }
      items.forEach((a) => {
        const row = el('div', 'activity-item');
        const verb = el('b', '', a.verb || a.action || 'did');
        row.appendChild(verb);
        const detail = a.detail || a.details || '';
        if (detail) row.appendChild(document.createTextNode(' — ' + detail));
        const who = a.actor || a.author || a.created_by;
        if (who) { row.appendChild(document.createTextNode(' · ')); row.appendChild(el('span', 'who', who)); }
        const when = timeAgo(a.created_at || a.ts);
        if (when) { row.appendChild(document.createTextNode(' · ')); row.appendChild(el('span', 'when', when)); }
        box.appendChild(row);
      });
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'empty-note', 'Could not load activity.'));
    }
  }

  // ======================================================================
  // VIEW 4 — SETTINGS: LLM key pool
  // ======================================================================
  async function loadKeys() {
    setLine('keysStatus', 'Loading the key pool…', true);
    try {
      const data = await getJson('/settings/keys');
      if (data && data.error) { setLine('keysStatus', 'Error: ' + data.error); return; }
      S.keysLoaded = true;
      const providers = listOf(data, ['providers']);
      const sel = $('keyProvider');
      if (providers.length && sel.options.length !== providers.length) {
        sel.innerHTML = '';
        providers.forEach((p) => {
          const id = typeof p === 'string' ? p : (p.id || p.name);
          const label = typeof p === 'string' ? p : (p.name || p.id);
          const o = document.createElement('option'); o.value = id; o.textContent = label;
          sel.appendChild(o);
        });
      }
      renderKeys(listOf(data, ['keys', 'items']));
      setLine('keysStatus', '');
    } catch (e) { setLine('keysStatus', 'Error: ' + e.message); }
  }
  function renderKeys(keys) {
    const tbody = $('keysRows'); tbody.innerHTML = '';
    if (!keys.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td'); td.colSpan = 6; td.className = 'mono';
      td.textContent = 'No keys yet — the genie runs on its deterministic template tier until one lands.';
      tr.appendChild(td); tbody.appendChild(tr);
      return;
    }
    keys.forEach((k) => {
      const tr = document.createElement('tr');
      const cell = (txt, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = txt || '—'; tr.appendChild(td); return td; };
      cell(k.provider);
      cell(k.key || k.masked || k.key_masked || '••••••••', 'mono'); // server sends the key pre-masked (····last4)
      cell(k.label);
      cell(k.model, 'mono');
      cell(k.addedBy || k.added_by || k.author);
      const td = document.createElement('td');
      const del = el('button', 'ghost sm danger', 'Delete'); del.type = 'button';
      del.onclick = async () => {
        busy(del, true);
        try {
          const out = await req('DELETE', '/settings/keys/' + encodeURIComponent(k.id));
          if (out && out.error) { setLine('keysStatus', 'Error: ' + out.error); busy(del, false); return; }
          loadKeys();
        } catch (e) { setLine('keysStatus', 'Error: ' + e.message); busy(del, false); }
      };
      td.appendChild(del); tr.appendChild(td);
      tbody.appendChild(tr);
    });
  }
  async function addKey() {
    const provider = $('keyProvider').value;
    const key = $('keyValue').value.trim();
    if (!key) { setLine('keysStatus', 'Paste the API key first.'); $('keyValue').focus(); return; }
    const btn = $('keyAdd');
    busy(btn, true, 'Adding…');
    try {
      const out = await api('/settings/keys', {
        provider, key,
        label: $('keyLabel').value.trim() || null,
        model: $('keyModel').value.trim() || null,
        author: author(),
      });
      if (out && out.error) { setLine('keysStatus', 'Error: ' + out.error); return; }
      ['keyValue', 'keyLabel', 'keyModel'].forEach((id) => { $(id).value = ''; });
      setLine('keysStatus', 'Key added to the shared pool.');
      loadKeys();
    } catch (e) { setLine('keysStatus', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }

  // ======================================================================
  // init + bindings
  // ======================================================================
  function bind() {
    document.querySelectorAll('.nav-item').forEach((b) => b.onclick = () => switchView(b.dataset.view));
    $('authorName').value = author() || '';
    $('authorName').onchange = () => { try { localStorage.setItem(AUTHOR_KEY, $('authorName').value.trim()); } catch (e) {} };
    $('devToggle').onchange = () => {
      document.body.classList.toggle('dev-mode', $('devToggle').checked);
      if (!$('devToggle').checked) switchDTab('preview');
    };

    // pitches home
    $('newPitchBtn').onclick = () => { resetWizard(); switchView('newpitch'); $('npBrand').focus(); };

    // wizard
    $('npBack').onclick = () => switchView('pitches');
    $('npResearch').onclick = researchBrand;
    $('npBrand').onkeydown = (e) => { if (e.key === 'Enter') researchBrand(); };
    $('npAddProduct').onclick = () => addProductRow($('npProducts'));
    wireDropzone($('npDrop'), $('npFile'), wizardUpload);
    $('npAddContact').onclick = wizardAddContact;
    $('npSave2').onclick = saveWizardKit;
    $('npSkip2').onclick = () => { setLine('npStatus2', ''); $('npStep3').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('npTitle').focus(); };
    $('npCreate').onclick = createPitch;
    $('npTitle').onkeydown = (e) => { if (e.key === 'Enter') createPitch(); };

    // workspace
    $('pwBack').onclick = () => { switchView('pitches'); };
    $('pwTitle').onclick = startRename;
    $('pwTitleInput').onblur = commitRename;
    $('pwTitleInput').onkeydown = (e) => {
      if (e.key === 'Enter') $('pwTitleInput').blur();
      if (e.key === 'Escape') { $('pwTitleInput').value = (S.pitch && S.pitch.title) || ''; $('pwTitleInput').blur(); }
    };
    document.querySelectorAll('[data-wtab]').forEach((b) => b.onclick = () => switchWTab(b.dataset.wtab));
    document.querySelectorAll('[data-dtab]').forEach((b) => b.onclick = () => switchDTab(b.dataset.dtab));

    // examples
    $('exNew').onclick = () => {
      const panel = $('genPanel');
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden') && !S.proposals.length) $('genPropose').focus();
    };
    $('genPropose').onclick = () => propose(false);
    $('genReroll').onclick = () => propose(true);
    $('ideaGo').onclick = generateFromIdea;
    $('ideaInput').onkeydown = (e) => { if (e.key === 'Enter') generateFromIdea(); };
    $('exBackBtn').onclick = () => { showExDetail(false); refreshPitch(); };
    $('exShare').onclick = copyShareLink;
    $('exDownload').onclick = downloadExample;
    $('exCopyAmp').onclick = copyExampleAmp;
    $('exTweakGo').onclick = tweakExample;
    $('exTweak').onkeydown = (e) => { if (e.key === 'Enter') tweakExample(); };

    // assets + contacts
    wireDropzone($('assetDrop'), $('assetFile'), assetsUpload);
    $('ctAdd').onclick = addContact;

    // details
    $('dtVoiceSave').onclick = saveVoice;
    $('dtPitchSave').onclick = savePitchDetails;

    // settings
    $('keyAdd').onclick = addKey;
    $('keyValue').onkeydown = (e) => { if (e.key === 'Enter') addKey(); };
  }

  async function init() {
    bind();
    switchView('pitches');
    try { S.meta = await getJson('/api/meta'); } catch (e) { S.meta = null; }
    // meta arrived after first paint: refresh module-name chips if a pitch is open
    if (S.examples.length) renderGallery();
  }

  init();
})();
