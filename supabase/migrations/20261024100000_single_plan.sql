-- One plan, every feature included (owner decision 2026-10-24, docs/PACKAGING-2026-10-24.md).
-- Replaces the 2026-09-23 packaging: $49 a month per branch, $199 once for the first branch and $89
-- once for each branch after it, and delivery is no longer an add-on. Every function below that is
-- replaced was re-created from its live definition (pg_get_functiondef on 2026-10-24) with the same
-- arguments, answer, owner, grants, SECURITY DEFINER and search_path; only the lines named here
-- changed.
--
-- 1. DELIVERY IS A BRANCH SWITCH, NOT A BILL (§3). private.branch_feature_granted(branch,
--    'delivery') answers: the restaurant is paid up AND its features grant delivery AND the merchant has
--    not switched it off at that branch (a branch_addons row with active = false). No row, a new
--    branch included, delivers. The trial exception is gone: every plan delivers.
--    branch_has_feature -- and through it the orders and deliveries insert gates, quote_delivery
--    and storefront_status -- reads it unchanged. public.set_branch_delivery(branch, enabled) is
--    the switch, for branch.settings at that branch (the owner and platform admins included). A
--    switch bumps storefront_versions, as a delivery-hours change does, so an open storefront
--    refreshes.
--
-- 2. BILLING NEVER READS OR WRITES branch_addons (§4.2). billing_compute bills and grants only the
--    plan line and the extra_branch seat line; billing_apply_selection writes only those two;
--    request_package_change, validate_billing_discount, billing_price_one_time,
--    billing_checkout_context and billing_set_package price no delivery. Their p_delivery_branch_ids
--    parameters stay and are ignored, so no caller has to change in lockstep; new requests carry
--    addons = '{}' and delivery_branch_ids = '{}'. billing_paid_state's
--    delivery_unlocked_branch_ids is always []; entitlements_json lists the active branches that
--    deliver now in delivery_branch_ids and, for old readers, in delivery_unlocked_branch_ids;
--    get_billing_overview's branches say delivery_active (delivers now) and delivery_unlocked
--    (always true). private.branch_delivery_unlocked and private.delivery_unlocked_branch_ids, read
--    only by those functions, are dropped.
--
-- 3. THE CARD-RAIL DELIVERY GUARDS ARE DROPPED. branches_block_stripe_delivery_loss(_delete) kept a
--    delivering branch of a card restaurant from being hidden, deleted or moved, and
--    branches_stripe_delivery_off_on_hide switched a hidden branch's add-on off, because delivery
--    was billed per branch. It is not any more, so hiding a branch no longer touches delivery.
--
-- 4. ONLY A PLATFORM ADMIN WRITES restaurants.feature_overrides (§2). The guard trigger returned
--    early for the restaurant's owner, who could write the column directly and grant themselves any
--    feature (ai_suite opens three AI edge functions at the next recompute). The check now sits
--    above that early return; every other rule of the guard is unchanged. A new BEFORE INSERT
--    guard refuses a restaurant born with feature switches (or raw loyalty settings), and
--    billing_start_trial gives one free trial per person, as onboarding already did.
--
-- 5. CATALOG (§4.1). base 199 once / 49 a month, extra_branch 89 once / 49 a month, so a branch is
--    49 a month whichever product sells it. Both plans (base and the 14-day trial) grant exactly
--    {card_payment, delivery}. The delivery and ai_suite rows are kept, inactive and granting
--    nothing: billing_charges and billing_requests name them by code.
--
-- 6. DATA (§4.2, §6). Pending requests are cancelled, their charges voided and their discount uses
--    given back; delivery lines are deleted; every base and extra_branch line of a paying
--    restaurant, and its subscriptions.unit_price, is repriced to the catalog's 49; branch_addons is
--    emptied, so every branch delivers; overrides that switched a withdrawn feature on or repeated a
--    plan feature as true are removed (a platform admin's false is kept); every restaurant is
--    recomputed. Paid one-time charges stay as they were paid: nobody owes the difference. Trials
--    are untouched. No restaurant pays by card today (no stripe_subscription_id anywhere), so no
--    Stripe subscription needs repricing.
--
-- The file refuses to run while a card change is inside its 23-hour payment window
-- (private.billing_card_lock = 'active'): cancelling that request would let Stripe apply a change
-- nobody grants. There is none on 2026-10-24; if one appears, let it settle or expire first.
-- Everything is one transaction, so any failure leaves the old packaging exactly as it was.

begin;

-- ---------------------------------------------------------------------------------------------
-- 0. Nothing may be cancelled that Stripe can still charge for.
-- ---------------------------------------------------------------------------------------------

do $guard$
begin
  -- Locked first, so an edge function marking a request at this moment is waited for and seen.
  perform 1 from public.billing_requests where status = 'pending' for update;
  if exists (select 1 from public.billing_requests br
              where br.status = 'pending' and private.billing_card_lock(br) = 'active') then
    raise exception 'payment_in_progress'
      using hint = 'A package change is inside its 23-hour card payment window. Apply this migration once it has settled or expired.';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------------------------
-- 1. The delivery rule (§3). One definition; every gate reads it through branch_has_feature.
-- ---------------------------------------------------------------------------------------------

create or replace function private.branch_feature_granted(p_branch_id uuid, p_key text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select (be.features -> p_key) = to_jsonb(true)
       and (
         -- Only delivery is per branch. card_payment is in the plan and stays restaurant-wide:
         -- resolving it per branch would take card checkout away from every branch but the first.
         p_key <> 'delivery'
         or (
           -- Delivery is in the plan at every branch (docs/PACKAGING-2026-10-24.md §3), so the
           -- answer is "does this branch deliver now": the restaurant is paid up, and the merchant
           -- has not switched delivery off here. The switch is a branch_addons row with
           -- active = false; no row -- a branch created since, say -- delivers. The deadline is
           -- part of it so that every reader (entitlements_json, get_billing_overview, the edge's
           -- branchDeliversToday) gets the same "now" the insert gates enforce.
           be.entitled_through is not null and be.entitled_through > now()
           and not exists (
                 select 1 from public.branch_addons ba
                  where ba.branch_id = b.id and ba.code = 'delivery' and not ba.active)
         )
       )
    from public.branches b
    join public.billing_entitlements be on be.restaurant_id = b.restaurant_id
    where b.id = p_branch_id
  ), false);
$function$;

comment on function private.branch_feature_granted(uuid, text) is
  'Is the feature on for this branch? card_payment (and any other key) is the restaurant-wide grant, deadline aside. delivery is the rule of docs/PACKAGING-2026-10-24.md §3: the restaurant is paid up, billing_entitlements.features.delivery is true (restaurants.feature_overrides can switch it off), and no branch_addons row says the merchant switched it off at this branch.';

comment on table public.branch_addons is
  'The merchant''s per-branch delivery switch (docs/PACKAGING-2026-10-24.md §3). A row with code ''delivery'' and active = false means delivery is switched off at that branch; no row, or active = true, means the branch delivers. Written only by public.set_branch_delivery. Billing never reads or writes it: delivery is part of the plan at every branch.';

-- An open storefront refreshes on a storefront_versions UPDATE, so a switch shows up the way a
-- delivery-hours change does. bump_storefront_version reads the row's branch_id.
drop trigger if exists trg_bump_storefront_version on public.branch_addons;
create trigger trg_bump_storefront_version
  after insert or update or delete on public.branch_addons
  for each row execute function private.bump_storefront_version();

-- Live body; only the list of tables that carry branch_id gained branch_addons.
create or replace function private.bump_storefront_version()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
  v_branch_ids uuid[];
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;

  if tg_table_name = 'branches' then
    v_branch_ids := array[r.id];
  elsif tg_table_name = 'restaurants' then
    select array_agg(id) into v_branch_ids from public.branches where restaurant_id = r.id;
  elsif tg_table_name = 'brands' then
    -- A brand is restaurant-scoped; every branch of that restaurant may render from it.
    select array_agg(id) into v_branch_ids from public.branches where restaurant_id = r.restaurant_id;
  elsif tg_table_name = 'combo_items' then
    -- The only storefront table with no branch_id of its own.
    select array_agg(c.branch_id) into v_branch_ids from public.combo_sets c where c.id = r.combo_id;
  else
    -- menu_items, menu_categories, happy_hours, branch_hours, branch_delivery_hours,
    -- branch_closures, combo_sets, branch_addons (the delivery switch): all carry branch_id.
    v_branch_ids := array[r.branch_id];
  end if;

  insert into public.storefront_versions (branch_id, version, updated_at)
  select b, 1, now()
    from unnest(coalesce(v_branch_ids, '{}'::uuid[])) as b
   where b is not null
     -- Mid-cascade the branch is already deleted: nothing left to refresh.
     and exists (select 1 from public.branches x where x.id = b)
  on conflict (branch_id) do update
    set version = public.storefront_versions.version + 1,
        updated_at = now();

  return null;
end;
$function$;

-- The switch. Answers the branch's switch as it now stands: true = the branch delivers (while the
-- restaurant is paid up), false = switched off here.
create or replace function public.set_branch_delivery(p_branch_id uuid, p_enabled boolean)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;
  if p_branch_id is null or p_enabled is null then
    raise exception 'invalid_argument'
      using errcode = '22023', hint = 'A branch and true or false are required.';
  end if;

  -- The rule every branch setting follows (patch_branch_settings, set_branch_delivery_hours).
  -- staff_has_capability already answers yes for the restaurant's owner and for platform admins.
  if not private.staff_has_capability(p_branch_id, 'branch.settings') then
    raise exception 'forbidden'
      using errcode = '42501', hint = 'Switching delivery at a branch needs the branch settings permission there.';
  end if;

  -- A platform admin passes the check above for any id at all, so an unknown branch is named here
  -- instead of failing on branch_addons' foreign key.
  if not exists (select 1 from public.branches where id = p_branch_id) then
    raise exception 'branch_not_found' using errcode = 'P0002';
  end if;

  -- On deletes the row (no row = delivers), off writes active = false. Saying the same thing twice
  -- writes nothing, so it does not bump the storefront either.
  if p_enabled then
    delete from public.branch_addons where branch_id = p_branch_id and code = 'delivery';
  else
    insert into public.branch_addons as ba (branch_id, code, active)
    values (p_branch_id, 'delivery', false)
    on conflict (branch_id, code) do update
      set active = false, updated_at = now()
      where ba.active;
  end if;

  return not exists (select 1 from public.branch_addons
                      where branch_id = p_branch_id and code = 'delivery' and not active);
end $function$;

comment on function public.set_branch_delivery(uuid, boolean) is
  'The merchant''s "Delivery at this branch" switch (docs/PACKAGING-2026-10-24.md §3). true deletes the branch_addons row, false upserts it with active = false. For branch.settings at that branch, the restaurant''s owner and platform admins. Free: it bills nothing and no billing writer undoes it. Deliveries already created are never touched; only new delivery work is refused at an off branch. Returns the switch as it now stands.';

revoke all on function public.set_branch_delivery(uuid, boolean) from public, anon, service_role;
grant execute on function public.set_branch_delivery(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Billing without delivery (§4.2).
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
  -- Nothing is sold as an add-on any more (docs/PACKAGING-2026-10-24.md §1), so this stays empty.
  -- The column is kept for the readers that still parse it.
  v_addons           text[] := '{}'::text[];
  v_overrides        jsonb := '{}'::jsonb;
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

    -- Deadline: private.billing_deadline, the one the expiry cron uses too. On the Stripe rail it
    -- runs past the period end by the grace days, because Stripe charges the renewal after the
    -- period has ended and a declined card must not take a restaurant offline in the middle of
    -- service (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md D9, §9.1).
    v_entitled_through := private.billing_deadline(v_status, v_sub.stripe_subscription_id,
                                                   v_sub.current_period_end, v_sub.trial_ends_at,
                                                   v_sub.grace_until);

    -- One row per line item: seats, money, plan code. Only the plan line (base, or the trial) and
    -- the extra_branch seat line count (docs/PACKAGING-2026-10-24.md §4.2), so monthly_total is the
    -- plan's monthly price for the first branch plus the seat's for every branch after it. A line
    -- of any other product -- a delivery or ai_suite line some older writer left behind -- is
    -- neither billed nor granted, and billing_apply_selection, the only writer, deletes it on the
    -- next package change.
    select
      coalesce(sum(coalesce(bp.included_seats, 0) + coalesce(bp.seats_per_unit, 0) * si.quantity), 0),
      coalesce(sum(si.unit_price * si.quantity), 0),
      coalesce(min(bp.code) filter (where bp.kind = 'plan'), 'none')
    into v_seats, v_total, v_plan_code
    from public.subscription_items si
    join public.billing_products bp on bp.code = si.product_code
    where si.subscription_id = v_sub.id
      and (bp.kind = 'plan' or bp.code = 'extra_branch');

    -- Feature grants are a set union over the same lines, computed separately so it cannot skew
    -- the sums. Which BRANCHES deliver is the merchant's switch (branch_addons), not this row's.
    select coalesce(jsonb_object_agg(k, true), '{}'::jsonb)
    into v_features
    from (
      select distinct f.key as k
      from public.subscription_items si
      join public.billing_products bp on bp.code = si.product_code
      cross join lateral jsonb_each(bp.features) f
      where si.subscription_id = v_sub.id
        and (bp.kind = 'plan' or bp.code = 'extra_branch')
        and f.value = to_jsonb(true)
    ) keys;

    if coalesce(v_sub.plan_code, '') <> '' and v_plan_code = 'none' then
      v_plan_code := v_sub.plan_code;
    end if;

    -- A trial is $0 a month, whatever its lines say (docs/PACKAGING-2026-10-24.md §1). The
    -- platform console can give a trial more seats in one click, and a line priced from the
    -- catalog -- a seat line written before the trial rule existed, or by any future writer that
    -- forgets it -- would otherwise put a monthly price on a free trial's plan page (MONEY-5).
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
  -- For delivery it says whether the account may deliver at all; the merchant's
  -- switch at each branch (branch_addons) still says where.
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

create or replace function private.billing_apply_selection(p_restaurant_id uuid, p_plan_code text, p_delivery_branch_ids uuid[], p_branch_seats integer, p_status text DEFAULT 'active'::text, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_trial_ends_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan          public.billing_products%rowtype;
  v_seat          public.billing_products%rowtype;
  v_sub_id        uuid;
  v_seats         integer := greatest(coalesce(p_branch_seats, 1), 1);
  v_extra         integer;
  v_start         timestamptz := coalesce(p_period_start, now());
  v_end           timestamptz;
  v_trial_ends_at timestamptz := p_trial_ends_at;
  v_used          integer;
  v_keep          text[];
  v_seat_price    numeric(10,2);
begin
  -- p_delivery_branch_ids is accepted and ignored (docs/PACKAGING-2026-10-24.md §4.2): delivery is
  -- in the plan at every branch, so a package says nothing about where it is on. It stays in the
  -- signature so the five callers, and the old requests they replay, need not change in lockstep.
  if p_restaurant_id is null then raise exception 'restaurant_required'; end if;

  select * into v_plan from public.billing_products where code = p_plan_code and kind = 'plan';
  if not found then raise exception 'unknown_plan:%', p_plan_code; end if;

  select * into v_seat from public.billing_products where code = 'extra_branch';

  -- The trial is $0 with everything on (docs/PACKAGING-2026-10-24.md §1), and that includes the
  -- branches beyond the first: the platform console can raise a trial's seats in one click, and
  -- charging the extra-branch line's monthly price for each of them put a monthly price on a free
  -- trial's plan page. The seat LINE still has to exist -- billing_compute reads the seat count off
  -- it, and deleting it would strand the merchant's second branch outside enforce_branch_limit --
  -- so the seat is kept and priced at the trial plan's own monthly price (0). This is the same rule
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

  -- Downgrades must leave zero orphan line items. A delivery line from the 2026-09-23 packaging is
  -- one of them.
  delete from public.subscription_items
   where subscription_id = v_sub_id and product_code <> all (v_keep);

  -- branch_addons is not touched: whether a branch delivers is its merchant's switch
  -- (public.set_branch_delivery), and no package change may turn it on or off.

  perform private.billing_compute(p_restaurant_id);
  return private.entitlements_json(p_restaurant_id);
end $function$;

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
    -- Kept for old readers. Delivery has no fee of any kind any more
    -- (docs/PACKAGING-2026-10-24.md §4.2), so no branch has anything "unlocked".
    'delivery_unlocked_branch_ids', '[]'::jsonb);
end $function$;

create or replace function private.billing_price_one_time(p_restaurant_id uuid, p_plan_code text, p_branch_seats integer, p_delivery_branch_ids uuid[])
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan     public.billing_products%rowtype;
  v_seat     public.billing_products%rowtype;
  v_paid     jsonb;
  -- Range-checked here too, not only at the two public entry points: this is the function the
  -- seat count is actually expensive in, and a private helper that trusts its callers is one
  -- refactor away from being the hole again.
  v_seats    integer := private.billing_seats_in_range(p_branch_seats);
  v_covered  integer;
  v_extra_seats integer;
  v_lines    jsonb := '[]'::jsonb;
  v_total    numeric(10,2) := 0;
begin
  -- p_delivery_branch_ids is ignored: delivery is in the plan and has no one-time fee
  -- (docs/PACKAGING-2026-10-24.md §4.2). It stays in the signature for the callers.
  select * into v_plan from public.billing_products where code = p_plan_code and kind = 'plan';
  if not found then raise exception 'unknown_plan:%', p_plan_code; end if;

  -- The trial is granted once at signup and never sold, so it raises nothing one-time.
  if coalesce(v_plan.trial_days, 0) > 0 then
    return jsonb_build_object('lines', '[]'::jsonb, 'total', 0);
  end if;

  select * into v_seat from public.billing_products where code = 'extra_branch';

  v_paid := private.billing_paid_state(p_restaurant_id);

  if coalesce((v_paid ->> 'base_paid')::boolean, false) is not true then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', v_plan.code, 'branch_id', null, 'amount', coalesce(v_plan.one_time_price, 0)));
    v_total := v_total + coalesce(v_plan.one_time_price, 0);
  end if;

  -- The base INCLUDES the first branch, so a first-time buyer of one branch pays the base's
  -- one-time price alone, not that plus a branch's. Once the base is paid, what is covered is what
  -- the ledger and the granted seats say. A seat can be bought before its branch exists (the
  -- merchant pays, then creates it), so a seat line carries no branch id: how many are paid for is
  -- the count, not a per-branch row.
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

  return jsonb_build_object('lines', v_lines, 'total', v_total);
end $function$;

create or replace function public.request_package_change(p_restaurant_id uuid, p_plan_code text, p_branch_seats integer DEFAULT 1, p_delivery_branch_ids uuid[] DEFAULT '{}'::uuid[], p_discount_code text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan     public.billing_products%rowtype;
  v_seats    integer;
  v_ids_superseded uuid[];
  v_open     integer;
  v_monthly  numeric(10,2) := 0;
  v_code     text := nullif(upper(btrim(coalesce(p_discount_code, ''))), '');
  v_priced   jsonb;
  v_quote    jsonb;
  v_row      public.billing_requests%rowtype;
  v_reason   text;
begin
  -- p_delivery_branch_ids is accepted and ignored (docs/PACKAGING-2026-10-24.md §4.2): delivery is
  -- in the plan at every branch. The request records addons = '{}' and delivery_branch_ids = '{}'.
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

  -- The plan's monthly price for the first branch and the extra branch's for every seat past the
  -- included ones: the same sum billing_compute makes once the request is applied.
  v_monthly := v_plan.monthly_price
             + greatest(v_seats - coalesce(v_plan.included_seats, 0), 0)
               * coalesce((select monthly_price from public.billing_products where code = 'extra_branch'), 0);

  -- One request at a time per restaurant. Two submits in the same instant would otherwise both
  -- void "the" pending request, both price against the same ledger and both reserve a code.
  perform pg_advisory_xact_lock(hashtextextended('favornoms.billing_request:' || p_restaurant_id::text, 0));

  -- A card change that Stripe can still apply (its invoice is open, or its subscription update was
  -- sent, less than 23 hours ago) cannot be replaced: Stripe applies it the moment that invoice is
  -- paid, whatever happened to the request meanwhile, so superseding it would charge the merchant
  -- for a package nobody grants (money-sql-1, §9.3). The pending rows are locked first, so an edge
  -- function marking the request at this very moment is waited for and seen. Past the window the
  -- lock is released: the old request is cancelled here, outside the block below, so it stays
  -- cancelled whatever this call answers (money-rr-1, §10.1). A Checkout (a first purchase, no
  -- invoice yet) can still be replaced: its other sessions are expired and a late payment is
  -- refunded (D12).
  perform 1 from public.billing_requests
   where restaurant_id = p_restaurant_id and status = 'pending'
   for update;
  perform private.billing_release_expired_card_locks(p_restaurant_id);
  if exists (select 1 from public.billing_requests br
              where br.restaurant_id = p_restaurant_id and br.status = 'pending'
                and private.billing_card_lock(br) = 'active') then
    raise exception 'payment_in_progress' using errcode = 'P0001',
      hint = 'A package change is waiting for its card payment on Stripe; finish paying it there, or wait until Stripe drops it.';
  end if;

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

    v_priced := private.billing_price_one_time(p_restaurant_id, v_plan.code, v_seats, '{}'::uuid[]);

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
       '{}'::text[],
       v_seats, v_monthly, p_note,
       '{}'::uuid[],
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

create or replace function public.validate_billing_discount(p_restaurant_id uuid, p_code text, p_plan_code text, p_branch_seats integer, p_delivery_branch_ids uuid[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_seats  integer;
  v_priced jsonb;
  v_quote  jsonb;
begin
  -- p_delivery_branch_ids is accepted and ignored, as request_package_change ignores it
  -- (docs/PACKAGING-2026-10-24.md §4.2).
  if auth.uid() is null then raise exception 'auth_required'; end if;
  -- Pricing a purchase, even without buying it, is billing.manage's. See
  -- private.user_can_manage_billing.
  if not private.user_can_manage_billing(p_restaurant_id) then
    raise exception 'forbidden';
  end if;

  v_seats := private.billing_seats_in_range(p_branch_seats);

  -- Priced against what is PAID, so a merchant with a request already queued is quoted the same
  -- total as the request they are about to replace -- not "nothing to discount" because the
  -- queued request's own charges made everything look bought.
  v_priced := private.billing_price_one_time(p_restaurant_id, p_plan_code, v_seats, '{}'::uuid[]);

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

create or replace function public.billing_set_package(p_restaurant_id uuid, p_plan_code text, p_branch_seats integer DEFAULT 1, p_delivery_branch_ids uuid[] DEFAULT '{}'::uuid[], p_status text DEFAULT 'active'::text, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  -- Stripe bills this restaurant; a package applied here would not be what Stripe charges, and
  -- the next paid invoice would move a period this call had just rewritten. Feature switches and
  -- suspension are separate calls and still work.
  if private.billing_is_stripe_managed(p_restaurant_id) then
    raise exception 'stripe_managed'
      using hint = 'This restaurant pays by card through Stripe; change it in Stripe or from its plan page.';
  end if;
  perform private.billing_detach_stripe_subscription(p_restaurant_id);
  -- p_delivery_branch_ids is ignored (docs/PACKAGING-2026-10-24.md §4.2): the package is the plan
  -- and its seats, and delivery is on at every branch its merchant has not switched off.
  return private.billing_apply_selection(
    p_restaurant_id, p_plan_code, '{}'::uuid[],
    p_branch_seats, p_status, null, p_period_end, null);
end $function$;

create or replace function public.billing_checkout_context(p_request_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_req      public.billing_requests%rowtype;
  v_plan     public.billing_products%rowtype;
  v_seat     public.billing_products%rowtype;
  v_extra    integer;
  v_open     integer;
  v_lines    jsonb := '[]'::jsonb;
  v_sub      jsonb;
begin
  select * into v_req from public.billing_requests where id = p_request_id;
  -- An unknown request and a stranger's request answer the same, so this says nothing about
  -- which request ids exist.
  if not found or not private.user_can_manage_billing(v_req.restaurant_id) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  -- Only a request that is still on order can be paid for. A superseded or decided one would be
  -- refunded on arrival (D12); refusing here means nobody is charged for it in the first place.
  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'request_not_pending', 'status', v_req.status);
  end if;

  select * into v_plan from public.billing_products where code = v_req.plan_code and kind = 'plan';
  if not found or coalesce(v_plan.trial_days, 0) > 0 then
    return jsonb_build_object('ok', false, 'error', 'plan_not_billable');
  end if;

  -- The seat floor billing_apply_selection enforces at settlement. A branch opened after the
  -- request was filed (a trial with spare seats, say) would make the settle fail AFTER the card
  -- was charged; refusing here charges nobody. The merchant files a request with enough seats.
  select count(*) into v_open
    from public.branches b where b.restaurant_id = v_req.restaurant_id and b.is_active;
  if v_req.branch_seats < v_open then
    return jsonb_build_object('ok', false, 'error', 'plan_limit_exceeded',
                              'detail', format('plan_limit_exceeded:branches:%s/%s', v_open, v_req.branch_seats),
                              'branches_used', v_open, 'branch_seats', v_req.branch_seats);
  end if;

  select * into v_seat from public.billing_products where code = 'extra_branch';

  -- The monthly lines Stripe bills are the ones billing_compute will sum once this request is
  -- applied: the plan once and every seat past the included ones. There is no delivery line
  -- (docs/PACKAGING-2026-10-24.md §4.2), whatever an old request's delivery_branch_ids says.
  v_extra := greatest(v_req.branch_seats - coalesce(v_plan.included_seats, 0), 0);

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'code', v_plan.code, 'quantity', 1,
    'unit_amount_cents', round(coalesce(v_plan.monthly_price, 0) * 100)::integer));
  if v_extra > 0 and v_seat.code is not null then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', v_seat.code, 'quantity', v_extra,
      'unit_amount_cents', round(coalesce(v_seat.monthly_price, 0) * 100)::integer));
  end if;

  select jsonb_build_object(
           'status', s.status,
           'plan_code', s.plan_code,
           'stripe_subscription_id', s.stripe_subscription_id,
           'stripe_customer_id', s.stripe_customer_id,
           'current_period_end', s.current_period_end,
           'trial_ends_at', s.trial_ends_at,
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'product_code', si.product_code,
                      'quantity', si.quantity,
                      'stripe_subscription_item_id', si.stripe_subscription_item_id)
                    order by si.product_code)
               from public.subscription_items si
              where si.subscription_id = s.id), '[]'::jsonb))
    into v_sub
    from public.subscriptions s
   where s.restaurant_id = v_req.restaurant_id
   limit 1;

  return jsonb_build_object(
    'ok', true,
    'request', to_jsonb(v_req),
    'restaurant', (
      select jsonb_build_object(
               'id', r.id,
               'name', r.name,
               'slug', r.slug,
               'stripe_customer_id', (select c.stripe_customer_id from public.billing_stripe_customers c
                                       where c.restaurant_id = r.id),
               -- As stored. The edge function leaves out an address no mail can reach.
               'owner_email', u.email)
        from public.restaurants r
        left join auth.users u on u.id = r.owner_user_id
       where r.id = v_req.restaurant_id),
    -- What is charged once, at its NET amount (after the code). A $0 line -- a fee a code took
    -- off in full -- is left out: there is nothing to collect, and settling marks it paid with the
    -- rest of the request.
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'code', c.code,
               'branch_id', c.branch_id,
               'net_amount', c.net_amount)
             order by c.created_at, c.id)
        from public.billing_charges c
       where c.request_id = v_req.id
         and c.status = 'pending'
         and c.net_amount > 0), '[]'::jsonb),
    'monthly_lines', v_lines,
    'subscription', v_sub,
    'stripe_managed', private.billing_is_stripe_managed(v_req.restaurant_id));
end $function$;

create or replace function private.entitlements_json(p_restaurant_id uuid, p_branch_id uuid DEFAULT NULL::uuid)
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
    'billing_rail',     case when m.managed then 'stripe' else 'manual' end,
    'billing_ends_at',  case
                          when not m.managed then null
                          when s.cancel_at is not null
                               and s.cancel_at <= coalesce(s.next_billing_at, s.current_period_end)
                            then s.cancel_at
                          when coalesce(s.cancel_at_period_end, false) then s.current_period_end
                        end,
    'entitled',         coalesce(be.entitled_through is not null and be.entitled_through > now(), false),
    'entitled_through', be.entitled_through,
    'trial_ends_at',    be.trial_ends_at,
    'branch_seats',     coalesce(be.branch_seats, 0),
    -- A hidden branch holds no seat, so it must not block lowering the seat count.
    'branches_used',    (select count(*) from public.branches b where b.restaurant_id = p_restaurant_id and b.is_active),
    'monthly_total',    coalesce(be.monthly_total, 0),
    -- RAW grants, deadline excluded (hasFeature() in the client adds the deadline back), except
    -- the one key a branch payload overrides: delivery is that branch's answer,
    -- private.branch_feature_granted (paid up, granted, not switched off there), so every
    -- existing hasFeature(ent, 'delivery') call site is per branch without being touched.
    'features',         case
                          when p_branch_id is null then coalesce(be.features, '{}'::jsonb)
                          else coalesce(be.features, '{}'::jsonb)
                               || jsonb_build_object('delivery',
                                    private.branch_feature_granted(p_branch_id, 'delivery'))
                        end,
    'addons',           to_jsonb(coalesce(be.addons, '{}'::text[])),
    -- The ACTIVE branches that deliver now: a hidden branch takes no orders.
    'delivery_branch_ids', d.ids,
    -- Kept for old readers, which took it as "this branch's delivery is already bought". Nothing
    -- is bought per branch any more (docs/PACKAGING-2026-10-24.md §4.2), so it is the same list.
    'delivery_unlocked_branch_ids', d.ids
  )
  from (select private.billing_is_stripe_managed(p_restaurant_id) as managed) m
  cross join lateral (
    select coalesce((
             select jsonb_agg(b.id order by b.created_at, b.id)
               from public.branches b
              where b.restaurant_id = p_restaurant_id
                and b.is_active
                and private.branch_feature_granted(b.id, 'delivery')
           ), '[]'::jsonb) as ids
  ) d
  left join public.billing_entitlements be on be.restaurant_id = p_restaurant_id
  left join public.subscriptions s on s.restaurant_id = p_restaurant_id;
$function$;

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
               -- This branch delivers now: paid up, and not switched off in its settings
               -- (private.branch_feature_granted). Delivery is in the plan, so the plan page only
               -- reports it.
               'delivery_active', private.branch_feature_granted(b.id, 'delivery'),
               -- Kept for old readers. Delivery is never bought per branch any more
               -- (docs/PACKAGING-2026-10-24.md §4.2).
               'delivery_unlocked', true
             ) order by b.created_at, b.id)
        from public.branches b
       where b.restaurant_id = p_restaurant_id and b.is_active
    ), '[]'::jsonb),
    -- What is PAID. A pending request's charges are not in here; they are on order, and the
    -- request below says what they come to.
    'paid', v_paid,
    -- The restaurant's open request, if any, as the plan page shows it: what it will cost once
    -- (net of the code), which code and how much came off, and its rail (stripe = waiting for the
    -- card payment to finish). Its charges are in `charges` with status 'pending'.
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
    ), '[]'::jsonb),
    -- How it pays: card through Stripe or the manual rail, and on the Stripe rail the next charge,
    -- the card, the last invoice and any failed renewal's grace.
    'billing', private.billing_rail_json(p_restaurant_id));
end $function$;

comment on function public.get_billing_overview(uuid) is
  'Everything the plan page needs in one read: the entitlements payload, each active branch with whether it delivers now (delivery_active; delivery_unlocked is always true, kept for old readers), what is PAID (billing_paid_state), the open request with its one-time total and discount, and the one-time ledger with each charge''s status. Merchants reach billing_charges only through here.';

comment on column public.billing_requests.delivery_branch_ids is
  'Written by the 2026-09-23 packaging only: the branches a request asked to deliver from. Since docs/PACKAGING-2026-10-24.md every new request carries ''{}'' and no reader acts on it; kept for the history of older requests.';

-- ---------------------------------------------------------------------------------------------
-- 3. The card-rail delivery guards, and the "unlocked" helpers nothing reads any more.
-- ---------------------------------------------------------------------------------------------

drop trigger if exists branches_block_stripe_delivery_loss on public.branches;
drop trigger if exists branches_block_stripe_delivery_loss_delete on public.branches;
drop trigger if exists branches_stripe_delivery_off_on_hide on public.branches;
drop function if exists private.guard_branch_stripe_delivery();
drop function if exists private.tg_branches_stripe_delivery_off();
drop function if exists private.delivery_unlocked_branch_ids(uuid);
drop function if exists private.branch_delivery_unlocked(uuid);

-- ---------------------------------------------------------------------------------------------
-- 4. restaurants.feature_overrides is the platform's (§2).
-- ---------------------------------------------------------------------------------------------

create or replace function private.guard_restaurant_privileged_columns()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Only end-user writes are policed. A service-role caller (billing sync,
  -- Stripe webhook) has no auth.uid() and must not be broken by this guard.
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;

  -- Deliberately ABOVE the owner/platform-admin early return: not even the owner may write the raw
  -- JSON, because that skips validation, the badge re-grade and the stale-editor check. The flag is
  -- raised only inside set_loyalty_settings(), after it has required user_owns_restaurant(), and
  -- lowered again the moment its UPDATE is done.
  if new.loyalty_settings is distinct from old.loyalty_settings
     and coalesce(current_setting('favornoms.loyalty_settings_write', true), 'off') <> 'on' then
    raise exception 'restaurant_privileged_column_denied'
      using hint = 'The loyalty programme is changed through set_loyalty_settings().';
  end if;

  -- Also above it: the Stripe customer is the one the customer portal and Checkout are opened
  -- for, and every restaurant's is readable. An owner who could write it could open another
  -- restaurant's portal. Only the stripe-billing edge function (service role) sets it.
  if new.stripe_customer_id is distinct from old.stripe_customer_id then
    raise exception 'restaurant_privileged_column_denied'
      using hint = 'The Stripe customer is set by the platform when the restaurant first pays by card.';
  end if;

  -- Also above it: a feature switch grants what the plan does not sell (ai_suite opens three AI
  -- edge functions), so it is the platform's alone (docs/PACKAGING-2026-10-24.md §2). The owner
  -- used to pass the early return below and could switch any feature on for themselves.
  -- platform_set_feature_override is the way in.
  if new.feature_overrides is distinct from old.feature_overrides
     and not private.user_is_platform_admin() then
    raise exception 'restaurant_privileged_column_denied'
      using hint = 'Feature switches are set by the platform.';
  end if;

  if private.user_is_platform_admin() or old.owner_user_id = auth.uid() then
    return new;
  end if;
  if new.id                 is distinct from old.id
     or new.owner_user_id      is distinct from old.owner_user_id
     or new.slug               is distinct from old.slug
     or new.custom_domain      is distinct from old.custom_domain
     or new.franchise_group_id is distinct from old.franchise_group_id then
    raise exception 'restaurant_privileged_column_denied'
      using hint = 'Only the restaurant owner or a platform admin may change ownership, slug, custom domain or franchise columns.';
  end if;
  return new;
end;
$function$;

-- The guard above is BEFORE UPDATE only, and restaurants_owner_full lets any signed-in user insert
-- a restaurant they own, so a row could be born with feature switches already on: restaurants_billing_seed
-- folds them in, billing_start_trial grants them for 14 days, and a later purchase keeps them. A
-- separate INSERT guard, because the update guard compares NEW with OLD and OLD is NULL here (its
-- loyalty_settings check would refuse every new restaurant, onboarding included). Onboarding
-- (create_restaurant_with_branch) inserts the column defaults, so it is untouched; loyalty settings are
-- policed the same way because a raw insert skips set_loyalty_settings' validation.
create or replace function private.guard_restaurant_insert_privileged_columns()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if coalesce(auth.role(), '') <> 'authenticated' or private.user_is_platform_admin() then
    return new;
  end if;
  if coalesce(new.feature_overrides, '{}'::jsonb) <> '{}'::jsonb then
    raise exception 'restaurant_privileged_column_denied'
      using hint = 'Feature switches are set by the platform.';
  end if;
  if coalesce(new.loyalty_settings, '{}'::jsonb) <> '{}'::jsonb then
    raise exception 'restaurant_privileged_column_denied'
      using hint = 'The loyalty programme is changed through set_loyalty_settings().';
  end if;
  return new;
end;
$function$;

revoke all on function private.guard_restaurant_insert_privileged_columns() from public, anon, authenticated;

drop trigger if exists guard_restaurant_insert_privileged_columns on public.restaurants;
create trigger guard_restaurant_insert_privileged_columns
  before insert on public.restaurants
  for each row execute function private.guard_restaurant_insert_privileged_columns();

comment on column public.restaurants.feature_overrides is
  'Platform-admin feature switches, written only by a platform admin (platform_set_feature_override; guard_restaurant_privileged_columns and guard_restaurant_insert_privileged_columns refuse anyone else signed in, on update and on insert). true = force on, false = force off, absent = follow the plan. Applied by private.billing_compute() after the plan''s grants.';

-- One free trial per person. create_restaurant_with_branch has started a trial only for a caller who
-- owns no restaurant yet since 2026-09-13, but billing_start_trial still started one for any restaurant
-- without a subscription, so a second restaurant (from the wizard, or inserted directly) earned another
-- free fortnight of every feature, as often as wanted. It now refuses a caller who owns, or is an active
-- owner of, any other restaurant -- the wizard's own rule. Platform admins may still start one.
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
  if not private.user_is_platform_admin()
     and (exists (select 1 from public.restaurants r
                   where r.owner_user_id = auth.uid() and r.id <> p_restaurant_id)
          or exists (select 1 from public.staff_members sm
                      where sm.user_id = auth.uid() and sm.status = 'active' and sm.role = 'owner'
                        and sm.restaurant_id <> p_restaurant_id)) then
    raise exception 'trial_already_used'
      using hint = 'One free trial per person; this restaurant is bought on Plan & billing.';
  end if;
  return private.billing_apply_selection(p_restaurant_id, 'trial', '{}'::uuid[], 1, 'trialing', null, null, null);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 5. The catalog (§4.1). After the functions, so the recompute it fires already prices the new way.
-- ---------------------------------------------------------------------------------------------

insert into public.billing_products as bp
  (code, name, kind, one_time_price, monthly_price, included_seats, seats_per_unit, is_quantity,
   features, is_active, trial_days, sort_order, description)
values
  ('base', 'FavorNoms Plan', 'plan', 199, 49, 1, 0, false,
   '{"card_payment": true, "delivery": true}'::jsonb, true, 0, 20,
   'Every feature at your first branch: branded ordering website and app, POS, kitchen display, FavorGo driver tools, marketing, loyalty and reports. No marketplace commissions.'),
  ('extra_branch', 'Additional branch', 'addon', 89, 49, 0, 1, true,
   '{}'::jsonb, true, 0, 30,
   'Each branch after the first, with every feature of the plan.'),
  ('trial', 'Free trial', 'plan', 0, 0, 1, 0, false,
   '{"card_payment": true, "delivery": true}'::jsonb, true, 14, 10,
   'Every feature at one branch for 14 days. No credit card required.'),
  ('delivery', 'Delivery (withdrawn)', 'addon', 0, 0, 0, 0, true,
   '{}'::jsonb, false, 0, 40,
   'Withdrawn on 2026-10-24: delivery is part of the FavorNoms Plan at every branch.')
on conflict (code) do update set
  name           = excluded.name,
  kind           = excluded.kind,
  one_time_price = excluded.one_time_price,
  monthly_price  = excluded.monthly_price,
  included_seats = excluded.included_seats,
  seats_per_unit = excluded.seats_per_unit,
  is_quantity    = excluded.is_quantity,
  features       = excluded.features,
  is_active      = excluded.is_active,
  description    = excluded.description,
  updated_at     = now();
-- trial_days and sort_order are left as they are on an existing row: the trial stays 14 days.

-- Withdrawn and granting nothing ("nothing extra", §2): an inactive product whose map still named
-- ai_suite would be one console tick away from switching the AI edge functions on again.
update public.billing_products
   set name = 'AI Suite (withdrawn)', is_active = false, features = '{}'::jsonb, updated_at = now()
 where code = 'ai_suite';

comment on column public.billing_products.one_time_price is
  'Paid once, ever: $199 for the FavorNoms Plan (first branch), $89 for each additional branch (docs/PACKAGING-2026-10-24.md). Never charged twice: public.billing_charges is the ledger that proves it.';

-- ---------------------------------------------------------------------------------------------
-- 6. Existing restaurants (§4.2, §6).
-- ---------------------------------------------------------------------------------------------

do $data$
declare
  r       record;
  v_ids   uuid[];
  v_drop  text[];
begin
  -- 6a. Pending requests were priced under the old catalog (a $170 base, $30 delivery lines).
  -- Approving one as filed would mix those one-time amounts with the new monthly price, so each is
  -- cancelled the way a superseded request is: its charges void (never agreed to), its code's use
  -- given back. Card locks were refused at the top of the file.
  select coalesce(array_agg(id), '{}'::uuid[]) into v_ids
    from public.billing_requests where status = 'pending';

  update public.billing_charges
     set status = 'void'
   where status = 'pending' and request_id = any (v_ids);

  perform private.billing_release_discount(v_ids);

  update public.billing_requests
     set status        = 'cancelled',
         decided_at    = now(),
         decision_note = 'Prices changed on 2026-10-24: one plan, every feature included. Please choose your branches again.',
         updated_at    = now()
   where id = any (v_ids);

  -- 6b. Delivery lines: nothing sells delivery, and billing_compute no longer bills or grants
  -- them. Deleted, as the ai_suite lines were in 20260923100000.
  delete from public.subscription_items where product_code = 'delivery';

  -- 6c. Every paying restaurant moves to the new price per branch at once (§6). The trial's lines
  -- are left alone (trials are untouched; a trial's seat line is priced at the trial's 0).
  update public.subscription_items si
     set unit_price = bp.monthly_price, updated_at = now()
    from public.subscriptions s, public.billing_products bp, public.billing_products pp
   where s.id = si.subscription_id
     and bp.code = si.product_code
     and si.product_code in ('base', 'extra_branch')
     and pp.code = s.plan_code
     and coalesce(pp.trial_days, 0) = 0
     and si.unit_price is distinct from bp.monthly_price;

  update public.subscriptions s
     set unit_price = bp.monthly_price, updated_at = now()
    from public.billing_products bp
   where bp.code = s.plan_code
     and bp.kind = 'plan'
     and coalesce(bp.trial_days, 0) = 0
     and s.unit_price is distinct from bp.monthly_price;

  -- 6d. Every branch delivers after the switch-over (§3): the old add-on rows said where delivery
  -- was BOUGHT, not where a merchant switched it off.
  delete from public.branch_addons;

  -- 6e. An override that switched a withdrawn feature on, or repeated a plan feature as true, is
  -- removed (§2). A false -- a platform admin switching something off -- is kept.
  v_drop := array['ai_suite', 'ai_voice', 'digital_signage', 'ai_menu_import']
            || coalesce(array(select jsonb_object_keys(features) from public.billing_products
                               where code = 'base'), '{}'::text[]);

  -- jsonb_each only ever sees an object: the CASE, not the order of the WHERE, guarantees it.
  update public.restaurants rs
     set feature_overrides = coalesce((
           select jsonb_object_agg(e.key, e.value)
             from jsonb_each(rs.feature_overrides) e
            where not (e.value = to_jsonb(true) and e.key = any (v_drop))
         ), '{}'::jsonb)
   where exists (select 1
                   from jsonb_each(case when jsonb_typeof(rs.feature_overrides) = 'object'
                                        then rs.feature_overrides else '{}'::jsonb end) e
                  where e.value = to_jsonb(true) and e.key = any (v_drop));

  -- 6f. Settle every restaurant once more, whatever it holds, so billing_entitlements is the new
  -- arithmetic and the new grants everywhere (the triggers above reach only the rows they touched).
  for r in select id from public.restaurants loop
    perform private.billing_compute(r.id);
  end loop;
end
$data$;

commit;
