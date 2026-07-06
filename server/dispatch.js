'use strict';

// Real AMP send path. Sends a multipart/alternative message with text/plain +
// text/html (the quality on-brand fallback) + text/x-amp-html (the interactive
// part). Validates before sending and refuses to send invalid AMP. SMTP
// credentials come from env, never the client.
//
// The html + text fallbacks are produced at /build time by server/fallback.js
// from the SAME GenerationContext as the AMP, so the three MIME parts can never
// drift. The client forwards those exact bodies here; if (defensively) none is
// supplied, we degrade to a minimal stub rather than send an empty part.

const nodemailer = require('nodemailer');
const { validate } = require('./validator');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null; // not configured
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

// Last-resort fallback ONLY if the client somehow sends no quality html part.
// In normal operation the real on-brand fallback from server/fallback.js is
// used, so a recipient on Outlook still sees a proper branded email.
function stubFallback(subject) {
  const title = String(subject || 'A message for you').replace(/[<>]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;padding:24px;color:#1d1d2b">
<h2>${title}</h2>
<p>This email contains an interactive AMP experience. Open it in a supported client (Gmail) to interact, or visit our site.</p>
</body></html>`;
}

async function dispatch({ to, subject, ampHtml, fromName, text, html }) {
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, error: 'A valid recipient email is required.' };
  }
  if (!ampHtml) return { ok: false, error: 'No AMP HTML to send.' };

  // Gate on the real validator — never send invalid AMP.
  const v = await validate(ampHtml);
  if (!v.pass) {
    return { ok: false, error: 'AMP failed validation; refusing to send.', validation: v };
  }

  const tx = getTransporter();
  if (!tx) {
    return {
      ok: false,
      error: 'SMTP not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS env vars. See README §Dispatch.',
      validation: v,
    };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const subj = subject || 'Your interactive email from AMP Genie';
  try {
    const info = await tx.sendMail({
      from: fromName ? `${fromName} <${from}>` : from,
      to,
      subject: subj,
      text: text || 'Open this email in Gmail to view the interactive AMP content.',
      html: html || stubFallback(subj), // real on-brand fallback from the client
      amp: ampHtml, // nodemailer adds the text/x-amp-html MIME part
    });
    return { ok: true, messageId: info.messageId, validation: v };
  } catch (e) {
    return { ok: false, error: 'SMTP send failed: ' + e.message, validation: v };
  }
}

module.exports = { dispatch, getTransporter };
