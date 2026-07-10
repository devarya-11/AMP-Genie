// GET /b/:id — public share page for one persisted build. Server-rendered
// from KV so the bare link is the whole deliverable: no app, no login, just
// the phone-framed live preview a client can tap.

import storeMod from '../../server/store.js';
import sharePagesMod from '../../server/share-pages.js';
import { html } from '../_lib/http.js';

const { getBuild } = storeMod;
const { buildPageHtml, notFoundPageHtml } = sharePagesMod;

export async function onRequestGet({ params, env }) {
  const build = await getBuild(env.HISTORY, params.id);
  if (!build) return html(notFoundPageHtml('build'), 404);
  return html(buildPageHtml(build));
}
