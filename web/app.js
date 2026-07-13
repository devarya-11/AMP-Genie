(function () {
  const $ = (id) => document.getElementById(id);
  const PLAYGROUND = 'https://amp.gmail.dev/playground/';

  const S = { meta: null, result: null, edited: null, counter: 0, colorTouched: false, active: 'preview', briefOverLimit: false, building: false };
  const BRIEF_MAX = 2000;
  // Guided-wizard state: the dossier and proposal being refined before build.
  const W = { dossier: null, useCases: [], gColorTouched: false };

  // Lightweight identity for team attribution: a name kept in localStorage and
  // stamped onto every build/slate this browser creates. Not auth — access
  // control is Cloudflare Access's job (see SETUP-CLOUDFLARE.md).
  const AUTHOR_KEY = 'genieAuthor';
  function author() { try { return (localStorage.getItem(AUTHOR_KEY) || '').trim() || null; } catch (e) { return null; } }

  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  }

  function setLine(id, t, loading) {
    const s = $(id); s.innerHTML = '';
    if (loading) { const sp = document.createElement('span'); sp.className = 'spinner'; s.appendChild(sp); }
    if (t) s.appendChild(document.createTextNode(t));
  }
  function setStatus(t, loading) { setLine('status', t, loading); }

  // ---------- init ----------
  async function init() {
    const m = await (await fetch('/api/meta')).json();
    S.meta = m;
    bind();
    loadHistory();
    loadPitches();
  }

  function bind() {
    // shell navigation
    document.querySelectorAll('.nav-item').forEach((b) => b.onclick = () => switchView(b.dataset.view));
    $('modeGuided').onclick = () => switchMode(true);
    $('modeQuick').onclick = () => switchMode(false);

    // guided wizard
    $('gResearch').onclick = research;
    $('gPropose').onclick = propose;
    $('ucReroll').onclick = reroll;
    $('ucAddIdea').onclick = addIdea;
    $('ucBuild').onclick = buildFromUseCases;
    $('gBrand').onkeydown = (e) => { if (e.key === 'Enter') research(); };
    $('gColorpick').oninput = () => { $('gColorhex').value = $('gColorpick').value; W.gColorTouched = true; };
    $('gColorhex').oninput = () => { if (/^#[0-9a-f]{6}$/i.test($('gColorhex').value)) $('gColorpick').value = $('gColorhex').value; W.gColorTouched = true; };

    // brands view
    $('bShow').onclick = lookupBrand;
    $('bSearch').onkeydown = (e) => { if (e.key === 'Enter') lookupBrand(); };
    $('bUse').onclick = () => {
      switchView('create'); switchMode(true);
      $('gBrand').value = $('bSearch').value.trim();
      research();
    };
    $('kAddProduct').onclick = () => addProductRow();
    $('kSave').onclick = saveKit;

    // quick generate (v2 flow, unchanged)
    $('colorpick').oninput = () => { $('colorhex').value = $('colorpick').value; S.colorTouched = true; };
    $('colorhex').oninput = () => { if (/^#[0-9a-f]{6}$/i.test($('colorhex').value)) $('colorpick').value = $('colorhex').value; S.colorTouched = true; };
    $('rub').onclick = () => build(false);
    $('surprise').onclick = () => { S.counter++; build(true); };
    $('copy').onclick = copyCode;
    $('download').onclick = downloadCode;
    $('share').onclick = copyShareLink;
    $('authorName').value = author() || '';
    $('authorName').onchange = () => { try { localStorage.setItem(AUTHOR_KEY, $('authorName').value.trim()); } catch (e) {} };
    $('revalidate').onclick = revalidate;
    $('resetCode').onclick = resetCode;
    $('dispatch').onclick = doDispatch;
    $('tweakGo').onclick = doTweak;
    $('tweakPrompt').onkeydown = (e) => { if (e.key === 'Enter') doTweak(); };
    $('code').oninput = onEdit;
    $('campaignBrief').oninput = updateBriefCounter;
    document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
    $('devToggle').onchange = () => {
      document.body.classList.toggle('dev-mode', $('devToggle').checked);
      if (!$('devToggle').checked && (S.active === 'code' || S.active === 'validation')) switchTab('preview');
    };
    $('historyToggle').onclick = toggleHistory;
    updateBriefCounter();
  }

  // ---------- shell: views + create modes ----------
  function switchView(name) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + name));
    if (name === 'history') loadHistory();
    if (name === 'pitches') loadPitches();
  }
  function switchMode(guided) {
    $('modeGuided').classList.toggle('on', guided);
    $('modeQuick').classList.toggle('on', !guided);
    $('guided').classList.toggle('hidden', !guided);
    $('quick').classList.toggle('hidden', guided);
  }

  // ---------- guided wizard: research -> questionnaire -> proposal -> build ----------
  async function research() {
    const brand = $('gBrand').value.trim();
    if (!brand) { setLine('gStatus1', 'Type a brand name first.'); $('gBrand').focus(); return; }
    setLine('gStatus1', 'Researching ' + brand + ' — site, products, voice…', true);
    $('gResearch').disabled = true;
    try {
      const out = await api('/usecases', { brand, notes: $('gNotes').value.trim() || null, count: 1 });
      if (out.error) { setLine('gStatus1', 'Error: ' + out.error); return; }
      W.dossier = out.dossier || null;
      renderDossier(W.dossier);
      $('wstep2').classList.remove('hidden');
      $('wstep3').classList.add('hidden');
      W.useCases = [];
      setLine('gStatus1', '');
      $('wstep2').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setLine('gStatus1', 'Error: ' + e.message);
    } finally {
      $('gResearch').disabled = false;
    }
  }

  function renderDossier(d) {
    const card = $('dossierCard');
    if (!d) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    $('dossierConf').textContent = d.confidence === 'llm' ? 'LLM-researched' : 'heuristic (no LLM key)';
    $('dossierSummary').textContent = d.summary || 'No public summary found — add notes above and re-research, or just continue.';
    const chips = $('dossierChips'); chips.innerHTML = '';
    if (d.vertical) chip(chips, 'vertical', d.vertical);
    (d.voice && d.voice.adjectives || []).slice(0, 4).forEach((a) => chip(chips, 'voice', a));
    (d.currentCampaigns || []).slice(0, 3).forEach((c) => chip(chips, 'campaign', c));
    // Products land in the questionnaire as tap-to-include picks.
    const picks = $('qProducts'); picks.innerHTML = '';
    const prods = (d.products || []).slice(0, 10);
    if (!prods.length) { picks.innerHTML = '<span class="hint">none found — name products in the must-include box below</span>'; }
    prods.forEach((p) => {
      const c = el('button', 'chip pick', p);
      c.type = 'button';
      c.onclick = () => c.classList.toggle('on');
      picks.appendChild(c);
    });
  }

  // The questionnaire folds into a synthesized brief — the same channel the
  // engines already understand (routing, signals, LLM context), so guided
  // answers and a hand-typed quick brief are one code path server-side.
  function synthesizedBrief() {
    const parts = [];
    if ($('qGoal').value) parts.push('Goal: ' + $('qGoal').value + '.');
    if ($('qAudience').value.trim()) parts.push('Audience: ' + $('qAudience').value.trim() + '.');
    if ($('qMoment').value.trim()) parts.push('Campaign moment: ' + $('qMoment').value.trim() + '.');
    const picked = Array.from(document.querySelectorAll('#qProducts .chip.on')).map((c) => c.textContent);
    if (picked.length) parts.push('Feature these products: ' + picked.join(', ') + '.');
    if ($('qMustHave').value.trim()) parts.push('Must include: ' + $('qMustHave').value.trim());
    return parts.join(' ') || null;
  }

  async function propose() {
    setLine('gStatus2', 'Drafting use-cases for ' + ($('gBrand').value.trim() || 'this brand') + '…', true);
    $('gPropose').disabled = true;
    try {
      const out = await api('/usecases', {
        brand: $('gBrand').value.trim(), notes: $('gNotes').value.trim() || null,
        brief: synthesizedBrief(), count: 6,
      });
      if (out.error) { setLine('gStatus2', 'Error: ' + out.error); return; }
      W.useCases = out.useCases || [];
      if (out.dossier) { W.dossier = out.dossier; renderDossier(out.dossier); }
      renderUseCases(out.source);
      setLine('gStatus2', '');
      $('wstep3').classList.remove('hidden');
      $('wstep3').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setLine('gStatus2', 'Error: ' + e.message);
    } finally {
      $('gPropose').disabled = false;
    }
  }

  async function reroll() {
    const feedback = $('ucFeedback').value.trim();
    setLine('gStatus3', feedback ? 'Rerolling with your steer…' : 'Rerolling…', true);
    $('ucReroll').disabled = true;
    try {
      const out = await api('/usecases', {
        brand: $('gBrand').value.trim(), notes: $('gNotes').value.trim() || null,
        brief: synthesizedBrief(), count: 6,
        feedback: feedback || null,
        prior: W.useCases.map((u) => u.title),
      });
      if (out.error) { setLine('gStatus3', 'Error: ' + out.error); return; }
      W.useCases = out.useCases || [];
      renderUseCases(out.source);
      $('ucFeedback').value = '';
      setLine('gStatus3', '');
    } catch (e) { setLine('gStatus3', 'Error: ' + e.message); } finally { $('ucReroll').disabled = false; }
  }

  async function addIdea() {
    const idea = $('ucFeedback').value.trim();
    if (!idea) { setLine('gStatus3', 'Describe the use-case you want in the box first.'); $('ucFeedback').focus(); return; }
    setLine('gStatus3', 'Shaping your idea into a use-case…', true);
    $('ucAddIdea').disabled = true;
    try {
      const out = await api('/usecases', { brand: $('gBrand').value.trim(), notes: $('gNotes').value.trim() || null, idea });
      if (out.error) { setLine('gStatus3', 'Error: ' + out.error); return; }
      if (out.useCase) { W.useCases.push(out.useCase); renderUseCases(); $('ucFeedback').value = ''; }
      setLine('gStatus3', '');
    } catch (e) { setLine('gStatus3', 'Error: ' + e.message); } finally { $('ucAddIdea').disabled = false; }
  }

  function renderUseCases(source) {
    if (source) $('ucSource').textContent = source === 'library' ? 'library playbook (LLM idle: key missing, cooling down, or unreachable)' : 'LLM-proposed';
    const list = $('ucList'); list.innerHTML = '';
    W.useCases.forEach((u, i) => {
      const card = el('div', 'uc-card');
      const top = el('div', 'uc-top');
      top.appendChild(el('span', 'uc-title', u.title));
      const rm = el('button', 'uc-remove', '✕');
      rm.type = 'button'; rm.title = 'Remove this use-case';
      rm.onclick = () => { W.useCases.splice(i, 1); renderUseCases(); };
      top.appendChild(rm);
      card.appendChild(top);
      card.appendChild(el('div', 'uc-goal', u.businessGoal || ''));
      const meta = el('div', 'chips');
      chip(meta, 'module', moduleName(u.moduleId));
      if (u.trigger) chip(meta, 'trigger', u.trigger);
      if (u.kpi) chip(meta, 'kpi', u.kpi);
      card.appendChild(meta);
      list.appendChild(card);
    });
    $('ucCount').textContent = W.useCases.length ? '(' + W.useCases.length + ')' : '';
    $('ucBuild').disabled = !W.useCases.length;
  }
  function moduleName(id) {
    const m = (S.meta && S.meta.modules || []).find((x) => x.id === id);
    return m ? m.name : id;
  }

  async function buildFromUseCases() {
    if (!W.useCases.length) return;
    setLine('gStatus3', 'Building ' + W.useCases.length + ' validated emails — this takes a moment…', true);
    $('ucBuild').disabled = true;
    try {
      const body = {
        brand: $('gBrand').value.trim() || 'Acme',
        brief: synthesizedBrief(),
        author: author(),
        useCases: W.useCases.map((u) => ({ title: u.title, moduleId: u.moduleId, contentPlan: u.contentPlan || {} })),
      };
      if (W.gColorTouched && /^#[0-9a-f]{6}$/i.test($('gColorhex').value)) body.colorOverride = $('gColorhex').value;
      const out = await api('/slate', body);
      if (out.error) { setLine('gStatus3', 'Error: ' + out.error); return; }
      renderSlate(out);
      setLine('gStatus3', 'Done — ' + out.builds.length + ' validated emails on one pitch page.');
      loadHistory(); loadPitches();
      $('slateResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setLine('gStatus3', 'Error: ' + e.message);
    } finally {
      $('ucBuild').disabled = !W.useCases.length;
    }
  }

  // ---------- brands view ----------
  async function lookupBrand() {
    const brand = $('bSearch').value.trim();
    if (!brand) { $('bSearch').focus(); return; }
    setLine('bStatus', 'Looking up ' + brand + '…', true);
    try {
      const out = await api('/usecases', { brand, count: 1 });
      if (out.error) { setLine('bStatus', 'Error: ' + out.error); return; }
      const d = out.dossier || {};
      $('brandCard').classList.remove('hidden');
      $('bSummary').textContent = d.summary || 'Nothing on file — research it from the Create tab.';
      const chips = $('bChips'); chips.innerHTML = '';
      if (d.vertical) chip(chips, 'vertical', d.vertical);
      if (d.confidence) chip(chips, 'research', d.confidence);
      (d.products || []).slice(0, 8).forEach((p) => chip(chips, 'product', p));
      (d.voice && d.voice.adjectives || []).slice(0, 4).forEach((a) => chip(chips, 'voice', a));
      setLine('bStatus', '');
      // The kit editor loads alongside the dossier — assets are the part the
      // team curates by hand.
      try {
        const kres = await fetch('/brandkit/' + encodeURIComponent(brandSlug(brand)));
        const kdata = await kres.json();
        fillKitEditor(kdata && kdata.kit);
      } catch (e) { fillKitEditor(null); }
    } catch (e) { setLine('bStatus', 'Error: ' + e.message); }
  }

  // ---------- brand kit editor ----------
  // Same slug rule as the server (store.js brandSlug) so the editor reads and
  // writes the record the pipeline will actually consult.
  function brandSlug(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function addProductRow(p) {
    const box = $('kProducts');
    if (box.children.length >= 8) return;
    const row = el('div', 'kit-product-row');
    const name = el('input'); name.placeholder = 'Product name'; name.value = (p && p.name) || '';
    const price = el('input'); price.placeholder = '₹ price'; price.value = (p && p.price != null) ? p.price : '';
    const image = el('input'); image.placeholder = 'https://…/product.jpg'; image.value = (p && p.image) || '';
    const rm = el('button', 'uc-remove', '✕'); rm.type = 'button'; rm.onclick = () => row.remove();
    [name, price, image, rm].forEach((n) => row.appendChild(n));
    box.appendChild(row);
  }

  function fillKitEditor(kit) {
    $('kitCard').classList.remove('hidden');
    $('kLogo').value = (kit && kit.logoUrl) || '';
    $('kHero').value = (kit && kit.heroUrl) || '';
    $('kColor').value = (kit && kit.primary) || '';
    $('kVoice').value = (kit && kit.voiceSample) || '';
    $('kProducts').innerHTML = '';
    ((kit && kit.products) || []).forEach((p) => addProductRow(p));
    if (!$('kProducts').children.length) addProductRow();
    $('kMsg').textContent = '';
  }

  async function saveKit() {
    const slug = brandSlug($('bSearch').value);
    if (!slug) { $('kMsg').textContent = 'Look up a brand first.'; return; }
    const products = Array.from($('kProducts').children).map((row) => {
      const [name, price, image] = Array.from(row.querySelectorAll('input')).map((i) => i.value.trim());
      const out = { name };
      if (price) out.price = Number(price.replace(/[^0-9.]/g, ''));
      if (image) out.image = image;
      return out;
    }).filter((p) => p.name);
    const body = {
      name: $('bSearch').value.trim(),
      // '' means "clear this field" server-side; absent means keep — the
      // editor always sends current values, so clearing a box clears the kit.
      logoUrl: $('kLogo').value.trim(),
      heroUrl: $('kHero').value.trim(),
      voiceSample: $('kVoice').value.trim(),
      products,
      author: author(),
    };
    const colour = $('kColor').value.trim();
    if (colour) body.primary = colour;
    $('kSave').disabled = true;
    $('kMsg').textContent = 'Saving…';
    try {
      const out = await api('/brandkit/' + encodeURIComponent(slug), body);
      if (out && out.ok) {
        $('kMsg').textContent = 'Saved — every future build for this brand uses these assets.';
      } else {
        $('kMsg').textContent = (out && out.error) || 'Save failed.';
      }
    } catch (e) {
      $('kMsg').textContent = 'Save failed: ' + e.message;
    } finally {
      $('kSave').disabled = false;
    }
  }

  // ---------- pitches view ----------
  async function loadPitches() {
    try {
      const res = await fetch('/slates');
      if (!res.ok) return;
      const data = await res.json();
      renderPitches((data && data.items) || []);
    } catch (e) { /* endpoint optional — the view keeps its empty note */ }
  }
  function renderPitches(items) {
    const list = $('pitchesList');
    if (!items.length) { list.innerHTML = '<div class="empty-note">No pitches yet — build a slate from the Create tab.</div>'; return; }
    list.innerHTML = '';
    items.forEach((p) => {
      const row = el('a', 'pitch-row');
      row.href = '/s/' + p.id; row.target = '_blank'; row.rel = 'noopener';
      const main = el('div', 'pitch-main');
      main.appendChild(el('span', 'pitch-title', p.title || (p.brand + ' — pitch slate')));
      main.appendChild(el('span', 'pitch-meta', (p.buildIds ? p.buildIds.length : '?') + ' emails' + (p.author ? ' · ' + p.author : '') + (p.ts ? ' · ' + new Date(p.ts).toLocaleDateString() : '')));
      row.appendChild(main);
      const open = el('span', 'slate-build-open', 'open ↗');
      row.appendChild(open);
      list.appendChild(row);
    });
  }

  // ---------- campaign brief: soft character guidance, never a hard cutoff ----------
  function updateBriefCounter() {
    const len = $('campaignBrief').value.length;
    const over = len > BRIEF_MAX;
    $('briefCount').textContent = len + '/' + BRIEF_MAX;
    $('briefCount').classList.toggle('over', over);
    $('briefWarn').classList.toggle('hidden', !over);
    S.briefOverLimit = over;
    if (!S.building) $('rub').disabled = over;
  }

  // ---------- build affordance: genie-lamp smoke loading animation ----------
  const LAMP_LOADING_HTML =
    '<svg class="lamp-anim" viewBox="0 0 64 48" aria-hidden="true">' +
      '<defs>' +
        '<linearGradient id="lampBodyGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#f2a94e"/><stop offset="1" stop-color="#c2691c"/>' +
        '</linearGradient>' +
        '<radialGradient id="smokeGrad" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0" stop-color="#4c88f8" stop-opacity=".9"/><stop offset="1" stop-color="#5257b3" stop-opacity="0"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<g class="lamp-smoke">' +
        '<circle class="wisp wisp-1" cx="54" cy="25" r="5" fill="url(#smokeGrad)"/>' +
        '<circle class="wisp wisp-2" cx="54" cy="25" r="4" fill="url(#smokeGrad)"/>' +
        '<circle class="wisp wisp-3" cx="54" cy="25" r="3.2" fill="url(#smokeGrad)"/>' +
      '</g>' +
      '<path d="M16 34C4 36 2 20 14 14" fill="none" stroke="#c2691c" stroke-width="3" stroke-linecap="round"/>' +
      '<ellipse cx="29" cy="40" rx="20" ry="3" fill="#00000030"/>' +
      '<path d="M8 38C8 26 18 18 30 18c8 0 14 4 17 10l7-3 2 5-7 3c.6 1.6 1 3.3 1 5Z" fill="url(#lampBodyGrad)"/>' +
      '<circle cx="54" cy="25" r="2.6" fill="#d5945e"/>' +
    '</svg> Conjuring&hellip;';

  let RUB_LABEL = '';
  function setBuilding(on, success) {
    const rub = $('rub');
    S.building = on;
    if (on) {
      if (!RUB_LABEL) RUB_LABEL = rub.innerHTML;
      rub.classList.add('loading'); rub.disabled = true;
      rub.innerHTML = LAMP_LOADING_HTML;
      return;
    }
    const finish = () => {
      rub.classList.remove('loading'); rub.disabled = S.briefOverLimit;
      if (RUB_LABEL) rub.innerHTML = RUB_LABEL;
    };
    if (success) {
      const lamp = rub.querySelector('.lamp-anim');
      if (lamp) { lamp.classList.add('success'); setTimeout(finish, 300); }
      else finish();
    } else {
      finish();
    }
  }

  // ---------- quick generate: the one click ----------
  async function build() {
    if ($('campaignBrief').value.length > BRIEF_MAX) {
      setStatus('Trim the campaign brief below ' + BRIEF_MAX + ' characters to Rub the lAMP.');
      return;
    }
    setBuilding(true);
    const slateMode = $('slateToggle').checked;
    setStatus(slateMode ? 'Conjuring the full slate — validated emails on one page…' : 'Rubbing the lamp…', true);
    let ok = false;
    try {
      const body = {
        brand: $('brand').value.trim() || 'Acme',
        counter: S.counter,
        brief: $('campaignBrief').value.trim() || null,
        author: author(),
      };
      if (S.colorTouched && /^#[0-9a-f]{6}$/i.test($('colorhex').value)) body.colorOverride = $('colorhex').value;
      if (slateMode) {
        const out = await api('/slate', body);
        if (out.error) { setStatus('Error: ' + out.error); return; }
        renderSlate(out);
        setStatus('Done — ' + out.builds.length + ' validated emails on one pitch page.');
      } else {
        const out = await api('/generate', body);
        if (out.error) { setStatus('Error: ' + out.error); return; }
        S.result = out;
        S.edited = null;
        // A fresh generation starts a fresh version chain.
        S.rootId = null;
        $('versionsRow').classList.add('hidden');
        $('tweakMsg').textContent = '';
        if (!S.colorTouched) { $('colorhex').value = out.palette.primary; $('colorpick').value = out.palette.primary; }
        $('slateResult').classList.add('hidden');
        $('result').classList.remove('hidden');
        renderResult();
        setStatus(out.validation.pass ? 'Done — valid AMP4EMAIL, zero errors.' : 'Done — see Validation tab for issues.');
      }
      ok = true;
      loadHistory(); loadPitches();
    } catch (e) {
      setStatus('Error: ' + e.message);
    } finally {
      setBuilding(false, ok);
    }
  }

  // ---------- slate rendering: the pitch deliverable ----------
  function renderSlate(out) {
    $('result').classList.add('hidden');
    const box = $('slateResult');
    box.classList.remove('hidden');
    $('slateTitle').textContent = out.title || (out.brand + ' — pitch slate');
    $('slateSub').textContent = out.builds.length + ' interactive modules, each validated AMP4EMAIL';
    const open = $('slateOpen');
    if (out.sharePath) {
      open.href = out.sharePath;
      open.classList.remove('hidden');
      $('slateMsg').textContent = '';
    } else {
      open.classList.add('hidden');
      $('slateMsg').textContent = 'Share pages unavailable — storage is not configured on this server.';
    }
    const list = $('slateBuilds'); list.innerHTML = '';
    out.builds.forEach((b) => {
      const row = el('div', 'slate-build');
      const name = el('span', 'slate-build-name', b.useCase || b.moduleName);
      const chipEl = el('span', 'chip ' + (b.validation && b.validation.pass ? 'pass' : 'fail'), b.validation && b.validation.pass ? 'valid' : 'invalid');
      row.appendChild(name);
      row.appendChild(chipEl);
      if (b.sharePath) {
        const a = el('a', 'slate-build-open', 'open');
        a.href = b.sharePath; a.target = '_blank'; a.rel = 'noopener';
        row.appendChild(a);
      }
      list.appendChild(row);
    });
  }

  // ---------- refine: prompt-to-tweak with version chains ----------
  // The LLM (or the deterministic parser when no key is set) turns the prompt
  // into a parameter edit-plan; the server rebuilds through generate() and the
  // real validator, persists the new version with parentId/rootId lineage, and
  // an invalid result is rejected server-side — this box can never ship a
  // broken email.
  async function doTweak() {
    const prompt = $('tweakPrompt').value.trim();
    const msg = $('tweakMsg');
    if (!prompt) { $('tweakPrompt').focus(); return; }
    if (!S.result || !S.result.shareId) return;
    const btn = $('tweakGo');
    btn.disabled = true;
    msg.className = 'dispatch-msg'; msg.innerHTML = '<span class="spinner"></span> Rebuilding&hellip;';
    try {
      const out = await api('/tweak', { buildId: S.result.shareId, prompt, author: author() });
      if (!out.ok) { msg.className = 'dispatch-msg err'; msg.textContent = out.error || 'Tweak failed.'; return; }
      S.result = out.response;
      S.edited = null;
      S.rootId = (out.build && (out.build.rootId || out.build.parentId)) || S.rootId || null;
      renderResult();
      msg.className = 'dispatch-msg ok'; msg.textContent = 'Applied — new validated version.';
      $('tweakPrompt').value = '';
      loadVersions();
      loadHistory();
    } catch (e) {
      msg.className = 'dispatch-msg err'; msg.textContent = 'Tweak failed: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function loadVersions() {
    const row = $('versionsRow');
    if (!S.rootId) { row.classList.add('hidden'); return; }
    try {
      const res = await fetch('/versions/' + encodeURIComponent(S.rootId));
      const data = await res.json();
      const items = (data && data.items) || [];
      row.innerHTML = '';
      const mk = (label, id, title) => {
        const a = el('a', 'chip', label);
        a.href = '/b/' + id; a.target = '_blank'; a.rel = 'noopener';
        if (title) a.title = title;
        if (S.result && S.result.shareId === id) a.classList.add('pass');
        row.appendChild(a);
      };
      mk('original', S.rootId, 'the first generation');
      items.forEach((v, i) => mk('v' + (i + 2), v.id, v.tweakPrompt || ''));
      row.classList.toggle('hidden', !items.length);
    } catch (e) { /* lineage is a nicety — never an error */ }
  }

  async function copyShareLink() {
    if (!S.result || !S.result.sharePath) return;
    const url = location.origin + S.result.sharePath;
    try { await navigator.clipboard.writeText(url); flash($('share'), 'Link copied!'); }
    catch (e) { flash($('share'), url); }
  }

  // ---------- result rendering ----------
  function renderResult() {
    const r = S.result;
    $('conjured').innerHTML = '';
    $('conjured').appendChild(document.createTextNode('The genie conjured: ' + r.moduleName));
    $('conjured').appendChild(el('small', '', r.kind));

    const chips = $('chips'); chips.innerHTML = '';
    chip(chips, 'brand', r.brand);
    chip(chips, 'vertical', r.vertical);
    chip(chips, 'tone', r.tone);
    chip(chips, 'colour', r.palette.primary + ' (' + (r.colorSource || '?') + ')');
    if (r.copySource) chip(chips, 'copy', r.copySource);
    $('share').classList.toggle('hidden', !r.sharePath);
    // Tweaking rebuilds from the persisted record, so it needs a stored build.
    $('tweakBox').classList.toggle('hidden', !r.sharePath);

    const note = $('briefNote');
    if (r.brief) {
      note.classList.remove('hidden');
      note.innerHTML = '<b>Brief:</b> ' + escapeHtml(r.brief);
    } else {
      note.classList.add('hidden');
      note.innerHTML = '';
    }

    $('code').value = currentCode();
    updateEditedIndicator();
    renderPreview();
    renderValidation(r.validation);
  }

  // Directive 7: the preview IS the email. Render the exact generated AMP inside
  // a sandboxed iframe that boots the real AMP runtime (amp-bind / amp-form /
  // amp-img, the amp4email boilerplate reveal) — not a hand-written JS mirror
  // that can drift from what actually ships. The iframe is created once and
  // reused; srcdoc carries the doc verbatim so no extra route or request is
  // involved and the bytes shown are byte-identical to the download.
  //
  // sandbox: allow-scripts (the AMP runtime + every interaction needs JS) and
  // allow-same-origin (the runtime refuses to boot in a sandboxed frame without
  // it). That pair is normally powerful, but the content here is our OWN
  // validator-passed AMP, not third-party HTML — the iframe is a rendering
  // surface, never a trust boundary for untrusted code.
  function renderPreview() {
    const area = $('previewArea');
    let frame = area.querySelector('iframe.amp-frame');
    if (!frame) {
      area.textContent = '';
      frame = document.createElement('iframe');
      frame.className = 'amp-frame';
      frame.title = 'Interactive AMP email preview';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      area.appendChild(frame);
    }
    // Always the last SUCCESSFULLY generated (validator-passed) AMP — never the
    // live-edited textarea, which may be mid-edit invalid; edits stay flagged by
    // the stale badge (updateEditedIndicator) exactly as before.
    frame.srcdoc = S.result.ampHtml;
  }

  function chip(box, k, v) { const c = el('span', 'chip'); c.innerHTML = '<b>' + escapeHtml(String(k)) + '</b> ' + escapeHtml(String(v)); box.appendChild(c); }

  function renderValidation(v) {
    const dot = $('valDot'); dot.className = 'statdot ' + (v.pass ? 'pass' : 'fail');
    const verdict = $('verdict'); verdict.className = 'verdict ' + (v.pass ? 'pass' : 'fail');
    verdict.innerHTML = '';
    verdict.appendChild(svg(v.pass ? 'i-check' : 'i-cross'));
    verdict.appendChild(document.createTextNode(v.pass ? 'PASS — valid AMP4EMAIL, zero errors' : 'FAIL — ' + v.errorCount + ' error(s)'));
    $('playground').href = PLAYGROUND;
    const list = $('errors'); list.innerHTML = '';
    (v.errors || []).forEach((er) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="loc">' + er.line + ':' + er.col + '</span>' + escapeHtml(er.message);
      list.appendChild(li);
    });
  }

  // ---------- history: read-only review of past builds ----------
  async function loadHistory() {
    try {
      const res = await fetch('/history');
      const data = await res.json();
      renderHistory((data && data.items) || []);
    } catch (e) { /* best-effort review aid */ }
  }

  function renderHistory(items) {
    const list = $('historyList');
    list.innerHTML = '';
    if (!items.length) { list.innerHTML = '<div class="empty-note">No builds yet.</div>'; return; }
    items.forEach((it) => list.appendChild(historyItem(it)));
  }

  function toggleHistory() {
    const btn = $('historyToggle');
    const list = $('historyList');
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    list.classList.toggle('hidden', open);
  }

  function historyItem(it) {
    const row = el('div', 'history-item');

    const hdr = el('div', 'history-item-hdr');
    const title = el('span', 'history-item-title', (it.brand || '?') + ' — ' + (it.moduleName || it.moduleId || '?'));
    const when = el('span', 'history-item-when', it.ts ? new Date(it.ts).toLocaleString() : '');
    hdr.appendChild(title); hdr.appendChild(when);
    row.appendChild(hdr);

    const meta = el('div', 'history-item-meta');
    meta.innerHTML =
      '<span class="chip"><b>vertical</b> ' + escapeHtml(String(it.vertical || '?')) + '</span>' +
      '<span class="chip"><b>tone</b> ' + escapeHtml(String(it.tone || '?')) + '</span>' +
      '<span class="chip ' + (it.validationPass ? 'pass' : 'fail') + '"><b>validation</b> ' + (it.validationPass ? 'pass' : 'fail') + '</span>' +
      (it.shareId ? ' <a class="slate-build-open" target="_blank" rel="noopener" href="/b/' + encodeURIComponent(it.shareId) + '">open</a>' : '');
    row.appendChild(meta);

    if (it.brief) {
      row.appendChild(el('div', 'history-item-brief', it.brief));
    } else {
      row.appendChild(el('div', 'history-item-brief empty', 'No campaign brief given.'));
    }
    return row;
  }

  // ---------- code editing ----------
  function currentCode() { return S.edited != null ? S.edited : S.result.ampHtml; }
  // The preview mirrors the last GENERATED build, so a keystroke in the code box
  // only flips the stale badge — it does not (and must not) reload the AMP iframe
  // on every character (that would refetch the runtime and flash the frame).
  function onEdit() { S.edited = $('code').value; updateEditedIndicator(); }
  function updateEditedIndicator() {
    const edited = S.edited != null && S.edited !== S.result.ampHtml;
    $('editedDot').classList.toggle('hidden', !edited);
    $('editedLabel').classList.toggle('hidden', !edited);
    $('previewStale').classList.toggle('hidden', !edited);
  }
  async function revalidate() {
    setStatus('Validating edited code…');
    const v = await api('/validate', { ampHtml: $('code').value });
    renderValidation(v);
    switchTab('validation');
    setStatus(v.pass ? 'Edited code is valid.' : 'Edited code FAILED validation.');
  }
  function resetCode() {
    S.edited = null;
    $('code').value = S.result.ampHtml;
    updateEditedIndicator();
    renderValidation(S.result.validation);
    renderPreview();
  }

  // ---------- copy / download ----------
  async function copyCode() {
    const text = currentCode();
    try {
      await navigator.clipboard.writeText(text);
      flash($('copy'), 'Copied!');
    } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      flash($('copy'), ok ? 'Copied!' : 'Press Ctrl/Cmd+C in the code box');
    }
  }
  function flash(btn, msg) {
    const o = btn.innerHTML;
    btn.innerHTML = '<svg class="ic"><use href="#i-check"/></svg> ' + msg;
    setTimeout(() => { btn.innerHTML = o; }, 1600);
  }
  function downloadCode() {
    const blob = new Blob([currentCode()], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = (S.result.moduleId || 'amp') + '.html'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- dispatch ----------
  async function doDispatch() {
    const to = $('dispatchTo').value.trim();
    const msg = $('dispatchMsg');
    if (!to) { msg.className = 'dispatch-msg err'; msg.textContent = 'Enter a recipient email.'; $('dispatchTo').focus(); return; }
    if (!S.result) { msg.className = 'dispatch-msg err'; msg.textContent = 'Rub the lAMP first.'; return; }
    const btn = $('dispatch');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    msg.className = 'dispatch-msg'; msg.innerHTML = '<span class="spinner"></span> Sending&hellip;';
    try {
      const out = await api('/dispatch', {
        to,
        subject: S.result.brand + ' — ' + S.result.moduleName,
        ampHtml: currentCode(),
        fromName: S.result.brand,
        // Branded fallback parts from the same generation context (server
        // fallback.js). They match the last generation, not manual code edits.
        html: S.result.fallbackHtml || undefined,
        text: S.result.fallbackText || undefined,
      });
      if (out && out.ok) {
        msg.className = 'dispatch-msg ok';
        msg.textContent = 'Sent to ' + to + ' — open it in Gmail to see the interactive AMP part.';
      } else {
        msg.className = 'dispatch-msg err';
        msg.textContent = (out && out.error) || 'Send failed.';
      }
    } catch (err) {
      msg.className = 'dispatch-msg err';
      msg.textContent = 'Send failed: ' + err.message;
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  }

  // ---------- tabs ----------
  function switchTab(name) {
    S.active = name;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === name));
  }

  // ---------- tiny dom helpers ----------
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svg(id) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'ic'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#' + id); s.appendChild(u); return s; }
  function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  init();
})();
