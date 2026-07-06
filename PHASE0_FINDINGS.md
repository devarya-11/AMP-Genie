# Phase 0 — Assertion-Layer Diagnosis (BLOCKING)

**Question the spec asks:** Does an assertion layer enforcing `GenerationContext` as the
*sole* source of truth for brand-specific values exist, and is it actively invoked in
**both** the preview path **and** the generator path?

**Short answer:** A **partial** assertion layer exists. It is **reference-leak-focused**, not a
general "GenerationContext is the sole source of truth" guard. It is invoked in **one**
generator path only (`/build-vertical`), and in **neither** the main generator path (`/build`)
**nor** the preview path.

---

## 1. What exists

| Guard | File / function | What it enforces | Direction |
|---|---|---|---|
| Forward guard | `reference/vocab.js` → `assertAbstract(obj)` | A distilled reference pattern/skeleton carries **no identity** — only counts, booleans, controlled-vocab tokens; throws `LeakError` otherwise. | Nothing concrete can be *stored* in the reference layer. |
| Backward guard | `reference/assert.js` → `assertNoReferenceLeak(html, {context})` | No chromatic hex / image URL / custom font-family observed in `corpus/*.html` appears in the finished email — **except** values the client independently owns (`allowFromContext(context)`). | No reference value *bleeds into* output. |

Both guards are about the **Trove reference corpus**. They answer "did a value from a *reference
email* survive into output?" They do **not** answer the broader remediation question: "did any
brand-specific value arrive from somewhere *other than* this build's `GenerationContext`
(a default, a cache, template remnant, or shared module-level state)?"

## 2. Where it is wired in

- `reference/integrate.js` → `generateWithForm(spec)`:
  - line 92 `assertAbstract(formOnly)` (forward guard, before build)
  - line 115 `assertNoReferenceLeak(built.ampHtml, { context: built.context })` (backward guard, after build)
- `generateWithForm` is called from exactly **one** place: `server/index.js` → the
  `/build-vertical` route (~line 137).

## 3. Where it is NOT wired in

- **Main generator path** — `server/build.js` → `buildProduction(opts)` (the primary
  GenerationContext producer, line 385) contains **zero** assertion calls. The only occurrence of
  "assert" in the file is a comment (~line 521). This is the path the web UI actually uses.
- **Preview path** — `web/preview.js` → `renderAmp(ampHtml, container)` (line 107) parses the
  **server-returned** `ampHtml` with `DOMParser` and renders it; it harvests `amp-state` only for
  interactivity (`harvestState`/`wire`). It **re-derives no brand values**, so there is nothing to
  assert there — but equally there is no guard confirming what it renders matches a single
  GenerationContext.
- **What the UI calls** — `web/app.js:135` calls `api('/build', ...)` (→ `buildProduction`),
  **not** `/build-vertical`. So in normal product use the assertion layer never runs at all.

## 4. Other findings relevant to bleed

- **No active hardcoded `#2c4152` default.** `server/assets.js:264` explicitly comments "There is
  NO '#2c4152' default — an unknown brand hashes its own name." The hex appears only in comments and
  a legitimate AJIO demo fixture.
- **Module-level mutable state is a live cross-build bleed vector.** `server/build.js` (lines
  ~164–185) declares `_activeLogo`, `_activeAes`, `_activeFooter`, `_activeBrand`, `_capturedHead`,
  `_capturedFootMsg`. They are set (~452–453) around `mod.build(ctx)` and reset in a `finally`
  (~456). If any read path observes them across builds, or a throw skips the reset, Client A's
  values can surface in Client B. This is the prime suspect for the AJIO `#2c4152` A→B bleed the
  spec asks to reproduce in Phase 1.

## 5. The gap (stated plainly, not built silently)

A general guard that fails loudly when **any brand-specific value originates outside the current
build's `GenerationContext`** does **not** exist. What exists is narrower (reference-corpus leak
only) and is wired into a route the UI doesn't call. Per the spec — *"do not build a partial
version silently; report the gap first"* and *"do not proceed to Phase 1 until this is answered"* —
this is reported here before any Phase 1 work.

**Recommended Phase 1 direction (for confirmation):**
1. Reproduce the AJIO `#2c4152` A→B bleed via the `/build` path (two sequential builds, Client A
   then Client B, diff B's output for A's colour).
2. Trace the surviving value backward to its entry point (primary hypothesis: the module-level
   `_active*` state above; secondary: any palette default/cache in `assets.js`).
3. Close every non-`GenerationContext` entry point, then wire the assertion layer into
   `buildProduction` itself (not just `/build-vertical`) so it fails loudly on the main path.
4. Re-run A/B, confirm zero bleed.
