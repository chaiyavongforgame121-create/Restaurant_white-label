-- Re-read closure and promo times that were saved as UTC by mistake.
--
-- The Closures card and the promo "Ends at" field are <input type="datetime-local">, whose
-- value has no zone ("2026-12-25T00:01"). The client wrote it straight into timestamptz, and a
-- zone-less literal is read as UTC — so every one of these rows holds the merchant's WALL
-- CLOCK labelled as UTC. A Chicago shop's "Christmas Day 12:01 AM" closure was stored as
-- 00:01 UTC, i.e. 6:01 PM on Christmas Eve, and the shop took orders through hours the
-- merchant believed were blocked. The client now converts in the branch's timezone
-- (packages/shared/src/utils/zoned-time.ts); this corrects what it had already written.
--
-- The correction reinterprets the stored wall clock in the BRANCH's timezone:
--   (value AT TIME ZONE 'UTC')  -> the naive wall clock the merchant typed
--   ... AT TIME ZONE b.timezone -> that wall clock, as an instant at the shop
--
-- Scope, deliberately narrow:
--   * Only rows with zero seconds. datetime-local has minute precision, so a value with
--     seconds did not come from that input — the seeded promos (23:59:59, and one with
--     fractional seconds) were written in real UTC and must not move.
--   * Only rows that already exist when this runs. After the client fix deploys, new rows are
--     correct and must not be shifted again.
--   * promos.starts_at is untouched: the form never sends it, so it is the column default.
--
-- NOT IDEMPOTENT. Running this twice shifts the same rows twice. It is recorded in
-- supabase_migrations.schema_migrations once applied, and must not be re-run by hand.
--
-- At the time of writing this touches 3 closures and 1 promo, all on one branch in
-- America/Chicago, all created from a device in that same zone — so reading them in the
-- branch zone is exactly what the merchant typed.

begin;

update public.branch_closures c
   set starts_at = (c.starts_at at time zone 'UTC') at time zone b.timezone,
       ends_at   = (c.ends_at   at time zone 'UTC') at time zone b.timezone
  from public.branches b
 where b.id = c.branch_id
   and b.timezone is not null
   and date_trunc('minute', c.starts_at) = c.starts_at
   and date_trunc('minute', c.ends_at) = c.ends_at
   and c.created_at < now();

update public.promos p
   set ends_at = (p.ends_at at time zone 'UTC') at time zone b.timezone
  from public.branches b
 where b.id = p.branch_id
   and b.timezone is not null
   and p.ends_at is not null
   and date_trunc('minute', p.ends_at) = p.ends_at
   and p.created_at < now();

commit;
