// GET /api/meta — dropdown metadata for the UI. Pure reads from the reused
// generate/content modules; no env or bindings needed.

import generateMod from '../../server/generate.js';
import contentMod from '../../server/content.js';
import { json } from '../_lib/http.js';

const { MODULE_IDS, MODULES, VERTICALS, CURRENCIES } = generateMod;
const { TONES } = contentMod;

export function onRequestGet() {
  return json({
    verticals: VERTICALS,
    tones: Object.keys(TONES),
    currencies: Object.keys(CURRENCIES),
    modules: MODULE_IDS.map((id) => ({ id, name: MODULES[id].name, kind: MODULES[id].kind })),
  });
}
