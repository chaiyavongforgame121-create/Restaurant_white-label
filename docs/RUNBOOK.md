# Favornoms — Operational Runbook

> Quick reference for on-call. For deeper docs see `HANDOFF.md`, `CONFIG-CHECKLIST.md`, `docs/BACKUPS.md`.

## Severity ladder

| Sev | Definition | First responder action |
|-----|-----------|------------------------|
| Sev-1 | All apps down, payments failing, data loss risk | Page; engage Supabase support if backend is the cause |
| Sev-2 | One critical flow broken (e.g. orders not dispatching) | Triage within 15 min; create incident ticket |
| Sev-3 | Degraded UX (e.g. push notifications down) | Resolve same business day |
| Sev-4 | Cosmetic / minor | Backlog |

## Common incidents

### "Orders not appearing in KDS"
1. Check Realtime publication includes `orders` + `order_items` (Dashboard → Database → Replication)
2. Check `notifications_outbox` for stuck rows: `select * from notifications_outbox where status='failed' order by created_at desc limit 20;`
3. Verify Edge Function `place-order` is ACTIVE
4. Check KDS browser tab is on `?station=` filter that matches the order's `station`

### "Drivers not getting dispatch"
1. Check `orders_dispatch_on_ready` trigger fired: look for delivery row with `status='dispatching'`
2. Check `private.app_settings` has `supabase_url` + `service_role_key` (otherwise pg_net call no-ops)
3. Check `dispatch-driver` Edge Function logs: `mcp__supabase__get_logs --service edge-function`
4. Verify drivers are online + within `DISPATCH_RADIUS_KM` (default 5km)

### "Web Push not sending"
1. Check VAPID env vars on `notify-worker` Edge Function
2. Check `push_subscriptions` rows exist for the recipient
3. Check `notifications_outbox` for `channel='push'` failures
4. Browser DevTools → Application → Service Workers — verify SW is active

### "Customer can't sign in (OTP not arriving)"
1. Auth → Logs in Supabase Dashboard — confirm OTP was generated
2. Check SMS Provider config (Auth → Providers → Phone) — Twilio account active
3. If using ThaiBulkSMS, check the Custom SMS Hook is enabled

### "Database query slow"
1. Run `select * from pg_stat_activity where state='active' and now() - query_start > interval '5s';`
2. Add a covering index if a hot table lacks one
3. Check `mcp__supabase__get_advisors --type performance`

## Deploys

### Edge Function
```bash
# Via MCP (this session) or CLI:
supabase functions deploy <name> --project-ref ayyfczidnzxetndiijmv
```
Or push to `main` — `.github/workflows/deploy-functions.yml` picks up changes in `supabase/functions/`.

### App
GitHub Actions builds + runs tests + type-check on every PR. Production hosting (Vercel/your choice) deploys on `main` merge.

### Database migration
1. Always run via `mcp__supabase__apply_migration` (or `supabase db push`)
2. Forward-only — destructive migrations require a rollback plan documented in the PR
3. Test on a branch first via `mcp__supabase__create_branch`

## Rotations + secrets

| Secret | Rotation cadence | Owner |
|--------|------------------|-------|
| `SUPABASE_SERVICE_ROLE_KEY` | On personnel changes | Tech lead |
| `OMISE_SECRET_KEY` | Annually | Finance + Tech |
| `VAPID_PRIVATE_KEY` | Only if compromised (invalidates all subscriptions) | Tech lead |
| `ANTHROPIC_API_KEY` | Annually | Tech lead |
| `RESEND_API_KEY` | Annually | Tech lead |

## Migration rollback

Forward-only migrations. To roll back:
1. Identify the migration that caused the issue (`mcp__supabase__list_migrations`)
2. Write a new "revert_<name>" migration that undoes it
3. Apply via `mcp__supabase__apply_migration`
4. Never `drop table` rolled-back tables until you've verified no data loss

## Smoke test (post-deploy)

Run through `CONFIG-CHECKLIST.md §11` — 7 steps from sign-in to live tracking.
