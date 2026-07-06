# AMP Genie

Paste a store URL — or nothing at all — and get back a **validated, interactive
AMP email**. The genie reads a brand's voice, palette and products from the web,
resolves every image to a working HTTPS asset, builds a production-grade
AMP4EMAIL document, and proves it is valid against the **real
`amphtml-validator`** before it ever reaches you.

Two rules are absolute:

1. **The Playground is the holy grail.** Every email is validated with the
   official AMP4EMAIL validator and must report **zero errors** before it is
   shown as done. The regex pre-check is only a fast first pass — the real
   validator is the gate.
2. **Always a complete email.** Whether you supply all your assets, a few, or
   *none*, the genie fills the gaps and returns a complete, branded, interactive,
   valid email. Zero input is a first-class, tested path.

---

## Quick start

```bash
npm install
npm start                 # serves the UI + API on http://localhost:4000
```

Open <http://localhost:4000>, optionally paste a store URL or brand name, pick a
use case (or leave it on **Auto**), and **Rub the lAMP**. You get:

- a **Live preview** (a generic AMP interpreter runs the actual `amp-bind`
  state machine, so interactions work in the preview);
- the **AMP code** (editable, with a one-click **Re-validate**);
- a **Validation** tab showing the real validator verdict and any errors;
- **Copy / Download / Send to inbox** — all operating on the code currently in
  the editor (your edits included).

---

## How it works

### Asset resolution (the waterfall)

For every asset slot an email needs (logo, product images, hero), the genie
resolves in strict priority order and **always ends on a working HTTPS asset**:

| Tier | Source | Notes |
|---|---|---|
| 1. **user** | what you upload / paste | uploads & non-HTTPS refs are rehosted to HTTPS |
| 2. **brand-site** | logo / products from the brand's own pages | only if reachable over HTTPS |
| 3. **open web** | favicon service (logos), permissively-licensed stock (products) | recorded as the source |
| 4. **generated** | branded, palette-aware placeholder | never a grey box; always reachable |

Nothing can fail: a blocked fetch or 404 falls through to the next tier, and the
bottom tier is always reachable. **Provenance is recorded per asset** and shown
in the UI (which tier, which source, and whether it was rehosted to HTTPS).

> **HTTPS everywhere.** AMP requires HTTPS image sources. Uploads, `data:` URIs
> and `http://` refs are downloaded and re-served from `PUBLIC_ASSET_BASE`
> (see [Sending to a real inbox](#sending-to-a-real-inbox)).

### Production AMP structure

The builder emits a production AMP4EMAIL document: `<!doctype html>` →
`<html amp4email data-css-strict>` with `<meta charset>` first, then `amp-bind`/`amp-form`/
`amp-carousel`/etc. component scripts, the `amp4email-boilerplate`, and a baked,
palette-aware `<style amp-custom>`. Layout is a table-based 600px column;
interactions are absolutely-positioned tap zones (`role="button"`,
`on="tap:AMP.setState(...)"`) over base images, driving `amp-bind` state
machines. All non-ASCII is encoded as HTML entities (e.g. `₹` → `&#8377;`).

> **Note on the CSP `<meta>`.** The real validator **rejects**
> `<meta http-equiv="Content-Security-Policy">` in AMP4EMAIL
> (`The attribute 'http-equiv' may not appear in tag 'meta'`), so it is omitted.
> Per the spec, we adjust to whatever the validator actually accepts.

### Module library

26 production modules across five groups, auto-selected by vertical when you
leave the use case on **Auto**:

- **Gamification** — Spin the Wheel, Scratch Card, Tap to Reveal, Slot Machine,
  Flip Card, Multi-frame Tap Game …
- **Commerce** — Add to Cart, Cart, Product Carousel, Search & Filter, Wishlist …
- **Feedback** — Quiz & Match, This-or-That Poll, NPS/Star Rating, Survey, Yes/No …
- **Calculators** — SIP, EMI, Points (lookup tables baked at build time — no
  runtime `Math.pow`).
- **Content / Utility** — Accordion, Tabs, Pincode/Store search, OTP, Lead-gen,
  Multi-lingual toggle, Appointment booking …

---

## Testing

```bash
npm test              # unit tests (encoding + validator)             -> 7/7
npm run matrix        # every prod module × {full, partial, zero}     -> 78/78 valid
npm run matrix:stage1 # Stage 1 generator regression                  -> 42/42 valid
npm run test:e2e      # Playwright UI e2e (real browser + validator)  -> 4/4
```

- **Unit** (`node --test`): currency/entity encoding round-trips and the
  validator wrapper.
- **Matrix** (`tests/prod-matrix.js`): builds all 26 modules against three asset
  modes (all user assets, partial/brand-site, and **zero input**) and validates
  every one — the acceptance grid.
- **e2e** (`tests/e2e.test.js`, Playwright): drives the actual UI — zero-input
  build, explicit module + interactivity, lifecycle arc, and the edit →
  re-validate → reset loop — each asserting the **real** validator verdict.
  Run `npx playwright install chromium` once before the first e2e run.

---

## Sending to a real inbox

`Send to your inbox` is gated: the genie **re-validates and refuses to send
invalid AMP**, and sends a proper multipart message — `text/plain`, an
`text/html` static fallback, and the **`text/x-amp-html`** AMP part (added by
nodemailer's `amp:` field).

Sending interactive AMP that *renders* in Gmail/Yahoo/Mail.ru has provider
prerequisites that are external to this app — getting a message delivered is not
the same as getting the AMP part to render. You must:

1. **Register as an AMP sender with each provider.** For Gmail, complete
   [Google's AMP-for-Email sender registration](https://developers.google.com/gmail/ampemail/register)
   from a real, consistently-used sending domain. Until you are allow-listed,
   the AMP part is ignored and the HTML fallback is shown.
2. **Authenticate the domain.** Valid **SPF**, **DKIM** *and* **DMARC** are
   required, and the `From:` domain must align. Unauthenticated mail will not
   render AMP.
3. **Use a stable, allow-listed `From:` sender.** It must match what you
   registered. Set it via `SMTP_FROM`.
4. **Pass the self-send / dynamic-email test.** Providers require that you can
   send the AMP email **to yourself** and that it validates and renders before
   they enable it for other recipients.
5. **Honour freshness rules.** Providers cap AMP email age (Gmail: ~30 days) and
   strip AMP outside that window — the HTML fallback then applies.

### SMTP configuration (env vars only — never in client code)

| Var | Required | Purpose |
|---|---|---|
| `SMTP_HOST` | yes | SMTP server hostname |
| `SMTP_PORT` | no (587) | `465` ⇒ implicit TLS, otherwise STARTTLS |
| `SMTP_USER` | yes | SMTP username |
| `SMTP_PASS` | yes | SMTP password / app password |
| `SMTP_FROM` | no | `From:` address (defaults to `SMTP_USER`); must be your allow-listed sender |

```bash
SMTP_HOST=smtp.example.com SMTP_PORT=587 \
SMTP_USER=genie@yourdomain.com SMTP_PASS='********' \
SMTP_FROM='AMP Genie <genie@yourdomain.com>' \
npm start
```

If SMTP is unset, dispatch returns a clear "SMTP not configured" message instead
of failing silently — the rest of the app (build, validate, copy, download)
works without it.

### `PUBLIC_ASSET_BASE` — required for real sends

Rehosted assets (uploads, `data:`/`http:` images) are written to `web/assets/`
and served from `PUBLIC_ASSET_BASE`. Locally this defaults to
`http://localhost:4000`, which is **not** reachable by a mail client. For a real
send, point it at a **public HTTPS origin** (an S3/CDN bucket — mirroring AJIO's
`s3.ap-south-1` pattern):

```bash
PUBLIC_ASSET_BASE=https://assets.yourdomain.com npm start
```

---

## Configuration reference

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port; CORS is locked to this origin |
| `PUBLIC_ASSET_BASE` | `http://localhost:$PORT` | public HTTPS base for rehosted assets |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | dispatch (see above) |

---

## Honest caveats

- **Logos usually resolve via the web (favicon) tier.** Brand-site logo capture
  depends on the page exposing an `og:image`/recognisable logo; otherwise the
  favicon service or a generated mark is used. Provenance always shows which.
- **Stock/open-web images are illustrative.** They are keyworded and
  permissively-licensed, but for production you should supply real product
  imagery (tier 1) — it always wins.
- **Local rehost is for development.** Real inbox sends require
  `PUBLIC_ASSET_BASE` on a public HTTPS bucket.
- **Inbox rendering is an external gate.** This repo proves *validity and
  build*; provider allow-listing (above) is what makes AMP *render* in the inbox.
