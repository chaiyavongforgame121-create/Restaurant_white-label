# Favornoms — Operational Config Checklist (🇺🇸 US)

> Things that can't be applied via SQL/migrations. You must click through Supabase Dashboard / Stripe Dashboard / set env vars.
>
> Project ref: `ayyfczidnzxetndiijmv` · Region: `ap-southeast-1`
> Dashboard: https://supabase.com/dashboard/project/ayyfczidnzxetndiijmv

---

## TL;DR — blocks real users

- [ ] §1 Auth redirect URLs (1 min)
- [ ] §2 Auth SMS provider (Twilio creds)
- [ ] §3 Auth password policies (1 toggle)
- [ ] §4 Auth Custom Access Token Hook (1 toggle)
- [ ] §5 **Deploy 7+ edge functions via CLI** (~5 min — see §5)
- [ ] §6 Edge Function secrets — Stripe + AI + Resend + VAPID + Sentry
- [ ] §7 `private.app_settings` SQL insert (1 paste)
- [ ] §8 Stripe webhook in Stripe Dashboard
- [ ] §9 Per-branch `sales_tax_rate` in admin app
- [ ] §10 App `.env.local` files
- [ ] §11 **(Optional)** Mount Stripe `<PaymentElement>` properly — see HANDOFF.md §8

---

## 1. Auth → URL Configuration

**Dashboard → Authentication → URL Configuration**

Add to **Redirect URLs**:
```
http://localhost:3000/**
http://localhost:3001/**
http://localhost:3002/**
http://localhost:3003/**
http://localhost:3004/**
```
Plus your production domain (e.g. `https://app.favornoms.com/**`).

**Site URL:** `http://localhost:3000` for dev, prod domain for prod.

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

# These are BRAND NEW
supabase functions deploy stripe-create-payment-intent
supabase functions deploy stripe-webhook
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
| `STRIPE_WEBHOOK_SECRET` | After creating webhook (see §8) |
| `STRIPE_PUBLISHABLE_KEY` | API keys (also set as `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in app envs) |

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

## 8. Stripe Dashboard — Create webhook

**dashboard.stripe.com → Developers → Webhooks → Add endpoint**

- **Endpoint URL:** `https://ayyfczidnzxetndiijmv.supabase.co/functions/v1/stripe-webhook`
- **Events to send:**
  - `payment_intent.succeeded`
  - `payment_intent.payment_failed`
  - `charge.refunded`
- Copy the **Signing secret** → paste as `STRIPE_WEBHOOK_SECRET` in §6.

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

## 11. Mount Stripe Elements properly (deferred — see HANDOFF §8)

Current state: `<StripePayment>` component loads Stripe.js from CDN and calls `confirmCardPayment`. There's **no `<PaymentElement>` mounted**, so customers can't enter card details end-to-end.

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
- `orders`, `order_items`, `deliveries`, `notifications_outbox`, `menu_items`, `reservations`, `broadcasts`

**Optional adds if you want live updates:**
```sql
alter publication supabase_realtime add table public.tax_invoices;
alter publication supabase_realtime add table public.waitlist;
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
