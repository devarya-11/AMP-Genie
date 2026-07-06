'use strict';

// Phase 1.3 — real deliverability inspection.
//
// AMP-in-email has a hard gate that is INDEPENDENT of markup validity: Gmail
// (and Yahoo/Mail.ru) only render the interactive part for a sender that is
// registered AND passes SPF + DKIM + DMARC. A perfectly valid AMP email from an
// unregistered/unauthenticated sender silently falls back to HTML. So before a
// real campaign we resolve the live DNS for the sending domain and report the
// three authentication records honestly, then explain exactly what Google needs.
//
// This makes genuine DNS queries (dns/promises resolveTxt), so it is a live
// probe — never spoofed. Each check returns pass / warn / fail / unknown with
// the actual record text, so the verdict is auditable.

const dns = require('dns').promises;
const { Resolver } = require('dns').promises;

// A resolver pinned to public DNS (Cloudflare, then Google) used as a fallback.
// The system resolver can time out on a large root-domain TXT set (many records
// overflow UDP and its TCP fallback is unreliable on some networks), whereas
// 1.1.1.1/8.8.8.8 answer reliably. We keep the system resolver as PRIMARY so
// locked-down networks that block public DNS still work, and only fall back here.
let _publicResolver = null;
function publicResolver() {
  if (_publicResolver) return _publicResolver;
  _publicResolver = new Resolver();
  _publicResolver.setServers(['1.1.1.1', '8.8.8.8']);
  return _publicResolver;
}

// ---- domain extraction ------------------------------------------------------
function domainOf(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (s.includes('@')) s = s.split('@').pop();            // email -> domain
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.split(':')[0];                                     // drop any port
  return s.trim().toLowerCase();
}

// Common DKIM selectors across the major ESPs. SES/others use random selectors
// we cannot guess; a miss here means "not found at the usual names", not "no
// DKIM" — the verdict text says exactly that.
const DKIM_SELECTORS = [
  'google', 'default', 'selector1', 'selector2', 'k1', 'k2', 'k3',
  'mail', 'dkim', 's1', 's2', 'smtp', 'pm', 'mandrill', 'mxvault',
  'sig1', 'litesrv', 'zoho', 'turbo-smtp', 'mte1', 'fm1', 'fm2', 'fm3',
];

// A root-domain TXT set can be large enough to time out over UDP (forcing a TCP
// retry), and public resolvers occasionally return transient SERVFAIL/TIMEOUT —
// especially when several lookups fire in parallel. ENOTFOUND/ENODATA are
// authoritative "no record"; everything else is transient. On a transient error
// we retry with the system resolver once, then fall back to public DNS, which
// answers large TXT sets reliably where the system resolver may not.
const TRANSIENT = new Set(['ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ECONNREFUSED', 'EAI_AGAIN']);
const flat = (recs) => recs.map((chunks) => chunks.join('')); // join split TXT chunks

async function resolveTxtFlat(name) {
  // 1) system resolver, with one retry for a transient blip
  for (let i = 0; i < 2; i++) {
    try { return flat(await dns.resolveTxt(name)); }
    catch (e) {
      if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) return [];
      if (!e || !TRANSIENT.has(e.code)) throw e;
      if (i === 0) await new Promise((r) => setTimeout(r, 200));
    }
  }
  // 2) fall back to public DNS (handles large/UDP-overflowing TXT sets)
  try { return flat(await publicResolver().resolveTxt(name)); }
  catch (e) {
    if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) return [];
    throw e;
  }
}

// ---- SPF --------------------------------------------------------------------
async function checkSpf(domain) {
  try {
    const txt = await resolveTxtFlat(domain);
    const spf = txt.find((r) => /^v=spf1\b/i.test(r));
    if (!spf) return { id: 'spf', label: 'SPF', status: 'fail', record: null, detail: 'No v=spf1 TXT record found at the domain root. Receivers cannot verify which servers may send for you.' };
    const all = (spf.match(/[~\-+?]all\b/i) || [])[0] || '';
    const strict = /-all/i.test(all);
    const soft = /~all/i.test(all);
    const status = strict ? 'pass' : (soft ? 'warn' : 'warn');
    const detail = strict
      ? 'SPF present with a hard fail (-all): unauthorised servers are rejected.'
      : soft
        ? 'SPF present with a soft fail (~all): unknown senders are accepted but flagged. Fine for AMP, tighten to -all when ready.'
        : 'SPF present but with a permissive/neutral qualifier. Consider ~all or -all.';
    return { id: 'spf', label: 'SPF', status, record: spf, detail };
  } catch (e) {
    return { id: 'spf', label: 'SPF', status: 'unknown', record: null, detail: 'DNS lookup failed: ' + e.message };
  }
}

// ---- DMARC ------------------------------------------------------------------
async function checkDmarc(domain) {
  try {
    const txt = await resolveTxtFlat('_dmarc.' + domain);
    const dmarc = txt.find((r) => /^v=DMARC1\b/i.test(r));
    if (!dmarc) return { id: 'dmarc', label: 'DMARC', status: 'fail', record: null, detail: 'No _dmarc TXT record. Gmail requires a DMARC policy for AMP senders.' };
    const p = (dmarc.match(/\bp=(none|quarantine|reject)\b/i) || [])[1] || '';
    const status = /quarantine|reject/i.test(p) ? 'pass' : 'warn';
    const detail = /reject/i.test(p)
      ? 'DMARC present with p=reject — strongest policy, ideal for AMP.'
      : /quarantine/i.test(p)
        ? 'DMARC present with p=quarantine — accepted for AMP.'
        : 'DMARC present but p=none (monitor only). Move to quarantine or reject before registering for AMP.';
    return { id: 'dmarc', label: 'DMARC', status, record: dmarc, detail };
  } catch (e) {
    return { id: 'dmarc', label: 'DMARC', status: 'unknown', record: null, detail: 'DNS lookup failed: ' + e.message };
  }
}

// ---- DKIM -------------------------------------------------------------------
async function checkDkim(domain) {
  const found = [];
  try {
    const results = await Promise.all(DKIM_SELECTORS.map(async (sel) => {
      const txt = await resolveTxtFlat(`${sel}._domainkey.${domain}`).catch(() => []);
      const rec = txt.find((r) => /(v=DKIM1|k=rsa|p=[A-Za-z0-9+/])/i.test(r));
      return rec ? { sel, rec } : null;
    }));
    for (const r of results) if (r) found.push(r);
    if (!found.length) {
      return { id: 'dkim', label: 'DKIM', status: 'warn', record: null,
        detail: 'No DKIM key found at the common selectors (' + DKIM_SELECTORS.slice(0, 6).join(', ') + ', …). Your ESP may use a custom selector — confirm a DKIM signature is applied on send.' };
    }
    const sels = found.map((f) => f.sel).join(', ');
    return { id: 'dkim', label: 'DKIM', status: 'pass', record: found[0].rec,
      detail: `DKIM public key published at selector(s): ${sels}. Messages can be cryptographically signed.` };
  } catch (e) {
    return { id: 'dkim', label: 'DKIM', status: 'unknown', record: null, detail: 'DNS lookup failed: ' + e.message };
  }
}

// ---- the Google AMP sender-registration explainer (static guidance) ---------
function registrationGuidance(domain, auth) {
  const authReady = auth.every((c) => c.status === 'pass');
  const authPartial = auth.some((c) => c.status === 'pass');
  return {
    // The decisive, easily-missed fact.
    gate: 'Markup validity is necessary but NOT sufficient. Gmail renders the interactive AMP part only for a sender that is registered with Google AND passes SPF + DKIM + DMARC. An unregistered sender always falls back to your HTML email — which is exactly why the static fallback has to be good.',
    selfSendTrick: 'You do NOT need registration to test: send the AMP email to YOURSELF (same address in From and To) from an SMTP server that authenticates as that account. Gmail renders AMP for self-addressed mail. Use the “Send a test to myself” button — if the interactive version shows up there, your markup and auth are working.',
    prerequisites: [
      { ok: auth.find((c) => c.id === 'spf')?.status === 'pass', text: 'SPF passes for the sending domain' },
      { ok: auth.find((c) => c.id === 'dkim')?.status === 'pass', text: 'DKIM signs every message' },
      { ok: auth.find((c) => c.id === 'dmarc')?.status === 'pass', text: 'DMARC policy is quarantine or reject' },
      { ok: null, text: 'Consistent From: address with a low spam-complaint history' },
      { ok: null, text: 'Every AMP email also carries a valid text/html fallback (this tool builds one for you)' },
      { ok: null, text: 'One-click unsubscribe (List-Unsubscribe) on bulk mail' },
    ],
    steps: [
      'Send a real, validator-passing AMP email from your production domain to ampforemail.whitelisting@gmail.com.',
      'Confirm that message arrives at that address with the AMP part intact (it must pass auth on the way in).',
      'Submit the registration form at developers.google.com/gmail/ampemail/register-for-amp from the SAME sending domain.',
      'Google reviews sender reputation + authentication (typically ~5 business days) and enables AMP rendering for your domain.',
    ],
    registerUrl: 'https://developers.google.com/gmail/ampemail/register-for-amp',
    whitelistingAddress: 'ampforemail.whitelisting@gmail.com',
    readiness: authReady ? 'ready' : (authPartial ? 'partial' : 'blocked'),
    readinessText: authReady
      ? `${domain} passes SPF, DKIM and DMARC — authentication prerequisites for AMP registration are met. Complete the Google form to enable interactive rendering for other recipients.`
      : authPartial
        ? `${domain} passes some but not all of SPF/DKIM/DMARC. Fix the failing record(s) below before registering, or interactive rendering will be denied even with valid markup.`
        : `${domain} is missing the core authentication records. Set up SPF, DKIM and DMARC first — registration will be rejected without them.`,
  };
}

// ---- public entry -----------------------------------------------------------
async function checkDeliverability(input) {
  const domain = domainOf(input);
  if (!domain || !domain.includes('.')) {
    return { ok: false, error: 'Enter a sending domain or email address (e.g. mail.yourbrand.com) to check authentication.' };
  }
  const [spf, dkim, dmarc] = await Promise.all([
    checkSpf(domain), checkDkim(domain), checkDmarc(domain),
  ]);
  const auth = [spf, dkim, dmarc];
  const guidance = registrationGuidance(domain, auth);
  return { ok: true, domain, checks: auth, guidance };
}

module.exports = { checkDeliverability, domainOf };
