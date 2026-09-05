# Migrations

## Applied directly in Supabase (not yet in this repo)

- **migration-002** — target levels; stock moves on handover, not on sale. Applied 5 Sep 2026.
- **migration-003** — restock triggers at minimum level. Applied 5 Sep 2026.

`supabase/schema.sql` does not reflect these changes yet.

## Rule: never edit a migration that's already been pushed

Once a migration file has been pushed (and especially once it's been applied
to Supabase), treat its content as immutable. Supabase tracks which migration
files have already run and won't re-run one just because its content
changed locally — so editing it after the fact only desyncs the repo from
what's actually in the database. If a migration turns out to be wrong,
write a new migration that fixes it forward instead.

(migration-005 was edited in place after being applied, which is exactly
this mistake — migration-006 exists to correct it.)
