# ASAP delivery, the booked time, "Send to kitchen" and the 18% tip — 2026-10-25 (owner request)

Map of the code before this change: the read-only reports behind this spec (storefront, kitchen release, tips).

## 1. ASAP delivery is back on the storefront

The 2026-09-16 redesign made storefront delivery schedule-only ("Schedule Delivery"). The owner now wants both.

- The order type is **Delivery** again (`channel.delivery` reads "Delivery" in every language; the receipt and the
  orders list use the same key). Under it, at checkout:
  - an **ASAP** checkbox ("As soon as possible — your order goes to the kitchen as soon as it is placed"), and
  - the **Day / Time** pickers, whose Time list starts with an empty "Choose a time" option.
  - **They are mutually exclusive**: ticking ASAP clears the time and disables the pickers; choosing a time disables
    the ASAP checkbox until the time is set back to "Choose a time". Neither chosen → the order cannot be placed
    ("Tick ASAP or choose a time").
  - ASAP starts ticked when it is available. ASAP is available when the branch takes ASAP deliveries at all (see the
    2026-10-26 switch below), the branch is open now (`is_branch_open`), delivery is available now
    (`storefront_status.delivery`: entitled, the branch's delivery switch on, inside delivery hours) and a payment method
    is accepted for "now" orders. When it is not available the checkbox is disabled with the reason and a time is
    required.
  - Scheduling off ("Accept scheduled orders" unticked) now hides only the Day/Time pickers: delivery stays as ASAP
    where ASAP is ticked. Delivery disappears only when neither ASAP nor a booking is possible.
- **Per-branch switch, 2026-10-26 (owner request).** "Accept ASAP delivery orders" sits above "Accept scheduled orders"
  in Branch settings, in the same card. It is `branches.settings.asap_delivery_enabled` and is **on only when it is
  exactly `true`**: a missing key is off, and existing branches were not backfilled, so ASAP leaves every storefront
  until it is ticked (booked delivery is unaffected). One rule, `asapDeliveryEnabled()` in
  `packages/shared/src/utils/asap-delivery.ts`, with a pinned copy in `supabase/functions/place-order/asap-delivery.ts`;
  `patch_branch_settings` accepts only a JSON boolean or null for the key
  (`20261026100000_asap_delivery_switch`).
  - Off: the ASAP checkbox **does not appear** at checkout (hidden, not disabled with a reason); the Day/Time pickers
    stand alone and a time is required. The storefront reads the switch from `branches.settings` on every request, not
    from the tenant cached for 300 s. The closed-hours banner on the menu no longer mentions ASAP
    (`storefront.closed.canScheduleNoAsap`).
  - Both off: delivery is not offered online at that branch, and the storefront says so as a standing fact
    ("Delivery is not offered at this branch"), not as "not right now". The admin card warns before saving.
  - `place-order` v11.9 refuses a **web** delivery with no `scheduled_for` at such a branch with
    409 `{ error: 'delivery_must_be_scheduled', hint: 'invalid_channel' }`; a checkout left open hides the box and asks
    for a time. Counter and POS (staff) are exempt and still ring up deliveries for now. Pickup, dine-in and QR are
    untouched.
  - Deploy order: the migration; then admin and storefront together; the owner ticks ASAP where wanted; `place-order`
    last (deployed alone). The storefront before this change ticks ASAP by default, so `place-order` going out first
    would refuse it at every branch that has not ticked the box.
  - An ASAP delivery shows the quote's ETA ("arrives in about N min") instead of a booked time.
- An ASAP delivery is `channel = 'delivery'`, `scheduled_for = null`, `held = false`: it is on the kitchen board as soon
  as it is placed (as soon as it is paid, for a card payment), exactly like a pickup, and the rider is dispatched when
  the kitchen marks it Ready, exactly like any delivery.
- `place-order` drops the `delivery_must_be_scheduled` refusal. `pickup_is_asap_only` stays (pickup is always now).
  (v11.9 brings the code back for branches that have not ticked "Accept ASAP delivery orders"; see above.)
- The branch payment matrix's two columns are renamed for what they govern: **"Order now (pickup and ASAP delivery)"**
  and **"Scheduled delivery"**. The keys (`asap`, `scheduled`) do not change.

## 2. What the Time means

The copy under the Time picker says: the time the driver picks your food up at the restaurant to bring it to you —
the kitchen has it ready by then. (Rider search still starts when the kitchen marks the order Ready; §3 is what makes
the food ready by the booked time.)

## 3. "Send to kitchen (minutes before)" really works

It is `branches.settings.schedule_lead_time_min`, per branch (every branch of every restaurant). A booking for 11:30
with 5 → it reaches the kitchen at 11:25: `place-order` holds it (`held = true`), the minute cron
`private.release_scheduled_orders` releases it at `scheduled_for − lead`, an open kitchen board receives the realtime
update and chimes. What changes:

- **One resolver**: lead = `schedule_lead_time_min` if it is a whole number 0–10080, else `prep_time_min` if valid,
  else 15 — the same rule in SQL (`private.branch_kitchen_lead_min(settings jsonb)`), in place-order and in one shared
  TS helper used by the kitchen board, the counter, the dashboard and the settings card.
- **A bad value can no longer stop every release**: the release function uses the safe resolver (no raw `::int` casts),
  `patch_branch_settings` refuses a lead or prep time that is not a whole number 0–10080, and place-order reads a bad
  value as the default instead of NaN.
- **Release only what the kitchen will make**: held orders that are cancelled, completed or refunded are not
  released.
- **The release cron job is in a migration** (created if missing, every minute), so the repo can rebuild it.
- **Kitchen board**: the Scheduled drawer counts down to the kitchen time (`scheduled_for − lead`), not the booked
  time; a released booking's ticket shows its booked time ("Due 11:30"); the board starts with the branch's real lead
  from the server instead of 15.
- **Settings card copy and warnings**: the description says it plainly with the 11:30 → 11:25 example; a lead shorter
  than the branch's prep time shows a warning ("food may not be ready when the driver arrives"), and 0 says the
  booking reaches the kitchen only at its booked time.

## 4. Tip opens at 18%

`TIP_DEFAULT_PERCENT = 18` in `packages/shared/src/utils/tip-settings.ts` (one of the chips 18/20/25). The storefront
checkout opens with 18% selected on every channel; "No tip", Custom and tapping 18% again still work. Nothing is stored
per branch and no SQL changes. The POS counter has no tip step and is unchanged.
