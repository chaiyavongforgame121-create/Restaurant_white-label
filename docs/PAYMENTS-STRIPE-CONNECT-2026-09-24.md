# Card payments — Stripe Connect, paid straight to each branch (owner decision 2026-09-24)

## 1. What the owner wants

1. Every restaurant enters its own banking details.
2. When a diner pays a branch by card, the money is that branch's, in that branch's own account.
3. The platform only builds the software. It never holds, receives or forwards a diner's money, takes no cut of an
   order, and does not carry the restaurants' card fees or disputes.

The platform earns only its own subscription ($170 once + $29 a month per branch, docs/PACKAGING-2026-09-23.md), which
stays a separate flow (billing_requests → billing_charges).

The platform's Stripe account is a **United States** account (confirmed by the owner, 2026-09-24).

## 2. The model

**Stripe Connect, Standard-type connected accounts, direct charges.**

- Each branch connects a Stripe account of its own. The account is created by the platform with **Accounts v2**
  (`POST /v2/core/accounts`), as Stripe's implementation planner requires of new platforms (read through the Stripe
  MCP, 2026-09-24): the restaurant gets the full Stripe Dashboard (`dashboard=full`), Stripe collects the verification
  and bank details (never our forms), **the account pays its own Stripe fees**
  (`defaults.responsibilities.fees_collector=stripe`), and **Stripe, not the platform, is liable for the account's
  negative balances** (`losses_collector=stripe`, "Managed Risk"), with the `merchant` configuration's
  `card_payments` capability requested. The restaurant onboards on a Stripe-hosted Account Link v2
  (`POST /v2/core/account_links`, HTTPS return/refresh URLs). Readiness is read with `GET /v1/accounts/{id}`, which
  Stripe documents for v2 accounts and which keeps `charges_enabled` / `requirements` in the shape the app stores.
- A diner's card is charged **on the branch's connected account** (a direct charge: the PaymentIntent is created with
  the `Stripe-Account` header). The charge, the fee, the payout, any refund and any dispute all live in the branch's
  account. There is **no `application_fee_amount`**: the platform takes nothing.
- Two branches of one restaurant may share one connected account (same business, same bank). The branch settings offer
  "use the same account as <other branch>" so the owner onboards once. A branch with its own bank connects its own.
- The platform can see its connected accounts and their payments in its own Stripe Dashboard, but the money never
  passes through the platform's balance.

## 3. Rules the code must keep

1. **The platform account is never charged for a diner.** The payment function refuses to create a PaymentIntent
   without a connected account id for the order's branch. The old function, which charged the platform account, is
   replaced; turning on `STRIPE_SECRET_KEY` for the subscription billing must not open a path that sends diners' money
   to the platform.
2. **The connected account id is server-owned.** It lives in its own table, written only by the service role (edge
   functions). It is never in `branches.settings` (a manager can write any key there and diners can read it) and never
   taken from the client.
3. **Card is offered only where it can be paid.** A branch shows card at checkout only when its connected account has
   `charges_enabled` (and the restaurant holds the `card_payment` entitlement, as today). Otherwise the diner sees the
   other methods, never a card form that cannot work.
4. **Nothing reaches the kitchen unpaid.** A card order is `awaiting_payment` until Stripe says the payment succeeded,
   exactly as a transfer order waits for its slip today. An unpaid card order expires and is cancelled 30 minutes
   after it was placed. A payment Stripe still reports as processing buys at most another 30 minutes (60 in all);
   after that the order is cancelled too, and money that arrives later is refunded, never sent to the kitchen.
   **Only cards are accepted** (Apple Pay and Google Pay included, as Stripe runs them as cards): the PaymentIntent
   and the Payment Element both list `card` instead of taking the branch's own Stripe payment-method settings,
   because a full-Dashboard branch could otherwise switch on a bank debit (ACH) that stays processing for up to four
   business days.
5. **Stripe is the source of truth for money.** A payment is marked paid, failed, refunded or disputed from a verified
   webhook event (with a client-side re-check after confirming, so the diner is not left waiting on a slow webhook).
   Every event is deduplicated.
   - **Refund state comes from Stripe's current objects, never from an event's snapshot alone.** Events arrive out of
     order, retries come hours late, and a refund that succeeded can still fail. A refund event re-reads the refund on
     the connected account; `charge.refunded` lists the charge's refunds (or, if it cannot, re-reads the charge) and
     never applies its own `refunded: true`. In the database a refund only moves forward: failed and canceled are
     final, and nothing goes back to pending. Money counts as returned only while a refund is pending or succeeded.
   - **Money that arrived is always recorded.** A card success is written to the payment even when a rule on the order
     refuses to confirm it (for example a transfer row still waiting for its slip); the order then stays pending, its
     history says why (`card_payment_order_not_confirmed`), and the webhook logs it for a person instead of failing
     until Stripe gives up.
6. **Refunds happen in Stripe.** Refunding an order from the back office creates the refund on the branch's connected
   account and records it; cancelling a paid card order refunds it.
7. **Card surcharges follow US card rules.** The card "service fee" a branch can add is capped at **3%** (the card
   networks' ceiling for credit-card surcharges); it was 25%. Branches set above 3% are read as 3%.
8. **A payment belongs to its order's branch.** The database refuses any `payments` row whose branch is not its
   order's branch (`payment_branch_mismatch`), for every writer, the service role included. The staff write policies
   check the payment's own branch only, so without this another restaurant's owner who learned an order id could hang
   a payment on it (a pending transfer row on a card order froze the diner's paid card payment).

## 4. Flows

### 4.1 A branch connects Stripe (admin → Branch settings → Card payments)

1. The owner presses **Connect Stripe** (or picks "use the same account as <branch>").
2. An edge function creates the connected account if the branch has none (US, business type chosen by the restaurant
   on Stripe's page), stores its id, and returns an Account Link (`account_onboarding`) with return/refresh URLs back to
   the branch settings page.
3. The owner completes Stripe's hosted onboarding: business, owners, identity, **bank account**.
4. `account.updated` webhooks (and a refresh on return) keep `charges_enabled`, `payouts_enabled`,
   `details_submitted` and the outstanding requirements current. The card shows the state in plain words: not
   connected / finish setting up / under review / ready to take cards / action needed, with a button to continue
   onboarding or open the Stripe Dashboard (login link).

### 4.2 A diner pays by card (storefront checkout)

1. Checkout shows Stripe's Payment Element for branches that are card-ready, loaded with the branch's connected
   account id (deferred-intent flow: the element is shown before the PaymentIntent exists).
2. On **Place order**: place-order creates the order (`awaiting_payment = true`) and its pending `payments` row, then
   the payment function creates the PaymentIntent on the branch's account for exactly the order's total (server-priced,
   in cents, with an idempotency key per payment), and the browser confirms it.
3. Success (including after 3-D Secure) returns to the order page, which re-checks the PaymentIntent; the
   webhook marks the payment paid, which clears `awaiting_payment` and puts the order on the kitchen board.
4. A failed or abandoned payment leaves the order unpaid; the diner can retry from the order page until it expires.

### 4.3 Back office

- Refund (whole or part) from the order's Refund dialog → refund on the connected account → recorded → the webhook
  confirms.
- Disputes appear on the order and in the payments report; they are answered in the branch's own Stripe Dashboard.
  Once a formal dispute has taken the money back (`needs_response`, `under_review` or `lost`) there is nothing to
  refund: the Orders row says "Disputed" instead of offering a refund, the Refund dialog says to answer the dispute,
  a refund request is refused before Stripe is asked (`disputed`), and a cancel goes ahead without a refund. An
  inquiry (`warning_*`) or a won dispute leaves the money with the restaurant, so it stays refundable.
- A cancel or refund also records any refund made straight in the branch's Stripe Dashboard that the webhook has not
  delivered yet, so one press is enough.
- The counter and POS keep recording card payments taken on an external terminal (unchanged).

## 5. What the owner sets up (once)

In the platform's **US Stripe account** (start in **Test mode**):

1. **Connect** → get started; platform profile ("software platform", restaurants in the US; the platform does not
   handle funds; connected accounts pay their own fees).
2. **Connect → Settings → Branding**: name, icon, colour (shown on Stripe's onboarding pages).
3. **Developers → Webhooks → Add endpoint**, "Events on connected accounts", pointing at
   `https://ayyfczidnzxetndiijmv.supabase.co/functions/v1/stripe-connect-webhook`, with the events listed in the
   function's header.
4. In **Supabase → Edge Functions → Secrets**: `STRIPE_SECRET_KEY` (the test secret key), `STRIPE_PUBLISHABLE_KEY`
   (the test publishable key), `STRIPE_CONNECT_WEBHOOK_SECRET` (from step 3). Keys are entered by the owner only.

Going live later repeats 3–4 with live keys.
