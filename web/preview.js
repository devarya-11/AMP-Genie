/* Generic AMP4EMAIL preview interpreter.
   Renders the *actual generated AMP* by interpreting a practical subset of
   amp-bind in plain JS — so every module (present and future) previews with no
   per-module mirror. Supported: <amp-state> init, [class]/[text]/[value]
   bindings, on="tap:AMP.setState(...)", on="input(-throttle):AMP.setState(...)",
   amp-img, amp-carousel (scroll strip), amp-accordion, amp-form (submit-success). */
(function () {
  function evalExpr(expr, scope) {
    try { return new Function('g', 'event', 'return (' + expr + ');')(scope.g || {}, scope.event || {}); }
    catch (e) { return undefined; }
  }
  function deepMerge(state, patch) {
    for (const id in patch) {
      if (patch[id] && typeof patch[id] === 'object') state[id] = Object.assign({}, state[id], patch[id]);
      else state[id] = patch[id];
    }
  }

  function copyDyn(from, to) {
    from.getAttributeNames().forEach((n) => {
      if (n[0] === '[' || n === 'on') to.setAttribute(n, from.getAttribute(n));
    });
  }

  function transform(container) {
    container.querySelectorAll('amp-img').forEach((a) => {
      const img = document.createElement('img');
      img.src = a.getAttribute('src') || '';
      img.alt = a.getAttribute('alt') || '';
      const layout = a.getAttribute('layout');
      img.style.display = 'block';
      if (layout === 'fixed') { img.width = +a.getAttribute('width') || 64; img.height = +a.getAttribute('height') || 64; }
      else { img.style.width = '100%'; img.style.height = 'auto'; }
      copyDyn(a, img);
      a.replaceWith(img);
    });
    container.querySelectorAll('amp-carousel').forEach((c) => {
      const strip = document.createElement('div');
      strip.style.cssText = 'display:flex;overflow-x:auto;gap:8px;scroll-snap-type:x mandatory';
      Array.from(c.children).forEach((ch) => { ch.style.cssText = (ch.style.cssText || '') + ';flex:0 0 80%;scroll-snap-align:center'; strip.appendChild(ch); });
      c.replaceWith(strip);
    });
    container.querySelectorAll('amp-accordion').forEach((ac) => {
      ac.querySelectorAll('section').forEach((sec) => {
        const kids = sec.children;
        if (kids.length >= 2) {
          const head = kids[0], body = kids[1];
          body.style.display = 'none';
          head.style.cursor = 'pointer';
          head.addEventListener('click', () => { body.style.display = body.style.display === 'none' ? 'block' : 'none'; });
        }
      });
    });
    container.querySelectorAll('amp-state').forEach((s) => s.remove());
  }

  function harvestState(scope) {
    const state = {};
    scope.querySelectorAll('amp-state').forEach((s) => {
      const id = s.getAttribute('id');
      const sc = s.querySelector('script');
      try { state[id] = JSON.parse(sc.textContent); } catch (e) { state[id] = {}; }
    });
    if (!state.g) state.g = {};
    return state;
  }

  function wire(container, state) {
    const binds = [];
    function apply(objExpr, event) {
      const patch = evalExpr(objExpr, { g: state.g, event });
      if (patch && typeof patch === 'object') deepMerge(state, patch);
      refresh();
    }
    function refresh() {
      binds.forEach((b) => {
        const v = evalExpr(b.expr, { g: state.g, event: {} });
        if (v === undefined) return;
        if (b.kind === 'class') b.el.className = String(v);
        else if (b.kind === 'text') b.el.textContent = String(v);
        else if (b.kind === 'value') b.el.value = String(v);
      });
    }

    container.querySelectorAll('*').forEach((el) => {
      el.getAttributeNames().forEach((n) => {
        if (n === '[class]') binds.push({ el, kind: 'class', expr: el.getAttribute(n) });
        else if (n === '[text]') binds.push({ el, kind: 'text', expr: el.getAttribute(n) });
        else if (n === '[value]') binds.push({ el, kind: 'value', expr: el.getAttribute(n) });
      });
      const on = el.getAttribute('on');
      if (on) {
        const tap = on.match(/tap:AMP\.setState\((\{[\s\S]*?\})\)/);
        if (tap) el.addEventListener('click', () => apply(tap[1], {}));
        const inp = on.match(/input(?:-throttle)?:AMP\.setState\((\{[\s\S]*?\})\)/);
        if (inp) el.addEventListener('input', () => apply(inp[1], { value: el.value }));
      }
    });
    container.querySelectorAll('form').forEach((f) => {
      const on = f.getAttribute('on') || '';
      const ss = on.match(/submit-success:AMP\.setState\((\{[\s\S]*?\})\)/);
      f.addEventListener('submit', (e) => { e.preventDefault(); if (ss) apply(ss[1], {}); });
    });
    refresh();
  }

  function renderAmp(ampHtml, container) {
    container.innerHTML = '';
    const doc = new DOMParser().parseFromString(ampHtml, 'text/html');
    const style = doc.querySelector('style[amp-custom]');
    const wrap = document.createElement('div');
    wrap.className = 'amp-preview-root';
    if (style) { const st = document.createElement('style'); st.textContent = style.textContent; wrap.appendChild(st); }
    const body = document.createElement('div');
    body.innerHTML = doc.body ? doc.body.innerHTML : '';
    const state = harvestState(body);
    transform(body);
    wrap.appendChild(body);
    container.appendChild(wrap);
    wire(body, state);
  }

  window.GeniePreview = {
    renderAmp,
    render(model, palette, container) {
      if (typeof model === 'string') return renderAmp(model, container);
      container.textContent = 'Preview unavailable for this item.';
    },
  };
})();
