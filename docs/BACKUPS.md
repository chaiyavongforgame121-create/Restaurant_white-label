# Backups + disaster recovery

> Production data lives in Supabase. This doc describes the recovery options.

## Layers of defense

| Layer | What | RPO | RTO | Cost |
|---|---|---|---|---|
| 1 | Supabase daily backups (built-in, Pro tier) | 24h | ~30 min | included |
| 2 | Supabase PITR (Pro tier + add-on) | <1 min | ~5 min | per-day storage |
| 3 | `scripts/db-dump.cjs` cron → S3/R2 | 24h (configurable) | ~10 min (manual restore) | object storage |
| 4 | Storage bucket replication (Wasabi/Backblaze) | varies | manual | included in destination |

## Quick recovery scenarios

### Accidentally deleted a row
1. Dashboard → Database → Backups → Restore database from latest
2. OR: PITR to 1 minute before the delete

### Restaurant data corruption (RLS bug, etc.)
1. Restore single table via Dashboard SQL editor + previous dump:
   ```sql
   truncate public.foo;
   -- then load from scripts/db-dump output
   \copy public.foo from '/tmp/foo.json' (format json);
   ```

### Complete project loss (account suspended, region outage)
1. Spin up new Supabase project
2. Apply migrations via `supabase db push` (or replay via MCP)
3. Load latest dump JSON into the new project (write a `db-restore.cjs` companion)
4. Re-deploy Edge Functions from `supabase/functions/`
5. Update DNS / env vars on each app

## Running the dump script

```bash
SUPABASE_URL=https://ayyfczidnzxetndiijmv.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service_role_key> \
node scripts/db-dump.cjs ./backups
```

Suggested cron (Vercel/GitHub Actions/EC2 cron):
```
0 3 * * *  cd /repo && node scripts/db-dump.cjs /var/backups/favornoms
```

Then ship to S3/R2 with `aws s3 sync` or `rclone copy`.

## What's NOT in the dump

- `auth.users` (passwords, OTP state) — Supabase manages this; export via their dashboard or admin API
- Storage bucket files (logos, KYC docs, receipts) — use `supabase storage mirror` or `rclone` against the bucket
- Edge Function source — already committed in `supabase/functions/`
- Migration history — already committed in MCP / `supabase/migrations/`

## Test the recovery, not just the backup

Schedule a quarterly DR drill:
1. Pick a random "moment in time" (e.g. last Tuesday 14:00 UTC)
2. Open a fresh staging project, restore to that moment
3. Smoke-test: log in, see orders, place a new order
4. Time how long it took. Refine the runbook.
