# Favornoms — Release Test Plan (pre-client-handoff) — 2026-08-10

> จุดประสงค์: ทดสอบทุกฟังก์ชันก่อนส่งมอบลูกค้า. เจอบัค → แก้ทันที → re-test → mark `[x]`.
> รายงานแบบสั้น: ✅ ผ่าน / 🐛 เจอบัค+แก้แล้ว ต่อรายการ.
> ฐานข้อมูลฟีเจอร์เต็ม: `docs/_inventory-2026-08-10.md` (304 features, สแกน 2026-08-10).
>
> **Method**: dev servers :3000 (web) / :3001 (driver) / :3004 (admin+counter+kitchen).
> Login = `scripts/qa-session.mjs` (password-grant + cookie) หรือ Claude-in-Chrome เมื่อเชื่อมต่อได้.
> Test accounts pw `playtest1234`: owner@ / cashier@ / kitchen@ / driver@ / customer@test.com.
> Branch: Brooklyn `44444444-4444-4444-4444-444444444444` (coastal-grill/brooklyn); Silom `2222…` (somtam-zab/silom).
> ⚠️ Billing tests: lapse ผ่าน `subscriptions.current_period_end` เท่านั้น (mirror gotcha) — ห้ามเขียน billing_entitlements ตรง ๆ. Restore ข้อมูลทุกครั้งหลังเทสต์.

---

## Phase 0 — Baseline (automated)
- [x] 0.1 `pnpm turbo run type-check` → 7/7 pass
- [x] 0.2 Unit tests: web cart 17/17 + shared 50/50 pass
- [x] 0.3 Dev servers ทั้ง 3 ตอบ HTTP; DB reachable (2 restaurants / 2 branches / 25 items)
- [ ] 0.4 Playwright route smokes (e2e/*.spec.ts) — รันหลังแก้บัค UI หลัก

## Phase A — Money & entitlements (backend, SQL/RPC)
- [x] A1 lapse ผ่าน current_period_end + expire_tick → status expired, mirror NULL, storefront_status false ทุก flag; restore กลับครบ ✅
- [x] A2 Gates ระหว่าง suspended: order INSERT → P0001 billing_inactive:orders ✅; cash settle order ค้าง → ผ่าน ✅; card → feature_not_entitled:card_payment ✅
- [x] A3 request_package_change ($248) → decide_billing_request(approve) → entitlements ทันที ✅ (restore trial แล้ว)
- [x] A4 expire_tick ใช้ greatest(period_end,trial_ends) — NULL ทั้งคู่ = ไม่ expire ตลอดกาล แต่ RPC rail ตั้งวันเสมอ (default +1mo) → OK by design, note ไว้
- [x] A5 branch เกิน seat → P0001 plan_limit_exceeded:branches:1/1 ✅
- [x] A6 ถอด delivery: place-order delivery → 403 ✅, deliveries INSERT → P0001 ✅ (restore addons แล้ว); ลำดับ validation: shape 400 มาก่อน authz 403 (มาตรฐาน)
- [x] A7 Lockdown: customer PATCH subscriptions → 42501 ✅, SELECT billing_entitlements → 42501 ✅; owner PATCH branches.entitled_through → ค่าไม่เปลี่ยน (mirror protected) ✅
- [x] A8 Suspended tenant: place-order 402 ✅, ai-chat-support ไม่มี auth → 401 gateway ✅ (role-check มาก่อน billing-check ใน export/import = ถูกต้อง)

## Phase B — place-order contract + pricing (backend)
- [x] B1 Error matrix 12/12 ✅ (invalid_channel/empty_order/table_required/phone/delivery_addr/dropoff/item_not_in_branch/invalid_payment/insufficient_stock 409/invalid_quantity/sched too_soon+too_far)
- [x] B2 Happy-hour server-side: 2× Onion Rings @4.80 (list 6.00) → subtotal 9.60 ✅ (หมายเหตุ: Lunch special ตอนนี้ผูก item เดียว — config เก่า ไม่ใช่บัค)
- [x] B3 Promo/gift validation 8/8 ✅; redemption จริง: WELCOME10 −$3.20 + count+1 + row ✅, GIFT50QA ตัด 28.80 ✅ (restore แล้ว; ต่ออายุ WELCOME10/FREESHIP → 2026-12-31 เพราะหมดอายุค้างจาก demo เก่า)
- [x] B4 Tax = taxableBase × sales_tax_rate (0.0701 ปัจจุบัน) ✅ ตรงทุก order
- [x] B5 scheduled +2h → held=true ✅; release_scheduled_orders → held=false ✅
- [x] B6 stock 0 → insufficient_stock ✅; 86 → item_inactive 400 + restore ✅
- [x] 🐛 **B-01 FIXED**: loyalty redemption ใน place-order เป็น branch-scope ทั้งที่ระบบ brand-scope → ลูกค้า redeem แล้วเงียบ (0 ส่วนลด, ไม่ตัดแต้ม) + ledger ใช้ type 'redeem' ผิด constraint → แก้เป็น brand-aware + 'redeemed', deploy v9.5 (version 13), ยืนยัน: −$1, แต้ม 160→60, ledger ถูกต้อง ✅
- [x] 🐛 **B-02 FIXED**: place-order (public, no JWT) ไม่มี rate limit → เพิ่ม per-IP 60/10min + per-phone 15/10min (fail-open, ยกเว้น counter sentinel) → ยิง 16 ครั้ง: 15 ผ่าน ครั้งที่ 16 = 429 ✅

## Phase C — Customer storefront (:3000)
- [ ] C1 Landing + legal (/privacy /terms /ccpa toggle /help) + cookie banner + sitemap/robots
- [ ] C2 Order-type gate: บังคับเลือกก่อนเข้าเมนู, persist ต่อ branch, ข้าม branch → reset, deep-link /checkout โดน gate, branch ไม่มี delivery → tile หาย
- [ ] C3 Menu: search, dietary AND filter + Clear, category tabs scroll, sold-out overlay, happy-hour strikethrough, combos row + Save $, reviews strip, usuals (signed-in)
- [ ] C4 Item sheet: modifier radio/checkbox+max, required บังคับ, ราคา live = (price+delta)×qty, notes, recommendations
- [ ] C5 Cart: line แยก/merge ตาม signature, stepper→0 ลบ, combo contents, notes persist, guest hint
- [ ] C6 Checkout pickup + dine-in: contact validation, dine-in ต้องมีเลขโต๊ะ (block+focus), สั่งสำเร็จ → order + redirect tracking
- [ ] C7 Checkout delivery: address gate (ต้อง resolve coords), quote fee/ETA live, out_of_range block, dropoff_pref บังคับ, address save หลังสั่ง
- [ ] C8 Payment matrix: ปิด card ใน branch settings → เหลือ Cash; ปิดทั้ง mode → auto-flip / disabled submit
- [ ] C9 Tracking: realtime status bar, ขั้น "Out for delivery" ต้องไม่โชว์กับ pickup/dine-in (bug → fix), cancel (pending), edit instructions, rate modal delivered, report issue, receipt print
- [ ] C10 Account hub + addresses CRUD (Mapbox) + loyalty page + settings + orders list + reorder
- [ ] C11 /reserve: จองได้ → row + confirmation; แก้ Thai placeholder + orphan link (fix)
- [ ] C12 Sign-in UI: phone/email tabs render, `&apos;` literal bug (fix), safeNext guard; OTP/magic-link ยิงจริงไม่ได้ (no Twilio/Resend) → บันทึก config gap
- [ ] C13 Bug sweep: star artifact เมื่อไม่มี rating (fix), Stripe box โผล่บน cash order (fix), orders empty-state copy (fix), push-subscriber maybeSingle multi-restaurant (fix), checkout email เขียนข้าม tenant (fix)

## Phase D — Kitchen + Counter (:3004)
- [ ] D1 Kitchen: order ใหม่เข้า lane NEW แบบ realtime, advance ทุก stage + Undo, ล้าง backlog 19 orders ค้าง
- [ ] D2 Reject (pending), Recall (ready→cooking, เช็ค DB จริง), 86 ผ่าน kebab + Undo, station filter + drowning, aging tiers, batch view, audio, fullscreen
- [ ] D3 Pause → storefront block + banner; Busy +20m → ETA เพิ่ม
- [ ] D4 Scheduled drawer: order held โชว์ countdown ไม่เข้า lane
- [ ] D5 Delivery handoff: ready → "Find a rider" → dispatch; "Assign to a rider" picker (online/GPS badges)
- [ ] D6 Counter: role gate, channel switcher (delivery เฉพาะ entitled), สลับออกจาก dine-in ล้างโต๊ะ
- [ ] D7 Cart/discount/split/park+resume/hotkeys(1-9, Ctrl+P, Esc)
- [ ] D8 Cash charge → order confirmed → เข้า KDS ทันที; discount เขียน DB ถูก
- [ ] D9 🐛 Counter delivery channel พังโดยกำเนิด (ไม่มีช่อง address → 400) → แก้ (เพิ่มฟอร์ม address หรือตัด channel) + test
- [ ] D10 Recent orders + refund (full/partial, ขอบเขต validation); suspension: counter ถูก gate แต่ /recent + kitchen ยังเข้าได้
- [ ] D11 Clock in/out → staff_shifts เปิด/ปิด

## Phase E — Driver (:3001)
- [ ] E1 driver-auth: login เบอร์เดิม → session; เบอร์ใหม่ → needs_profile → signup → drivers row; invalid_phone
- [ ] E2 Online toggle scoped ทุก approved branch + AvailabilitySheet + partial-failure rollback; schedule self-service (insert + cron apply + ลบ)
- [ ] E3 Dispatch: offer sheet + TTL countdown; accept → active; reject → re-offer next; timeout → sweep re-offer; 2 rejects → cooldown pill + block
- [ ] E4 Active 5 stages: photo บังคับที่ picked_up + delivered (RPC enforce), illegal transition rejected, arriving → customer "Arriving now"
- [ ] E5 Map + Navigate deep links + Chat (realtime สองทาง, ปิดหลังจบ) + Call
- [ ] E6 Cancel pre-pickup / fail post-pickup (+photo) → admin triage banner → requeue
- [ ] E7 Earnings ledger + withdrawal request (bank validation, pending ซ้ำ block) + receipt หลังจ่าย
- [ ] E8 History filter, profile, KYC upload 3 docs → apply gate, merchant approve
- [ ] E9 GPS ping → current_location update; stale >5min → หลุดจาก candidates
- [ ] E10 Bug sweep: Support center dead button (fix), "Trusted by 2,300+ drivers" fake copy (fix), training orphan+unenforced (fix: link + note), battery '—%' (fix)

## Phase F — Admin back office (:3004/b/…)
- [ ] F1 Layout guard (non-staff denied), sidebar entitlement gating, dark mode persist
- [ ] F2 Dashboard: 🐛 fake trend bars + fake delta badges → แก้เป็นข้อมูลจริง + test
- [ ] F3 Orders: search/filter/saved views; refund by items (🐛 ignore modifier delta → fix), cancel, edit notes (🐛 เปิด blank ทับของเดิม → fix prefill), issue receipt (เช็ค RPC gate status), mobile ไม่มี actions (🐛 fix)
- [ ] F4 Menu: item CRUD + image, duplicate, DnD reorder, modifiers manager, combos, happy hours, CSV import, AI import (503 without key = graceful)
- [ ] F5 Inventory restock/waste + low-stock; Shifts + force clock-out + tip pool + CSV
- [ ] F6 Staff invite (edge fn ตอบ ok; email delivery = config gap) — ดู H3 ด้วย
- [ ] F7 Drivers: approvals, KYC review signed URLs + verify/reject, payouts pay/reject + receipt
- [ ] F8 Customers list, marketing broadcast → outbox rows, promos CRUD, receipts list + reprint, reports + 4 CSV exports
- [ ] F9 Reservations status flow (🐛 realtime ไม่อัปเดต state — fix), waitlist add/notify/seat/no-show, floor plan add/move/status cycle
- [ ] F10 Branch settings: identity/theme/tax, hours editor (atomic), closures, delivery settings + fee preview, payment toggles (🐛 card=false persist หลัง upgrade — เช็ค/fix), tip config, storefront override, jsonb clobber ระหว่างการ์ด (เช็ค)
- [ ] F11 Brands CRUD + loyalty scope, add branch seat-gated, franchise broadcast → items copied
- [ ] F12 QR page render + link ถูก (env fallback localhost — บันทึก config gap)
- [ ] F13 Plan page: package builder total, confirm → pending queue (Stripe dormant fallback), suspended ยังเข้าหน้านี้ได้

## Phase G — Platform admin (:3004/platform)
- [ ] G1 Dashboard stats + tenant list/search/filter chips + drawer per-branch verdicts
- [ ] G2 Open store cross-tenant (รวม tenant ที่ lapse — regression ปุ่มเคยตาย) + impersonation banner แสดงเฉพาะ non-staff
- [ ] G3 Audit trail: write ข้าม tenant → audit_logs actor_type='platform_admin' + changed_columns; mirror updates ไม่ log
- [ ] G4 Suspend/Restore ผ่าน drawer + Extend 1 month / Convert to Base (ราคา per-tenant ถูกต้อง)
- [ ] G5 Subscriptions manager (?q= prefill+auto-open) + Requests approve/reject → entitlements ทันที
- [ ] G6 Plans catalog CRUD (features jsonb ไม่ถูก clobber), Mark inactive ต้อง Save (บันทึกเป็น known behavior หรือ fix)
- [ ] G7 Platform settings: penalty/tips/defaults/features แก้แล้ว persist
- [ ] G8 Reports: การ์ดครบ + 🐛 broken link /platform/requests → fix เป็น /platform/subscriptions/requests
- [ ] G9 Non-admin → access denied ทุกหน้า

## Phase H — Auth & onboarding
- [ ] H1 Signup→onboarding: สร้าง tenant ใหม่ผ่าน `create_restaurant_with_branch` (user จริง) → trial + owner + redirect; ลบ tenant ทดสอบทิ้ง
- [ ] H2 /login UI + safeNext (// blocked); magic-link ต้องมี SMTP → config gap
- [ ] H3 Invite accept: staff_members pending + email match → active; email mismatch → error; not-signed-in dead-end (🐛 ไม่มีปุ่ม sign-in → fix)
- [ ] H4 test-sign-in routes ปิดใน production (ENABLE_TEST_AUTH ต้องไม่ set บน Vercel) — ตรวจ + บันทึก

## Phase I — System & security
- [ ] I1 Realtime: orders/deliveries/delivery_messages/reservations ยิง event ถึง client
- [ ] I2 notify-worker: secret ผิด → 403; in_app row → sent; sms/email → failed พร้อม *_not_configured (graceful); 🐛 email template ใช้ relative URL → fix
- [ ] I3 Cron 1-9 ทั้งหมด: job_run_details ล่าสุด succeeded
- [ ] I4 Storage policies: driver-kyc private (cross-role denied), receipts private, 🐛 proof photos อยู่ public bucket → ตัดสินใจ+fix, 🐛 branding policy bug (foldername เทียบผิด) → fix
- [ ] I5 🐛 Orphan edge fns (parse-voice-order, create-payment-source, omise-webhook) → ลบ; invite-staff source หายจาก repo → กู้เข้า repo
- [ ] I6 Security advisors (get_advisors) + revoke anon EXECUTE บน sensitive RPCs (defense-in-depth)
- [ ] I7 🐛 Migrations ไม่อยู่ใน repo → export schema dump เข้า repo
- [ ] I8 Batching (flag OFF): เปิดบน test branch → claim_batch_sibling จับคู่ detour ≤1mi → ปิด flag คืน (backend-level)
- [ ] I9 resolve_custom_domain RPC ตอบ slug ถูก (full DNS test = production task)
- [ ] I10 cancel_order คืน stock หรือไม่ (inventory compensation) — verify + ตัดสินใจ

## Phase J — Docs & handoff readiness (report)
- [ ] J1 HANDOFF.md / USER-GUIDE.md / USER-FLOWS.md stale (Thai-era, pre-packaging) → mark superseded + สรุปสิ่งที่ต้อง rewrite
- [ ] J2 CONFIG-CHECKLIST: env/secrets ที่ยังไม่ set (Twilio/Resend/Stripe/VAPID/ANTHROPIC) → สรุป config gaps ให้เจ้าของตัดสินใจก่อนส่งมอบ
- [ ] J3 SMOKE-TEST.md อัปเดตให้ตรง build ปัจจุบัน (order-type gate, tip 2-mode)
- [ ] J4 Final: type-check + unit + Playwright ทั้งชุดเขียวหลังแก้บัคทั้งหมด

---
### Bug log (running)
> เพิ่มรายการที่นี่ระหว่างทดสอบ: `B-xx  [phase]  อาการ → การแก้  (commit)`
