// Worker-native replacement for the Node nodemailer/SMTP dispatch
// (server/dispatch.js). Sends the interactive AMP part alongside plain-text and
// HTML fallbacks over an HTTP email API — SMTP sockets aren't available on the
// Workers runtime.
//
// AMP-in-email requires a provider that accepts a `text/x-amp-html` part; most
// HTTP email APIs (Resend, Postmark) don't. The two that do are SendGrid and
// Mailgun, so this supports both and auto-selects by which secret is present —
// same "configure the key you have" pattern as the LLM providers. Credentials
// come from env (Worker secrets), never the client.
//
// Validation gates the send here (never send invalid AMP), keeping that
// guarantee in one place exactly as the Node version did.

import { validate } from './validator.js';

function stubFallback(subject) {
  const title = String(subject || 'A message for you').replace(/[<>]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;padding:24px;color:#1d1d2b">
<h2>${title}</h2>
<p>This email contains an interactive AMP experience. Open it in a supported client (Gmail) to interact, or visit our site.</p>
</body></html>`;
}

// SendGrid v3: content parts MUST be ordered text/plain -> text/x-amp-html ->
// text/html. 202 = accepted; the id comes back in the X-Message-Id header.
async function sendViaSendGrid({ apiKey, from, fromName, to, subject, text, html, ampHtml }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: fromName ? { email: from, name: fromName } : { email: from },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/x-amp-html', value: ampHtml },
        { type: 'text/html', value: html },
      ],
    }),
  });
  if (res.status === 202) {
    return { ok: true, messageId: res.headers.get('x-message-id') || null };
  }
  const body = await res.text().catch(() => '');
  return { ok: false, error: `SendGrid send failed (${res.status}): ${body.slice(0, 300)}` };
}

// Mailgun: application/x-www-form-urlencoded, HTTP Basic (user "api"), the AMP
// part goes in the `amp-html` field. 200 = accepted; id in JSON `.id`.
async function sendViaMailgun({ apiKey, domain, from, fromName, to, subject, text, html, ampHtml }) {
  const form = new URLSearchParams();
  form.set('from', fromName ? `${fromName} <${from}>` : from);
  form.set('to', to);
  form.set('subject', subject);
  form.set('text', text);
  form.set('html', html);
  form.set('amp-html', ampHtml);
  const res = await fetch(`https://api.mailgun.net/v3/${encodeURIComponent(domain)}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`api:${apiKey}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: true, messageId: data.id || null };
  }
  const body = await res.text().catch(() => '');
  return { ok: false, error: `Mailgun send failed (${res.status}): ${body.slice(0, 300)}` };
}

// env: the Pages Function's context.env (Worker secrets/vars).
export async function dispatch({ to, subject, ampHtml, fromName, text, html }, env = {}) {
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, error: 'A valid recipient email is required.' };
  }
  if (!ampHtml) return { ok: false, error: 'No AMP HTML to send.' };

  // Gate on the real validator — never send invalid AMP.
  const v = await validate(ampHtml);
  if (!v.pass) {
    return { ok: false, error: 'AMP failed validation; refusing to send.', validation: v };
  }

  const subj = subject || 'Your interactive email from AMP Genie';
  const parts = {
    from: env.EMAIL_FROM,
    fromName,
    to,
    subject: subj,
    text: text || 'Open this email in Gmail to view the interactive AMP content.',
    html: html || stubFallback(subj),
    ampHtml,
  };

  if (!parts.from) {
    return {
      ok: false,
      error: 'No sender configured. Set the EMAIL_FROM secret to a verified sender address.',
      validation: v,
    };
  }

  try {
    let result;
    if (env.SENDGRID_API_KEY) {
      result = await sendViaSendGrid({ apiKey: env.SENDGRID_API_KEY, ...parts });
    } else if (env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN) {
      result = await sendViaMailgun({ apiKey: env.MAILGUN_API_KEY, domain: env.MAILGUN_DOMAIN, ...parts });
    } else {
      return {
        ok: false,
        error: 'Email not configured. Set SENDGRID_API_KEY, or MAILGUN_API_KEY + MAILGUN_DOMAIN (plus EMAIL_FROM), as Worker secrets. See README §Dispatch.',
        validation: v,
      };
    }
    return { ...result, validation: v };
  } catch (e) {
    return { ok: false, error: 'Email send failed: ' + (e && e.message), validation: v };
  }
}
