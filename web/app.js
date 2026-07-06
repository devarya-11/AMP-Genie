(function () {
  const $ = (id) => document.getElementById(id);
  const PLAYGROUND = 'https://amp.gmail.dev/playground/';

  const S = {
    meta: null, profile: null, result: null, active: 0, edited: {}, counter: 0, colorTouched: false,
    // Phase 1.2 — preview modes: device (mobile/desktop), theme (light/dark), client (amp/outlook).
    preview: { device: 'mobile', theme: 'light', client: 'amp' },
  };

  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  }
  function setStatus(t, loading) {
    const s = $('status'); s.innerHTML = '';
    if (loading) { const sp = document.createElement('span'); sp.className = 'spinner'; s.appendChild(sp); }
    if (t) s.appendChild(document.createTextNode(t));
  }

  // ---------- build affordance: spinner button + preview skeleton ----------
  let RUB_LABEL = '';
  function setBuilding(on) {
    const rub = $('rub');
    if (on) {
      if (!RUB_LABEL) RUB_LABEL = rub.innerHTML;
      rub.classList.add('loading'); rub.disabled = true;
      rub.innerHTML = '<span class="spinner"></span> Conjuring…';
      showPreviewSkeleton();
    } else {
      rub.classList.remove('loading'); rub.disabled = false;
      if (RUB_LABEL) rub.innerHTML = RUB_LABEL;
    }
  }
  function showPreviewSkeleton() {
    $('result').classList.remove('hidden');
    $('previewArea').innerHTML =
      '<div class="sk-stack">' +
      '<div class="skeleton sk-block"></div>' +
      '<div class="skeleton sk-line" style="width:72%"></div>' +
      '<div class="skeleton sk-line" style="width:92%"></div>' +
      '<div class="skeleton sk-line" style="width:54%"></div>' +
      '</div>';
  }

  // ---------- init ----------
  async function init() {
    const m = await (await fetch('/api/meta')).json();
    S.meta = m;
    fill($('vertical'), m.verticals);
    fill($('tone'), m.tones);
    fill($('currency'), m.currencies);
    fill($('ed-currency'), m.currencies);
    fillModules($('moduleSel'), m.prodModules || []);
    bind();
    loadHistory();
  }
  function fill(sel, arr) { (arr || []).forEach((v) => sel.appendChild(opt(v, v))); }
  function opt(v, label) { const o = document.createElement('option'); o.value = v; o.textContent = label; return o; }

  // Use-case dropdown: an "Auto" default + every production module, grouped.
  function fillModules(sel, mods) {
    sel.appendChild(opt('auto', 'Auto — let the genie choose'));
    const groups = {};
    mods.forEach((md) => { (groups[md.group || 'Other'] = groups[md.group || 'Other'] || []).push(md); });
    Object.keys(groups).forEach((g) => {
      const og = document.createElement('optgroup'); og.label = g;
      groups[g].forEach((md) => og.appendChild(opt(md.id, md.name)));
      sel.appendChild(og);
    });
    sel.value = 'auto';
  }

  function bind() {
    $('colorpick').oninput = () => { $('colorhex').value = $('colorpick').value; S.colorTouched = true; };
    $('colorhex').oninput = () => { if (/^#[0-9a-f]{6}$/i.test($('colorhex').value)) $('colorpick').value = $('colorhex').value; S.colorTouched = true; };
    $('rub').onclick = () => build(false);
    $('lockRegen').onclick = lockRegen;
    $('surprise').onclick = () => { S.counter++; build(true); };
    $('copy').onclick = copyCode;
    $('download').onclick = downloadCode;
    $('renderVisuals').onclick = renderVisuals;
    $('revalidate').onclick = revalidate;
    $('resetCode').onclick = resetCode;
    $('dispatch').onclick = doDispatch;
    $('code').oninput = onEdit;
    document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
    // preview-mode segmented controls
    document.querySelectorAll('#deviceSeg button').forEach((b) => b.onclick = () => setMode('device', b.dataset.device));
    document.querySelectorAll('#themeSeg button').forEach((b) => b.onclick = () => setMode('theme', b.dataset.theme));
    document.querySelectorAll('#clientSeg button').forEach((b) => b.onclick = () => setMode('client', b.dataset.client));
    // send-readiness panels
    $('runPreflight').onclick = runPreflight;
    $('runDeliver').onclick = runDeliver;
    $('deliverDomain').oninput = () => { S.deliverTouched = true; };
    // editable subject in the envelope feeds the dispatch
    $('envSubject').oninput = () => { if (S.result) active().subject = $('envSubject').value; };
  }

  // ---------- gather the intake into a /build spec ----------
  function buildSpec() {
    const products = ($('assetProducts').value || '')
      .split(/\n+/).map((s) => s.trim()).filter(Boolean)
      .map((u) => ({ imageUrl: u }));
    // Only send the brand colour when the user actually set it; otherwise let the
    // resolver pick the real brand colour (curated library / fetched site) so the
    // default field value never clobbers it.
    const colors = {};
    if (S.colorTouched && /^#[0-9a-f]{6}$/i.test($('colorhex').value)) colors.primary = $('colorhex').value;
    const accent = $('assetAccent').value.trim();
    if (/^#[0-9a-f]{6}$/i.test(accent)) colors.accent = accent;
    const copy = {};
    if ($('copyHead').value.trim()) copy.headline = $('copyHead').value.trim();
    if ($('copyCode').value.trim()) copy.code = $('copyCode').value.trim();
    return {
      brandUrl: $('url').value.trim(),
      brandName: $('brand').value.trim(),
      moduleId: $('moduleSel').value || 'auto',
      vertical: $('vertical').value,
      tone: $('tone').value,
      currency: $('currency').value,
      copy,
      user: { logo: $('assetLogo').value.trim() || null, colors, products },
      need: { logo: true, products: 3 },
    };
  }

  // ---------- the one click: resolve assets -> build -> validate ----------
  async function build(reroll) {
    setBuilding(true);
    try {
      const spec = buildSpec();
      // One complete, brand-accurate email per Rub. Resolve assets → build → validate.
      setStatus('Rubbing the lamp — resolving assets…', true);
      const out = await api('/build', Object.assign({ reroll: S.counter }, spec));
      if (out.error) { setStatus('Error: ' + out.error); $('previewArea').innerHTML = ''; return; }
      S.result = normalizeBuild(out, spec);
      S.profile = out.brand || null;
      S.lastProvenance = out.provenance || [];
      S.lastSummary = out.summary || {};
      S.lastPalette = out.palette || {};
      S.lastContext = out.context || null;
      renderProvenance(out);
      // Reflect the *resolved* brand colour back into the field (without
      // marking it as a user override) so the chip + field show the real colour.
      if (out.palette && out.palette.primary) setResolvedColor(out.palette.primary);
      S.active = 0; S.edited = {};
      renderResult();
      saveHistory(spec, S.result);
      setStatus(S.result.allValid ? 'Done — valid AMP4EMAIL, zero errors.' : 'Done — see Validation tab for issues.');
    } catch (e) { setStatus('Error: ' + e.message); $('previewArea').innerHTML = ''; }
    finally { setBuilding(false); }
  }

  function normalizeBuild(out, spec) {
    const e = {
      // The email envelope + both static fallbacks come from the same build, so
      // the preview, the Outlook view and the dispatch all use one source.
      subject: out.subject || ((out.brand && out.brand.name ? out.brand.name : 'Brand') + ' — ' + out.moduleName),
      preheader: out.preheader || '',
      fromName: out.fromName || (out.brand && out.brand.name) || 'Brand',
      module: out.moduleId, moduleName: out.moduleName, kind: out.kind,
      tone: (out.brand && out.brand.tone) || spec.tone,
      ampHtml: out.ampHtml, htmlFallback: out.htmlFallback || '', textFallback: out.textFallback || '',
      palette: out.palette, validation: out.validation, accessibility: out.accessibility || null,
      visualStatus: 'rendered',
    };
    return { brand: (out.brand && out.brand.name) || spec.brandName, currency: out.brand && out.brand.currency, emails: [e], allValid: out.validation.pass };
  }

  // ---------- provenance (asset waterfall) ----------
  const TIER_LABEL = { user: 'you', 'brand-site': 'brand site', web: 'open web', generated: 'generated' };
  function renderProvenance(out) {
    $('profilePanel').classList.remove('hidden');
    const b = out.brand || {};
    $('sourceBadge').textContent = b.source || 'synthesised';
    $('sourceBadge').className = 'badge ' + (b.source || '');
    const body = $('profileBody'); body.innerHTML = '';
    body.appendChild(pf('Brand', b.name || '—'));
    body.appendChild(pf('Vertical', b.vertical || '—'));
    body.appendChild(pf('Tone', b.tone || '—'));
    body.appendChild(pf('Currency', b.currency || '—'));
    const palBox = pf('Palette', '');
    const sw = el('div', 'swatches'); const p = out.palette || {};
    ['primary', 'accent', 'tint', 'ink'].forEach((k) => { if (p[k]) { const s = el('div', 'sw'); s.style.background = p[k]; s.title = k + ' ' + p[k]; sw.appendChild(s); } });
    palBox.querySelector('.v').appendChild(sw); body.appendChild(palBox);

    // summary line
    const sum = out.summary || {};
    const sumBox = pf('Assets', Object.keys(sum).map((t) => sum[t] + ' ' + (TIER_LABEL[t] || t)).join(' · ') || '—');
    body.appendChild(sumBox);

    // provenance table
    const prov = el('div', 'provtable');
    (out.provenance || []).forEach((a) => {
      const row = el('div', 'provrow');
      const im = document.createElement('img'); im.className = 'provthumb'; im.src = a.url; im.alt = a.slot; im.loading = 'lazy';
      const info = el('div', 'provinfo');
      info.appendChild(el('div', 'provslot', a.slot + (a.name ? ' · ' + a.name : '')));
      const meta = el('div', 'provmeta');
      const tier = el('span', 'tier ' + a.tier, TIER_LABEL[a.tier] || a.tier);
      meta.appendChild(tier);
      meta.appendChild(document.createTextNode(' ' + (a.source || '') + (a.rehosted ? ' · rehosted→HTTPS' : '')));
      // Phase 1.4 — licence + rights badge (first-party/user/generated = clear; open-web = review).
      if (a.license) meta.appendChild(el('span', 'lic ' + (a.rights === 'review' ? 'review' : 'clear'), a.license));
      info.appendChild(meta);
      if (a.licenseNote) info.appendChild(el('div', 'provlic', a.licenseNote));
      row.appendChild(im); row.appendChild(info);
      prov.appendChild(row);
    });
    const provWrap = el('div', 'pf wide');
    provWrap.appendChild(el('div', 'k', 'Asset provenance'));
    provWrap.appendChild(prov);
    body.appendChild(provWrap);

    // prefill editor
    $('ed-name').value = b.name || ''; $('ed-voice').value = b.voice || '';
    $('ed-currency').value = b.currency || 'INR';
    $('ed-accent').value = (p.accent && /^#[0-9a-f]{6}$/i.test(p.accent)) ? p.accent : '#cc8800';
    $('ed-bg').value = '#ffffff';
    $('ed-primary').value = (p.primary && /^#[0-9a-f]{6}$/i.test(p.primary)) ? p.primary : '#6c2bd9';
  }
  function pf(k, v) {
    const box = el('div', 'pf');
    box.appendChild(el('div', 'k', k));
    box.appendChild(el('div', 'v', v));
    return box;
  }

  // Show a resolved colour in the field without treating it as a user override.
  function setResolvedColor(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
    $('colorhex').value = hex; $('colorpick').value = hex;
    S.colorTouched = false;
  }

  function lockRegen() {
    // Push edited brand fields back into the intake controls, then rebuild.
    $('brand').value = $('ed-name').value;
    $('currency').value = $('ed-currency').value;
    $('colorhex').value = $('ed-primary').value; $('colorpick').value = $('ed-primary').value;
    $('assetAccent').value = $('ed-accent').value;
    S.colorTouched = true; // an edited brand colour is a deliberate override → re-bake both renders
    build(false);
  }

  // ---------- result rendering ----------
  function active() { return S.result.emails[S.active]; }
  function renderResult() {
    $('result').classList.remove('hidden');
    renderActive();
  }

  function renderActive() {
    const e = active();
    $('conjured').innerHTML = '';
    $('conjured').appendChild(document.createTextNode('The genie conjured: ' + e.moduleName));
    $('conjured').appendChild(el('small', '', e.kind));
    const chips = $('chips'); chips.innerHTML = '';
    chip(chips, 'brand', S.result.brand || $('brand').value || 'Brand');
    chip(chips, 'vertical', $('vertical').value);
    chip(chips, 'tone', e.tone);
    chip(chips, 'colour', $('colorhex').value);
    chip(chips, 'module', e.module);
    // code
    const code = S.edited[S.active] != null ? S.edited[S.active] : e.ampHtml;
    $('code').value = code;
    updateEditedIndicator();
    renderEnvelope(e);
    applyStageClasses();
    renderPreview();
    renderValidation(e.validation);
    renderAccessibility(e.accessibility);
    updatePrecheck();
    resetSendPanels();
    prefillDeliverDomain();
    $('visualState').textContent = 'Rendered with resolved HTTPS assets — interact with the preview.';
  }

  // ---------- email envelope (sender / subject / preheader) ----------
  function renderEnvelope(e) {
    const from = e.fromName || S.result.brand || 'Brand';
    $('envFrom').textContent = from;
    $('envAvatar').textContent = (from.trim().charAt(0) || 'B');
    $('envSubject').value = e.subject || '';
    const ph = e.preheader || '';
    $('envPreheader').textContent = ph;
    $('envPreheader').classList.toggle('hidden', !ph);
  }

  // ---------- preview modes (device / theme / client) ----------
  function setMode(kind, val) {
    if (!val || S.preview[kind] === val) {
      // still reflect the active state on the buttons
    }
    S.preview[kind] = val;
    const segId = kind === 'device' ? 'deviceSeg' : kind === 'theme' ? 'themeSeg' : 'clientSeg';
    document.querySelectorAll('#' + segId + ' button').forEach((b) => b.classList.toggle('on', b.dataset[kind] === val));
    applyStageClasses();
    renderPreview();
  }
  function applyStageClasses() {
    $('previewStage').classList.toggle('desktop', S.preview.device === 'desktop');
  }
  function updatePreviewNotices() {
    const dark = S.preview.theme === 'dark';
    const dw = $('darkWarn');
    dw.classList.toggle('hidden', !dark);
    if (dark) dw.innerHTML = '<svg class="ic"><use href="#i-warn"/></svg><span><b>Dark-mode simulation (forced inversion).</b> Mobile Gmail can invert a light email like this. Check that text stays readable, the logo doesn’t vanish on a dark ground, and the CTA still pops.</span>';
    const cn = $('clientNote');
    const outlook = S.preview.client === 'outlook';
    cn.classList.toggle('hidden', !outlook);
    if (outlook) cn.innerHTML = '<svg class="ic"><use href="#i-info"/></svg><span><b>Outlook / non-AMP view.</b> This is the static <code>text/html</code> fallback every non-AMP client receives — intentionally not interactive. It must stand on its own.</span>';
  }
  function chip(box, k, v) { const c = el('span', 'chip'); c.innerHTML = '<b>' + k + '</b> ' + escapeHtml(String(v)); box.appendChild(c); }

  // Mode-aware preview. Gmail·AMP renders the interactive code through the
  // generic interpreter; Outlook·static renders the real text/html fallback in
  // an isolated iframe. Dark theme applies a forced-inversion simulation.
  function renderPreview() {
    const area = $('previewArea');
    if (S.preview.client === 'outlook') {
      const e = active();
      const html = e.htmlFallback || '<p style="font-family:Arial,sans-serif;padding:24px;color:#444">No static fallback was generated for this email.</p>';
      area.innerHTML = '';
      const ifr = document.createElement('iframe');
      ifr.className = 'staticframe';
      ifr.setAttribute('sandbox', '');     // isolate: no scripts, no same-origin
      ifr.setAttribute('title', 'Static HTML fallback preview');
      ifr.srcdoc = html;
      area.appendChild(ifr);
    } else {
      window.GeniePreview.renderAmp(currentCode(), area);
    }
    area.classList.toggle('dark', S.preview.theme === 'dark');
    updatePreviewNotices();
  }

  // ---------- accessibility report ----------
  function renderAccessibility(a) {
    const dot = $('a11yDot'); const body = $('a11yBody');
    if (!a) { dot.className = 'statdot'; body.innerHTML = '<p class="checkhint">The accessibility report appears after a build.</p>'; return; }
    dot.className = 'statdot ' + (a.status === 'pass' ? 'pass' : a.status === 'fail' ? 'fail' : '');
    body.innerHTML = '';
    body.appendChild(el('p', 'checkhint', a.summary));
    (a.checks || []).forEach((c) => {
      let extra = null;
      if (c.id === 'contrast' && c.rows) {
        extra = '<div class="ck-rec">' + c.rows.map((r) => (r.ok ? '✓ ' : '✗ ') + escapeHtml(r.name) + ' — ' + r.ratio + ':1 (needs ' + r.min + ':1)').join('<br>') + '</div>';
      }
      body.appendChild(checkRow(c.status, c.label, c.detail, extra));
    });
  }

  // A generic check row: status pill + label + detail (+ optional html extra).
  function checkRow(status, label, detail, extraHtml) {
    const row = el('div', 'checkrow');
    row.appendChild(el('span', 'pill ' + status, status));
    const main = el('div', 'ck-main');
    main.appendChild(el('div', 'ck-label', label));
    if (detail) main.appendChild(el('div', 'ck-detail', detail));
    if (extraHtml) { const x = document.createElement('div'); x.innerHTML = extraHtml; main.appendChild(x); }
    row.appendChild(main);
    return row;
  }

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

  // ---------- code editing ----------
  function onEdit() { S.edited[S.active] = $('code').value; updateEditedIndicator(); updatePrecheck(); renderPreview(); }

  // Instant CLIENT-SIDE pre-check (labelled as such — NOT the real validator).
  // This is a fast heuristic so an edit gets immediate feedback; the authoritative
  // verdict still comes from the server's amphtml-validator via Re-validate.
  function quickLint(code) {
    if (!code || !code.trim()) return null;
    const issues = [];
    if (!/<html[^>]*\bamp4email\b/i.test(code) && !/&#x26A1;4email|⚡4email/i.test(code)) issues.push('no amp4email on <html>');
    if (!/cdn\.ampproject\.org\/v0\.js/i.test(code)) issues.push('missing AMP runtime script');
    if (/<img\b/i.test(code)) issues.push('raw <img> — use <amp-img>');
    if (/(?:src|href)="http:\/\//i.test(code)) issues.push('non-HTTPS URL');
    if (/style\s*=\s*"/i.test(code)) issues.push('inline style= (disallowed)');
    return issues;
  }
  function updatePrecheck() {
    const pc = $('preCheck'); if (!pc) return;
    const issues = quickLint($('code').value);
    if (issues === null) { pc.className = 'precheck'; pc.innerHTML = '<span class="pc-dot"></span>pre-check'; return; }
    if (issues.length === 0) { pc.className = 'precheck ok'; pc.innerHTML = '<span class="pc-dot"></span>pre-check: no obvious issues'; }
    else { pc.className = 'precheck bad'; pc.innerHTML = '<span class="pc-dot"></span>pre-check: ' + escapeHtml(issues[0]) + (issues.length > 1 ? ' (+' + (issues.length - 1) + ')' : ''); }
  }
  function updateEditedIndicator() {
    const edited = S.edited[S.active] != null && S.edited[S.active] !== active().ampHtml;
    $('editedDot').classList.toggle('hidden', !edited);
    $('editedLabel').classList.toggle('hidden', !edited);
  }
  async function revalidate() {
    setStatus('Validating edited code…');
    const v = await api('/validate', { ampHtml: $('code').value });
    renderValidation(v); switchTab('validation'); setStatus(v.pass ? 'Edited code is valid.' : 'Edited code FAILED validation.');
  }
  function resetCode() { delete S.edited[S.active]; $('code').value = active().ampHtml; updateEditedIndicator(); renderValidation(active().validation); renderPreview(); }

  function currentCode() { return S.edited[S.active] != null ? S.edited[S.active] : active().ampHtml; }

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
  function flash(btn, msg) { const o = btn.innerHTML; btn.innerHTML = '<svg class="ic"><use href="#i-check"/></svg> ' + msg; setTimeout(() => { btn.innerHTML = o; }, 1600); }
  function downloadCode() {
    const blob = new Blob([currentCode()], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = (active().module || 'amp') + '.html'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- visual layer (re-resolve real images into the current code) ----------
  async function renderVisuals() {
    const e = active();
    setStatus('Rendering visuals…');
    const prods = ($('assetProducts').value || '').split(/\n+/).map((s) => s.trim()).filter(Boolean).map((u) => ({ imageUrl: u }));
    const out = await api('/render-visuals', { ampHtml: currentCode(), products: prods, logo: $('assetLogo').value.trim() || null });
    if (out.error) { setStatus('Visual render error: ' + out.error); return; }
    e.ampHtml = out.ampHtml; e.validation = out.validation; e.visualStatus = out.visualStatus || 'rendered'; e.visual = out;
    delete S.edited[S.active];
    renderActive();
    setStatus('Visuals: ' + (out.rendered || 0) + '/' + (out.total || 0) + ' real assets rendered, ' + out.validation.status + '.');
  }

  // ====================================================================
  //  SEND-READINESS PANELS  (Phase 1.3/1.4/1.5)
  //  Every async action below has a loading, error and success state.
  // ====================================================================

  // Map a pass/warn/fail/unknown verdict to a status-dot class.
  function statClass(s) { return s === 'pass' ? 'pass' : s === 'fail' ? 'fail' : s === 'warn' ? 'warn' : ''; }

  // ---------- pre-send checks (spam · size · image weight · rights) ----------
  async function runPreflight() {
    if (!S.result) return;
    const e = active();
    setBtnLoading('runPreflight', true);
    $('preflightDot').className = 'statdot';
    $('preflightBody').innerHTML = skeletonRows(4);
    try {
      const assets = (S.lastContext && S.lastContext.assets) || S.lastProvenance || [];
      const out = await api('/preflight', {
        ampHtml: currentCode(),
        htmlFallback: e.htmlFallback || '',
        textFallback: e.textFallback || '',
        subject: e.subject || '',
        assets,
      });
      if (!out || out.ok === false || out.error) {
        $('preflightBody').innerHTML = errBox((out && out.error) || 'Pre-send check failed.');
        $('preflightDot').className = 'statdot fail';
        return;
      }
      renderPreflight(out);
    } catch (err) {
      $('preflightBody').innerHTML = errBox('Pre-send check failed: ' + err.message);
      $('preflightDot').className = 'statdot fail';
    } finally {
      setBtnLoading('runPreflight', false);
    }
  }

  function renderPreflight(out) {
    $('preflightDot').className = 'statdot ' + statClass(out.status);
    const body = $('preflightBody'); body.innerHTML = '';
    body.appendChild(el('p', 'checkhint', out.summary || ''));

    // spam — labelled estimate with a meter and the exact contributing factors
    const sp = out.spam || {};
    const lvlPill = sp.level === 'low' ? 'pass' : sp.level === 'moderate' ? 'warn' : 'fail';
    const row = el('div', 'checkrow');
    row.appendChild(el('span', 'pill ' + lvlPill, sp.level || '—'));
    const main = el('div', 'ck-main');
    main.appendChild(el('div', 'ck-label', 'Estimated spam score — ' + (sp.score != null ? sp.score : '?') + ' / ' + (sp.max || 10)));
    const meter = el('div', 'meter meter-' + (sp.level || 'low'));
    const fillBar = document.createElement('i');
    fillBar.style.width = Math.max(4, Math.min(100, ((sp.score || 0) / (sp.max || 10)) * 100)) + '%';
    meter.appendChild(fillBar); main.appendChild(meter);
    if (sp.detail) main.appendChild(el('div', 'ck-detail', sp.detail));
    if (sp.factors && sp.factors.length) {
      const rec = el('div', 'ck-rec');
      rec.innerHTML = sp.factors.map((f) => '+' + f.pts + ' ' + escapeHtml(f.text)).join('<br>');
      main.appendChild(rec);
    }
    row.appendChild(main); body.appendChild(row);

    // size
    const sz = out.size || {};
    body.appendChild(checkRow(sz.status, 'Message size', sz.detail));

    // images — HTTPS + weight (list any non-HTTPS offenders verbatim)
    const im = out.images || {};
    let imgExtra = null;
    if (im.nonHttps && im.nonHttps.length) imgExtra = '<div class="ck-rec">' + im.nonHttps.map((u) => '✗ ' + escapeHtml(u)).join('<br>') + '</div>';
    body.appendChild(checkRow(im.status, 'Images — HTTPS & weight', im.detail, imgExtra));

    // asset rights / licensing (Phase 1.4)
    const ri = out.rights || {};
    let riExtra = null;
    if (ri.review && ri.review.length) riExtra = '<div class="ck-rec">' + ri.review.map((a) => '⚠ ' + escapeHtml(a.slot + ' · ' + (a.license || 'open web') + (a.source ? ' · ' + a.source : ''))).join('<br>') + '</div>';
    body.appendChild(checkRow(ri.status, 'Asset rights & licensing', ri.detail, riExtra));
  }

  // ---------- deliverability: real SPF/DKIM/DMARC + Google registration ----------
  async function runDeliver() {
    const inp = $('deliverDomain');
    const domain = inp.value.trim();
    if (!domain) { $('deliverBody').innerHTML = errBox('Enter a sending domain (e.g. mail.yourbrand.com) to check authentication.'); inp.focus(); return; }
    setBtnLoading('runDeliver', true);
    $('deliverStatusDot').className = 'statdot';
    $('deliverBody').innerHTML = skeletonRows(3);
    try {
      const out = await api('/deliverability', { domain });
      if (!out || out.ok === false || out.error) {
        $('deliverBody').innerHTML = errBox((out && out.error) || 'Deliverability check failed.');
        $('deliverStatusDot').className = 'statdot fail';
        return;
      }
      renderDeliver(out);
    } catch (err) {
      $('deliverBody').innerHTML = errBox('Deliverability check failed: ' + err.message);
      $('deliverStatusDot').className = 'statdot fail';
    } finally {
      setBtnLoading('runDeliver', false);
    }
  }

  function renderDeliver(out) {
    const checks = out.checks || [];
    const worst = checks.some((c) => c.status === 'fail') ? 'fail'
      : checks.some((c) => c.status === 'unknown') ? 'unknown'
        : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
    $('deliverStatusDot').className = 'statdot ' + statClass(worst);

    const g = out.guidance || {};
    // the tab dot reflects overall AMP-send readiness, not just the worst record
    $('deliverDot').className = 'statdot ' + (g.readiness === 'ready' ? 'pass' : g.readiness === 'blocked' ? 'fail' : 'warn');

    const body = $('deliverBody'); body.innerHTML = '';
    body.appendChild(el('p', 'checkhint', 'Live DNS for ' + (out.domain || '—')));

    // the three authentication records, each with the real TXT shown verbatim
    checks.forEach((c) => {
      const extra = c.record ? '<div class="ck-rec">' + escapeHtml(c.record) + '</div>' : null;
      body.appendChild(checkRow(c.status, c.label, c.detail, extra));
    });

    // ---- registration guidance ----
    const guide = el('div', 'guide');
    const rb = el('span', 'readiness ' + (g.readiness || 'partial'));
    rb.appendChild(svg(g.readiness === 'ready' ? 'i-check' : g.readiness === 'blocked' ? 'i-cross' : 'i-warn'));
    rb.appendChild(document.createTextNode(g.readiness === 'ready' ? 'Auth ready' : g.readiness === 'blocked' ? 'Auth blocked' : 'Auth partial'));
    guide.appendChild(rb);
    if (g.readinessText) guide.appendChild(el('p', 'ck-detail', g.readinessText));

    if (g.gate) { guide.appendChild(el('h4', '', 'The registration gate')); guide.appendChild(el('div', 'gate', g.gate)); }
    if (g.selfSendTrick) { guide.appendChild(el('h4', '', 'Test without registration')); guide.appendChild(el('div', 'trick', g.selfSendTrick)); }

    if (g.prerequisites && g.prerequisites.length) {
      guide.appendChild(el('h4', '', 'Prerequisites'));
      const ul = el('ul', 'prereqs');
      g.prerequisites.forEach((p) => {
        const li = document.createElement('li');
        const icon = p.ok === true ? 'i-check' : p.ok === false ? 'i-cross' : 'i-info';
        const s = svg(icon);
        s.style.color = p.ok === true ? 'var(--ok)' : p.ok === false ? 'var(--bad)' : 'var(--muted)';
        li.appendChild(s); li.appendChild(document.createTextNode(p.text));
        ul.appendChild(li);
      });
      guide.appendChild(ul);
    }

    if (g.steps && g.steps.length) {
      guide.appendChild(el('h4', '', 'Register the sending domain with Google'));
      const ol = document.createElement('ol');
      g.steps.forEach((s) => { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); });
      guide.appendChild(ol);
    }

    const linkP = document.createElement('p');
    const a = document.createElement('a');
    a.href = g.registerUrl || 'https://developers.google.com/gmail/ampemail/register-for-amp';
    a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open Google AMP registration →';
    linkP.appendChild(a); guide.appendChild(linkP);
    if (g.whitelistingAddress) guide.appendChild(el('div', 'ck-detail', 'Whitelisting test address: ' + g.whitelistingAddress));

    body.appendChild(guide);
  }

  // ---------- dispatch: authenticated multipart self-send ----------
  async function doDispatch() {
    const to = $('dispatchTo').value.trim();
    const msg = $('dispatchMsg');
    if (!to) { msg.className = 'dispatch-msg err'; msg.textContent = 'Enter a recipient email.'; $('dispatchTo').focus(); return; }
    if (!S.result) { msg.className = 'dispatch-msg err'; msg.textContent = 'Build an email first.'; return; }
    const e = active();
    setBtnLoading('dispatch', true);
    msg.className = 'dispatch-msg'; msg.innerHTML = '<span class="spinner"></span> Sending a self-test…';
    try {
      const out = await api('/dispatch', {
        to, subject: e.subject, ampHtml: currentCode(),
        html: e.htmlFallback || '', text: e.textFallback || '', fromName: e.fromName || '',
      });
      if (out && out.ok) {
        msg.className = 'dispatch-msg ok';
        msg.textContent = 'Sent to ' + to + ' — open it in Gmail to see the interactive AMP part (id ' + (out.messageId || 'ok') + ').';
      } else {
        msg.className = 'dispatch-msg err';
        msg.textContent = (out && out.error) || 'Send failed.';
      }
    } catch (err) {
      msg.className = 'dispatch-msg err';
      msg.textContent = 'Send failed: ' + err.message;
    } finally {
      setBtnLoading('dispatch', false);
    }
  }

  // ---------- shared async-state helpers ----------
  // Spinner-in-button with a restore. Stores the original markup on the node so
  // any button (icon-only or labelled) returns to exactly what it was.
  function setBtnLoading(id, on) {
    const b = $(id); if (!b) return;
    if (on) {
      if (b.dataset.label == null) b.dataset.label = b.innerHTML;
      b.disabled = true; b.classList.add('loading');
      b.innerHTML = '<span class="spinner"></span>';
    } else {
      b.disabled = false; b.classList.remove('loading');
      if (b.dataset.label != null) { b.innerHTML = b.dataset.label; delete b.dataset.label; }
    }
  }
  // Shimmer placeholders for a panel that's loading rows.
  function skeletonRows(n) {
    let s = '';
    for (let i = 0; i < (n || 3); i++) {
      s += '<div class="checkrow">'
        + '<span class="skeleton" style="width:46px;height:20px;border-radius:20px;flex:0 0 auto"></span>'
        + '<div class="ck-main">'
        + '<div class="skeleton sk-line" style="width:' + (42 + (i * 13) % 38) + '%"></div>'
        + '<div class="skeleton sk-line" style="width:' + (70 + (i * 7) % 24) + '%;margin-top:7px"></div>'
        + '</div></div>';
    }
    return s;
  }
  // A consistent inline error block (never leave a panel dead-silent).
  function errBox(t) {
    return '<div class="notice warn"><svg class="ic"><use href="#i-warn"/></svg>'
      + '<span>' + escapeHtml(String(t || 'Something went wrong.')) + '</span></div>';
  }
  // Clear the send-readiness panels back to their resting hint on a fresh build.
  function resetSendPanels() {
    const pfDot = $('preflightDot'); if (pfDot) pfDot.className = 'statdot';
    const dDot = $('deliverStatusDot'); if (dDot) dDot.className = 'statdot';
    const tabDot = $('deliverDot'); if (tabDot) tabDot.className = 'statdot';
    const pfBody = $('preflightBody');
    if (pfBody) pfBody.innerHTML = '<p class="checkhint">Estimated spam score, total size, image weight, HTTPS and asset rights — run before you send.</p>';
    const dBody = $('deliverBody');
    if (dBody) dBody.innerHTML = '<p class="checkhint">Check live SPF, DKIM and DMARC for your sending domain, then see exactly what Google needs to enable interactive AMP in recipients’ inboxes.</p>';
    const dm = $('dispatchMsg'); if (dm) { dm.className = 'dispatch-msg'; dm.textContent = ''; }
  }
  // Convenience: seed the deliverability domain from the store URL (host only),
  // unless the user has already typed their own sending domain.
  function prefillDeliverDomain() {
    const inp = $('deliverDomain'); if (!inp || S.deliverTouched) return;
    const raw = ($('url').value || '').trim(); if (!raw) return;
    let host = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
      .split('/')[0].split('?')[0].split('#')[0].split(':')[0];
    if (host && host.includes('.')) inp.value = host.toLowerCase();
  }

  // ---------- tabs ----------
  function switchTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === name));
  }

  // ---------- history ----------
  async function saveHistory(spec, result) {
    const moduleName = (result.emails[0] && result.emails[0].moduleName) || 'AMP email';
    await api('/history', { title: (spec.brandName || spec.brandUrl || 'Acme') + ' · ' + moduleName, request: { spec }, allValid: result.allValid });
    loadHistory();
  }
  async function loadHistory() {
    const list = await (await fetch('/history')).json();
    const ul = $('historyList'); ul.innerHTML = '';
    if (!list.length) { $('historyPanel').classList.add('hidden'); return; }
    $('historyPanel').classList.remove('hidden');
    list.forEach((h) => {
      const li = el('li', 'h-item');
      const main = el('div', 'h-main');
      main.innerHTML = '<b>' + escapeHtml(h.title) + '</b><small>' + new Date(h.createdAt).toLocaleString() + (h.allValid ? ' · all valid' : ' · check validation') + '</small>';
      main.onclick = () => replayHistory(h);
      const star = document.createElement('button'); star.className = 'iconbtn star' + (h.starred ? ' on' : ''); star.appendChild(svg('i-star'));
      star.onclick = async (ev) => { ev.stopPropagation(); await api('/history/' + h.id, { starred: !h.starred }); loadHistory(); };
      const trash = document.createElement('button'); trash.className = 'iconbtn'; trash.appendChild(svg('i-trash'));
      trash.onclick = async (ev) => { ev.stopPropagation(); await api('/history/' + h.id, { trash: true }); loadHistory(); };
      li.appendChild(main); li.appendChild(star); li.appendChild(trash); ul.appendChild(li);
    });
  }
  function replayHistory(h) {
    const req = h.request || {}; const spec = req.spec || {};
    if (spec.brandUrl) $('url').value = spec.brandUrl;
    if (spec.brandName) $('brand').value = spec.brandName;
    if (spec.moduleId) $('moduleSel').value = spec.moduleId;
    if (spec.vertical) $('vertical').value = spec.vertical;
    if (spec.tone) $('tone').value = spec.tone;
    if (spec.currency) $('currency').value = spec.currency;
    if (spec.user && spec.user.colors && spec.user.colors.primary) { $('colorhex').value = spec.user.colors.primary; $('colorpick').value = spec.user.colors.primary; }
    if (spec.user && spec.user.logo) $('assetLogo').value = spec.user.logo;
    if (spec.user && Array.isArray(spec.user.products)) $('assetProducts').value = spec.user.products.map((p) => p.imageUrl).join('\n');
    if (spec.copy && spec.copy.headline) $('copyHead').value = spec.copy.headline;
    if (spec.copy && spec.copy.code) $('copyCode').value = spec.copy.code;
    build(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- tiny dom helpers ----------
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svg(id) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'ic'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#' + id); s.appendChild(u); return s; }
  function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  init();
})();
