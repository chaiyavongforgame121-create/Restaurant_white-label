# Migrations

The live project (`ayyfczidnzxetndiijmv`) tracks every migration in
`supabase_migrations.schema_migrations` — 185+ of them, applied over the life of the
project. They were **never checked into git**, so this directory starts from
2026-08-27 and is not a full history. `supabase db pull` reconstructs the rest.

Every schema change from here on lands as a file here *and* is applied to the remote,
in that order. Without this the schema exists only on the server: no review, no
rollback, and no way to stand up a second environment.
