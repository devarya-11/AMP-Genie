# Changelog

## v3.2.1 — dossier reliability + honest LLM-status label (2026-07-12)

The "heuristic (no LLM key)" chip was appearing even with a key configured.
Three causes fixed:

- **Scrape starvation** — `brand-research` kept its own `.com`-only domain
  list (drifted from `brand.js`), so `.in`-first brands (groww.in) timed out
  the whole scrape budget on dead `.com` domains before the real one was
  tried. Now imports the shared `candidateDomains` (`.com` + `.in`) and RACES
  all candidates in parallel (`Promise.any`).
- **Stale cache** — a dossier researched in an earlier keyless session cached
  `heuristic` and was served forever. `buildDossier` now re-attempts a cached
  heuristic when a provider is configured, upgrading it to `llm`.
- **Free-tier flakiness** — the LLM synthesis retries once.
- **Honest label** — `/usecases` returns `llmConfigured`; the chip only says
  "(no LLM key)" when there genuinely isn't one, otherwise "click Research to
  retry the LLM". (A raw `429` quota-exceeded — the free Gemini tier's daily
  cap — is the usual reason a configured key still yields heuristic; an
  Anthropic key has no free-tier wall.)

Merged devarya's Directive 7 (preview now renders the **real** validated AMP
in an iframe, retiring the `preview.js` JS-mirror and its drift risk).

## v3.2 — proper emailers: assets, voice, exemplars (2026-07-12)

- **Brand kit assets** — the Brands view gains an editor: logo URL, hero
  image, up to 8 real products (name/price/image) and a **brand voice
  sample**, saved once per brand (`GET/POST /brandkit/:slug`, '' clears a
  field, absent keeps it) and consumed by every future build.
- **Hero image band** — every module renders a full-width hero under the
  header when one exists (kit > live og:image > manual copy precedence),
  validator-gated; product tiles use REAL images when supplied (https-only;
  a bad URL degrades to the placeholder, never breaks the item).
- **Voice fingerprint** — the kit's pasted voice sample is injected into
  both the copy LLM and the ideation LLM as "match this voice".
- **Exemplar-tuned ideation** — the proposal prompt now carries the caliber
  bar: 8 use-cases distilled from the team's real winning decks (reschedule
  in-email, plan calculator, lab-report explainer, IPO one-tap bid, MTF
  margin calculator, price-drop reveal…).
- Real logos (shipped same day): Google favicon tier + .in domains.
- Suite: 263 → 289 unit tests; 21 e2e green.


## v3.1 — refine loop + LLM tier live (2026-07-12)

v3 is complete: every build can now be steered after the fact, and the
intelligence layer runs on a real key.

- **Prompt-to-tweak** (`server/tweak-engine.js`, `POST /tweak`) — "make it
  25% off · switch to the quiz · #112233 · more premium" becomes a
  schema-validated parameter edit-plan (LLM tier, deterministic parser as the
  zero-key floor), rebuilt through `generate()` and the real validator. An
  invalid result persists NOTHING (dry-run gate). Every accepted tweak is a
  new version with `parentId`/`rootId` lineage; `GET /versions/:rootId` lists
  the chain, and the UI shows clickable version chips.
- **Gemini tier activated** — `GEMINI_API_KEY` wired as a deployment secret;
  `callGemini` now authenticates via the `x-goog-api-key` header (Google's
  new `AQ.`-format keys reject the legacy `?key=` query param) and disables
  the 2.5-family default thinking budget for structured-fill calls (measured:
  1.3s instead of 15s+); ideation budget widened to 30s for the slow tail.
- **e2e suite rewritten for the v3 shell** — 21 Playwright tests covering
  nav, both create modes, the full guided wizard journey, slates + share
  pages, calc/report interactivity, download/dispatch guards. Hermetic:
  the webServer env blanks all provider keys so runs never consume quota.
- Build records now carry `params` (counter/colorOverride/final copy) so any
  build made from here on can be reproduced and tweaked byte-exactly.

## v3.0 — the intelligence layer + team shell (2026-07-11)

The genie now understands the brand before it builds, proposes use-cases you
can steer, and lives in a proper multi-view team app.

- **Brand dossier** (`server/brand-research.js`) — a brand name (+ optional
  pasted guidelines/notes, which outrank scraped guesses) becomes a structured
  dossier: summary, products, categories, voice, current campaigns, vertical.
  Two tiers: deterministic site-scrape heuristics (always works, no keys) and
  one schema-constrained LLM synthesis call when a provider key exists.
  KV-cached per brand (`dossier:<slug>`).
- **Steerable use-case ideation** (`server/usecase-engine.js`) — proposes
  brand-grounded lifecycle use-cases mapped to modules via `POST /usecases`:
  propose, reroll with feedback (+ prior titles), or shape the team's own
  idea into the same structure. Zero-key tier: a hand-authored library of
  42+ real lifecycle plays across all 7 verticals. Every LLM output is
  allowlist-revalidated (no markup can ever reach a template).
- **Guided pitch wizard** — the new default Create flow: research the brand →
  see what the genie learned → a 30-second questionnaire (goal, audience,
  moment, products to feature, must-haves) → **a proposal you approve or
  steer before anything is built** → slate.
- **Slates from use-cases** — `POST /slate` accepts `useCases[]`: one build
  per approved idea, titles as labels, contentPlan driving copy through the
  existing validated channel; modules may repeat.
- **SaaS team shell** — left navigation (Create / Pitches / Brands / History),
  Pitches view backed by a new `GET /slates` index, Brands lookup view,
  attribution in the sidebar. Quick generate (v2 one-click) remains as a tab.
- Tests: 145 → 218.

## v2 — pitch workspace (2026-07-10)

The tool's unit of value moves from "one random validated email" to **the
pitch**: brand + brief → a slate of validated interactive demos, each with a
hosted share page, honest fallbacks, and attribution. Generation engine,
validator gate, and determinism are unchanged.

- **Slates** — `POST /slate`: one brief → up to 6 distinct-module builds
  (brief-routed module first), grouped under a shareable pitch page at
  `/s/<id>`. UI: "Full slate" toggle next to the brand colour control.
- **Share pages** — every persisted build gets `/b/<id>`: a client-presentable
  page with the interactive phone-frame demo (rendered by the same
  `preview.js` the app uses), validation badge, and AMP download
  (`/build/<id>?format=amp`).
- **Brand kits** — first successful live brand resolution is cached in KV
  (`brandkit:<slug>`) and reused on subsequent builds (`colorSource: 'kit'`),
  so repeat pitches stop re-fetching the brand's site and stay consistent.
- **Real branded fallback** — `server/fallback.js` now exists (the file
  dispatch's comments always claimed built the `text/html` fallback): a static,
  email-safe, palette-branded rendering of the same generation context, sent
  as the fallback MIME parts on dispatch. Non-AMP clients stop getting the
  generic stub.
- **Build pipeline extracted** — the full generate flow lives once in
  `server/build-pipeline.js`, consumed by both the Express dev server and the
  Pages Function (they had drifted-by-construction as two hand-synced copies).
- **Attribution** — an optional "Your name" field stamps builds/slates so the
  team can tell whose demo is whose. Not auth (see SETUP-CLOUDFLARE.md §3).
- **Preview honesty** — editing the AMP code now shows a visible "preview
  shows the last generated version" notice instead of silently rendering
  stale content.
- **Copy provenance** — the result chips show whether copy came from the
  template library or an LLM, so a configured key silently degrading to
  templates is visible.
- **Branch convergence** — `cloudflare-pages-port` merged into `main`; `main`
  is canonical from here on.
