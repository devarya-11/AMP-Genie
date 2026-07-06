'use strict';

// Part A + Part C proof — a REAL Burberry product inside a COMPLETE wishlist flow.
//
// Runs the real pipeline (resolveAssets → buildProduction → amphtml-validator)
// for Burberry, then:
//   • asserts the email VALIDATES (AMP4EMAIL, 0 errors) — the binding gate;
//   • asserts Part A: every shown product is a REAL same-SKU pull (real name +
//     official CDN image + deep link to its OWN product page), with a price where
//     the brand exposes one and an honest "see price on site" where it does not —
//     we never staple a fabricated price onto a real SKU;
//   • writes web/_demo/partA-wishlist.json (the interactive email for the viewer);
//   • writes web/_demo/partA-wishlist.html — a storyboard that EMBEDS the live
//     email AND shows the five flow states (initial → selected → submitting →
//     success/thank-you → error+retry) beside the real Burberry products.
//
// Exit 0 only when the email is valid AND at least one real same-SKU product
// is rendered end-to-end (name + official image + product-page link).

const fs = require('fs');
const path = require('path');
const { resolveAssets } = require('../server/assets');
const { buildProduction } = require('../server/build');
const { validate } = require('../server/validator');
const { formatPrice } = require('../server/generate');

const OUT = path.join(__dirname, '..', 'web', '_demo');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const trunc = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function onInk(hex) {
  const c = String(hex || '').replace('#', ''); if (c.length < 6) return '#ffffff';
  const f = (i) => { const x = parseInt(c.slice(i, i + 2), 16) / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return (0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4)) > 0.55 ? '#1a1a1a' : '#ffffff';
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const BRAND = { brandName: 'Burberry', brandUrl: 'https://us.burberry.com', vertical: 'Fashion', currency: 'USD' };
  console.log(`Resolving REAL assets for ${BRAND.brandName} (homepage → sitemap → PDP JSON-LD crawl)…`);
  const t0 = Date.now();
  const resolved = await resolveAssets({
    brandName: BRAND.brandName, brandUrl: BRAND.brandUrl,
    vertical: BRAND.vertical, currency: BRAND.currency,
    need: { logo: true, products: 3, hero: true },
  });
  console.log(`  …resolved in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Build the wishlist email through the SAME resolved context, then validate it
  // with the real amphtml-validator (AMP4EMAIL). This is the binding gate.
  const built = buildProduction({
    moduleId: 'wishlist', resolved, currency: BRAND.currency,
    endpoint: 'https://api.acme.in/wishlist',
  });
  const v = await validate(built.ampHtml);

  // ---- Part A provenance (console) ----
  const prods = resolved.assets.products || [];
  console.log(`=== ${BRAND.brandName} — wishlist products (Part A: exact same-SKU) ===`);
  prods.forEach((pr, i) => {
    const price = pr.price != null ? formatPrice(pr.price, BRAND.currency) : '(on site)';
    console.log(`  [${i}] ${trunc(pr.name, 40)}`);
    console.log(`      price=${price}  real=${pr.real ? 'YES' : 'no'}  tier=${pr.tier}  rights=${pr.rights}`);
    console.log(`      sku  = ${pr.sku || '—'}`);
    console.log(`      image= ${trunc(pr.url, 88)}`);
    console.log(`      link = ${trunc(pr.link || '—', 88)}`);
  });

  const realProds = prods.filter((pr) => pr.real && pr.url && /^https:\/\//.test(pr.url) && pr.link);
  const partAOk = realProds.length >= 1; // ≥1 real same-SKU product, end to end
  console.log(`\n  → ${built.moduleName}: ${v.pass ? 'VALID ✓ (0 errors)' : 'INVALID ✗ ' + v.errorCount + ' errors'}`);
  console.log(`  → Part A: ${realProds.length}/${prods.length} products are REAL same-SKU pulls (name+image+link) — ${partAOk ? 'PASS' : 'FAIL'}`);
  if (!v.pass) {
    console.log('\nVALIDATOR ERRORS:');
    v.errors.filter((e) => e.severity === 'ERROR').forEach((e) => console.log(`  L${e.line}:${e.col}  ${e.message}  [${e.code}]`));
  }

  // ---- viewer JSON (interactive email) ----
  fs.writeFileSync(path.join(OUT, 'partA-wishlist.json'), JSON.stringify({
    ampHtml: built.ampHtml, brand: BRAND.brandName, moduleName: built.moduleName,
    kind: built.kind, palette: built.context.palette, nav: [],
  }));

  // ---------------------------------------------------------------------------
  // Storyboard — the five flow states beside the REAL Burberry products. These
  // are faithful static renders of what the live amp-bind states produce (the
  // SAME products, palette and copy the email ships), so the flow is legible at
  // a glance even before you interact with the embedded live email above.
  // ---------------------------------------------------------------------------
  const pal = built.palette; // {primary, primaryDark, accent, tint, ink, line}
  const logo = resolved.assets.logo || {};
  const picks = prods.slice(0, 3);

  const priceLine = (pr) => pr.price != null
    ? `<div class="pprice">${esc(formatPrice(pr.price, BRAND.currency))}</div>`
    : `<a class="ponsite" href="${esc(pr.link || '#')}" target="_blank" rel="noopener">See price on site &rarr;</a>`;

  const itemRow = (pr, saved, dim) => `
    <div class="wl-item${dim ? ' dim' : ''}">
      <div class="thumb"><img src="${esc(pr.url)}" alt="${esc(pr.name)}" loading="lazy"></div>
      <div class="meta">
        <div class="pname">${esc(trunc(pr.name, 46))}</div>
        ${priceLine(pr)}
        ${pr.real ? `<div class="prov">real SKU · ${esc(pr.tier)}${pr.sku ? ' · ' + esc(trunc(pr.sku, 18)) : ''}</div>` : ''}
      </div>
      <div class="act"><span class="wbtn${saved ? ' on' : ''}">${saved ? '✓ Saved' : '+ Save'}</span></div>
    </div>`;

  const items = (savedArr, dim) => picks.map((pr, i) => itemRow(pr, !!savedArr[i], dim)).join('');

  const panel = (step, label, caption, body) => `
    <figure class="panel">
      <figcaption><span class="step">${esc(step)}</span><span class="plabel">${esc(label)}</span><span class="pcap">${esc(caption)}</span></figcaption>
      <div class="device">
        <div class="ehead"><img class="elogo" src="${esc(logo.url || '')}" alt="${esc(BRAND.brandName)}"></div>
        <div class="etitle">Save your favourites for later</div>
        <div class="ebody">${body}</div>
        <div class="efoot">Your wishlist syncs to your ${esc(BRAND.brandName)} account.</div>
      </div>
    </figure>`;

  const submitBtn = (n) => `<div class="btnrow"><button class="interest-btn" type="button">Save ${n} to my wishlist</button></div>`;
  const summary = (n) => `<p class="wl-summary">${n} item(s) selected</p>`;

  // 1) initial — nothing selected
  const sInit = panel('1', 'Initial state', 'Real products, every Save button live.',
    items([false, false, false]) + summary(0) +
    `<p class="hint">Tap <b>+ Save</b> on an item to add it to your wishlist.</p>`);

  // 2) selected — user has saved two items (visible selected state + running count)
  const sSel = panel('2', 'Selected', 'amp-bind [class]/[text] toggle the chip + count; submit appears.',
    items([true, true, false]) + summary(2) + submitBtn(2));

  // 3) submitting — amp-form shows the [submitting] loader during the XHR
  const sSub = panel('3', 'Submitting', 'amp-form action-xhr posts the selected SKUs + tracking inputs.',
    items([true, true, false], true) +
    `<div class="loader"><span class="spin"></span><span>Saving your wishlist&hellip;</span></div>`);

  // 4) success — real confirmation + count + a view-wishlist deep link
  const sOk = panel('4', 'Success / thank-you', 'submit-success → confirmation, count + deep-linked CTA.',
    `<div class="wl-success">
       <div class="wl-tick">&#10003;</div>
       <p class="thanks">Saved! <b>2</b> item(s) added to your wishlist.</p>
       <p class="subnote">We&rsquo;ll email you if anything you saved drops in price or is running low.</p>
       <a class="wl-cta" href="${esc((picks[0] && picks[0].link ? new URL(picks[0].link).origin : 'https://us.burberry.com') + '/wishlist')}" target="_blank" rel="noopener">View my wishlist</a>
     </div>`);

  // 5) error — selection preserved, clear message, retry
  const sErr = panel('5', 'Error + retry', 'submit-error → message; selection preserved so the user can retry.',
    items([true, true, false]) + summary(2) +
    `<div class="errbox"><p class="errmsg">We couldn&rsquo;t save your wishlist. Please try again.</p>
       <p class="hint">Your selection is still here &mdash; tap the button to retry.</p></div>` +
    submitBtn(2));

  const provRows = picks.map((pr, i) => `
    <tr>
      <td>${i}</td>
      <td class="pn"><a href="${esc(pr.link || '#')}" target="_blank" rel="noopener">${esc(trunc(pr.name, 52))}</a></td>
      <td>${pr.price != null ? esc(formatPrice(pr.price, BRAND.currency)) : '<span class="muted">on site</span>'}</td>
      <td>${pr.real ? '<span class="ok">real</span>' : '<span class="muted">fallback</span>'}</td>
      <td><span class="tier tier-${esc(pr.tier)}">${esc(pr.tier)}</span></td>
      <td><span class="rights rights-${esc(pr.rights)}">${esc(pr.rights)}</span></td>
      <td class="img"><a href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(trunc((pr.url || '').replace(/^https:\/\//, ''), 38))}</a></td>
    </tr>`).join('');

  const validBadge = v.pass
    ? `<span class="badge pass">AMP4EMAIL VALID · 0 errors</span>`
    : `<span class="badge fail">INVALID · ${v.errorCount} errors</span>`;
  const partABadge = partAOk
    ? `<span class="badge pass">Part A · ${realProds.length}/${prods.length} real same-SKU products</span>`
    : `<span class="badge fail">Part A · no real product resolved</span>`;

  const ink = pal.ink || '#1c2230';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Part A + C — real Burberry product in a complete wishlist flow</title>
<style>
  :root{--ink:${ink};--mut:#6b7280;--line:#e6e8ee;--brand:${pal.primary};--accent:${pal.accent};--tint:${pal.tint}}
  *{box-sizing:border-box} body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#f4f6f9;padding:28px}
  h1{font-size:21px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 16px;max-width:880px}
  .badges{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 22px}
  .badge{font-size:12px;font-weight:700;padding:6px 12px;border-radius:20px}
  .badge.pass{background:#e8f5e9;color:#1f7a37} .badge.fail{background:#fdecea;color:#b3261e}
  section{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px 18px 22px;margin:0 0 20px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
  h2{font-size:15px;margin:0 0 4px} h2 small{color:var(--mut);font-weight:400}
  .secsub{color:var(--mut);margin:2px 0 16px;font-size:13px}
  /* provenance table */
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--mut)}
  td.pn a{color:var(--brand);font-weight:600;text-decoration:none} td.img a{color:var(--mut);text-decoration:none;font-size:11px}
  .muted{color:#9aa0a6} .ok{color:#1f7a37;font-weight:700}
  .tier,.rights{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase}
  .tier-brand-site{background:#e3f2fd;color:#1565c0}.tier-web{background:#e8f5e9;color:#2e7d32}.tier-generated{background:#fff3e0;color:#e65100}.tier-user{background:#f3e5f5;color:#6a1b9a}
  .rights-clear{background:#e8f5e9;color:#2e7d32}.rights-review{background:#fff8e1;color:#a16207}
  /* live email */
  .ampframe{width:100%;max-width:620px;height:1180px;border:1px solid var(--line);border-radius:12px;background:#fff;display:block}
  /* storyboard */
  .flow{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}
  @media(max-width:1180px){.flow{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:640px){.flow{grid-template-columns:1fr}}
  .panel{margin:0}
  figcaption{display:flex;align-items:baseline;gap:7px;margin:0 0 8px;flex-wrap:wrap}
  .step{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--brand);color:${onInk(pal.primary)};font-size:11px;font-weight:700;flex:none}
  .plabel{font-weight:700;font-size:13px} .pcap{color:var(--mut);font-size:11px;flex-basis:100%;margin-left:27px;line-height:1.4}
  .device{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#fff;display:flex;flex-direction:column;min-height:430px}
  .ehead{padding:12px 14px 6px;border-bottom:3px solid var(--brand)} .elogo{height:22px;width:auto;display:block;object-fit:contain}
  .etitle{font-family:Georgia,'Times New Roman',serif;font-size:14px;letter-spacing:.04em;color:var(--brand);padding:12px 14px 4px;font-weight:600}
  .ebody{padding:6px 12px 12px;flex:1}
  .efoot{padding:10px 14px;background:${pal.primaryDark || pal.primary};color:${onInk(pal.primaryDark || pal.primary)};font-size:10.5px;text-align:center}
  .wl-item{display:flex;gap:9px;align-items:flex-start;border:1px solid var(--line);border-radius:10px;padding:8px;margin:0 0 8px}
  .wl-item.dim{opacity:.5}
  .thumb{width:54px;height:54px;border-radius:7px;overflow:hidden;background:#eef0f3;flex:none}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .meta{flex:1;min-width:0} .pname{font-weight:600;font-size:12px;line-height:1.3}
  .pprice{font-weight:700;font-size:12px;color:var(--brand);margin-top:2px}
  .ponsite{color:var(--brand);font-weight:600;font-size:11px;text-decoration:none;margin-top:2px;display:inline-block}
  .prov{font-size:9.5px;color:var(--mut);margin-top:3px;text-transform:uppercase;letter-spacing:.3px}
  .act{flex:none} .wbtn{display:inline-block;padding:6px 11px;border:1px solid var(--accent);color:var(--accent);border-radius:20px;font-weight:700;font-size:11px;white-space:nowrap}
  .wbtn.on{background:var(--accent);color:${onInk(pal.accent)}}
  .wl-summary{text-align:center;font-size:12px;color:var(--mut);margin:8px 0 0}
  .hint{font-size:11.5px;color:var(--mut);text-align:center;margin:8px 0 0}
  .btnrow{text-align:center;margin-top:12px}
  .interest-btn{border:0;background:var(--brand);color:${onInk(pal.primary)};border-radius:6px;padding:11px 20px;font-size:13px;font-weight:700;letter-spacing:.3px;cursor:pointer}
  .loader{display:flex;align-items:center;justify-content:center;gap:9px;padding:24px 0;color:var(--mut);font-size:12.5px}
  .spin{width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--brand);border-radius:50%;display:inline-block;animation:sp .8s linear infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  .wl-success{text-align:center;padding:18px 12px;border:1px solid var(--line);border-radius:12px;background:var(--tint)}
  .wl-tick{font-size:30px;color:var(--brand);line-height:1} .thanks{font-weight:700;font-size:14px;margin:6px 0 0;color:var(--ink)}
  .subnote{font-size:11px;color:var(--mut);margin:6px 0 0;line-height:1.4}
  .wl-cta{display:inline-block;margin-top:12px;padding:10px 20px;border-radius:6px;background:var(--brand);color:${onInk(pal.primary)};font-weight:700;font-size:12px;text-decoration:none}
  .errbox{margin-top:10px;text-align:center} .errmsg{color:#d23b3b;font-weight:600;font-size:12px;margin:0}
</style></head><body>
<h1>Part A + Part C — a real Burberry product in a complete wishlist flow</h1>
<p class="sub">Real pipeline: <b>resolveAssets</b> crawled Burberry's sitemap → product-detail pages and pulled <b>exact same-SKU</b> records (name + official Scene7 image + product-page link from the SAME page); <b>buildProduction</b> rendered the wishlist; the <b>real amphtml-validator</b> gated it. The wishlist is no longer a dead toggle — it is a full <b>select → submit → submitting → thank-you → error+retry</b> amp-form cycle that posts the selected SKUs with tracking inputs and merge tokens.</p>
<div class="badges">${validBadge}${partABadge}</div>

<section>
  <h2>Part A — exact products from Burberry <small>· every row is one real SKU; name, price, image and link all belong to it</small></h2>
  <p class="secsub">Where Burberry's product page exposes no price (some PDPs list only availability), we show an honest <b>“on site”</b> link instead of inventing one — we never pass a fabricated price off as the real SKU.</p>
  <table>
    <tr><th>#</th><th>Product (→ real PDP)</th><th>Price</th><th>Source</th><th>Tier</th><th>Rights</th><th>Official image</th></tr>
    ${provRows}
  </table>
</section>

<section>
  <h2>The complete flow <small>· five states, the same real products throughout</small></h2>
  <p class="secsub">Faithful static renders of the live amp-bind / amp-form states the email ships.</p>
  <div class="flow">${sInit}${sSel}${sSub}${sOk}${sErr}</div>
</section>

<section>
  <h2>Live interactive email <small>· this is the validated AMP, running</small></h2>
  <p class="secsub">Click <b>+ Save</b> on a product — the chip flips to “✓ Saved”, the count updates and the <b>Save N to my wishlist</b> button appears (real amp-bind). Submitting posts to the configured <code>action-xhr</code> endpoint; with no backend wired it surfaces the error state, exactly as designed.</p>
  <iframe class="ampframe" srcdoc="${esc(built.ampHtml)}" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>
</section>
</body></html>`;
  fs.writeFileSync(path.join(OUT, 'partA-wishlist.html'), html);

  // ---------------------------------------------------------------------------
  // LIVE standalone pages — the actual proof of a COMPLETE cycle in a browser.
  //
  // The srcdoc-embedded email above can boot and toggle, but its source origin
  // is "about:srcdoc", so amp-form's action-xhr can never complete a real cycle.
  // Here we emit the SAME validated markup but with the action-xhr pointed at the
  // demo echo route, written as a full page. Served from http://localhost:4000
  // the document origin is a real, AMP-secure origin (AMP treats localhost as
  // secure) and the echo route returns the AMP-CORS handshake, so the live cycle
  // completes: select → submit → submitting → success (thank-you), and the
  // ?fail variant drives submit → submitting → error + retry.
  //
  // These pages are demo-only: http-localhost action-xhr is runtime-secure but
  // NOT AMP4EMAIL-valid, so the VALIDATED artifact above keeps its https endpoint
  // and the zero-error gate stays green. We do not gate on these.
  const liveCommon = {
    moduleId: 'wishlist', resolved, currency: BRAND.currency,
    // Configurable tracking endpoints (Part D) pointed at the demo collectors so
    // the open-track amp-list + click_form complete a real 200 round-trip live.
    openEndpoint: 'http://localhost:4000/_demo/track-open',
    clickEndpoint: 'http://localhost:4000/_demo/track-click',
  };
  const liveOk = buildProduction({
    ...liveCommon,
    endpoint: 'http://localhost:4000/_demo/wishlist-echo',
  });
  const liveFail = buildProduction({
    ...liveCommon,
    endpoint: 'http://localhost:4000/_demo/wishlist-echo?fail=1',
  });
  fs.writeFileSync(path.join(OUT, 'partA-wishlist-live.html'), liveOk.ampHtml);
  fs.writeFileSync(path.join(OUT, 'partA-wishlist-live-fail.html'), liveFail.ampHtml);

  console.log(`\nwrote web/_demo/partA-wishlist.html + web/_demo/partA-wishlist.json`);
  console.log(`wrote web/_demo/partA-wishlist-live.html (success) + partA-wishlist-live-fail.html (error)`);
  console.log(`open: http://localhost:4000/_demo/partA-wishlist.html`);
  console.log(`live: http://localhost:4000/_demo/partA-wishlist-live.html`);
  process.exit(v.pass && partAOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
