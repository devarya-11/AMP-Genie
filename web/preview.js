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
          // A real product image exists only when the brand kit / pasted
          // brief supplied one — mirrors the AMP part exactly.
          it.image ? el('img', { src: it.image, style: 'width:100%;display:block' }) : null,
          el('div', { class: 'pv-card-name', text: it.name }),
          it.price ? el('div', { class: 'pv-card-price', style: `color:${p.primary}`, text: it.price }) : null,
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
          // it.image is now the REAL product image, present only when one was
          // supplied — synthesize the same neutral placeholder the AMP part
          // falls back to when it is absent.
          el('img', {
            src: it.image || ('https://placehold.co/300x200/EDEDF2/1d1d2b?text=' + encodeURIComponent(it.name)),
            style: 'width:100%;display:block',
          }),
          el('div', { class: 'pv-card-name', text: it.name }),
          it.price ? el('div', { class: 'pv-card-price', style: `color:${p.primary}`, text: it.price }) : null,
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


  function renderCalc(root, m, p) {
    let a = (m.defaults && Number.isInteger(m.defaults.a)) ? m.defaults.a : 0;
    let b = (m.defaults && Number.isInteger(m.defaults.b)) ? m.defaults.b : 0;
    let done = false;
    const B = m.bVals.length;
    const tagStyle = `position:absolute;top:-9px;right:10px;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;background:${p.tint};border:1px solid #e6e6ec;color:${p.primaryDark};padding:2px 8px;border-radius:9px`;
    const ctl = (t) => el('p', { style: 'font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b6b7b;margin:14px 0 8px', text: t });

    if (m.receiptRows && m.receiptRows.length) {
      root.appendChild(el('div', { style: 'margin:16px 16px 0;border:1px solid #e6e6ec;border-radius:12px;padding:14px 14px 8px;position:relative', 'data-testid': 'calc-receipt' },
        [el('span', { style: tagStyle, text: m.receiptTag })].concat(m.receiptRows.map((r) => el('p', { style: 'margin:0 0 6px;font-size:12px;color:#6b6b7b;overflow:hidden' }, [
          el('span', { style: 'float:right;font-weight:700;color:#1d1d2b;margin-left:10px', text: r.v }),
          el('span', { text: r.k }),
        ])))));
      root.appendChild(el('div', { style: 'border-top:1.5px dashed #e6e6ec;margin:22px 16px 0;text-align:center;height:0' }, [
        el('span', { style: `display:inline-block;position:relative;top:-9px;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;background:${p.tint};border:1px solid #e6e6ec;color:${p.primaryDark};padding:2px 10px;border-radius:9px`, text: m.dividerLabel }),
      ]));
    }

    const wrap = el('div', { style: 'padding:16px 16px 20px' });
    wrap.appendChild(el('p', { class: 'pv-muted', text: m.promptText }));
    wrap.appendChild(ctl(m.aLabel));
    const pills = el('div', { class: 'pv-pills', style: 'padding:0' }, m.aVals.map((label, i) =>
      el('span', { class: 'pv-pill', 'data-testid': 'calc-a-' + i, onclick: () => { a = i; update(); }, text: label })));
    wrap.appendChild(pills);
    wrap.appendChild(ctl(m.bLabel));
    const stpStyle = `width:32px;height:32px;background:${p.tint};color:${p.primaryDark};font-size:16px;font-weight:700;cursor:pointer;text-align:center;line-height:32px;display:inline-block`;
    const minus = el('span', { 'data-testid': 'calc-minus', style: stpStyle, text: '−', onclick: () => { b = b - 1 < 0 ? 0 : b - 1; update(); } });
    const readout = el('span', { 'data-testid': 'calc-bval', style: 'min-width:72px;text-align:center;font-weight:700;font-size:14px;line-height:32px;padding:0 8px;display:inline-block' });
    const plus = el('span', { 'data-testid': 'calc-plus', style: stpStyle, text: '+', onclick: () => { b = b + 1 > B - 1 ? B - 1 : b + 1; update(); } });
    wrap.appendChild(el('div', { style: 'display:inline-flex;border:1.5px solid #e6e6ec;border-radius:9px;overflow:hidden' }, [minus, readout, plus]));

    const big = el('p', { 'data-testid': 'calc-big', style: `font-family:'Courier New',Courier,monospace;font-size:26px;font-weight:700;color:${p.primaryDark};margin:0` });
    const sub = el('p', { 'data-testid': 'calc-sub', style: 'font-size:12px;color:#6b6b7b;margin:6px 0 0;line-height:1.5' });
    wrap.appendChild(el('div', { style: `background:${p.tint};border:1px solid #e6e6ec;border-radius:12px;padding:16px;text-align:center;margin-top:18px` }, [
      el('p', { style: `font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${p.primaryDark};margin:0 0 6px`, text: m.resultLabel }),
      big, sub,
    ]));
    wrap.appendChild(el('p', { class: 'pv-muted', style: 'margin:10px 0 0;font-size:11px', text: m.assumptionText }));
    const cta = m.ctaHref
      ? el('a', { class: 'pv-btn', href: m.ctaHref, target: '_blank', rel: 'noopener noreferrer', style: `background:${p.primary};text-decoration:none`, 'data-testid': 'calc-cta', text: m.ctaLabel })
      : el('button', { class: 'pv-btn', style: `background:${p.primary}`, 'data-testid': 'calc-cta', text: m.ctaLabel, onclick: () => { done = true; update(); } });
    wrap.appendChild(el('div', { style: 'text-align:center' }, [cta]));
    root.appendChild(wrap);

    function update() {
      Array.from(pills.children).forEach((btn, i) => {
        const on = i === a;
        btn.classList.toggle('on', on);
        btn.style.background = on ? p.primary : '';
      });
      readout.textContent = m.bVals[b];
      minus.style.opacity = b === 0 ? '.35' : '';
      plus.style.opacity = b === B - 1 ? '.35' : '';
      big.textContent = m.big[a * B + b];
      sub.textContent = m.sub[a * B + b];
      if (!m.ctaHref) {
        cta.textContent = done ? m.doneLabel : m.ctaLabel;
        cta.style.opacity = done ? '.55' : '';
        cta.disabled = done;
      }
    }
    update();
  }

  function renderReport(root, m, p) {
    let open = -1;
    let revealed = false;
    let sel = -1;
    let done = false;
    // Semantic status colours are fixed constants, mirroring generate.js.
    const OK = { fg: '#0a6b51', bg: '#e4f0ea' };
    const ATTN = { fg: '#b45309', bg: '#fff3dc' };
    const tagStyle = `position:absolute;top:-9px;right:10px;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;background:${p.tint};border:1px solid #e6e6ec;color:${p.primaryDark};padding:2px 8px;border-radius:9px`;

    if ((m.metaRows && m.metaRows.length) || m.attachmentName) {
      const kids = [el('span', { style: tagStyle, text: m.receiptTag })]
        .concat((m.metaRows || []).map((r) => el('p', { style: 'margin:0 0 6px;font-size:12px;color:#6b6b7b;overflow:hidden' }, [
          el('span', { style: 'float:right;font-weight:700;color:#1d1d2b;margin-left:10px', text: r.v }),
          el('span', { text: r.k }),
        ])));
      if (m.attachmentName) {
        kids.push(el('div', { style: 'border-top:1px solid #e6e6ec;margin-top:8px;padding:10px 0 4px;overflow:hidden' }, [
          el('span', { style: 'float:left;width:36px;height:36px;border-radius:9px;background:#fde8e8;color:#b42318;font-size:10px;font-weight:700;text-align:center;line-height:36px', text: 'PDF' }),
          el('span', { style: 'display:block;margin-left:46px;font-size:12px;font-weight:700;color:#1d1d2b;padding-top:3px', text: m.attachmentName }),
          el('span', { style: 'display:block;margin-left:46px;font-size:11px;color:#9a9aa8;margin-top:2px', text: m.attachmentMeta }),
        ]));
      }
      root.appendChild(el('div', { style: 'margin:16px 16px 0;border:1px solid #e6e6ec;border-radius:12px;padding:14px 14px 8px;position:relative', 'data-testid': 'report-receipt' }, kids));
    }
    root.appendChild(el('div', { style: 'border-top:1.5px dashed #e6e6ec;margin:22px 16px 0;text-align:center;height:0' }, [
      el('span', { style: `display:inline-block;position:relative;top:-9px;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;background:${p.tint};border:1px solid #e6e6ec;color:${p.primaryDark};padding:2px 10px;border-radius:9px`, text: m.dividerLabel }),
    ]));

    const wrap = el('div', { style: 'padding:16px 16px 20px' });
    const rowEls = [];
    const detailEls = [];
    const carEls = [];
    m.rows.forEach((r, i) => {
      const c = r.status === 'attention' ? ATTN : OK;
      const car = el('span', { style: 'float:right;color:#9a9aa8;font-size:12px;margin-left:8px', text: '▾' });
      const detail = el('div', { class: 'hidden', 'data-testid': 'report-detail-' + i }, [
        el('p', { style: 'font-size:12px;color:#6b6b7b;line-height:1.5;margin:8px 0 0', text: r.detail }),
        r.range ? el('p', { style: 'font-size:11px;color:#9a9aa8;margin:4px 0 0', text: 'Typical: ' + r.range }) : null,
      ]);
      const row = el('div', {
        'data-testid': 'report-row-' + i,
        style: 'border:1px solid #e6e6ec;border-radius:10px;padding:12px;margin:0 0 8px;cursor:pointer;overflow:hidden',
        onclick: () => { open = open === i ? -1 : i; update(); },
      }, [
        car,
        el('span', { style: 'float:right;text-align:right;margin-left:8px' }, [
          el('span', { style: `font-weight:700;font-size:13px;color:${c.fg}`, text: r.value + (r.unit ? ' ' + r.unit : '') }),
          el('span', { style: `display:inline-block;font-size:10px;font-weight:700;border-radius:8px;padding:2px 8px;margin-left:6px;background:${c.bg};color:${c.fg}`, text: r.statusLabel || (m.statusLabels ? m.statusLabels[r.status] : '') }),
        ]),
        el('p', { style: 'font-size:14px;font-weight:700;margin:0;color:#1d1d2b', text: r.name }),
        r.sub ? el('p', { style: 'font-size:11px;color:#9a9aa8;margin:2px 0 0', text: r.sub }) : null,
        detail,
      ]);
      rowEls.push(row); detailEls.push(detail); carEls.push(car);
      wrap.appendChild(row);
    });

    const vc = m.attnCount > 0 ? ATTN : OK;
    const verdictBtnWrap = el('div', { style: 'text-align:center;margin:14px 0 0' }, [
      el('button', { class: 'pv-btn', style: `background:${p.primary};margin-top:0`, 'data-testid': 'report-verdict-btn', text: m.verdictCta, onclick: () => { revealed = true; update(); } }),
    ]);
    const verdict = el('div', { class: 'hidden', 'data-testid': 'report-verdict', style: `border-radius:10px;padding:14px 16px;margin:14px 0 0;background:${vc.bg}` }, [
      el('p', { style: `margin:0;font-size:13px;line-height:1.5;font-weight:700;color:${vc.fg}`, text: m.verdictText }),
    ]);
    wrap.appendChild(verdictBtnWrap);
    wrap.appendChild(verdict);

    wrap.appendChild(el('p', { style: 'font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b6b7b;margin:20px 0 8px', text: m.nextPrompt }));
    const slots = el('div', {}, m.slotLabels.map((label, i) =>
      el('span', { 'data-testid': 'report-slot-' + i, style: 'display:inline-block;font-size:13px;font-weight:700;text-align:center;border:1.5px solid #e6e6ec;border-radius:9px;padding:10px 14px;margin:0 8px 8px 0;cursor:pointer;color:#1d1d2b', text: label, onclick: () => { sel = i; update(); } })));
    wrap.appendChild(slots);
    const cta = el('button', { class: 'pv-btn', style: `background:${p.primary};margin-top:6px`, 'data-testid': 'report-cta', text: m.pickPrompt, onclick: () => { if (sel >= 0) { done = true; update(); } } });
    wrap.appendChild(el('div', {}, [cta]));
    root.appendChild(wrap);

    function update() {
      rowEls.forEach((row, i) => {
        const isOpen = open === i;
        detailEls[i].classList.toggle('hidden', !isOpen);
        carEls[i].textContent = isOpen ? '▴' : '▾';
        row.style.borderColor = isOpen ? p.primary : '#e6e6ec';
        row.style.background = isOpen ? p.tint : '';
      });
      verdictBtnWrap.classList.toggle('hidden', revealed);
      verdict.classList.toggle('hidden', !revealed);
      Array.from(slots.children).forEach((s, i) => {
        const on = sel === i;
        s.style.background = on ? p.primary : '';
        s.style.color = on ? '#fff' : '#1d1d2b';
        s.style.borderColor = on ? p.primary : '#e6e6ec';
      });
      if (done) {
        cta.textContent = m.doneLabel;
        cta.style.background = '#0a6b51';
        cta.style.opacity = '';
        cta.disabled = true;
      } else {
        cta.textContent = sel >= 0 ? m.ctaLabel + ' · ' + m.slotLabels[sel] : m.pickPrompt;
        cta.style.opacity = sel >= 0 ? '' : '.5';
      }
    }
    update();
  }

  const RENDERERS = {
    reveal: renderReveal, search: renderSearch, quiz: renderQuiz,
    rating: renderRating, spin: renderSpin, poll: renderPoll,
    calc: renderCalc, report: renderReport,
  };

  function render(container, { moduleId, previewModel, palette }) {
    container.innerHTML = '';
    const header = el('div', { class: 'pv-hdr', style: `background:${palette.primary}` }, [
      el('h1', { text: previewModel.head }),
    ]);
    container.appendChild(header);
    // Hero band — mirrors the AMP part's full-width hero between header and
    // body, present on every module when a hero image was resolved/saved.
    if (previewModel.heroUrl) {
      container.appendChild(el('img', {
        src: previewModel.heroUrl,
        style: 'width:100%;display:block',
        'data-testid': 'preview-hero',
      }));
    }
    const body = el('div', { class: 'pv-body', 'data-testid': 'preview-body' });
    container.appendChild(body);
    const fn = RENDERERS[moduleId];
    if (fn) fn(body, previewModel, palette);
  }

  global.AmpGeniePreview = { render };
})(window);
