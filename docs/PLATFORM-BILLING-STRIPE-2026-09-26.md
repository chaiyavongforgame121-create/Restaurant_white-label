# Platform billing through Stripe — restaurants pay Favornoms by card (owner request 2026-09-26)

The owner asked for the platform side of Stripe: restaurants that sign up pay the platform's own Stripe account for
their package — the one-time fees and the monthly fee — and the monthly fee is charged again every month by itself.

This is the platform's income (docs/PACKAGING-2026-09-23.md). It is **not** diners paying restaurants, which is
Stripe Connect (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md). Both use the same platform Stripe account and keys; they
never share a code path, a webhook endpoint or a table row.

The maps this design was built from (live definitions, 2026-09-26) are in the session scratchpad; the facts that shape
the design are repeated here so this file stands alone.

## 1. What is wrong with the dormant rail (why it is rewritten, not switched on)

1. It opens Checkout **instead of** filing the request, so the server's pricing, the seat floor, the one-time charges
   and the discount-code reservation are all skipped. It charges no one-time fee and uses Stripe promotion codes that
   can discount the monthly price.
2. Any selection with more than one branch fails (`seat_product_missing`); delivery is one line at quantity 1.
3. **Every subscription event grants a free month.** The webhook reads `subscription.current_period_*`, which the
   pinned API version (basil) no longer has, so the period is always `now() + 1 month` — after a cancellation too.
4. A restaurant already paying through Stripe that adds a branch gets a **second subscription**.
5. The webhook's delivery branches are "whatever is active already", so a converting trial is charged for delivery and
   granted none.
6. `incomplete` (nothing paid) maps to `past_due`, which grants access.

## 2. Decisions (made for the owner; each can be changed later)

| # | Decision | Why |
|---|---|---|
| D1 | **Two rails.** `stripe` (card, automatic) and `manual` (the existing request → platform approval, for bank transfers and special deals). A restaurant is on the Stripe rail while it has a live Stripe subscription. | Nothing the owner uses today is taken away. |
| D2 | **The switch lives in the database**: `platform_settings.billing->>'stripe_enabled'`, turned on from the new `/platform/billing-setup` page, which refuses to turn it on until the keys and the webhook secret are set. The env flag `STRIPE_BILLING_ENABLED` is retired. | The owner can switch it from the app; no secret needs editing. |
| D3 | **Request first, then pay.** The plan page files `request_package_change` exactly as today, then asks the edge function to take payment **for that request**. The server prices everything; Stripe is told net amounts. | One pricing path, codes and the one-time ledger keep working. |
| D4 | **First purchase = Stripe Checkout (subscription mode)** with the monthly lines as recurring prices and each one-time charge as a one-time line **priced at its net amount** (`price_data`). No Stripe promotion codes. Card only. | Exact to the cent against `billing_charges.net_amount`; codes stay one-time only. |
| D5 | **Time already covered is not charged twice.** If the restaurant is in its free trial, or already paid through a date on the manual rail, and more than 48 h remain, the monthly charge starts at that date (`subscription_data.trial_end`); the one-time fees are charged now. Otherwise monthly billing starts now. | A trial merchant who buys early keeps the rest of the trial; a manual merchant switching to card keeps what they paid for. |
| D6 | **After purchase the restaurant is `active` on the paid plan**, paid through the first charge date. The trial ends at purchase in our records (its all-branch delivery stops; the branches they chose deliver). | They bought a package; the trial banner would be wrong. |
| D7 | **A paying Stripe restaurant that changes its package is not sent to Checkout again.** Its subscription is updated in place: quantities change, the new one-time fees (net) are added, and the difference is charged to the card on file **now** (`proration_behavior=always_invoice`, `payment_behavior=pending_if_incomplete`). Removing a branch's delivery or a seat credits the unused part automatically. If the card needs 3-D Secure or fails, the change waits and the merchant gets Stripe's invoice page to pay. | One subscription per restaurant; "pay $70 now" is immediate and clear. |
| D8 | **Paid-through only moves when money arrives.** `current_period_end` is set at purchase (the first charge date or the first paid period) and moved forward only by `invoice.paid`. Subscription update events change the status and the cancel flags, never the date. | Fixes the free-month bug for good. |
| D9 | **7 days of grace after a failed renewal.** On the first failed renewal the restaurant is `past_due` and keeps working until `grace_until = paid-through + 7 days`. Stripe keeps retrying (Smart Retries); a later success restores it. If Stripe gives up and cancels, access ends at the later of paid-through and grace. | A declined card does not take a restaurant offline in the middle of service. |
| D10 | **Cancel = at the end of the paid period**, from the Stripe customer portal. The portal is configured by code: update card, invoice history, billing details, cancel at period end; **no plan switching** (plans change on our page). | The merchant never loses days they paid for. |
| D11 | **Manual controls are refused on a Stripe restaurant** (`billing_set_package`, approving a request of a Stripe restaurant or a request awaiting card payment) with `stripe_managed`; the console links to the customer in Stripe instead. Feature switches and suspension still work. | Our records and Stripe never drift. |
| D12 | **A payment for a request that is no longer pending is refunded and its subscription cancelled** (a stale Checkout tab paid after the merchant changed their mind). Opening a new Checkout expires the restaurant's other open sessions first. | Nobody pays for something they did not end up buying. |

## 3. Data (migration `20260926100000_platform_billing_stripe.sql`)

### 3.1 Columns

```sql
alter table public.platform_settings add column billing jsonb not null default '{}'::jsonb;
  -- keys: stripe_enabled boolean, portal_configuration_id text, grace_days int (default 7 when absent)

alter table public.billing_requests
  add column rail text not null default 'manual' check (rail in ('manual','stripe')),
  add column stripe_checkout_session_id text,
  add column stripe_invoice_id text,          -- the invoice a subscription change is waiting on
  add column paid_at timestamptz;

alter table public.billing_charges add column stripe_invoice_id text;

alter table public.subscriptions
  add column grace_until timestamptz,
  add column card_brand text,
  add column card_last4 text,
  add column card_exp_month int,
  add column card_exp_year int,
  add column cancel_at timestamptz;
  -- existing and now used: stripe_customer_id, stripe_subscription_id, next_billing_at, cancel_at_period_end

create table public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  stripe_invoice_id text not null unique,
  stripe_subscription_id text,
  billing_reason text,                 -- subscription_create | subscription_cycle | subscription_update | ...
  status text not null,                -- paid | open | uncollectible | void
  amount_due numeric(10,2) not null default 0,
  amount_paid numeric(10,2) not null default 0,
  currency text not null default 'usd',
  period_start timestamptz, period_end timestamptz,
  hosted_invoice_url text,
  paid_at timestamptz,
  attempt_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
-- RLS on; no direct policies. Read through get_billing_overview (merchant) and the platform RPCs.
```

`subscription_items.stripe_subscription_item_id` (exists) is now filled at settlement.

### 3.2 Rules changed in existing SQL

- `private.billing_compute`: `entitled_through = greatest(current_period_end, trial_ends_at,
  case when status = 'past_due' then grace_until end)` for trialing/active/past_due/cancelled (was without grace).
- `private.billing_expire_tick` (live-only today; now in the repo): expires where that same greatest(...) `<= now()`.
  The cron job `billing-expire-tick` (every 10 min) is re-declared idempotently in the migration.
- `public.decide_billing_request`: approving refuses with `stripe_managed` when the request's `rail = 'stripe'` or the
  restaurant is Stripe-managed (§3.4). Rejecting still works (and for a `stripe` request it is how an admin clears a
  checkout the merchant abandoned).
- `public.billing_set_package`: refuses with `stripe_managed` for a Stripe-managed restaurant.
- `private.billing_paid_state`: unchanged (a Stripe restaurant's base is a paid `billing_charges` row after settlement).

### 3.3 New SQL functions

All SECURITY DEFINER, `search_path` pinned, EXECUTE revoked from public. "service" = granted to `service_role` only.

```sql
-- Is this restaurant on the Stripe rail right now?
private.billing_is_stripe_managed(p_restaurant_id uuid) returns boolean
  -- subscriptions.stripe_subscription_id is not null and status in ('trialing','active','past_due')
  -- (a 'cancelled' row with cancel_at_period_end still pending counts too: status 'active' + cancel flag).

public.billing_stripe_enabled() returns boolean            -- EXECUTE authenticated; reads platform_settings.billing

-- EXECUTE authenticated. The edge function calls it with a client carrying the CALLER's JWT, so
-- auth.uid() is the merchant and user_can_manage_billing is the permission check.
public.billing_checkout_context(p_request_id uuid) returns jsonb
  -- refuses ({ok:false, error:'forbidden'}) unless user_can_manage_billing(request's restaurant);
  -- returns { ok, request{...}, restaurant{id,name,slug,stripe_customer_id,owner_email},
  --           charges[{id,code,branch_id,net_amount}], monthly_lines[{code,quantity,unit_amount_cents}],
  --           subscription{status,plan_code,stripe_subscription_id,stripe_customer_id,current_period_end,
  --                        trial_ends_at,items[{product_code,quantity,stripe_subscription_item_id}]} | null,
  --           stripe_managed boolean }
  -- monthly_lines: base qty 1, extra_branch qty seats-included (omitted at 0), delivery qty = number of
  -- delivery_branch_ids (omitted at 0), unit prices from billing_products.

-- EXECUTE authenticated, caller's JWT: the restaurant a branch belongs to and whether the caller may bill it.
public.billing_branch_context(p_branch_id uuid) returns jsonb
  -- { ok, restaurant_id, can_manage boolean, stripe_customer_id, stripe_subscription_id, stripe_managed }
  -- (ok:false, error:'branch_not_found' for an unknown branch). Used by `portal`, by `start` to check that
  -- branch_id belongs to the request's restaurant, and by `confirm` to check the caller.

-- service: the edge function marks the request as being paid by card.
public.billing_mark_request_stripe(p_request_id uuid, p_checkout_session_id text, p_invoice_id text) returns void

-- service: store the Stripe customer on the restaurant (and on its subscriptions row if one exists).
public.billing_set_stripe_customer(p_restaurant_id uuid, p_customer_id text) returns void

-- service: a paid first purchase (Checkout completed) or a paid subscription change.
public.billing_settle_stripe_request(
  p_request_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_invoice_id text,                 -- the invoice that paid it (null when nothing was due)
  p_paid_through timestamptz,        -- D5/D8: the first charge date or the paid period's end
  p_items jsonb,                     -- [{product_code, stripe_subscription_item_id}]
  p_card jsonb                       -- {brand,last4,exp_month,exp_year} or null
) returns jsonb
  -- lock the request. If already 'approved' with the same session/invoice/subscription -> {ok:true, duplicate:true}.
  -- If not 'pending' -> {ok:false, reason:'request_not_pending', status} (the caller refunds, D12).
  -- First purchase (restaurant not yet Stripe-managed):
  --   billing_apply_selection(rid, plan, req.delivery_branch_ids, seats, 'active', now(), p_paid_through, null)
  -- Change on an existing Stripe subscription: keep the current period:
  --   billing_apply_selection(rid, plan, ids, seats, current status, current_period_start, current_period_end, null)
  -- then: subscriptions.stripe_customer_id / stripe_subscription_id / next_billing_at = p_paid_through (first purchase)
  --       / card columns / grace_until null / cancel_at_period_end false (first purchase only);
  --       subscription_items.stripe_subscription_item_id by product_code;
  --       billing_charges of the request -> paid, paid_at now(), stripe_invoice_id;
  --       redemptions reserved -> redeemed; request -> approved, rail 'stripe', paid_at now(),
  --       decision_note 'Paid by card (Stripe)'; billing_log_event('stripe.request_settled').
  -- A plan_limit_exceeded from apply_selection is caught: log 'stripe.settle_failed' (level error) and return
  -- {ok:false, reason:'settle_failed', detail} WITHOUT raising (the webhook must not retry forever).

-- service: a change that will never be paid (pending update expired, checkout expired and replaced, stale).
public.billing_cancel_stripe_request(p_request_id uuid, p_reason text) returns void
  -- pending -> cancelled, charges void, reservation released. No-op when not pending.

-- service: status/flags from a (re-fetched) Stripe subscription. NEVER moves current_period_end (D8).
public.billing_sync_stripe_status(
  p_stripe_subscription_id text, p_status text, p_cancel_at_period_end boolean, p_cancel_at timestamptz,
  p_next_billing_at timestamptz, p_card jsonb) returns jsonb
  -- only for the restaurant whose subscriptions.stripe_subscription_id = p_stripe_subscription_id
  --   (a stale subscription resolves to nothing -> {ok:false, reason:'unknown_subscription'}).
  -- status map: trialing|active -> 'active'; past_due|unpaid -> 'past_due'; canceled -> 'cancelled';
  --   incomplete|incomplete_expired -> unchanged; paused -> 'expired'.
  -- entering past_due sets grace_until = current_period_end + grace_days (only if grace_until is null);
  -- leaving past_due clears grace_until.

-- service: an invoice was paid.
public.billing_record_stripe_invoice(p_invoice jsonb, p_paid_through timestamptz) returns jsonb
  -- p_invoice: {id, subscription, billing_reason, status, amount_due, amount_paid, currency, period_start,
  --             period_end, hosted_invoice_url, paid_at, attempt_count, customer}
  -- upsert billing_invoices (resolve restaurant by subscription id, then by restaurants.stripe_customer_id);
  -- when status='paid' and it belongs to the current subscription:
  --   current_period_end = greatest(current_period_end, p_paid_through), status 'active', grace_until null,
  --   next_billing_at = p_paid_through.

-- service: an invoice payment failed (renewal or change).
public.billing_record_stripe_invoice_failed(p_invoice jsonb) returns jsonb
  -- upsert billing_invoices (status open, attempt_count); if it is a renewal of the current subscription:
  -- status 'past_due', grace_until = coalesce(grace_until, current_period_end + grace_days).

-- service: find the pending request a paid change invoice belongs to.
public.billing_request_for_invoice(p_invoice_id text) returns uuid

-- merchant read (extends the existing one): get_billing_overview(p_restaurant_id) gains
--   billing: { stripe_enabled, rail ('stripe'|'manual'), status, stripe_customer: boolean,
--              next_charge_at, next_charge_amount (= monthly_total), cancel_at_period_end, cancel_at,
--              grace_until, card {brand,last4,exp_month,exp_year} | null,
--              last_invoice {amount_paid,status,paid_at,hosted_invoice_url,billing_reason} | null,
--              pending_request_rail ('stripe'|'manual'|null) }
-- platform read (extends the existing one): list_restaurant_subscriptions() rows gain the same `billing`
--   object plus stripe_customer_id, stripe_subscription_id, open_invoice {amount_due, attempt_count,
--   hosted_invoice_url} | null.
-- list_billing_requests rows gain rail, stripe_checkout_session_id, paid_at.

-- platform read: public.platform_billing_events(p_restaurant_id uuid default null, p_limit int default 50)
--   returns jsonb[] from billing_events (platform admin only), newest first, Connect events excluded
--   (type not like 'account.%' and not like 'payment_intent.%' and not like 'charge.%' and not like 'refund.%').
```

### 3.4 "Stripe-managed"

`billing_is_stripe_managed` is the one definition every guard and every UI flag uses.

## 4. Edge functions

### 4.1 `supabase/functions/_shared/stripe-billing.ts` (pure, imports nothing, unit-tested from apps/admin)

- `STRIPE_API_VERSION = '2025-08-27.basil'` (re-exported from the Connect module's value, or duplicated with a test
  that they match), `EVENT_API_VERSION = '2026-08-26.dahlia'`.
- Catalog identity, stable forever:
  - products: `favornoms_base`, `favornoms_extra_branch`, `favornoms_delivery` (monthly),
    `favornoms_base_setup`, `favornoms_extra_branch_setup`, `favornoms_delivery_setup` (one-time; `price_data` only).
  - recurring price lookup key: `favornoms_<code>_monthly_<cents>` — the amount is in the key, so a price change in
    `billing_products` makes a new Stripe price and never edits an old one; existing subscribers keep their price until
    their items are changed (a later decision for the owner).
  - `productCodeOf(productId)` maps back.
- Pure builders (return `URLSearchParams`-ready flat records) and readers, each with tests:
  - `checkoutSessionParams(ctx, prices, urls, trialEnd, idempotencyKey)`
  - `subscriptionUpdateParams(ctx, currentItems, prices)` (quantities, `deleted` items, `add_invoice_items` with
    `price_data` at net cents + `metadata[billing_charge_id]`, `proration_behavior=always_invoice`,
    `payment_behavior=pending_if_incomplete`, `expand[]=latest_invoice`, `metadata[billing_request_id]`)
  - `billingAnchor(nowMs, trialEndsAt, currentPeriodEnd, status)` → unix seconds or null (D5, the 48 h rule)
  - `subscriptionPaidThrough(sub)` → from `items.data[].current_period_end` (max), or `trial_end` when trialing
  - `invoiceSubscriptionId(inv)` (basil `parent.subscription_details.subscription`, legacy `subscription`)
  - `mapCard(pm)` → `{brand,last4,exp_month,exp_year}` or null
  - `cents(n)` / `dollars(c)`; `isStripeManagedStatus`.
  - Signature verification is imported from `_shared/stripe-connect.ts` (`verifyStripeSignature`, handles several
    `v1` values) — the platform webhook reuses it.

### 4.2 `supabase/functions/stripe-billing/index.ts` (new; verify_jwt on; the caller's JWT is checked in code too)

`POST { action, ... }`, JSON answers, CORS like the other admin-called functions.

| action | caller | does |
|---|---|---|
| `start` `{request_id, branch_id}` | merchant with billing.manage | Dormant (`billing_stripe_enabled()` false or key missing) → 503 `stripe_not_configured` (the request stays a manual request). Otherwise `billing_checkout_context`. **Not Stripe-managed** → ensure customer (`restaurants.stripe_customer_id`, else `POST /v1/customers` with idempotency `billing_customer:<restaurant_id>`, then `billing_set_stripe_customer`), ensure prices, expire the customer's other `open` Checkout sessions, create the session (success `…/b/<branch>/settings/plan?checkout=success&session_id={CHECKOUT_SESSION_ID}`, cancel `…?checkout=cancelled`, origin from `PUBLIC_ADMIN_URL` via the Connect module's `resolveAdminOrigin`; `branch_id` must belong to the restaurant), `billing_mark_request_stripe`, answer `{kind:'checkout', url}`. **Stripe-managed** → update the subscription (D7); `latest_invoice.status` paid (or nothing due) → `billing_settle_stripe_request` now and answer `{kind:'applied'}`; `pending_update` present → `billing_mark_request_stripe(req, null, invoice)` and answer `{kind:'action_required', url: hosted_invoice_url}`. |
| `confirm` `{session_id}` | merchant with billing.manage | Re-reads the session (expand subscription, subscription.default_payment_method); `complete` and paid → settle (idempotent) and answer `{settled:true}`; else `{settled:false, status}`. The page calls it on `?checkout=success` so it does not wait for the webhook. |
| `portal` `{branch_id}` | merchant with billing.manage | Ensures the portal configuration (D10; id kept in `platform_settings.billing.portal_configuration_id`), `POST /v1/billing_portal/sessions` with `configuration`, return URL `…/b/<branch>/settings/plan?portal=return`. `{url}`. |
| `status` | platform admin | Booleans only, never secrets: `{mode, secret_key_set, publishable_key_set, webhook_secret_set, connect_webhook_secret_set, stripe_enabled, account{id, charges_enabled, payouts_enabled, details_submitted, currently_due:int, has_bank}, portal_configured, prices_ready, last_event_at, dashboard_base}` where `dashboard_base = https://dashboard.stripe.com/<acct>/` + `test/` in test mode. |
| `set_enabled` `{enabled}` | platform admin | Turning on requires `secret_key_set && webhook_secret_set`; ensures prices and the portal configuration first. Writes `platform_settings.billing.stripe_enabled` with the service role. |

Platform admin = `user.app_metadata.is_platform_admin === true` from `auth.getUser(jwt)`.

### 4.3 `supabase/functions/stripe-webhook/index.ts` (rewritten; verify_jwt off)

- Signature with `verifyStripeSignature` (shared); `STRIPE_WEBHOOK_SECRET`; ignore `event.account` (Connect);
  dedupe with `stripe_event_seen` / `stripe_event_forget` (shared table, event ids are global); warn on
  `api_version !== EVENT_API_VERSION`; mode check like Connect (`eventMatchesMode`).
- **Every object is re-read by id with the pinned version**; payload fields are never trusted beyond ids.
- Events (the endpoint subscribes to exactly these; never `invoice.created`):
  - `checkout.session.completed` → session (expand subscription + default_payment_method); `mode=subscription`,
    `payment_status in (paid, no_payment_required)` → settle `metadata.billing_request_id`. `request_not_pending` →
    refund the session's invoice payment in full and cancel the subscription now (D12), log
    `stripe.stale_checkout_refunded`. After settling: copy the subscription's default payment method to the
    customer's `invoice_settings.default_payment_method` and clear it on the subscription, so a card changed in the
    portal is the one renewals use.
  - `checkout.session.expired` → if its request is still pending with that session id: leave it pending (the
    merchant can continue or change); log only.
  - `invoice.paid` → invoice; `billing_record_stripe_invoice(inv, subscriptionPaidThrough(sub))`; if a pending request
    waits on this invoice (`billing_request_for_invoice`) → settle it.
  - `invoice.payment_failed`, `invoice.payment_action_required` → `billing_record_stripe_invoice_failed`.
  - `customer.subscription.updated`, `.deleted`, `.pending_update_applied` → re-read the subscription →
    `billing_sync_stripe_status`.
  - `customer.subscription.pending_update_expired` → cancel the request that waited (`billing_cancel_stripe_request`).
  - `customer.subscription.trial_will_end`, `customer.subscription.created` → log only.
  - `customer.updated` → if `invoice_settings.default_payment_method` changed, store the card
    (`billing_sync_stripe_status` with the card only, looked up by the customer's subscription).
- A handler that throws un-marks the event and answers 500; a business refusal (`{ok:false}`) is logged
  and answered 200.

### 4.4 Retired

`stripe-create-checkout-session` and `stripe-billing-portal` are replaced by stubs answering
`410 {error:'moved', use:'stripe-billing'}`; the owner can delete them from the dashboard later.

## 5. Merchant UI (`/b/[branchId]/settings/plan`, dashboard, suspension screen)

- Submit: `requestPackageChange` (unchanged) → if `overview.billing.stripe_enabled`: `startCardPayment(requestId,
  branchId)` → `checkout` redirect / `applied` refresh / `action_required` open Stripe's invoice page /
  dormant → keep the filed request (the manual rail). A failed card start leaves the filed request, and the page says
  the request is waiting for payment with a **Continue to payment** button.
- `?checkout=success&session_id=` → `confirmCheckout` → "Payment received — your package is active" (poll overview
  until `rail === 'stripe'`, max ~20 s, then "Processing…" copy). `?checkout=cancelled` → "Payment cancelled — nothing
  was charged" with Continue to payment. `?portal=return` → refresh.
- Billing card (Stripe rail): next charge date and amount, card brand/last4 and expiry, last invoice with its link,
  **Manage card & invoices** (portal). Banners: **Payment failed** (past_due, until `grace_until`), **Cancels on
  {date}** (cancel_at_period_end), **Waiting for card payment** (pending request with rail stripe).
- Copy for the Stripe rail: the button says what is charged ("Pay $X now"), the footnote says the monthly amount is
  charged to the card automatically, the dashboard's 7-day "goes dark" card is not shown for a Stripe restaurant that
  is not past due (it renews), and the suspension screen's billing button still leads to the plan page.
- New copy lives in `apps/admin/messages/{en,es,th,vi}/settings.json` under `settings.plan.stripe.*`, and in
  `dashboard.json` under `dashboard.stripe.*`.

## 6. Platform console

- **`/platform/billing-setup`** (new tab "Stripe"): a checklist from the `status` action — account connected (mode),
  bank account for payouts (link to `<dashboard_base>settings/payouts`), account activated (link to
  `<dashboard_base>account/onboarding` when `currently_due > 0` or payouts disabled), webhook for package payments
  (link to `<dashboard_base>workbench/webhooks`, the URL to use and the event list to tick), prices ready, customer
  portal, and the switch **Charge packages by card** (`set_enabled`). Plus useful links: failed-payment retries
  (`<dashboard_base>revenue_recovery/retries`), invoices, customers.
- Subscriptions page and the dashboard drawer: a **Card (Stripe)** / **Manual** rail chip, status, next charge, card,
  open invoice (past due), links "Open in Stripe" (`<dashboard_base>customers/<cus>`, `…subscriptions/<sub>`); the
  Apply package / Extend / Convert controls are hidden for Stripe restaurants (the SQL refuses them anyway).
- Requests page: a request with `rail='stripe'` shows **Awaiting card payment** (or **Paid by card** when approved by
  settlement) and has no Approve button; Reject stays.
- Health chips: a Stripe restaurant renews by itself, so "goes dark on {date}" becomes "renews on {date}" unless it is
  past due ("payment failed, grace until {date}").
- New copy in `platform.json` / `platformBilling.json` under `platformBilling.stripe.*` and `platform.stripe.*`.

## 7. What the owner does (once per mode)

1. Stripe Dashboard → **Settings → Payouts**: the bank account the platform's income is paid into (live mode; the
   sandbox needs none).
2. **Workbench → Webhooks → Add destination**, events from **Your account**, URL
   `https://ayyfczidnzxetndiijmv.supabase.co/functions/v1/stripe-webhook`, the events in §4.3; copy its signing secret
   into Supabase secret **`STRIPE_WEBHOOK_SECRET`**.
3. **Billing → Revenue recovery → Retries**: Smart Retries on **within 1 week** (inside our 7-day grace), and after all
   retries fail **cancel the subscription**.
4. `/platform/billing-setup` → **Charge packages by card: On**.

## 8. Tests

- SQL: `supabase/tests/platform_billing_stripe.sql` (inside a transaction that rolls back): settle a first purchase
  (trial → active, paid-through = anchor, charges paid, code redeemed, request approved, items linked), settle a
  change (period kept), duplicate settle, stale settle, cancel request, sync status (all mappings, grace in/out,
  never moves the date), invoice paid moves the date forward only, invoice failed sets grace once, expire tick with
  grace, guards (`stripe_managed` on set_package and approve), overview/list payloads.
- Edge pure module: `apps/admin/src/lib/stripe-billing-edge.test.ts` (params exactness, anchor 48 h rule, paid-through
  from items, invoice subscription id, card mapping, lookup keys).
- UI models: plan page state → banners/buttons, platform rail chip and guards.
- Sandbox end to end (§7 done): a trial restaurant buys with 4242 (one-time now, monthly at trial end), adds a branch
  ($70 + prorated $29 now), opens the portal, and a failed renewal via a test clock.

## 9. Review fixes (2026-09-27)

An adversarial review (8 scopes, each finding independently verified; the verified list is kept in the session
scratchpad as `review-verified.json`) confirmed 43 defects. They are fixed by migration
`20260927100000_platform_billing_stripe_fixes.sql` and the edge/UI changes below. The rules they add:

### 9.1 Deadlines (money-sql-5, money-sql-7)
- One helper, `private.billing_deadline(...)`, used by both `billing_compute` and `billing_expire_tick`:
  - a Stripe row (`stripe_subscription_id` not null) that is `active` or `past_due`:
    `greatest(current_period_end + grace_days, grace_until, trial_ends_at)` — Stripe charges a renewal up to ~1 h
    (72 h worst case) after the period ends, and its failure must land while the restaurant is still on the Stripe
    rail, so the grace window always follows a Stripe period end;
  - a Stripe row that is `cancelled`: `greatest(current_period_end, grace_until)`;
  - every other row: as before.
- Owner setting (§7.3): Smart Retries **within 1 week**, then cancel — so Stripe stops retrying no later than our grace.

### 9.2 One live subscription per restaurant (money-sql-2, WH-1, ME-2, money-sql-3, WH-8)
- `openCheckout` first cancels any Stripe subscription still stored on the row (when Stripe says it is not
  already `canceled`/`incomplete_expired` and its `metadata.restaurant_id` matches), without proration, and voids its
  open invoices. Settling a first purchase that replaces a different subscription id returns
  `replaced_subscription_id`; the caller cancels it too (defence in depth).
- The manual rail (approval, `billing_set_package`) applied to a row that is **not** Stripe-managed clears the
  row's Stripe subscription id, item ids, cancel flags, `grace_until` and `next_billing_at`, so a dead subscription
  can never make the row "Stripe-managed" again.

### 9.3 A change waiting on its invoice cannot be replaced or rejected (money-sql-1, ME-1, SP-3, WH-2, WH-3, ui-platform-1)
- `request_package_change` and `decide_billing_request(reject)` refuse `payment_in_progress` while the restaurant's
  pending request is `rail='stripe'` with a `stripe_invoice_id` (a subscription change waiting on 3-D Secure or a
  declined card). The merchant finishes paying on Stripe's page (`billing_requests.stripe_invoice_url`, shown on the
  plan page), or Stripe discards the change after ~23 h (`pending_update_expired` → the request is cancelled and that
  invoice voided).
- `billing_request_for_invoice` returns the request whatever its status. An invoice paid for a request that is not
  pending is refunded, and for a change the subscription's quantities are put back (proration none); logged at
  error level.
- `pending_update_expired` cancels only the request whose `stripe_invoice_id` is the event's `latest_invoice`.
- Checkout requests (first purchase, no invoice) can still be replaced or rejected: other open sessions are expired
  and a late payment is refunded (D12).

### 9.4 Retrying never charges twice (SP-2, ME-5, ME-4, ME-7)
- A subscription change sends the **full target** (every item with its target quantity, `deleted` for zero) plus the
  fees, with the idempotency key `billing_change:<request_id>` (no parameter fingerprint): a retry replays Stripe's
  first answer instead of charging again. The invoice id and URL are stored on the request **before** settling.
- Before changing, a request that already has a `stripe_invoice_id` is resolved from that invoice (paid → settle;
  open → its page; void → the request is cancelled and the merchant told to try again). A Stripe idempotency error is
  resolved the same way from the subscription's latest invoice.
- Checkout: the idempotency key includes the previous session id; a replayed session that is not `open` is never
  handed out, and only sessions other than the one returned are expired.

### 9.5 Money taken but not applied is given back (money-sql-4, ME-3, ME-6)
- `billing_checkout_context` refuses `plan_limit_exceeded` (seats below active branches) **before** anything is
  charged.
- If settling still fails after payment: a first purchase is refunded and its subscription cancelled; a change is
  refunded and its quantities reverted. The merchant sees `charged_refunded` ("your card was charged and the money is
  being returned"), never "nothing was charged".

### 9.6 Stripe and our bill agree (money-sql-6, ui-platform-4)
- Hiding, moving or deleting a branch that has active delivery on a Stripe-managed restaurant is refused
  (`stripe_delivery_active`): turn delivery off for that branch on the plan page first (which updates Stripe).
- `subscriptions.stripe_monthly_amount` is Stripe's recurring total (sum of the subscription's recurring items), set
  at settlement and on every sync; the next charge shown on the Stripe rail is that amount.

### 9.7 Stripe ids and the card are private (SEC-SQL-1, SEC-SQL-2, SEC-EDGE-1)
- New table `billing_stripe_customers(restaurant_id pk, stripe_customer_id unique, card_brand, card_last4,
  card_exp_month, card_exp_year, updated_at)`, RLS on with no policies (service role and SECURITY DEFINER readers
  only). It replaces `restaurants.stripe_customer_id` (publicly readable) and the card columns on `subscriptions`
  (readable by all staff), which are emptied and no longer written.

### 9.8 Webhook robustness (WH-4, WH-5, WH-6, WH-7, money-sql-8)
- Only a 404 on a re-read is a business refusal (logged, 200); any other Stripe failure is retried (500).
- Events are claimed with a lease: `stripe_event_claim(id, type, lease_seconds)` (a `received` row older than the
  lease can be claimed again) and marked `handled` with `stripe_event_done(id)` on success.
- A refunded stale-checkout invoice is marked `refunded` (`billing_mark_invoice_refunded`) and the merchant's
  "last invoice" only considers paid invoices of the current subscription. The refund log says what really happened.
- The dormant `stripe_sync_subscription` (the free-month bug) loses its service-role grant.

### 9.9 Settings, switch-off and UI (SEC-EDGE-2, SEC-EDGE-3, UIM-*, ui-platform-*)
- `platform_settings.billing` is changed only through `billing_settings_merge(patch)` (atomic `billing || patch`).
- The switch controls **new** card purchases only: a restaurant already on the Stripe rail keeps renewing, can change
  its package through Stripe and open the portal while the switch is off.
- `cancel_at` counts as cancelling everywhere (no "next charge", a "cancels on" banner).
- `entitlements_json` gains `billing_rail` so the dashboard does not warn managers of a card restaurant that renews.
- The UI follows any https URL the function returns (Stripe custom domains), maps every function error code, treats a
  stale `?checkout=success` as over, and uses the same anchor rule as the edge (48 h + 10 min margin).

## 10. Second review fixes (2026-09-27)

A focused re-review of §9 confirmed 20 more defects (1 high, none critical; `rereview-verified.json` in the session
scratchpad). Fixed by migration `20260927200000_platform_billing_stripe_fixes_2.sql` and the edge/UI changes:

1. **A card change lock always ends (money-rr-1, edge-rr-1).** `billing_requests.stripe_invoice_marked_at` is set when a
   request is tied to an invoice, and `stripe_change_started_at` just before the subscription update is sent. Both
   `payment_in_progress` refusals treat a lock older than 23 h as released: the old request is cancelled (charges void,
   code released) and a late payment of its invoice is refunded by the webhook (§9.3). The plan page calls `start`
   (not just a link) for a request waiting on an invoice, so an expired invoice is voided and the request cancelled.
2. **Paid invoices of a subscription that is not the restaurant's current one are refunded and it is cancelled**
   (money-rr-2): a renewal (`subscription_cycle`) or change (`subscription_update`) invoice paid for a subscription no
   restaurant row holds — for example one the manual rail detached while Stripe was still retrying. First invoices
   (`subscription_create`) are left to `checkout.session.completed`.
3. **Delivery follows active branches (money-rr-3).** `billing_apply_selection` only switches delivery on for active
   branches; hiding a branch on a Stripe-managed restaurant (a platform admin can) switches its delivery add-on off, so
   showing it again never grants unbilled delivery.
4. **A change is found even if its invoice id was never stored (money-rr-4)**: the in-flight marker locks the request,
   the mark after a paid change is retried (hard failure), and `invoice.paid` falls back to the request id on the
   invoice's fee lines.
5. **A change paid for a row that is no longer Stripe-managed is refunded and reverted (money-rr-7)**, never settled as
   a first purchase.
6. **Idempotency in use (409) is "busy, try again", not a conflict (edge-rr-3).**
7. **Events: claimed / handled / in flight (SEC-R2-2, money-rr-6).** `stripe_event_claim` reports which; an in-flight
   delivery answers 409 so Stripe retries after the lease. Stripe calls time out after 20 s.
8. **`cancel_at` counts as cancelling only when it falls on or before the next renewal (ui-rr-2).**
9. **Undo is exact (money-rr-5, money-rr-8, edge-rr-2, edge-rr-4):** a fee invoice is created first and its items
   attached to it (nothing leaks onto the next renewal); undoing a downgrade reverses its customer-balance credit; the
   answer says what happened (`charged_refunded` only when fully refunded, `charged_not_applied` when a refund failed,
   `change_not_applied` when nothing was charged).
10. **Smaller:** the card-sync idempotency key includes the event id (edge-rr-5); `get_pending_billing_request` hides
    Stripe ids and URLs from staff without billing.manage (SEC-R2-1); `entitlements_json` gains `billing_ends_at` so
    managers see a cancelling card restaurant's end date (ui-rr-3); the return page and the pending-request logic
    read every answer truthfully (ui-rr-1, ui-rr-4); the switch-off copy matches what the Requests page allows (ui-rr-5).
