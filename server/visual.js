'use strict';

// Feature 3 — Visual Layer. Pass 2: swap placehold.co placeholders for real
// HTTPS assets (logo + product images). Re-validate. Any asset that isn't HTTPS
// or doesn't resolve degrades back to its placeholder; the email never breaks.

const { validate } = require('./validator');

const AMPIMG_RE = /<amp-img\s+([^>]*?)src="(https:\/\/placehold\.co[^"]*)"([^>]*?)>/gi;

async function reachableHttps(url) {
  if (!/^https:\/\//i.test(url)) return false;
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(4000) });
    if (r.ok) return true;
    // some CDNs reject HEAD; try a tiny GET
    const g = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(4000) });
    return g.ok;
  } catch { return false; }
}

async function renderVisuals(body) {
  const ampHtml = body.ampHtml || '';
  const products = Array.isArray(body.products) ? body.products : [];
  const logo = body.logo || null;

  // Build the ordered asset queue: logo first (hero), then product images.
  const queue = [];
  if (logo) queue.push(logo);
  for (const p of products) if (p && p.imageUrl) queue.push(p.imageUrl);

  // Validate reachability up-front (parallel, capped).
  const checked = new Map();
  await Promise.all([...new Set(queue)].map(async (u) => { checked.set(u, await reachableHttps(u)); }));

  const slots = [];
  let qi = 0;
  const swapped = ampHtml.replace(AMPIMG_RE, (full, pre, src, post) => {
    // find next usable asset
    let chosen = null;
    while (qi < queue.length) {
      const cand = queue[qi++];
      if (checked.get(cand)) { chosen = cand; break; }
    }
    if (!chosen) {
      slots.push({ from: src, to: null, status: 'placeholder' });
      return full; // keep placeholder
    }
    slots.push({ from: src, to: chosen, status: 'rendered' });
    return `<amp-img ${pre}src="${chosen}"${post}>`;
  });

  const renderedCount = slots.filter((s) => s.status === 'rendered').length;
  const v = await validate(swapped);

  // If the swap somehow broke validation, fall back entirely to the original.
  if (!v.pass) {
    const orig = await validate(ampHtml);
    return {
      ampHtml,
      validation: orig,
      visualStatus: 'failed',
      rendered: 0,
      slots: slots.map((s) => ({ ...s, status: 'placeholder', to: null })),
      note: 'Real assets broke validation; reverted to placeholders.',
    };
  }

  return {
    ampHtml: swapped,
    validation: v,
    visualStatus: renderedCount > 0 ? 'rendered' : 'pending',
    rendered: renderedCount,
    total: slots.length,
    slots,
  };
}

module.exports = { renderVisuals };
