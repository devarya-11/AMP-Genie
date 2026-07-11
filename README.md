# AMP Genie

Type a brand name and get back a **validated, interactive AMP4EMAIL** — a
production-grade document with a random interactive module, brand-appropriate
colours, and copy that reads as real (never Lorem Ipsum). It's built to serve
both developers (clean, editable AMP HTML) and non-technical folks (a working
demo in one click).

Two rules are absolute:

1. **The Playground is the holy grail.** Every email is checked against the
   official **`amphtml-validator`** package (AMP4EMAIL format) and must report
   **zero errors** before it's shown as done. There is no regex approximation —
   the real validator is the only gate, in the server, on every generation.
2. **The server is the single source of truth.** `server/generate.js` builds
   the AMP; the web UI never re-derives it. The code editor, the downloadable
   file, the validated file, and the dispatched file are always byte-identical.
   (The live preview is a faithful plain-JS *mirror* of the same generation
   context — not a render of the bytes — and says so on screen the moment you
   edit the code, so it can never silently show you something you didn't send.)

Since v2 the tool is organised around the **pitch**, not the single email: one
brand + one brief can produce a full **slate** of validated interactive
demos, grouped on one shareable page — see *The pitch workspace* below.

---

## Quick start

```bash
npm install
npm start                 # serves the UI + API on http://localhost:4000
```

Open <http://localhost:4000>, type a brand name, optionally pick an industry,
tone, and colour override, and **Rub the lAMP** — while the request is in
flight, the button itself turns into a small brass genie lamp with blue smoke
wisps rising off the spout (an inline animated SVG, `prefers-reduced-motion`
gets a static non-animated lamp instead), then bursts into a quick flash on
success so it never blocks the reveal. By default you get the core,
non-technical experience — a **Live preview** (a phone-framed, plain-JS mirror
of the exact `amp-bind` state machine baked into the AMP, so every tap/type
interaction works in the browser without an AMP runtime), plus **Copy /
Download / Send to inbox**, all acting on the generated AMP.

Flip the **Developer view** toggle (top-right corner, off by default,
in-memory only — it resets on reload) to reveal two more tabs for
debugging:

- the **AMP code** — editable, with a one-click **Re-validate** (runs the real
  validator on your edited text) and **Reset**;
- a **Validation** tab with the real validator's PASS/FAIL verdict and the
  full per-error list (line, column, message).

Copy/Download/Send always act on the code currently in the editor, your edits
included, whether or not Developer view is on.

Click **Surprise me again** to reroll: brand, industry, and tone stay put, but
a reroll counter advances the seed, so you get a different (but reproducible)
module/content pick each time.

### The intelligence layer (v3)

The genie researches the brand before it builds, and shows you the plan
before it generates:

1. **Research** — `POST /usecases` builds a **brand dossier**: site scrape +
   heuristics always; one schema-constrained LLM synthesis call when a
   provider key is configured. Pasted brand guidelines/notes are first-class
   input and outrank scraped guesses. Cached in KV per brand.
2. **Questionnaire** — the guided Create flow asks the few things that decide
   pitch quality (goal, audience, campaign moment, products to feature,
   must-have ideas). Every answer optional; answers fold into the same brief
   channel the engines already understand.
3. **Proposal** — the genie shows the use-cases it intends to build (title,
   business goal, module, KPI). Steer it: reroll with feedback, remove cards,
   or type your own idea and have it shaped into a use-case. Nothing is
   generated until you approve.
4. **Build** — approved use-cases become a validated slate (one email per
   idea, `contentPlan` driving copy through the same allowlist-validated
   channel as everything else).

Zero-key behaviour: ideation falls back to a hand-authored library of real
lifecycle plays per vertical, and research falls back to heuristics — the
flow works identically, just less brand-specific. **The LLM never writes
markup anywhere in this layer**: it produces schema-validated parameters; the
deterministic engine renders them; the real validator gates the result.

### The pitch workspace (v2)

Nobody pitches one email. The v2 surface turns a brand + brief into the thing
you actually take to a client:

- **Slates** — flip the **Full slate** toggle (or `POST /slate`) and one brief
  becomes up to **6 distinct-module builds** (the brief-routed module first),
  each independently validated to zero errors, grouped under a slate record.
- **Share pages** — every persisted build gets a hosted page at **`/b/<id>`**:
  brand header, interactive phone-frame demo (rendered by the *same*
  `preview.js` the app uses — one renderer, no second implementation),
  validation badge, and an AMP download. A slate gets **`/s/<id>`** — a
  responsive grid of all its demos on one page. Drop that link straight into
  the pitch deck.
- **Brand kits** — the first successful live brand resolution (colour + logo +
  site) is saved to KV as `brandkit:<slug>` and reused on every later build
  for that brand (`colorSource: "kit"`): repeat pitches stop re-fetching the
  brand's site and always render consistently. An explicit colour override
  still wins and refreshes the resolution.
- **Attribution** — the optional **Your name** field (top bar, stored in
  localStorage) stamps builds and slates so the team can tell whose demo is
  whose. It is attribution, not auth — lock the deployment itself with
  Cloudflare Access (see `SETUP-CLOUDFLARE.md`).
- **Copy provenance** — the result chips show whether the copy came from the
  template library or an LLM, so a configured key silently degrading to
  templates is visible instead of invisible.

Storage note: builds, slates and brand kits share the existing `HISTORY` KV
namespace under key prefixes (`build:`, `slate:`, `brandkit:`) — no new
infrastructure. The Express dev server persists the same records to a local
`.data/` directory (git-ignored) so share links work in local dev too.

### Campaign brief — captured, not interpreted

Below the structured fields sits an optional **"Tell us about this
campaign"** textarea — one free-text box for the use case, desired flow, and
any integrations ("needs to hit our loyalty API on redeem," "should match
our Diwali sale email from last year," "skip the OTP step for returning
users") instead of forcing that into extra dropdowns. It has a soft
`0/2000` character counter: past the limit, **Rub the lAMP** disables and a
warning appears, but **nothing you've typed is ever truncated** — there is
deliberately no `maxlength` on the field.

The brief is trimmed server-side (whitespace-only → no brief, not an empty
string), stored alongside the build, and echoed back next to the current
result. It **never changes which module, vertical, or tone gets picked** —
those still come entirely from the structured fields. What it *can* do is
drive a handful of short copy fragments — see the next section.

### Brief-driven content generation (`server/brief-content.js`, `server/llm-providers.js`)

When a brief is given, `composeContent()` fans the brief out to **every
configured LLM provider in parallel** — Claude, Google Gemini, Groq, and a
local Ollama install — each asked to write a handful of short plain-text copy
fragments for whichever module got picked, never markup, never the
module/vertical/tone choice itself. Every provider's response is constrained
twice: once by that provider's own JSON-schema/structured-output feature, and
again locally by `validatePlan()` as defense in depth — any unrecognised
field, non-string value, empty/over-long string, or stray `<`/`>` character
rejects that **entire** plan back to `null`. The allowed fields per module
(mirroring each module's own `copy.*` support in `generate.js`):

| Module | Overridable fields |
|---|---|
| reveal | `head`, `teaserText`, `ctaLabel`, `footerText` |
| search | `head`, `footerText` |
| quiz | `head`, `question`, `footerText` |
| rating | `head`, `prompt`, `footerText` |
| spin | `head`, `teaserText`, `footerText` |
| poll | `head`, `question`, `optionA`, `optionB`, `footerText` |

**Best of N, not first-past-the-post.** Once every provider has answered (or
failed/timed out), each validated plan is scored by a small deterministic
heuristic in `scorePlan()` — rewarding fuller field coverage and natural
sentence length, penalising spammy filler ("act now", "amazing offer"),
excess `!`, and SHOUTING — and only the **highest-scoring** plan is used. This
is a cheap proxy for quality, not a semantic judge (that would mean yet
another paid LLM call just to rank outputs), but it reliably filters out the
worst outputs when several providers respond.

A validated plan is merged into `copy` and passed straight into `generate()` —
the exact same override channel a caller can hit manually via `POST /generate`'s
own `copy` field, which always wins field-by-field over any LLM's plan.
**Every failure mode degrades silently** — a provider with no key configured
is skipped entirely; a network/API error, a malformed/schema-invalid
response, or the timeout budget elapsing all degrade that one provider to
`null` without affecting the others; if every configured provider fails (or
none are configured at all), `composeContent()` returns `null` and
`/generate` falls back to the template's own built-in copy. A brief, or a
flaky/slow/exhausted LLM, can never break or block a build.

**Providers and cost model** — configure any subset via env vars; only
configured providers are called:

| Provider | Env var(s) | Cost | Free-tier behaviour |
|---|---|---|---|
| Claude | `ANTHROPIC_API_KEY` | Pay-per-use, no free tier | Always called while configured |
| Google Gemini | `GEMINI_API_KEY` (model via `GEMINI_MODEL`, default `gemini-2.5-flash`) | Free tier, rate-limited | On a `429`/quota `403`, that provider cools down for ~10 minutes (`server/llm-providers.js`) so an exhausted free tier is skipped, not hammered or silently billed |
| Groq | `GROQ_API_KEY` (model via `GROQ_MODEL`, default `llama-3.1-8b-instant`) | Free tier, rate-limited | Same 10-minute cooldown behaviour on quota/rate-limit errors |
| Ollama (local) | `OLLAMA_BASE_URL` (e.g. `http://localhost:11434`; model via `OLLAMA_MODEL`, default `llama3.2`) | Permanently free — runs on your machine | No quota, so no cooldown; only attempted when `OLLAMA_BASE_URL` is set, so a bare checkout never probes an arbitrary local port |

```bash
# Any combination — only the ones you set get called:
ANTHROPIC_API_KEY=sk-ant-... GEMINI_API_KEY=... GROQ_API_KEY=... OLLAMA_BASE_URL=http://localhost:11434 npm start
```

With none of these set, briefs are still captured/stored/shown exactly as
before — generation just falls back to the library's default copy.

### Header & footer: brand logo, link, and attribution (`generate.js`)

Every module's header now carries a placeholder brand-logo image
(palette-tinted, matching the resolved brand colour) wrapped in a link to a
best-effort guess at the brand's homepage (`https://www.<slugified-brand>.com`,
opened in a new tab) alongside the module's headline. Every footer carries the
brand name plus either the module's own default trailing line or an
overridden `footerText`. Both are built by shared `headerBlock()` /
`footerBlock()` helpers so all six modules stay visually and structurally
consistent.

### Recent builds — a read-only history

Every generation is appended to a small **`.history.json`** file on disk
(server/history.js — newest-first, capped at 200 entries, best-effort: a
failed write never fails the request that triggered it) and shown in a
**Recent builds** panel underneath the result — brand, module, vertical,
tone, timestamp, a pass/fail chip, and the campaign brief (or "No campaign
brief given") for each past build, all HTML-escaped the same way the rest of
the UI escapes free text. It's a review aid, not a system of record: nothing
here feeds back into generation.

---

## How it works

### Brand colour resolution (`server/brand.js`)

Given a brand name, colours resolve in strict priority order, and the winning
tier is reported back and shown as a chip in the UI:

| Tier | Source | Notes |
|---|---|---|
| 1. `override` | your hex input | wins unconditionally when valid |
| 2. `library` | a curated list of real brand colours (AJIO, Zomato, Groww, Nykaa, Myntra, Zerodha, Apple, …) | keyed by a normalised brand name, with a few aliases |
| 3. `fetched` | a live, server-side fetch of `https://www.<brand>.com` (and the bare domain) | parses `<meta name="theme-color">` first, then falls back to the most common saturated hex literal in the page |
| 4. `hash` | a deterministic HSL-derived colour from the brand string | always succeeds — the floor of the waterfall |

A blocked/failed/timed-out fetch (DNS failure, no HTTPS, non-2xx, no usable
colour on the page) falls through silently to the next tier — it never errors
the `/generate` request. A full palette (primary, darkened primary, accent,
light tint, ink, line) is derived from the resolved primary in
`derivePalette()` and baked directly into every CSS rule — AMP4EMAIL forbids
`:root` and `var(--…)`, so nothing is ever templated through CSS custom
properties.

### The six interactive modules (`server/generate.js`)

Each module is a pure function of `(brand, vertical, tone, currency, palette,
content, rng) → { ampHtml, previewModel }`, driven entirely by an `amp-bind`
state machine (`amp-state` + `[hidden]`/`[class]`/`[text]` +
`on="tap:AMP.setState(...)"` / `on="input-throttle:AMP.setState(...)"`):

1. **Tap to Reveal Offer** — teaser → tap → discount + code + product cards. `{r:false}`
2. **Search & Filter Catalog** — live search + category pills over a baked product grid. `{s:'',cat:'all'}`
3. **Quiz & Match** — tap an option → a personalised result appears. `{sel:''}`
4. **Star Rating / NPS** — 5 tap-to-rate stars with a confirmation line. `{score:0}`
5. **Spin to Win** — one tap → reward reveal. `{spun:false}`
6. **This or That Poll** — two options → vote → social-proof result. `{v:''}`

The module is picked at random from a seeded RNG (`brand + reroll counter`),
so the same brand + counter always reproduces byte-identical output, while
**Surprise me again** varies it. Product/quiz/poll/rating copy comes from a
per-vertical content library (`server/content.js`; Fashion, Food, Finance,
Beauty, Electronics, Travel, Generic) with tone-swapped headline templates
(Playful / Premium / Urgent / Informative) and a `{b}` brand-token
interpolated in. Demo images are `https://placehold.co/...` (always HTTPS,
always reachable, palette-tinted).

### AMP4EMAIL correctness (baked into `generate.js`, asserted in tests)

- `<!doctype html>` then `<html amp4email data-css-strict>`; `<meta
  charset="utf-8">` is the first child of `<head>`.
- Head order: runtime `v0.js` → `amp-bind` component script → `<style
  amp4email-boilerplate>` → `<style amp-custom>`.
- No `:root`, no `var(--…)`, no `!important`, no `@import`, no external
  stylesheet — every colour is baked straight into its rule.
- All `<amp-img>` sources are HTTPS and carry `width`/`height`/`layout`.
- No runtime data: no `<amp-state src>`, no `[src]` — everything is baked into
  an inline `<amp-state>` JSON blob.
- `amp-bind` expressions only use whitelisted methods (`indexOf`,
  `toLowerCase`, `length`, …) and `==`, never `=`.
- Every non-ASCII character is emitted as a numeric HTML entity (see below) —
  never a raw multibyte glyph.

### Encoding — no mojibake, ever

The classic bug: a price like `₹4,799` (UTF-8 bytes `E2 82 B9`) gets
misread as Latin-1 somewhere in the pipeline and turns into `â‚¹4,799`.
The fix here isn't "serve the right charset and hope" — `enc()` in
`generate.js` converts every codepoint above 127 into a numeric entity
(`₹` → `&#8377;`) before it ever reaches the markup, so the output is
correct regardless of how it's later saved, pasted, or re-served. Currency is
configurable (₹ default; $, €, £ available), all via entities.

---

## Testing

```bash
npm test              # unit tests: encoding + validator + llm-providers + brief-content -> 46/46
npm run test:e2e      # Playwright UI e2e against the real server        -> 25/25
```

- **`tests/encoding.test.js`** — asserts `formatPrice`/`enc` never emit a raw
  multibyte currency glyph, only the numeric entity; and that a generated INR
  email's raw bytes contain `&#8377;`, never mojibake.
- **`tests/validator.test.js`** — every one of the 6 modules × all 7 verticals
  is generated and run through the real `amphtml-validator` in AMP4EMAIL mode.
  Prints the full pass/fail matrix and asserts **42/42 PASS, zero errors**.
  Also covers deterministic reroll (same seed ⇒ identical bytes, a reroll ⇒
  different) and the structural rules above.
- **`tests/llm-providers.test.js`** — each provider caller (`callClaude`,
  `callGemini`, `callGroq`, `callOllama`) is exercised with an injected fake
  client/`fetchImpl`, never a real network call: happy-path parsing of each
  provider's distinct response shape, never-throws behaviour on a client
  error/malformed JSON/refused connection, the shared `withTimeout()` helper
  resolving to `null` (not hanging) once its budget elapses, and the
  Gemini/Groq quota-cooldown mechanism (`looksLikeQuotaExhausted()`,
  `cooldown()`/`isCoolingDown()`) tripping on a `429` and suppressing the next
  call until it expires.
- **`tests/brief-content.test.js`** — `validatePlan()`'s allowlist rejects
  unknown fields, non-strings, empty/over-long strings, and any `<`/`>`;
  `scorePlan()`'s heuristic rewards fuller field coverage and clean copy over
  spammy filler; and a set of dependency-injected fake `opts.providers`
  arrays exercise `composeContent()`'s multi-provider fan-out — a single
  provider's happy path (plus a `opts.client`-only backward-compat case), the
  **best-of-N selection** picking the higher-scoring plan when several
  providers succeed, falling back to whichever provider survives when others
  error/fail validation, returning `null` when every provider fails or none
  are configured, a thrown (sync or async) provider never crashing the whole
  call, and the shared timeout budget resolving to `null` rather than hanging
  even when a provider never resolves. Also covers an end-to-end check that a
  validated plan's fields show up verbatim in `generate()`'s AMP output and
  still pass the real validator, and that an empty/omitted `copy` is a
  byte-for-byte no-op against the pre-feature baseline.
- **`tests/e2e.test.js`** (Playwright, `npx playwright install chromium` once
  first) drives the real UI against the real running server end to end:
  zero-input generation, brand/vertical/tone flowing into chips and code,
  exactly-three-tabs (no Checklist tab), the AMP code / Validation tabs
  staying hidden until the "Developer view" toggle is switched on (and the
  active tab snapping back to Live preview if it's switched back off), a
  colour override reflected in its chip, all three brand-colour resolution
  tiers (a library brand, an
  unrecognised-but-real brand exercising the live site fetch, and a
  nonexistent brand falling back to the deterministic hash), every one of the
  6 modules' live-preview interactivity (reached by rerolling until each comes
  up), the edit → Re-validate (real FAIL with real errors) → Reset (back to
  real PASS) loop, Copy via the async Clipboard API (read back via granted
  clipboard permissions), Download byte-for-byte matching the current/edited
  code, both dispatch failure paths (no recipient; no SMTP configured), and
  the Rub button's genie-lamp smoke loading animation (shown, and the button
  disabled, for the duration of a deliberately-slowed `/generate`; fully
  cleaned up back to the resting label once it resolves); and the campaign
  brief — trimmed and round-tripped to the current result, whitespace-only
  treated as no brief, the optional field never blocking generation, the soft
  2000-character limit disabling submit without ever truncating typed text,
  and a submitted build (with its brief) appearing in the read-only Recent
  builds history list.

---

## Sending to a real inbox

The dispatch button (`POST /dispatch`) is wired to a real path: it
**re-validates and refuses to send invalid AMP**, then sends a proper
multipart message — `text/plain`, a `text/html` fallback, and the
`text/x-amp-html` AMP part. Credentials come from env vars only, never the
client, and CORS is locked to the genie's own origin.

The `text/html` and `text/plain` parts are the **real branded fallback** built
by `server/fallback.js` from the same generation context as the AMP (palette,
logo, module content, entity-encoded prices) — what Outlook and other non-AMP
clients render. The UI passes them along automatically; API callers can
override them via `html`/`text` on `POST /dispatch`.

Two transports, one contract:

- **Express dev server** (`server/dispatch.js`) — `nodemailer` over SMTP
  (`SMTP_*` env vars below).
- **Cloudflare Pages deployment** (`functions/_lib/email.js`) — SMTP sockets
  don't exist on Workers, so it sends over an HTTP email API that accepts the
  AMP MIME part: **SendGrid** (`SENDGRID_API_KEY`) or **Mailgun**
  (`MAILGUN_API_KEY` + `MAILGUN_DOMAIN`), plus `EMAIL_FROM`, auto-selected by
  which secret is present.

Getting a message *delivered* isn't the same as getting Gmail to *render* the
AMP part. Three things gate that, and they're external to this app:

1. **Register as an AMP sender with Google.** Send
   `ampforemail.whitelisting@gmail.com` a request per
   [Google's AMP-for-Email guide](https://developers.google.com/gmail/ampemail/register)
   from a real, consistently-used sending domain. Until allow-listed, the AMP
   part is ignored and the HTML fallback renders instead.
2. **Pass SPF, DKIM, and DMARC**, aligned to the `From:` domain.
3. **Self-send to verify before registration completes.** Gmail renders AMP
   for mail sent **to the same account it was sent from**, regardless of
   allow-list status — this is the fastest way to confirm interactivity works
   in a real inbox while registration is pending. Use the dispatch field to
   send yourself each module and tap through it in Gmail.

### SMTP configuration (env vars only)

| Var | Required | Purpose |
|---|---|---|
| `SMTP_HOST` | yes | SMTP server hostname |
| `SMTP_PORT` | no (587) | `465` ⇒ implicit TLS, otherwise STARTTLS |
| `SMTP_USER` | yes | SMTP username |
| `SMTP_PASS` | yes | SMTP password / app password |
| `SMTP_FROM` | no | `From:` address (defaults to `SMTP_USER`); must match your allow-listed sender |
| `PORT` | no (4000) | HTTP port; CORS is locked to `http://localhost:$PORT` |
| `ANTHROPIC_API_KEY` | no | Enables the Claude provider for brief-driven content generation (see above) |
| `GEMINI_API_KEY` | no | Enables the Google Gemini provider (free tier; self-cools down on quota errors) |
| `GEMINI_MODEL` | no (`gemini-2.5-flash`) | Overrides the Gemini model used |
| `GROQ_API_KEY` | no | Enables the Groq provider (free tier; self-cools down on quota errors) |
| `GROQ_MODEL` | no (`llama-3.1-8b-instant`) | Overrides the Groq model used |
| `OLLAMA_BASE_URL` | no | Enables the local Ollama provider (e.g. `http://localhost:11434`); unset means never probed |
| `OLLAMA_MODEL` | no (`llama3.2`) | Overrides the local Ollama model used |
| `SENDGRID_API_KEY` | no | Cloudflare deployment only: send-to-inbox via SendGrid (AMP MIME part supported) |
| `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` | no | Cloudflare deployment only: send-to-inbox via Mailgun |
| `EMAIL_FROM` | with either of the above | Verified sender address for the HTTP email APIs |

None of the above are required — with none set, briefs are still
captured/stored, and generation just falls back to default copy.

```bash
SMTP_HOST=smtp.gmail.com SMTP_PORT=587 \
SMTP_USER=you@gmail.com SMTP_PASS='an-app-password' \
npm start
```

If SMTP is unset, dispatch returns a clear "SMTP not configured. Set
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS env vars…" message instead of
failing silently — everything else (build, validate, copy, download) keeps
working without it.

---

## Project layout

```
amp-genie/
  server/                 runtime-agnostic engine + Express dev server
    generate.js           module generators + AMP4EMAIL document assembly (source of truth)
    content.js            per-vertical product/quiz/poll/rating copy + tone headlines
    validator.js          thin wrapper around amphtml-validator, AMP4EMAIL mode
    brand.js              4-tier brand colour resolver (override/library/fetch/hash)
    brief-router.js       deterministic brief->module routing + vertical/tone inference + brief signals
    brief-content.js      brief -> best-of-N schema-validated copy.* plan across all configured LLM providers
    llm-providers.js      fetch-based callers for Claude/Gemini/Groq/Ollama + timeout + free-tier cooldown
    build-pipeline.js     the ONE build flow (brand kit -> resolve -> route -> compose -> generate -> validate -> fallback -> persist), shared by Express and Pages Functions
    slate-core.js         one brief -> N distinct-module validated builds under a slate record
    fallback.js           branded static text/html fallback from the same generation context
    share-pages.js        share-page HTML builders (/b/<id>, /s/<id>)
    store.js              KV-backed builds/slates/brand-kits (key-prefixed, best-effort)
    store-fs.js           same store interface over a local .data/ dir for Express dev
    dispatch.js           nodemailer AMP send over SMTP (Express dev)
    history.js            legacy recent-builds list (read/append/normalizeBrief)
    index.js              Express routes: /api/meta, /brand, /generate, /slate, /history, /validate, /dispatch, /b/:id, /s/:id, /build/:id
  functions/              Cloudflare Pages Functions (production backend)
    generate.js slate.js validate.js brand.js dispatch.js history.js api/meta.js
    b/[id].js s/[id].js build/[id].js
    _lib/                 Workers-runtime edges: validator (wasm), KV history, store glue, HTTP email (SendGrid/Mailgun), env bridge
  web/
    index.html            hero (brand + brief + slate toggle), result panel, 3 tabs, history
    app.js                UI state machine: build/slate/share/edit/revalidate/copy/download/dispatch
    preview.js            plain-JS mirror of each module's amp-bind logic (app + share pages)
    style.css
  tests/                  node:test unit suites (offline, no keys) + Playwright e2e
  SETUP-CLOUDFLARE.md     one-time dashboard steps: production branch, secrets, Cloudflare Access
  CHANGELOG.md
  playwright.config.js
  package.json
```

---

## No dead controls

Every input and button in the UI is wired to real behaviour: the colour
picker/hex fields sync bidirectionally and feed `/generate`'s
`colorOverride`, the dispatch recipient field drives a real
`POST /dispatch`, Copy/Download/Re-validate/Reset all operate on the exact
code currently shown (edits included), and there is no fourth "Checklist"
tab — only Live preview, AMP code, and Validation. The AMP code and
Validation tabs are hidden (`display:none`, not removed from the DOM) until
Developer view is switched on, so every existing lookup and behaviour keeps
working unchanged whether or not the toggle is on.
