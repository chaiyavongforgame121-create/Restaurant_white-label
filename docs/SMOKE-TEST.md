# Favornoms — End-to-end smoke test (🇺🇸 US)

> Complete pass through every role's loop, including all features added this session. Run after dashboard config (`CONFIG-CHECKLIST.md`).

## Setup (one time)
1. Apply `CONFIG-CHECKLIST.md` §1–§13
2. `node scripts/generate-vapid-keys.cjs` → paste keys
3. `pnpm install && pnpm dev` (or per-app: `dev:web|driver|kds|pos|admin`)
4. Open 5 browser windows on `localhost:3000-3004`
5. Stripe Dashboard → Webhook deliveries tab open

---

## 🧑 Customer flow (apps/web :3000)

### Sign-in & onboarding
- [ ] Visit `/r/coastal-grill/brooklyn`
- [ ] Cookie banner appears → "Accept all"
- [ ] PWA install prompt may appear after 8s — verify dismissable
- [ ] Tap "Sign in" → toggle to **Email** tab → enter email → magic link sent
- [ ] Open magic link → returns signed in
- [ ] (Alt) Switch to Phone tab → OTP code arrives via Twilio

### Menu browsing
- [ ] **Reviews strip** shows 4.x rating + count
- [ ] **🔥 Combos row** appears (if combos exist) — scroll horizontally
- [ ] **👋 Your usuals** row appears (after at least one prior order)
- [ ] **Chef's picks** row appears for recommended items
- [ ] **Dietary filter chips** filter the grid (toggle Vegan, Gluten-free)
- [ ] **Happy-hour pricing**: if a happy hour is active for a category, item card shows strikethrough original price + sale label

### Item detail (with modifiers)
- [ ] Tap an item linked to a modifier group (e.g. size with S/M/L)
- [ ] Modifier section renders — required/optional indicators correct
- [ ] Add a modifier with price_delta — price updates in real-time
- [ ] "You might also like" row shows co-purchase recommendations
- [ ] Add to cart

### Cart
- [ ] Cart line shows modifier list (e.g. "+ Large (+$2.00)")
- [ ] Combo line shows expandable child items list
- [ ] Voice order: tap mic → say "Add 2 cheeseburgers" → items appear
- [ ] "Sign in for loyalty" hint shows if not signed in
- [ ] Tap Checkout

### Checkout
- [ ] **When?** section: ASAP / Schedule for later (datetime picker)
- [ ] Schedule for later → pick 2hrs from now
- [ ] Contact info — name + phone (US format placeholder) + email
- [ ] Delivery address: saved addresses radio + new address option
- [ ] Payment method: Card / Cash (no PromptPay)
- [ ] Tip slider: 0/5/10/15/custom
- [ ] Promo code entry → apply `WELCOME10` (create in admin first)
- [ ] **🎁 Gift card** entry → apply gift card code → balance applies up to subtotal
- [ ] Loyalty points slider (if customer has points)
- [ ] Place order

### Order tracking
- [ ] Status shows `pending` → tap "Pay with card"
- [ ] Stripe Elements opens (after you mount `<PaymentElement>` — see HANDOFF §8)
- [ ] Use test card `4242 4242 4242 4242` exp `12/30` cvc `123`
- [ ] Webhook delivery in Stripe Dashboard shows 200
- [ ] Order auto-advances `pending → confirmed` via realtime
- [ ] Watch KDS pop the order
- [ ] Edit instructions button works while pending
- [ ] **Report an issue button** opens issue form → submit → ticket created
- [ ] After delivered: rate the order (food + delivery stars)
- [ ] "View full receipt →" opens `/orders/{n}/receipt` — printable HTML

### Legal / account
- [ ] `/privacy`, `/terms`, `/ccpa` all render
- [ ] `/ccpa` toggle "Do Not Sell" — toggles cookie + honors GPC
- [ ] `/account` → Download my data → JSON file downloads
- [ ] `/account` → Delete account → anonymizes orders, scrubs PII
- [ ] `/help` index + `/help/placing-an-order` etc.

---

## 🚴 Driver flow (apps/driver :3001)

- [ ] Sign in with phone OTP (US format `(555) 234-5678`)
- [ ] First-time? Visit `/app/training` → complete 4 modules + quiz → 100% to unlock
- [ ] Go online
- [ ] Wait for dispatch (or use admin to manually send)
- [ ] Accept within 45s
- [ ] Status: heading_to_pickup → at_pickup → picked_up → in_transit → at_customer
- [ ] **At at_customer stage**: 📸 Snap a delivery photo button → upload → POD saved
- [ ] Mark delivered
- [ ] Verify peak-hour bonus applied if delivered during a configured window
- [ ] Earnings page increments
- [ ] **Performance card** on Home shows 30-day stats (acceptance/on-time/earnings/deliveries)
- [ ] History page shows USD amounts

---

## 👩‍🍳 KDS flow (apps/kds :3002)

- [ ] Order appears in "New" column
- [ ] Long-press any item name (700ms) → confirm 86 → item flips `is_active=false`
- [ ] Bump through Preparing → Ready
- [ ] Recall a bumped order within 5 min

---

## 🧾 POS flow (apps/pos :3003)

- [ ] Sign in with magic link
- [ ] **🕒 Clock in** button → starts a `staff_shifts` row
- [ ] Take a dine-in order → enter table # → charge cash → ESC/POS receipt prints
- [ ] **🅿️ Park order** → label "Table 5" → reset cart
- [ ] Take another order → park
- [ ] "Parked" badge shows 2 → expand → resume one
- [ ] **Hotkeys**: type `1` → first visible item adds; `Ctrl+P` → payment sheet
- [ ] `/recent` → on a completed order: Refund button
- [ ] Refund: choose "By items" mode → set qty to refund per line → submit
- [ ] **Clock out** at end of shift

---

## 🏢 Admin flow (apps/admin :3004)

### Sign in & onboarding
- [ ] Magic link login
- [ ] If new owner: `/onboarding` wizard creates restaurant + branch
- [ ] Dashboard shows revenue + plan banner

### Branch settings
- [ ] **Branch settings → Sales tax** → set `8.875` → save
- [ ] Verify next order's tax_amount is computed correctly

### Menu
- [ ] `/menu` — DnD reorder works
- [ ] `/menu/modifiers` → create group "Size" → add Small/Med/Large with prices → link to a menu item
- [ ] `/menu/combos` → create "Burger Combo" → add 3 items → set discounted total price
- [ ] `/menu/happy-hours` → create "Lunch special" 11:00-14:00 weekdays, 15% off Burgers category
- [ ] `/menu/import` — AI menu import with photo → bulk insert
- [ ] `/menu/import` — CSV import: paste/upload CSV (download template button) → preview valid/invalid → import

### Inventory
- [ ] `/inventory` — toggle Track stock on a few items → set thresholds
- [ ] Click "Restock" → enter qty + supplier → stock increments
- [ ] Click "Waste" → reason "spoiled" → stock decrements (not below 0)
- [ ] Verify Low stock card highlights items below threshold

### Shifts & tips
- [ ] `/shifts` — open shifts and total hours visible
- [ ] Tip pool: set From/To range → Calculate → see distribution by hours
- [ ] Export CSV

### Waitlist
- [ ] `/waitlist` → "Add to waitlist" → party of 4, phone (555) 234-5678
- [ ] Position auto-assigned
- [ ] Click "Notify" → SMS queued (verify in notifications_outbox)
- [ ] Click "Seat" → row moves to history

### Floor plan
- [ ] `/floor-plan` → add table → drag-drop to grid cell (Edit mode)
- [ ] Cycle status: open → occupied → dirty → reserved by clicking

### Orders
- [ ] `/orders` — search by order # / customer name / phone
- [ ] Save current filter as a view → reload → still saved
- [ ] Open action menu → Refund (partial by-item)
- [ ] Edit notes → updates instantly
- [ ] Issue receipt → opens HTML in new window

### Marketing
- [ ] `/marketing` → compose broadcast → push/sms/in_app channels → Send now
- [ ] Check `notifications_outbox` queue

### Promos
- [ ] `/promos` → create `WELCOME10` (percent_off 10, min $25)

### Plan & billing
- [ ] `/settings/plan` shows current plan + usage bars (branches/items/orders)
- [ ] Upgrade to Starter → plan banner disappears on dashboard

### Insights
- [ ] `/reports` → revenue chart with branch timezone
- [ ] `/receipts` → list of all issued receipts → View / print
- [ ] `/activity` → audit log entries

### Dark mode
- [ ] Sidebar bottom: "Dark mode" / "Light mode" toggle
- [ ] Persists across reload

---

## 🛡 Platform admin

- [ ] `/platform` (gated by `private.user_is_platform_admin()`)
- [ ] Cross-tenant stats, tenant list, suspend/restore, impersonate

---

## 🤖 AI features

### AI chat support (customer)
- [ ] Future: customer hits a chat widget → calls `ai-chat-support` edge fn → Claude responds with menu/hours/refund info
- [ ] (UI not yet built — backend ready)

### AI review responder (admin)
- [ ] Future: admin clicks "Draft reply" on a review → `ai-review-response` returns brand-voiced text
- [ ] (UI not yet built — backend ready)

### AI menu optimizer (admin)
- [ ] Future: admin clicks "Optimize my menu" → `ai-menu-optimize` returns 5–10 actionable recs
- [ ] (UI not yet built — backend ready)

---

## 🤝 Integrations (DoorDash / QuickBooks / etc.)

- [ ] `/admin` has no UI yet for integrations management (scaffold ready)
- [ ] Verify backend: insert a row into `integrations` table, then call `enqueue_sync_job` RPC, then hit `/functions/v1/integration-sync` → job moves through queued → running → done (or failed if credentials missing)

---

## 🩺 Health checks (after every smoke test pass)

- [ ] Sentry — throw a test error in `/r/coastal-grill/brooklyn` → appears in Sentry
- [ ] Stripe Dashboard → all webhook deliveries 200
- [ ] Supabase Logs — no 5xx in last 5 min
- [ ] `pnpm -r type-check && pnpm -r test && pnpm -r build` all green
- [ ] Spot-check 3 random admin pages load < 2s

If everything above ✅ — you're launch-ready.
