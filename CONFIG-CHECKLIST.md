# Favornoms — Operational Config Checklist (🇺🇸 US)

> Things that can't be applied via SQL/migrations. You must click through Supabase Dashboard / Stripe Dashboard / set env vars.
>
> Project ref: `ayyfczidnzxetndiijmv` · Region: `us-east-1`
> Dashboard: https://supabase.com/dashboard/project/ayyfczidnzxetndiijmv
>
> Region corrected 2026-08-29: this said `ap-southeast-1`, which is wrong and had been
> copied into other docs. Verified against the live project.

---

## TL;DR — blocks real users

- [ ] §1 Auth redirect URLs (1 min) — **still unticked as of 2026-08-29, and it is the
      reason merchant sign-in links land on the customer marketing site**
- [ ] §1b Custom SMTP — the built-in mailer is rate-limited and silently drops invites
- [ ] §2 Auth SMS provider (Twilio creds)
- [ ] §3 Auth password policies (1 toggle)
- [ ] §4 Auth Custom Access Token Hook (1 toggle)
- [ ] §5 **Deploy 7+ edge functions via CLI** (~5 min — see §5)
- [ ] §6 Edge Function secrets — Stripe + AI + Resend + VAPID + Sentry
- [ ] §7 `private.app_settings` SQL insert (1 paste)
- [ ] §8 Stripe webhooks in Stripe Dashboard — two endpoints: platform billing (§8a) and
      Connect, for diners' card payments (§8b)
- [ ] §9 Per-branch `sales_tax_rate` in admin app
- [ ] §10 App `.env.local` files
- [x] §11 Mount Stripe `<PaymentElement>` — done with Stripe Connect (2026-09-24); see §11

---

## 1. Auth → URL Configuration

**Dashboard → Authentication → URL Configuration**
https://supabase.com/dashboard/project/ayyfczidnzxetndiijmv/auth/url-configuration

### What goes wrong when this is skipped

GoTrue does not error on an unlisted `redirect_to` — it **silently discards it and uses the
Site URL instead**. Site URL is the customer storefront, so a merchant who asked for a
sign-in link on `localhost:3004` (or on the admin domain) gets mailed a link that lands on
the *diner marketing page*, carrying `?error=access_denied&error_code=otp_expired`. Nothing
in the merchant app is broken at that point and nothing logs an error; the click just goes
somewhere else. This was reported as "I click the email and it bounces me to the home page"
on 2026-08-29 and is exactly this setting.

Password sign-in (now the default on `/login`) does **not** depend on this list. Magic
links, staff invitations, and password resets all do.

### Measured state, 2026-08-29

Probed directly rather than assumed. `GET /auth/v1/verify` with a deliberately bogus token
redirects to `redirect_to` when that URL is on the list and to the Site URL when it is not,
so the list can be read back without sending a single email:

```
curl -s -o /dev/null -w '%{redirect_url}\n' \
  "$SUPABASE_URL/auth/v1/verify?token=bogus&type=recovery&redirect_to=<url-encoded>"
```

| URL | On the list? |
|---|---|
| `http://localhost:3000/**` | yes |
| `http://localhost:3001/**` | **NO** |
| `http://localhost:3004/**` | **NO** |
| `https://restaurant-white-label-web.vercel.app/**` | yes (also the Site URL) |
| `https://restaurant-white-label-admin.vercel.app/**` | yes |
| `https://restaurant-white-label-admin-git-main-boyproject.vercel.app/**` | yes |
| `https://restaurant-white-label-driver.vercel.app/**` | yes |
| `https://evil.example.com/` | no — the list is doing its job |

So **production is already configured correctly**; nothing needs adding there. Once an
admin build carrying `/auth/callback` is live, merchant magic links, staff invitations and
password resets work on the Vercel domain with no dashboard change at all.

Only local development is missing, and only two lines of it:
```
http://localhost:3001/**
http://localhost:3004/**
```
Without them, `localhost:3004` sign-in links land on the customer storefront — which is the
whole of the 2026-08-29 report. Add each merchant's custom domain as it is issued.

**Site URL:** the customer storefront —
`https://restaurant-white-label-web.vercel.app` today. Leave it pointing at the storefront:
it is the fallback for links whose target is not on the list, and a diner landing on the
storefront is the least-wrong outcome.

---

## 1b. Auth → Custom SMTP

**Dashboard → Project Settings → Authentication → SMTP Settings**

The project is still on Supabase's **built-in** mailer, which is documented as a low
hourly cap for development only. Measured on 2026-08-29: a single signup attempt returned
`429 over_email_send_rate_limit`.

Every one of these goes through that mailer:
- staff invitations (`invite-staff` → `inviteUserByEmail`)
- password resets (`/forgot-password`)
- magic links (`/login` → "Email me a link instead")
- signup confirmation (email confirmation is **on** for this project)

A restaurant onboarding its 7 staff in one sitting will hit the cap partway through, and the
failures are near-silent — the UI says "check your inbox" because GoTrue accepted the
request; the mail simply never arrives. Configure a real sender (Resend is already a
dependency for order mail, and `RESEND_API_KEY` is in §6) before handing over to a client.

---

## 2. Auth → SMS Provider

**Dashboard → Authentication → Providers → Phone** → Twilio:
- `Twilio Account SID`
- `Twilio Auth Token`
- `Twilio Message Service SID` (or sender phone)

---

## 3. Auth → Password Settings

**Dashboard → Authentication → Policies → Password Security**

- [ ] Enable **Leaked Password Protection**

---

## 4. Auth → Hooks → Custom Access Token

**Dashboard → Authentication → Hooks → Custom Access Token**

- Toggle **ON**
- Function: `public.custom_access_token_hook`

Verify with browser console:
```js
const { data: { session } } = await supabase.auth.getSession();
JSON.parse(atob(session.access_token.split('.')[1]));
// Should show branch_ids and restaurant_ids
```

---

## 5. Deploy edge functions

**Currently ACTIVE on remote:** place-order v4, dispatch-driver, create-payment-source (Omise legacy), omise-webhook (legacy), invite-staff, notify-worker v3, import-menu v2, parse-voice-order v2, issue-tax-invoice v1 (Thai E-Tax XML), export-csv

**Needs deploy from local source:**

```bash
# These need an UPGRADE (source is newer than active version)
supabase functions deploy place-order            # v4 → v8 (modifiers + combos + happy hour + scheduling + gift cards)
supabase functions deploy notify-worker          # adds gift_card_issued, birthday_reward, abandoned_cart, waitlist_ready templates
supabase functions deploy issue-tax-invoice      # Thai E-Tax XML → US HTML receipt

# Stripe. They ship DORMANT: with no STRIPE_SECRET_KEY set they return 503
# stripe_not_configured, and the plan page falls back to the manual
# request queue. Setting the secrets in §6 is what switches them on; the two
# subscription functions also need STRIPE_BILLING_ENABLED=true (§6).
# Diners' card payments go to each BRANCH's own connected Stripe account
# (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md). Apply migrations 20260925100000,
# 20260925110000 and 20260925120000 BEFORE deploying the order-payment functions.
supabase functions deploy stripe-create-payment-intent   # diner card payment → the branch's connected account
supabase functions deploy stripe-refund                  # back-office refunds, and the refund a cancel of a paid card order makes
supabase functions deploy stripe-connect-onboard         # a branch connects its own Stripe account
supabase functions deploy stripe-connect-webhook --no-verify-jwt  # §8b; verify_jwt MUST be false
supabase functions deploy stripe-webhook --no-verify-jwt # §8a, platform billing only; verify_jwt MUST be false
supabase functions deploy stripe-create-checkout-session # subscriptions   → platform's Stripe
supabase functions deploy stripe-billing-portal          # merchant self-manages card / cancels
supabase functions deploy integration-sync       # DoorDash/UberEats/QuickBooks worker (stubbed)
supabase functions deploy ai-chat-support        # Claude customer chatbot
supabase functions deploy ai-review-response     # Brand-voiced review replies
supabase functions deploy ai-menu-optimize       # Menu sales/pricing analysis
```

If you don't have the CLI:
```bash
npm i -g supabase
supabase login
supabase link --project-ref ayyfczidnzxetndiijmv
```

**Optional cleanup** — these are legacy and can be deleted from the Dashboard:
- `create-payment-source` (Omise)
- `omise-webhook` (Omise)

---

## 6. Project Settings → Edge Function Secrets

**Dashboard → Project Settings → Edge Functions → Secrets**

### 💳 Stripe (required for live payments)
| Key | Where to get |
|-----|--------------|
| `STRIPE_SECRET_KEY` | dashboard.stripe.com → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | After creating the platform webhook (see §8a) |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | After creating the Connect webhook (see §8b) |
| `STRIPE_PUBLISHABLE_KEY` | API keys. The storefront gets it from `stripe-create-payment-intent`, so no app env is needed |
| `STRIPE_BILLING_ENABLED` | Leave unset. `true` moves Confirm package to Stripe Checkout; see below |

> **Two different money flows share these keys — don't confuse them.**
> - *Subscriptions* (Base $199 / +$99 branch / +$49 Delivery / +$59 AI Suite) are
>   billed by **the platform** to the restaurant, on **our** Stripe account.
>   This flow is fully built.
> - *Order payments* are **direct charges on each branch's own connected Stripe
>   account** (Stripe Connect, owner decision 2026-09-24,
>   `docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md`). The payment function refuses to charge
>   without the branch's connected account, so a diner's money never reaches the
>   platform's balance, and the platform takes no cut. Each branch connects its account
>   under Branch settings → Card payments. Their events go to the Connect endpoint (§8b).

**Setting the keys does not switch on subscription checkout.** `STRIPE_SECRET_KEY` is also
what diners' card payments need, so the subscription functions (`stripe-create-checkout-session`,
`stripe-billing-portal`) stay dormant, and Confirm package keeps filing a request for manual
approval, until a separate secret `STRIPE_BILLING_ENABLED=true` is set. Leave it unset: that
flow charges neither the one-time fees ($170 base, $70 extra branch) nor a discount code yet, and
every row in `billing_products` ships with `stripe_price_id = NULL`, which it refuses with
`400 product_missing_stripe_price` (naming the product). Switched on with the prices still
missing, every Confirm package would fail instead of reaching the request queue.

To switch on (after the one-time fees and discount codes are built into it):
1. In Stripe, create one **recurring monthly USD Price** per sellable product —
   `base` $199, `extra_branch` $99, `delivery` $49, `ai_suite` $59.
   Do **not** create one for `trial`; it is granted, never purchased.
2. Paste each Price ID into the catalog (platform admin → Plans, or directly):
   ```sql
   select public.upsert_billing_product(
     p_code => 'base', p_stripe_price_id => 'price_...', /* other args unchanged */);
   ```
3. Verify none are left unmapped:
   ```sql
   select code, kind, monthly_price from public.billing_products
   where is_active and stripe_price_id is null and code <> 'trial';
   -- must return 0 rows
   ```
Prices must be **recurring**, not one-off: a one-off Price makes Checkout reject
the session in `subscription` mode.
4. Set `STRIPE_BILLING_ENABLED=true` (and `STRIPE_WEBHOOK_SECRET`, §8a).

### 🤖 AI (required for chatbot, menu import, voice order, review responder, menu optimizer)
| Key | Where to get |
|-----|--------------|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `ANTHROPIC_MODEL` *(optional)* | defaults to `claude-haiku-4-5-20251001` |

### 📬 Notifications
| Key | Where to get |
|-----|--------------|
| `NOTIFY_WORKER_SECRET` | Random string — must match `private.app_settings` (§7) |
| `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` | `node scripts/generate-vapid-keys.cjs` |
| `VAPID_SUBJECT` *(optional)* | `mailto:ops@favornoms.com` |
| `RESEND_API_KEY` | resend.com |
| `RESEND_FROM` *(optional)* | `Favornoms <orders@favornoms.com>` |
| `TWILIO_ACCOUNT_SID` | Same as §2 |
| `TWILIO_AUTH_TOKEN` | Same as §2 |
| `TWILIO_PHONE_NUMBER` | Same as §2 |

### 🐛 Error tracking (optional)
| Key | Where to get |
|-----|--------------|
| `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` | sentry.io project |
| `SENTRY_ORG` + `SENTRY_PROJECT` + `SENTRY_AUTH_TOKEN` | For CI source-map upload |

### 🧾 Receipts (optional)
| Key | Description |
|-----|-------------|
| `RECEIPT_SELLER_NAME` | Overrides branch name in printed receipt |
| `RECEIPT_SELLER_ADDRESS` | Overrides branch address |
| `RECEIPT_SELLER_PHONE` | Shown in receipt header |

### 🗑 Legacy (can delete)
- `OMISE_*` — Omise integration retired
- `ETAX_*` — Thai E-Tax replaced with US receipt HTML

### 🔒 Auto-injected (don't set)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`

---

## 7. SQL — `private.app_settings`

Paste once in **Dashboard → SQL Editor**:
```sql
insert into private.app_settings(key, value) values
  ('supabase_url',         'https://ayyfczidnzxetndiijmv.supabase.co'),
  ('service_role_key',     '<paste service_role key from API settings>'),
  ('notify_worker_url',    'https://ayyfczidnzxetndiijmv.supabase.co/functions/v1/notify-worker'),
  ('notify_worker_secret', '<same as NOTIFY_WORKER_SECRET env>')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

---

## 8. Stripe Dashboard — Create the two webhooks

**dashboard.stripe.com → Developers → Webhooks → Add endpoint**, twice. The two endpoints
receive different events and have different signing secrets; do not tick one event on both.

Both use **API version** `2025-08-27.basil`, pinned in every function we ship. If an
endpoint is created on a different version the handler still runs, but the platform one
logs a `stripe.api_version_mismatch` row into `billing_events`; check there first if a
handler goes quiet. Signatures older than **300s** are rejected, so the Supabase project
clock must be sane. A "bad_signature" storm with a correct secret is a clock-skew symptom.

### 8a. Platform billing — the platform charges the restaurant

- **Events from:** Your account
- **Endpoint URL:** `https://ayyfczidnzxetndiijmv.supabase.co/functions/v1/stripe-webhook`
- **Events to send (9)**, as listed in the header of `supabase/functions/stripe-webhook/index.ts`:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `customer.subscription.trial_will_end`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `invoice.payment_action_required`
  - `invoice.marked_uncollectible`
- Copy the **Signing secret** → paste as `STRIPE_WEBHOOK_SECRET` in §6.
- An endpoint created before 2026-09-24 may still have `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.refunded` and `charge.dispute.created` ticked.
  Untick them: diners' payments are no longer on the platform's account, and this endpoint
  answers them 200 and ignores them.

### 8b. Connect — diners pay each branch's own Stripe account

- **Events from:** Connected accounts
- **Endpoint URL:** `https://ayyfczidnzxetndiijmv.supabase.co/functions/v1/stripe-connect-webhook`
- **Events to send (14)**, as listed in the header of
  `supabase/functions/stripe-connect-webhook/index.ts`:
  - `account.updated`
  - `account.application.deauthorized`
  - `payment_intent.succeeded`
  - `payment_intent.payment_failed`
  - `payment_intent.canceled`
  - `payment_intent.processing`
  - `charge.refunded`
  - `refund.created`
  - `refund.updated`
  - `refund.failed`
  - `charge.dispute.created`
  - `charge.dispute.updated`
  - `charge.dispute.closed`
  - `charge.dispute.funds_withdrawn`
- Copy the **Signing secret** → paste as `STRIPE_CONNECT_WEBHOOK_SECRET` in §6.
- Without this endpoint a diner's card payment is still confirmed by the order page's own
  re-check, but a branch never becomes "ready to take cards" by itself, refunds and disputes
  made in a branch's Stripe Dashboard are never recorded, and a payment that lands after its
  order expired is not refunded automatically.

---

## 9. Per-branch sales tax

Sign into admin (`localhost:3004`) → pick branch → **Branch settings → Sales tax** → enter rate as percent (`8.875` for NYC, `9.5` for LA). Defaults to 0% so existing branches don't break.

---

## 10. App `.env.local` files

Paste into `apps/web/.env.local` + `apps/driver/.env.local`:
```env
NEXT_PUBLIC_SUPABASE_URL=https://ayyfczidnzxetndiijmv.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<from Dashboard → Project Settings → API → publishable>
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<same as VAPID_PUBLIC_KEY>
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=<pk_test_…>
NEXT_PUBLIC_SENTRY_DSN=<optional>
NEXT_PUBLIC_SITE_URL=<your prod domain>
```

(Apex / admin / kds / pos only need the first two — and Sentry DSN if you want client-side capture there.)

---

## 11. Mount Stripe Elements properly — DONE (2026-09-24)

Superseded by Stripe Connect (`docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md`): the checkout and the
order page mount Stripe's Payment Element for the branch's connected account, and
`stripe-refund` refunds on that account from the back office, including when a paid card order
is cancelled or rejected. What follows is kept as history only; do not follow it.

Former state: `<StripePayment>` loaded Stripe.js from a CDN and called `confirmCardPayment`, with **no `<PaymentElement>` mounted**.

**To finish:**
```bash
cd apps/web
pnpm add @stripe/stripe-js @stripe/react-stripe-js
```

Then in `apps/web/src/app/r/[restaurant]/[branch]/orders/[orderNumber]/_components/order-tracking.tsx`, replace the `StripePayment` component implementation to:
1. Use `loadStripe()` from `@stripe/stripe-js`
2. Wrap `<Elements stripe={stripePromise} options={{ clientSecret }}>`
3. Use `<PaymentElement />` for the card UI
4. Call `stripe.confirmPayment({ elements, confirmParams: { return_url } })`

Also add a `stripe-refund` edge function so admin Refund actually issues a Stripe refund, not just a DB update. Easy: call `POST https://api.stripe.com/v1/refunds` with the order's `payment_intent_id`.

---

## 12. Realtime → Replication

**Dashboard → Database → Replication → `supabase_realtime`**

Already added by migrations:
- `orders`, `order_items`, `deliveries`, `delivery_messages`, `notifications_outbox`, `menu_items`

**Optional adds if you want live updates:**
```sql
alter publication supabase_realtime add table public.tax_invoices;
alter publication supabase_realtime add table public.tables;
```

---

## 13. pg_cron schedules

Already scheduled by migrations:
- `notify-worker-tick` — every minute
- `daily-loyalty-housekeeping` — daily 06:00 UTC (refresh tiers + birthday rewards)
- `abandoned-cart-sweep` — every 15 minutes

**Optional add** for the integration-sync worker once deployed:
```sql
select cron.schedule(
  'integration-sync-tick',
  '*/5 * * * *',
  $$ select net.http_post(
    url := 'https://ayyfczidnzxetndiijmv.supabase.co/functions/v1/integration-sync',
    headers := jsonb_build_object('Authorization', 'Bearer <service_role_key>')
  ); $$
);
```

---

## 14. Smoke test after config

Walk through `docs/SMOKE-TEST.md`. The flows cover every feature class shipped this session. Use Stripe test card `4242 4242 4242 4242`.

If any step fails, check the corresponding section here.
