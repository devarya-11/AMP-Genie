# Cloudflare setup — AMP Genie

The app is a Cloudflare Pages project: static UI from `web/`, backend as Pages
Functions from `functions/`, persistence in the KV namespace bound as
`HISTORY` (builds, slates, brand kits and the recent-builds list all share it,
key-prefixed). Everything below is dashboard/one-time work — the code needs no
change for any of it.

## 1. Deploy from `main` (one-time)

`main` is now the canonical branch (the `cloudflare-pages-port` branch has been
merged into it, and all new work lands on `main` directly). Point the Pages
project's **production branch** at `main`:

> Workers & Pages → amp-genie → Settings → Builds & deployments →
> Production branch → `main`

After that, every push to `main` auto-deploys. Nothing else changes — the KV
binding and `wrangler.toml` carry over as-is.

## 2. Optional env (set only what you have)

Worker secrets / Pages environment variables — same "configure the key you
have" pattern everywhere:

| Var | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | Claude for brief-driven copy |
| `GEMINI_API_KEY` / `GROQ_API_KEY` | Free-tier LLM copy providers (self-cool-down on quota) |
| `SENDGRID_API_KEY` + `EMAIL_FROM` | Send-to-inbox via SendGrid (AMP MIME part supported) |
| `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` + `EMAIL_FROM` | Send-to-inbox via Mailgun |

With none set, generation still works fully (template copy, no email send).

## 3. Lock it to the team (recommended before wide sharing)

Zero-trust SSO without writing any auth code:

> Zero Trust → Access → Applications → Add an application → Self-hosted →
> domain `amp-genie.pages.dev` → policy: Allow → Emails ending in your
> Google-Workspace domain.

Share pages (`/b/…`, `/s/…`) sit behind the same policy. If you want client-
visible demo links later, add a second Access application scoped to `/b/*` and
`/s/*` with a Service Auth or Bypass policy — decide when it comes up.

## 4. Gmail AMP rendering (ops, not code)

Sending delivers; **rendering** the AMP part in Gmail needs (self-send works
without any of this — Gmail renders AMP sent to the same account it came from):

1. SPF + DKIM + DMARC aligned on the `From:` domain (SendGrid/Mailgun docs).
2. Register the sender with Google: <https://developers.google.com/gmail/ampemail/register>.
