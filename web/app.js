(function () {
  const $ = (id) => document.getElementById(id);
  const PLAYGROUND = 'https://amp.gmail.dev/playground/';

  const S = { meta: null, result: null, edited: null, counter: 0, colorTouched: false, active: 'preview', briefOverLimit: false, building: false };
  const BRIEF_MAX = 2000;
  // Lightweight identity for team attribution: a name kept in localStorage and
  // stamped onto every build/slate this browser creates. Not auth — access
  // control is Cloudflare Access's job (see SETUP-CLOUDFLARE.md).
  const AUTHOR_KEY = 'genieAuthor';
  function author() { try { return (localStorage.getItem(AUTHOR_KEY) || '').trim() || null; } catch (e) { return null; } }

  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  }

  function setStatus(t, loading) {
    const s = $('status'); s.innerHTML = '';
    if (loading) { const sp = document.createElement('span'); sp.className = 'spinner'; s.appendChild(sp); }
    if (t) s.appendChild(document.createTextNode(t));
  }

  // ---------- init ----------
  async function init() {
    const m = await (await fetch('/api/meta')).json();
    S.meta = m;
    bind();
    loadHistory();
  }
  function bind() {
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

  // ---------- campaign brief: soft character guidance, never a hard cutoff ----------
  // No maxlength on the textarea — typing is never silently truncated. Past
  // BRIEF_MAX we just warn and disable the submit button until it's trimmed.
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
  // Purely visual — the disable/prevent-double-submit contract (rub.disabled
  // toggling around the request) is unchanged from the plain-spinner version.
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
      // Let the smoke burst into a quick flash rather than just stopping
      // dead — but resolve well under ~400ms so it never blocks the reveal.
      const lamp = rub.querySelector('.lamp-anim');
      if (lamp) { lamp.classList.add('success'); setTimeout(finish, 300); }
      else finish();
    } else {
      finish();
    }
  }

  // ---------- the one click: generate -> validate ----------
  async function build() {
    if ($('campaignBrief').value.length > BRIEF_MAX) {
      setStatus('Trim the campaign brief below ' + BRIEF_MAX + ' characters to Rub the lAMP.');
      return;
    }
    setBuilding(true);
    const slateMode = $('slateToggle').checked;
    setStatus(slateMode ? 'Conjuring the full slate — six validated emails&hellip;' : 'Rubbing the lamp&hellip;', true);
    let ok = false;
    try {
      const body = {
        brand: $('brand').value.trim() || 'Acme',
        counter: S.counter,
        // Industry and tone are no longer asked for — the backend infers them
        // from the brand and brief. The brief itself now drives module, copy,
        // vertical, tone, and any stated offer number. "" / whitespace -> null.
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
        if (!S.colorTouched) { $('colorhex').value = out.palette.primary; $('colorpick').value = out.palette.primary; }
        $('slateResult').classList.add('hidden');
        $('result').classList.remove('hidden');
        renderResult();
        setStatus(out.validation.pass ? 'Done — valid AMP4EMAIL, zero errors.' : 'Done — see Validation tab for issues.');
      }
      ok = true;
      loadHistory();
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
    } else {
      // KV/storage write failed — builds still happened, they just have no
      // hosted pages. Say so instead of showing a dead link.
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
    // Copy provenance: whether an LLM wrote the copy or the template library
    // did. Without this a configured API key silently degrading to templates
    // is invisible — the one observability gap that costs real money.
    if (r.copySource) chip(chips, 'copy', r.copySource);
    $('share').classList.toggle('hidden', !r.sharePath);

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

  function renderPreview() {
    const area = $('previewArea');
    window.AmpGeniePreview.render(area, { moduleId: S.result.moduleId, previewModel: S.result.previewModel, palette: S.result.palette });
  }

  function chip(box, k, v) { const c = el('span', 'chip'); c.innerHTML = '<b>' + k + '</b> ' + escapeHtml(String(v)); box.appendChild(c); }

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
    } catch (e) {
      // best-effort review aid — a fetch failure here must never surface as
      // an app error or block anything else.
    }
  }

  function renderHistory(items) {
    const section = $('historySection');
    const list = $('historyList');
    list.innerHTML = '';
    if (!items.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    items.forEach((it) => list.appendChild(historyItem(it)));
  }

  // Collapsed-by-default accordion (Phase 7): a real button toggling both the
  // visual hidden state and aria-expanded, so keyboard/AT users and the CSS
  // chevron-rotation rule (`.history-hdr[aria-expanded="true"] .history-chevron`)
  // stay in sync with each other.
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
      '<span class="chip ' + (it.validationPass ? 'pass' : 'fail') + '"><b>validation</b> ' + (it.validationPass ? 'pass' : 'fail') + '</span>';
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
  function onEdit() { S.edited = $('code').value; updateEditedIndicator(); renderPreview(); }
  function updateEditedIndicator() {
    const edited = S.edited != null && S.edited !== S.result.ampHtml;
    $('editedDot').classList.toggle('hidden', !edited);
    $('editedLabel').classList.toggle('hidden', !edited);
    // The live preview renders previewModel from the last generation — it does
    // NOT re-parse edited AMP. Say so right on the preview instead of letting
    // an edited build silently show stale content (the old honesty gap).
    $('previewStale').classList.toggle('hidden', !edited);
  }
  async function revalidate() {
    setStatus('Validating edited code&hellip;');
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
        // fallback.js) — what non-AMP clients (Outlook) render instead of the
        // generic stub. They match the last generation, not manual code edits.
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
