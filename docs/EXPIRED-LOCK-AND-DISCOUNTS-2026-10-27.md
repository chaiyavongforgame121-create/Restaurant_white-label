# Expired restaurants and discount codes — 2026-10-27 (owner decision)

"A restaurant whose subscription has ended: the storefront stays closed, but the merchant can still
open the back office, which shows ONLY Plan & billing, so they can renew." And: "the platform's
Discount codes page must really work."

## 1. Who sees what once the subscription has ended

The rule lives in `getBranchAccess` (apps/admin/src/lib/capabilities.ts, via
apps/admin/src/lib/subscription-gate.ts), which every `/b`, `/counter` and `/kitchen` page and
layout calls, so no click inside the app gets around it.

- **Owner, admin, manager, cashier** (anyone with `backoffice.access`): every page sends them to
  Plan & billing, and the menu lists Plan & billing alone. The owner renews there; everyone else
  reads "ask the owner".
- **Server, staff, kitchen**: sent to `/suspended/<branch>`, which names the cause and says only the
  owner can renew.
- **Platform admins** keep full access, with a banner saying the subscription has ended.
- **Someone who does not work there** gets the ordinary access-denied card.
- **A failed read of the subscription locks nothing**: a "Couldn't check the subscription — Try
  again" banner instead, and plan-dependent features stay hidden.
- The database refuses new orders on its own (`orders_billing_gate`), whatever any screen does.

## 2. Orders placed before the end are finished

The kitchen board and the till's Recent list stay open, with a banner, while the branch has orders
those screens can still finish (`branchHasOrdersInProgress`):

- placed, or booked for, within the last 24 hours (Recent's own window), so a forgotten ticket from
  last month cannot keep them open for ever;
- a held booking counts (the board shows it in its Scheduled drawer and the release brings it on);
- tickets with lines only, as the board shows them;
- a storefront order still waiting for its transfer slip does not count (the slip is decided on
  the locked Orders page); a till sale waiting for its payment does (Recent settles it).

The till and Tables always lock; table bills and transfer slips wait for the renewal, and the lock
pages say so. The lock pages (Plan & billing for every role, `/suspended`) link to the screens that
are still open. The banner, `/suspended` and the "ask the owner" card ask the server again every
minute, so a renewal unlocks them and the last order finished locks them without a reload.

## 3. Discount codes (migration 20261027100000_discount_codes_hardening)

- **The price confirmed is the price filed.** The plan page sends the totals the merchant confirmed
  (`p_expected_one_time`, `p_expected_monthly`); when the server prices differently it files nothing
  and answers `quote_changed` with its own figures, which the page asks about before sending again.
- **An abandoned card checkout gives its code back**: on `checkout.session.expired` (stripe-webhook),
  and an hourly sweep (`billing-release-stale-checkouts`) for an expiry the webhook never handled.
- The server refuses what the console refuses: `code_invalid_chars`, `code_too_long` (40
  characters, the most a Stripe line names), `product_not_one_time`, `ends_before_start`,
  `per_restaurant_limit_invalid`. Codes are written only through the platform RPCs.
- A deleted restaurant keeps its redemption history; a discounted Stripe line names the code and the
  amount off; a failed read shows an error, never "No codes yet" or $0.
