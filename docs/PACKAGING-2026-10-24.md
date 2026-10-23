# Packaging — 2026-10-24: one plan, every feature included (owner decision)

Replaces [PACKAGING-2026-09-23.md](PACKAGING-2026-09-23.md), which stays as history. Every price in that file is dead.

## 1. What the owner sells now

"Simple pricing. One plan. Every feature included."

| What | Paid once | Every month |
|---|---|---|
| **FavorNoms Plan**, includes the first branch (`base`) | **$199** first-time setup and onboarding | **$49** |
| **Additional branch** (`extra_branch`), each branch after the first | **$89** additional branch setup | **$49** |

Monthly: **$49 per branch**. One-time: **$199 for the first branch, $89 for each branch after it.**

    1 branch      $199 once, then  $49 / month
    2 branches    $288 once, then  $98 / month
    3 branches    $377 once, then $147 / month

Included in the plan, at every branch:

- All customer, admin and driver features
- Branded ordering website + web app
- POS, kitchen display and branch management
- FavorGo driver tools (delivery)
- Marketing, loyalty and reports
- No marketplace commissions

**Delivery is no longer an add-on.** It is part of the plan at every branch. The `delivery` product is withdrawn.

The 14-day free trial is unchanged: $0, every feature, 1 branch.

## 2. Entitlements: exactly these, nothing missing, nothing extra

The plan's feature map is exactly `{"card_payment": true, "delivery": true}`, the same as the trial's. Those are the
only two features any code checks for a paying restaurant; everything else on the owner's list (POS/counter, kitchen
display, loyalty, promos, reports, customers, inventory, QR, HQ, franchise, staff, custom domain, PWA) needs no feature
key, only a paid-up restaurant and the staff member's capabilities.

| Feature / limit | Trial | FavorNoms Plan | Lapsed (deadline passed) |
|---|---|---|---|
| card_payment (restaurant-wide) | yes | yes | no new card sales |
| delivery (per branch) | every branch whose delivery switch is on | every branch whose delivery switch is on | no new deliveries |
| branch seats | 1 | 1 + additional branches bought | cannot add a branch |
| ai_suite, ai_voice, digital_signage, ai_menu_import | **no** | **no** | no |

Withdrawn features stay withdrawn ("nothing extra"):

- No product grants `ai_suite`, `ai_voice`, `digital_signage` or `ai_menu_import`.
- `import-menu` (the AI menu import edge function) is gated on `ai_menu_import`, which nothing grants. It used to
  check only that the restaurant was paid up, so any paid-up restaurant could call it directly.
- `restaurants.feature_overrides` is written only by a platform admin. A restaurant owner used to be able to write it
  directly (the guard trigger returned early for the owner) and so grant themselves any feature.
- Every override that switched a withdrawn feature **on**, or repeated a plan feature as `true`, is removed. Overrides
  set to `false` (a platform admin switching a feature off) are kept.

## 3. Delivery at a branch: a free switch, on by default

The old per-branch delivery add-on was also the merchant's only way to say "this branch does not deliver". That
control stays, but it is no longer billed and it lives in branch settings, not on the plan page.

- `branch_addons` (code `delivery`) is reinterpreted: **a row with `active = false` means the merchant switched
  delivery off at that branch.** No row, or `active = true`, means the branch delivers. So a new branch delivers.
- The migration deletes every existing `branch_addons` row, so every branch delivers after the switch-over.
- The rule, identical in SQL (`private.branch_feature_granted`) and in the edge (`_shared/entitlements.ts`
  `branchDeliversToday`):

      branch delivers = restaurant entitled (deadline in the future)
                        AND billing_entitlements.features.delivery = true
                        AND NOT EXISTS (branch_addons row for this branch, code 'delivery', active = false)

  No plan-code or trial exception any more.
- `public.set_branch_delivery(p_branch_id uuid, p_enabled boolean) returns boolean` switches it: on deletes the row,
  off upserts `active = false`. Allowed for staff with `branch.settings` at that branch, the owner and platform admins.
- Deliveries already in flight are never stranded: the `deliveries` row is gated once, at insert.
- Billing never reads or writes `branch_addons` any more.

## 4. Data and functions (the contract every part is built to)

### 4.1 Catalog (`billing_products`)

| code | name | kind | once | monthly | included_seats | seats_per_unit | features | active |
|---|---|---|---|---|---|---|---|---|
| `base` | FavorNoms Plan | plan | 199 | 49 | 1 | 0 | `{card_payment, delivery}` | yes |
| `extra_branch` | Additional branch | addon | 89 | 49 | 0 | 1 | `{}` | yes |
| `trial` | Free trial | plan | 0 | 0 | 1 | 0 | `{card_payment, delivery}` | yes |
| `delivery` | Delivery (withdrawn) | addon | 0 | 0 | 0 | 0 | `{}` | **no** |
| `ai_suite` | AI Suite (withdrawn) | addon | — | — | — | — | — | no |

The `delivery` and `ai_suite` rows are kept, not deleted: history (`billing_charges`, `billing_requests`) refers to
them by code. `base.monthly_price` must equal `extra_branch.monthly_price` so "per branch" holds.

### 4.2 SQL

- `private.branch_feature_granted(branch, 'delivery')`: the rule in §3. Other keys stay restaurant-wide.
- `private.billing_compute`: no delivery line; seats and totals from `base` and `extra_branch` lines only.
- `private.billing_apply_selection`, `public.request_package_change`, `public.billing_set_package`,
  `public.validate_billing_discount`, `private.billing_price_one_time`, `public.billing_checkout_context`: no delivery
  anywhere. **Their `p_delivery_branch_ids uuid[]` parameters stay in the signatures and are ignored**, so no caller
  has to change in lockstep; new code sends `[]`. New `billing_requests` rows get `addons = '{}'` and
  `delivery_branch_ids = '{}'`.
- `private.billing_paid_state`: `delivery_unlocked_branch_ids` is always `[]`.
- `private.entitlements_json`: `features.delivery` (branch payload) follows §3; `delivery_branch_ids` lists the active
  branches that deliver now; `delivery_unlocked_branch_ids` is the same list (kept for old readers).
- `public.get_billing_overview`: `branches[].delivery_active` = that branch delivers now; `delivery_unlocked` = true.
- Dropped: the card-rail triggers `branches_block_stripe_delivery_loss`, `branches_block_stripe_delivery_loss_delete`,
  `branches_stripe_delivery_off_on_hide` and their functions. Hiding a branch no longer touches delivery.
- Migration data: catalog as in §4.1; `subscription_items` with `product_code = 'delivery'` deleted; every `base` and
  `extra_branch` item and `subscriptions.unit_price` repriced to 49; every pending `billing_requests` row cancelled with
  its charges voided and discount uses released; `branch_addons` emptied; overrides cleaned as in §2; every restaurant
  recomputed. One-time charges already paid stay as they were paid: nobody owes the difference.

### 4.3 Edge

- `_shared/entitlements.ts` `branchDeliversToday`: the rule in §3, no `'trial'` exception.
- `_shared/stripe-billing.ts`: the sold monthly codes are `base` and `extra_branch`; `delivery` is a legacy code that is
  recognised on an existing Stripe subscription, always targeted at quantity 0 (so the next change removes it) and never
  required for the catalog to be complete or for setup products. Product names:
  "FavorNoms Plan (first branch), monthly", "Additional branch, monthly", "FavorNoms Plan, first-time setup",
  "Additional branch setup".
- `import-menu`: requires `ai_menu_import` (§2).
- No restaurant was billed by card when this shipped (no `stripe_subscription_id` anywhere), so no live Stripe
  subscription needed repricing.

### 4.4 `packages/shared` (`utils/entitlements.ts`)

```ts
export const FEATURE_DELIVERY = 'delivery';
/** @deprecated delivery is not sold any more; kept so old rows and callers still parse. */
export const ADDON_DELIVERY = FEATURE_DELIVERY;

export interface PackageSelection { planCode: string; branchSeats: number }
export interface BillingPaidState { basePaid: boolean; seatsPaid: number }

monthlyLines(sel, catalog)        // plan line + extra_branch × (seats − included_seats); nothing else
oneTimeLines(sel, catalog, paid)  // base once (unless paid) + extra_branch once × seats not yet covered
branchMonthly(sel, catalog)       // the per-branch monthly price (49; 0 on the trial)
```

`Entitlements.deliveryBranchIds` stays (branches that deliver now). `deliveryUnlockedBranchIds` is removed.

### 4.5 `packages/database` (`queries/billing.ts`)

- `getBillingOverview`: `branches: Array<{ id; name; deliveryOn: boolean }>`; `paid: BillingPaidState` (no delivery).
- `requestPackageChange`, `setRestaurantPackage`, `validateBillingDiscount`: take a `PackageSelection` without
  delivery and send `p_delivery_branch_ids: []`.
- New `getBranchDeliveryEnabled(supabase, branchId): Promise<boolean>` and
  `setBranchDelivery(supabase, branchId, enabled): Promise<boolean>`.

## 5. Surfaces

- **Landing page** (`apps/web`): "Simple pricing. One plan." / "Every feature included."; one plan card "$49 / month
  per branch" with a Best value badge and the six included items; side cards "First-time setup $199 — One-time setup
  and onboarding." and "Additional branch setup $89 — Per additional branch." Prices read from the catalog. The call to
  action stays the 14-day free trial (there is no demo-booking flow).
- **Merchant plan page**: one plan, every feature included; branch rows at $49 each with no delivery switch; the
  "Add a branch" stepper at "+$89 once, +$49/month"; totals without delivery.
- **Branch settings**: a "Delivery at this branch" switch above the delivery settings; the add-on upsell card is gone.
- **Delivery pages** (Live deliveries, Drivers, Payouts, the Delivery report, dashboard tiles, the counter's Delivery
  tile): shown when the branch delivers; when its switch is off they say so and point to branch settings, never to the
  plan page and never with a price.
- **Platform console**: no "which branches deliver" picker, delivery badge, delivery request diff or delivery errors.

## 6. Prices for restaurants that existed on 2026-10-24

Every paying restaurant moved to $49 per paid branch at once, with delivery included. Already-paid one-time charges
($170 / $70, or older) are history: nobody is asked for the difference. Trials are untouched.
