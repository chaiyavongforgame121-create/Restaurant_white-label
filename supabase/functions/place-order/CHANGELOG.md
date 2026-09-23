# place-order — change log

Moved out of the top of `index.ts` on 2026-08-28. It had grown to 110 lines and was
the bulk of the file; every deploy had to carry it. The history is the valuable part,
so it lives here rather than being deleted.

```
// place-order v11.6 — every branch is its own shop
//   v11.6 (2026-09-23): delivery is the BRANCH's answer, not the restaurant's.
//        - Delivery is sold per branch now (docs/PACKAGING-2026-09-23.md §2): a restaurant can
//          deliver from one branch and not from the next. The billing gate therefore loads
//          entitlements for { restaurantId, branchId } instead of the restaurant alone, so
//          `delivery` means "this branch delivers".
//        - A delivery order at a branch that does not deliver is refused with the same
//          403 { error: 'feature_not_entitled', feature: 'delivery' } as before, and with
//          nothing written. Without this it reached orders_billing_gate instead, which raises
//          feature_not_entitled:delivery as a P0001 in the middle of the handler — the exact
//          half-written-order failure the up-front check exists to avoid.
//        - The quote_delivery `delivery_not_entitled` → 403 below is unchanged and now only
//          covers the race where a merchant switches the branch's delivery off mid-checkout.
//        - No change to pickup, dine-in or QR ordering, and none to the 402 billing_inactive
//          path: being paid up is still a question about the restaurant.
//   v11.5 (2026-09-22): one line per selection. No SQL half.
//        - The owner's report: SET A tapped from the storefront's Happy Hour strip and again from
//          the menu came out as two SET A lines on the bill. On the bill in question (A-2609-0005)
//          the two differed by an option (7 x "No Egg", 1 x the default "Runny-Yolk Fried Egg"
//          +$2.00), which is rightly two lines; this makes sure identical ones never are.
//        - Before anything is looked up or priced, payload lines are consolidated
//          (consolidateLines, a hand mirror of consolidateOrderLines in
//          packages/shared/src/utils/modifiers.ts): dish lines with the same menu_item_id, the same
//          SET of modifier_option_ids (any order) and the same trimmed note become one line with
//          the quantities added; combo lines with the same combo_id and trimmed note likewise.
//          The first line of a selection keeps its place. Stock/demand, sold-out, option, reward
//          and price checks all run on the consolidated lines (their sums are unchanged).
//        - Each line as sent is still held to 1..99 (400 invalid_quantity); a consolidated line
//          above 99 is refused the same way (not clamped: that would bill 99 for 110 ordered).
//          Two lines that each passed can now fold into one that does not, e.g. two combo adds of
//          60 and 50, which v11.3 took as two lines; the storefront cart therefore stops every
//          merge at 99 (MAX_LINE_QUANTITY in modifiers.ts) and never sends such a pair.
//        - A line's note is stored trimmed, and a blank one as null (it was stored as sent). An
//          option id repeated on one line counts once: it was charged, and listed, twice.
//        - modifier_option_ids that is present but not an array is refused with 400
//          invalid_modifiers (a string was read as one id, or threw a TypeError: a bare 500).
//        - Quote and charge still agree: the storefront cart's subtotal() and the till's
//          quoteCounterCart (counterLineSubtotals) price lines of one selection as the one line
//          this function makes of them, because lineTotal rounds a line once on its whole quantity
//          (2 x $7.995 is $15.99 as one line, $16.00 as two). The storefront checkout also sends
//          its lines already consolidated (consolidateOrderLines), so the payload is the lines it
//          priced.
//        - No change to the free_item rule here, but the checkout's quote of it was wrong in a
//          happy hour and is fixed on that side: loyaltyRewardDiscount priced the reward at
//          list_loyalty_rewards.menu_item_price, the LIST price ($15.99 off for a dish selling at
//          $7.995), while this function takes off lineTotal(unit, 0, 1) of the happy-hour unit
//          ($8.00), so the diner was charged $7.99 more than the checkout showed. It now reads the
//          unit from the same cart line this function matches (the first dish line of the item,
//          never a combo line). v11.4's "the quote and the charge agree" did not hold for this
//          one case until then.
//   v11.4 (2026-09-22): a unit price is never rounded to the cent. SQL half:
//        20260922100000_exact_unit_prices (order_items.unit_price numeric(12,4), and
//        get_effective_prices returns round(eff_price, 4)).
//        - The owner's report: seven SET A at Food Thai Thai's 50% happy hour ($15.99 -> $7.995)
//          showed $55.97 on the cart line but $56.00 as the Subtotal, on "Proceed to checkout" and
//          on the saved bill (7 x $8.00). Each line was r2(r2(price + options) x qty), so the unit
//          was rounded to $8.00 before it was multiplied, and numeric(10,2) rounded it again.
//        - A line is now lineTotal(unit, options, qty): (unit + options) x qty in whole
//          ten-thousandths, rounded half-up to the cent ONCE (7 x 7.995 = 55.965 -> $55.97). The
//          subtotal is sumMoney() of the lines, the exact sum with nothing rounded after it. Both
//          are hand mirrors of packages/shared/src/utils/money.ts, which the storefront cart, the
//          checkout and the counter's quoteCounterCart use, so the quote and the charge agree.
//        - order_items.unit_price is stored to four decimals (7.995, not 8.00); subtotal and
//          modifier_total stay cents. A combo line goes through lineTotal() too.
//        - A free_item reward takes off what that one unit is charged as a line of one,
//          lineTotal(unit, 0, 1): $8.00 for a $7.995 dish, never a fraction of a cent.
//        - Tax, fees, discounts, the tip, gift-card credit and the total are unchanged: computed
//          from the subtotal in cents, as before.
//   v11.3 (2026-09-19): a transfer with nothing to pay is not stranded.
//        - A 'transfer' order whose total is 0 (a gift card or reward covered it all) is inserted
//          with awaiting_payment false. It had no payment row to approve (payments_amount_check
//          refuses 0, so the insert failed silently), sat in "awaiting payment" for good and never
//          reached the kitchen. It now goes through like any other order with nothing to collect.
//        - No payment row is attempted for a total of 0 (the insert only ever failed there);
//          payment_id is null in the 201 body, as it already was.
//        - Unchanged since v11.1: a reserve_order_credits failure that is not a known refusal is
//          released (release_order_credits) before the order is deleted.
//   v11.2 (2026-09-19): after a second review.
//        - A combo line's quantity is held to the dish-line rule: a whole number 1..99, else 400
//          invalid_quantity {combo_id}. It was clamped silently (0 -> 1, 2.7 -> 2, 150 -> 99), so a
//          client bug was charged, stock-checked and cooked for a quantity it never sent.
//        - In SQL (same migration, applied as a delta): find_branch_customer_by_phone reads a number
//          stored without a country code only under the branch's own calling code (its timezone's,
//          as the till reads a number typed without a +) or +1; '+44 626 638 6401' no longer finds
//          the diner who stored '626 638 6401'. reserve_order_credits locks the gift card, then the
//          promo, then the points, the order a cancel and release_order_credits give them back in,
//          so a checkout and a cancel of the same diner's other order cannot deadlock.
//   v11.1 (2026-09-18): after review. SQL half: the same migration, extended and re-applied.
//        - The till's customer_lookup_phone is matched by digits through
//          find_branch_customer_by_phone(branch, phone): the same digits in any format, or a number
//          stored nationally (trunk 0 dropped) behind a 1-3 digit country code. The exact text match
//          never found a diner who typed '6266386401' when the till sent '+16266386401' (Food Thai
//          Thai's only customer with a phone). The 201 body carries customer_matched when a number
//          was looked up, so the counter can say whether the sale was filed under a regular.
//        - A promo or gift-card refusal carries hint 'stale_client_refresh_required': a storefront
//          deployed before these refusals existed finds no copy for their codes and showed only
//          "Something went wrong", while this code it maps to "please refresh and try again", which
//          clears the code or card. The counter reads `error` only.
//        - A reservation that fails with anything but a known refusal (a timeout may have committed)
//          is released before the order is deleted; release_order_credits works only from the rows
//          the order has, so it is harmless when nothing was taken. A failed delete is logged.
//        - In SQL: a cancelled or refunded order that never completed now gives its gift-card credit
//          and promo use back (orders_return_credits_on_cancel), and takes them again if reopened;
//          a walk-in's promo use has its promo_redemptions row too.
// place-order v11.0 — every branch is its own shop
//   v11.0 (2026-09-18): the owner opened a second branch and asked that nothing be shared
//        between branches but the diner's login. SQL half: 20260918140000_order_pipeline_integrity.
//        - Staff first, per branch. staffPlaced is decided straight after auth by
//          staff_can_ring_up(user, branch) (= staff_has_capability(branch,'counter.access'):
//          owner rows and restaurant-wide rows cover every branch, plus owner_user_id and platform
//          admins). It used to be any active staff row of the restaurant, decided AFTER the
//          customer, so a Hamburger cashier could ring up Food Thai Thai around its payment matrix
//          and every counter sale was filed under the cashier's own customer record. A counter/POS
//          caller who is not staff here now gets 403 not_staff_at_branch instead of being treated
//          as a diner. orders.staff_id is set from the caller's staff row for the branch.
//        - Staff sales are walk-ins (customer_id null) unless the till sends customer_lookup_phone
//          (E.164) matching an existing customers row at THIS branch; it is only read, never
//          created or claimed. Web orders resolve and create the diner by (branch_id, user_id);
//          the phone claim is per branch; a blank existing row gets the typed name/phone filled in
//          (placeholder phone and 'Walk-in'/'Table N' skipped, a phone held by another row at the
//          branch left out). The v26 lookup by (user, restaurant) errored for anyone with rows at
//          two branches and filed their orders as guest orders.
//        - discount_percent (0-100, staff only; 400 invalid_discount_percent, 403
//          discount_requires_staff) comes off the food before tax AND the card service fee, is
//          stored in orders.discount_amount and written to audit_logs ('order.discount'). The
//          counter used to take it off afterwards and overwrite orders.total from the browser.
//        - Order numbers from next_order_number(branch): A-YYMM-NNNN per branch, month in the
//          branch timezone, atomic. The old call to private.generate_order_number could never run
//          through PostgREST, so every order got a random number that could collide (500). The
//          insert retries once on a 23505 order-number clash.
//        - Points, promo and gift card are taken for the order in ONE transaction
//          (reserve_order_credits) right after the insert; any refusal deletes the order: 409
//          insufficient_points / promo_exhausted / per_customer_limit_reached / promo_unavailable /
//          gift_card_changed. The debit is conditional (balance >= cost) and writes the 'redeemed'
//          ledger row with the order's branch, which the cancel trigger gives back. If the order
//          lines then fail, release_order_credits gives all three back before the order is deleted.
//        - Rewards are looked up with branch_id = the order's branch; the loyalty_scope 'brand'
//          paths are gone (a CHECK pins it to 'branch').
//        - Promos: validate_promo_code gets p_customer_id, so the per-customer limit is finally
//          enforced on the server; a code sent as applied that no longer validates is refused
//          (409 with the promo's own code and promo:true) instead of silently charging more; a use
//          is counted only when the code gave something (a free-delivery code on a pickup does not
//          spend the diner's use).
//        - Gift cards are checked with the branch (check_gift_card(code, branch)); a card that no
//          longer checks out is 409 gift_card_changed instead of being ignored, and a redeem that
//          does not return the full credit refuses the order.
//        - Combos: combo_items are read with the set; 409 combo_empty, 409 combo_item_unavailable
//          {combo_id, item_id, reason: not_in_branch|inactive|sold_out|insufficient_stock,
//          available?} (hint combo_inactive for substring matchers); archived sets are
//          combo_inactive. The combo line stores combo_contents [{menu_item_id, name, quantity
//          (per ONE combo), station}] for the kitchen and the stock trigger.
//        - Stock: demand is summed per dish across dish lines and combo contents before it is
//          compared; a tracked dish with null stock counts as 0. insufficient_stock carries
//          item_id and available. Quantities must be whole numbers 1..99.
//        - Counter delivery contract: delivery_address {line1 (required), notes, lat, lng,
//          dropoff_pref}; a staff sale defaults dropoff_pref to 'hand_to_me' and needs a real
//          customer_phone (400 customer_phone_required); without lat/lng the flat
//          settings.delivery_fee (default 3.99) applies and quote_delivery is skipped. A saved
//          address that resolves to nothing is 400 delivery_address_required.
// place-order v10.5 — US pivot + modifiers + combos + happy-hour + schedules + gift cards
//   v10.5 (2026-09-08): dine-in by QR is a SESSION, and this function enforces it.
//        Two holes closed. First, `payload.table_id` was taken verbatim — the FK proves
//        the row exists, not that it belongs to the branch being ordered from, so a token
//        lifted from one restaurant's table tent could stamp an order at another branch
//        with that branch's table id, and the ticket was walked to a table that is not
//        there. It is now read back and checked for branch and is_active, and the same
//        rule is enforced by tg_orders_table_and_session on orders so a direct insert
//        cannot skip it. Second, dine-in was orderable forever by anyone holding the
//        token: verify_jwt is false, the storefront's sign-in requirement is client-side
//        javascript, and there was no session because there was no session entity. A
//        dine-in order with source 'web' now requires an OPEN table_sessions row at that
//        table, a signed-in caller (401 sign_in_required), and a table_session_participants
//        row for that exact sitting (403 not_at_this_table); a payload.session_id that no
//        longer matches the sitting is 409 table_session_changed. Settling the bill closes
//        the session, so the code on the tent is inert until staff seat the next party.
//        Counter and POS are exempt in the other direction: they may seat the table
//        themselves, so a walk-in rung up at the till joins the same bill the diner's
//        phone is adding to. orders.session_id is written, and the trigger assigns
//        session_seq — the round number the kitchen ticket prints.
//        Auth moved up: it used to be resolved after pricing, which is far too late to
//        gate anything, so it is now read once straight after the branch fetch and reused
//        by the customer/loyalty block rather than fetched twice.
//   v10.4 (2026-09-08): scheduled orders are now checked against the branch's BOOKABLE
//        window, not only its opening hours. The times a diner could pick came from
//        branch_hours alone — whenever the kitchen is open, it is bookable — so a shop
//        open every day that wanted pre-orders from 17:00 Monday to Saturday but only
//        10:00-14:00 on Sunday had no way to say so. Those windows live in the new
//        branch_schedule_hours, armed per branch by settings.schedule_hours_enabled, and
//        are judged by is_schedule_window_open() `at time zone branches.timezone` — asking
//        here would use the edge runtime's UTC and put a Bangkok shop seven hours out.
//        Returns true whenever the feature is off, so every existing branch is unaffected.
//        source 'counter'/'pos' are exempt: it is a self-service policy for diners, and a
//        manager taking a phone booking IS the override. They are not exempt from opening
//        hours. Refusals are 409 outside_scheduling_window.
//        This function is NOT the only writer of orders — orders_public_insert lets anon
//        INSERT a pending row into any active branch, and until now no BEFORE INSERT
//        trigger checked opening hours at all, so a hand-crafted PostgREST request could
//        book a pickup for 3am on a day the shop was shut. The real gate is
//        tg_enforce_scheduled_time on public.orders; the check here exists so the diner
//        gets readable copy instead of a database error. Both must exempt the same
//        sources or a counter booking passes one and dies in the other.
//        An insert rejected by one of those triggers is now returned as the 409 it is
//        rather than a 500 order_insert_failed carrying the code in `detail`.
//   v10.3 (2026-09-04): the delivery row now records the surge multiplier the quote
//        applied. quote_delivery has returned `surge` since the delivery backbone and
//        nothing ever read it, so deliveries.surge_multiplier sat at its column default
//        on every order and there was no way to answer "was this one surged, and by how
//        much" after the fact — not for support, not for reporting, not for a dispute.
//        Only written when the RPC actually quoted (an address with coordinates); the
//        no-coordinates flat-fee path leaves the column alone. Historical rows keep the
//        default whether or not they were surged, so reporting on it has to start here.
//   v10.2 (2026-09-04): the service fee is now a CARD-ONLY surcharge. It used to be
//        computed from branches.settings.service_fee_percent before any payment gate
//        ran, so cash, QR transfer, dine-in (submitted as 'cash') and every counter /
//        POS sale were charged it too — invisibly, since the counter prints a receipt
//        it builds itself and never showed a fee line. The fee now moves below the
//        entitlement / transfer / matrix gates and is charged only when
//        payment_method === 'card', with no staff exemption: a card sale at the till
//        is a card sale. The percentage is clamped to 0–25% here as well as in the
//        admin editor, so a hand-edited jsonb cannot exceed the advertised ceiling.
//        Mirrored by computeServiceFee() in packages/shared/src/utils/pricing.ts.
//        Historical rows keep their fee — those totals were really collected.
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
