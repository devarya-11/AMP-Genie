---
name: amp-image-sourcing
description: The brand-agnostic contract for how AMP Genie sources hero and product images for EVERY generated AMP email. Hero = the brand's own website main image (og:image); product tiles = a real photo or a clean placeholder labeled with the product's own name; no slot ever uses a random keyword/CC stock photo. The catalogue search must bind a VALID amp event. Read this whenever touching image resolution or the search module in server/pitch-api.js, server/generate.js, server/email-doc.js, or server/brand-research.js.
---

# AMP Genie image sourcing & search interactivity

A single, brand-agnostic contract that holds for every AMP email this app builds
— across every brand, vertical and use case. Brand names in a request are only
examples; never special-case one. Both render paths share this logic: the
module path (`generate()`) and the doc/editor path (`email-doc.js`
`renderInteractive` -> `buildModuleFragment`). The production Cloudflare Pages
shells import `server/` directly (`functions/_lib/pitch.js` ->
`server/pitch-api.js`), so `server/` is the single source of truth.

## Hero image — the brand's OWN website main image

The header band shows the brand's real homepage hero, never a lookalike. Ladder,
best source first (`heroFromDossier` in `server/pitch-api.js`, curated rung in
`curatedImagePicks`):

1. A curated `brand_images` row with `kind='hero'` (a team upload) — wins.
2. The scraped **`og:image`** from the brand's homepage (`liveHeroUrl` /
   `logo.heroUrl`). This IS "the website main image" for that brand.
3. A deterministic floor — the LLM's `heroPrompt`, else the vertical noun, as a
   loremflickr keyword photo — so the header is never a bare box. Relevant, and
   **deterministic**, never random.

**Never** a random Openverse/CC photo. `heroFromDossier` deliberately does NOT
read `dossier.heroImage`. (For a brand whose og:image genuinely is a plain logo,
e.g. some sportswear sites, the honest richer hero is a curated upload or a
scoped image-generation rung — not a random CC lookalike.)

## Product tiles — a real photo, or a clean labeled placeholder

Each tile shows a REAL product photo or an honest placeholder — never a random
keyword photo of the wrong subject. Ladder (`productsFromDossier` in
`server/pitch-api.js`; tile render in `buildSearch`/module builders in
`server/generate.js`):

1. Curated `brand_images` rows with `kind='product'` override tiles **by
   position** (`curatedImagePicks`).
2. A real image already carried on the catalog item (`it.image`), if present.
3. Otherwise **no image** — the tile renders a `placehold.co` box tinted to the
   brand and **labeled with the product's own name** (`ph()` in generate.js).

`productsFromDossier` keeps a real image only; it never invents keyword stock.

## Why not Openverse / loremflickr keyed on names

A CC/Flickr photo AND-matched on a product name — or on a brand-poisoned query —
comes back as an unrelated, often repeated, sometimes logo-like image. That is
what produced "a random nike logo" heroes and "random images that aren't the
product" tiles. `resolveDossierImagery` (in `server/brand-research.js`) still
exists and is exported for explicit opt-in callers, but the default research
path (`buildDossier`) does **not** call it — imagery is left to the floors above.

## Search interactivity — bind a VALID amp event

The catalogue search input must fire `AMP.setState` on a real AMP event. The
low-level amp-bind text-input events are `input-throttled` and `input-debounced`
(plus `change` on blur/enter). `input-throttle` (no `d`) is **not** an AMP event
— it validates but is silently inert, so the search box does nothing. Correct
binding (see `buildSearch` in `server/generate.js`):

```
on="input-throttled:AMP.setState({s:{q:event.value.toLowerCase()}});change:AMP.setState({s:{q:event.value.toLowerCase()}})"
```

The tile `[hidden]` filter keys off `s.q` / `s.cat`; the `<input>` and the
category pills are the only things that write `s`.

## Guardrails / tests

- `tests/pitch-api.test.js` — hero resolves to og:image or the deterministic
  floor; a real provided product image is kept; offline catalog products persist
  image-less (clean placeholder at render).
- `tests/brand-research.test.js` — `buildDossier` paints no imagery and makes
  zero Openverse calls; `resolveDossierImagery` still works when called directly.
- The AMP validator matrix (`search` x every vertical) proves the search event
  binding is valid AMP4EMAIL.

When you change any image rung or the search binding, keep it structural and
brand-agnostic (select on `kind`, on the vertical noun, on presence of a real
URL — never on a brand name) and update these tests.
