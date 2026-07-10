// GET /s/:id — public share page for a slate: every build it references,
// rendered as a phone-frame grid. Builds are fetched concurrently and a
// missing one (expired/deleted key) drops out silently — a slate page with
// N-1 phones still pitches better than an error page.

import storeMod from '../../server/store.js';
import sharePagesMod from '../../server/share-pages.js';
import { html } from '../_lib/http.js';

const { getSlate, getBuild } = storeMod;
const { slatePageHtml, notFoundPageHtml } = sharePagesMod;

export async function onRequestGet({ params, env }) {
  const slate = await getSlate(env.HISTORY, params.id);
  if (!slate) return html(notFoundPageHtml('slate'), 404);
  const ids = Array.isArray(slate.buildIds) ? slate.buildIds : [];
  const builds = (await Promise.all(ids.map((id) => getBuild(env.HISTORY, id)))).filter(Boolean);
  return html(slatePageHtml(slate, builds));
}
