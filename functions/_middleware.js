// Root Pages middleware — the team password gate. A root-level _middleware.js
// runs on EVERY request, static assets included, which is exactly what a
// login wall needs (the app shell is a static index.html).
//
// Thin shell by design: all decisions (public-path allowlist, cookie check,
// password compare, redirect-vs-401 shape) live in server/auth.js where they
// are unit-tested offline; this file only maps a decision object onto
// Responses. When env.TEAM_PASSWORD is unset auth.js declares the gate OPEN
// and every request falls straight through to next() — the dev default.

import authMod from '../server/auth.js';
import { applyEnv } from './_lib/env.js';
import { json, readJson } from './_lib/http.js';

const { gateDecision } = authMod;

export async function onRequest(context) {
  const { request, env, next } = context;
  applyEnv(env); // secrets → process.env for the downstream server modules
  const url = new URL(request.url);

  // Only the login POST carries a body the gate cares about; read it here so
  // gateDecision stays a pure function of strings.
  let suppliedPassword;
  if (request.method === 'POST' && url.pathname === '/login') {
    const body = await readJson(request);
    suppliedPassword = typeof body.password === 'string' ? body.password : '';
  }

  const decision = await gateDecision({
    method: request.method,
    pathname: url.pathname,
    cookieHeader: request.headers.get('cookie'),
    acceptHeader: request.headers.get('accept'),
    password: typeof env.TEAM_PASSWORD === 'string' ? env.TEAM_PASSWORD : '',
    suppliedPassword,
  });

  if (decision.action === 'open') return next();

  if (decision.action === 'login-ok') {
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (decision.setCookie) headers['set-cookie'] = decision.setCookie;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }
  if (decision.action === 'login-fail') {
    return json({ ok: false, error: 'Wrong password' }, 401);
  }
  if (decision.action === 'redirect') {
    return Response.redirect(new URL(decision.location, request.url).toString(), 302);
  }
  // 'deny' (and any future unknown action, defensively): API-ish request
  // without a session.
  return json({ error: 'Team password required — sign in at /login.html' }, 401);
}
