-- GENIE 2.0 phase 1 — brand_images: a brand's OWN curated pictures, and the
-- TOP rung of the image ladder (they win over the scraped og:image, the
-- Openverse CC0 floor and the loremflickr floor beneath them). Every row is a
-- real https URL: source 'manual' is a pasted link, source 'upload' is a file
-- put in R2 and served back as a URL — ONE table so the ladder and the UI
-- never care how a picture arrived. kind buckets a row as 'hero', 'product'
-- or 'other'; pos orders the list; alt is optional description text. Additive
-- and safe: CREATE ... IF NOT EXISTS only, no existing table is touched.
--
-- MIRROR: server/migrations.js embeds this file as a JS string so the Workers
-- runtime can apply it without fs. tests/db-repo.test.js asserts the two
-- copies are byte-identical — edit BOTH or that test fails.
--
-- server/db.js splits migration files on ';' at end-of-line — keep one
-- statement per ';'-terminated block and never put a ';' inside a string
-- literal in a migration.

CREATE TABLE IF NOT EXISTS brand_images (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  alt TEXT,
  pos INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brand_images_brand ON brand_images(brand_id);
