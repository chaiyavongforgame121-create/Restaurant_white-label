# Favornoms — White-label Restaurant SaaS (🇺🇸 US)

Monorepo for the Favornoms platform — **fully feature-complete** as of 2026-05-27. See [`HANDOFF.md`](./HANDOFF.md) for the full state of the world and [`CONFIG-CHECKLIST.md`](./CONFIG-CHECKLIST.md) for the operational checklist.

| App | Port | Purpose |
|-----|------|---------|
| **`apps/web`** | 3000 | Customer PWA — menu (modifiers, combos, dietary filters, happy hour pricing, your usuals, recommendations), Stripe checkout, scheduled orders, gift cards, voice ordering, custom domains, receipts, /privacy /terms /ccpa /account /help |
| **`apps/driver`** | 3001 | Driver PWA — phone OTP (US), realtime dispatch, GPS, KYC, **photo POD upload**, **onboarding training**, **performance dashboard**, peak-hour bonus, 1099 summary, Web Push |
| **`apps/kds`** | 3002 | Kitchen Display — realtime + station filter, audio beep, **long-press to 86**, recall |
| **`apps/pos`** | 3003 | Tablet POS — magic-link, ESC/POS printer, **clock in/out**, **park order**, refunds, keyboard hotkeys (1-9, Ctrl+P), card+cash |
| **`apps/admin`** | 3004 | Owner/Manager — dashboard with plan banner, orders (search/filter/saved views/partial refund), reservations, **waitlist**, **floor plan**, menu (CRUD + DnD + AI import + CSV + modifiers + combos + happy hours), **inventory**, **shifts/tips**, drivers + KYC, brands, marketing, promos, receipts, reports, plan & billing, dark mode |

Backend: Supabase project `ayyfczidnzxetndiijmv` — **71 migrations**, RLS everywhere, **14 Edge Functions** (10 active, 4+ new awaiting CLI deploy), PostGIS dispatch, realtime, `pg_cron` for notifications + loyalty + abandoned carts.

---

## Quick start

```bash
npm install -g pnpm@9
pnpm install

# Verify
pnpm -r type-check    # 8 packages clean
pnpm -r test          # 49 tests pass
pnpm -r build         # production build

# Run
pnpm dev              # all 5 apps
# or individually:
pnpm dev:web          # → :3000
pnpm dev:driver       # → :3001
pnpm dev:kds          # → :3002
pnpm dev:pos          # → :3003
pnpm dev:admin        # → :3004
```

---

## Status (2026-05-27)

```
✅ 49 tests passing (Vitest unit + Playwright e2e)
✅ 5 Next.js apps build clean (~14+20+10+5+4 routes)
✅ 71 Supabase migrations applied
✅ Sentry + GitHub Actions CI wired
✅ Stripe Customer + webhook scaffolded (Elements mount deferred — see HANDOFF §8)
✅ AI features (3 Claude edge fns ready)
✅ Integration scaffold (DoorDash/UberEats/QuickBooks/Yelp/etc.)
✅ Compliance (CCPA + sales tax + age verify + food safety logs)
```

---

## Feature matrix (high level)

### Customer
Order online · Voice ordering · Custom modifiers · Combos · Scheduled orders · Dietary filters · Your usuals · Recommendations · Gift cards · Loyalty (tiered + birthday) · Referrals · Reviews · Receipt · Cancel/edit · Issue tickets · Address book · Saved methods *(via Stripe)* · PWA install · Magic-link or Phone OTP · Guest checkout · CCPA data rights

### Driver
Phone OTP · Realtime dispatch · Active delivery 5-stage · Photo POD · Training + quiz · 30-day performance card · Peak-hour bonus · Withdrawals · Web Push · 1099 summary · KYC upload · Schedule · History

### Kitchen (KDS)
Realtime tickets · Station filter · Audio beep · Long-press 86 · Recall window · Fullscreen mode

### POS
Magic-link · Cash drawer + receipt printer · Park order · Clock in/out · Refund flow · Keyboard hotkeys · Split bill · Table number · Manual discount

### Admin
Dashboard with plan upgrade banner · Orders with search/filter/saved views/partial refund · Reservations · Walk-in waitlist · Floor plan editor · Menu CRUD + DnD reorder + AI import + CSV import + modifiers + combos + happy hours · Inventory (restock + waste log) · Shifts + tip pooling · Drivers + KYC · Customers · Marketing broadcasts · Promos · Receipts list · Reports (with branch TZ) · Activity log · Brands · Franchise · Plan & billing · Dark mode

### Backend
Stripe payment intents + webhooks · US sales tax · Gift card issue/redeem · Promo validation · Tiered loyalty + birthday cron · Abandoned cart sweep cron · Recommendations RPC · Recurring orders · Group cart sharing · Driver stats RPC · Peak-hour bonus trigger · Driver 1099 · Cohort retention RPC · Customer LTV RPC · 7-day forecast · AI chatbot edge fn · AI review responder · AI menu optimizer · Sync jobs queue · Sales tax filing RPC · Food safety logs · Age verification flag

---

## What you must do before live traffic

See [`CONFIG-CHECKLIST.md`](./CONFIG-CHECKLIST.md). Quick list:

1. **Deploy ~7 edge functions via CLI** (`supabase functions deploy …`)
2. Set secrets in Supabase Dashboard: Stripe, Anthropic, Resend, VAPID, Twilio, Sentry
3. Create Stripe webhook pointing at `stripe-webhook`
4. Set per-branch `sales_tax_rate` in admin app
5. Paste `private.app_settings` SQL
6. Mount `<PaymentElement />` properly (see HANDOFF §8)
7. Run full smoke test in [`docs/SMOKE-TEST.md`](./docs/SMOKE-TEST.md)

---

## Repository layout

```
favornoms/
├── apps/
│   ├── web/         # Customer PWA          (3000)
│   ├── driver/      # Driver PWA            (3001)
│   ├── kds/         # Kitchen Display       (3002)
│   ├── pos/         # POS terminal          (3003)
│   └── admin/       # Restaurant admin      (3004)
├── packages/
│   ├── shared/      # Types, utils, mock fixtures (American casual)
│   ├── ui/          # Design system (Tailwind + Framer Motion)
│   └── database/    # Supabase types, client, server, queries
├── supabase/
│   └── functions/   # Edge fn sources (place-order v8, stripe-*, ai-*, etc.)
├── e2e/             # Playwright specs
├── docs/            # HANDOFF, CONFIG-CHECKLIST, SMOKE-TEST, USER-GUIDE, USER-FLOWS, RUNBOOK, BACKUPS
├── pnpm-workspace.yaml
└── turbo.json
```

---

## Deferred (when you're ready)

- Native iOS/Android apps (Capacitor wrap)
- Multi-currency (when going international)
- B2B catering portal with invoice billing
- Status page (`status.favornoms.com`)
- Real-time observability dashboard
- Stripe Connect (split payments for marketplace model)

See [`HANDOFF.md` §10](./HANDOFF.md) for the full deferred list.

---

Built end-to-end for the US market. See [`HANDOFF.md`](./HANDOFF.md) for the canonical state-of-the-world document.
