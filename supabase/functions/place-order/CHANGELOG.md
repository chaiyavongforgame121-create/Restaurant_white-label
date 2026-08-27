# place-order — change log

Moved out of the top of `index.ts` on 2026-08-28. It had grown to 110 lines and was
the bulk of the file; every deploy had to carry it. The history is the valuable part,
so it lives here rather than being deleted.

```
// place-order v10.1 — US pivot + modifiers + combos + happy-hour + schedules + gift cards
//   v10.1 (2026-08-28): 'transfer' joins card|cash as a payment method. The diner scans
//        the branch's own QR (branches.settings.qr_transfer.image_url), transfers, and
//        uploads a slip; the merchant approves it from Orders. A branch with the method
//        enabled but no QR saved is refused here with 400 transfer_not_configured rather
//        than sending the diner to a payment step with nothing to scan. The order stays
//        'pending' until approval — enforced in the DB by orders_block_unpaid_transfer,
//        not by this function, so the kitchen screen cannot start early either.
//        `gateway` now keys off 'card' rather than "not cash", so a transfer payment is
//        not mislabelled as a Stripe charge.
//   v10.0 (2026-08-16): points now buy NAMED REWARDS, not arbitrary dollars off.
//        The old `redeem_points` let any diner slide up to 50% of the subtotal off
//        at 100 pts = $1, with the merchant unable to say what points are for.
//        Redemption is now keyed on `reward_id` pointing at a row the merchant
//        published in `loyalty_rewards`, and this function prices it server-side
//        (percent_off with an optional cap / fixed_off / free_item / free_delivery).
//        Points cost is whatever the merchant set — decoupled from the discount.
//        `redeem_points` is REJECTED with 409 stale_client_refresh_required rather
//        than ignored: ignoring it would charge a pre-catalog client more than the
//        total it displayed, and a silent overcharge is worse than a forced reload.
//   v9.9 (2026-08-16): scheduled orders are checked against the time the food is
//        wanted, not the time the order was typed. is_branch_open() was called
//        with no p_at, so a branch closed right now rejected every pre-order for
//        tomorrow (409 branch_closed) — scheduling was unusable outside opening
//        hours — while an order placed during today's lunch for a day the branch
//        is shut sailed straight through. scheduled_for is now parsed BEFORE the
//        hours check and passed as p_at; a slot outside hours returns the
//        distinct code `branch_closed_at_scheduled_time` so the diner is told to
//        pick another time rather than that the restaurant is closed.
//   v9.8 (2026-08-11): login is now MANDATORY for customer-placed orders. A non-staff
//        caller with no authenticated user is rejected 401 login_required, before any
//        customer/loyalty/order work. The storefront also gates add-to-cart and
//        checkout, but this is the real gate: `source` is client-supplied, so a guest
//        cannot pose as a staff channel — callerIsStaff() reads the JWT role and a
//        tokenless caller is never staff, so staffPlaced stays false and the 401 fires.
//   v9.7 (2026-08-11): ACCOUNT TAKEOVER fix in lazy customer creation. When the
//        (user, restaurant) lookup missed, the insert that followed could lose
//        customers_restaurant_phone_uidx, and the fallback then re-read the row by
//        (restaurant_id, phone) alone — on the service-role client, so no RLS. Since
//        phone sign-in is OTP-less and customer_phone is raw request body, any signed-in
//        diner could name a victim's number and have customerId resolve to the VICTIM's
//        row: their loyalty balance was then readable, spendable, and the order was filed
//        under their identity. The fallback now re-reads the caller's own row, and only
//        claims a phone-matched row while it is UNOWNED (user_id IS NULL — the staff- or
//        guest-created row the fallback was actually written for). Nothing safe to adopt
//        means a guest order, not someone else's account.
//   v9.6 (2026-08-11): dine-in is exempt from the merchant payment matrix — the
//        dine-in checkout has no payment step and always sends 'cash' ("pay at
//        the restaurant"), so a branch that had turned asap.cash off would have
//        rejected every dine-in order with payment_method_not_accepted. The
//        entitlement gate and the invalid_payment_method check still apply.
//        + Loyalty redemption now requires a PROVEN identity (403
//        google_link_required), checked before the order row is written. Phone
//        sign-in is OTP-less, so knowing a phone number is enough to become that
//        customer; proving the account is really yours is the second factor that
//        stops a stranger spending someone else's points. Either a linked Google
//        identity OR a confirmed real email (the shipped magic-link path) counts —
//        NOT the synthetic customer-auth address every phone diner carries. Staff-
//        placed orders (counter/POS) are exempt — the authenticated user there is
//        the cashier, not the diner. The wire code stays `google_link_required`
//        for clients that already match on it.
//   v9.5 (2026-08-10): loyalty redemption is brand-scope aware. The balance
//        check and debit previously filtered loyalty_points by the ordering
//        branch_id, but brand-scope balances (the locked default) live at
//        branch_id NULL + restaurant_id, so redemption silently did nothing.
//        The ledger insert also used type 'redeem', which violates the
//        loyalty_transactions type check ('redeemed').
//                  + distance-based delivery fees (Mapbox location backbone, Phase 1)
//                  + payment-method gating + structured drop-off.
//   v9.4 (2026-08-06): `channel` is validated against the enum (400 invalid_channel)
//        instead of failing as a Postgres cast. New `source` field ('web' | 'counter'
//        | 'pos', default + fallback 'web') is stored on the order instead of the
//        hardcoded 'web'. Dine-in from source 'web' now requires table_id or
//        table_number (400 table_required) — staff surfaces are exempt because the
//        counter takes walk-in dine-in with no table. A supplied table_number is
//        resolved (exact match, dine_in/qr_ordering only) against the branch's
//        active `tables` rows to populate orders.table_id, which until now no
//        surface ever wrote.
//   v9.2 (2026-07-12): payment gating from branches.settings.payment_methods
//        ({asap|scheduled}.{cash|card}); absent key/subkey => allowed, explicit false
//        => 400 payment_method_not_accepted. Delivery orders now require a structured
//        drop-off: delivery_address.dropoff_pref (leave_at_door | hand_to_me | at_desk
//        | other), dropoff_other required when 'other'; free-text fields trimmed and
//        length-capped (dropoff_other 120, gate_code/room 40) and whitelisted into the
//        delivery_address JSON stored on the order (survives saved-address rebuild).
//   v9.3 (2026-07-12): payment gating exempts active staff of the branch's restaurant
//        (the counter/POS pay buttons are staff-facing, not customer-facing); a
//        checkout-typed delivery_address.notes now survives the saved-address rebuild.
//   v9   (2026-06-11): when delivery_address has lat/lng (direct or saved address),
//        calls quote_delivery() for the authoritative distance fee + heuristic ETA,
//        rejects out-of-radius addresses (409 delivery_out_of_range), and populates
//        deliveries.pickup_location/delivery_location/dropoff_lat/lng/distance_km/
//        estimated_duration_min. No coords → legacy flat fee (graceful fallback).
//   v9.1 (2026-06-11): scheduled orders beyond prep_time+15min are inserted with
//        held=true (hidden from the kitchen) and released by pg_cron at
//        scheduled_for − prep_time (private.release_scheduled_orders).
//   v8.1 (2026-06-11): modifiers column is NOT NULL '[]'::jsonb — send [] not null.
//   • Computes US sales tax from branches.sales_tax_rate.
//   • Drops PromptPay payment_method, US uses card | cash.
//   • Reads delivery_fee from branch settings (defaults to $3.99).
//   • Item modifiers: client sends modifier_option_ids[], server looks up
//     price_delta from modifier_options table and adds to line subtotal.
//   • Combos: client sends `combos` array. Each combo entry resolves to one
//     order_items row with combo_id set and the combo's total_price as unit price.
//   • Happy hour: server fetches get_effective_prices() and uses those instead
//     of menu_items.price when present.
//   • Schedules: rejects items whose availability_schedule doesn't include now.
// Server-side recalculation never trusts client totals.
```
