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

## Billing operations

Packaging (2026-07-25): **Base $199** (card payment + AI menu import, 1 branch)
· **+$99** per extra branch · **+$49** Delivery · **+$59** AI Suite
· **$0 / 14-day trial** with everything and 1 branch.

### How entitlement actually works

`subscriptions` + `subscription_items` → (trigger) → `billing_entitlements`
(one resolved row per restaurant) → mirrored onto `branches.entitled_through`.

`entitled_through` is a **deadline, not a flag**. A restaurant is trading while
`entitled_through > now()`. That means:
- **No cron suspends anyone**, and none is needed. Nothing to be "stuck".
- **Cancelling does not suspend immediately** — a cancelled subscription keeps
  trading until the paid period runs out. Status alone never answers "can they
  trade?"; compare the deadline.
- Paying **restores instantly**. No data is ever deleted by suspension.

Enforcement is **BEFORE INSERT triggers**, not RLS, and it only blocks *new*
business. Orders already in the pipe stay cookable, printable and payable in
cash — suspension must never strand a restaurant mid-service.

Error codes surfaced to the UI:
| Raised | Meaning |
|--------|---------|
| `billing_inactive:<scope>` | nothing is paid for → 402 |
| `feature_not_entitled:<key>` | paid, but not in the package → 403 |
| `plan_limit_exceeded:branches:<used>/<limit>` | out of branch seats → buy a seat first |

### "A merchant paid but is still suspended"
1. `select * from billing_entitlements where restaurant_id = '<id>';` — is
   `entitled_through` in the past?
2. `select * from billing_events where restaurant_id = '<id>' order by created_at desc limit 20;`
   Look for `stripe.sync_failed` or `stripe.unresolved_customer` (the latter means
   the invoice matched no restaurant and **nothing was updated**).
3. Stripe → Developers → Webhooks → check for failed deliveries. The handler
   returns 500 on a failed sync precisely so Stripe retries; re-send the event.
4. Manual override (the live path while Stripe is dormant):
   ```sql
   select public.billing_set_package(
     p_restaurant_id => '<id>', p_plan_code => 'base',
     p_addons => array['delivery','ai_suite'], p_branch_seats => 1,
     p_status => 'active', p_period_end => now() + interval '1 month');
   ```

### "Merchant can't create a branch"
Expected when branch seats are exhausted — extra branches are **pay-first**.
Check `branch_seats` vs actual branches; raise seats via `billing_set_package`.

### Stripe is DORMANT until keys are set
All four `stripe-*` functions are deployed and ACTIVE but return
`503 stripe_not_configured` without `STRIPE_SECRET_KEY`; the plan page falls back
to the manual request queue (platform admin → Subscriptions → Requests). See
`CONFIG-CHECKLIST.md §6` — note that **Price IDs must also be mapped**, not just
the API keys.

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
| `STRIPE_SECRET_KEY` | Annually | Finance + Tech |
| `STRIPE_WEBHOOK_SECRET` | Only on endpoint change / compromise | Tech lead |
| ~~`OMISE_SECRET_KEY`~~ | Legacy (Thailand). Market is US-only — Omise is unused; `create-payment-source` + `omise-webhook` are dead functions pending deletion | — |
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
