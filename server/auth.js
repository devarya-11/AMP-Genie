'use strict';

// Team password gate — Genie 2.0 Phase 0.
//
// ONE shared password for the whole team (env TEAM_PASSWORD): whoever knows
// it gets a long-lived session cookie; there are no per-user accounts. All
// gate DECISIONS live here so they are unit-testable in plain Node — the
// Pages middleware (functions/_middleware.js) and any future Express hook
// only translate a decision object into an HTTP response.
//
// Runtime-agnostic on purpose: this module must bundle for Cloudflare
// Workers via esbuild, so the sha256 comes from Web Crypto (crypto.subtle —
// a global in Workers AND in Node 19+, incl. the Node 24 this repo runs on),
// NOT from node:crypto's createHash, which would drag a Node-only builtin
// into the Workers bundle. That makes sessionTokenFor async; a sha256 of a
// short string is microseconds either way and the result is memoized.
//
// >>> LOUD DEV DEFAULT: when TEAM_PASSWORD is UNSET the gate is FULLY OPEN —
// every request passes untouched. That keeps local `npm start`, wrangler dev
// and the existing e2e suite working with zero setup, and means forgetting
// the secret on a fresh deployment silently publishes the app. Set
// TEAM_PASSWORD as a Pages secret before sharing the URL. <<<

const SESSION_COOKIE = 'genie_session';
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 2592000 — a month of team use
const PASSWORD_MAX = 200; // cap untrusted login bodies; nothing real is longer

// sha256 hex of 'genie:' + password. The 'genie:' prefix domain-separates the
// token from a bare sha256(password) rainbow-table lookup; the cookie stores
// this digest, never the password itself.
async function sessionTokenFor(password) {
  const data = new TextEncoder().encode('genie:' + String(password == null ? '' : password));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

// Tiny memo so the per-request middleware doesn't re-hash the same password
// on every static asset. Capped: a hostile caller can't grow it (only the
// CONFIGURED password ever reaches tokenFor — supplied passwords are hashed
// via sessionTokenFor directly).
const tokenMemo = new Map(); // password -> token
async function tokenFor(password) {
  if (tokenMemo.has(password)) return tokenMemo.get(password);
  const token = await sessionTokenFor(password);
  if (tokenMemo.size >= 8) tokenMemo.clear();
  tokenMemo.set(password, token);
  return token;
}

// Minimal cookie-header parse — first 'name=value' pair wins. No decoding:
// the only value we ever store is a hex digest.
function readCookie(cookieHeader, name) {
  const header = typeof cookieHeader === 'string' ? cookieHeader : '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// True when the request's genie_session cookie equals the expected token.
// Plain === is fine here: the compared value is a sha256 digest, so a timing
// probe learns nothing useful about the password behind it.
function isAuthed(cookieHeader, expectedToken) {
  if (!expectedToken || typeof expectedToken !== 'string') return false;
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  return !!token && token === expectedToken;
}

// The Set-Cookie header value for a successful login. HttpOnly (no JS reads),
// SameSite=Lax (survives top-level navigation, blocks cross-site POSTs),
// Path=/ (one cookie for app + API). No Secure flag: wrangler dev and the
// Express dev server run on plain http, and pages.dev is https anyway.
function loginResponseHeaders(token) {
  return SESSION_COOKIE + '=' + String(token || '')
    + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_MAX_AGE_S;
}

// EXACT public allowlist — everything not listed here needs the cookie.
//   /login.html         the gate page itself (POST /login is handled by
//                       gateDecision separately, it is not a "path")
//   /favicon.ico        browsers fetch it before any login happens
//   /b/* and /s/*       client share pages — the whole point is sending them
//                       to people without the password
//   /build/*            raw AMP download the share pages link to
//   /assets/*           image bytes referenced INSIDE generated emails; mail
//                       clients fetch these with no cookie at all
// Notably NOT public: '/', the app shell (app.js/style.css/index.html) and
// every API route.
const PUBLIC_EXACT = ['/login.html', '/favicon.ico'];
const PUBLIC_PREFIXES = ['/b/', '/s/', '/build/', '/assets/'];

function isPublicPath(pathname) {
  const p = typeof pathname === 'string' ? pathname : '';
  if (PUBLIC_EXACT.includes(p)) return true;
  return PUBLIC_PREFIXES.some((prefix) => p.startsWith(prefix));
}

// The whole gate as one pure(ish) async decision. Input is plain strings so
// it needs no Request object and tests can drive every branch offline:
//   { method, pathname, cookieHeader, acceptHeader, password,
//     suppliedPassword }   (suppliedPassword only for POST /login)
// Returns one of:
//   { action: 'open' }                         pass the request through
//   { action: 'login-ok', setCookie }          POST /login succeeded
//                                              (setCookie null when the gate
//                                              is open — nothing to grant)
//   { action: 'login-fail' }                   POST /login wrong password
//   { action: 'redirect', location }           browser page → login screen
//   { action: 'deny' }                         API-ish request → 401 JSON
// Never throws: every input is coerced before use.
async function gateDecision(args = {}) {
  const a = (args && typeof args === 'object') ? args : {};
  const method = String(a.method || 'GET').toUpperCase();
  const pathname = typeof a.pathname === 'string' ? a.pathname : '/';
  const password = typeof a.password === 'string' ? a.password : '';

  // POST /login is answered by the gate itself (there is no functions/login
  // route behind it). With the gate open it still answers ok:true so the
  // login page, if someone lands on it anyway, just redirects home.
  if (method === 'POST' && pathname === '/login') {
    if (!password) return { action: 'login-ok', setCookie: null };
    const supplied = typeof a.suppliedPassword === 'string'
      ? a.suppliedPassword.slice(0, PASSWORD_MAX) : '';
    // Hash both sides and compare digests — reuses the token we hand out and
    // roughly evens out the comparison timing versus raw string equality.
    if (supplied && await sessionTokenFor(supplied) === await tokenFor(password)) {
      return { action: 'login-ok', setCookie: loginResponseHeaders(await tokenFor(password)) };
    }
    return { action: 'login-fail' };
  }

  if (!password) return { action: 'open' }; // TEAM_PASSWORD unset — gate open
  if (isPublicPath(pathname)) return { action: 'open' };
  if (isAuthed(a.cookieHeader, await tokenFor(password))) return { action: 'open' };

  // Unauthenticated. A browser asking for a page (GET + Accept: text/html)
  // gets sent to the login screen; everything API-ish (POST/PUT/…, JSON
  // Accept, or a bare */* fetch) gets an honest 401 instead of an HTML
  // redirect its caller would choke on.
  const accept = typeof a.acceptHeader === 'string' ? a.acceptHeader : '';
  if (method === 'GET' && accept.includes('text/html')) {
    return { action: 'redirect', location: '/login.html' };
  }
  return { action: 'deny' };
}

module.exports = {
  sessionTokenFor, isAuthed, loginResponseHeaders, isPublicPath, gateDecision,
  SESSION_COOKIE,
};
