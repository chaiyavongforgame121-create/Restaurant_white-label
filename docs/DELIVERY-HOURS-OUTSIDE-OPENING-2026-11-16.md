# Delivery hours outside opening hours — 2026-11-16 (owner report)

## The report

A merchant at the branch "Thai Burrito" (America/Chicago) is open 09:00–17:30 every day and wants customers to order
**delivery only** 08:00–09:00 and 18:00–19:00. They tried both switches the back office has, and nothing could be
ordered:

- "Limit the times customers can book" (Scheduled orders card: `settings.schedule_hours_enabled` +
  `branch_schedule_hours`), and
- "Limit delivery to set hours" (Delivery card: `settings.delivery_hours_enabled` + `branch_delivery_hours`).

Every check started from opening hours (`public.is_branch_open`) and only narrowed from there. Windows that lie
entirely outside opening hours left an empty set: the storefront offered no time and place-order refused one.

## The rule

| # | Order | Allowed when |
|---|-------|--------------|
| R1 | Pickup, dine-in, every non-delivery order | Opening hours decide (`is_branch_open`), unchanged. |
| R2 | Delivery while "Limit delivery to set hours" is **on** (`settings->>'delivery_hours_enabled' = 'true'`) | At time T if and only if the branch exists, is active, is not paused (`settings.orders_paused`), no `branch_closures` row covers T, and T is inside a `branch_delivery_hours` window (`is_delivery_available(branch, T)`, overnight windows in the branch's zone). **Opening hours do not apply**: the delivery windows are the delivery's own hours and may lie before opening or after closing. |
| R3 | Delivery while it is **off** | Opening hours decide (`is_branch_open`), exactly as pickup. Unchanged. |
| R4 | A booked delivery (`orders.scheduled_for` set) | R2/R3 at `scheduled_for`; for a diner (web) order **also** the booking windows when those are on (`is_schedule_window_open`, unchanged), plus the lead time and horizon settings, unchanged. |
| R5 | An ASAP delivery | R2/R3 at `now()`, plus "Accept ASAP delivery orders" (`settings.asap_delivery_enabled`), unchanged. |

`public.is_branch_open_for(p_branch_id uuid, p_channel text, p_at timestamptz default now()) returns boolean` is the
single judge of R1–R3 in the database. In TypeScript the matching helpers are `deliveryRangesForDay` and
`effectiveBookableRanges(opening, bookable, dow, delivery)` in `packages/shared/src/utils/schedule-windows.ts`; a caller
passes the branch's delivery windows as `delivery` only while `delivery_hours_enabled` is true, else null.

A window's end is exclusive, as before: 08:00–09:00 takes 08:00 up to 08:59, not 09:00 itself.

Live data at the time of the change: only Thai Burrito has delivery or booking windows outside its opening hours, and no
live branch has `delivery_hours_enabled` true, so no existing branch changes behaviour until someone switches it on.

## What the merchant does

For a shop open 09:00–17:30 that delivers 08:00–09:00 and 18:00–19:00:

1. On the **Delivery** card with "Who delivers?" (Branch settings), switch on **Limit delivery to set hours**, add
   08:00–09:00 and 18:00–19:00 on one day, "Copy to all days", and save. Under each day the card now says which part
   lies outside opening hours ("Outside opening hours: 8:00 AM – 9:00 AM, 6:00 PM – 7:00 PM. Customers can order
   delivery then, but not pickup."). That line is information only; nothing blocks saving.
2. On **Scheduled orders**, "Limit the times customers can book" can stay off: bookable times then follow the delivery
   windows. Left on, the booking windows narrow the delivery windows, never widen them, so they must overlap. Each day
   reads back "Customers will see: 8:00 AM – 9:00 AM, 6:00 PM – 7:00 PM".
3. With "Accept ASAP delivery orders" ticked, an ASAP delivery can be placed inside those windows too.

Pickup and dine-in stay 09:00–17:30. A closure day or "Pause new orders" still stops delivery.

## Back office (apps/admin)

- **Scheduled orders card** (`scheduled-orders-card.tsx`). "Customers will see" is
  `effectiveBookableRanges(openingHours, draftWindows, day, deliveryHoursOn ? deliveryWindows : null)`, through
  `bookingPreview()` in `_components/delivery-hours-model.ts`. It uses the Delivery card's **saved** switch
  (`settings.delivery_hours_enabled`) and windows, because those are what the storefront and place-order read. The page
  (`branch/page.tsx`) reads `branch_delivery_hours` **and `branch_hours`** on the server and passes both down
  (`deliveryWindows`, `openingHours`), so the `router.refresh()` after the Delivery card saves brings the new windows
  with the new switch, and the `router.refresh()` the Opening hours card (`hours-editor.tsx`) now does after a save
  brings the new opening hours. Both cards used to read `branch_hours` once on mount and kept the hours from page load
  until a reload. A failed read is null, and the line is then left out instead of guessed (opening hours unread only
  hides a day's line while delivery hours are off, since they do not matter while those are on; "Same as opening
  hours" is hidden too rather than copying nothing).
  - A day whose booking windows give nothing **while delivery hours are off** (they miss opening hours) says how to
    fix it: switch on "Limit delivery to set hours" further down and add those times there
    (`scheduling.outsideOpeningFix`). This is the exact state the owner's merchant was in. It also says the side
    effect: once that switch is on, delivery runs **only** in the windows set there, so a branch that still delivers
    during opening hours must add those daytime hours as well.
  - A day whose booking windows miss the delivery windows while those are on reads "nothing — the branch does not
    deliver during these hours" (`scheduling.noDeliveryDuringWindows`) instead of "the branch is closed".
  - "Same as opening hours" becomes **"Same as delivery hours"** while delivery hours are on, and copies the delivery
    windows: copying 09:00–17:30 against 08:00–09:00 deliveries would offer nothing.
- **Delivery card** (`delivery-hours-card.tsx`). The hint (`deliveryHours.limitHint`) says the windows are the delivery
  hours, may lie before opening or after closing (with the 09:00–17:30 / 08:00–09:00 + 18:00–19:00 example), that
  pickup still follows opening hours, and that closures and a pause still stop delivery. The new per-day info line is
  `deliveryHours.outsideOpening`, from `deliveryOutsideOpening()`.
- **Copy** (`apps/admin/messages/{en,es,th,vi}/branchOps.json`): `scheduling.description`, `scheduling.limitHint` and
  `scheduling.asapHint` now say bookable and ASAP times start from the branch's delivery hours (opening hours, or the
  delivery windows when delivery is limited to set hours), narrowed by the booking windows.
- **Till** (`counter/[branchId]/_components/counter-delivery.tsx`, `useDeliveryHours`). Whether Charge opens for a
  delivery is `is_branch_open_for(branch, 'delivery')`, the judge place-order v11.11 asks, with the same mapping as
  before (true open, false closed with `errors.deliveryNotAvailableNow`, an error or a non-boolean unknown, which does
  not block). It asked `is_delivery_available`, which knows only the delivery windows: with delivery hours off it said
  "open" after closing, during a pause and on a closure day, and place-order refused at Charge, for a QR sale after
  the customer had paid.
- **Platform tenant drawer** (`platform/_components/tenant-drawer.tsx`, `tenant-health.ts`). The per-branch "what a
  diner sees" verdict probed only `is_branch_open`, so a branch delivering on its own hours outside business hours
  read "Closed now — order submit returns 409", false for its deliveries. A branch with `delivery_hours_enabled` true
  (`BranchLite.delivery_hours_on`, read by `platform/page.tsx`) at a restaurant that has delivery
  (`needsDeliveryProbe`) is now also asked `is_branch_open_for(branch, 'delivery')`. Outside business hours,
  `branchVerdict` then answers live with "Delivery only (outside business hours)"
  (`health.verdict.hint.deliveryOnly`, `health.verdict.why.deliveryOnly`), closed with
  `health.verdict.why.outsideAllHours` when the delivery windows are shut too, and unknown
  (`health.verdict.why.deliveryUnknown`) when that probe fails; it waits for the probe rather than saying closed.
- No other back-office screen combines opening hours with delivery windows.

Deploy note — the order matters, and it is:

1. **Migration `20261116100000_delivery_hours_outside_opening.sql`** (creates `public.is_branch_open_for`, re-creates
   `tg_enforce_scheduled_time` to ask it, adds `delivery_open_now` to `storefront_status`). On its own it changes
   nothing a diner sees: no live branch has `delivery_hours_enabled` true, and the deployed place-order still asks
   `is_branch_open` first, so it refuses what it refused before.
2. **place-order v11.11**, deployed **with its new `closed-refusal.ts`** next to `index.ts` (it imports it; through
   the Management API / MCP rather than the CLI, pass both files). It calls `is_branch_open_for`, so it needs step 1:
   before the migration that RPC does not exist, the open check returns an error, and only the insert triggers judge.
3. **The web and admin apps.** They read `delivery_open_now` and build bookable times from the delivery windows
   alone while delivery hours are on (`deliveryRangesForDay` / `effectiveBookableRanges`), and the till and the
   platform drawer call `is_branch_open_for`.

Why web goes last: a storefront shipped before the database and place-order would offer the delivery slots outside
opening hours (08:00–09:00, 18:00–19:00) that the old server still refuses: the old place-order's `is_branch_open`
check answers `branch_closed` / `branch_closed_at_scheduled_time`, and the old `tg_enforce_scheduled_time` raises
`branch_closed_at_scheduled_time` at insert. The diner would pick a time and then be told the shop is closed. The same
holds for the back office: its previews would promise times the old server refuses, and before the migration its
`is_branch_open_for` calls fail (the till then treats delivery as unknown and does not block; the drawer shows
"Hours unknown" for a branch with its own delivery hours while it is outside business hours). An older web or admin against the new database is safe: it
ignores `delivery_open_now`.
