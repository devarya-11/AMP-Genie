# Changelog

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
