// POST /validate — re-run the real validator on (possibly edited) AMP.

import { validate } from './_lib/validator.js';
import { json, readJson } from './_lib/http.js';

export async function onRequestPost({ request }) {
  try {
    const body = await readJson(request);
    const v = await validate(body.ampHtml || '');
    return json(v);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
}
