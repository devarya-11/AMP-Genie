// GET/POST /brandkit/:slug — the brand-kit editor's read/write endpoint.
// GET returns { kit } with kit null when nothing is saved — absence is a
// normal state the editor renders as an empty form, never a 404. POST merges
// a sanitized partial patch onto the existing kit (read-modify-write in
// server/store.js) and stamps it source:'manual' so a hand-edited kit is
// distinguishable from a fetch-frozen one.
//
// Clear vs keep: an EXPLICIT empty string for logoUrl / heroUrl / voiceSample
// means "clear this field" (the key is deleted from the record); a field
// absent from the body keeps its saved value. The editor UI relies on this
// distinction — see sanitizeKitPatch/mergeKitPatch in server/store.js.

import storeMod from '../../server/store.js';
import { json, readJson } from '../_lib/http.js';

const { getBrandKit, putBrandKit, sanitizeKitPatch, mergeKitPatch } = storeMod;

export async function onRequestGet({ params, env }) {
  return json({ kit: await getBrandKit(env.HISTORY, params.slug) });
}

export async function onRequestPost({ request, params, env }) {
  const body = await readJson(request);
  const patch = sanitizeKitPatch(body);
  if (!patch) return json({ error: 'no valid kit fields in body' }, 400);
  const slug = params.slug;
  // First save for a brand still needs a name — fall back to the slug rather
  // than refuse, so "type a colour, hit save" works on a fresh kit.
  const existing = (await getBrandKit(env.HISTORY, slug)) || { slug, name: patch.name || slug };
  const record = mergeKitPatch(existing, patch);
  record.slug = slug; // the KV key is the identity — never patchable
  record.source = 'manual';
  record.updatedAt = new Date().toISOString();
  record.updatedBy = typeof body.author === 'string' && body.author.trim()
    ? body.author.replace(/[<>]/g, '').trim().slice(0, 60)
    : null;
  // putBrandKit re-validates (slug shape, primary-if-present) and never
  // throws — false covers both a rejected record and a failed KV write.
  if (!(await putBrandKit(env.HISTORY, record))) {
    return json({ error: 'kit failed validation or could not be saved' }, 400);
  }
  return json({ ok: true, kit: record });
}
