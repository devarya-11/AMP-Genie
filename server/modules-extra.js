'use strict';

// Stage 2 · Step 3 — the broad module library.
// Each module is a production AMP4EMAIL generator returning
// { rows, css, components, state }. Helpers are injected by build.js so this
// file stays free of circular dependencies. Every module validates zero-errors.

module.exports = function makeModules(h) {
  const { ampImg, headRow, footRow, productGrid, enc, formatPrice, pick, generatedUrl } = h;

  // symbol-only currency prefix (entity), e.g. "&#8377;"
  const sym = (code) => formatPrice(0, code).replace(/[\d.,\s]/g, '');
  const opt = (label, on, cls) => `<div class="opt ${cls || ''}" role="button" tabindex="0" on="${on}">${enc(label)}</div>`;

  const M = {};

  // ===== GAMIFICATION & REVEAL =============================================
  M.slot = {
    name: 'Slot Machine', kind: 'slot-machine', group: 'Gamification',
    build(ctx) {
      const { p, copy, rng } = ctx;
      const pct = copy.pct || pick(rng, [15, 20, 25]);
      const code = copy.code || 'SLOT' + pct;
      const css =
        '.reels{margin:14px 0;}' +
        `.reel{display:inline-block;width:58px;height:78px;line-height:78px;font-size:38px;font-weight:bold;border:2px solid ${p.line};border-radius:10px;margin:0 5px;color:${p.primary};vertical-align:middle;}` +
        `.reward{background:${p.tint};border-radius:12px;padding:18px;margin-top:12px;}`;
      const reel = () => `<span class="reel" [text]="g.pulled ? '7' : '?'">?</span>`;
      const rows = headRow(copy.head || 'Pull the lever — line up the sevens') +
        `<tr><td class="pad center">` +
        `<div class="reels">${reel()}${reel()}${reel()}</div>` +
        `<div [class]="g.pulled ? 'dn' : 'db'"><div class="btn btnA" role="button" tabindex="0" on="tap:AMP.setState({g:{pulled:true}})">Pull the lever</div></div>` +
        `<div class="reward dn" [class]="g.pulled ? 'reward db' : 'reward dn'"><p class="lead" style="font-size:22px">Jackpot — ${pct}% off!</p><div class="code">${enc(code)}</div></div>` +
        `</td></tr>`;
      return { rows: rows + footRow('One pull per customer. Terms apply.'), css, components: [], state: { pulled: false } };
    },
  };

  M.flip = {
    name: 'Flip the Card', kind: 'flip-card', group: 'Gamification',
    build(ctx) {
      const { p, copy, rng } = ctx;
      const pct = copy.pct || pick(rng, [10, 15, 20, 25]);
      const code = copy.code || 'FLIP' + pct;
      const css =
        '.flipwrap{max-width:300px;margin:0 auto;height:180px;position:relative;}' +
        '.face{position:absolute;top:0;left:0;right:0;bottom:0;border-radius:14px;transition:opacity .5s;padding-top:60px;box-sizing:border-box;text-align:center;}' +
        `.front{background:${p.primary};color:#ffffff;font-size:18px;font-weight:bold;cursor:pointer;}` +
        `.back{background:${p.tint};opacity:0;}` +
        '.back.on{opacity:1;}.front.off{opacity:0;}';
      const rows = headRow(copy.head || 'Flip the card to reveal your prize') +
        `<tr><td class="pad center"><div class="flipwrap">` +
        `<div class="front" [class]="g.flipped ? 'face front off' : 'face front'" role="button" tabindex="0" on="tap:AMP.setState({g:{flipped:true}})">Tap to flip</div>` +
        `<div class="back" [class]="g.flipped ? 'face back on' : 'face back'"><p class="lead" style="font-size:24px">${pct}% OFF</p><div class="code">${enc(code)}</div></div>` +
        `</div></td></tr>`;
      return { rows: rows + footRow('One flip per customer. Terms apply.'), css, components: [], state: { flipped: false } };
    },
  };

  // ===== COMMERCE ==========================================================
  M.carousel = {
    name: 'Product Carousel', kind: 'carousel', group: 'Commerce',
    build(ctx) {
      const { products, currency } = ctx;
      const slides = products.map((pr) =>
        `<div class="slide"><table role="presentation" width="100%"><tr><td>${ampImg(pr, { width: 600, height: 400, alt: pr.name })}</td></tr>` +
        `<tr><td class="center"><div class="pname">${enc(pr.name)}</div><div class="pprice">${formatPrice(pr.price, currency)}</div></td></tr></table></div>`
      ).join('');
      const css = '.slide{padding:6px;}';
      const rows = headRow(ctx.copy.head || 'Swipe through this week’s picks') +
        `<tr><td class="pad"><amp-carousel width="600" height="480" layout="responsive" type="slides">${slides}</amp-carousel></td></tr>`;
      return { rows: rows + footRow('Swipe to browse. Tap an item on our site to buy.'), css, components: ['amp-carousel'], state: {} };
    },
  };

  M.search = {
    name: 'Search & Filter Catalog', kind: 'live-search', group: 'Commerce',
    build(ctx) {
      const { p, products, currency } = ctx;
      const css =
        `.sin{width:100%;box-sizing:border-box;padding:11px;border:1px solid ${p.line};border-radius:8px;margin-bottom:12px;}` +
        '.card{display:inline-block;width:46%;vertical-align:top;margin:1.5%;}' +
        `.cardin{border:1px solid ${p.line};border-radius:10px;overflow:hidden;}`;
      const cards = products.map((pr) => {
        const key = enc(String(pr.name).toLowerCase());
        return `<div class="card" [class]="(g.q == '' || '${key}'.indexOf(g.q) != -1) ? 'card db' : 'card dn'"><div class="cardin">${ampImg(pr, { width: 300, height: 200, alt: pr.name })}<div style="padding:9px"><div class="pname">${enc(pr.name)}</div><div class="pprice">${formatPrice(pr.price, currency)}</div></div></div></div>`;
      }).join('');
      const rows = headRow(ctx.copy.head || 'Search the catalogue from your inbox') +
        `<tr><td class="pad"><input class="sin" type="text" placeholder="Search products" on="input-throttle:AMP.setState({g:{q:event.value.toLowerCase()}})">${cards}</td></tr>`;
      return { rows: rows + footRow('Live catalogue search, right inside your inbox.'), css, components: [], state: { q: '' } };
    },
  };

  M.cart = {
    name: 'Add to Cart', kind: 'add-to-cart', group: 'Commerce',
    build(ctx) {
      const { p, products, currency } = ctx;
      const a = products[0], b = products[1] || products[0];
      const PA = a.price, PB = b.price;
      const css =
        `.line{border-bottom:1px solid ${p.line};padding:12px 0;}` +
        `.qbtn{display:inline-block;width:30px;height:30px;line-height:28px;text-align:center;border:1px solid ${p.line};border-radius:6px;font-weight:bold;cursor:pointer;color:${p.primary};}` +
        '.qn{display:inline-block;width:34px;text-align:center;font-weight:bold;}';
      const line = (pr, key) =>
        `<table role="presentation" width="100%" class="line"><tr>` +
        `<td width="64">${ampImg(pr, { width: 64, height: 64, layout: 'fixed', alt: pr.name })}</td>` +
        `<td><div class="pname">${enc(pr.name)}</div><div class="pprice">${formatPrice(pr.price, currency)}</div></td>` +
        `<td align="right" style="white-space:nowrap">` +
        `<span class="qbtn" role="button" tabindex="0" on="tap:AMP.setState({g:{${key}: (g.${key} &gt; 0 ? g.${key}-1 : 0)}})">-</span>` +
        `<span class="qn" [text]="g.${key}">0</span>` +
        `<span class="qbtn" role="button" tabindex="0" on="tap:AMP.setState({g:{${key}: g.${key}+1}})">+</span>` +
        `</td></tr></table>`;
      const rows = headRow(ctx.copy.head || 'Build your cart without leaving your inbox') +
        `<tr><td class="pad">${line(a, 'qa')}${line(b, 'qb')}` +
        `<table role="presentation" width="100%" style="margin-top:14px"><tr><td class="pname">Subtotal</td>` +
        `<td align="right" class="pprice" style="font-size:18px">${sym(currency)}<span [text]="g.qa*${PA} + g.qb*${PB}">0</span></td></tr></table>` +
        `<div class="btn" style="margin-top:14px;width:100%;box-sizing:border-box" role="button" tabindex="0" on="tap:AMP.setState({g:{added:true}})" [class]="(g.qa+g.qb) &gt; 0 ? 'btn' : 'btn'">Add <span [text]="g.qa+g.qb">0</span> to cart</div>` +
        `<p class="sub center dn" style="margin-top:10px" [class]="g.added ? 'sub center db' : 'sub center dn'">Saved to your cart — finish checkout on our site.</p>` +
        `</td></tr>`;
      return { rows: rows + footRow('Prices update live. Checkout completes on our site.'), css, components: [], state: { qa: 0, qb: 0, added: false } };
    },
  };

  // COMPLETE FUNCTIONAL FLOW (Part C). The wishlist is no longer a dead local
  // toggle: it is a full select → submit → submitting → success/thank-you →
  // error+retry cycle, posting the SELECTED SKUs + hidden tracking inputs +
  // merge tokens through an amp-form action-xhr, and deep-linking every item to
  // its REAL product page. Mirrors the lead-capture state machine in
  // prodtemplate.js (responseData-style [class] toggles + a `submitting` loader).
  M.wishlist = {
    name: 'Wishlist', kind: 'wishlist', group: 'Commerce',
    build(ctx) {
      const { p, products, currency, endpoint, brandName } = ctx;
      // readable ink on the primary button background (luxury black → white)
      const onInk = (hex) => {
        const c = String(hex || '').replace('#', ''); if (c.length < 6) return '#ffffff';
        const f = (i) => { const v = parseInt(c.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return (0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4)) > 0.55 ? '#1a1a1a' : '#ffffff';
      };
      // sanitise a value so it is safe both as JS-string content AND as an HTML
      // attribute (the [value] bindings live inside double-quoted attributes).
      const safeVal = (s) => String(s == null ? '' : s).replace(/[\\'"<>&]/g, ' ').replace(/\s+/g, ' ').trim();
      const slug = String(brandName || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'brand';

      // a real "view wishlist" deep-link on the brand's OWN origin (from a real
      // product URL when we have one), carrying UTM + the per-recipient token.
      let brandBase = 'https://www.' + slug.replace(/_/g, '') + '.com';
      try { if (products[0] && products[0].link) brandBase = new URL(products[0].link).origin; } catch (e) { /* keep default */ }
      const withUtm = (u, medium) => { const b = u || brandBase; return b + (b.indexOf('?') === -1 ? '?' : '&') + 'utm_source=amp_email&utm_medium=' + medium; };
      const viewWishlist = brandBase + '/wishlist?utm_source=amp_email&utm_medium=wishlist_cta&em=[EMAIL]';

      const css =
        `.wl-item{border:1px solid ${p.line};border-radius:12px;padding:10px;margin:0 0 10px;}` +
        'amp-img img{object-fit:cover;}' +
        `.wbtn{display:inline-block;padding:8px 15px;border:1px solid ${p.accent};color:${p.accent};border-radius:22px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap;}` +
        `.wbtn.on{background:${p.accent};color:${onInk(p.accent)};}` +
        `.ponsite{color:${p.primary};font-weight:600;font-size:12px;text-decoration:none;}` +
        '.wl-summary{font-size:13px;color:#5a5a5a;margin:8px 0 0;}' +
        `.wl-success{padding:20px;border:1px solid ${p.line};border-radius:14px;background:${p.tint};}` +
        `.wl-tick{font-size:32px;line-height:1;margin:0 0 6px;color:${p.primary};}` +
        `.wl-cta{display:inline-block;margin-top:12px;padding:11px 24px;border-radius:8px;background:${p.primary};color:${onInk(p.primary)};font-weight:700;font-size:14px;}`;

      const priceCell = (pr) => pr.price != null
        ? `<div class="pprice">${formatPrice(pr.price, currency)}</div>`
        : `<a class="ponsite" href="${withUtm(pr.link, 'wishlist_price')}">See price on site &rarr;</a>`;

      const item = (pr, key) => {
        const link = withUtm(pr.link, 'wishlist_item');
        return `<table role="presentation" width="100%" class="wl-item"><tr>` +
          `<td width="72" valign="top"><a href="${link}">${ampImg(pr, { width: 72, height: 72, layout: 'fixed', alt: pr.name })}</a></td>` +
          `<td valign="top" style="padding:0 10px"><a href="${link}" style="text-decoration:none"><div class="pname">${enc(pr.name)}</div></a>${priceCell(pr)}</td>` +
          `<td align="right" valign="top"><span class="wbtn" role="button" tabindex="0" ` +
          `[class]="g.${key} ? 'wbtn on' : 'wbtn'" [text]="g.${key} ? '✓ Saved' : '+ Save'" ` +
          `on="tap:AMP.setState({g:{${key}: !g.${key}}})">+ Save</span></td>` +
          `</tr></table>`;
      };

      const keys = ['wa', 'wb', 'wc'];
      const picks = (products || []).slice(0, 3);
      const itemsHtml = picks.map((pr, i) => item(pr, keys[i])).join('');
      const skuExpr = picks.map((pr, i) => `(g.${keys[i]} ? '${safeVal(pr.sku || pr.name)},' : '')`).join(' + ') || "''";
      const nameExpr = picks.map((pr, i) => `(g.${keys[i]} ? '${safeVal(pr.name)};' : '')`).join(' + ') || "''";
      // The selected count is DERIVED from the selection booleans — never an
      // incrementally-maintained counter — so it can never desync from the actual
      // selection (two taps in one frame, etc.). Used for the summary, the submit
      // gate/label, the hidden capture and the success confirmation count.
      const nExpr = picks.map((pr, i) => `(g.${keys[i]} ? 1 : 0)`).join(' + ') || '0';

      const onAttr = 'on="' +
        'submit-success:AMP.setState({wlres:{status:event.response.status,message:event.response.message,count:' + nExpr + '}});' +
        "submit-error:AMP.setState({wlres:{status:'error',message:'We couldn’t save your wishlist. Please try again.'}})" +
        '"';

      const formInner =
        // ---- active area (hidden once success) ----
        `<div class="displayBlock" [class]="wlres.status == 'success' ? 'displayNone' : 'displayBlock'">` +
          itemsHtml +
          `<p class="wl-summary center"><span [text]="${nExpr}">0</span> item(s) selected</p>` +
          // submit — shown only when at least one item is selected
          `<div class="displayNone center" [class]="${nExpr} &gt; 0 ? 'displayBlock center' : 'displayNone'" style="margin-top:14px">` +
            `<button type="submit" class="interest-btn"><span [text]="'Save ' + (${nExpr}) + ' to my wishlist'">Save to my wishlist</span></button>` +
          `</div>` +
          // hint — shown when nothing is selected yet
          `<div class="displayBlock center" [class]="${nExpr} &gt; 0 ? 'displayNone' : 'displayBlock center'" style="margin-top:12px">` +
            `<p class="sub">Tap <b>+ Save</b> on an item to add it to your wishlist.</p>` +
          `</div>` +
          // error — active area stays visible so the user can simply resubmit
          `<div class="displayNone center" [class]="wlres.status == 'error' ? 'displayBlock center' : 'displayNone'" style="margin-top:12px">` +
            `<p class="err" [text]="wlres.message">We couldn’t save your wishlist. Please try again.</p>` +
            `<p class="sub">Your selection is still here &mdash; tap the button to retry.</p>` +
          `</div>` +
        `</div>` +
        // ---- submitting loader (amp-form toggles this during the XHR) ----
        `<div submitting class="loader"><p class="sub center">Saving your wishlist&hellip;</p></div>` +
        // ---- success thank-you (real confirmation + count + view-wishlist CTA) ----
        `<div class="displayNone" [class]="wlres.status == 'success' ? 'displayBlock' : 'displayNone'">` +
          `<div class="wl-success center"><p class="wl-tick">✓</p>` +
          `<p class="thanks" style="padding:0">Saved! <span [text]="wlres.count">0</span> item(s) added to your wishlist.</p>` +
          `<p class="sub center" style="margin:6px 0 0">We&rsquo;ll email you if anything you saved drops in price or is running low.</p>` +
          `<a class="wl-cta" href="${viewWishlist}">View my wishlist</a></div>` +
        `</div>` +
        // ---- hidden capture (selected SKUs/names/count) + tracking + merge tokens ----
        `<input type="hidden" name="wishlist_count" value="0" [value]="${nExpr}">` +
        `<input type="hidden" name="wishlist_skus" value="" [value]="${skuExpr}">` +
        `<input type="hidden" name="wishlist_items" value="" [value]="${nameExpr}">` +
        `<input type="hidden" name="subscriber_email" value="[EMAIL]">` +
        `<input type="hidden" name="campaign_id" value="[CAMPAIGN_ID]">` +
        `<input type="hidden" name="customer_id" value="[CUSTOMER_ID]">` +
        `<input type="hidden" name="smt_mid" value="[SMT_MID]">` +
        `<input type="hidden" name="client_name" value="${enc(slug)}">` +
        `<input type="hidden" name="request_form_type" value="AMP">` +
        `<input type="hidden" name="x_utm_source" value="EMAIL">` +
        `<input type="hidden" name="x_utm_medium" value="EMAIL_AMP">` +
        `<input type="hidden" name="x_utm_campaign" value="EMAIL_AMP_WISHLIST">`;

      const rows = headRow(ctx.copy.head || 'Save your favourites for later') +
        `<tr><td class="pad"><form id="wishlist_form" method="post" action-xhr="${endpoint}" ${onAttr}>${formInner}</form></td></tr>`;

      return {
        rows: rows + footRow('Your wishlist syncs to your ' + (brandName || '') + ' account.'),
        css,
        components: ['amp-form'],
        state: { wa: false, wb: false, wc: false },
      };
    },
  };

  // ===== QUIZ / POLL / FEEDBACK ===========================================
  M.quiz = {
    name: 'Quiz & Match', kind: 'quiz', group: 'Feedback',
    build(ctx) {
      const { p, copy, content } = ctx;
      const css =
        `.opt{border:1px solid ${p.line};border-radius:10px;padding:14px;margin:0 0 10px;cursor:pointer;}` +
        `.opt.on{border-color:${p.primary};background:${p.tint};}` +
        `.res{background:${p.tint};border-radius:10px;padding:16px;}`;
      const keys = ['a', 'b', 'c', 'd'];
      const qz = (content && content.quiz) || {};
      const src = (qz.options && qz.options.length ? qz.options : [
        { label: 'Bold & adventurous', result: 'You’re a trailblazer — here are our boldest picks.' },
        { label: 'Calm & classic', result: 'Timeless taste — our classics are made for you.' },
        { label: 'Playful & fun', result: 'You bring the fun — these vibrant picks match your energy.' },
      ]).slice(0, 4).map((o, i) => [keys[i], o.label, o.result]);
      const buttons = src.map(([k, label]) => `<div class="opt" [class]="g.sel == '${k}' ? 'opt on' : 'opt'" role="button" tabindex="0" on="tap:AMP.setState({g:{sel:'${k}'}})">${enc(label)}</div>`).join('');
      const results = src.map(([k, , res]) => `<div class="res dn" [class]="g.sel == '${k}' ? 'res db' : 'res dn'"><p style="font-weight:bold;color:${p.primary};margin:0 0 6px">Your match</p><p class="sub" style="margin:0">${enc(res)}</p></div>`).join('');
      const rows = headRow(copy.head || qz.q || 'Which one are you?') +
        `<tr><td class="pad"><p style="font-size:17px;font-weight:bold;margin:0 0 14px">Tap the answer that fits you best</p>${buttons}${results}</td></tr>`;
      return { rows: rows + footRow('Tap an answer for your personalised pick.'), css, components: [], state: { sel: '' } };
    },
  };

  M.poll = {
    name: 'This or That Poll', kind: 'poll', group: 'Feedback',
    build(ctx) {
      const { p, copy, content } = ctx;
      const poll = (content && content.poll) || {};
      const A = copy.a || poll.a || 'This', B = copy.b || poll.b || 'That';
      const css =
        `.po{display:inline-block;width:46%;margin:1.5%;text-align:center;border:2px solid ${p.line};border-radius:12px;padding:22px 8px;cursor:pointer;font-weight:bold;}` +
        `.po.on{border-color:${p.primary};background:${p.tint};}` +
        `.res{text-align:center;background:${p.tint};border-radius:10px;padding:16px;margin-top:14px;}`;
      const rows = headRow(copy.head || poll.q || 'This or that? Cast your vote') +
        `<tr><td class="pad center">` +
        `<div class="po" [class]="g.v == 'a' ? 'po on' : 'po'" role="button" tabindex="0" on="tap:AMP.setState({g:{v:'a'}})">${enc(A)}</div>` +
        `<div class="po" [class]="g.v == 'b' ? 'po on' : 'po'" role="button" tabindex="0" on="tap:AMP.setState({g:{v:'b'}})">${enc(B)}</div>` +
        `<div class="res dn" [class]="g.v == '' ? 'res dn' : 'res db'"><p class="sub" style="margin:0" [text]="g.v == 'a' ? 'You’re with the 64% who chose ${enc(A)}. Great pick!' : 'You joined the 36% backing ${enc(B)}. Bold!'"></p></div>` +
        `</td></tr>`;
      return { rows: rows + footRow('Tap to vote — results update instantly.'), css, components: [], state: { v: '' } };
    },
  };

  M.rating = {
    name: 'Star Rating', kind: 'rating', group: 'Feedback',
    build(ctx) {
      const { p, copy, content } = ctx;
      const css =
        `.star{display:inline-block;font-size:40px;cursor:pointer;padding:0 4px;color:${p.line};}` +
        `.star.on{color:${p.accent};}`;
      let stars = '';
      for (let i = 1; i <= 5; i++) stars += `<span class="star" [class]="g.score &gt;= ${i} ? 'star on' : 'star'" role="button" tabindex="0" on="tap:AMP.setState({g:{score:${i}}})">★</span>`;
      const rows = headRow(copy.head || 'How did we do?') +
        `<tr><td class="pad center"><p class="sub">${enc(copy.prompt || (content && content.rate) || 'Rate your recent experience')}</p><div style="margin:10px 0">${stars}</div>` +
        `<p style="font-weight:bold;color:${p.primary};min-height:20px" [text]="g.score == 0 ? '' : 'You rated ' + g.score + ' out of 5 — thank you!'"></p></td></tr>`;
      return { rows: rows + footRow('Your feedback shapes what we do next.'), css, components: [], state: { score: 0 } };
    },
  };

  M.nps = {
    name: 'NPS Score', kind: 'nps', group: 'Feedback',
    build(ctx) {
      const { p, copy, endpoint } = ctx;
      const css =
        `.nb{display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;border:1px solid ${p.line};border-radius:6px;margin:2px;cursor:pointer;font-weight:bold;font-size:13px;}` +
        `.nb.on{background:${p.primary};color:#ffffff;border-color:${p.primary};}`;
      let scale = '';
      for (let i = 0; i <= 10; i++) scale += `<span class="nb" [class]="g.n == ${i} ? 'nb on' : 'nb'" role="button" tabindex="0" on="tap:AMP.setState({g:{n:${i}}})">${i}</span>`;
      const rows = headRow(copy.head || 'How likely are you to recommend us?') +
        `<tr><td class="pad center"><div style="margin:8px 0">${scale}</div>` +
        `<p style="font-weight:bold;color:${p.primary};min-height:20px" [text]="g.n &lt; 0 ? '' : (g.n &gt;= 9 ? 'A promoter — thank you!' : (g.n &gt;= 7 ? 'Glad you’re happy.' : 'We’ll do better — thank you.'))"></p>` +
        `<form method="post" action-xhr="${endpoint}" on="submit-success:AMP.setState({g:{sent:true}})"><input type="hidden" name="nps" value="0" [value]="g.n"><input type="submit" class="btn" value="Send feedback"></form>` +
        `<p class="sub dn" style="margin-top:8px" [class]="g.sent ? 'sub db' : 'sub dn'">Thanks for your feedback!</p></td></tr>`;
      return { rows: rows + footRow('One tap tells us how we’re doing.'), css, components: ['amp-form'], state: { n: -1, sent: false } };
    },
  };

  M.survey = {
    name: 'Multi-step Survey', kind: 'survey', group: 'Feedback',
    build(ctx) {
      const { p } = ctx;
      const css = `.opt{border:1px solid ${p.line};border-radius:10px;padding:13px;margin:0 0 10px;cursor:pointer;}`;
      const steps = [
        ['How often do you shop with us?', ['Weekly', 'Monthly', 'Rarely']],
        ['What matters most to you?', ['Price', 'Quality', 'Speed']],
        ['How did you hear about us?', ['Friend', 'Social', 'Search']],
      ];
      const frame = (i, q, options) =>
        `<div class="${i === 0 ? '' : 'dn'}" [class]="g.step == ${i} ? 'db' : 'dn'"><p style="font-weight:bold;font-size:16px;margin:0 0 12px">${enc(q)}</p>` +
        options.map((o) => `<div class="opt" role="button" tabindex="0" on="tap:AMP.setState({g:{step:g.step+1}})">${enc(o)}</div>`).join('') +
        `<p class="sub center">Step ${i + 1} of ${steps.length}</p></div>`;
      const frames = steps.map((s, i) => frame(i, s[0], s[1])).join('');
      const done = `<div class="dn center" [class]="g.step &gt;= ${steps.length} ? 'db center' : 'dn center'"><p class="lead" style="font-size:22px">All done!</p><p class="sub">Thanks for helping us improve.</p></div>`;
      const rows = headRow('A quick 3-step survey') + `<tr><td class="pad">${frames}${done}</td></tr>`;
      return { rows: rows + footRow('Three taps, that’s it. Thank you.'), css, components: [], state: { step: 0 } };
    },
  };

  M.yesno = {
    name: 'Yes / No Survey', kind: 'yesno', group: 'Feedback',
    build(ctx) {
      const { p, copy } = ctx;
      const css = `.yn{display:inline-block;width:42%;margin:1.5%;padding:18px;text-align:center;border:2px solid ${p.line};border-radius:12px;font-weight:bold;cursor:pointer;}` + `.yn.on{border-color:${p.primary};background:${p.tint};}`;
      const rows = headRow(copy.head || 'Quick question') +
        `<tr><td class="pad center"><p style="font-size:17px;font-weight:bold;margin:0 0 14px">${enc(copy.q || 'Would you recommend us to a friend?')}</p>` +
        `<div class="yn" [class]="g.a == 'y' ? 'yn on' : 'yn'" role="button" tabindex="0" on="tap:AMP.setState({g:{a:'y'}})">Yes</div>` +
        `<div class="yn" [class]="g.a == 'n' ? 'yn on' : 'yn'" role="button" tabindex="0" on="tap:AMP.setState({g:{a:'n'}})">No</div>` +
        `<p class="sub" style="margin-top:12px" [text]="g.a == '' ? '' : (g.a == 'y' ? 'Thank you — that means a lot!' : 'Thanks — we’ll keep improving.')"></p></td></tr>`;
      return { rows: rows + footRow('One tap, much appreciated.'), css, components: [], state: { a: '' } };
    },
  };

  // ===== CALCULATORS (baked lookup tables) =================================
  function presetRow(label, key, values, p) {
    const btns = values.map((v) => `<span class="cb" [class]="g.${key} == ${v} ? 'cb on' : 'cb'" role="button" tabindex="0" on="tap:AMP.setState({g:{${key}:${v}}})">${v}</span>`).join('');
    return `<p class="sub" style="margin:10px 0 4px">${enc(label)}</p><div>${btns}</div>`;
  }
  function bakedTernary(amts, yrs, fn, keyA, keyB) {
    // build nested ternary over the two selectors with precomputed values
    let expr = "'—'";
    for (const a of amts) for (const y of yrs) {
      expr = `(g.${keyA} == ${a} &amp;&amp; g.${keyB} == ${y}) ? '${fn(a, y)}' : ${expr}`;
    }
    return expr;
  }
  const calcCss = (p) => `.cb{display:inline-block;padding:8px 14px;border:1px solid ${p.line};border-radius:8px;margin:3px;cursor:pointer;font-weight:bold;font-size:13px;color:${p.primary};}` + `.cb.on{background:${p.primary};color:#ffffff;border-color:${p.primary};}` + `.cout{font-size:26px;font-weight:bold;color:${p.primary};margin:14px 0 4px;}`;

  M.sip = {
    name: 'SIP Calculator', kind: 'calculator', group: 'Calculators',
    build(ctx) {
      const { p, currency } = ctx;
      const amts = [2000, 5000, 10000], yrs = [5, 10, 15], r = 0.12, i = r / 12;
      const fv = (a, y) => { const n = y * 12; const f = a * (((Math.pow(1 + i, n) - 1) / i) * (1 + i)); return sym(currency) + Math.round(f).toLocaleString('en-IN'); };
      const expr = bakedTernary(amts, yrs, fv, 'amt', 'yr');
      const rows = headRow('SIP growth calculator') +
        `<tr><td class="pad center">${presetRow('Monthly investment', 'amt', amts, p)}${presetRow('Years', 'yr', yrs, p)}` +
        `<p class="sub" style="margin-top:14px">Estimated value at 12% p.a.</p><div class="cout" [text]="${expr}">—</div></td></tr>`;
      return { rows: rows + footRow('Illustrative only. Returns are not guaranteed.'), css: calcCss(p), components: [], state: { amt: 0, yr: 0 } };
    },
  };

  M.emi = {
    name: 'EMI Calculator', kind: 'calculator', group: 'Calculators',
    build(ctx) {
      const { p, currency } = ctx;
      const loans = [100000, 500000, 1000000], yrs = [1, 3, 5], r = 0.105, i = r / 12;
      const emi = (a, y) => { const n = y * 12; const e = (a * i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1); return sym(currency) + Math.round(e).toLocaleString('en-IN'); };
      const expr = bakedTernary(loans, yrs, emi, 'amt', 'yr');
      const rows = headRow('EMI calculator') +
        `<tr><td class="pad center">${presetRow('Loan amount', 'amt', loans, p)}${presetRow('Tenure (years)', 'yr', yrs, p)}` +
        `<p class="sub" style="margin-top:14px">Monthly EMI at 10.5% p.a.</p><div class="cout" [text]="${expr}">—</div></td></tr>`;
      return { rows: rows + footRow('Illustrative only. Final rate may vary.'), css: calcCss(p), components: [], state: { amt: 0, yr: 0 } };
    },
  };

  M.points = {
    name: 'Rewards Points', kind: 'calculator', group: 'Calculators',
    build(ctx) {
      const { p } = ctx;
      const spends = [1000, 5000, 10000];
      const tier = (s) => { const pts = Math.round(s * 0.05); return pts + ' pts → ' + (s >= 10000 ? 'Gold' : s >= 5000 ? 'Silver' : 'Bronze'); };
      let expr = "'—'";
      for (const s of spends) expr = `g.spend == ${s} ? '${tier(s)}' : ${expr}`;
      const rows = headRow('See what your spend earns') +
        `<tr><td class="pad center">${presetRow('Monthly spend', 'spend', spends, p)}` +
        `<div class="cout" [text]="${expr}">—</div></td></tr>`;
      return { rows: rows + footRow('Earn 5 points per 100 spent.'), css: calcCss(p), components: [], state: { spend: 0 } };
    },
  };

  // ===== CONTENT & UTILITY =================================================
  M.accordion = {
    name: 'FAQ Accordion', kind: 'accordion', group: 'Content',
    build(ctx) {
      const { p } = ctx;
      const css = `amp-accordion section{border-bottom:1px solid ${p.line};}` + `.ah{font-weight:bold;padding:14px 0;color:${p.ink};}` + `.ab{padding:0 0 14px;color:#6b6b7b;font-size:13px;line-height:1.6;}`;
      const faqs = [
        ['How long does delivery take?', 'Most orders arrive within 3–5 business days, with free returns for 30 days.'],
        ['Can I change my order?', 'Yes — you can edit or cancel within 1 hour of placing it from your account.'],
        ['Do you ship internationally?', 'We ship to 40+ countries. Duties are calculated at checkout.'],
      ];
      const secs = faqs.map(([q, a]) => `<section><h3 class="ah">${enc(q)}</h3><div class="ab">${enc(a)}</div></section>`).join('');
      const rows = headRow('Frequently asked') + `<tr><td class="pad"><amp-accordion>${secs}</amp-accordion></td></tr>`;
      return { rows: rows + footRow('Still stuck? Reply to this email.'), css, components: ['amp-accordion'], state: {} };
    },
  };

  M.tabs = {
    name: 'Tab Switcher', kind: 'tabs', group: 'Content',
    build(ctx) {
      const { p } = ctx;
      const css = `.tab{display:inline-block;padding:10px 16px;cursor:pointer;font-weight:bold;border-bottom:3px solid transparent;color:#6b6b7b;}` + `.tab.on{color:${p.primary};border-bottom-color:${p.primary};}`;
      const tabs = [['New in', 'Fresh arrivals dropping every week — be the first to shop them.'], ['Bestsellers', 'The pieces everyone’s loving right now, back in stock.'], ['Sale', 'Up to 50% off selected styles while stocks last.']];
      const head2 = tabs.map(([t], i) => `<span class="tab" [class]="g.tab == ${i} ? 'tab on' : 'tab'" role="button" tabindex="0" on="tap:AMP.setState({g:{tab:${i}}})">${enc(t)}</span>`).join('');
      const panels = tabs.map(([, body], i) => `<div class="${i === 0 ? '' : 'dn'}" [class]="g.tab == ${i} ? 'db' : 'dn'"><p class="sub" style="margin-top:14px">${enc(body)}</p></div>`).join('');
      const rows = headRow('Explore the collection') + `<tr><td class="pad center">${head2}<div style="text-align:left">${panels}</div></td></tr>`;
      return { rows: rows + footRow('Tap a tab to switch.'), css, components: [], state: { tab: 0 } };
    },
  };

  M.pincode = {
    name: 'Store Locator', kind: 'store-search', group: 'Content',
    build(ctx) {
      const { p } = ctx;
      const css = `.sin{width:100%;box-sizing:border-box;padding:11px;border:1px solid ${p.line};border-radius:8px;margin-bottom:12px;}` + `.store{padding:12px 0;border-bottom:1px solid ${p.line};}`;
      const stores = [
        ['Flagship — Bandra', 'Mumbai 400050', '400050'],
        ['High Street — Indiranagar', 'Bengaluru 560038', '560038'],
        ['Mall of India — Sector 18', 'Noida 201301', '201301'],
        ['Park Street', 'Kolkata 700016', '700016'],
      ];
      const items = stores.map(([n, addr, pin]) => `<div class="store" [class]="(g.q == '' || '${pin}'.indexOf(g.q) != -1 || '${enc(n.toLowerCase())}'.indexOf(g.q) != -1) ? 'store db' : 'store dn'"><div class="pname">${enc(n)}</div><div class="sub">${enc(addr)}</div></div>`).join('');
      const rows = headRow('Find a store near you') +
        `<tr><td class="pad"><input class="sin" type="text" placeholder="Enter pincode or city" on="input-throttle:AMP.setState({g:{q:event.value.toLowerCase()}})">${items}</td></tr>`;
      return { rows: rows + footRow('Stores update in real time.'), css, components: [], state: { q: '' } };
    },
  };

  M.otp = {
    name: 'OTP Verify', kind: 'otp', group: 'Content',
    build(ctx) {
      const { p } = ctx;
      const code = '4821';
      const css = `.oin{width:160px;text-align:center;letter-spacing:8px;font-size:24px;padding:12px;border:1px solid ${p.line};border-radius:8px;}`;
      const rows = headRow('Verify it’s you') +
        `<tr><td class="pad center"><p class="sub">Enter the code <b>${code}</b> we sent you</p>` +
        `<input class="oin" type="text" maxlength="4" placeholder="0000" on="input:AMP.setState({g:{code:event.value}})">` +
        `<p style="font-weight:bold;margin-top:14px" [class]="g.code == '${code}' ? 'db' : 'dn'" class="dn" [text]="'✓ Verified — welcome back!'">✓ Verified</p>` +
        `<p class="sub dn" [class]="(g.code != '' &amp;&amp; g.code != '${code}') ? 'sub db' : 'sub dn'">That code doesn’t match — try again.</p></td></tr>`;
      return { rows: rows + footRow('Codes expire after 10 minutes.'), css, components: [], state: { code: '' } };
    },
  };

  M.leadgen = {
    name: 'Lead Capture', kind: 'lead-form', group: 'Content',
    build(ctx) {
      const { p, endpoint } = ctx;
      const css = `.inp{width:100%;box-sizing:border-box;padding:11px;border:1px solid ${p.line};border-radius:8px;margin:6px 0;}`;
      const rows = headRow(ctx.copy.head || 'Get 10% off your first order') +
        `<tr><td class="pad"><p class="sub" style="margin-bottom:10px">Join the list — we’ll send your code straightaway.</p>` +
        `<form method="post" action-xhr="${endpoint}" on="submit-success:AMP.setState({g:{done:true}})">` +
        `<input class="inp" type="text" name="name" placeholder="Your name" required>` +
        `<input class="inp" type="email" name="email" placeholder="Email address" required>` +
        `<input type="submit" class="btn" style="width:100%;box-sizing:border-box;margin-top:6px" value="Send my code"></form>` +
        `<p class="sub center dn" style="margin-top:10px" [class]="g.done ? 'sub center db' : 'sub center dn'">You’re in! Check your inbox for the code.</p></td></tr>`;
      return { rows: rows + footRow('We’ll never share your details.'), css, components: ['amp-form'], state: { done: false } };
    },
  };

  M.lang = {
    name: 'Language Toggle', kind: 'multi-lingual', group: 'Content',
    build(ctx) {
      const { p } = ctx;
      const css = `.lb{display:inline-block;padding:8px 16px;border:1px solid ${p.line};border-radius:20px;margin:4px;cursor:pointer;font-weight:bold;}` + `.lb.on{background:${p.primary};color:#ffffff;border-color:${p.primary};}`;
      const rows = headRow('Read in your language') +
        `<tr><td class="pad center"><div>` +
        `<span class="lb" [class]="g.lang == 'en' ? 'lb on' : 'lb'" role="button" tabindex="0" on="tap:AMP.setState({g:{lang:'en'}})">English</span>` +
        `<span class="lb" [class]="g.lang == 'hi' ? 'lb on' : 'lb'" role="button" tabindex="0" on="tap:AMP.setState({g:{lang:'hi'}})">${enc('हिन्दी')}</span>` +
        `</div><p style="font-size:18px;font-weight:bold;margin-top:16px" [text]="g.lang == 'hi' ? '${enc('आपका स्वागत है!')}' : 'Welcome — great to see you!'">Welcome — great to see you!</p></td></tr>`;
      return { rows: rows + footRow('Tap a language to switch instantly.'), css, components: [], state: { lang: 'en' } };
    },
  };

  M.appointment = {
    name: 'Slot Booking', kind: 'appointment', group: 'Content',
    build(ctx) {
      const { p } = ctx;
      const css = `.slot{display:inline-block;padding:10px 16px;border:1px solid ${p.line};border-radius:8px;margin:4px;cursor:pointer;font-weight:bold;color:${p.primary};}` + `.slot.on{background:${p.primary};color:#ffffff;border-color:${p.primary};}`;
      const slots = ['10:00', '11:30', '14:00', '16:30'];
      const btns = slots.map((s) => `<span class="slot" [class]="g.slot == '${s}' ? 'slot on' : 'slot'" role="button" tabindex="0" on="tap:AMP.setState({g:{slot:'${s}'}})">${enc(s)}</span>`).join('');
      const rows = headRow('Book your appointment') +
        `<tr><td class="pad center"><p class="sub">Pick a time that works for you</p><div style="margin:10px 0">${btns}</div>` +
        `<p style="font-weight:bold;color:${p.primary};min-height:20px" [text]="g.slot == '' ? 'No time selected yet' : 'Booked for ' + g.slot + ' — see you then!'">No time selected yet</p></td></tr>`;
      return { rows: rows + footRow('You can reschedule any time.'), css, components: [], state: { slot: '' } };
    },
  };

  // ===== PAYMENTS ==========================================================
  // Pay-in-mail (UPI). AMP4EMAIL is the INTERACTION layer ONLY: the recipient
  // confirms an amount and sends a UPI collect request from inside the inbox; the
  // actual PIN authorisation always happens in their own UPI app, EXTERNALLY.
  // This module NEVER collects a delivery address and never asks for a card
  // number or UPI PIN — a VPA handle (name@bank) is a public identifier, not a
  // credential. The email's job ends at "payment requested"; every downstream
  // step (fulfilment, address, voucher delivery) is sent SEPARATELY.
  //
  // Three fulfilment paths (ctx.fulfillmentPath, a GenerationContext flag) each
  // get their OWN interaction framing and success-state copy. Crucially, none of
  // them say "order complete" — a completed PAYMENT is not a completed order:
  //   sender_known    → address already on file; nothing to collect here
  //   self_claim      → shareable claim link; recipient adds address externally
  //   digital_voucher → digital SKU; delivered by email, no address at all
  const UPI_PATHS = {
    sender_known: {
      head: 'A gift is waiting — complete the payment',
      cta: 'Send UPI request',
      sub: 'Confirm the amount and pay by UPI. We already have the delivery address on file.',
      note: 'Delivery address: already on file — nothing to enter here.',
      success: 'Payment complete. Your gift is on its way to the address on file — a confirmation has been sent to you separately.',
      foot: 'Payment is authorised in your own UPI app. No card number or UPI PIN is ever entered in this email.',
    },
    self_claim: {
      head: 'Send a gift — pay now, they claim it',
      cta: 'Pay & create claim link',
      sub: 'Pay by UPI to create a shareable gift link. Your recipient adds their delivery address when they claim it.',
      note: 'Recipient adds their address later, on the external claim page.',
      success: 'Payment complete. We’ve emailed you a shareable claim link — your recipient enters their delivery address on the secure claim page, not in this email.',
      foot: 'The address step happens externally on the claim page. This email only takes the payment.',
    },
    digital_voucher: {
      head: 'Buy a digital voucher by UPI',
      cta: 'Pay for voucher',
      sub: 'Pay by UPI for an instant digital voucher. Nothing ships, so no delivery address is needed.',
      note: 'Digital SKU — delivered by email, no address step.',
      success: 'Payment complete. Your digital voucher code has been sent to your inbox separately — no delivery address required.',
      foot: 'Digital delivery only. There is no physical shipment and no address step.',
    },
  };
  M.upi = {
    name: 'Pay in Mail (UPI)', kind: 'upi-pay', group: 'Payments',
    build(ctx) {
      const { p, currency, copy, endpoint, products } = ctx;
      const path = UPI_PATHS[ctx.fulfillmentPath] ? ctx.fulfillmentPath : 'sender_known';
      const C = UPI_PATHS[path];
      // Amount: explicit copy amount wins; else the first product's real price;
      // else a sensible gift default. Never fabricated onto a real SKU here — this
      // is the gift/voucher value the sender chooses, not a product price claim.
      const firstPrice = products && products[0] && products[0].price;
      const rawAmt = (copy && copy.amount) || (firstPrice != null ? firstPrice : 500);
      const amt = formatPrice(rawAmt, currency);
      const css =
        `.upi-pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:${p.primaryDark || p.primary};border:1px solid ${p.line};border-radius:20px;padding:4px 12px;}` +
        `.upi-amt{font-size:30px;font-weight:800;color:${p.primary};margin:10px 0 2px;}` +
        `.upi-note{display:inline-block;background:${p.tint};color:${p.ink};border-radius:8px;padding:8px 12px;font-size:12px;margin:8px 0;}` +
        `.upi-in{width:100%;box-sizing:border-box;padding:12px;border:1px solid ${p.line};border-radius:8px;margin:8px 0;font-size:15px;}` +
        `.upi-ok{background:${p.tint};border-radius:10px;padding:16px;margin-top:12px;text-align:left;}` +
        `.upi-ok .oh{font-weight:700;color:${p.primary};margin:0 0 4px;}`;
      const rows = headRow(copy.head || C.head) +
        `<tr><td class="pad center">` +
          `<span class="upi-pill">UPI &middot; Pay in mail</span>` +
          `<p class="upi-amt">${amt}</p>` +
          `<p class="sub">${enc(C.sub)}</p>` +
          `<div class="upi-note">${enc(C.note)}</div>` +
          `<form method="post" action-xhr="${endpoint}" on="submit-success:AMP.setState({g:{requested:true}})">` +
            `<input class="upi-in" type="text" name="upi_vpa" placeholder="yourname@bank" required pattern="[^@\\s]+@[^@\\s]+" title="Enter your UPI ID, e.g. name@bank">` +
            `<input type="hidden" name="amount" value="${enc(String(rawAmt))}">` +
            `<input type="hidden" name="currency" value="${enc(currency)}">` +
            `<input type="hidden" name="fulfillment_path" value="${enc(path)}">` +
            `<input type="submit" class="btn" style="width:100%;box-sizing:border-box" value="${enc(C.cta)}">` +
          `</form>` +
          `<div class="upi-ok dn" [class]="g.requested ? 'upi-ok db' : 'upi-ok dn'">` +
            `<p class="oh">Payment complete</p>` +
            `<p class="sub" style="margin:0">${enc(C.success)}</p>` +
          `</div>` +
        `</td></tr>`;
      return { rows: rows + footRow(C.foot), css, components: ['amp-form'], state: { requested: false } };
    },
  };

  return M;
};
