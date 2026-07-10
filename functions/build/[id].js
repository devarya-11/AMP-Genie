// GET /build/:id — the persisted build as data. Plain JSON strips the three
// bulky markup fields (ampHtml/fallbackHtml/fallbackText) so metadata reads
// stay light; ?format=amp / ?format=fallback serve the real file as a
// download (the share page's "Download AMP" link).

import storeMod from '../../server/store.js';
import { json } from '../_lib/http.js';

const { getBuild, brandSlug } = storeMod;

// Both filename parts reach a Content-Disposition header, so they are forced
// into a header-safe alphabet regardless of what the record carries.
function attachment(markup, build) {
  const slug = brandSlug(build.brand) || 'brand';
  const mod = String(build.moduleId || '').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'module';
  return new Response(markup || '', {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="amp-genie-${slug}-${mod}.html"`,
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestGet({ params, env, request }) {
  const build = await getBuild(env.HISTORY, params.id);
  if (!build) return json({ error: 'build not found' }, 404);
  const format = new URL(request.url).searchParams.get('format');
  if (format === 'amp') return attachment(build.ampHtml, build);
  if (format === 'fallback') return attachment(build.fallbackHtml, build);
  const { ampHtml, fallbackHtml, fallbackText, ...meta } = build;
  return json(meta);
}
