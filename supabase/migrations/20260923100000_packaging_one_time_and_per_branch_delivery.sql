-- Packaging, 2026-09-23 (owner decision, docs/PACKAGING-2026-09-23.md). Two changes that the
-- billing schema has never been able to express, plus the discount codes the owner wants to sell
-- with.
--
-- 1. MONEY IS NOW PAID ONCE *AND* EVERY MONTH. billing_products had exactly one price column
--    (monthly_price) and no interval flag, so "$228 to start, then $29 a month" had nowhere to
--    live. A one_time_price column joins it, and public.billing_charges becomes the ledger of
--    what has actually been bought: one row per one-time fee, so the plan page can never ask a
--    merchant to pay for the base, a branch seat or a branch's delivery twice. Money is still
--    collected out of band (Stripe is dormant: no secret key, no stripe_price_id on any row), so
--    a platform admin approving a request marks that request's charges paid. When Stripe wakes
--    up these are the rows a checkout session is built from.
--
-- 2. DELIVERY IS PER BRANCH. One restaurant-wide flag (billing_entitlements.features->'delivery')
--    switched delivery on for every branch of a restaurant, and private.branch_has_feature()
--    looked per-branch while joining billing_entitlements on b.restaurant_id -- both of Coastal
--    Grill's branches took delivery orders off one add-on. public.branch_addons now says which
--    branches the owner chose, branch_has_feature() resolves 'delivery' through it, and
--    storefront_status / entitlements_json answer per branch. Every OTHER key keeps its
--    restaurant-wide meaning; card_payment in particular is sold with the base and must stay
--    restaurant-wide, or a second branch would silently lose card checkout.
--
--    Nobody is re-sold anything. Every restaurant whose live entitlements include delivery gets
--    an active branch_addons row for EVERY branch it has, with no one-time charge raised, and
--    while a restaurant is on the trial every branch delivers without a row at all -- the trial
--    is granted, never sold, so it must not consume a branch's $59 unlock.
--
-- 3. THE EXTRA-BRANCH DOUBLE COUNT IS FIXED. extra_branch is kind='addon', so billing_compute
--    put it in billing_entitlements.addons, currentSelection() copied that array into the plan
--    page's selection and packageLines() charged it a second time: Coastal Grill's page rendered
--    $545 against a stored monthly_total of $446. A seat-selling product is not a feature add-on,
--    so the addons array now excludes anything with seats_per_unit > 0. The same array was the
--    input that made billing_apply_selection's add-on loop clamp the seat quantity back to 1;
--    that loop is gone -- the function takes p_delivery_branch_ids uuid[] and prices the delivery
--    line as a quantity, one per delivering branch.
--
-- 4. MONTHLY IS NOW ONE SENTENCE: every branch is $29, and a branch with delivery is $58.
--    billing_compute still sums subscription_items.unit_price * quantity; what changed is what
--    billing_apply_selection writes into it -- base 1 x 29, extra_branch (seats - 1) x 29,
--    delivery (number of delivering branches) x 29. Existing snapshots are repriced below
--    (subscription_items.unit_price is a snapshot taken at purchase and never refreshed: Somtam
--    Zab still carried ai_suite @ 59 and delivery @ 49 against a catalog of 89 and 59).
--
-- 5. THE AI SUITE IS WITHDRAWN. Its subscription_items are deleted and the product is
--    deactivated rather than dropped: subscription_items.product_code has an FK to it, and
--    deleting the row would fail against any history. ai_menu_import leaves the feature maps of
--    base and trial because nothing sells it any more; the KEY stays defined in code so old rows
--    and platform feature_overrides keep parsing.
--
-- Security: every new internal lives in `private` with execute revoked; every new public function
-- is SECURITY DEFINER with a fixed search_path, checks platform admin (platform_*) or that the
-- caller holds billing.manage for the restaurant (merchant), and prices everything itself. A
-- discount code is never trusted from the client -- the merchant sends a CODE and the server
-- computes what comes off, exactly as validate_promo_code does for diners.
--
-- Four rules the rest of this file is written to (the lead's decisions after the 2026-09-23
-- review, D1-D9 in the fix notes):
--
--   BOUGHT MEANS PAID. A one-time fee is bought when its billing_charges row is 'paid' (or, for a
--   branch's delivery, when a branch_addons row exists). A pending request's charges are ON
--   ORDER: they never make the plan page, the discount box or the next request think the fee is
--   already covered.
--
--   ONE PENDING REQUEST, PRICED LAST. request_package_change voids the restaurant's pending
--   request -- its charges and its discount reservation -- before it prices the new one, so two
--   identical requests in a row quote the same total.
--
--   A DISCOUNT IS RESERVED WHEN THE MERCHANT SUBMITS. max_redemptions and per_restaurant_limit
--   are spent at request time; approval keeps the reservation and never re-checks the code, so a
--   code switched off after submission cannot strand a request, and rejection or supersession
--   gives the redemption back.
--
--   THE MONTHLY BILL IS DERIVED. The delivery line is priced from the branch_addons rows of the
--   restaurant's active branches every time billing_compute runs, and a trial bills $0 whatever
--   its lines say.

-- ---------------------------------------------------------------------------------------------
-- 1. Catalog: a second price column.
-- ---------------------------------------------------------------------------------------------

alter table public.billing_products
  add column if not exists one_time_price numeric(10,2) not null default 0;

alter table public.billing_products
  drop constraint if exists billing_products_one_time_price_check;
alter table public.billing_products
  add constraint billing_products_one_time_price_check check (one_time_price >= 0);

comment on column public.billing_products.one_time_price is
  'Paid once, ever. $228 for the base (first branch), $99 for each branch after it, $59 to unlock delivery on a branch. Never charged twice: public.billing_charges is the ledger that proves it.';

-- ---------------------------------------------------------------------------------------------
-- 2. New tables.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.branch_addons (
  branch_id   uuid not null references public.branches(id) on delete cascade,
  code        text not null,
  active      boolean not null default true,
  unlocked_at timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (branch_id, code)
);

comment on table public.branch_addons is
  'Which branches have a per-branch add-on switched on. ''delivery'' is the only code today. active drives the monthly bill; unlocked_at records when the one-time fee was paid and is KEPT FOREVER, so switching a branch off and on again later costs nothing one-time.';

create index if not exists branch_addons_code_active_idx
  on public.branch_addons (code) where active;

alter table public.branch_addons enable row level security;
revoke all on public.branch_addons from public, anon, authenticated;
grant select on public.branch_addons to authenticated;
grant all on public.branch_addons to service_role;

drop policy if exists branch_addons_staff_read on public.branch_addons;
create policy branch_addons_staff_read on public.branch_addons
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()) or private.user_is_platform_admin());

create table if not exists public.billing_charges (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  branch_id       uuid references public.branches(id) on delete set null,
  code            text not null,
  amount          numeric(10,2) not null check (amount >= 0),
  discount_code   text,
  discount_amount numeric(10,2) not null default 0 check (discount_amount >= 0),
  net_amount      numeric(10,2) not null check (net_amount >= 0),
  status          text not null check (status in ('pending', 'paid', 'void')),
  request_id      uuid references public.billing_requests(id) on delete set null,
  created_at      timestamptz not null default now(),
  paid_at         timestamptz,
  created_by      uuid references auth.users(id) on delete set null
);

comment on table public.billing_charges is
  'One row per one-time fee. ''paid'' means the fee is bought and is never raised again. ''pending'' means it is on order on the restaurant''s one open request: it does NOT count as bought (a later request voids it and prices the fee afresh), and approval turns it paid. branch_id is set for a branch''s delivery unlock (and for the branch seats backfilled from history); a seat bought before its branch exists carries none.';

-- The database, not the caller, is what makes "never charge a one-time fee twice" true. A branch
-- pays its $59 once and a restaurant pays its base once; a voided charge frees the slot again.
-- The indexes also cover 'pending' on purpose: request_package_change voids the open request's
-- rows before it writes new ones, so a pending row colliding here means two requests were being
-- written for one restaurant at once, and refusing the second is right.
create unique index if not exists billing_charges_base_uniq
  on public.billing_charges (restaurant_id) where code = 'base' and status <> 'void';
create unique index if not exists billing_charges_branch_code_uniq
  on public.billing_charges (branch_id, code) where branch_id is not null and status <> 'void';
create index if not exists billing_charges_restaurant_idx
  on public.billing_charges (restaurant_id, created_at desc);
create index if not exists billing_charges_request_idx
  on public.billing_charges (request_id) where request_id is not null;

alter table public.billing_charges enable row level security;
revoke all on public.billing_charges from public, anon, authenticated;
grant select on public.billing_charges to authenticated;
grant all on public.billing_charges to service_role;

-- A merchant reads their own charges through get_billing_overview (SECURITY DEFINER), never off
-- the table: a policy keyed on user_restaurant_ids() would also expose what other tenants owe
-- the moment someone widens that helper.
drop policy if exists billing_charges_platform_admin on public.billing_charges;
create policy billing_charges_platform_admin on public.billing_charges
  for select to authenticated
  using (private.user_is_platform_admin());

create table if not exists public.billing_discount_codes (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  description         text,
  kind                text not null check (kind in ('percent', 'fixed')),
  value               numeric(10,2) not null check (value > 0),
  -- A percent above 100 is a typo, not a bigger discount; the quote clamps it too.
  constraint billing_discount_codes_percent_range check (kind <> 'percent' or value <= 100),
  product_codes       text[] not null default '{}'::text[],
  max_redemptions     integer check (max_redemptions is null or max_redemptions > 0),
  redemption_count    integer not null default 0 check (redemption_count >= 0),
  per_restaurant_limit integer not null default 1 check (per_restaurant_limit > 0),
  starts_at           timestamptz not null default now(),
  ends_at             timestamptz,
  is_active           boolean not null default true,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.billing_discount_codes is
  'Platform-issued codes that come off the ONE-TIME total only (the base, an extra branch, a delivery unlock). Keeping the recurring bill out of it leaves the monthly figure one number everyone can check. code is stored and compared upper-case; product_codes empty means every one-time charge.';

comment on column public.billing_discount_codes.redemption_count is
  'Uses taken, counting reservations on requests still waiting for the platform as well as approved redemptions -- a use is spent when the merchant submits, so max_redemptions is enforced then. Moved only by private.billing_reserve_discount and the billing_discount_redemptions_release trigger, never by the console.';

create index if not exists billing_discount_codes_active_idx
  on public.billing_discount_codes (is_active, starts_at);

alter table public.billing_discount_codes enable row level security;
revoke all on public.billing_discount_codes from public, anon, authenticated;
grant select, insert, update on public.billing_discount_codes to authenticated;
grant all on public.billing_discount_codes to service_role;

drop policy if exists billing_discount_codes_platform_admin on public.billing_discount_codes;
create policy billing_discount_codes_platform_admin on public.billing_discount_codes
  for all to authenticated
  using (private.user_is_platform_admin())
  with check (private.user_is_platform_admin());

create table if not exists public.billing_discount_redemptions (
  id            uuid primary key default gen_random_uuid(),
  code_id       uuid not null references public.billing_discount_codes(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  request_id    uuid references public.billing_requests(id) on delete set null,
  amount_off    numeric(10,2) not null check (amount_off >= 0),
  -- 'reserved' from the moment the merchant submits until the platform decides; 'redeemed' once
  -- the request is approved. Only a reservation can be given back.
  status        text not null default 'reserved' check (status in ('reserved', 'redeemed')),
  redeemed_at   timestamptz not null default now()
);

comment on table public.billing_discount_redemptions is
  'The ledger that makes a limited code actually limited. One row per use, taken when the merchant SUBMITS (status reserved) and kept when the request is approved (status redeemed); rejecting or superseding the request deletes the reservation and gives the use back. per_restaurant_limit is counted from here, and billing_discount_codes.redemption_count moves with it.';

create index if not exists billing_discount_redemptions_code_idx
  on public.billing_discount_redemptions (code_id, redeemed_at desc);
create index if not exists billing_discount_redemptions_restaurant_idx
  on public.billing_discount_redemptions (restaurant_id, code_id);
create index if not exists billing_discount_redemptions_request_idx
  on public.billing_discount_redemptions (request_id) where request_id is not null;

-- A reservation that disappears gives its use back, however it disappears. Written as a trigger
-- rather than beside each delete because not every delete is ours to write: deleting a restaurant
-- cascades its reservations away too, and a code with max_redemptions = 1 must not stay spent on
-- a restaurant that no longer exists. A 'redeemed' row keeps its use -- that one was given away.
create or replace function private.tg_billing_discount_release()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  update public.billing_discount_codes
     set redemption_count = greatest(redemption_count - 1, 0), updated_at = now()
   where id = old.code_id;
  return null;
end $function$;

drop trigger if exists billing_discount_redemptions_release on public.billing_discount_redemptions;
create trigger billing_discount_redemptions_release
  after delete on public.billing_discount_redemptions
  for each row
  when (old.status = 'reserved')
  execute function private.tg_billing_discount_release();

alter table public.billing_discount_redemptions enable row level security;
revoke all on public.billing_discount_redemptions from public, anon, authenticated;
grant select on public.billing_discount_redemptions to authenticated;
grant all on public.billing_discount_redemptions to service_role;

drop policy if exists billing_discount_redemptions_platform_admin on public.billing_discount_redemptions;
create policy billing_discount_redemptions_platform_admin on public.billing_discount_redemptions
  for select to authenticated
  using (private.user_is_platform_admin());

-- ---------------------------------------------------------------------------------------------
-- 3. The request queue carries the new shape.
-- ---------------------------------------------------------------------------------------------

alter table public.billing_requests
  add column if not exists delivery_branch_ids uuid[] not null default '{}'::uuid[],
  add column if not exists one_time_total numeric(10,2) not null default 0,
  add column if not exists discount_code text,
  add column if not exists discount_amount numeric(10,2) not null default 0;

comment on column public.billing_requests.delivery_branch_ids is
  'The branches this request asks to deliver from. Replaces reading ''delivery'' out of addons[], which could not say WHICH branch.';
comment on column public.billing_requests.one_time_total is
  'What is payable once if this request is approved, already net of discount_amount. Priced by the server from billing_products and billing_charges; the client''s number is display only.';

-- ---------------------------------------------------------------------------------------------
-- 4. Feature resolution: 'delivery' per branch, everything else per restaurant.
-- ---------------------------------------------------------------------------------------------

-- Two different questions get two functions, and each is written once.
--
--   GRANTED  -- private.branch_feature_granted: is the feature switched on for this branch,
--               leaving the payment deadline aside? For delivery that is "the restaurant may have
--               delivery at all, and this branch's switch is on (or the restaurant is on the
--               trial)". It is what the plan page shows as "delivers today" for a lapsed
--               merchant, and branch_has_feature adds the deadline to it.
--   UNLOCKED -- private.branch_delivery_unlocked: was this branch's $59 bought? A branch_addons
--               row (on or off) or a PAID delivery charge. Nothing else: not the switch, not the
--               restaurant-wide grant, not a charge that is only on order.
--
-- The draft of this migration called the first one branch_owns_feature and described it as the
-- rule dispatch-driver relies on to finish a run after billing lapses. It never was: nothing but
-- the three readers below calls it, and it requires the switch to be ON, so it cannot answer
-- "was this bought". With a third "owns" in the edge helper that answered something in between,
-- switching off a restaurant's last delivering branch stranded the runs already out (DELIV-1).
--
-- In-flight deliveries do not need either question. THE rule, stated here and in
-- supabase/functions/_shared/entitlements.ts and nowhere else:
--
--   A deliveries row is checked ONCE, when it is inserted (deliveries_billing_gate ->
--   tg_billing_gate_delivery -> branch_has_feature). A row that exists was entitled then, so it
--   is finished whatever the branch's delivery switch or the restaurant's billing says now:
--   dispatch-driver dispatches it and nothing re-checks. What stays refused is CREATING delivery
--   work for a branch that does not deliver.
create or replace function private.branch_feature_granted(p_branch_id uuid, p_key text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select (be.features -> p_key) = to_jsonb(true)
       and (
         -- Only delivery is per branch. card_payment is sold with the base and stays
         -- restaurant-wide: resolving it per branch would take card checkout away from
         -- every branch but the first.
         p_key <> 'delivery'
         -- While the restaurant is on the trial every branch delivers, so the merchant can
         -- try it before the add-on is sold to them. No branch_addons row is written for a
         -- trial: the $59 unlock is not spent by a trial.
         or coalesce(bp.trial_days, 0) > 0
         or exists (
              select 1 from public.branch_addons ba
               where ba.branch_id = b.id and ba.code = 'delivery' and ba.active)
       )
    from public.branches b
    join public.billing_entitlements be on be.restaurant_id = b.restaurant_id
    left join public.billing_products bp on bp.code = be.plan_code
    where b.id = p_branch_id
  ), false);
$function$;

comment on function private.branch_feature_granted(uuid, text) is
  'Is the feature switched on for this branch, leaving the payment deadline aside? The restaurant-wide grant (which restaurants.feature_overrides can force on) says the feature may be had at all; for delivery, branch_addons.active (or the trial) says where. NOT "was it bought" -- that is private.branch_delivery_unlocked.';

-- Was this branch's delivery unlock bought? The one definition; billing_paid_state, the
-- entitlements payload and get_billing_overview all read it, and anything outside SQL that needs
-- the same answer reads it from the entitlements payload (delivery_unlocked_branch_ids) rather
-- than working it out again.
--
-- A branch_addons row counts whether it is on or off: unlocked_at is kept for ever, which is what
-- makes switching a branch off and on again cost nothing one-time. It also covers what a platform
-- operator granted by hand and the grandfathered branches, neither of which raised a charge. A
-- charge counts only once it is PAID -- a pending one is on order, and the request it belongs to
-- can still be replaced or rejected.
create or replace function private.branch_delivery_unlocked(p_branch_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select exists (select 1 from public.branch_addons ba
                  where ba.branch_id = p_branch_id and ba.code = 'delivery')
      or exists (select 1 from public.billing_charges c
                  where c.branch_id = p_branch_id and c.code = 'delivery' and c.status = 'paid');
$function$;

comment on function private.branch_delivery_unlocked(uuid) is
  'Was this branch''s $59 delivery unlock bought? A branch_addons row (active or not) or a PAID delivery charge. The only definition of "unlocked"; a pending charge is on order, not bought.';

-- Every branch of the restaurant whose unlock is bought, oldest first. Hidden branches are
-- included: hiding a branch does not refund its $59, and un-hiding it must not charge it again.
create or replace function private.delivery_unlocked_branch_ids(p_restaurant_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select jsonb_agg(b.id order by b.created_at, b.id)
      from public.branches b
     where b.restaurant_id = p_restaurant_id
       and private.branch_delivery_unlocked(b.id)
  ), '[]'::jsonb);
$function$;

-- THE gate. quote_delivery, tg_billing_gate_order and tg_billing_gate_delivery all read it, so
-- per branch here is per branch everywhere.
create or replace function private.branch_has_feature(p_branch_id uuid, p_key text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select private.branch_entitled(p_branch_id)
     and private.branch_feature_granted(p_branch_id, p_key);
$function$;

-- The storefront's whole delivery surface. Both keys were built from billing_entitlements joined
-- on restaurant_id; they now ask the branch.
create or replace function public.storefront_status(p_branch_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select jsonb_build_object(
      'entitled',           coalesce(b.entitled_through is not null and b.entitled_through > now(), false),
      'delivery',           coalesce(private.branch_has_feature(b.id, 'delivery')
                                     and public.is_delivery_available(b.id), false),
      'delivery_entitled',  coalesce(private.branch_has_feature(b.id, 'delivery'), false),
      'delivery_available', public.is_delivery_available(b.id),
      'delivery_hours_on',  coalesce((b.settings->>'delivery_hours_enabled')::boolean, false),
      'delivery_mode',      coalesce(b.settings->>'delivery_mode', 'platform'),
      'delivery_windows',   coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_delivery_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      -- Sold with the base, so it stays restaurant-wide.
      'card_payment',       coalesce(b.entitled_through > now() and (be.features -> 'card_payment') = to_jsonb(true), false),

      'timezone',           coalesce(b.timezone, 'America/New_York'),
      -- Empty array means "no hours configured", which is_branch_open() treats as
      -- always-open. The client must read it the same way, so the distinction between
      -- "no hours" and "closed all week" is preserved rather than flattened to [].
      'opening_hours',      coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      'scheduling_enabled', coalesce((b.settings->>'scheduling_enabled')::boolean, true),
      'schedule_min_lead_min', greatest(0, coalesce((b.settings->>'schedule_min_lead_min')::int, 15)),
      'schedule_max_days',     greatest(0, coalesce((b.settings->>'schedule_max_days')::int, 14)),
      'schedule_slot_minutes', greatest(5, coalesce((b.settings->>'schedule_slot_minutes')::int, 15))
    )
    from public.branches b
    left join public.billing_entitlements be on be.restaurant_id = b.restaurant_id
    where b.id = p_branch_id
  ), jsonb_build_object('entitled', false, 'delivery', false, 'delivery_entitled', false,
                        'delivery_available', false, 'delivery_hours_on', false,
                        'delivery_mode', 'platform', 'delivery_windows', '[]'::jsonb,
                        'card_payment', false,
                        'timezone', 'America/New_York', 'opening_hours', '[]'::jsonb,
                        'scheduling_enabled', false,
                        'schedule_min_lead_min', 15, 'schedule_max_days', 14,
                        'schedule_slot_minutes', 15));
$function$;

-- The entitlements payload gains a branch. Loaded for a branch, features.delivery is THAT
-- branch's answer; loaded for a restaurant it keeps the restaurant-wide meaning ("delivery is
-- sold to this account"). Both payloads carry delivery_branch_ids, so one read tells a page
-- which branches deliver. The old one-argument form is dropped rather than overloaded: two
-- candidates would make every existing one-argument call ambiguous.
drop function if exists private.entitlements_json(uuid);

create or replace function private.entitlements_json(p_restaurant_id uuid, p_branch_id uuid default null)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'restaurant_id',    p_restaurant_id,
    'branch_id',        p_branch_id,
    'plan_code',        coalesce(be.plan_code, 'none'),
    'status',           coalesce(be.status, 'none'),
    'entitled',         coalesce(be.entitled_through is not null and be.entitled_through > now(), false),
    'entitled_through', be.entitled_through,
    'trial_ends_at',    be.trial_ends_at,
    'branch_seats',     coalesce(be.branch_seats, 0),
    -- A hidden branch holds no seat, so it must not block lowering the seat count.
    'branches_used',    (select count(*) from public.branches b where b.restaurant_id = p_restaurant_id and b.is_active),
    'monthly_total',    coalesce(be.monthly_total, 0),
    -- RAW grants, deadline excluded (hasFeature() in the client adds the deadline back). A
    -- branch payload overrides the one key that is per branch, so every existing
    -- hasFeature(ent, 'delivery') call site becomes per-branch without being touched.
    'features',         case
                          when p_branch_id is null then coalesce(be.features, '{}'::jsonb)
                          else coalesce(be.features, '{}'::jsonb)
                               || jsonb_build_object('delivery',
                                    private.branch_feature_granted(p_branch_id, 'delivery'))
                        end,
    'addons',           to_jsonb(coalesce(be.addons, '{}'::text[])),
    -- Active branches only: a hidden branch takes no orders, and the plan page lists the
    -- branches the merchant can actually switch.
    'delivery_branch_ids', coalesce((
                             select jsonb_agg(b.id order by b.created_at, b.id)
                               from public.branches b
                              where b.restaurant_id = p_restaurant_id
                                and b.is_active
                                and private.branch_feature_granted(b.id, 'delivery')
                           ), '[]'::jsonb),
    -- The branches whose $59 is already bought, so a screen that offers "turn delivery back on"
    -- can say it costs nothing once without reading the billing ledger (which is the owner's).
    -- The same list private.billing_paid_state prices against.
    'delivery_unlocked_branch_ids', private.delivery_unlocked_branch_ids(p_restaurant_id)
  )
  from (select 1) one
  left join public.billing_entitlements be on be.restaurant_id = p_restaurant_id;
$function$;

create or replace function public.get_entitlements(p_restaurant_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  if not private.user_is_platform_admin()
     and p_restaurant_id not in (select private.user_restaurant_ids()) then
    raise exception 'forbidden';
  end if;
  return private.entitlements_json(p_restaurant_id);
end $function$;

create or replace function public.get_branch_entitlements(p_branch_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_restaurant_id uuid;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  select restaurant_id into v_restaurant_id from public.branches where id = p_branch_id;
  if v_restaurant_id is null then raise exception 'branch_not_found'; end if;
  if not private.user_is_platform_admin()
     and v_restaurant_id not in (select private.user_restaurant_ids())
     and p_branch_id not in (select private.user_branch_ids()) then
    raise exception 'forbidden';
  end if;
  -- Resolved FOR this branch: the payload's features.delivery is this branch's answer.
  return private.entitlements_json(v_restaurant_id, p_branch_id);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 5. What is already bought, and what a selection would cost once.
-- ---------------------------------------------------------------------------------------------

-- Read from BOTH the ledger and the current entitlements. A platform admin who granted a seat or
-- a branch's delivery by hand (billing_set_package) raises no charge row, and the merchant must
-- not then be asked to buy what they were given.
--
-- BOUGHT MEANS PAID. Only a 'paid' charge counts. This used to count every charge that was not
-- void, so the moment a request was filed its own pending rows made the fee look bought: the
-- plan page said "Everything in this package is already paid for" to a merchant who had paid
-- nothing, the discount box answered "nothing to discount" for a good code, and a second request
-- priced at $0 against rows the same call then voided -- the whole one-time bill given away
-- (PKG-1, MONEY-1, PKG-01, PKG-02). A pending request's charges are on order; the plan page
-- shows them from the request itself (billing_requests.one_time_total).
create or replace function private.billing_paid_state(p_restaurant_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_base_paid boolean;
  v_seats_paid integer;
  v_charged_seats integer;
  v_granted_seats integer := 0;
begin
  select exists (
           select 1 from public.billing_charges c
            where c.restaurant_id = p_restaurant_id and c.code = 'base' and c.status = 'paid')
         -- A subscription on a sold plan means the base was had, whether a platform operator
         -- granted it or it predates the one-time ledger. The trial is granted, never sold.
         or exists (
           select 1 from public.subscriptions s
             join public.billing_products bp on bp.code = s.plan_code
            where s.restaurant_id = p_restaurant_id and coalesce(bp.trial_days, 0) = 0)
    into v_base_paid;

  select count(*) into v_charged_seats
    from public.billing_charges c
   where c.restaurant_id = p_restaurant_id and c.code = 'extra_branch' and c.status = 'paid';

  if v_base_paid then
    select coalesce(be.branch_seats, 0) into v_granted_seats
      from public.billing_entitlements be where be.restaurant_id = p_restaurant_id;
  end if;

  v_seats_paid := greatest(
    (case when v_base_paid then 1 else 0 end) + coalesce(v_charged_seats, 0),
    coalesce(v_granted_seats, 0));

  return jsonb_build_object(
    'base_paid', v_base_paid,
    'seats_paid', v_seats_paid,
    -- Unlocked once, unlocked forever -- private.branch_delivery_unlocked is the one rule.
    'delivery_unlocked_branch_ids', private.delivery_unlocked_branch_ids(p_restaurant_id));
end $function$;

-- The one-time lines a selection still has to pay for, priced from the catalog. Anything already
-- bought is simply absent.
create or replace function private.billing_price_one_time(
  p_restaurant_id uuid,
  p_plan_code text,
  p_branch_seats integer,
  p_delivery_branch_ids uuid[]
) returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan     public.billing_products%rowtype;
  v_seat     public.billing_products%rowtype;
  v_delivery public.billing_products%rowtype;
  v_paid     jsonb;
  v_unlocked uuid[];
  -- Range-checked here too, not only at the two public entry points: this is the function the
  -- seat count is actually expensive in, and a private helper that trusts its callers is one
  -- refactor away from being the hole again.
  v_seats    integer := private.billing_seats_in_range(p_branch_seats);
  v_covered  integer;
  v_extra_seats integer;
  v_lines    jsonb := '[]'::jsonb;
  v_total    numeric(10,2) := 0;
  v_unlocks  jsonb;
  v_unlocks_total numeric(10,2);
begin
  select * into v_plan from public.billing_products where code = p_plan_code and kind = 'plan';
  if not found then raise exception 'unknown_plan:%', p_plan_code; end if;

  -- The trial is granted once at signup and never sold, so it raises nothing one-time.
  if coalesce(v_plan.trial_days, 0) > 0 then
    return jsonb_build_object('lines', '[]'::jsonb, 'total', 0);
  end if;

  select * into v_seat from public.billing_products where code = 'extra_branch';
  select * into v_delivery from public.billing_products where code = 'delivery';

  v_paid := private.billing_paid_state(p_restaurant_id);
  select coalesce(array_agg(value::uuid), '{}'::uuid[]) into v_unlocked
    from jsonb_array_elements_text(v_paid -> 'delivery_unlocked_branch_ids');

  if coalesce((v_paid ->> 'base_paid')::boolean, false) is not true then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', v_plan.code, 'branch_id', null, 'amount', coalesce(v_plan.one_time_price, 0)));
    v_total := v_total + coalesce(v_plan.one_time_price, 0);
  end if;

  -- The base INCLUDES the first branch, so a first-time buyer of one branch pays 228 and not
  -- 228 + 99. Once the base is paid, what is covered is what the ledger and the granted seats
  -- say. A seat can be bought before its branch exists (the merchant pays, then creates it), so
  -- a seat line carries no branch id: how many are paid for is the count, not a per-branch row.
  if coalesce((v_paid ->> 'base_paid')::boolean, false) then
    v_covered := coalesce((v_paid ->> 'seats_paid')::int, 0);
  else
    v_covered := coalesce(v_plan.included_seats, 0);
  end if;

  -- ONE statement per kind of line, never one append per line. `v_lines := v_lines || ...` in a
  -- loop copies the whole array every iteration, so building n seat lines cost O(n^2): 4x the
  -- seats was 16x the time (seats=4000 3.1s, seats=8000 12.2s, seats=16000 49.2s), and a big
  -- enough number held a backend until the statement timeout. Both callers now refuse a seat
  -- count outside 1..200 (private.billing_seats_in_range), but the loop was the thing that turned
  -- a silly number into a stuck connection, so no part of the pricing gets to stay quadratic.
  v_extra_seats := greatest(v_seats - v_covered, 0);
  if v_seat.code is not null and v_extra_seats > 0 then
    v_lines := v_lines || coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', v_seat.code, 'branch_id', null,
               'amount', coalesce(v_seat.one_time_price, 0)))
        from generate_series(1, v_extra_seats)
    ), '[]'::jsonb);
    v_total := v_total + v_extra_seats * coalesce(v_seat.one_time_price, 0);
  end if;

  -- One unlock per chosen branch of THIS restaurant that was never bought, oldest first so the
  -- ledger reads in the order the merchant sees the branches.
  if v_delivery.code is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
                      'code', v_delivery.code, 'branch_id', b.id,
                      'amount', coalesce(v_delivery.one_time_price, 0))
                    order by b.created_at, b.id), '[]'::jsonb),
           count(*) * coalesce(v_delivery.one_time_price, 0)
      into v_unlocks, v_unlocks_total
      from public.branches b
     where b.restaurant_id = p_restaurant_id
       and b.id = any (coalesce(p_delivery_branch_ids, '{}'::uuid[]))
       and not (b.id = any (v_unlocked));
    v_lines := v_lines || v_unlocks;
    v_total := v_total + coalesce(v_unlocks_total, 0);
  end if;

  return jsonb_build_object('lines', v_lines, 'total', v_total);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 6. Discount codes: one place the maths lives.
-- ---------------------------------------------------------------------------------------------

-- The "no discount" answer. Always carries the undiscounted total, so a page can still price the
-- purchase while it explains why the code did not apply.
create or replace function private.billing_discount_none(
  p_lines jsonb, p_total numeric, p_reason text
) returns jsonb
 language sql
 immutable
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'valid', p_reason is null,
    'reason', p_reason,
    'label', null,
    'code_id', null,
    'one_time_total', coalesce(p_total, 0),
    'amount_off', 0,
    'net_total', coalesce(p_total, 0),
    'lines', coalesce((
      select jsonb_agg(l || jsonb_build_object(
               'discount_code', null,
               'discount_amount', 0,
               'net_amount', coalesce((l ->> 'amount')::numeric, 0)) order by ord)
        from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality t(l, ord)
    ), '[]'::jsonb));
$function$;

-- Can THIS restaurant use this code NOW? Null when it can, otherwise the reason the merchant is
-- told. The quote and the reservation both ask it, so the two refuse for the same reasons in the
-- same words.
--
-- What a merchant is told. A code that does not exist, one that was switched off and one that has
-- not started yet all answer 'invalid_code'. Those three are exactly the states a guesser learns
-- from ("this name exists, try again next week"), and an honest merchant cannot act on the
-- difference; answering each one differently made validate_billing_discount an enumeration oracle
-- (PKG-3). Expired, exhausted and already-used-by-you keep their own words: a code only reaches
-- those states after it was handed out, so the merchant holding it was given it, and "that code
-- has expired" is the sentence they need. Guessing is paid for in attempts instead -- see
-- private.billing_discount_throttled.
--
-- The restaurant's OWN reservation on its still-pending request is not held against it:
-- submitting again supersedes that request and gives the reservation back first, so counting it
-- would refuse a merchant who is only sending the same code a second time.
create or replace function private.billing_discount_refusal(p_code_id uuid, p_restaurant_id uuid)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_code public.billing_discount_codes%rowtype;
  v_used integer;
  v_mine integer;
begin
  select * into v_code from public.billing_discount_codes where id = p_code_id;
  if not found then return 'invalid_code'; end if;
  if not v_code.is_active or now() < v_code.starts_at then return 'invalid_code'; end if;
  if v_code.ends_at is not null and now() > v_code.ends_at then return 'code_expired'; end if;

  select count(*),
         count(*) filter (where r.status = 'reserved' and br.status = 'pending')
    into v_used, v_mine
    from public.billing_discount_redemptions r
    left join public.billing_requests br on br.id = r.request_id
   where r.code_id = v_code.id and r.restaurant_id = p_restaurant_id;

  if v_code.max_redemptions is not null
     and v_code.redemption_count - v_mine >= v_code.max_redemptions then
    return 'code_exhausted';
  end if;
  if v_used - v_mine >= greatest(coalesce(v_code.per_restaurant_limit, 1), 1) then
    return 'per_restaurant_limit_reached';
  end if;
  return null;
end $function$;

-- Guessing a code costs attempts. At most 10 UNSUCCESSFUL code checks per restaurant per 15
-- minutes, validate_billing_discount and request_package_change counted together; past that
-- every check answers 'rate_limited' -- a code that would have applied included, or the refusal
-- itself would be the oracle (rate_limited for a wrong guess, valid for a right one).
--
-- Only failures are counted, so a merchant who types the right code first time, or re-checks it
-- after changing the selection, never runs the allowance down. Kept in public.rate_limits, the
-- bucket store the diner-side promo path and place-order already use (a cron job clears rows
-- older than an hour, well past this window). Per restaurant rather than per user: the codes are
-- the platform's, and one merchant with five logins is still one guesser. Counted only after the
-- caller passed the billing.manage check, so a stranger cannot use up a restaurant's allowance.
create or replace function private.billing_discount_throttled(p_restaurant_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(sum(rl.count), 0) >= 10
    from public.rate_limits rl
   where rl.bucket_key = 'billing_discount_fail:' || p_restaurant_id::text
     and rl.window_start >= now() - interval '15 minutes';
$function$;

-- Count one unsuccessful check. Callers write this OUTSIDE anything that is rolled back: a
-- failure that vanished with the refusal would never run the allowance down.
create or replace function private.billing_discount_note_failure(p_restaurant_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  -- 'nothing_to_discount' is a fact about the basket, answered before the code is looked at, and
  -- 'rate_limited' is the throttle itself. Neither was a check of a code.
  if p_reason is null or p_reason in ('nothing_to_discount', 'rate_limited') then return; end if;
  insert into public.rate_limits (bucket_key, window_start, count)
  values ('billing_discount_fail:' || p_restaurant_id::text, date_trunc('second', now()), 1)
  on conflict (bucket_key, window_start) do update
    set count = public.rate_limits.count + 1;
end $function$;

-- Percent or fixed, applied to the one-time lines only, and only to the lines whose code is in
-- product_codes when that array is not empty. Never more than the total. Every refusal comes back
-- as a reason code the UI can translate, never as an error -- and never with the code's label,
-- because a label on a refusal would itself say "this code exists".
--
-- Set-based, like billing_price_one_time. Each line's share is the difference of the rounded
-- running totals, so the shares add up to exactly the amount off with no "last line takes the
-- rounding" pass and no append per line.
create or replace function private.billing_discount_quote(
  p_restaurant_id uuid, p_code text, p_lines jsonb
) returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_code   public.billing_discount_codes%rowtype;
  v_norm   text := upper(btrim(coalesce(p_code, '')));
  v_lines  jsonb := coalesce(p_lines, '[]'::jsonb);
  v_pct    numeric;
  v_total  numeric(10,2);
  v_elig   numeric(10,2);
  v_off    numeric(10,2);
  v_given  numeric(10,2);
  v_reason text;
  v_out    jsonb;
begin
  select coalesce(sum(coalesce((t.line ->> 'amount')::numeric, 0)), 0)
    into v_total
    from jsonb_array_elements(v_lines) t(line);

  -- Nothing to pay once is nothing for any code to come off, real or not. Answered before the code
  -- is looked up, so an empty basket cannot be used to tell a real code from a typo.
  if v_total <= 0 then
    return private.billing_discount_none(v_lines, v_total, 'nothing_to_discount');
  end if;
  if v_norm = '' then return private.billing_discount_none(v_lines, v_total, 'invalid_code'); end if;

  select * into v_code from public.billing_discount_codes where code = v_norm;
  v_reason := private.billing_discount_refusal(v_code.id, p_restaurant_id);
  if v_reason is not null then
    return private.billing_discount_none(v_lines, v_total, v_reason);
  end if;

  select coalesce(sum(coalesce((t.line ->> 'amount')::numeric, 0)), 0)
    into v_elig
    from jsonb_array_elements(v_lines) t(line)
   where coalesce(array_length(v_code.product_codes, 1), 0) = 0
      or (t.line ->> 'code') = any (v_code.product_codes);

  -- A real, usable code, but nothing being bought is something it covers (a code for delivery
  -- unlocks, typed against a basket that only adds a branch).
  if v_elig <= 0 then
    return private.billing_discount_none(v_lines, v_total, 'not_applicable');
  end if;

  -- A percent above 100 is refused by the table; the clamp is for a row edited by hand.
  v_pct := least(greatest(v_code.value, 0), 100);
  v_off := case when v_code.kind = 'percent' then round(v_elig * v_pct / 100.0, 2) else v_code.value end;
  -- A code can wipe out what it applies to and not one cent more.
  v_off := least(v_off, v_elig);

  with l as (
    select t.ord, t.line,
           coalesce((t.line ->> 'amount')::numeric, 0) as amt,
           (coalesce(array_length(v_code.product_codes, 1), 0) = 0
            or (t.line ->> 'code') = any (v_code.product_codes)) as elig
      from jsonb_array_elements(v_lines) with ordinality t(line, ord)
  ), run as (
    -- upto = the eligible amount up to and including this line.
    select l.*, sum(case when l.elig then l.amt else 0 end) over (order by l.ord) as upto
      from l
  ), cut as (
    select run.ord, run.line, run.amt,
           case
             when not run.elig then 0::numeric
             when v_code.kind = 'percent' then
               least(run.amt, round(run.upto * v_pct / 100.0, 2)
                              - round((run.upto - run.amt) * v_pct / 100.0, 2))
             else least(run.upto, v_off) - least(run.upto - run.amt, v_off)
           end as share
      from run
  )
  select jsonb_agg(cut.line || jsonb_build_object(
                     'discount_code', case when cut.share > 0 then v_code.code else null end,
                     'discount_amount', cut.share,
                     'net_amount', cut.amt - cut.share) order by cut.ord),
         coalesce(sum(cut.share), 0)
    into v_out, v_given
    from cut;

  return jsonb_build_object(
    'valid', true,
    'reason', null,
    'label', coalesce(nullif(btrim(coalesce(v_code.description, '')), ''), v_code.code),
    'code_id', v_code.id,
    'one_time_total', v_total,
    'amount_off', v_given,
    'net_total', v_total - v_given,
    'lines', v_out);
end $function$;

-- Take one use of a code for a request, atomically. request_package_change calls this after it
-- has given back the restaurant's previous reservation, so max_redemptions and
-- per_restaurant_limit are spent the moment the merchant SUBMITS. They used to be spent at
-- approval, which let one code be quoted to more restaurants than it had uses and left the
-- platform unable to approve a request whose code had been switched off in between (MONEY-4).
-- Now approval keeps the reservation and never looks at the code again: the merchant keeps the
-- price they were quoted.
--
-- The budget check and the counter bump are ONE statement, so two restaurants submitting in the
-- same instant cannot both take the last use -- the same shape as redeem_promo_for_order on the
-- diner side. Null on success, otherwise the reason, in billing_discount_refusal's words.
create or replace function private.billing_reserve_discount(
  p_restaurant_id uuid, p_code_id uuid, p_request_id uuid, p_amount numeric
) returns text
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_reason text;
  v_taken  uuid;
begin
  -- per_restaurant_limit is counted here, not in the UPDATE below. That is safe because the caller
  -- holds the restaurant's request lock: no second request of this restaurant can reserve between
  -- this count and the insert.
  v_reason := private.billing_discount_refusal(p_code_id, p_restaurant_id);
  if v_reason is not null then return v_reason; end if;

  update public.billing_discount_codes
     set redemption_count = redemption_count + 1, updated_at = now()
   where id = p_code_id
     and is_active
     and now() >= starts_at
     and (ends_at is null or now() <= ends_at)
     and (max_redemptions is null or redemption_count < max_redemptions)
  returning id into v_taken;

  if v_taken is null then
    -- Another restaurant took the last use, or the code was switched off, since the check above.
    return coalesce(private.billing_discount_refusal(p_code_id, p_restaurant_id), 'code_exhausted');
  end if;

  insert into public.billing_discount_redemptions
    (code_id, restaurant_id, request_id, amount_off, status)
  values (p_code_id, p_restaurant_id, p_request_id, coalesce(p_amount, 0), 'reserved');
  return null;
end $function$;

-- Give back the reservations these requests hold (rejected, or superseded by a newer request).
-- Deleting the row is the whole of it: the billing_discount_redemptions_release trigger puts the
-- use back on the code.
create or replace function private.billing_release_discount(p_request_ids uuid[])
 returns void
 language sql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  delete from public.billing_discount_redemptions
   where request_id = any (coalesce(p_request_ids, '{}'::uuid[]))
     and status = 'reserved';
$function$;

-- ---------------------------------------------------------------------------------------------
-- 6b. The boundary between a merchant and the billing engine.
--
-- Guards that every client-callable billing RPC shares. They live together, and away from the
-- pricing maths, because they answer questions about the CALLER -- may they spend this money, and
-- is what they sent a number we are willing to price -- rather than questions about the catalog.
-- ---------------------------------------------------------------------------------------------

-- Who may commit this restaurant to a purchase? Whoever holds billing.manage.
--
-- public.role_capabilities is the codebase's single source of truth for what a role may do; the
-- sidebar and the plan page already ask it, and it gives billing.manage to the OWNER ALONE: an
-- admin is the owner's deputy for operations, not for the owner's bank balance. The draft spelt
-- the rule by hand as "owns the restaurant, or a staff row with role = 'admin'", so a branch admin
-- could queue a package change that, once a platform operator approved it, charged the restaurant
-- $228/$99/$59 one-time and raised its monthly bill for good (PKG-5).
--
-- Asked through private.staff_has_capability, the helper every other capability check uses, so
-- this answer cannot drift from theirs. That helper is branch-scoped and billing is bought for
-- the whole restaurant, so the question is "does the caller hold it at any branch of this
-- restaurant". A restaurant with no branch left falls back to its owner and the platform -- the
-- two callers staff_has_capability itself lets through unconditionally.
create or replace function private.user_can_manage_billing(p_restaurant_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    exists (
      select 1 from public.branches b
       where b.restaurant_id = p_restaurant_id
         and private.staff_has_capability(b.id, 'billing.manage'))
    or private.user_is_platform_admin()
    or exists (
      select 1 from public.restaurants r
       where r.id = p_restaurant_id and r.owner_user_id = auth.uid()),
  false);
$function$;

comment on function private.user_can_manage_billing(uuid) is
  'May the caller commit this restaurant to a purchase? Holds billing.manage at any of its branches, per private.staff_has_capability and public.role_capabilities, so the billing RPCs cannot drift from the matrix the rest of the app is gated on.';

-- A seat count we are willing to price: 1 to 200.
--
-- Two RPCs take p_branch_seats straight from the client -- request_package_change and
-- validate_billing_discount -- and both hand it to private.billing_price_one_time, which builds
-- one line per unpaid seat. Nothing bounded it, and validate_billing_discount is callable by any
-- merchant with billing.manage, so a hand-made call with an absurd seat count was a free way to
-- pin a Postgres backend until the statement timeout: measured on this database, seats=4000 took
-- 3.1s, seats=8000 took 12.2s, seats=16000 took 49.2s, and seats=2000000 ran until the server
-- cancelled it (PKG-2). billing_price_one_time is linear now as well, but refusing nonsense at the
-- door is the part that does not depend on how the pricing is written.
--
-- 200 is far above anything the plan page offers (it caps the stepper lower still) and far below
-- anything that costs the database real time. Raised, not clamped: silently pricing something
-- other than what was asked for is how a merchant ends up agreeing to the wrong bill. Null is the
-- declared default of one branch.
create or replace function private.billing_seats_in_range(p_branch_seats integer)
 returns integer
 language plpgsql
 immutable
 set search_path to 'public', 'pg_temp'
as $function$
declare v_seats integer := coalesce(p_branch_seats, 1);
begin
  if v_seats < 1 or v_seats > 200 then
    raise exception 'seats_out_of_range:%/%', v_seats, 200 using errcode = 'P0001';
  end if;
  return v_seats;
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 7. The writers.
-- ---------------------------------------------------------------------------------------------

create or replace function private.billing_compute(p_restaurant_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sub              public.subscriptions%rowtype;
  v_plan_code        text := 'none';
  v_status           text := 'none';
  v_entitled_through timestamptz;
  v_trial_ends_at    timestamptz;
  v_seats            integer := 0;
  v_total            numeric(10,2) := 0;
  v_features         jsonb := '{}'::jsonb;
  v_addons           text[] := '{}'::text[];
  v_overrides        jsonb := '{}'::jsonb;
  v_delivers         integer := 0;
  v_delivery_price   numeric(10,2);
begin
  if p_restaurant_id is null then return; end if;
  -- Mid-cascade (a restaurant being deleted takes its subscription with it) the restaurant row is
  -- already gone, and writing its entitlements would break billing_entitlements_restaurant_id_fkey
  -- and roll the whole delete back.
  if not exists (select 1 from public.restaurants where id = p_restaurant_id) then return; end if;

  select * into v_sub
  from public.subscriptions
  where restaurant_id = p_restaurant_id
  limit 1;

  if found then
    v_status        := v_sub.status::text;
    v_trial_ends_at := v_sub.trial_ends_at;

    -- Deadline. past_due and cancelled keep access until the paid period ends.
    if v_status in ('trialing', 'active', 'past_due', 'cancelled') then
      v_entitled_through := greatest(v_sub.current_period_end, v_sub.trial_ends_at);
    else
      v_entitled_through := null;
    end if;

    -- The delivery line is DERIVED, never trusted from the snapshot. Its quantity was only ever
    -- written by billing_apply_selection, but branches are deleted and hidden outside it, and a
    -- deleted or hidden branch went on being billed $29 a month for ever: billing_entitlements
    -- said 116 while the same payload's delivery_branch_ids listed one branch and the plan page
    -- read 87 off it -- and, the page not being dirty, the merchant could not even resubmit to
    -- correct it (MONEY-2). The truth is the same one entitlements_json and branch_has_feature
    -- use: this restaurant's ACTIVE branches that hold an active delivery add-on. The branches
    -- table's own triggers (below) run this on every delete and hide, so the bill moves the
    -- moment the branch does.
    --
    -- Updated in place, never inserted: an operator's feature_overrides grant writes branch_addons
    -- rows without selling anything, and creating a line here would turn that comp into a charge.
    -- At zero the line is kept at quantity 1 (subscription_items_quantity_check forbids 0) priced
    -- at 0, so the restaurant keeps its delivery grant -- features.delivery comes off this line --
    -- and un-hiding a branch simply prices it again.
    select count(*) into v_delivers
      from public.branch_addons ba
      join public.branches b on b.id = ba.branch_id
     where b.restaurant_id = p_restaurant_id
       and b.is_active
       and ba.code = 'delivery'
       and ba.active;

    select monthly_price into v_delivery_price from public.billing_products where code = 'delivery';

    update public.subscription_items si
       set quantity   = greatest(v_delivers, 1),
           unit_price = case when v_delivers > 0 then coalesce(v_delivery_price, si.unit_price) else 0 end,
           updated_at = now()
     where si.subscription_id = v_sub.id
       and si.product_code = 'delivery'
       and (si.quantity, si.unit_price) is distinct from
           (greatest(v_delivers, 1),
            case when v_delivers > 0 then coalesce(v_delivery_price, si.unit_price) else 0 end);

    -- One row per line item: seats, money, add-on list, plan code. monthly_total is the sum of
    -- unit_price * quantity, which under the 2026-09-23 packaging is 29 x branch_seats plus 29 x
    -- delivering branches: the delivery line's quantity IS the number of delivering branches.
    select
      coalesce(sum(coalesce(bp.included_seats, 0) + coalesce(bp.seats_per_unit, 0) * si.quantity), 0),
      coalesce(sum(si.unit_price * si.quantity), 0),
      -- A product that sells SEATS is not a feature add-on. extra_branch used to land here, the
      -- plan page copied this array into its selection, and the seat was then priced twice.
      coalesce(array_agg(distinct bp.code)
               filter (where bp.kind = 'addon' and coalesce(bp.seats_per_unit, 0) = 0), '{}'::text[]),
      coalesce(min(bp.code) filter (where bp.kind = 'plan'), 'none')
    into v_seats, v_total, v_addons, v_plan_code
    from public.subscription_items si
    join public.billing_products bp on bp.code = si.product_code
    where si.subscription_id = v_sub.id;

    -- Feature grants are a set union, computed separately so it cannot skew the sums. Which
    -- BRANCHES a per-branch key covers is branch_addons' job, not this row's.
    select coalesce(jsonb_object_agg(k, true), '{}'::jsonb)
    into v_features
    from (
      select distinct f.key as k
      from public.subscription_items si
      join public.billing_products bp on bp.code = si.product_code
      cross join lateral jsonb_each(bp.features) f
      where si.subscription_id = v_sub.id
        and f.value = to_jsonb(true)
    ) keys;

    if coalesce(v_sub.plan_code, '') <> '' and v_plan_code = 'none' then
      v_plan_code := v_sub.plan_code;
    end if;

    -- A trial is $0 a month, whatever its lines say (docs/PACKAGING-2026-09-23.md §1). The
    -- platform console can give a trial more seats in one click, and a line priced from the
    -- catalog -- a seat line written before the trial rule existed, or by any future writer that
    -- forgets it -- would otherwise put "$29 every month" on a free trial's plan page (MONEY-5).
    -- Decided here, where the bill is summed, so no writer has to remember it.
    if exists (select 1 from public.billing_products bp
                where bp.code = v_plan_code and coalesce(bp.trial_days, 0) > 0) then
      v_total := 0;
    end if;
  end if;

  -- The override is applied LAST, on top of whatever the package resolved to,
  -- and outside the `found` branch so it also covers a restaurant with no
  -- subscription row at all. A forced-on key still needs entitled_through to be
  -- live: this switch controls WHICH features, never WHETHER they are paid for.
  -- For delivery it says the account may have delivery at all; branch_addons still
  -- says which branches, so the switch cannot quietly re-grant every branch.
  select coalesce(r.feature_overrides, '{}'::jsonb)
    into v_overrides
  from public.restaurants r
  where r.id = p_restaurant_id;

  if coalesce(v_overrides, '{}'::jsonb) <> '{}'::jsonb then
    select coalesce(jsonb_object_agg(merged.k, true), '{}'::jsonb)
      into v_features
    from (
      -- kept from the package, unless explicitly switched off
      select k from jsonb_object_keys(v_features) as k
      where coalesce(v_overrides -> k, 'null'::jsonb) is distinct from to_jsonb(false)
      union
      -- granted by the switch alone
      select e.key from jsonb_each(v_overrides) e where e.value = to_jsonb(true)
    ) merged(k);
  end if;

  insert into public.billing_entitlements as be
    (restaurant_id, plan_code, status, entitled_through, trial_ends_at,
     branch_seats, monthly_total, features, addons, computed_at)
  values
    (p_restaurant_id, v_plan_code, v_status, v_entitled_through, v_trial_ends_at,
     v_seats, v_total, v_features, v_addons, now())
  on conflict (restaurant_id) do update set
    plan_code        = excluded.plan_code,
    status           = excluded.status,
    entitled_through = excluded.entitled_through,
    trial_ends_at    = excluded.trial_ends_at,
    branch_seats     = excluded.branch_seats,
    monthly_total    = excluded.monthly_total,
    features         = excluded.features,
    addons           = excluded.addons,
    computed_at      = now();

  update public.branches
     set entitled_through = v_entitled_through
   where restaurant_id = p_restaurant_id
     and entitled_through is distinct from v_entitled_through;
end $function$;

-- Deleting or hiding a branch changes the bill, so it has to recompute it. Nothing else does:
-- branches_sync_subscription_branch_count keeps subscriptions.branch_count in step but never
-- touches billing_entitlements, so a delivering branch that was deleted went on being billed
-- $29/month until the merchant happened to submit another package change.
--
-- INSERT is deliberately not covered: a brand-new branch holds no delivery add-on, so there is
-- nothing to re-derive, and billing_compute would be run on every branch created.
create or replace function private.tg_branches_recompute_billing()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_restaurant_id uuid;
begin
  -- Both restaurants when a branch moves between them. billing_compute returns early when the
  -- restaurant row is already gone, which is what a restaurant delete looks like from here.
  for v_restaurant_id in
    select distinct x
      from unnest(array[
             case when tg_op in ('UPDATE', 'DELETE') then old.restaurant_id end,
             case when tg_op = 'UPDATE' then new.restaurant_id end]) x
     where x is not null
  loop
    perform private.billing_compute(v_restaurant_id);
  end loop;
  return null;
end $function$;

drop trigger if exists branches_recompute_billing on public.branches;
create trigger branches_recompute_billing
  after delete on public.branches
  for each row
  execute function private.tg_branches_recompute_billing();

-- The WHEN clause is what keeps this off billing_compute's own write: it updates
-- branches.entitled_through, which is not one of the columns listed here.
drop trigger if exists branches_recompute_billing_upd on public.branches;
create trigger branches_recompute_billing_upd
  after update of is_active, restaurant_id on public.branches
  for each row
  when (old.is_active is distinct from new.is_active
        or old.restaurant_id is distinct from new.restaurant_id)
  execute function private.tg_branches_recompute_billing();

-- The only writer of subscriptions + subscription_items, for BOTH rails. It now takes the
-- branches that deliver instead of an add-on array: the old text[] could only say "delivery",
-- never where, and its loop upserted every add-on with quantity = 1 hard-coded, which silently
-- clamped the extra_branch seat count back to 1 whenever 'extra_branch' arrived in that array.
drop function if exists private.billing_apply_selection(uuid, text, text[], integer, text, timestamptz, timestamptz, timestamptz);

create or replace function private.billing_apply_selection(
  p_restaurant_id uuid,
  p_plan_code text,
  p_delivery_branch_ids uuid[],
  p_branch_seats integer,
  p_status text default 'active',
  p_period_start timestamptz default null,
  p_period_end timestamptz default null,
  p_trial_ends_at timestamptz default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan          public.billing_products%rowtype;
  v_seat          public.billing_products%rowtype;
  v_delivery      public.billing_products%rowtype;
  v_sub_id        uuid;
  v_seats         integer := greatest(coalesce(p_branch_seats, 1), 1);
  v_extra         integer;
  v_start         timestamptz := coalesce(p_period_start, now());
  v_end           timestamptz;
  v_trial_ends_at timestamptz := p_trial_ends_at;
  v_used          integer;
  v_keep          text[];
  v_ids           uuid[];
  v_delivers      integer;
  v_seat_price    numeric(10,2);
begin
  if p_restaurant_id is null then raise exception 'restaurant_required'; end if;

  select * into v_plan from public.billing_products where code = p_plan_code and kind = 'plan';
  if not found then raise exception 'unknown_plan:%', p_plan_code; end if;

  select * into v_seat from public.billing_products where code = 'extra_branch';
  select * into v_delivery from public.billing_products where code = 'delivery';

  -- Only this restaurant's own branches, each one once. A stray id from another tenant would
  -- otherwise be billed for here and unlocked for delivery.
  select coalesce(array_agg(distinct b.id), '{}'::uuid[]) into v_ids
    from public.branches b
   where b.restaurant_id = p_restaurant_id
     and b.id = any (coalesce(p_delivery_branch_ids, '{}'::uuid[]));

  -- A trial delivers from every branch by rule, so it neither bills a delivery line nor spends
  -- any branch's one-time unlock.
  if coalesce(v_plan.trial_days, 0) > 0 then
    v_ids := '{}'::uuid[];
  end if;
  v_delivers := coalesce(array_length(v_ids, 1), 0);

  -- The trial is $0 with everything on (docs/PACKAGING-2026-09-23.md §1), and that includes the
  -- branches beyond the first: the platform console can raise a trial's seats in one click, and
  -- charging the extra-branch line's $29 for each of them put "$29 every month" on a free trial's
  -- plan page. The seat LINE still has to exist -- billing_compute reads the seat count off it,
  -- and deleting it would strand the merchant's second branch outside enforce_branch_limit -- so
  -- the seat is kept and priced at the trial plan's own monthly price (0). This is the same rule
  -- as seatPrice() in packages/shared/src/utils/entitlements.ts, and the two must stay in step.
  -- billing_compute zeroes a trial's total as well, so the line's price is for the record: what
  -- the merchant is billed cannot depend on this writer getting it right.
  v_seat_price := case
                    when coalesce(v_plan.trial_days, 0) > 0 then coalesce(v_plan.monthly_price, 0)
                    else coalesce(v_seat.monthly_price, 0)
                  end;

  -- Never strand an active branch outside the paid seat count. Hidden branches hold no
  -- seat; un-hiding one later needs a free seat (enforce_branch_limit).
  select count(*) into v_used from public.branches where restaurant_id = p_restaurant_id and is_active;
  if v_seats < v_used then
    raise exception 'plan_limit_exceeded:branches:%/%', v_used, v_seats using errcode = 'P0001';
  end if;

  if v_plan.trial_days > 0 then
    v_trial_ends_at := coalesce(v_trial_ends_at, v_start + make_interval(days => v_plan.trial_days));
    v_end := coalesce(p_period_end, v_trial_ends_at);
  else
    v_end := coalesce(p_period_end, v_start + interval '1 month');
  end if;

  insert into public.subscriptions as s
    (restaurant_id, status, billing_cycle, current_period_start, current_period_end,
     branch_count, unit_price, plan_code, trial_ends_at)
  values
    (p_restaurant_id, coalesce(p_status, 'active')::public.subscription_status, 'monthly', v_start, v_end,
     v_seats, v_plan.monthly_price, v_plan.code, v_trial_ends_at)
  on conflict (restaurant_id) do update set
    status               = excluded.status,
    billing_cycle        = excluded.billing_cycle,
    current_period_start = excluded.current_period_start,
    current_period_end   = excluded.current_period_end,
    branch_count         = excluded.branch_count,
    unit_price           = excluded.unit_price,
    plan_code            = excluded.plan_code,
    trial_ends_at        = excluded.trial_ends_at,
    cancelled_at         = case when excluded.status in ('cancelled','expired')
                                then coalesce(s.cancelled_at, now()) else null end,
    updated_at           = now()
  returning id into v_sub_id;

  v_keep := array[v_plan.code];

  insert into public.subscription_items (subscription_id, product_code, quantity, unit_price)
  values (v_sub_id, v_plan.code, 1, v_plan.monthly_price)
  on conflict (subscription_id, product_code) do update set
    quantity = 1, unit_price = excluded.unit_price, updated_at = now();

  v_extra := greatest(v_seats - coalesce(v_plan.included_seats, 0), 0);
  if v_extra > 0 and v_seat.code is not null then
    v_keep := v_keep || v_seat.code;
    insert into public.subscription_items (subscription_id, product_code, quantity, unit_price)
    values (v_sub_id, v_seat.code, v_extra, v_seat_price)
    on conflict (subscription_id, product_code) do update set
      quantity = excluded.quantity, unit_price = excluded.unit_price, updated_at = now();
  end if;

  -- One delivery line, quantity = the number of delivering branches. That is the whole of
  -- "$29 more a month for every branch that delivers".
  if v_delivers > 0 and v_delivery.code is not null then
    v_keep := v_keep || v_delivery.code;
    insert into public.subscription_items (subscription_id, product_code, quantity, unit_price)
    values (v_sub_id, v_delivery.code, v_delivers, v_delivery.monthly_price)
    on conflict (subscription_id, product_code) do update set
      quantity = excluded.quantity, unit_price = excluded.unit_price, updated_at = now();
  end if;

  -- Downgrades must leave zero orphan line items.
  delete from public.subscription_items
   where subscription_id = v_sub_id and product_code <> all (v_keep);

  -- The chosen branches on, every other branch of this restaurant off. unlocked_at is never
  -- rewritten: the $59 is paid once ever, so switching a branch back on later is free.
  if v_delivery.code is not null then
    insert into public.branch_addons (branch_id, code, active)
    select b.id, 'delivery', true
      from public.branches b
     where b.id = any (v_ids)
    on conflict (branch_id, code) do update set active = true, updated_at = now();

    update public.branch_addons ba
       set active = false, updated_at = now()
     where ba.code = 'delivery'
       and ba.active
       and not (ba.branch_id = any (v_ids))
       and ba.branch_id in (select b.id from public.branches b where b.restaurant_id = p_restaurant_id);
  end if;

  perform private.billing_compute(p_restaurant_id);
  return private.entitlements_json(p_restaurant_id);
end $function$;

-- The platform's direct activation rail. It raises no billing_charges row: what an operator
-- grants by hand is not owed, and billing_paid_state() reads the granted seats and the
-- branch_addons rows as already bought, so the merchant is never asked to buy it again.
drop function if exists public.billing_set_package(uuid, text, text[], integer, text, timestamptz);

create or replace function public.billing_set_package(
  p_restaurant_id uuid,
  p_plan_code text,
  p_branch_seats integer default 1,
  p_delivery_branch_ids uuid[] default '{}'::uuid[],
  p_status text default 'active',
  p_period_end timestamptz default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  return private.billing_apply_selection(
    p_restaurant_id, p_plan_code, coalesce(p_delivery_branch_ids, '{}'::uuid[]),
    p_branch_seats, p_status, null, p_period_end, null);
end $function$;

-- Queue a package change for platform approval. This is the live rail while Stripe is dormant.
-- The server prices EVERYTHING here: the monthly total, the one-time total and the discount all
-- come from billing_products, billing_charges and billing_discount_codes. The client sends a code,
-- never an amount.
--
-- A discount code that cannot be used does not raise: the call RETURNS
-- {ok: false, reason, error: 'discount_invalid:<reason>'} and files nothing. It has to return,
-- because a raise rolls back everything the call wrote, and one of the things it writes is the
-- failed attempt that the guessing limit counts -- a limit that forgot every refusal was no limit
-- at all, and this RPC would have been the unlimited oracle once validate_billing_discount was
-- throttled. packages/database requestPackageChange turns the refusal back into an Error carrying
-- 'discount_invalid:<reason>', so callers read it exactly as they did.
drop function if exists public.request_package_change(uuid, text, text[], integer, text);

create or replace function public.request_package_change(
  p_restaurant_id uuid,
  p_plan_code text,
  p_branch_seats integer default 1,
  p_delivery_branch_ids uuid[] default '{}'::uuid[],
  p_discount_code text default null,
  p_note text default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan     public.billing_products%rowtype;
  v_seats    integer;
  v_ids      uuid[];
  v_ids_superseded uuid[];
  v_delivers integer;
  v_open     integer;
  v_monthly  numeric(10,2) := 0;
  v_code     text := nullif(upper(btrim(coalesce(p_discount_code, ''))), '');
  v_priced   jsonb;
  v_quote    jsonb;
  v_row      public.billing_requests%rowtype;
  v_reason   text;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  -- Whoever holds billing.manage for this restaurant -- today the owner alone. Any member used to
  -- pass, and a cashier's request then locked the owner's own plan page until the platform acted
  -- on it; the fix for that let the owner's admin through too, which public.role_capabilities
  -- never agreed to. See private.user_can_manage_billing.
  if not private.user_can_manage_billing(p_restaurant_id) then
    raise exception 'forbidden';
  end if;

  -- Nonsense in, nothing priced: see private.billing_seats_in_range.
  v_seats := private.billing_seats_in_range(p_branch_seats);

  select * into v_plan from public.billing_products where code = p_plan_code and kind = 'plan' and is_active;
  if not found then raise exception 'unknown_plan:%', p_plan_code; end if;

  -- The trial is granted once at signup, never sold.
  if coalesce(v_plan.trial_days, 0) > 0 then
    raise exception 'plan_not_purchasable:%', p_plan_code;
  end if;

  -- The same floor private.billing_apply_selection enforces when the request is APPROVED. It was
  -- only there, so a request for fewer seats than the restaurant has open branches queued
  -- happily and then failed with plan_limit_exceeded every single time a platform operator
  -- pressed Approve -- the refusal landing on the operator instead of on the merchant who asked
  -- for it, with the request stuck pending for ever (PKG-6). Refuse it at the door, in the
  -- merchant's own call, where describeBillingError() already turns it into "you are using N of
  -- M branch seats". Hidden branches hold no seat, which is why this counts only the active ones.
  select count(*) into v_open
    from public.branches where restaurant_id = p_restaurant_id and is_active;
  if v_seats < v_open then
    raise exception 'plan_limit_exceeded:branches:%/%', v_open, v_seats using errcode = 'P0001';
  end if;

  -- Only this restaurant's ACTIVE branches, each once. A hidden branch takes no orders and
  -- billing_compute bills no delivery for it, so quoting it here would put a figure on the request
  -- that the approved bill never matches.
  select coalesce(array_agg(distinct b.id), '{}'::uuid[]) into v_ids
    from public.branches b
   where b.restaurant_id = p_restaurant_id
     and b.is_active
     and b.id = any (coalesce(p_delivery_branch_ids, '{}'::uuid[]));
  v_delivers := coalesce(array_length(v_ids, 1), 0);

  -- 29 per branch, and 29 more for every branch that delivers.
  v_monthly := v_plan.monthly_price
             + greatest(v_seats - coalesce(v_plan.included_seats, 0), 0)
               * coalesce((select monthly_price from public.billing_products where code = 'extra_branch'), 0)
             + v_delivers
               * coalesce((select monthly_price from public.billing_products where code = 'delivery'), 0);

  -- One request at a time per restaurant. Two submits in the same instant would otherwise both
  -- void "the" pending request, both price against the same ledger and both reserve a code.
  perform pg_advisory_xact_lock(hashtextextended('favornoms.billing_request:' || p_restaurant_id::text, 0));

  -- Past the guessing limit every code check answers rate_limited, this one included; see
  -- private.billing_discount_throttled. Checked before anything is voided, so a refused call
  -- leaves the merchant's queued request exactly as it was.
  if v_code is not null and private.billing_discount_throttled(p_restaurant_id) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited',
                              'error', 'discount_invalid:rate_limited');
  end if;

  -- Everything that writes lives in this block, so a code refused anywhere inside it (the quote,
  -- or the reservation losing a race for the last use) rolls ALL of it back -- the superseded
  -- request is not cancelled, nothing is filed -- while the failed attempt, written after the
  -- block, still counts.
  begin
    -- VOID FIRST, PRICE AFTER. A superseded request's charges are void, not pending: they were
    -- never agreed to. This used to run AFTER billing_price_one_time while billing_paid_state()
    -- counted every non-void charge as bought, so the ordinary "I picked the wrong branch, let me
    -- resubmit" flow priced the replacement against the very rows this call was about to throw
    -- away and handed the whole one-time bill over for $0 (PKG-1, MONEY-1, PKG-01). The ledger
    -- is now paid-only as well, so the order no longer changes the price -- but voiding first
    -- still matters for the code: the superseded request's reservation is given back here, before
    -- the new one is quoted, so re-sending the same code is not refused as already used.
    select coalesce(array_agg(id), '{}'::uuid[]) into v_ids_superseded
      from public.billing_requests
     where restaurant_id = p_restaurant_id and status = 'pending';

    update public.billing_charges c
       set status = 'void'
     where c.status = 'pending'
       and c.request_id = any (v_ids_superseded);

    perform private.billing_release_discount(v_ids_superseded);

    update public.billing_requests
       set status = 'cancelled', updated_at = now()
     where id = any (v_ids_superseded);

    v_priced := private.billing_price_one_time(p_restaurant_id, v_plan.code, v_seats, v_ids);

    if v_code is null then
      v_quote := private.billing_discount_none(v_priced -> 'lines', (v_priced ->> 'total')::numeric, null);
    else
      v_quote := private.billing_discount_quote(p_restaurant_id, v_code, v_priced -> 'lines');
      -- The code was good enough to show a price a moment ago; if it no longer applies the
      -- merchant is told, not quietly charged the full amount.
      if coalesce((v_quote ->> 'valid')::boolean, false) is not true then
        raise exception using errcode = 'FNB01',
          message = coalesce(v_quote ->> 'reason', 'invalid_code');
      end if;
    end if;

    insert into public.billing_requests
      (restaurant_id, requested_by, plan_code, addons, branch_seats, monthly_total, note,
       delivery_branch_ids, one_time_total, discount_code, discount_amount)
    values
      (p_restaurant_id, auth.uid(), v_plan.code,
       case when v_delivers > 0 then array['delivery'] else '{}'::text[] end,
       v_seats, v_monthly, p_note,
       v_ids,
       coalesce((v_quote ->> 'net_total')::numeric, 0),
       -- Only a code that took something off is recorded against the request.
       case when coalesce((v_quote ->> 'amount_off')::numeric, 0) > 0 then v_code end,
       coalesce((v_quote ->> 'amount_off')::numeric, 0))
    returning * into v_row;

    -- Reserve the use now, tied to this request. Approval keeps it; rejection or the next
    -- request gives it back.
    if v_code is not null and coalesce((v_quote ->> 'amount_off')::numeric, 0) > 0 then
      v_reason := private.billing_reserve_discount(
        p_restaurant_id, (v_quote ->> 'code_id')::uuid, v_row.id,
        (v_quote ->> 'amount_off')::numeric);
      if v_reason is not null then
        raise exception using errcode = 'FNB01', message = v_reason;
      end if;
    end if;

    insert into public.billing_charges
      (restaurant_id, branch_id, code, amount, discount_code, discount_amount, net_amount,
       status, request_id, created_by)
    select p_restaurant_id, nullif(ln ->> 'branch_id', '')::uuid, ln ->> 'code',
           coalesce((ln ->> 'amount')::numeric, 0),
           nullif(ln ->> 'discount_code', ''),
           coalesce((ln ->> 'discount_amount')::numeric, 0),
           coalesce((ln ->> 'net_amount')::numeric, 0),
           'pending', v_row.id, auth.uid()
      from jsonb_array_elements(coalesce(v_quote -> 'lines', '[]'::jsonb)) t(ln);
  exception when sqlstate 'FNB01' then
    get stacked diagnostics v_reason = message_text;
  end;

  if v_reason is not null then
    perform private.billing_discount_note_failure(p_restaurant_id, v_reason);
    return jsonb_build_object('ok', false, 'reason', v_reason,
                              'error', 'discount_invalid:' || v_reason);
  end if;

  return to_jsonb(v_row) || jsonb_build_object('ok', true, 'request_id', v_row.id);
end $function$;

-- Approve or reject. Approving applies the package, marks this request's charges paid and turns
-- its discount reservation into a redemption -- in one transaction, so a code can never be given
-- away without the package being applied, or the other way round. Rejecting voids the charges and
-- gives the reservation back.
--
-- Approval never re-checks the code. The use was reserved when the merchant submitted, against
-- the code as it stood then, and the merchant keeps the price they were quoted: a code switched
-- off or expired in between used to make this raise, which left the package unapplied and its
-- charges pending with nothing in the console able to finish the sale (MONEY-4).
create or replace function public.decide_billing_request(p_id uuid, p_approve boolean, p_note text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_req public.billing_requests%rowtype;
  v_ent jsonb;
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;

  select * into v_req from public.billing_requests where id = p_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_req.status <> 'pending' then raise exception 'request_already_decided'; end if;

  if p_approve then
    v_ent := private.billing_apply_selection(
      v_req.restaurant_id, v_req.plan_code, coalesce(v_req.delivery_branch_ids, '{}'::uuid[]),
      v_req.branch_seats, 'active', null, null, null);

    -- Money is collected out of band while Stripe is dormant, so approval IS payment.
    update public.billing_charges
       set status = 'paid', paid_at = now()
     where request_id = v_req.id and status = 'pending';

    update public.billing_discount_redemptions
       set status = 'redeemed', redeemed_at = now()
     where request_id = v_req.id and status = 'reserved';
  else
    update public.billing_charges
       set status = 'void'
     where request_id = v_req.id and status = 'pending';

    perform private.billing_release_discount(array[v_req.id]);
  end if;

  update public.billing_requests
     set status        = case when p_approve then 'approved' else 'rejected' end,
         decided_by    = auth.uid(),
         decided_at    = now(),
         decision_note = p_note,
         updated_at    = now()
   where id = p_id;

  return jsonb_build_object('ok', true, 'approved', p_approve, 'entitlements', v_ent);
end $function$;

create or replace function public.billing_start_trial(p_restaurant_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  if not private.user_is_platform_admin()
     and p_restaurant_id not in (select private.user_restaurant_ids()) then
    raise exception 'forbidden';
  end if;
  if exists (select 1 from public.subscriptions where restaurant_id = p_restaurant_id) then
    return private.entitlements_json(p_restaurant_id);
  end if;
  return private.billing_apply_selection(p_restaurant_id, 'trial', '{}'::uuid[], 1, 'trialing', null, null, null);
end $function$;

-- Only the trial grant changed here: an empty uuid[] where an empty text[] used to be.
create or replace function public.create_restaurant_with_branch(p_restaurant_name text, p_restaurant_slug text, p_branch_name text, p_branch_slug text, p_branch_address text DEFAULT NULL::text, p_timezone text DEFAULT 'America/New_York'::text, p_theme jsonb DEFAULT '{}'::jsonb, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_restaurant_id uuid;
  v_branch_id uuid;
  v_geo geography(Point, 4326);
  -- The name is NOT part of the theme. Storing it here is what froze it.
  v_theme jsonb := coalesce(p_theme, '{}'::jsonb) - 'brandName';
  v_trial boolean;
begin
  if v_uid is null then raise exception 'auth_required'; end if;

  if (p_lat is null) <> (p_lng is null) then
    raise exception 'invalid_location'
      using hint = 'Latitude and longitude must be supplied together.';
  end if;
  if p_lat is not null then
    if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180
       or (abs(p_lat) < 0.0001 and abs(p_lng) < 0.0001) then
      raise exception 'invalid_location' using hint = 'Drop the pin on the store.';
    end if;
    v_geo := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lng, p_lat), 4326)::geography;
  end if;

  -- One free trial per account. Running the wizard again used to mint another 14-day,
  -- all-features trial and another public storefront every time. The lock stops two Launch
  -- presses in the same instant from both finding "no restaurant yet".
  perform pg_advisory_xact_lock(hashtextextended('favornoms.trial:' || v_uid::text, 0));
  v_trial := not exists (
    select 1 from public.restaurants r where r.owner_user_id = v_uid
    union all
    select 1 from public.staff_members sm
     where sm.user_id = v_uid and sm.status = 'active' and sm.role = 'owner'
  );

  insert into public.restaurants (slug, name, owner_user_id, brand_settings)
  values (lower(p_restaurant_slug), p_restaurant_name, v_uid, v_theme)
  returning id into v_restaurant_id;

  if v_trial then
    -- Pro Start-up: 14 days, 1 branch, no card, and delivery on every branch by rule.
    perform private.billing_apply_selection(
      v_restaurant_id, 'trial', '{}'::uuid[], 1, 'trialing', null, null, null);
  else
    -- No subscription means no seat, and enforce_branch_limit would refuse the founding
    -- branch. Exempt exactly this restaurant, for exactly the insert below.
    perform set_config('favornoms.founding_restaurant_id', v_restaurant_id::text, true);
  end if;

  insert into public.branches (restaurant_id, slug, name, address, timezone, theme_override, is_active, geo_location)
  values (v_restaurant_id, lower(p_branch_slug), p_branch_name, p_branch_address, p_timezone, v_theme, true, v_geo)
  returning id into v_branch_id;

  perform set_config('favornoms.founding_restaurant_id', '', true);

  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status)
  values (v_uid, v_restaurant_id, v_branch_id, 'owner', 'active');

  return jsonb_build_object(
    'restaurant_id', v_restaurant_id,
    'branch_id', v_branch_id,
    'trial_granted', v_trial,
    'entitlements', private.entitlements_json(v_restaurant_id)
  );
end
$function$;

-- The Stripe rail (dormant: no secret key, no stripe_price_id on any row). A Stripe line item
-- cannot name a branch, so a delivery line there means "keep delivering from the branches this
-- restaurant already chose"; its absence means none. Both rails still go through
-- billing_apply_selection, so they cannot drift.
create or replace function public.stripe_sync_subscription(p_restaurant_id uuid, p_stripe_customer_id text, p_stripe_subscription_id text, p_status text, p_items jsonb, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_trial_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cancel_at_period_end boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_restaurant_id uuid := p_restaurant_id;
  v_plan_code     text;
  v_addons        text[] := '{}'::text[];
  v_delivery_ids  uuid[] := '{}'::uuid[];
  v_seats         integer := 0;
  v_unknown       text[] := '{}'::text[];
  v_status        text;
  v_ent           jsonb;
  it              record;
  bp              public.billing_products%rowtype;
begin
  if v_restaurant_id is null then
    v_restaurant_id := public.stripe_resolve_restaurant(p_stripe_customer_id, p_stripe_subscription_id);
  end if;

  if v_restaurant_id is null then
    perform public.billing_log_event('stripe.unresolved_customer', 'error',
      'no subscription matches this Stripe customer/subscription', null,
      jsonb_build_object('customer', p_stripe_customer_id, 'subscription', p_stripe_subscription_id));
    return jsonb_build_object('ok', false, 'error', 'unresolved_customer');
  end if;

  for it in select (e->>'price_id') as price_id,
                   greatest(coalesce((e->>'quantity')::int, 1), 1) as quantity
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
  loop
    select * into bp from public.billing_products where stripe_price_id = it.price_id;
    if not found then
      v_unknown := v_unknown || it.price_id;
      continue;
    end if;
    if bp.kind = 'plan' then
      v_plan_code := bp.code;
      v_seats := v_seats + coalesce(bp.included_seats, 0);
    elsif bp.kind = 'addon' and coalesce(bp.seats_per_unit, 0) > 0 then
      v_seats := v_seats + coalesce(bp.seats_per_unit, 0) * it.quantity;
    elsif bp.kind = 'addon' then
      v_addons := v_addons || bp.code;
    elsif bp.kind = 'seat' then
      v_seats := v_seats + coalesce(bp.seats_per_unit, 0) * it.quantity;
    end if;
  end loop;

  if array_length(v_unknown, 1) is not null then
    perform public.billing_log_event('stripe.unknown_price', 'warn',
      'price id not present in billing_products', v_restaurant_id,
      jsonb_build_object('price_ids', to_jsonb(v_unknown)));
  end if;

  if v_plan_code is null then
    perform public.billing_log_event('stripe.no_plan_line', 'error',
      'subscription carries no line item mapping to a plan product; refusing to overwrite', v_restaurant_id,
      jsonb_build_object('items', p_items));
    return jsonb_build_object('ok', false, 'error', 'no_plan_line');
  end if;

  if 'delivery' = any (v_addons) then
    select coalesce(array_agg(ba.branch_id), '{}'::uuid[]) into v_delivery_ids
      from public.branch_addons ba
      join public.branches b on b.id = ba.branch_id
     where b.restaurant_id = v_restaurant_id and ba.code = 'delivery' and ba.active;
  end if;

  v_status := case
    when p_status in ('trialing','active','past_due','canceled','cancelled','incomplete','incomplete_expired','unpaid','paused')
    then case p_status
           when 'canceled'            then 'cancelled'
           when 'incomplete'          then 'past_due'
           when 'unpaid'              then 'past_due'
           when 'incomplete_expired'  then 'expired'
           when 'paused'              then 'expired'
           else p_status
         end
    else 'expired'
  end;

  v_ent := private.billing_apply_selection(
    v_restaurant_id, v_plan_code, v_delivery_ids, greatest(v_seats, 1), v_status,
    p_period_start, p_period_end, p_trial_end);

  update public.subscriptions
     set stripe_customer_id     = coalesce(p_stripe_customer_id, stripe_customer_id),
         stripe_subscription_id = coalesce(p_stripe_subscription_id, stripe_subscription_id),
         cancel_at_period_end   = coalesce(p_cancel_at_period_end, false),
         updated_at             = now()
   where restaurant_id = v_restaurant_id;

  perform private.billing_compute(v_restaurant_id);

  return jsonb_build_object('ok', true, 'restaurant_id', v_restaurant_id,
                            'entitlements', private.entitlements_json(v_restaurant_id));
end $function$;

-- The catalog editor gains the second price. Dropped and recreated rather than overloaded: a
-- 13-argument call would otherwise match two candidates.
drop function if exists public.upsert_billing_product(text, text, text, numeric, integer, integer, integer, boolean, jsonb, text, boolean, integer, text);

create or replace function public.upsert_billing_product(
  p_code text,
  p_name text default null,
  p_kind text default null,
  p_monthly_price numeric default null,
  p_included_seats integer default null,
  p_seats_per_unit integer default null,
  p_trial_days integer default null,
  p_is_quantity boolean default null,
  p_features jsonb default null,
  p_stripe_price_id text default null,
  p_is_active boolean default null,
  p_sort_order integer default null,
  p_description text default null,
  p_one_time_price numeric default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v public.billing_products%rowtype;
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  if coalesce(btrim(p_code), '') = '' then raise exception 'code_required'; end if;

  insert into public.billing_products as bp
    (code, name, kind, monthly_price, one_time_price, included_seats, seats_per_unit, trial_days,
     is_quantity, features, stripe_price_id, is_active, sort_order, description)
  values
    (p_code, coalesce(p_name, p_code), coalesce(p_kind, 'addon'), coalesce(p_monthly_price, 0),
     coalesce(p_one_time_price, 0),
     coalesce(p_included_seats, 0), coalesce(p_seats_per_unit, 0), coalesce(p_trial_days, 0),
     coalesce(p_is_quantity, false), coalesce(p_features, '{}'::jsonb), p_stripe_price_id,
     coalesce(p_is_active, true), coalesce(p_sort_order, 0), p_description)
  on conflict (code) do update set
    -- null means "leave alone", so a partial save cannot clobber the rest of the row.
    name            = coalesce(p_name, bp.name),
    kind            = coalesce(p_kind, bp.kind),
    monthly_price   = coalesce(p_monthly_price, bp.monthly_price),
    one_time_price  = coalesce(p_one_time_price, bp.one_time_price),
    included_seats  = coalesce(p_included_seats, bp.included_seats),
    seats_per_unit  = coalesce(p_seats_per_unit, bp.seats_per_unit),
    trial_days      = coalesce(p_trial_days, bp.trial_days),
    is_quantity     = coalesce(p_is_quantity, bp.is_quantity),
    features        = coalesce(p_features, bp.features),
    stripe_price_id = coalesce(nullif(p_stripe_price_id, ''), bp.stripe_price_id),
    is_active       = coalesce(p_is_active, bp.is_active),
    sort_order      = coalesce(p_sort_order, bp.sort_order),
    description     = coalesce(p_description, bp.description),
    updated_at      = now()
  returning * into v;

  return to_jsonb(v);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 8. The readers the plan page and the platform console need.
-- ---------------------------------------------------------------------------------------------

create or replace function public.get_billing_overview(p_restaurant_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_paid jsonb;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  -- The ledger of what this restaurant has paid is billing.manage's to read, and the matrix
  -- gives that to the owner alone. See private.user_can_manage_billing.
  if not private.user_can_manage_billing(p_restaurant_id) then
    raise exception 'forbidden';
  end if;

  v_paid := private.billing_paid_state(p_restaurant_id);

  return jsonb_build_object(
    'entitlements', private.entitlements_json(p_restaurant_id),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id,
               'name', b.name,
               -- Switched on today, deadline aside. For a trial that is every branch, and it says
               -- nothing about whether the $59 was bought -- delivery_unlocked does.
               'delivery_active', private.branch_feature_granted(b.id, 'delivery'),
               -- Unlocked = the $59 was PAID at some point, so switching this branch back on
               -- later costs nothing one-time.
               'delivery_unlocked', private.branch_delivery_unlocked(b.id)
             ) order by b.created_at, b.id)
        from public.branches b
       where b.restaurant_id = p_restaurant_id and b.is_active
    ), '[]'::jsonb),
    -- What is PAID. A pending request's charges are not in here; they are on order, and the
    -- request below says what they come to.
    'paid', v_paid,
    -- The restaurant's open request, if any, as the plan page shows it: what it will cost once
    -- (net of the code), which code and how much came off. Its charges are in `charges` with
    -- status 'pending'.
    'pending_request', (
      select to_jsonb(br) from public.billing_requests br
       where br.restaurant_id = p_restaurant_id and br.status = 'pending'
       order by br.created_at desc limit 1),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'code', c.code,
               'branch_id', c.branch_id,
               'amount', c.amount,
               'discount_code', c.discount_code,
               'discount_amount', c.discount_amount,
               'net_amount', c.net_amount,
               'status', c.status,
               'request_id', c.request_id,
               'created_at', c.created_at,
               'paid_at', c.paid_at
             ) order by c.created_at desc, c.id)
        from public.billing_charges c
       where c.restaurant_id = p_restaurant_id
    ), '[]'::jsonb));
end $function$;

comment on function public.get_billing_overview(uuid) is
  'Everything the plan page needs in one read: the entitlements payload, each active branch with whether it delivers today and whether its delivery unlock was paid, what is PAID (billing_paid_state), the open request with its one-time total and discount, and the one-time ledger with each charge''s status. Merchants reach billing_charges only through here.';

-- Price a code against a selection, for the plan page's discount box. Writes nothing but the
-- failed attempt the guessing limit counts, which is why it is VOLATILE (the default) rather than
-- stable: Postgres refuses a write inside a non-volatile function. PostgREST reaches it by POST
-- either way (packages/database validateBillingDiscount calls supabase.rpc plainly).
create or replace function public.validate_billing_discount(
  p_restaurant_id uuid,
  p_code text,
  p_plan_code text,
  p_branch_seats integer,
  p_delivery_branch_ids uuid[]
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ids    uuid[];
  v_seats  integer;
  v_priced jsonb;
  v_quote  jsonb;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  -- Pricing a purchase, even without buying it, is billing.manage's. See
  -- private.user_can_manage_billing.
  if not private.user_can_manage_billing(p_restaurant_id) then
    raise exception 'forbidden';
  end if;

  v_seats := private.billing_seats_in_range(p_branch_seats);

  -- The same branches request_package_change would price: this restaurant's active ones.
  select coalesce(array_agg(distinct b.id), '{}'::uuid[]) into v_ids
    from public.branches b
   where b.restaurant_id = p_restaurant_id
     and b.is_active
     and b.id = any (coalesce(p_delivery_branch_ids, '{}'::uuid[]));

  -- Priced against what is PAID, so a merchant with a request already queued is quoted the same
  -- total as the request they are about to replace -- not "nothing to discount" because the
  -- queued request's own charges made everything look bought.
  v_priced := private.billing_price_one_time(p_restaurant_id, p_plan_code, v_seats, v_ids);

  if coalesce((v_priced ->> 'total')::numeric, 0) > 0
     and private.billing_discount_throttled(p_restaurant_id) then
    v_quote := private.billing_discount_none(v_priced -> 'lines', (v_priced ->> 'total')::numeric,
                                             'rate_limited');
  else
    v_quote := private.billing_discount_quote(p_restaurant_id, p_code, v_priced -> 'lines');
    perform private.billing_discount_note_failure(p_restaurant_id, v_quote ->> 'reason');
  end if;

  -- The merchant is told the amount and the label, never the row: product_codes, the remaining
  -- redemptions and every other code stay platform-only.
  return jsonb_build_object(
    'valid', v_quote -> 'valid',
    'reason', v_quote -> 'reason',
    'label', v_quote -> 'label',
    'one_time_total', v_quote -> 'one_time_total',
    'amount_off', v_quote -> 'amount_off',
    'net_total', v_quote -> 'net_total');
end $function$;

create or replace function public.platform_list_discount_codes()
 returns setof public.billing_discount_codes
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  return query
    select * from public.billing_discount_codes order by created_at desc;
end $function$;

create or replace function public.platform_create_discount_code(p jsonb)
 returns public.billing_discount_codes
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_code text := upper(btrim(coalesce(p ->> 'code', '')));
  v      public.billing_discount_codes%rowtype;
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  if v_code = '' then raise exception 'code_required'; end if;
  if coalesce(p ->> 'kind', '') not in ('percent', 'fixed') then raise exception 'kind_invalid'; end if;

  insert into public.billing_discount_codes
    (code, description, kind, value, product_codes, max_redemptions, per_restaurant_limit,
     starts_at, ends_at, is_active, created_by)
  values
    (v_code,
     nullif(btrim(coalesce(p ->> 'description', '')), ''),
     p ->> 'kind',
     coalesce((p ->> 'value')::numeric, 0),
     coalesce((select array_agg(value) from jsonb_array_elements_text(
                 case when jsonb_typeof(p -> 'product_codes') = 'array'
                      then p -> 'product_codes' else '[]'::jsonb end)), '{}'::text[]),
     nullif(p ->> 'max_redemptions', '')::integer,
     greatest(coalesce(nullif(p ->> 'per_restaurant_limit', '')::integer, 1), 1),
     coalesce(nullif(p ->> 'starts_at', '')::timestamptz, now()),
     nullif(p ->> 'ends_at', '')::timestamptz,
     coalesce((p ->> 'is_active')::boolean, true),
     auth.uid())
  returning * into v;

  return v;
end $function$;

create or replace function public.platform_update_discount_code(p_id uuid, p jsonb)
 returns public.billing_discount_codes
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v public.billing_discount_codes%rowtype;
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  if p ? 'kind' and coalesce(p ->> 'kind', '') not in ('percent', 'fixed') then
    raise exception 'kind_invalid';
  end if;

  -- An absent key means "leave alone", so deactivating a code cannot clobber its dates. The
  -- redemption counter is never writable from here: it is the ledger's job.
  update public.billing_discount_codes c
     set description          = case when p ? 'description'
                                     then nullif(btrim(coalesce(p ->> 'description', '')), '')
                                     else c.description end,
         kind                 = case when p ? 'kind' then p ->> 'kind' else c.kind end,
         value                = case when p ? 'value' then coalesce((p ->> 'value')::numeric, c.value)
                                     else c.value end,
         product_codes        = case when p ? 'product_codes'
                                     then coalesce((select array_agg(value) from jsonb_array_elements_text(
                                            case when jsonb_typeof(p -> 'product_codes') = 'array'
                                                 then p -> 'product_codes' else '[]'::jsonb end)), '{}'::text[])
                                     else c.product_codes end,
         max_redemptions      = case when p ? 'max_redemptions'
                                     then nullif(p ->> 'max_redemptions', '')::integer
                                     else c.max_redemptions end,
         per_restaurant_limit = case when p ? 'per_restaurant_limit'
                                     then greatest(coalesce(nullif(p ->> 'per_restaurant_limit', '')::integer, 1), 1)
                                     else c.per_restaurant_limit end,
         starts_at            = case when p ? 'starts_at'
                                     then coalesce(nullif(p ->> 'starts_at', '')::timestamptz, c.starts_at)
                                     else c.starts_at end,
         ends_at              = case when p ? 'ends_at' then nullif(p ->> 'ends_at', '')::timestamptz
                                     else c.ends_at end,
         is_active            = case when p ? 'is_active'
                                     then coalesce((p ->> 'is_active')::boolean, c.is_active)
                                     else c.is_active end,
         updated_at           = now()
   where c.id = p_id
  returning * into v;

  if v.id is null then raise exception 'code_not_found'; end if;
  return v;
end $function$;

create or replace function public.platform_list_discount_redemptions(p_code_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id,
             'code_id', r.code_id,
             'restaurant_id', r.restaurant_id,
             'restaurant_name', res.name,
             'request_id', r.request_id,
             'amount_off', r.amount_off,
             -- reserved = on a request still waiting for the platform; redeemed = approved.
             'status', r.status,
             'redeemed_at', r.redeemed_at
           ) order by r.redeemed_at desc)
      from public.billing_discount_redemptions r
      left join public.restaurants res on res.id = r.restaurant_id
     where p_code_id is null or r.code_id = p_code_id
  ), '[]'::jsonb);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 9. Grants.
-- ---------------------------------------------------------------------------------------------

revoke execute on function private.branch_feature_granted(uuid, text) from public, anon, authenticated;
revoke execute on function private.branch_delivery_unlocked(uuid) from public, anon, authenticated;
revoke execute on function private.delivery_unlocked_branch_ids(uuid) from public, anon, authenticated;
revoke execute on function private.branch_has_feature(uuid, text) from public, anon, authenticated;
revoke execute on function private.entitlements_json(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.billing_paid_state(uuid) from public, anon, authenticated;
revoke execute on function private.billing_price_one_time(uuid, text, integer, uuid[]) from public, anon, authenticated;
revoke execute on function private.billing_discount_none(jsonb, numeric, text) from public, anon, authenticated;
revoke execute on function private.billing_discount_quote(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function private.billing_discount_refusal(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.billing_discount_throttled(uuid) from public, anon, authenticated;
revoke execute on function private.billing_discount_note_failure(uuid, text) from public, anon, authenticated;
revoke execute on function private.billing_reserve_discount(uuid, uuid, uuid, numeric) from public, anon, authenticated;
revoke execute on function private.billing_release_discount(uuid[]) from public, anon, authenticated;
revoke execute on function private.tg_billing_discount_release() from public, anon, authenticated;
revoke execute on function private.user_can_manage_billing(uuid) from public, anon, authenticated;
revoke execute on function private.billing_seats_in_range(integer) from public, anon, authenticated;
revoke execute on function private.billing_apply_selection(uuid, text, uuid[], integer, text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function private.billing_compute(uuid) from public, anon, authenticated;
revoke execute on function private.tg_branches_recompute_billing() from public, anon, authenticated;

revoke execute on function public.billing_set_package(uuid, text, integer, uuid[], text, timestamptz) from public, anon;
grant  execute on function public.billing_set_package(uuid, text, integer, uuid[], text, timestamptz) to authenticated, service_role;

revoke execute on function public.request_package_change(uuid, text, integer, uuid[], text, text) from public, anon;
grant  execute on function public.request_package_change(uuid, text, integer, uuid[], text, text) to authenticated, service_role;

revoke execute on function public.get_billing_overview(uuid) from public, anon;
grant  execute on function public.get_billing_overview(uuid) to authenticated, service_role;

revoke execute on function public.validate_billing_discount(uuid, text, text, integer, uuid[]) from public, anon;
grant  execute on function public.validate_billing_discount(uuid, text, text, integer, uuid[]) to authenticated, service_role;

revoke execute on function public.platform_list_discount_codes() from public, anon;
grant  execute on function public.platform_list_discount_codes() to authenticated, service_role;
revoke execute on function public.platform_create_discount_code(jsonb) from public, anon;
grant  execute on function public.platform_create_discount_code(jsonb) to authenticated, service_role;
revoke execute on function public.platform_update_discount_code(uuid, jsonb) from public, anon;
grant  execute on function public.platform_update_discount_code(uuid, jsonb) to authenticated, service_role;
revoke execute on function public.platform_list_discount_redemptions(uuid) from public, anon;
grant  execute on function public.platform_list_discount_redemptions(uuid) to authenticated, service_role;

revoke execute on function public.upsert_billing_product(text, text, text, numeric, integer, integer, integer, boolean, jsonb, text, boolean, integer, text, numeric) from public, anon;
grant  execute on function public.upsert_billing_product(text, text, text, numeric, integer, integer, integer, boolean, jsonb, text, boolean, integer, text, numeric) to authenticated, service_role;

-- storefront_status stays anonymous: it is what an unsigned-in diner's storefront reads.
grant execute on function public.storefront_status(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 10. The catalog, and everything that already exists.
-- ---------------------------------------------------------------------------------------------

-- Prices first. This fires billing_products_recompute, which recomputes every tenant holding the
-- code; the final recompute at the bottom settles them all anyway.
update public.billing_products
   set one_time_price = 228, monthly_price = 29, included_seats = 1, seats_per_unit = 0,
       is_quantity = false, features = '{"card_payment": true}'::jsonb, updated_at = now()
 where code = 'base';

update public.billing_products
   set one_time_price = 99, monthly_price = 29, included_seats = 0, seats_per_unit = 1,
       is_quantity = true, features = '{}'::jsonb, updated_at = now()
 where code = 'extra_branch';

-- delivery becomes a QUANTITY product: its quantity is the number of branches that deliver.
update public.billing_products
   set one_time_price = 59, monthly_price = 29, included_seats = 0, seats_per_unit = 0,
       is_quantity = true, features = '{"delivery": true}'::jsonb, updated_at = now()
 where code = 'delivery';

-- The trial is unchanged in spirit: $0, everything the base has plus delivery on every branch,
-- so the merchant can try it before the add-on is sold to them.
update public.billing_products
   set one_time_price = 0, monthly_price = 0, included_seats = 1, seats_per_unit = 0,
       is_quantity = false, features = '{"card_payment": true, "delivery": true}'::jsonb,
       updated_at = now()
 where code = 'trial';

-- Withdrawn. Deactivated, not deleted: subscription_items.product_code has an FK to it and the
-- history must still resolve.
update public.billing_products
   set is_active = false, updated_at = now()
 where code = 'ai_suite';

delete from public.subscription_items si
 where si.product_code = 'ai_suite';

-- Grandfather delivery onto EVERY branch of every restaurant that holds it today, active or not,
-- with no one-time charge raised. They already paid for delivery; they are not re-sold it.
insert into public.branch_addons (branch_id, code, active, unlocked_at)
select b.id, 'delivery', true, now()
  from public.branches b
  join public.billing_entitlements be on be.restaurant_id = b.restaurant_id
 where (be.features -> 'delivery') = to_jsonb(true)
   and exists (
     select 1 from public.subscriptions s
       join public.billing_products bp on bp.code = s.plan_code
      where s.restaurant_id = b.restaurant_id and coalesce(bp.trial_days, 0) = 0)
on conflict (branch_id, code) do nothing;

-- The one-time history of everyone who already pays. Marked paid, so the plan page never asks
-- them to buy the base or a branch seat they have had for months.
insert into public.billing_charges
  (restaurant_id, branch_id, code, amount, discount_amount, net_amount, status, paid_at)
select s.restaurant_id, null, 'base',
       (select one_time_price from public.billing_products where code = 'base'), 0,
       (select one_time_price from public.billing_products where code = 'base'), 'paid', now()
  from public.subscriptions s
  join public.billing_products bp on bp.code = s.plan_code
 where coalesce(bp.trial_days, 0) = 0
   and not exists (select 1 from public.billing_charges c
                    where c.restaurant_id = s.restaurant_id and c.code = 'base' and c.status <> 'void');

-- One row per branch beyond the oldest, up to the seats they hold. A seat paid for but not yet
-- opened as a branch carries no branch id.
insert into public.billing_charges
  (restaurant_id, branch_id, code, amount, discount_amount, net_amount, status, paid_at)
select r.restaurant_id, r.branch_id, 'extra_branch',
       (select one_time_price from public.billing_products where code = 'extra_branch'), 0,
       (select one_time_price from public.billing_products where code = 'extra_branch'), 'paid', now()
  from (
    select s.restaurant_id,
           b.id as branch_id,
           row_number() over (partition by s.restaurant_id order by b.created_at, b.id) as seat_no
      from public.subscriptions s
      join public.billing_products bp on bp.code = s.plan_code
      join public.branches b on b.restaurant_id = s.restaurant_id
     where coalesce(bp.trial_days, 0) = 0
  ) r
  join public.billing_entitlements be on be.restaurant_id = r.restaurant_id
 where r.seat_no > 1
   and r.seat_no <= greatest(coalesce(be.branch_seats, 1), 1)
   and not exists (select 1 from public.billing_charges c
                    where c.branch_id = r.branch_id and c.code = 'extra_branch' and c.status <> 'void');

-- Reprice every line to the new catalog. unit_price is a snapshot taken at purchase and never
-- refreshed, so without this Coastal Grill would keep paying 446 forever while the catalog says
-- 116. The delivery line's quantity becomes the number of branches that deliver.
--
-- A TRIAL's lines stay at its own price (0). A trial that was granted a second branch carries an
-- extra_branch line, and repricing it to the catalog's 29 would put a monthly bill on a free
-- trial -- the same bug billing_apply_selection had, and existing trials are meant to be
-- untouched by this migration (docs/PACKAGING-2026-09-23.md §6).
update public.subscription_items si
   set unit_price = case when coalesce(tp.trial_days, 0) > 0
                         then coalesce(tp.monthly_price, 0) else bp.monthly_price end,
       quantity = case
                    when si.product_code = 'delivery'
                    then greatest((select count(*) from public.branch_addons ba
                                    join public.branches b on b.id = ba.branch_id
                                   where b.restaurant_id = s.restaurant_id
                                     and b.is_active
                                     and ba.code = 'delivery' and ba.active), 1)
                    else si.quantity
                  end,
       updated_at = now()
  from public.billing_products bp,
       public.subscriptions s
       left join public.billing_products tp on tp.code = s.plan_code
 where bp.code = si.product_code
   and s.id = si.subscription_id;

-- Settle every tenant against the new functions.
do $$
declare r record;
begin
  for r in select id from public.restaurants loop
    perform private.billing_compute(r.id);
  end loop;
end $$;
