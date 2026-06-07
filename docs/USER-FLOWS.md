# Favornoms — User Flows (ทุก Role ละเอียด)

> เอกสารนี้อธิบายทุก loop การทำงานของแต่ละ role พร้อม URL, ปุ่มที่กด, การเปลี่ยนแปลงใน DB, และ edge cases.
> ใช้คู่กับ `docs/SMOKE-TEST.md` สำหรับ checklist สั้นๆ.

---

# 👤 1. Customer (apps/web — port 3000)

URL pattern: `/r/{restaurant_slug}/{branch_slug}/...`
ตัวอย่าง seed: `/r/somtam-zab/main`

## 1.A — เข้าใช้งานครั้งแรก (anonymous)

```
1. Customer พิมพ์ URL ร้าน → /r/somtam-zab/main
   ↳ Server resolves tenant (resolveTenantBySlug)
   ↳ ThemeProvider โหลด theme จาก brand/restaurant
2. เห็นหน้า hero พร้อมเมนูแบ่งหมวด
3. ระบบยังไม่ track customer — เป็น anonymous session
```

**ทางเลือก:** Customer หาผ่าน custom domain → middleware ดู `branches.custom_domain` → rewrite ไปที่ `/r/restaurant/branch`

## 1.B — Sign-in (Phone OTP)

```
1. กดปุ่ม Account (ขวาบน) → ไม่ logged in → redirect /sign-in?next=/account
2. ใส่เบอร์โทร (08x-xxx-xxxx) → กดส่ง OTP
   ↳ Supabase Auth ส่ง OTP ผ่าน SMS provider (Twilio)
   ↳ DEV: อ่าน OTP จาก Dashboard → Auth → Logs
3. ใส่ OTP 6 หลัก → verify
   ↳ Trigger `handle_new_user` สร้าง customers row (ถ้ายังไม่มี)
   ↳ JWT มี branch_ids[] + restaurant_ids[] (ถ้าตั้ง Custom Access Token Hook)
4. PushSubscriber component ทำงาน → ขอสิทธิ์ Notification → register endpoint ลง push_subscriptions
5. Redirect กลับ /account ตามที่ ?next= บอก
```

## 1.C — สั่งอาหารแบบเต็ม flow

```
1. Browse menu
   - แต่ละหมวด: filter ด้วย is_active=true
   - กดรูปสินค้า → modal รายละเอียด → ปรับ quantity + notes
   - กด Add to cart → cart store (Zustand persist ใน localStorage)
   - cart store track menuItemId + notes แยกบรรทัด (Foodpanda-style)

2. เปิด /cart
   - แสดง items, edit quantity, ลบทีละ line
   - **Voice ordering** — กด Speak → SpeechRecognition browser API
     → ส่ง transcript ไปยัง parse-voice-order Edge fn
     → Claude แปลงเป็น actions
     → addToCart() ตาม actions
   - กด Checkout

3. /checkout — กรอกข้อมูล
   - Name + Phone (auto-fill ถ้า signed in จาก customers row)
   - Channel: delivery / pickup / dine_in (เลือกใน cart)
   - **Saved addresses** — ถ้ามีหลายที่ → radio cards
     เลือก + ปุ่ม "Use a new address"
   - Payment: PromptPay / Card / Cash
   - **Promo code** — ใส่ → กด Apply → call validate_promo_code RPC
     → ถ้า valid: discount แสดง, free_delivery → deliveryFee = 0
   - **Tip slider** — 0/5/10/15% หรือ custom amount
   - **Loyalty redeem** — slider จาก 0 ถึง min(balance, subtotal*0.5)
   - Total อัปเดต realtime

4. กด Place order ฿{total}
   ↳ Call place-order Edge fn (v3)
   ↳ Server recalculates ทุกอย่าง — ไม่เชื่อ client
   ↳ Server validates: branch open (is_branch_open), stock, promo
   ↳ Insert orders + order_items + payments + delivery (ถ้า delivery)
   ↳ ถ้า new address → insert customer_addresses row
   ↳ Return order_number

5. Redirect → /orders/{order_number}
   - Realtime subscribe channel `order:{id}` + `deliveries`
   - แสดง 5-step progress bar
   - PENDING → ปุ่ม "Simulate payment success" (dev only)
   - หลัง confirmed → ครัวเริ่มทำ → kds bump
   - แสดง driver card เมื่อ assigned_driver
```

## 1.D — Track + cancel + rate

```
สถานะ pending/confirmed:
  - ปุ่ม "Cancel order" → call cancel_order RPC
  - Server เช็ค status, restore stock, mark canceled
  - ถ้า status เลย preparing → ปุ่มหาย ต้องโทรร้าน

สถานะ delivered/completed:
  - แสดง "How was it?" card
  - food_stars 1-5 + delivery_stars (ถ้ามี driver) + comment
  - Insert order_ratings row
  - ครั้งเดียวต่อ order (unique constraint)
```

## 1.E — Account + Loyalty

```
/account แสดง:
  - Loyalty card: points balance, tier (bronze/silver/gold/platinum), lifetime
  - ถ้า restaurant.loyalty_scope = 'brand' → pool ข้ามสาขา
  - List orders ล่าสุด
  - Manage saved addresses
  - Sign out
```

## 1.F — Push notifications loop

```
1. หลัง sign-in → PushSubscriber component ขอ Notification permission
2. Service worker register
3. pushManager.subscribe(VAPID_PUBLIC_KEY) → endpoint + keys
4. Call register_push_subscription RPC → insert push_subscriptions row
5. เมื่อมี event (order_confirmed, ready, out_for_delivery):
   - Trigger insert notifications_outbox channel='push'
   - pg_cron tick → notify-worker → web-push lib → browser
   - SW push event → showNotification
6. คลิก notification → SW notificationclick → open URL
```

---

# 🛵 2. Driver (apps/driver — port 3001)

## 2.A — สมัครคนขับครั้งแรก (KYC)

```
1. Visit /login → enter phone → OTP
   ↳ Trigger handle_new_user: ถ้า raw_user_meta_data.signup_type='driver'
     → insert drivers row พร้อม user_id link
2. หลัง verify → DriverSessionProvider ดึง drivers row
3. ถ้า drivers.kyc_status = 'pending' → /app/profile แสดง KYC upload
4. Upload 5 เอกสาร:
   - National ID (front)
   - Driving license (front)
   - Driving license (back)
   - Vehicle registration
   - Selfie holding ID
   ↳ Upload เข้า bucket driver-kyc (private)
   ↳ Insert/update driver_approvals row
5. รอ admin review (driver app แสดง "Pending verification")
```

## 2.B — Daily sign-in + auth gate

```
1. Visit /login → phone OTP → verify
2. DriverSessionProvider โหลด:
   - drivers row + driver_approvals (latest)
   - check kyc_status = 'verified' → allow /app/*
   - หาก rejected → แสดงเหตุผล
3. PushSubscriber subscribes (recipient_type='driver')
```

## 2.C — Going online + GPS tracking

```
1. /app/home → toggle "Go online"
   ↳ Update drivers.is_online = true
   ↳ Subscribe channel `dispatch:driver:{driver_id}`
   ↳ DriverLocationPing component starts watchPosition
2. ทุก 5-10 วินาที:
   ↳ Call set_driver_location RPC (PostGIS point)
   ↳ Updates drivers.current_location + drivers.last_seen_at
3. Battery, accuracy ส่งไปด้วย
4. Toggle off → drivers.is_online = false
```

## 2.D — Receive dispatch

```
1. มีออเดอร์ ready ที่ branch ใกล้เคียง
   ↳ orders_dispatch_on_ready trigger fires
   ↳ pg_net call dispatch-driver Edge fn
   ↳ dispatch-driver หา driver ใกล้สุด (within DISPATCH_RADIUS_KM=5)
   ↳ Insert/update deliveries.driver_id

2. Realtime channel ส่งให้ driver
   ↳ DispatchSheet popup แสดง:
     - ระยะทาง km
     - เวลาคาดการณ์
     - ค่าจ้าง earnings
     - 45-second countdown timer

3. ตัวเลือก:
   - Accept → call accept_dispatch(delivery_id) RPC
     → atomic claim (race-condition safe)
     → deliveries.status='assigned'
   - Reject → call reject_dispatch(delivery_id, reason)
     → increment_driver_reject_streak
     → ระบบหา driver ถัดไป
   - Timeout 45s → auto-reject
```

## 2.E — Active delivery 5 stages

```
หลัง accept → DeliveryProvider แสดง active delivery card.

Stage 1: heading (กำลังไปจุดรับ)
  → ปุ่ม "Arrived at restaurant" → deliveries.status='at_pickup'

Stage 2: at_pickup
  → ปุ่ม "Picked up order" → deliveries.status='picked_up'
  → orders.status='out_for_delivery'

Stage 3: picked_up / in_transit
  → ปุ่ม "Arrived at customer" → deliveries.status='at_customer'

Stage 4: at_customer
  → ปุ่ม "Delivered" → deliveries.status='delivered'
  → orders.status='delivered'
  → orders_award_loyalty_on_complete trigger
  → notifications_outbox row (order_delivered)

ทุก stage:
  - GPS ยังคง ping
  - Customer tracking page อัปเดต realtime
```

## 2.F — Earnings + withdrawals

```
/app/earnings:
  - Lifetime earnings (sum of deliveries.driver_earnings where status='delivered')
  - List ของ driver_withdrawals แต่ละสถานะ

Request withdrawal:
  1. กด "Request withdrawal"
  2. กรอก: amount, bank, account number, account name
  3. Insert driver_withdrawals (status='requested')
  4. Admin จะเห็นในหน้า drivers → review
  5. Admin approve → status='approved' → จ่ายเงินจริง → status='paid'
```

## 2.G — Schedule

```
/app/schedule:
  - SELECT driver_schedules WHERE driver_id = me
  - แสดง shifts ตาม scheduled_period (tstzrange)
  - status: pending / confirmed / completed / canceled

(Future) Sign up for open shifts published by admin.
```

---

# 🏪 3. Owner / Manager (apps/admin — port 3004)

URL pattern: `/b/{branchId}/...`
ทุกหน้ามี Sidebar nav: Operate · People · Insights · Setup

## 3.A — Self-service onboarding (NEW restaurant signup)

```
1. Visit /onboarding (ตรงๆ หรือคนแชร์ลิงก์)
2. ถ้าไม่ login → /login?next=/onboarding
3. Step 1: Restaurant name + slug (auto-generated from name, editable)
4. Step 2: Branch name + slug + address
5. Step 3: Brand colors (primary + accent) + live preview
6. Click "Launch my restaurant"
   ↳ Call create_restaurant_with_branch RPC
   ↳ Insert restaurants + branches + staff_members(role='owner') + subscriptions(plan='free')
   ↳ Return branch_id
7. Redirect → /b/{branch_id}/dashboard
```

## 3.B — Daily ops dashboard

```
/b/{branchId}/dashboard
  - แสดง KPIs: orders today, revenue today, open orders, drivers online
  - Quick actions: new menu item, view orders, etc.

Sidebar:
  Operate
    - Dashboard
    - Orders (live)
    - Reservations (live)
    - Menu
  People
    - Staff
    - Drivers
    - Customers
    - Marketing
    - Promos
  Insights
    - Reports
    - Activity log
  Setup
    - Branch settings
    - Brands
    - Franchise
    - Preferences
```

## 3.C — Menu management

```
/b/{branchId}/menu — 2 modes: Edit + Reorder

EDIT MODE (default):
  - Items grouped by category
  - Each item card: edit (✎) / duplicate (📋) / delete (🗑️)

  Click ✎ → Sheet drawer opens with ItemEditor:
    - Name
    - Category (dropdown)
    - Price
    - Description
    - Image upload (drag-drop → branch-assets bucket → public URL)
    - Track stock toggle
      → if on: current stock + low_stock_threshold
    - Chef's recommendation checkbox
    - New flag

  Click 📋 duplicate → call duplicate_menu_item RPC → "Item (Copy)" appears

  Click 🗑️ delete → confirm → delete cascade

  + Add item button → empty ItemEditor
  + AI import button → /menu/import:
    - Upload menu photo → upload to bucket → get URL
    - Call import-menu Edge fn (Claude vision + tool use)
    - Returns proposed items list
    - User reviews/edits inline
    - Bulk insert on confirm

REORDER MODE:
  - DnD-kit sortable
  - Drag category up/down (vertical sort)
  - Drag item within category or to different category
  - "Save layout" button → call reorder_menu_categories + reorder_menu_items + set_menu_item_category RPCs
```

## 3.D — Stock management

```
ทุก item ที่มี track_stock=true:
  - แสดง stock_quantity ใน item card
  - เมื่อ order placed → trigger order_items_decrement_stock_trg
    → decrement menu_items.stock_quantity by line quantity
    → ถ้า stock_quantity <= low_stock_threshold:
      Insert notifications_outbox (template='low_stock')
  - Admin เห็น low stock alert ใน activity log + push notification

ถ้า stock=0 → place-order block (insufficient_stock)
86 toggle (instant out-of-stock):
  - ใน menu editor uncheck "is_active"
  - หรือ kitchen call toggle_item_availability RPC จาก KDS
```

## 3.E — Order management

```
/b/{branchId}/orders:
  - Table: Order #, Channel, Customer, Created, Total, Status, Actions
  - Realtime updates ผ่าน orders subscription

Action menu (••• per row):
  ┌─────────────────────────┐
  │ ↻ Issue refund          │ (full or partial — input amount)
  │ ✕ Cancel order          │ (if not completed/delivered)
  │ 📄 Issue tax invoice    │ (if completed/delivered)
  └─────────────────────────┘

Issue refund:
  → modal: amount (max=total) + reason
  → call refund_order RPC
  → status → 'refunded' if full, marks status_history
  → audit_logs entry

Issue tax invoice:
  → call issue_tax_invoice RPC
  → allocates branch-scoped invoice number (INV-2026-000123)
  → insert tax_invoices row
  → (future) call issue-tax-invoice Edge fn → builds XML + RD submission
```

## 3.F — Reservations

```
/b/{branchId}/reservations:
  - Live realtime list
  - Statuses: pending → confirmed → seated → completed (or canceled)
  - Filter by date
  - Confirm/Reject pending
  - Mark seated when guests arrive
  - Mark completed after dining
```

## 3.G — Driver KYC review

```
/b/{branchId}/drivers:
  - List drivers in branch
  - Pending KYC highlighted
  - Click → review modal:
    - See uploaded docs (signed URLs from driver-kyc bucket)
    - Approve → call set_driver_kyc_status(driver_id, 'verified')
    - Reject → with reason → status='rejected'
```

## 3.H — Staff invitations

```
/b/{branchId}/staff:
  - List current staff (role + branch)
  - "Invite staff" button:
    - Email + role (owner/manager/cashier/kitchen)
    - Call invite-staff Edge fn
    - Sends magic link with embedded restaurant_id + branch_id
  - Invitee opens link → /invite/accept
    - Verifies token + creates staff_members row
    - Redirect to /b/{branch}/dashboard
```

## 3.I — Marketing broadcasts

```
/b/{branchId}/marketing:
  - List past broadcasts
  - "New broadcast" button:
    - Title + body + URL
    - Audience filter:
      - Tier (bronze/silver/gold/platinum) — multi-select
      - Ordered within last N days
      - Marketing consent only (default ON)
    - Channels (push / in_app / sms)
    - Send now
  - Insert broadcasts row → call enqueue_broadcast RPC
    → fan-out: insert notifications_outbox per (recipient, channel)
    → notify-worker drains → push/sms/email
  - Broadcast status updates via realtime
```

## 3.J — Promo codes

```
/b/{branchId}/promos:
  - List existing codes (active/paused/expired)
  - "New promo" button:
    - Code (e.g. WELCOME10)
    - Type: % off / fixed THB off / free delivery
    - Value (if applicable)
    - Min subtotal (e.g. ฿100)
    - Max redemptions (optional)
    - Per-customer limit (default 1)
    - Ends at (optional)
  - Toggle pause/activate
  - Delete

Customer use:
  - At checkout → enter code → validate_promo_code RPC
  - Server checks: valid, not expired, redemption count, customer limit
  - Apply discount + record promo_redemptions row on order place
```

## 3.K — Brands (multi-brand)

```
/b/{branchId}/brands:
  - Loyalty scope toggle: branch vs brand-wide pool
  - List of brands under this restaurant
  - "New brand":
    - Name + slug + theme (primary/accent colors, logo URL)
    - Link branches (multi-select checkboxes)
    - Mark as default
  - Edit existing brand same way

When branch.brand_id is set:
  - Customer site uses brand.theme as base
  - branch.theme_override merges on top
```

## 3.L — Franchise mode

```
/b/{branchId}/franchise:
  - If restaurant not in any group → "Create franchise group"
  - If in group:
    - Show group name + linked restaurants/branches
    - "Broadcast this branch's menu to:" — checklist of other branches
    - Call broadcast_franchise_menu RPC
      → copies missing categories + items
      → updates locked-field items (franchise_menu_locks)
    - Result: { inserted_categories, inserted_items, updated_items }
```

## 3.M — Holiday hours / closures

```
/b/{branchId}/branch → Closures section:
  - "Add closure" — starts_at, ends_at, reason
  - List upcoming/past closures
  - Delete

Effect:
  - During closure, is_branch_open() returns false
  - place-order returns 409 branch_closed
  - Customer site shows "Closed today" banner (future enhancement)
```

## 3.N — Branch settings

```
/b/{branchId}/branch:
  - Identity: name, address, active toggle
  - Brand theme: primary + accent colors (preview)
  - Custom domain: hostname (DNS A/CNAME → Favornoms target)
  - Operating settings: timezone, delivery radius, service fee %
  - Closures (see above)
```

## 3.O — Reports + CSV exports

```
/b/{branchId}/reports:
  - Date range selector: 7 / 30 / 90 days
  - Cards: Revenue, Orders, AOV, Completion %
  - Charts: revenue daily (bar), by channel (pie), top items, peak hours heatmap
  - Top 10 menu items

  Export buttons (top right):
    - Orders CSV
    - Customers CSV
    - Loyalty transactions CSV
    - Revenue CSV
  → call export-csv Edge fn → download
```

---

# 💵 4. Cashier (apps/pos — port 3003)

## 4.A — Sign in + printer pair

```
1. /login → magic link via email
2. Click link → verify → role check (owner/manager/cashier)
3. Land on /b/{branchId} → main POS view
4. First time: Click "Pair USB printer"
   → navigator.usb.requestDevice() → user picks printer
   → Stored in IndexedDB for next session
   → PrinterStatusButton shows green if connected
```

## 4.B — Take walk-in order

```
1. Left side: menu grid (search + category filter)
2. Tap item → adds to right-side ticket
3. Adjust quantity with +/- buttons
4. Select channel (top right):
   - Dine-in (default) → show Table no. input
   - Pickup
   - Delivery (rare for POS — usually customer app)

5. Apply mods (right side):
   - Table no. (dine-in only)
   - Discount % (0-100)
   - Split count (1-20) — shows per-person calc

6. Tap "Charge ฿{total}" → payment sheet:
   - Cash → click → kicks drawer + prints receipt + creates order
   - PromptPay → click → creates order + prints QR receipt
   - Card → click → creates order (terminal integration TBD)

7. Server flow:
   - Call place-order Edge fn
   - Auto-mark status='confirmed' (skip pending for POS)
   - Print receipt via WebUSB ESC/POS
   - Open cash drawer (pin 2) if cash
   - Success toast → ready for next order
```

## 4.C — Refund (future enhancement)

```
Currently refunds happen in admin app. POS could add:
  - "Recent orders" view
  - Tap → refund button
  - Reuses refund_order RPC
```

---

# 👨‍🍳 5. Kitchen (apps/kds — port 3002)

## 5.A — Setup on shop tablet

```
1. Tablet visits /setup → pick branch from list
2. Saved in localStorage → redirect /b/{branchId}
3. Optionally append ?station=hot (filter by station)
4. Tap fullscreen icon (or F11) → kiosk mode
```

## 5.B — Receive new order

```
1. Customer places order → orders.status='confirmed' (after payment)
   OR Cashier in POS → orders.status='confirmed' immediately
2. KDS realtime channel `kds-branch:{branchId}` receives INSERT
3. Audio beep (if soundOn)
4. Order card animates in to "New" section
5. Card color = green/border-primary
```

## 5.C — Process order stages

```
Each order card has 3 stages:

[New / confirmed]
  ↓ Tap "Start cooking"
  → orders.status='preparing'
  → moves to "In the kitchen" section (yellow/accent)

[Preparing]
  ↓ Tap "Mark ready"
  → orders.status='ready'
  → moves to "Ready for pickup" section (green/success)
  → BACKEND: orders_dispatch_on_ready trigger fires (for delivery)

[Ready]
  ↓ Tap "Bump"
  → orders.status='completed' (pickup/dine-in) or stays for delivery
  → card animates out
```

## 5.D — Recall (un-bump within 5 min)

```
On "Ready" stage card → bottom shows "Recall to kitchen" button
  ↓ Tap → call recall_order RPC
  → checks: within 5-min window, not yet dispatched
  → orders.status='preparing'
  → card moves back to "In the kitchen"
```

## 5.E — Item 86 (out of stock toggle)

```
Quick way from KDS (when chef sees they're out):
  - (UI to add: long-press item name → toggle availability)
  - Or call toggle_item_availability RPC
  - menu_items.is_active = false
  - Customer site immediately reflects (realtime menu_items channel)
```

## 5.F — Station filtering

```
URL: /b/{branchId}?station=hot
  - Only items with order_items.station='hot' show
  - Each station tablet has its own URL
  - Station options (set on menu_items): hot / cold / bar / dessert / expo
```

## 5.G — Urgency colors

```
Border color based on elapsed time:
  - 0-8 min: normal (border-border)
  - 8-15 min: warning (orange)
  - 15+ min: danger (red)
Visible at glance — chef prioritizes.
```

---

# 🏢 6. Platform Admin (apps/admin/platform)

## 6.A — Access

```
1. Visit /platform
2. Server check: private.user_is_platform_admin() must return true
   - This is a function in private schema that checks auth.users.raw_app_meta_data
   - Or admins are added via direct DB grant
3. If not admin → "Access denied" page
4. If admin → dashboard renders
```

## 6.B — Cross-tenant operations dashboard

```
/platform shows:
  - 6 stat cards (top):
    - Restaurants (count)
    - Active branches (count of is_active=true)
    - Customers (count)
    - Drivers online (count of is_online=true)
    - Orders today (count where created_at >= today)
    - Revenue today (sum of total where status=completed today)

  - Search bar (filter by name/slug)

  - Restaurants table:
    Name | Slug | Branches (active/total) | Loyalty scope | Created | Actions

Each row's Actions:
  - "Open <branch>" — impersonate into that branch's admin (redirects to /b/{id}/dashboard)
  - "Suspend" — calls set_restaurant_suspended → all branches.is_active=false
  - "Restore" — reactivates all branches
```

## 6.C — Tenant impersonation

```
Click "Open <branch>" button:
  → Same auth session (platform admin has RLS access)
  → Redirect to /b/{branchId}/dashboard
  → Now acting as if owner of that branch
  → To go back: nav to /platform
```

## 6.D — Suspend / restore

```
Suspend:
  → Confirm dialog
  → call set_restaurant_suspended(restaurant_id, true)
  → All branches.is_active = false
  → Customer-facing sites return 404 for those branches
  → Existing orders in pipeline still process

Restore:
  → call set_restaurant_suspended(restaurant_id, false)
  → All branches.is_active = true
```

## 6.E — (Future) Billing dashboard

```
Tabular view of subscriptions:
  - Restaurant | Plan | Status | Next billing | MRR
  - Filter by status: trial / active / past_due / canceled
  - Quick actions: upgrade plan, mark past_due, cancel
```

---

# 🛠️ 7. Developer / DevOps

## 7.A — Local development

```
git pull
pnpm install          # idempotent
pnpm dev              # all 5 apps via turbo
pnpm dev:web          # single app
pnpm -r type-check    # all 8 packages
pnpm -r test          # vitest
pnpm test:e2e         # playwright (requires apps running)
pnpm -r build         # full prod build
```

## 7.B — Database migrations

```
1. Author migration via mcp__supabase__apply_migration
   - Forward-only — no rollback assumed
2. After DDL change: regenerate types
   mcp__supabase__generate_typescript_types
   → save to tool-results
   → extract to packages/database/src/types.ts
3. Run pnpm -r type-check
4. Commit migration + types together
```

## 7.C — Edge Function deploy

```
1. Edit source in supabase/functions/{name}/index.ts
2. Deploy via:
   - mcp__supabase__deploy_edge_function (this session), OR
   - supabase functions deploy {name} --project-ref ayyfczidnzxetndiijmv, OR
   - Push to main → .github/workflows/deploy-functions.yml
3. Set secrets via Dashboard → Edge Functions → Secrets
4. Logs: Dashboard → Edge Functions → {name} → Logs
```

## 7.D — CI/CD pipeline

```
On PR push:
  - .github/workflows/ci.yml runs
  - pnpm install → type-check → test → build (matrix all 5 apps)
  - migration-safety job grep for DROP/TRUNCATE in changed migrations
  - Status checks block merge if red

On main push:
  - Same CI runs
  - If supabase/functions/ changed → deploy-functions.yml
  - Apps deploy via host integration (Vercel/etc)
```

## 7.E — Incident response

```
1. Detect via Sentry alert (set up DSN first)
2. Severity per docs/RUNBOOK.md
3. Common diagnostics:
   - mcp__supabase__get_logs --service edge-function
   - mcp__supabase__get_advisors --type security
   - mcp__supabase__execute_sql "select status, count(*) from notifications_outbox group by status"
4. Quick recovery via Dashboard → Database → Backups (PITR)
5. Backups: scripts/db-dump.cjs + docs/BACKUPS.md
```

---

# 🔗 Cross-role data flow (overview)

```
Customer places order
  → place-order Edge fn validates
  → INSERT orders + order_items
  → status=pending → payment processing
  → status=confirmed → KDS sees it instantly (realtime)
    ↓
KDS chef cooks
  → status=preparing → status=ready
    ↓
For delivery:
  → trigger orders_dispatch_on_ready fires
  → pg_net → dispatch-driver Edge fn
  → finds nearest online driver → deliveries.driver_id set
  → driver app realtime receives → dispatch sheet
  → driver accepts → status=assigned → ... → delivered
    ↓
For pickup/dine-in:
  → POS or KDS bumps to completed
    ↓
On delivered/completed:
  → trigger orders_award_loyalty_on_complete
  → INSERT loyalty_points + loyalty_transactions
  → customer points/tier update
  → notifications_outbox push/email/sms
    ↓
notify-worker (pg_cron tick every 1 min)
  → drains outbox → web-push / Twilio / Resend
  → customer browser/phone receives
    ↓
Customer rates order (food_stars + delivery_stars)
  → INSERT order_ratings
  → driver sees own ratings in /app/profile (future)
```

---

# 📍 Status state machines

## Order status

```
pending → confirmed → preparing → ready → out_for_delivery → delivered → completed
                                       ↘ completed (for pickup/dine-in)

Any status (except completed/delivered/refunded) → canceled
completed/delivered → refunded (full)
```

## Delivery status

```
pending → dispatching → assigned → at_pickup → picked_up
  → in_transit → at_customer → delivered
                                  ↘ canceled
```

## Driver KYC status

```
unverified → pending (uploaded docs) → verified
                                    ↘ rejected (with reason) → resubmit
```

## Reservation status

```
pending → confirmed → seated → completed
                  ↘ canceled
```

## Tax invoice status

```
draft → issued → submitted → accepted
                          ↘ rejected
issued/submitted → canceled
```

## Broadcast status

```
draft → scheduled → sending → sent
                          ↘ failed → retry → sent
                          ↘ canceled
```

## Withdrawal status

```
requested → approved → paid
        ↘ rejected (with reason)
```
