// POST /brand — resolve a brand's primary colour + palette + vertical from a
// name (or hex override). Reuses the Node brand resolver (fetch-based, already
// Worker-safe).

import brandMod from '../server/brand.js';
import generateMod from '../server/generate.js';
import { applyEnv } from './_lib/env.js';
import { json, readJson } from './_lib/http.js';

const { resolveBrandColor, libVertical } = brandMod;
const { derivePalette } = generateMod;

export async function onRequestPost({ request, env }) {
  applyEnv(env);
  try {
    const { brandName, hexOverride } = await readJson(request);
    const resolved = await resolveBrandColor({ brandName, hexOverride });
    const palette = derivePalette(resolved.primary);
    const vertical = libVertical(brandName);
    return json({ ...resolved, palette, vertical });
  } catch (e) {
    return json({ error: e.message }, 400);
  }
}
