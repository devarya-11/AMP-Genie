-- Postgres-side addendum 0002 (applied to Supabase via the Management API;
-- NOT in migrations/ because SQLite cannot ALTER TABLE ADD CONSTRAINT and the
-- local dev schema does not need it — PostgREST does, to embed examples(count)
-- from brands). activity deliberately stays FK-free: logging must never fail.
ALTER TABLE examples
  ADD CONSTRAINT examples_brand_fk FOREIGN KEY (brand_id) REFERENCES brands(id);
