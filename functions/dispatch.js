// POST /dispatch — real send-to-inbox path over an HTTP email API. Validates
// before sending and refuses invalid AMP (gate lives in email.js). Credentials
// come from Worker secrets (env), never the client.

import { dispatch } from './_lib/email.js';
import { applyEnv } from './_lib/env.js';
import { json, readJson } from './_lib/http.js';

export async function onRequestPost({ request, env }) {
  applyEnv(env);
  const body = await readJson(request);
  const result = await dispatch(body, env);
  return json(result, result.ok ? 200 : 400);
}
