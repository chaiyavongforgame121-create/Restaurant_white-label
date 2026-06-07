# 🇺🇸 US Launch Plan — Sprint Plan (1 week, solo dev)

> **CRITICAL CONTEXT FOR NEW SESSION:** โปรเจกต์นี้กำลัง pivot จาก Thai market → US SaaS
> Read this FIRST before touching any code.

---

## 🎯 Decisions made (locked in)

| | Decision | Why |
|---|---|---|
| 🌐 | Market: **US (English primary)** | User pivoted from Thai market |
| 🗣 | Language: **EN only** | Simple MVP — no other locale yet |
| 💰 | Currency: **USD** | Drop THB hardcoding everywhere |
| 💳 | Payment: **Stripe** | Standard in US, supports Apple/Google Pay |
| 📄 | Tax: **US sales tax** (state-specific) | Drop Thai E-Tax (RD XML) |
| 📱 | Phone: **E.164 international** | Drop +66/08x specific format |
| 📍 | Address: **US format** (street, city, state, zip) | Drop district/province |
| 🕐 | Timezone: **America/New_York** default | Drop Asia/Bangkok |
| ⚖️ | Compliance: **CCPA** + state laws | Drop PDPA (Thai) |
| 🍔 | Mock data: **American casual** (Coastal Grill / Bella Burger / etc.) | Replace Somtam Zab |
| 📅 | Timeline: **1 week** | Solo dev, aggressive |
| 🧑 | Team: **1 person** (user) | Solo, prioritize ruthlessly |
| 🏪 | Business model: **Open SaaS** — restaurants self-signup | Public landing + onboarding wizard |

---

## 📋 Sprint plan (8 tasks × ~1 day each)

### US-1: Localization sweep (Day 1) ← in_progress when session ended

**Locations of THB / Thai-isms found:**

```
packages/shared/src/utils/index.ts:8     formatCurrency default 'THB'
packages/shared/src/mock/index.ts:1-322   ENTIRE Somtam Zab mock data
packages/shared/src/utils/utils.test.ts:24 THB tests
packages/ui/src/printer/html-fallback.ts:14 currency 'THB'
packages/ui/src/printer/escpos.ts:123,129  currency 'THB'
packages/database/src/queries/tenant.ts:91 currency ?? 'THB'

apps/web/src/app/r/[restaurant]/[branch]/reserve/_components/reserve-view.tsx:49  Asia/Bangkok comment
apps/admin/src/app/b/[branchId]/reports/_components/reports-view.tsx:240         Asia/Bangkok
apps/admin/src/app/b/[branchId]/menu/_components/menu-manager.tsx:298            "Price (THB)"
apps/admin/src/app/b/[branchId]/orders/_components/order-row-actions.tsx:126     "Amount (THB)"
apps/admin/src/app/b/[branchId]/menu/import/_components/menu-import-view.tsx:171 "Northern Thai cuisine, prices in THB"
apps/admin/src/app/b/[branchId]/promos/_components/promos-manager.tsx:101,106,110 THB labels
apps/driver/src/app/app/earnings/page.tsx:101                                    "Amount (THB)"

supabase/functions/parse-voice-order/index.ts:63                                 "${m.price} THB"
supabase/functions/import-menu/index.ts:90                                       "Thai Baht (THB)"
supabase/functions/notify-worker/index.ts:292                                    "${earnings} THB"
supabase/functions/issue-tax-invoice/index.ts:113-123                            currencyID="THB" (5 places)
```

**Thai language files to delete:**
```
apps/{admin,driver,kds,pos,web}/messages/th.json
```

**Actions:**
1. ✏️ Rewrite `packages/shared/src/mock/index.ts` — American casual restaurant
   - Restaurant: "Coastal Grill" or similar
   - Branch: "Brooklyn" or similar US location
   - Menu: burgers, fries, milkshakes, salads, wings, etc.
   - Driver: American name, US phone format
2. ✏️ `packages/shared/src/utils/index.ts` — change `formatCurrency` default `'THB'` → `'USD'`
3. ✏️ `packages/database/src/queries/tenant.ts` — `currency ?? 'USD'`
4. ✏️ `packages/ui/src/printer/*.ts` — currency default `'USD'`
5. ✏️ `packages/shared/src/utils/utils.test.ts` — update tests for USD
6. ✏️ Admin UI labels: "THB" → "$" or "USD"
7. ✏️ Edge function prompts: drop "Thai Baht" references, use "USD"
8. ✏️ Drop all `th.json` files
9. ✏️ Drop `zh.json` files (EN only)
10. 🗄️ Migration: update default `branches.settings` to include USD + America/New_York
11. 🗄️ Migration: re-seed (or wipe + reseed) with American casual data
12. ✏️ Update i18n configs in each app — drop 'th' and 'zh' from locales

**Phone format:**
- Remove `08x-xxx-xxxx` placeholder, use `(555) 555-5555` or E.164 `+1234567890`
- Update `auth.ts` if hardcoded TH country code

**Address format:**
- `customer_addresses` table currently has `district`, `province`, `postal_code`
- Keep schema (works for international), but update form labels: "city", "state", "ZIP"
- Update checkout-view input labels

---

### US-2: Stripe payment integration (Day 2)

**Files to change:**
- Replace `supabase/functions/create-payment-source/index.ts` → `stripe-create-payment-intent/index.ts`
- Replace `supabase/functions/omise-webhook/index.ts` → `stripe-webhook/index.ts`
- Update `place-order` edge fn: `payment_method` enum from `card/promptpay/cash` to `card/cash` (drop PromptPay)
- Add Stripe.js script tag in `apps/web` checkout
- Stripe Elements for card collection

**Env vars to add:**
```
STRIPE_SECRET_KEY=sk_test_...     (set in Supabase Edge Function Secrets)
STRIPE_WEBHOOK_SECRET=whsec_...   (after creating webhook in Stripe Dashboard)
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...   (in apps/web/.env.local)
```

**Stripe webhook endpoints needed:**
- `payment_intent.succeeded` → update payments.status='completed' + orders.status='confirmed'
- `payment_intent.payment_failed` → update payments.status='failed'
- `charge.refunded` → reconcile with refund_order RPC

**Drop:**
- Omise SDK + Edge Function code
- `OMISE_SECRET_KEY`, `OMISE_WEBHOOK_SECRET` env vars
- PromptPay QR display in customer checkout

---

### US-3: US receipt + sales tax (Day 3)

**Sales tax:**
- Add `branches.sales_tax_rate` column (e.g. 0.0875 for NYC)
- Update `place-order` to compute `tax_amount = subtotal × sales_tax_rate`
- Display tax line in checkout breakdown
- Admin branch settings → input for tax rate

**Replace E-Tax invoice with US receipt:**
- Keep `tax_invoices` table (rename to `receipts` if cleaner, or keep schema)
- Drop `xml_payload` column or repurpose as `pdf_url`
- Replace `issue-tax-invoice` edge fn body — generate simple PDF receipt instead of E-Tax XML
- Use pdf-lib or similar to render
- Tax invoice number → "Receipt #" + sequential

**Drop:**
- `etax_*` env vars
- RD-specific XML namespace code

---

### US-4: Sentry + subscription enforcement (Day 4)

**Sentry:**
1. Sign up at sentry.io → create new project (Next.js)
2. Get DSN → paste into:
   - `apps/{web,driver,admin}/.env.local` as `NEXT_PUBLIC_SENTRY_DSN` and `SENTRY_DSN`
   - GitHub Secrets for CI source map upload (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`)
3. Verify error capture: throw test error in `/` page

**Subscription enforcement (wire `check_plan_limit`):**
Current state: RPC exists, NOTHING calls it.

Wire into:
1. `create_restaurant_with_branch` RPC — check `branches` limit before insert
2. Branch settings → add new branch button — check before insert
3. Menu item create — check `items` limit (need to know restaurant_id from branch_id)
4. (Optional) Daily orders quota — check on each place-order

Show "Upgrade plan" modal in UI when blocked.

---

### US-5: UI gaps fixup (Day 5)

**Customer:**
- Edit order UI on order tracking page (DB+RPC exists `edit_pending_order`, no UI)
- Closed branch banner — call `is_branch_open()` at menu page load, show banner if false

**POS:**
- "Recent orders" view → tap → Refund button (call `refund_order` RPC)

**Admin:**
- Tax invoice/receipt list page at `/b/{branchId}/receipts`
- Download receipt PDF
- Audit logs entries on: refund, cancel, staff invite, KYC approve/reject, plan upgrade
- Driver schedule admin publish UI (`/b/{branchId}/drivers/schedule`) — insert driver_schedules rows

**KDS:**
- Item 86 toggle: long-press item name in order card → toggle availability (call `toggle_item_availability` RPC)

---

### US-6: CCPA + legal pages (Day 6)

**Pages:**
- `/privacy` — Privacy Policy template (CCPA-compliant)
- `/terms` — Terms of Service template
- `/ccpa` — California-specific notice + "Do Not Sell" toggle

**Consent flows:**
- Cookie consent banner (top + accept/reject)
- Marketing consent checkbox at sign-up + checkout (already have `customers.marketing_consent`)
- Customer can request data export → CSV of their orders
- Customer can request account deletion → `delete_my_account` RPC (anonymize, don't hard-delete)

**Templates to use:**
- termly.io or iubenda for generation
- DON'T copy other sites' policies verbatim (legal risk)
- Recommend a lawyer review before production

---

### US-7: Tests on critical paths (Day 7 — half)

**Vitest:**
- `place-order` math correctness: subtotal + tip + promo + loyalty + tax = total
- Loyalty earn (per order completion)
- Loyalty redeem (max 50% subtotal)
- Promo validation edge cases (expired, exhausted, min subtotal)
- Refund partial vs full

**Playwright (already have config):**
- Customer happy path: browse → cart → checkout → place order → track
- Admin happy path: login → menu → orders → refund
- Driver happy path: login → online → accept → deliver

**RLS spot checks:**
- Customer A cannot see Customer B's orders
- Driver cannot see other drivers' earnings
- Owner of restaurant A cannot see restaurant B's data

---

### US-8: Staging env + smoke + handoff (Day 7 — half)

**Staging:**
1. Create 2nd Supabase project (e.g. `favornoms-staging`)
2. Replay all 47 migrations
3. Deploy all 10 Edge Functions (with staging secrets)
4. Setup `.env.staging` files in each app
5. Add `pnpm dev:staging` script
6. GitHub Actions: add staging deploy on PR merge

**Smoke test:**
Run through `docs/SMOKE-TEST.md` updated for US:
- Use Stripe test card (4242 4242 4242 4242)
- Real email signup (no SMS)
- Test consent flow

**Update docs:**
- `HANDOFF.md` — final state
- `README.md` — US launch ready
- `CONFIG-CHECKLIST.md` — drop Twilio/Omise, add Stripe
- `docs/USER-GUIDE.md` — rewrite with US personas
- `docs/SMOKE-TEST.md` — Stripe test card, US flow

---

## 🚫 Things to defer (NOT in 1-week scope)

- Multi-currency support (handle later when needed)
- Multi-language support (EN only for now)
- Real RD submission (US doesn't have this equivalent — sales tax is state-level)
- Native mobile apps
- Webhook for Slack/Discord notifications
- A/B testing infrastructure
- Customer chat / support inbox

---

## ✅ Definition of "Launch-ready"

Before launch checklist:
- [ ] All US-1 through US-8 tasks completed
- [ ] All 5 apps build clean
- [ ] All tests pass (Vitest + Playwright)
- [ ] Sentry capturing errors (verified with test error)
- [ ] Stripe live keys configured (after KYC with Stripe)
- [ ] Privacy/ToS/CCPA pages live
- [ ] At least 1 pilot restaurant onboarded + tested
- [ ] DNS configured for production domain
- [ ] Backups verified (restore tested)
- [ ] On-call rotation defined (even if just 1 person)

---

## 📞 Quick context for new session

**Current state:**
- 47 migrations applied (Thai-oriented but schema is fine)
- 10 Edge Functions ACTIVE (need rework: omise → stripe, tax-invoice → receipt)
- 5 apps + 3 packages all build clean
- 28 tests passing
- Documentation: 8 files in `docs/`

**Pivot status:**
- User decided 2026-05-26 to pivot from Thai → US market
- Launch target: 1 week
- Solo dev
- Open SaaS model

**Files that need rework (priority order):**
1. `packages/shared/src/mock/index.ts` — full rewrite
2. `packages/shared/src/utils/index.ts` — defaults USD
3. All admin/web/driver UI labels with "THB"
4. `supabase/functions/omise-*` → `supabase/functions/stripe-*`
5. `supabase/functions/issue-tax-invoice` → US receipt
6. Drop all `th.json` and `zh.json` files

**Read first when starting:**
1. This file (`docs/US-LAUNCH-PLAN.md`)
2. `HANDOFF.md`
3. `CONFIG-CHECKLIST.md`
4. `docs/USER-FLOWS.md` (for system understanding)
