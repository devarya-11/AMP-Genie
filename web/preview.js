'use strict';

// Plain-JS mirror of the AMP module logic, for the phone-framed Live Preview
// tab. This never touches the AMP runtime — it re-implements each module's
// tap/input state machine directly against the DOM so it works everywhere,
// while staying visually and behaviourally faithful to the amp-bind logic in
// server/generate.js. The `data-testid` hooks below are used by the e2e tests.

(function (global) {
  function el(tag, attrs, children) {
    const node = tag === 'svg'
      ? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    (children || []).forEach((c) => c && node.appendChild(c));
    return node;
  }

  function renderReveal(root, m, p) {
    let revealed = false;
    const teaser = el('div', { class: 'pv-teaser', style: 'text-align:center;padding:20px' }, [
      el('p', { style: `font-size:30px;font-weight:bold;color:${p.primary};margin:0 0 6px`, text: `${m.discount}% OFF` }),
      el('p', { class: 'pv-muted', text: 'A hand-picked reward is waiting behind the curtain.' }),
      el('button', {
        class: 'pv-btn', style: `background:${p.primary}`, text: 'Reveal my offer', 'data-testid': 'reveal-btn',
        onclick: () => { revealed = true; renderInner(); },
      }),
    ]);
    const offerWrap = el('div', { class: 'pv-offer hidden', 'data-testid': 'reveal-offer' }, []);
    root.appendChild(teaser);
    root.appendChild(offerWrap);

    function renderInner() {
      teaser.classList.toggle('hidden', revealed);
      offerWrap.classList.toggle('hidden', !revealed);
      if (!revealed) return;
      offerWrap.innerHTML = '';
      offerWrap.appendChild(el('img', { src: m.image, style: 'width:100%;display:block' }));
      const body = el('div', { style: 'padding:16px;text-align:center' }, [
        el('p', { class: 'pv-muted', text: 'Use this code at checkout' }),
        el('span', { class: 'pv-code', style: `border-color:${p.accent};color:${p.primaryDark}`, text: m.code }),
        el('div', { class: 'pv-row' }, m.items.map((it) => el('div', { class: 'pv-card' }, [
          el('div', { class: 'pv-card-name', text: it.name }),
          el('div', { class: 'pv-card-price', style: `color:${p.primary}`, text: it.price }),
        ]))),
      ]);
      offerWrap.appendChild(body);
    }
    renderInner();
  }

  function renderSearch(root, m, p) {
    let q = '';
    let cat = 'all';
    const input = el('input', {
      type: 'text', placeholder: 'Search products', class: 'pv-search', 'data-testid': 'search-input',
      oninput: (e) => { q = e.target.value.toLowerCase(); renderGrid(); },
    });
    const pills = el('div', { class: 'pv-pills' }, m.cats.map((k, i) =>
      el('span', { class: 'pv-pill', text: m.catLabels[i], 'data-testid': 'pill-' + k, onclick: () => { cat = k; renderGrid(); } })
    ));
    const grid = el('div', { class: 'pv-grid', 'data-testid': 'search-grid' });
    root.appendChild(input);
    root.appendChild(pills);
    root.appendChild(grid);

    function renderGrid() {
      Array.from(pills.children).forEach((btn, i) => {
        const on = m.cats[i] === cat;
        btn.classList.toggle('on', on);
        btn.style.background = on ? p.primary : '';
      });
      grid.innerHTML = '';
      const visible = m.items.filter((it) => (cat === 'all' || it.cat === cat) && (q === '' || it.key.indexOf(q) !== -1));
      if (!visible.length) { grid.appendChild(el('div', { class: 'pv-empty', text: 'No products match.' })); return; }
      visible.forEach((it) => {
        grid.appendChild(el('div', { class: 'pv-card' }, [
          el('img', { src: it.image, style: 'width:100%;display:block' }),
          el('div', { class: 'pv-card-name', text: it.name }),
          el('div', { class: 'pv-card-price', style: `color:${p.primary}`, text: it.price }),
        ]));
      });
    }
    renderGrid();
  }

  function renderQuiz(root, m, p) {
    let sel = '';
    const q = el('p', { class: 'pv-qtitle', text: m.q });
    const opts = el('div', {}, m.options.map((o) => el('span', {
      class: 'pv-opt', 'data-testid': 'quiz-opt-' + o.key,
      onclick: () => { sel = o.key; renderResult(); },
      text: o.label,
    })));
    const resultBox = el('div', { class: 'pv-result hidden', 'data-testid': 'quiz-result' });
    root.appendChild(q); root.appendChild(opts); root.appendChild(resultBox);

    function renderResult() {
      Array.from(opts.children).forEach((btn, i) => btn.classList.toggle('on', m.options[i].key === sel));
      const picked = m.options.find((o) => o.key === sel);
      resultBox.classList.toggle('hidden', !picked);
      if (picked) { resultBox.style.background = p.tint; resultBox.textContent = picked.result; }
    }
    renderResult();
  }

  function renderRating(root, m, p) {
    let score = 0;
    const prompt = el('p', { class: 'pv-qtitle', text: m.prompt });
    const stars = el('div', { class: 'pv-stars' }, [1, 2, 3, 4, 5].map((i) => el('svg', {
      class: 'pv-star', viewBox: '0 0 24 24', 'data-testid': 'star-' + i,
      onclick: () => { score = i; renderStars(); },
      html: '<path fill="currentColor" d="M12 2l3 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.9 21l1.2-6.8-5-4.9 6.9-1z"/>',
    })));
    const conf = el('p', { class: 'pv-conf', style: `color:${p.primaryDark}`, 'data-testid': 'rating-confirm' });
    root.appendChild(prompt); root.appendChild(stars); root.appendChild(conf);

    function renderStars() {
      Array.from(stars.children).forEach((s, i) => { s.style.color = (i + 1) <= score ? p.accent : '#d8d8e2'; });
      conf.textContent = score === 0 ? '' : `You rated ${score} out of 5 — thank you!`;
    }
    renderStars();
  }

  function renderSpin(root, m, p) {
    let spun = false;
    const img = el('img', { src: m.image, style: 'width:200px;display:block;margin:0 auto 16px' });
    const spinWrap = el('div', {}, [
      el('p', { class: 'pv-muted', text: 'One spin, one reward. Ready?' }),
      el('button', { class: 'pv-btn', style: `background:${p.accent};color:#1c1c1c`, text: 'Spin to win', 'data-testid': 'spin-btn', onclick: () => { spun = true; renderInner(); } }),
    ]);
    const rewardWrap = el('div', { class: 'pv-reward hidden', 'data-testid': 'spin-reward' });
    root.appendChild(el('div', { style: 'text-align:center' }, [img, spinWrap, rewardWrap]));

    function renderInner() {
      spinWrap.classList.toggle('hidden', spun);
      rewardWrap.classList.toggle('hidden', !spun);
      if (!spun) return;
      rewardWrap.style.background = p.tint;
      rewardWrap.innerHTML = '';
      rewardWrap.appendChild(el('p', { style: `font-size:22px;font-weight:bold;color:${p.primaryDark}`, text: `You won ${m.pct}% off!` }));
      rewardWrap.appendChild(el('span', { class: 'pv-code', style: `border-color:${p.accent};color:${p.primaryDark}`, text: m.reward }));
    }
    renderInner();
  }

  function renderPoll(root, m, p) {
    let vote = '';
    const q = el('p', { class: 'pv-qtitle', text: m.q });
    const row = el('div', { class: 'pv-row', style: 'text-align:center' }, [
      el('span', { class: 'pv-vote', 'data-testid': 'poll-a', onclick: () => { vote = 'a'; renderResult(); }, text: m.a }),
      el('span', { class: 'pv-vote', 'data-testid': 'poll-b', onclick: () => { vote = 'b'; renderResult(); }, text: m.b }),
    ]);
    const resultBox = el('div', { class: 'pv-result hidden', 'data-testid': 'poll-result' });
    root.appendChild(q); root.appendChild(row); root.appendChild(resultBox);

    function renderResult() {
      row.children[0].classList.toggle('on', vote === 'a');
      row.children[1].classList.toggle('on', vote === 'b');
      row.children[0].style.background = vote === 'a' ? p.tint : '';
      row.children[1].style.background = vote === 'b' ? p.tint : '';
      resultBox.classList.toggle('hidden', !vote);
      if (vote) {
        resultBox.style.background = p.tint;
        resultBox.textContent = vote === 'a' ? `You are with the 64% who chose ${m.a}. Great pick!` : `You joined the 36% backing ${m.b}. Bold!`;
      }
    }
    renderResult();
  }

  const RENDERERS = {
    reveal: renderReveal, search: renderSearch, quiz: renderQuiz,
    rating: renderRating, spin: renderSpin, poll: renderPoll,
  };

  function render(container, { moduleId, previewModel, palette }) {
    container.innerHTML = '';
    const header = el('div', { class: 'pv-hdr', style: `background:${palette.primary}` }, [
      el('h1', { text: previewModel.head }),
    ]);
    container.appendChild(header);
    const body = el('div', { class: 'pv-body', 'data-testid': 'preview-body' });
    container.appendChild(body);
    const fn = RENDERERS[moduleId];
    if (fn) fn(body, previewModel, palette);
  }

  global.AmpGeniePreview = { render };
})(window);
