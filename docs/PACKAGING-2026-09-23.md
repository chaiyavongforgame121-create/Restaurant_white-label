# Packaging — 2026-09-23 (owner decision)

Replaces the all-monthly model of [PACKAGING-2026-07-25.md](PACKAGING-2026-07-25.md). That file stays as history; every
price in it is dead.

## 1. What the owner sells now

| What | Paid once | Every month |
|---|---|---|
| **Base** — includes the first branch | **$228** | **$29** (that branch) |
| **Extra branch** — each branch after the first | **$99** | **$29** (that branch) |
| **Delivery** — per branch, chosen by the owner | **$59** | **$29** (that branch) |

The base covers: card payment at checkout, online ordering & QR, reports & loyalty, kitchen display & counter, one
branch. **Delivery is never in the base.**

Monthly, in one sentence: **every branch is $29, and a branch with delivery is $58.**

    1 branch, no delivery                        $29 / month
    2 branches, delivery on one         29 + 58 = $87 / month
    2 branches, delivery on both        58 + 58 = $116 / month

One-time, in one sentence: **$228 for the first branch, $99 for each branch after it, $59 to unlock delivery on a
branch.** A branch's $59 is paid once ever. Switching that branch's delivery off and on again later costs nothing
one-time; it only changes the monthly bill.

The **AI Suite** add-on is withdrawn. So is the **AI menu import** screen (the CSV importer on the same page stays).

The 14-day trial is unchanged: $0, everything on, delivery included on every branch, so the merchant can try it before
the add-on is sold to them.

## 2. Delivery is per branch

Today one restaurant-wide flag (`billing_entitlements.features->'delivery'`) switches delivery on for every branch.
It becomes per branch:

- The owner picks which branches deliver. Everything about delivery — the storefront's Delivery order type, the
  delivery fee quote, the counter's Delivery tile, the Live deliveries board, Drivers, Driver payouts, the dashboard's
  delivery cards and warnings, the Delivery report section, dispatch — is on only for the branches that have it.
- A branch without delivery reads as "this branch does not deliver", never as "your add-on is gone".
- While the restaurant is on the trial, every branch delivers.
- Deliveries already in flight are never stranded: switching delivery off on a branch does not stop a rider finishing a
  run. A `deliveries` row is gated once, when it is inserted (`deliveries_billing_gate`), so a delivery that already
  exists is always dispatched and finished, whatever the branch's switch or the restaurant's billing says now.

## 3. Data model

### 3.1 Catalog (`billing_products`)

New column `one_time_price numeric(10,2) NOT NULL DEFAULT 0` beside the existing `monthly_price`.

| code | kind | one_time | monthly | included_seats | seats_per_unit | is_quantity | features |
|---|---|---|---|---|---|---|---|
| `base` | plan | 228 | 29 | 1 | 0 | false | `{card_payment:true}` |
| `extra_branch` | addon | 99 | 29 | 0 | 1 | true | `{}` |
| `delivery` | addon | 59 | 29 | 0 | 0 | true | `{delivery:true}` |
| `trial` | plan | 0 | 0 | 1 | 0 | false | `{card_payment:true, delivery:true}` |
| `ai_suite` | addon | — | — | — | — | — | `is_active = false`, removed from every subscription |

`delivery` becomes a **quantity** product: its `quantity` is the number of branches that have delivery.

`ai_menu_import` leaves the feature maps of `base` and `trial` (nothing sells it any more). The key stays defined in
code so old rows and platform overrides keep parsing.

### 3.2 Per-branch add-ons (`branch_addons`)

```
branch_addons(
  branch_id uuid references branches(id) on delete cascade,
  code text not null,                         -- 'delivery' today
  active boolean not null default true,       -- billed monthly while true
  unlocked_at timestamptz not null default now(),  -- the one-time fee was paid then; never charged again
  updated_at timestamptz not null default now(),
  primary key (branch_id, code))
```

### 3.3 One-time ledger (`billing_charges`)

Every one-time fee is a row, so the plan page never charges for something already bought and the platform console can
see what is owed.

```
billing_charges(
  id uuid pk,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  branch_id uuid references branches(id) on delete set null,   -- for extra_branch / delivery
  code text not null,                    -- 'base' | 'extra_branch' | 'delivery'
  amount numeric(10,2) not null,         -- list price
  discount_code text,
  discount_amount numeric(10,2) not null default 0,
  net_amount numeric(10,2) not null,     -- amount - discount_amount
  status text not null check (status in ('pending','paid','void')),
  request_id uuid references billing_requests(id) on delete set null,
  created_at, paid_at, created_by)
```

Money is still collected out of band (Stripe is dormant), so a platform admin approving a request marks its charges
`paid`. When Stripe wakes up, the same rows are what a checkout session is built from.

### 3.4 Discount codes (platform)

```
billing_discount_codes(
  id uuid pk,
  code text not null unique,             -- stored upper-case, compared upper-case
  description text,
  kind text not null check (kind in ('percent','fixed')),
  value numeric(10,2) not null check (value > 0),   -- percent 1..100, or dollars
  product_codes text[] not null default '{}',       -- empty = every one-time charge
  max_redemptions int, redemption_count int not null default 0,
  per_restaurant_limit int not null default 1,
  starts_at timestamptz not null default now(), ends_at timestamptz,
  is_active boolean not null default true,
  created_by uuid, created_at, updated_at)

billing_discount_redemptions(
  id uuid pk, code_id uuid not null references billing_discount_codes(id) on delete cascade,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  request_id uuid references billing_requests(id) on delete set null,
  amount_off numeric(10,2) not null, redeemed_at timestamptz not null default now())
```

**Codes discount one-time charges only** (the base, an extra branch, a delivery unlock) — that is what the owner
described, and it keeps the recurring bill one number everyone can check. The merchant types the code before paying;
the server prices it. A code is never trusted from the client.

RLS: only platform admins read or write `billing_discount_codes`. A merchant only ever sees the result of
`validate_billing_discount(...)` (SECURITY DEFINER), which returns the amount off and a label, never the row.

## 4. Flows

### 4.1 The merchant's plan page (`/b/<branch>/settings/plan`)

Shows, in this order:

1. **What you have now** — plan, branches, which branches deliver, next payment date.
2. **Your branches** — one row per branch: its $29, a Delivery switch showing "+$29/month" and, the first time it is
   switched on for that branch, "+$59 once".
3. **Add a branch** — the seat stepper, "+$99 once, +$29/month each".
4. **What you pay** — two totals, never mixed:
   - **Pay once today**: the sum of the one-time charges this change adds, minus a discount code if one applies.
   - **Then every month**: `$29 × branches + $29 × delivery branches`, itemised per branch.
5. **Discount code** — a box beside the one-time total. Typing a code re-prices the one-time total server-side and
   shows the code's label and what came off.
6. Submit → Stripe Checkout when Stripe is configured, otherwise the existing `billing_requests` queue (today's path).

### 4.2 Platform console

- **`/platform/discounts`** (new) — create, edit, deactivate codes; see redemptions, and how much has been given away.
- **`/platform/subscriptions/requests`** — each request shows the one-time charges, the code used and the discount, and
  the resulting monthly total. Approving applies the package, writes `branch_addons`, marks the charges paid and
  confirms the code's use. A code's use is **reserved when the merchant submits**, so the limits are enforced then,
  and a code deactivated or expired after submission never blocks the approval: the merchant keeps the price they
  were quoted. Rejecting or replacing the request voids its charges and gives the use back.
- **`/platform/subscriptions`** — per restaurant: which branches deliver, the monthly total and the one-time history.

## 5. Rules the code must keep

1. **One price, one place.** `billing_products` is the catalog; nothing hardcodes 228/99/59/29 in a component. The
   landing page reads the same numbers.
2. **The server prices everything.** `request_package_change` and `billing_apply_selection` recompute the monthly
   total, the one-time total and the discount from the catalog and the ledger. The client's numbers are display only.
3. **Never charge a one-time fee twice.** A `paid` `billing_charges` row for `base`, for a branch's `extra_branch`,
   or for a branch's `delivery` means it is bought (and a branch whose delivery was ever unlocked keeps it unlocked).
   A `pending` row is only on order: replacing a pending request voids its charges first, then prices the new one, so
   two identical requests always price the same.
4. **Both rails agree.** The manual approval path and the Stripe webhook path both go through
   `billing_apply_selection`, so they cannot drift.
5. **Per-branch means per branch everywhere.** `private.branch_has_feature(branch, 'delivery')` is the only gate, and
   every surface that shows delivery asks it (or asks an entitlements payload that was resolved for that branch).
   `card_payment` stays restaurant-wide.
6. **Fail closed.** A missing row, a lapsed deadline or an unparsable payload reads as "no".

## 6. Migration of what exists

- Restaurants whose live entitlements include `delivery` keep it: a `branch_addons` row (active, `unlocked_at = now()`)
  is written for **every** branch they have, and no one-time charge is raised. They are grandfathered, not re-sold.
- Every existing paid restaurant gets `billing_charges` rows marked `paid` for the base and for each branch seat beyond
  the first, so the plan page does not ask them to buy what they already have.
- `ai_suite` subscription items are deleted and the product is deactivated; nobody is billed for it again.
- `subscription_items.unit_price` is reset to the new monthly prices (29), so `billing_compute` produces the new
  monthly totals for everyone.
- Existing trials are untouched.

## 7. The contract the code is built to

So the database, the merchant page and the platform console can be written at the same time, these names and shapes are
fixed here. Anything not listed keeps working as it does today.

### 7.1 `packages/shared/src/utils/entitlements.ts`

```ts
export interface BillingProduct { code; name; kind; monthly_price; one_time_price; included_seats;
  seats_per_unit; is_quantity; trial_days; features; description; sort_order; is_active }

export interface PackageSelection {
  planCode: string;            // 'base'
  branchSeats: number;         // branches paid for, >= 1
  deliveryBranchIds: string[]; // the branches that deliver
}

/** What is already bought, so nothing one-time is charged twice. */
export interface BillingPaidState { basePaid: boolean; seatsPaid: number; deliveryUnlockedBranchIds: string[] }

export interface PriceLine { code: string; label: string; qty: number; unit: number; total: number; branchId?: string }

export function monthlyLines(sel, catalog): PriceLine[];      // base/extra branch $29 each + delivery $29 each
export function packageMonthlyTotal(sel, catalog): number;    // 29 * seats + 29 * deliveryBranchIds.length
export function oneTimeLines(sel, catalog, paid: BillingPaidState): PriceLine[];  // only what is not paid yet
export function packageOneTimeTotal(sel, catalog, paid): number;
export function branchMonthly(sel, catalog, branchId): number;  // 29, or 58 with delivery
export function deliversHere(ent: Entitlements): boolean;       // branch-resolved payload: features.delivery
export const ADDON_DELIVERY = 'delivery'; // unchanged
// ADDON_AI_SUITE is removed; FEATURE_KEYS keeps its keys so old rows still parse.
```

`Entitlements` gains `deliveryBranchIds: string[]` (every branch of the restaurant that delivers) and keeps
`features.delivery` meaning "this payload's branch delivers" when it was loaded for a branch.

### 7.2 `packages/database/src/queries/billing.ts`

```ts
getBillingOverview(supabase, restaurantId): Promise<{
  entitlements: Entitlements;
  branches: Array<{ id: string; name: string; deliveryActive: boolean; deliveryUnlocked: boolean }>;
  paid: BillingPaidState;
  charges: Array<{ id; code; branchId; amount; discountCode; discountAmount; netAmount; status; createdAt }>;
}>;
validateBillingDiscount(supabase, { restaurantId, code, selection }): Promise<{
  valid: boolean; reason?: string; label?: string; oneTimeTotal: number; amountOff: number; netTotal: number }>;
requestPackageChange(supabase, { restaurantId, selection, discountCode, note }): Promise<BillingRequest>;
// platform console
listDiscountCodes(supabase): Promise<DiscountCode[]>;
createDiscountCode(supabase, input): Promise<DiscountCode>;
updateDiscountCode(supabase, id, patch): Promise<DiscountCode>;
listDiscountRedemptions(supabase, codeId): Promise<DiscountRedemption[]>;
```

### 7.3 SQL

```
public.get_billing_overview(p_restaurant_id uuid) -> jsonb          -- entitlements + branches + paid + charges
public.validate_billing_discount(p_restaurant_id uuid, p_code text,
        p_plan_code text, p_branch_seats int, p_delivery_branch_ids uuid[]) -> jsonb
public.request_package_change(p_restaurant_id uuid, p_plan_code text, p_branch_seats int,
        p_delivery_branch_ids uuid[], p_discount_code text, p_note text) -> jsonb
        -- the request row, or {ok:false, reason} when the code cannot be used (the attempt still counts
        -- towards the guessing limit: 10 unsuccessful checks per restaurant per 15 minutes)
public.decide_billing_request(p_id uuid, p_approve boolean, p_note text) -> void   -- applies + marks charges paid
public.billing_set_package(p_restaurant_id uuid, p_plan_code text, p_branch_seats int,
        p_delivery_branch_ids uuid[], p_status text, p_period_end timestamptz) -> void
public.platform_list_discount_codes() -> setof billing_discount_codes
public.platform_create_discount_code(p jsonb) -> billing_discount_codes
public.platform_update_discount_code(p_id uuid, p jsonb) -> billing_discount_codes
public.platform_list_discount_redemptions(p_code_id uuid) -> jsonb
private.branch_has_feature(p_branch_id uuid, p_key text) -> boolean  -- 'delivery' per branch, everything else per restaurant
```

`request_package_change` and `billing_apply_selection` take `p_delivery_branch_ids` instead of an addons array; the
`delivery` subscription item's quantity is that array's length. `billing_requests` gains
`delivery_branch_ids uuid[]`, `one_time_total numeric`, `discount_code text`, `discount_amount numeric`.
