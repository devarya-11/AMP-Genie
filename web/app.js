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
    // ---- visual block editor ----
    doc: null,             // { version, brand?, currency?, blocks:[{id,type,props}] }
    editingExampleId: null,// example id being edited in place (null = new)
    edSelId: null,         // id of the selected block
    edDirty: false,        // unsaved changes since last save/load
    edIdSeq: 1,            // client-side block-id counter (Date.now-free)
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
  // Every new example is editor-first: generate a starting doc (with the
  // routed interactive module baked in) and open the visual editor. Nothing
  // is persisted until the user saves from the editor.
  async function generateFromProposal(u, btn) {
    busy(btn, true, 'Drafting…');
    setLine('genStatus', 'Drafting “' + (u.title || 'example') + '” for the editor…', true);
    try {
      const out = await api('/api/pitches/' + encodeURIComponent(S.pitch.id) + '/ai-doc', {
        moduleId: u.moduleId, useCase: u.title, brief: (S.pitch && S.pitch.brief) || u.title || '', author: author(),
      });
      if (out && out.error) { setLine('genStatus', 'Error: ' + out.error); return; }
      setLine('genStatus', '');
      enterEditor((out && out.doc) || { version: 1, blocks: [] }, null, u.title || 'New email');
    } catch (e) { setLine('genStatus', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }
  async function generateFromIdea() {
    const text = $('ideaInput').value.trim();
    if (!text) { setLine('ideaStatus', 'Describe the email you want first.'); $('ideaInput').focus(); return; }
    const btn = $('ideaGo');
    busy(btn, true);
    setLine('ideaStatus', 'Drafting your idea for the editor…', true);
    try {
      const out = await api('/api/pitches/' + encodeURIComponent(S.pitch.id) + '/ai-doc', {
        brief: text, useCase: text, author: author(),
      });
      if (out && out.error) { setLine('ideaStatus', 'Error: ' + out.error); return; }
      $('ideaInput').value = '';
      setLine('ideaStatus', '');
      enterEditor((out && out.doc) || { version: 1, blocks: [] }, null, text.slice(0, 60) || 'New email');
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

    // Share page id: interactive examples link their KV build via
    // params.buildId; doc examples (built in the editor) key the build record
    // by the example id itself (/b/<exampleId>, stable across edits).
    const isDocEx = (x.module_id || x.moduleId) === 'doc';
    const buildId = exampleParams(x).buildId || (isDocEx ? x.id : null);
    const open = $('exOpenShare'), share = $('exShare');
    if (buildId) {
      open.href = '/b/' + encodeURIComponent(buildId);
      open.classList.remove('hidden');
      share.classList.remove('hidden');
    } else {
      open.classList.add('hidden');
      share.classList.add('hidden');
    }
    // EVERY example is editable in the visual editor: doc examples load their
    // blocks; legacy interactive examples synthesize an editable doc via
    // /as-doc (openEditorForExample handles both).
    $('exEditDoc').classList.remove('hidden');
    // Prompt-tweak applies to interactive (KV-build) examples; doc examples
    // are refined in the visual editor instead, so hide the tweak box there.
    $('exTweakBox').classList.toggle('hidden', isDocEx);

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
  // VIEW — VISUAL BLOCK EDITOR (Genie 2.0 Phase 4)
  // ======================================================================
  // Block registry: label for the palette + a factory for default props +
  // a one-line summary for the block-list card. Types & props mirror the
  // backend v1 static set exactly.
  const BLOCK_TYPES = [
    { type: 'header',   label: 'Header',   glyph: 'H',
      make: () => ({ brandName: (S.brand && S.brand.name) || 'Brand', logoUrl: (S.brand && S.brand.logo_url) || '', link: '' }),
      summary: (p) => p.brandName || 'Header' },
    { type: 'hero',     label: 'Hero image', glyph: '▦',
      make: () => ({ imageUrl: (S.brand && S.brand.hero_url) || '', alt: '', height: '' }),
      summary: (p) => p.imageUrl ? shortUrl(p.imageUrl) : 'No image yet' },
    { type: 'text',     label: 'Text',     glyph: 'T',
      make: () => ({ heading: 'Heading', body: 'Body copy goes here.' }),
      summary: (p) => p.heading || p.body || 'Text' },
    { type: 'image',    label: 'Image',    glyph: '▤',
      make: () => ({ imageUrl: '', alt: '', href: '' }),
      summary: (p) => p.imageUrl ? shortUrl(p.imageUrl) : 'No image yet' },
    { type: 'button',   label: 'Button',   glyph: '⬢',
      make: () => ({ label: 'Shop now', href: '', align: 'center' }),
      summary: (p) => p.label || 'Button' },
    { type: 'products', label: 'Products', glyph: '▧',
      make: () => ({ items: productSeed(), columns: 2 }),
      summary: (p) => ((p.items && p.items.length) || 0) + ' product' + (((p.items && p.items.length) || 0) === 1 ? '' : 's') },
    { type: 'divider',  label: 'Divider',  glyph: '—',
      make: () => ({}),
      summary: () => 'Horizontal rule' },
    { type: 'footer',   label: 'Footer',   glyph: 'F',
      make: () => ({ brandName: (S.brand && S.brand.name) || 'Brand', text: 'You are receiving this because you subscribed.' }),
      summary: (p) => p.text || p.brandName || 'Footer' },
  ];
  // ---- INTERACTIVE (amp-state) modules. block.type === module id. A doc may
  //      hold only ONE of these (they share amp-state). Copy fields per module
  //      are edited here; the interactivity itself is baked into the renderer.
  const INTERACTIVE_FIELDS = {
    reveal: ['head', 'teaserText', 'ctaLabel', 'footerText'],
    search: ['head', 'footerText'],
    quiz:   ['head', 'question', 'footerText'],
    rating: ['head', 'prompt', 'footerText'],
    spin:   ['head', 'teaserText', 'footerText'],
    poll:   ['head', 'question', 'optionA', 'optionB', 'footerText'],
    calc:   ['head', 'promptText', 'ctaLabel', 'assumptionText', 'footerText'],
    report: ['head', 'verdictText', 'ctaLabel', 'footerText'],
  };
  const INTERACTIVE_TYPES = [
    { type: 'reveal', label: 'Tap to reveal',    glyph: '⊕' },
    { type: 'search', label: 'Search & filter',  glyph: '⌕' },
    { type: 'quiz',   label: 'Quiz',             glyph: '?' },
    { type: 'rating', label: 'Star rating',      glyph: '★' },
    { type: 'spin',   label: 'Spin to win',      glyph: '◉' },
    { type: 'poll',   label: 'This-or-that poll', glyph: '⇄' },
    { type: 'calc',   label: 'Calculator',       glyph: '∑' },
    { type: 'report', label: 'Personal report',  glyph: '⎙' },
  ];
  function interactiveDef(type) { return INTERACTIVE_TYPES.find((b) => b.type === type); }
  function isInteractive(type) { return Object.prototype.hasOwnProperty.call(INTERACTIVE_FIELDS, type); }
  function docHasInteractive() { return (S.doc && S.doc.blocks || []).some((b) => isInteractive(b.type)); }
  // Pretty label + glyph for any block type (static or interactive).
  function typeLabel(type) { const d = blockDef(type) || interactiveDef(type); return (d && d.label) || type; }
  function typeGlyph(type) { const d = blockDef(type) || interactiveDef(type); return (d && d.glyph) || '▪'; }
  function blockDef(type) { return BLOCK_TYPES.find((b) => b.type === type); }
  function shortUrl(u) { const s = String(u); return s.length > 34 ? '…' + s.slice(-32) : s; }
  function productSeed() {
    const prods = (S.brand && Array.isArray(S.brand.products) ? S.brand.products : []).slice(0, 2);
    if (!prods.length) return [{ name: 'Product', price: '', imageUrl: '' }];
    return prods.map((p) => typeof p === 'string'
      ? { name: p, price: '', imageUrl: '' }
      : { name: p.name || 'Product', price: p.price != null ? String(p.price) : '', imageUrl: p.image || p.imageUrl || '' });
  }
  function nextBlockId() { return 'b' + (S.edIdSeq++); }
  // Adopt server ids on load; keep the counter ahead of any numeric client id.
  function seedIdSeq(doc) {
    let max = S.edIdSeq;
    (doc.blocks || []).forEach((b) => { const m = /^b(\d+)$/.exec(b.id || ''); if (m) max = Math.max(max, Number(m[1]) + 1); });
    S.edIdSeq = max;
  }
  function ensureBlockIds(doc) {
    (doc.blocks || []).forEach((b) => { if (!b.id) b.id = nextBlockId(); });
  }

  // ---- M5: "New example" opens the editor DIRECTLY. AI lives INSIDE the
  // editor (the "Draft with AI" drawer on the left), so you can start on a
  // blank canvas and generate/build, all in one surface. ----
  function openEditorBlank() {
    if (!S.pitch) return;
    const brand = S.brand ? {
      name: S.brand.name,
      primaryHex: S.brand.primary_hex || undefined,
      logoUrl: S.brand.logo_url || undefined,
    } : {};
    enterEditor({ version: 1, brand, blocks: [] }, null,
      (S.pitch && S.pitch.title) ? (S.pitch.title + ' email') : 'New email');
    setLine('edAiStatus', '');
    $('edAiList').innerHTML = '';
  }
  // Replace the canvas doc in place (from an AI draft) without leaving the
  // editor or losing the current save target.
  function setDocInEditor(doc, title) {
    S.doc = (doc && typeof doc === 'object' && Array.isArray(doc.blocks)) ? doc : { version: 1, blocks: [] };
    seedIdSeq(S.doc); ensureBlockIds(S.doc);
    S.edSelId = S.doc.blocks.length ? S.doc.blocks[0].id : null;
    if (title) $('edTitle').value = title;
    renderPalette(); renderLibrary(); renderBlocks(); renderProps(); renderPreview();
    markDirty();
  }
  async function edAiFromIdea() {
    const text = $('edAiIdea').value.trim();
    if (!text) { $('edAiIdea').focus(); return; }
    const btn = $('edAiGo');
    busy(btn, true);
    setLine('edAiStatus', 'Drafting onto the canvas…', true);
    try {
      const out = await api('/api/pitches/' + encodeURIComponent(S.pitch.id) + '/ai-doc', {
        brief: text, useCase: text, author: author(),
      });
      if (out && out.error) { setLine('edAiStatus', 'Error: ' + out.error); return; }
      setDocInEditor((out && out.doc) || { version: 1, blocks: [] });
      $('edAiIdea').value = '';
      setLine('edAiStatus', 'Drafted — click any block to edit it.');
    } catch (e) { setLine('edAiStatus', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }
  async function edAiPropose() {
    if (!S.brand) { setLine('edAiStatus', 'Research a brand first.'); return; }
    const btn = $('edAiProposeBtn');
    busy(btn, true, 'Thinking…');
    setLine('edAiStatus', 'Drafting use-cases for ' + S.brand.name + '…', true);
    try {
      const out = await api('/usecases', { brand: S.brand.name, brief: (S.pitch && S.pitch.brief) || undefined, count: 6 });
      if (out && out.error) { setLine('edAiStatus', 'Error: ' + out.error); return; }
      const list = $('edAiList'); list.innerHTML = '';
      (out.useCases || []).forEach((u) => {
        const card = el('div', 'ed-ai-uc');
        card.appendChild(el('div', 'ed-ai-uc-title', u.title || 'Use-case'));
        const meta = el('div', 'chips'); chip(meta, 'module', moduleName(u.moduleId)); card.appendChild(meta);
        card.onclick = () => edAiFromProposal(u);
        list.appendChild(card);
      });
      setLine('edAiStatus', (out.useCases || []).length ? 'Pick one to draft it onto the canvas.' : 'No proposals — type your own idea.');
    } catch (e) { setLine('edAiStatus', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }
  async function edAiFromProposal(u) {
    setLine('edAiStatus', 'Drafting “' + (u.title || 'idea') + '”…', true);
    try {
      const out = await api('/api/pitches/' + encodeURIComponent(S.pitch.id) + '/ai-doc', {
        moduleId: u.moduleId, useCase: u.title, brief: (S.pitch && S.pitch.brief) || u.title || '', author: author(),
      });
      if (out && out.error) { setLine('edAiStatus', 'Error: ' + out.error); return; }
      setDocInEditor((out && out.doc) || { version: 1, blocks: [] }, u.title);
      $('edAiList').innerHTML = '';
      setLine('edAiStatus', 'Drafted — click any block to edit it.');
    } catch (e) { setLine('edAiStatus', 'Error: ' + e.message); }
  }

  // ---- open the editor: fresh (from ai-doc) or from an existing doc example.
  async function openEditorNew() {
    if (!S.pitch) return;
    const btn = $('edNew');
    busy(btn, true, 'Drafting…');
    setLine('edNewStatus', 'Asking the genie for a starting layout…', true);
    try {
      const out = await api('/api/pitches/' + encodeURIComponent(S.pitch.id) + '/ai-doc', {
        brief: (S.pitch && S.pitch.brief) || '', author: author(),
      });
      if (out && out.error) { setLine('edNewStatus', 'Error: ' + out.error); return; }
      const doc = (out && out.doc) || { version: 1, blocks: [] };
      setLine('edNewStatus', '');
      enterEditor(doc, null, (S.pitch && S.pitch.title) || 'New email');
    } catch (e) { setLine('edNewStatus', 'Error: ' + e.message); }
    finally { busy(btn, false); }
  }
  // Open ANY example in the editor: a doc example loads its stored blocks; a
  // legacy interactive example is synthesized into an editable doc server-side
  // (/as-doc). Saving PATCHes the same example, so editing an old AMP updates
  // it in place.
  async function openEditorForExample() {
    const x = S.example; if (!x) return;
    let doc = null;
    const raw = x.doc_json != null ? x.doc_json : x.docJson;
    try { doc = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { doc = null; }
    if (doc && Array.isArray(doc.blocks)) { enterEditor(doc, x.id, x.title || 'Email'); return; }
    setLine('exStatus', 'Opening in the editor…', true);
    try {
      const out = await getJson('/api/examples/' + encodeURIComponent(x.id) + '/as-doc');
      if (!out || out.error || !out.doc || !Array.isArray(out.doc.blocks)) {
        setLine('exStatus', 'Error: ' + ((out && out.error) || 'this example cannot be edited as a document.'));
        return;
      }
      setLine('exStatus', '');
      enterEditor(out.doc, x.id, x.title || 'Email');
    } catch (e) { setLine('exStatus', 'Error: ' + e.message); }
  }
  function enterEditor(doc, exampleId, title) {
    S.doc = doc && typeof doc === 'object' ? doc : { version: 1, blocks: [] };
    if (!Array.isArray(S.doc.blocks)) S.doc.blocks = [];
    seedIdSeq(S.doc);
    ensureBlockIds(S.doc);
    S.editingExampleId = exampleId || null;
    S.edSelId = S.doc.blocks.length ? S.doc.blocks[0].id : null;
    S.edDirty = false;
    $('edTitle').value = title || '';
    setLine('edSaveErr', '');
    switchView('editor');
    renderPalette();
    renderLibrary();
    renderBlocks();
    renderProps();
    setSaved();
    renderPreview();
    // Pull the freshest shared brand library (teammates upload via Supabase);
    // don't trust stale S.assets. Best-effort — the editor works without it.
    refreshBrandAssets().catch(() => {});
  }
  // Re-GET the brand so the asset library reflects teammates' uploads. Updates
  // S.assets + S.brand.products in place, then repaints the library grid.
  async function refreshBrandAssets() {
    const brandId = (S.brand && S.brand.id) || (S.pitch && (S.pitch.brand_id || S.pitch.brandId));
    if (!brandId) return;
    const data = await getJson('/api/brands/' + encodeURIComponent(brandId));
    if (data && data.error) return;
    if (data.brand || data.id) S.brand = data.brand || data;
    const assets = listOf(data, ['assets']).length ? listOf(data, ['assets']) : listOf(S.brand, ['assets']);
    if (assets.length || !S.assets) S.assets = assets;
    const prods = listOf(data, ['products']);
    if (prods.length && S.brand) S.brand.products = prods;
    if (document.getElementById('view-editor') && document.getElementById('view-editor').classList.contains('on')) {
      renderLibrary();
      if (selectedBlock() && selectedBlock().type === 'products') renderProps();
    }
  }
  function leaveEditor() {
    switchView('pitch');
    switchWTab('examples');
    showExDetail(false);
    refreshPitch();
  }

  // ---- dirty tracking + save indicator ----
  function markDirty() { S.edDirty = true; setSaved(); scheduleRender(); }
  function setSaved() {
    const el0 = $('edSaved');
    if (S.edDirty) { el0.textContent = '• unsaved'; el0.className = 'ed-saved unsaved'; }
    else { el0.textContent = S.editingExampleId ? 'Saved' : 'Not saved yet'; el0.className = 'ed-saved' + (S.editingExampleId ? ' saved' : ''); }
  }

  // ---- LEFT: palette (Layout blocks + Interactive modules) ----
  function paletteBtn(def, opts) {
    const b = el('button', 'ed-add-btn'); b.type = 'button';
    b.appendChild(el('span', 'ed-add-ic', def.glyph));
    b.appendChild(el('span', 'ed-add-lbl', def.label));
    if (opts && opts.disabled) {
      b.disabled = true; b.classList.add('disabled');
      b.title = (opts.hint || '');
    } else {
      b.onclick = () => addBlock(def.type);
    }
    return b;
  }
  function renderPalette() {
    const box = $('edPalette'); box.innerHTML = '';
    box.appendChild(el('div', 'ed-pal-group', 'Layout'));
    BLOCK_TYPES.forEach((def) => box.appendChild(paletteBtn(def)));
    box.appendChild(el('div', 'ed-pal-group', 'Interactive'));
    const locked = docHasInteractive();
    INTERACTIVE_TYPES.forEach((def) => {
      box.appendChild(paletteBtn(def, locked ? { disabled: true, hint: 'one interactive block per email' } : null));
    });
    if (locked) box.appendChild(el('div', 'ed-pal-note', 'One interactive block per email.'));
  }
  function addBlock(type) {
    let block;
    if (isInteractive(type)) {
      if (docHasInteractive()) return; // guard: one per email
      block = { id: nextBlockId(), type, props: {} };
    } else {
      const def = blockDef(type); if (!def) return;
      block = { id: nextBlockId(), type, props: def.make() };
    }
    const idx = S.doc.blocks.findIndex((b) => b.id === S.edSelId);
    if (idx >= 0) S.doc.blocks.splice(idx + 1, 0, block);
    else S.doc.blocks.push(block);
    S.edSelId = block.id;
    renderPalette(); renderBlocks(); renderProps();
    markDirty();
  }

  // ---- LEFT: brand ASSET LIBRARY (shared, collaborative) ----
  //      #edDrawer stays the id (e2e finds it); #edLibrary is an alias for the
  //      same panel. Renders: upload control + drag/pick thumbnail grid.
  function renderLibrary() {
    const box = $('edDrawer'); box.innerHTML = '';
    // --- upload control (dropzone + file input) ---
    const up = el('div', 'ed-lib-upload');
    const zone = el('div', 'ed-lib-drop');
    zone.appendChild(el('span', 'ed-lib-drop-ic', '⇪'));
    zone.appendChild(el('span', 'ed-lib-drop-txt', 'Drop images or click to upload'));
    const input = el('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.className = 'ed-lib-file';
    input.id = 'edLibFile';
    zone.appendChild(input);
    zone.onclick = () => input.click();
    up.appendChild(zone);
    const status = el('div', 'ed-lib-status'); status.id = 'edLibStatus';
    up.appendChild(status);
    wireDropzone(zone, input, (files) => libraryUpload(files));
    box.appendChild(up);
    // --- thumbnail grid ---
    const grid = el('div', 'ed-lib-grid'); grid.id = 'edLibGrid';
    const assets = (S.assets || []).filter((a) => assetUrl(a));
    if (!assets.length) {
      grid.appendChild(el('div', 'empty-note ed-lib-empty',
        'Upload images or add them in the pitch’s Assets tab — your whole team shares this library.'));
    } else {
      assets.forEach((a) => grid.appendChild(libraryCell(a)));
    }
    box.appendChild(grid);
  }
  function libraryCell(a) {
    const url = assetUrl(a);
    const cell = el('div', 'ed-asset'); cell.draggable = true;
    cell.title = a.filename || 'asset';
    const img = el('img'); img.src = url; img.loading = 'lazy'; img.alt = a.filename || 'asset';
    cell.appendChild(img);
    const cap = el('div', 'ed-asset-cap');
    cap.appendChild(el('span', 'ed-asset-name', a.filename || 'file'));
    const by = a.uploadedBy || a.uploaded_by || a.created_by || a.author;
    if (by) cap.appendChild(el('span', 'ed-asset-by', String(by)));
    cell.appendChild(cap);
    cell.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/asset-url', url);
      e.dataTransfer.setData('text/plain', url);
      e.dataTransfer.effectAllowed = 'copy';
    });
    return cell;
  }
  // Upload file(s) in-editor -> POST /assets -> refresh the shared library.
  async function libraryUpload(files) {
    const brandId = (S.brand && S.brand.id) || (S.pitch && (S.pitch.brand_id || S.pitch.brandId));
    const status = $('edLibStatus');
    if (!brandId) { if (status) status.textContent = 'Research the brand first — uploads need a brand to land in.'; return; }
    const imgs = Array.from(files).filter((f) => /^image\//.test(f.type) || !f.type);
    if (!imgs.length) { if (status) status.textContent = 'Only image files can be added to the library.'; return; }
    for (let i = 0; i < imgs.length; i++) {
      if (status) status.textContent = 'Uploading ' + (i + 1) + '/' + imgs.length + ' — ' + imgs[i].name + '…';
      try { await uploadAsset(imgs[i], 'image', brandId); }
      catch (e) { if (status) status.textContent = 'Error: ' + e.message; return; }
    }
    if (status) status.textContent = imgs.length + ' image' + (imgs.length > 1 ? 's' : '') + ' uploaded — shared with your team.';
    try { await refreshBrandAssets(); } catch (e) { renderLibrary(); }
  }

  // ---- CENTER: block list (select / delete / duplicate / reorder) ----
  function renderBlocks() {
    const box = $('edBlocks'); box.innerHTML = '';
    if (!S.doc.blocks.length) { box.appendChild(el('div', 'empty-note', 'Empty email — add a block from the left.')); return; }
    S.doc.blocks.forEach((blk, i) => {
      const def = blockDef(blk.type);
      const inter = isInteractive(blk.type);
      const card = el('div', 'ed-block' + (blk.id === S.edSelId ? ' sel' : '') + (inter ? ' ed-block-inter' : ''));
      card.dataset.id = blk.id;
      const canDropAsset = /^(hero|image|header|products)$/.test(blk.type);

      const handle = el('span', 'ed-handle', '⋮⋮'); handle.title = 'Drag to reorder';
      card.appendChild(handle);

      const icon = el('span', 'ed-block-ic', typeGlyph(blk.type));
      card.appendChild(icon);

      const body = el('div', 'ed-block-body');
      body.appendChild(el('div', 'ed-block-type', typeLabel(blk.type)));
      const sum = inter ? (blk.props && blk.props.head ? blk.props.head : 'Interactive module')
                        : ((def && def.summary(blk.props || {})) || '');
      body.appendChild(el('div', 'ed-block-sum', sum));
      body.onclick = () => selectBlock(blk.id);
      card.appendChild(body);

      const acts = el('div', 'ed-block-acts');
      const up = el('button', 'ed-iconbtn', '↑'); up.type = 'button'; up.title = 'Move up'; up.disabled = i === 0;
      up.onclick = () => moveBlock(blk.id, -1);
      const down = el('button', 'ed-iconbtn', '↓'); down.type = 'button'; down.title = 'Move down'; down.disabled = i === S.doc.blocks.length - 1;
      down.onclick = () => moveBlock(blk.id, 1);
      const dup = el('button', 'ed-iconbtn', '⧉'); dup.type = 'button';
      dup.title = inter ? 'One interactive block per email' : 'Duplicate';
      dup.disabled = inter;
      dup.onclick = () => duplicateBlock(blk.id);
      const del = el('button', 'ed-iconbtn danger', '✕'); del.type = 'button'; del.title = 'Delete';
      del.onclick = () => deleteBlock(blk.id);
      [up, down, dup, del].forEach((b) => acts.appendChild(b));
      card.appendChild(acts);

      // HTML5 drag-reorder (up/down buttons above are the reliable fallback).
      handle.draggable = true;
      handle.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/block-id', blk.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', (e) => {
        const types = e.dataTransfer.types || [];
        const isBlock = types.indexOf && types.indexOf('text/block-id') >= 0;
        const isAsset = types.indexOf && types.indexOf('text/asset-url') >= 0;
        if (isBlock) { e.preventDefault(); card.classList.add('drag-over'); }
        else if (isAsset && canDropAsset) { e.preventDefault(); card.classList.add('drop-armed'); }
      });
      card.addEventListener('dragleave', () => { card.classList.remove('drag-over'); card.classList.remove('drop-armed'); });
      card.addEventListener('drop', (e) => {
        card.classList.remove('drag-over'); card.classList.remove('drop-armed');
        const movedId = e.dataTransfer.getData('text/block-id');
        const assetUrl0 = e.dataTransfer.getData('text/asset-url');
        if (movedId) { e.preventDefault(); reorderBlock(movedId, blk.id); }
        else if (assetUrl0 && canDropAsset) { e.preventDefault(); dropAssetOnBlock(blk, assetUrl0); }
      });

      box.appendChild(card);
    });
    renderSelBar(); // keep the in-canvas toolbar in sync with every mutation
  }
  function blockIndex(id) { return S.doc.blocks.findIndex((b) => b.id === id); }
  function moveBlock(id, dir) {
    const i = blockIndex(id); if (i < 0) return;
    const j = i + dir; if (j < 0 || j >= S.doc.blocks.length) return;
    const [b] = S.doc.blocks.splice(i, 1); S.doc.blocks.splice(j, 0, b);
    S.edSelId = id; renderBlocks(); renderProps(); markDirty();
  }
  function reorderBlock(movedId, targetId) {
    if (movedId === targetId) return;
    const from = blockIndex(movedId), to = blockIndex(targetId);
    if (from < 0 || to < 0) return;
    const [b] = S.doc.blocks.splice(from, 1);
    S.doc.blocks.splice(blockIndex(targetId) + (from < to ? 1 : 0), 0, b);
    S.edSelId = movedId; renderBlocks(); renderProps(); markDirty();
  }
  function duplicateBlock(id) {
    const i = blockIndex(id); if (i < 0) return;
    const src = S.doc.blocks[i];
    if (isInteractive(src.type)) return; // can't duplicate: one interactive per email
    const copy = { id: nextBlockId(), type: src.type, props: JSON.parse(JSON.stringify(src.props || {})) };
    S.doc.blocks.splice(i + 1, 0, copy);
    S.edSelId = copy.id; renderBlocks(); renderProps(); markDirty();
  }
  function deleteBlock(id) {
    const i = blockIndex(id); if (i < 0) return;
    S.doc.blocks.splice(i, 1);
    if (S.edSelId === id) S.edSelId = S.doc.blocks.length ? S.doc.blocks[Math.min(i, S.doc.blocks.length - 1)].id : null;
    renderPalette(); renderBlocks(); renderProps(); markDirty();
  }
  function dropAssetOnBlock(blk, url) {
    if (blk.type === 'products') {
      blk.props.items = blk.props.items && blk.props.items.length ? blk.props.items : [{ name: 'Product', price: '', imageUrl: '' }];
      blk.props.items[0].imageUrl = url;
    } else if (blk.type === 'header') {
      blk.props.logoUrl = url;
    } else {
      blk.props.imageUrl = url; // hero + image
    }
    renderBlocks();
    if (S.edSelId === blk.id) renderProps();
    markDirty();
  }

  // ---- RIGHT: properties for the selected block ----
  function selectedBlock() { return S.doc.blocks.find((b) => b.id === S.edSelId) || null; }
  function renderProps() {
    const box = $('edProps'); box.innerHTML = '';
    const blk = selectedBlock();
    if (!blk) { box.appendChild(el('div', 'ed-props-empty', 'Select a block to edit its content, or add one from the left.')); return; }
    const def = blockDef(blk.type);
    // header: icon + type name
    const hdr = el('div', 'ed-props-hdr');
    hdr.appendChild(el('span', 'ed-props-hdr-ic', typeGlyph(blk.type)));
    hdr.appendChild(el('span', 'ed-props-hdr-name', typeLabel(blk.type)));
    box.appendChild(hdr);
    const set = (key, val) => { blk.props[key] = val; renderBlocks(); markDirty(); };
    if (!blk.props || typeof blk.props !== 'object') blk.props = {};
    // Interactive modules: one labelled copy field per its field-map entry.
    if (isInteractive(blk.type)) {
      const note = el('div', 'ed-props-note');
      note.textContent = typeLabel(blk.type) + ' — interactivity is baked in; edit the copy here.';
      box.appendChild(note);
      const sec = el('div', 'ed-props-sec', 'Copy');
      box.appendChild(sec);
      (INTERACTIVE_FIELDS[blk.type] || []).forEach((f) => {
        // multi-line copy for the longer prose fields; single-line for headings/labels/short prompts
        const long = /^(teaserText|footerText|assumptionText|verdictText|promptText)$/.test(f);
        const label = fieldLabel(f);
        box.appendChild(long
          ? areaField(label, blk.props[f] || '', (v) => set(f, v))
          : field(label, blk.props[f] || '', (v) => set(f, v)));
      });
      return;
    }
    switch (blk.type) {
      case 'header':
        box.appendChild(field('Brand name', blk.props.brandName || '', (v) => set('brandName', v)));
        box.appendChild(urlField('Logo URL', blk.props.logoUrl || '', (v) => set('logoUrl', v)));
        box.appendChild(field('Link (href)', blk.props.link || '', (v) => set('link', v)));
        break;
      case 'hero':
        box.appendChild(urlField('Image URL', blk.props.imageUrl || '', (v) => set('imageUrl', v)));
        box.appendChild(field('Alt text', blk.props.alt || '', (v) => set('alt', v)));
        box.appendChild(field('Height (px)', blk.props.height || '', (v) => set('height', v)));
        break;
      case 'text':
        box.appendChild(field('Heading', blk.props.heading || '', (v) => set('heading', v)));
        box.appendChild(areaField('Body', blk.props.body || '', (v) => set('body', v)));
        break;
      case 'image':
        box.appendChild(urlField('Image URL', blk.props.imageUrl || '', (v) => set('imageUrl', v)));
        box.appendChild(field('Alt text', blk.props.alt || '', (v) => set('alt', v)));
        box.appendChild(field('Link (href)', blk.props.href || '', (v) => set('href', v)));
        break;
      case 'button':
        box.appendChild(field('Label', blk.props.label || '', (v) => set('label', v)));
        box.appendChild(field('Link (href)', blk.props.href || '', (v) => set('href', v)));
        box.appendChild(selectField('Align', ['left', 'center', 'right'], blk.props.align || 'center', (v) => set('align', v)));
        break;
      case 'products':
        box.appendChild(productsEditor(blk));
        box.appendChild(selectField('Columns', ['1', '2', '3'], String(blk.props.columns || 2), (v) => set('columns', Number(v))));
        break;
      case 'footer':
        box.appendChild(field('Brand name', blk.props.brandName || '', (v) => set('brandName', v)));
        box.appendChild(areaField('Text', blk.props.text || '', (v) => set('text', v)));
        break;
      case 'divider':
        box.appendChild(el('div', 'ed-props-empty', 'A divider has no settings — reorder or delete it.'));
        break;
      default:
        box.appendChild(el('div', 'ed-props-empty', 'No editor for this block type.'));
    }
  }
  // property-field builders (label + input, live oninput)
  // camelCase field key -> human label, e.g. "footerText" -> "Footer text".
  function fieldLabel(key) {
    const words = String(key).replace(/([A-Z])/g, ' $1').trim();
    return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
  }
  function ctrl(labelText) { const c = el('div', 'ctrl'); c.appendChild(el('label', '', labelText)); return c; }
  function field(labelText, value, onChange) {
    const c = ctrl(labelText); const i = el('input'); i.type = 'text'; i.value = value;
    i.oninput = () => onChange(i.value); c.appendChild(i); return c;
  }
  function areaField(labelText, value, onChange) {
    const c = ctrl(labelText); const t = el('textarea'); t.rows = 3; t.value = value;
    t.oninput = () => onChange(t.value); c.appendChild(t); return c;
  }
  function selectField(labelText, opts, value, onChange) {
    const c = ctrl(labelText); const s = el('select');
    opts.forEach((o) => { const op = el('option', '', o); op.value = o; if (o === value) op.selected = true; s.appendChild(op); });
    s.onchange = () => onChange(s.value); c.appendChild(s); return c;
  }
  // URL field with a "Choose from assets" affordance: reveals the drawer, then
  // arms the next drawer click to fill THIS field (in addition to drag-drop).
  function urlField(labelText, value, onChange) {
    const c = ctrl(labelText);
    // current-image thumbnail preview (if set)
    const prev = el('div', 'ed-url-prev');
    function paintPrev(v) {
      prev.innerHTML = '';
      if (v) { const im = el('img'); im.src = v; im.loading = 'lazy'; im.alt = 'current'; prev.appendChild(im); prev.style.display = ''; }
      else { prev.style.display = 'none'; }
    }
    const row = el('div', 'ed-url-row');
    const i = el('input'); i.type = 'text'; i.value = value; i.placeholder = 'https://…';
    i.oninput = () => { onChange(i.value); paintPrev(i.value); };
    const pick = el('button', 'ghost sm', 'Choose from library'); pick.type = 'button'; pick.title = 'Pick an uploaded image';
    pick.onclick = () => armAssetPick((url) => { i.value = url; onChange(url); paintPrev(url); });
    row.appendChild(i); row.appendChild(pick);
    c.appendChild(prev); c.appendChild(row);
    paintPrev(value);
    return c;
  }
  // Repeatable products editor: name / price / image rows + add/remove, each
  // row's image using the library-pick affordance, plus a brand-products picker.
  function productsEditor(blk) {
    const wrap = ctrl('Products');
    const rows = el('div', 'ed-prod-rows');
    if (!Array.isArray(blk.props.items)) blk.props.items = [];
    blk.props.items.forEach((item, idx) => {
      const row = el('div', 'ed-prod-row');
      const name = el('input'); name.type = 'text'; name.placeholder = 'Name'; name.value = item.name || '';
      name.oninput = () => { item.name = name.value; renderBlocks(); markDirty(); };
      const price = el('input'); price.type = 'text'; price.placeholder = 'Price'; price.value = item.price != null ? String(item.price) : '';
      price.oninput = () => { item.price = price.value; markDirty(); };
      const img = el('input'); img.type = 'text'; img.placeholder = 'Image URL'; img.value = item.imageUrl || item.image || '';
      img.oninput = () => { item.imageUrl = img.value; markDirty(); };
      // library-pick button for THIS row's image
      const pick = el('button', 'ed-iconbtn', '▤'); pick.type = 'button'; pick.title = 'Choose image from library';
      pick.onclick = () => armAssetPick((url) => { img.value = url; item.imageUrl = url; renderBlocks(); markDirty(); });
      const rm = el('button', 'ed-iconbtn danger', '✕'); rm.type = 'button'; rm.title = 'Remove';
      rm.onclick = () => { blk.props.items.splice(idx, 1); renderProps(); renderBlocks(); markDirty(); };
      [name, price, img, pick, rm].forEach((n) => row.appendChild(n));
      rows.appendChild(row);
    });
    wrap.appendChild(rows);
    const btns = el('div', 'ed-prod-btns');
    const add = el('button', 'ghost sm', '+ add product'); add.type = 'button';
    add.onclick = () => { blk.props.items.push({ name: 'Product', price: '', imageUrl: '' }); renderProps(); renderBlocks(); markDirty(); };
    btns.appendChild(add);
    // "Add from brand products" picker (GET /api/brands/:id products[])
    const brandProds = (S.brand && Array.isArray(S.brand.products) ? S.brand.products : []).filter((p) => p && (typeof p === 'string' || p.name));
    if (brandProds.length) {
      const fromBrand = el('button', 'ghost sm', '+ from brand products'); fromBrand.type = 'button';
      fromBrand.onclick = () => togglePicker();
      btns.appendChild(fromBrand);
      const picker = el('div', 'ed-prod-picker'); picker.style.display = 'none';
      brandProds.forEach((p) => {
        const item = typeof p === 'string' ? { name: p } : p;
        const row = el('button', 'ed-prod-pick-row'); row.type = 'button';
        const thumb = el('span', 'ed-prod-pick-thumb');
        const purl = item.image_url || item.image || item.imageUrl || '';
        if (purl) { const im = el('img'); im.src = purl; im.loading = 'lazy'; thumb.appendChild(im); }
        row.appendChild(thumb);
        const info = el('span', 'ed-prod-pick-info');
        info.appendChild(el('span', 'ed-prod-pick-name', item.name || 'Product'));
        if (item.price != null && item.price !== '') info.appendChild(el('span', 'ed-prod-pick-price', String(item.price)));
        row.appendChild(info);
        row.onclick = () => {
          blk.props.items.push({ name: item.name || 'Product', price: item.price != null ? String(item.price) : '', imageUrl: purl });
          renderProps(); renderBlocks(); markDirty();
        };
        picker.appendChild(row);
      });
      wrap.appendChild(btns);
      wrap.appendChild(picker);
      function togglePicker() { picker.style.display = picker.style.display === 'none' ? 'flex' : 'none'; }
      return wrap;
    }
    wrap.appendChild(btns);
    return wrap;
  }
  // asset-pick arming: the drawer thumbnails also respond to a plain click
  // while a URL field is waiting for one.
  let _assetPickCb = null;
  function armAssetPick(cb) {
    _assetPickCb = cb;
    const box = $('edDrawer');
    box.querySelectorAll('.ed-asset').forEach((cell) => {
      cell.classList.add('drop-armed');
      cell.onclick = () => {
        const img = cell.querySelector('img');
        if (_assetPickCb && img) _assetPickCb(img.src);
        _assetPickCb = null;
        box.querySelectorAll('.ed-asset').forEach((c) => { c.classList.remove('drop-armed'); c.onclick = null; });
      };
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---- PREVIEW: debounced POST /api/docs/render ----
  let _renderTimer = null;
  // ---- selection is shared by the block list AND the phone canvas ----
  function selectBlock(id) {
    S.edSelId = id;
    renderBlocks();
    renderSelBar();
    renderProps();
    highlightCanvas();
  }

  // The in-canvas toolbar for the selected block: name + move/duplicate/delete,
  // above the phone. Replaces the old block-list column's per-row controls.
  function renderSelBar() {
    const bar = $('edSelBar'); if (!bar) return;
    bar.innerHTML = '';
    const blk = S.doc && S.doc.blocks.find((b) => b.id === S.edSelId);
    if (!blk) { bar.appendChild(el('span', 'ed-selbar-empty', 'Click a block in the email to edit it')); return; }
    const i = S.doc.blocks.findIndex((b) => b.id === blk.id);
    const inter = isInteractive(blk.type);
    const tag = el('span', 'ed-selbar-tag' + (inter ? ' inter' : ''));
    tag.appendChild(el('span', 'ed-block-ic', typeGlyph(blk.type)));
    tag.appendChild(el('span', '', typeLabel(blk.type)));
    bar.appendChild(tag);
    const acts = el('div', 'ed-selbar-acts');
    const mk = (glyph, title, fn, disabled, danger) => {
      const b = el('button', 'ed-iconbtn' + (danger ? ' danger' : ''), glyph);
      b.type = 'button'; b.title = title; b.disabled = !!disabled; b.onclick = fn; return b;
    };
    acts.appendChild(mk('↑', 'Move up', () => moveBlock(blk.id, -1), i === 0));
    acts.appendChild(mk('↓', 'Move down', () => moveBlock(blk.id, 1), i === S.doc.blocks.length - 1));
    if (!inter) acts.appendChild(mk('⧉', 'Duplicate', () => duplicateBlock(blk.id)));
    acts.appendChild(mk('✕', 'Delete', () => deleteBlock(blk.id), false, true));
    bar.appendChild(acts);
  }

  // ---- M2: edit INSIDE the phone. The rendered AMP carries data-bid anchors
  // (server adds them for the editor preview only); clicking a block in the
  // iframe selects it and opens its settings. The iframe is srcdoc + same
  // origin, so we can reach its document, inject a selection style, and
  // capture clicks before the AMP runtime treats them as taps. ----
  function canvasDoc() {
    try { return $('edFrame').contentDocument; } catch (e) { return null; }
  }
  function anchorOf(cd, node) {
    while (node && node !== cd.body) {
      if (node.dataset && node.dataset.bid) return node;
      node = node.parentNode;
    }
    return null;
  }
  function highlightCanvas() {
    const cd = canvasDoc(); if (!cd || !cd.body) return;
    cd.querySelectorAll('.edg-sel,.edg-hover').forEach((n) => n.classList.remove('edg-sel', 'edg-hover'));
    if (S.edSelId) {
      const sel = cd.querySelector('[data-bid="' + String(S.edSelId).replace(/"/g, '') + '"]');
      if (sel) sel.classList.add('edg-sel');
    }
  }
  function bindCanvas() {
    const cd = canvasDoc(); if (!cd || !cd.body) return;
    if (!cd.getElementById('edg-style')) {
      const st = cd.createElement('style'); st.id = 'edg-style';
      st.textContent = '.edg-a{cursor:pointer;transition:outline .1s}'
        + '.edg-a.edg-hover{outline:2px dashed #e78129;outline-offset:-2px}'
        + '.edg-a.edg-sel{outline:2px solid #e78129;outline-offset:-2px}';
      (cd.head || cd.documentElement).appendChild(st);
    }
    cd.addEventListener('mouseover', (e) => {
      const a = anchorOf(cd, e.target);
      cd.querySelectorAll('.edg-hover').forEach((n) => n.classList.remove('edg-hover'));
      if (a && a.dataset.bid !== S.edSelId) a.classList.add('edg-hover');
    });
    cd.addEventListener('mouseout', () => {
      cd.querySelectorAll('.edg-hover').forEach((n) => n.classList.remove('edg-hover'));
    });
    // Capture phase so a click SELECTS (edit mode) rather than triggering the
    // module's amp-bind tap.
    cd.addEventListener('click', (e) => {
      if (S.editMode === false) return; // interact mode (M6): let AMP handle it
      const a = anchorOf(cd, e.target);
      if (a) { e.preventDefault(); e.stopPropagation(); selectBlock(a.dataset.bid); }
    }, true);
    highlightCanvas();
  }

  function scheduleRender() { clearTimeout(_renderTimer); _renderTimer = setTimeout(renderPreview, 400); }
  async function renderPreview() {
    clearTimeout(_renderTimer);
    if (!S.doc) return;
    const chip0 = $('edChip'); chip0.className = 'chip rendering'; chip0.textContent = 'rendering…';
    try {
      const out = await api('/api/docs/render', { doc: S.doc });
      if (out && out.error && !out.ampHtml) { chip0.className = 'chip fail'; chip0.textContent = 'render error'; $('edWarn').textContent = out.error; return; }
      // Re-bind the canvas each time the iframe reloads (srcdoc wipes it).
      $('edFrame').onload = bindCanvas;
      $('edFrame').srcdoc = out.ampHtml || '';
      // Prefer the server's sanitized doc so ids/shape stay in lockstep.
      if (out.doc && Array.isArray(out.doc.blocks)) mergeSanitized(out.doc);
      const v = out.validation || {};
      if (v.pass) { chip0.className = 'chip pass'; chip0.textContent = 'PASS'; }
      else { chip0.className = 'chip fail'; chip0.textContent = 'FAIL' + (v.errorCount != null ? ' · ' + v.errorCount : ''); }
      const warns = Array.isArray(out.warnings) ? out.warnings : [];
      $('edWarn').textContent = warns.length ? warns.map((w) => (typeof w === 'string' ? w : (w.message || JSON.stringify(w)))).join(' · ') : '';
    } catch (e) {
      chip0.className = 'chip fail'; chip0.textContent = 'render error';
      $('edWarn').textContent = e.message;
    }
  }
  // Adopt the server's sanitized doc without clobbering focus/selection: only
  // reconcile when the block set (ids+types) matches, so live typing is safe.
  function mergeSanitized(sdoc) {
    const a = S.doc.blocks, b = sdoc.blocks;
    if (a.length !== b.length) return;
    for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id || a[i].type !== b[i].type) return;
    if (sdoc.brand !== undefined) S.doc.brand = sdoc.brand;
    if (sdoc.currency !== undefined) S.doc.currency = sdoc.currency;
    if (sdoc.version !== undefined) S.doc.version = sdoc.version;
  }

  // ---- SAVE: PATCH existing doc example, else POST a new one ----
  async function saveDoc() {
    if (!S.doc) return;
    const title = $('edTitle').value.trim() || 'Untitled email';
    const btn = $('edSave');
    busy(btn, true, 'Saving…');
    setLine('edSaveErr', '');
    try {
      let out;
      if (S.editingExampleId) {
        out = await req('PATCH', '/api/examples/' + encodeURIComponent(S.editingExampleId) + '/doc', { doc: S.doc, author: author() });
      } else {
        out = await api('/api/pitches/' + encodeURIComponent(S.pitch.id) + '/doc-examples', { title, doc: S.doc, author: author() });
      }
      if (!out || out.error) {
        const val = out && out.validation;
        let msg = 'Error: ' + ((out && out.error) || 'save failed');
        if (val && val.errorCount != null) msg += ' — ' + val.errorCount + ' AMP validation error' + (val.errorCount === 1 ? '' : 's') + ' (your work is safe; fix and re-save)';
        setLine('edSaveErr', msg);
        return;
      }
      const ex = out.example || (out.build && out.build.example) || out;
      if (ex && ex.id) S.editingExampleId = ex.id; // subsequent saves PATCH in place
      S.edDirty = false; setSaved();
      setLine('edSaveErr', '');
    } catch (e) { setLine('edSaveErr', 'Error: ' + e.message); }
    finally { busy(btn, false); }
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

    // examples: "New example" opens the visual editor directly (M5); the AI
    // drafting lives inside it (the "Draft with AI" drawer).
    $('exNew').onclick = openEditorBlank;
    $('edAiGo').onclick = edAiFromIdea;
    $('edAiIdea').onkeydown = (e) => { if (e.key === 'Enter') edAiFromIdea(); };
    $('edAiProposeBtn').onclick = edAiPropose;
    $('exBackBtn').onclick = () => { showExDetail(false); refreshPitch(); };
    $('exShare').onclick = copyShareLink;
    $('exDownload').onclick = downloadExample;
    $('exCopyAmp').onclick = copyExampleAmp;
    $('exTweakGo').onclick = tweakExample;
    $('exTweak').onkeydown = (e) => { if (e.key === 'Enter') tweakExample(); };
    $('exEditDoc').onclick = openEditorForExample;

    // visual block editor
    $('edNew').onclick = openEditorNew;
    $('edBack').onclick = leaveEditor;
    $('edSave').onclick = saveDoc;
    $('edTitle').oninput = () => { S.edDirty = true; setSaved(); };

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
