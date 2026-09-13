-- Merchant lifecycle: seats for hidden branches, one trial per account, who may open a branch
-- or file a package request, setting up a new branch from an existing one, changing a team
-- member's branch access, and letting a merchant read what the platform decided.
--
-- Every existing function below is its LIVE body, read with pg_get_functiondef on 2026-09-13,
-- plus only the edit described here. None of the billing or onboarding SQL was ever committed
-- (supabase/migrations/README.md), so this file is also the first copy of each in git.
--
-- 1. A hidden branch no longer holds a paid seat.
--    create_branch, the enforce_branch_limit trigger, billing_apply_selection,
--    entitlements_json (branches_used), check_plan_limit, platform_financial_summary and the
--    subscriptions.branch_count mirror all counted EVERY branch, hidden or not. A merchant who
--    tried a second location, closed it with the Hidden checkbox and asked to go back to one
--    seat was refused with plan_limit_exceeded:branches:2/1, while the plan page told them to
--    "close a branch first" — and Hidden is the only way to close one. They now count
--    is_active branches only.
--
--    That alone would open a hole: at 1 of 1 seats a merchant could hide branch A, create
--    branch B, then un-hide A and run two storefronts on one seat. So enforce_branch_limit now
--    also fires on UPDATE OF is_active when a branch goes from hidden to active, and that
--    reactivation needs a free seat. It deliberately does NOT need the restaurant to be paid
--    up: switching a branch back on sells nothing (orders, deliveries and payments keep their
--    own billing triggers, and the storefront shows the billing screen), and demanding it
--    would make the platform console's Restore fail outright for any store that is both
--    suspended and lapsed. Inserting a branch, or moving one to another restaurant, still
--    needs both a paid-up restaurant and a seat.
--
-- 2. One free trial per account.
--    create_restaurant_with_branch started a fresh 14-day, all-features trial on every call,
--    so running the onboarding wizard again gave the same person another free fortnight and
--    another public storefront, indefinitely. It now starts the trial only when the caller
--    owns no restaurant yet (restaurants.owner_user_id, or an active owner staff row). A
--    further restaurant is created with no subscription, so its owner lands on Plan & billing
--    like any lapsed store. The reply now carries trial_granted so the wizard can say so.
--
--    The founding branch of that unpaid restaurant must still be inserted, but
--    enforce_branch_limit rightly refuses a branch for a restaurant that is not paid up and has
--    zero seats. The exemption is a transaction-local setting, favornoms.founding_restaurant_id:
--    create_restaurant_with_branch sets it to the id it has just inserted, immediately before
--    its single branch insert, and clears it immediately after. The trigger honours it only for
--    an INSERT into exactly that restaurant while that restaurant has no branches at all.
--    Nothing else can use it. No client can call set_config (pg_catalog is not exposed over
--    PostgREST, and before this migration no public or private function called set_config or
--    current_setting — checked in the live catalog). is_local = true means it dies with the
--    transaction. And a forged value would buy only the first branch of an empty restaurant,
--    which is exactly what this function hands to anyone anyway.
--
-- 3. Opening a branch and filing a package request are owner/admin actions.
--    create_branch accepted the manager role, although the capability matrix gives brand.edit
--    to owner and admin only and the sidebar hides Brand & branches from managers, so a
--    manager who typed the URL could spend the owner's paid seats. It now asks
--    private.staff_has_capability(branch, 'brand.edit') on any branch of the restaurant — the
--    shape the staff_roster_read policy already uses — which also admits platform admins, who
--    hold the owner capability set everywhere else.
--
--    request_package_change accepted any member of the restaurant, a cashier included, and a
--    pending request locks the owner's own plan page until the platform acts on it. It now
--    takes the owner (private.user_owns_restaurant, which includes platform admins) or an
--    active admin. billing.manage alone is owner-only in the matrix, but the admin is the
--    owner's deputy and is the one who sees the plan page when a store lapses, so the plan page
--    lets an admin build a package; refusing that request here would strand it.
--
-- 4. New RPC copy_branch_setup(source, target, copy_menu, copy_hours, copy_settings).
--    A new branch started from nothing: an empty menu, no opening hours — which the storefront
--    reads as open 24/7 — and default payment settings. The only copy tool,
--    broadcast_franchise_menu, needs a franchise group and copies neither option groups nor
--    hours. This copies, within one restaurant: categories, items and their option groups;
--    the weekly opening hours; and the payment, delivery, tip and service-fee settings together
--    with the delivery-hour windows those settings switch on. It refuses a menu copy into a
--    branch that already has a menu (target_menu_not_empty) rather than duplicating every dish.
--    Map pin, address, colours, closures, table QR codes and stock counts are never copied.
--
-- 5. New RPC get_latest_billing_decision(restaurant_id).
--    The plan page loaded only the PENDING request (get_pending_billing_request), so after a
--    rejection the merchant's banner simply vanished and the platform owner's decision note
--    never reached them. billing_requests keeps RLS on with no policy and no table grant; this
--    returns the newest approved or rejected row, the same way the pending one is returned, to
--    the same people request_package_change accepts: the owner (platform admins included) or
--    an active admin, since the note answers their request.
--
-- 6. New RPC set_staff_branch_scope(staff_id, branch_id).
--    Each staff row holds one branch_id, invite-staff answers 409 already_active for an existing
--    member, and nothing could change the scope afterwards, so a cashier invited to "This
--    branch only" could never work at a second branch short of being made restaurant-wide.
--    This moves a member between one branch and every branch (null). The owner row is fixed
--    (the owner reaches every branch through the restaurant), only the owner may move an
--    admin, the branch must belong to the same restaurant, and the caller needs staff.manage
--    on both the old and the new scope, so a branch-scoped admin cannot hand out "every
--    branch" they do not hold themselves. Each change writes an audit_logs row.
--
-- 7. private.user_branch_ids(): checked; one arm added.
--    The live helper already returns every branch of a restaurant whose owner_user_id is the
--    caller, so the founding owner — whose staff row create_restaurant_with_branch ties to the
--    FIRST branch — does see the second branch's orders under the orders_staff policy. What it
--    missed is an active staff row with role owner, tied to one branch, for someone who is not
--    owner_user_id: private.user_owns_restaurant treats that person as owner of the whole
--    restaurant, yet RLS showed them only their one branch, so a second branch's orders looked
--    empty. Owner staff rows now reach every branch of their restaurant. Its EXECUTE grants
--    (anon and authenticated) are left untouched on purpose: RLS policies evaluated for either
--    role call it, and revoking anon would turn those reads into permission errors.
--
-- 8. set_restaurant_suspended: Restore gives back what Suspend hid, and only that.
--    It was one statement, is_active = not p_suspended, on every branch. Restore therefore also
--    switched on branches the MERCHANT had hidden, and once item 1 made reactivation need a free
--    seat, Restore would fail outright for any store whose hidden branches exceed its seats, or
--    that has no package at all (item 2's extra restaurants hold 0 seats). Suspend now records the
--    branches that were open in private.platform_suspension_snapshots, a private-schema table no
--    client can reach, and Restore reactivates exactly those. They already fitted the seat count
--    when they were hidden, so Restore sets a transaction-local favornoms.restoring_restaurant_id
--    around that one update and enforce_branch_limit lets it through, the same shape as the
--    founding-branch exemption. A store suspended before this migration has no snapshot and falls
--    back to the old reactivate-everything behaviour.
--
-- 9. Two small closings.
--    create_restaurant_with_branch takes a per-account advisory lock before deciding whether this
--    is the account's first restaurant, so two Launch presses in the same instant cannot both be
--    handed a trial. copy_branch_setup with nothing ticked returns zeros before looking anything
--    up, so it cannot be used to ask whether two branch ids belong to the same restaurant.

begin;

-- ---------------------------------------------------------------------------------------------
-- 7. private.user_branch_ids
-- ---------------------------------------------------------------------------------------------
create or replace function private.user_branch_ids()
 returns setof uuid
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  SELECT sm.branch_id
  FROM public.staff_members sm
  WHERE sm.user_id = auth.uid()
    AND sm.status = 'active'
    AND sm.branch_id IS NOT NULL
  UNION
  SELECT b.id
  FROM public.staff_members sm
  JOIN public.branches b ON b.restaurant_id = sm.restaurant_id
  WHERE sm.user_id = auth.uid()
    AND sm.status = 'active'
    AND sm.branch_id IS NULL
  UNION
  SELECT b.id
  FROM public.restaurants r
  JOIN public.branches b ON b.restaurant_id = r.id
  WHERE r.owner_user_id = auth.uid()
  UNION
  -- An owner staff row tied to one branch still owns the whole restaurant, as
  -- private.user_owns_restaurant already says; without this arm that owner's second
  -- branch showed no orders.
  SELECT b.id
  FROM public.staff_members sm
  JOIN public.branches b ON b.restaurant_id = sm.restaurant_id
  WHERE sm.user_id = auth.uid()
    AND sm.status = 'active'
    AND sm.role = 'owner'
  UNION
  SELECT b.id
  FROM public.branches b
  WHERE private.user_is_platform_admin();
$function$;

-- ---------------------------------------------------------------------------------------------
-- 1. Seat counts: active branches only
-- ---------------------------------------------------------------------------------------------
create or replace function private.entitlements_json(p_restaurant_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'restaurant_id',    p_restaurant_id,
    'plan_code',        coalesce(be.plan_code, 'none'),
    'status',           coalesce(be.status, 'none'),
    'entitled',         coalesce(be.entitled_through is not null and be.entitled_through > now(), false),
    'entitled_through', be.entitled_through,
    'trial_ends_at',    be.trial_ends_at,
    'branch_seats',     coalesce(be.branch_seats, 0),
    -- A hidden branch holds no seat, so it must not block lowering the seat count.
    'branches_used',    (select count(*) from public.branches b where b.restaurant_id = p_restaurant_id and b.is_active),
    'monthly_total',    coalesce(be.monthly_total, 0),
    'features',         coalesce(be.features, '{}'::jsonb),
    'addons',           to_jsonb(coalesce(be.addons, '{}'::text[]))
  )
  from (select 1) one
  left join public.billing_entitlements be on be.restaurant_id = p_restaurant_id;
$function$;

create or replace function public.check_plan_limit(p_restaurant_id uuid, p_limit_key text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_entitled boolean := private.restaurant_entitled(p_restaurant_id);
  v_seats    integer := 0;
  v_used     bigint  := 0;
  v_plan     text    := 'none';
begin
  select coalesce(be.branch_seats, 0), coalesce(be.plan_code, 'none')
    into v_seats, v_plan
    from public.billing_entitlements be where be.restaurant_id = p_restaurant_id;

  if p_limit_key = 'branches' then
    select count(*) into v_used from public.branches where restaurant_id = p_restaurant_id and is_active;
    return jsonb_build_object(
      'allowed', v_entitled and v_used < coalesce(v_seats, 0),
      'limit', coalesce(v_seats, 0), 'current', v_used, 'plan', v_plan, 'entitled', v_entitled);
  elsif p_limit_key in ('items', 'orders_per_month') then
    -- Uncapped by design; only the entitlement deadline applies.
    return jsonb_build_object('allowed', v_entitled, 'limit', -1, 'current', null,
                              'plan', v_plan, 'entitled', v_entitled);
  end if;

  -- Unknown key -> deny. This used to return allowed:true, silently passing anything.
  return jsonb_build_object('allowed', false, 'limit', 0, 'current', 0,
                            'plan', v_plan, 'entitled', v_entitled, 'reason', 'unknown_limit_key');
end $function$;

create or replace function private.billing_apply_selection(p_restaurant_id uuid, p_plan_code text, p_addons text[], p_branch_seats integer, p_status text DEFAULT 'active'::text, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_trial_ends_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
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
  v_addon         text;
  v_used          integer;
  v_keep          text[];
begin
  if p_restaurant_id is null then raise exception 'restaurant_required'; end if;

  select * into v_plan from public.billing_products where code = p_plan_code and kind = 'plan';
  if not found then raise exception 'unknown_plan:%', p_plan_code; end if;

  select * into v_seat from public.billing_products where code = 'extra_branch';

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
    values (v_sub_id, v_seat.code, v_extra, v_seat.monthly_price)
    on conflict (subscription_id, product_code) do update set
      quantity = excluded.quantity, unit_price = excluded.unit_price, updated_at = now();
  end if;

  foreach v_addon in array coalesce(p_addons, '{}'::text[]) loop
    if exists (select 1 from public.billing_products where code = v_addon and kind = 'addon') then
      v_keep := v_keep || v_addon;
      insert into public.subscription_items (subscription_id, product_code, quantity, unit_price)
      select v_sub_id, code, 1, monthly_price from public.billing_products where code = v_addon
      on conflict (subscription_id, product_code) do update set
        quantity = 1, unit_price = excluded.unit_price, updated_at = now();
    end if;
  end loop;

  -- Downgrades must leave zero orphan line items.
  delete from public.subscription_items
   where subscription_id = v_sub_id and product_code <> all (v_keep);

  perform private.billing_compute(p_restaurant_id);
  return private.entitlements_json(p_restaurant_id);
end $function$;

create or replace function public.platform_financial_summary()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v jsonb;
begin
  if not private.user_is_platform_admin() then raise exception 'not_platform_admin'; end if;
  select jsonb_build_object(
    'mrr', coalesce((select sum(be.monthly_total) from public.billing_entitlements be
                      where be.status in ('active','past_due')), 0),
    'arr', coalesce((select sum(be.monthly_total) * 12 from public.billing_entitlements be
                      where be.status in ('active','past_due')), 0),
    'trial_pipeline_mrr', coalesce((
      select sum(bp.monthly_price) from public.billing_entitlements be
      cross join lateral (select monthly_price from public.billing_products where code = 'base') bp
      where be.status = 'trialing'), 0),
    'active_subs',    (select count(*) from public.billing_entitlements where status = 'active'),
    'trialing_subs',  (select count(*) from public.billing_entitlements where status = 'trialing'),
    'past_due_subs',  (select count(*) from public.billing_entitlements where status = 'past_due'),
    'cancelled_subs', (select count(*) from public.billing_entitlements where status = 'cancelled'),
    'expired_subs',   (select count(*) from public.billing_entitlements where status = 'expired'),
    'total_restaurants',  (select count(*) from public.restaurants),
    'paying_restaurants', (select count(*) from public.billing_entitlements
                            where status in ('active','past_due') and monthly_total > 0),
    'entitled_restaurants', (select count(*) from public.billing_entitlements
                              where entitled_through is not null and entitled_through > now()),
    'branch_seats_sold', coalesce((select sum(branch_seats) from public.billing_entitlements
                                    where status in ('active','past_due')), 0),
    -- Seats are held by active branches only; a hidden branch is not "over seats".
    'branches_used',     (select count(*) from public.branches where is_active),
    'by_plan', (
      select coalesce(jsonb_agg(jsonb_build_object('plan_code', plan_code, 'count', c, 'mrr', round(m,2)) order by m desc), '[]'::jsonb)
      from (
        select plan_code, count(*) c, sum(monthly_total) m
        from public.billing_entitlements
        where status in ('active','trialing','past_due')
        group by plan_code
      ) t
    ),
    'by_addon', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'count', c, 'mrr', round(m,2)) order by m desc), '[]'::jsonb)
      from (
        select bp.code, bp.name, count(*) c, sum(si.unit_price * si.quantity) m
        from public.subscription_items si
        join public.billing_products bp on bp.code = si.product_code
        join public.subscriptions s on s.id = si.subscription_id
        where bp.kind in ('addon','seat') and s.status in ('active','past_due')
        group by bp.code, bp.name
      ) t
    ),
    'pending_requests', (select count(*) from public.billing_requests where status = 'pending'),
    'driver_payouts_accrued', coalesce((select sum(total) from public.driver_earnings_ledger where status = 'accrued'), 0),
    'driver_payouts_paid',    coalesce((select sum(total) from public.driver_earnings_ledger where status = 'paid'), 0),
    'orders_last_30d', (select count(*) from public.orders where created_at >= now() - interval '30 days'),
    'gmv_last_30d',    coalesce((select sum(total) from public.orders where status = 'completed' and created_at >= now() - interval '30 days'), 0),
    'restaurants', (
      select coalesce(jsonb_agg(row order by (row->>'mrr')::numeric desc nulls last), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'restaurant_id', r.id,
          'name', r.name, 'slug', r.slug,
          'plan', coalesce(be.plan_code, 'none'),
          'status', coalesce(be.status, 'none'),
          'mrr', coalesce(be.monthly_total, 0),
          'addons', to_jsonb(coalesce(be.addons, '{}'::text[])),
          'branch_seats', coalesce(be.branch_seats, 0),
          'branches_used', (select count(*) from public.branches b where b.restaurant_id = r.id and b.is_active),
          'entitled', coalesce(be.entitled_through is not null and be.entitled_through > now(), false),
          'entitled_through', be.entitled_through,
          'trial_ends_at', be.trial_ends_at,
          'created_at', r.created_at
        ) as row
        from public.restaurants r
        left join public.billing_entitlements be on be.restaurant_id = r.id
        order by coalesce(be.monthly_total, 0) desc
        limit 200
      ) t
    )
  ) into v;
  return v;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 1 + 2. enforce_branch_limit: active seats, reactivation, and the founding-branch exemption
-- ---------------------------------------------------------------------------------------------
create or replace function public.enforce_branch_limit()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_seats      integer := 0;
  v_used       integer := 0;
  v_check_paid boolean;
begin
  -- Platform Restore gives back the branches its Suspend hid. They fitted the seat count when
  -- they were hidden, and set_restaurant_suspended sets this transaction-local value around
  -- exactly that update; item 8 in the header explains why nothing else can use it.
  if tg_op = 'UPDATE'
     and old.restaurant_id = new.restaurant_id
     and coalesce(current_setting('favornoms.restoring_restaurant_id', true), '') = new.restaurant_id::text then
    return new;
  end if;

  -- The founding branch of a restaurant that create_restaurant_with_branch has just created
  -- without a trial. That function sets this transaction-local value to the new restaurant's
  -- id around its one branch insert and clears it straight after; the migration that added
  -- this explains why nothing else can use it.
  if tg_op = 'INSERT'
     and coalesce(current_setting('favornoms.founding_restaurant_id', true), '') = new.restaurant_id::text
     and not exists (select 1 from public.branches b where b.restaurant_id = new.restaurant_id) then
    return new;
  end if;

  -- Switching a hidden branch back on sells nothing, so it needs a seat but not a paid-up
  -- restaurant; demanding both would stop the platform restoring a suspended, lapsed store.
  -- Inserting a branch or moving one to another restaurant needs both.
  if tg_op = 'INSERT' then
    v_check_paid := true;
  else
    v_check_paid := old.restaurant_id is distinct from new.restaurant_id;
  end if;

  if v_check_paid and not private.restaurant_entitled(new.restaurant_id) then
    raise exception 'billing_inactive:branches' using errcode = 'P0001';
  end if;

  -- A hidden branch holds no seat.
  if not new.is_active then
    return new;
  end if;

  select coalesce(be.branch_seats, 0) into v_seats
    from public.billing_entitlements be where be.restaurant_id = new.restaurant_id;

  select count(*) into v_used
    from public.branches b
   where b.restaurant_id = new.restaurant_id
     and b.is_active
     and (tg_op = 'INSERT' or b.id <> new.id);

  if v_used >= coalesce(v_seats, 0) then
    -- Wire format consumed by describePlanError() in packages/database/src/queries/plan.ts
    raise exception 'plan_limit_exceeded:branches:%/%', v_used, coalesce(v_seats, 0)
      using errcode = 'P0001';
  end if;
  return new;
end $function$;

-- Without this, hide A -> create B -> un-hide A runs two storefronts on one seat. The WHEN
-- keeps it off every ordinary Save changes, which rewrites is_active with the same value.
drop trigger if exists branches_enforce_plan_limit_reactivate on public.branches;
create trigger branches_enforce_plan_limit_reactivate
  before update of is_active on public.branches
  for each row
  when (not old.is_active and new.is_active)
  execute function public.enforce_branch_limit();

-- ---------------------------------------------------------------------------------------------
-- 1 + 3. create_branch: brand.edit only, active seats
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_branch(p_restaurant_id uuid, p_name text, p_slug text, p_address text DEFAULT NULL::text, p_timezone text DEFAULT 'America/New_York'::text, p_brand_id uuid DEFAULT NULL::uuid, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_branch_id uuid;
  v_can boolean;
  v_seats integer := 0;
  v_used integer := 0;
  v_geo geography(Point, 4326);
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_slug), '') = '' then
    raise exception 'name_and_slug_required';
  end if;

  -- A new branch spends a paid seat, so it follows brand.edit (owner and admin in the
  -- capability matrix). Managers used to pass here by typing the URL.
  select exists (
    select 1 from public.restaurants r
     where r.id = p_restaurant_id and r.owner_user_id = v_uid
    union
    select 1 from public.branches b
     where b.restaurant_id = p_restaurant_id
       and private.staff_has_capability(b.id, 'brand.edit')
  ) into v_can;
  if not v_can then raise exception 'not_authorized'; end if;

  if p_brand_id is not null and not exists (
     select 1 from public.brands b where b.id = p_brand_id and b.restaurant_id = p_restaurant_id
  ) then
    raise exception 'invalid_brand';
  end if;

  if (p_lat is null) <> (p_lng is null) then
    raise exception 'invalid_location'
      using hint = 'Latitude and longitude must be supplied together.';
  end if;
  if p_lat is not null then
    if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180
       or (abs(p_lat) < 0.0001 and abs(p_lng) < 0.0001) then
      raise exception 'invalid_location' using hint = 'Drop the pin on the store.';
    end if;
    -- longitude first
    v_geo := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lng, p_lat), 4326)::geography;
  end if;

  if not private.restaurant_entitled(p_restaurant_id) then
    raise exception 'billing_inactive:branches' using errcode = 'P0001';
  end if;

  select coalesce(be.branch_seats, 0) into v_seats
    from public.billing_entitlements be where be.restaurant_id = p_restaurant_id;
  select count(*) into v_used from public.branches where restaurant_id = p_restaurant_id and is_active;

  if v_used >= coalesce(v_seats, 0) then
    raise exception 'plan_limit_exceeded:branches:%/%', v_used, coalesce(v_seats, 0)
      using errcode = 'P0001';
  end if;

  insert into public.branches (restaurant_id, slug, name, address, timezone, brand_id, is_active, geo_location)
  values (p_restaurant_id, lower(p_slug), p_name, nullif(btrim(p_address), ''), p_timezone, p_brand_id, true, v_geo)
  returning id into v_branch_id;

  -- Keep the reporting mirror honest.
  update public.subscriptions
     set branch_count = greatest(branch_count, (select count(*) from public.branches where restaurant_id = p_restaurant_id and is_active))
   where restaurant_id = p_restaurant_id;

  return jsonb_build_object('branch_id', v_branch_id, 'slug', lower(p_slug));
end
$function$;

-- ---------------------------------------------------------------------------------------------
-- 2. create_restaurant_with_branch: one trial per account
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_restaurant_with_branch(p_restaurant_name text, p_restaurant_slug text, p_branch_name text, p_branch_slug text, p_branch_address text DEFAULT NULL::text, p_timezone text DEFAULT 'America/New_York'::text, p_theme jsonb DEFAULT '{}'::jsonb, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
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
    -- Pro Start-up: 14 days, all features, 1 branch, no card.
    perform private.billing_apply_selection(
      v_restaurant_id, 'trial', '{}'::text[], 1, 'trialing', null, null, null);
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

-- ---------------------------------------------------------------------------------------------
-- 3. request_package_change: owner or admin
-- ---------------------------------------------------------------------------------------------
create or replace function public.request_package_change(p_restaurant_id uuid, p_plan_code text, p_addons text[] DEFAULT '{}'::text[], p_branch_seats integer DEFAULT 1, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_total numeric(10,2) := 0;
  v_plan  public.billing_products%rowtype;
  v_seats integer := greatest(coalesce(p_branch_seats, 1), 1);
  v_id    uuid;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  -- The owner (platform admins included) or their admin. Any member used to pass, and a
  -- cashier's request then locked the owner's own plan page until the platform acted on it.
  if not private.user_owns_restaurant(p_restaurant_id)
     and not exists (
       select 1 from public.staff_members sm
        where sm.restaurant_id = p_restaurant_id
          and sm.user_id = auth.uid()
          and sm.status = 'active'
          and sm.role = 'admin'
     ) then
    raise exception 'forbidden';
  end if;

  select * into v_plan from public.billing_products where code = p_plan_code and kind = 'plan' and is_active;
  if not found then raise exception 'unknown_plan:%', p_plan_code; end if;

  -- The trial is granted once at signup, never sold.
  if coalesce(v_plan.trial_days, 0) > 0 then
    raise exception 'plan_not_purchasable:%', p_plan_code;
  end if;

  select v_plan.monthly_price
       + greatest(v_seats - coalesce(v_plan.included_seats, 0), 0)
         * coalesce((select monthly_price from public.billing_products where code = 'extra_branch'), 0)
       + coalesce((select sum(monthly_price) from public.billing_products
                   where kind = 'addon' and code = any (coalesce(p_addons, '{}'::text[]))), 0)
  into v_total;

  update public.billing_requests
     set status = 'cancelled', updated_at = now()
   where restaurant_id = p_restaurant_id and status = 'pending';

  insert into public.billing_requests
    (restaurant_id, requested_by, plan_code, addons, branch_seats, monthly_total, note)
  values
    (p_restaurant_id, auth.uid(), v_plan.code, coalesce(p_addons, '{}'::text[]), v_seats, v_total, p_note)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'request_id', v_id, 'monthly_total', v_total);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 5. get_latest_billing_decision
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_latest_billing_decision(p_restaurant_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  -- Whoever may file a request may read the answer to it; a cashier may do neither.
  if not private.user_owns_restaurant(p_restaurant_id)
     and not exists (
       select 1 from public.staff_members sm
        where sm.restaurant_id = p_restaurant_id
          and sm.user_id = auth.uid()
          and sm.status = 'active'
          and sm.role = 'admin'
     ) then
    raise exception 'forbidden';
  end if;
  return (
    select to_jsonb(br) from public.billing_requests br
     where br.restaurant_id = p_restaurant_id and br.status in ('approved', 'rejected')
     order by coalesce(br.decided_at, br.updated_at, br.created_at) desc
     limit 1
  );
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 4. copy_branch_setup
-- ---------------------------------------------------------------------------------------------
create or replace function public.copy_branch_setup(p_source_branch_id uuid, p_target_branch_id uuid, p_copy_menu boolean, p_copy_hours boolean, p_copy_settings boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  -- The payment, delivery, tip and service-fee settings the Branch settings cards edit, plus
  -- the QR transfer details a copied "transfer" method needs (place-order refuses transfer
  -- with no QR) and the currency the copied prices are written in. Deliberately absent: the
  -- storefront look, the pause/busy switches (live kitchen state) and the rider dispatch
  -- tuning the platform sets.
  v_setting_keys constant text[] := array[
    'currency', 'payment_methods', 'qr_transfer', 'tip_config', 'service_fee_percent',
    'delivery_mode', 'delivery_hours_enabled', 'delivery_base_fee', 'delivery_per_km_fee',
    'delivery_min_fee', 'delivery_max_fee', 'delivery_radius_km', 'delivery_surge_from_mi',
    'delivery_surge_multiplier', 'batch_enabled', 'batch_max_detour_mi', 'batch_max_dropoff_mi'
  ];
  v_source public.branches%rowtype;
  v_target public.branches%rowtype;
  v_cat_map jsonb;
  v_item_map jsonb;
  v_group_map jsonb;
  v_settings jsonb;
  v_categories int := 0;
  v_items int := 0;
  v_groups int := 0;
  v_hours int := 0;
  v_settings_copied boolean := false;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  if p_source_branch_id is null or p_target_branch_id is null then raise exception 'branch_required'; end if;
  -- Nothing ticked means nothing to authorise, so answer before the lookups below could tell a
  -- caller whether two branch ids share a restaurant.
  if not (coalesce(p_copy_menu, false) or coalesce(p_copy_hours, false) or coalesce(p_copy_settings, false)) then
    return jsonb_build_object('categories_copied', 0, 'items_copied', 0, 'modifier_groups_copied', 0,
                              'hours_copied', 0, 'settings_copied', false);
  end if;
  if p_source_branch_id = p_target_branch_id then raise exception 'same_branch'; end if;

  select * into v_source from public.branches where id = p_source_branch_id;
  if not found then raise exception 'source_not_found'; end if;
  -- Locked so two retries of the same copy cannot both find the target menu empty.
  select * into v_target from public.branches where id = p_target_branch_id for update;
  if not found then raise exception 'target_not_found'; end if;
  if v_source.restaurant_id <> v_target.restaurant_id then raise exception 'different_restaurant'; end if;

  if coalesce(p_copy_menu, false) then
    if not (private.staff_has_capability(p_source_branch_id, 'menu.manage')
            and private.staff_has_capability(p_target_branch_id, 'menu.manage')) then
      raise exception 'not_authorized';
    end if;
    -- Copying into a branch that already has a menu would duplicate every dish and group.
    if exists (select 1 from public.menu_items where branch_id = p_target_branch_id)
       or exists (select 1 from public.menu_categories where branch_id = p_target_branch_id)
       or exists (select 1 from public.modifier_groups where branch_id = p_target_branch_id) then
      raise exception 'target_menu_not_empty';
    end if;
  end if;

  if (coalesce(p_copy_hours, false) or coalesce(p_copy_settings, false))
     and not (private.staff_has_capability(p_source_branch_id, 'branch.settings')
              and private.staff_has_capability(p_target_branch_id, 'branch.settings')) then
    raise exception 'not_authorized';
  end if;

  if coalesce(p_copy_menu, false) then
    -- Fresh ids are minted up front so every child row can point at its copied parent.
    select coalesce(jsonb_object_agg(c.id::text, gen_random_uuid()), '{}'::jsonb) into v_cat_map
      from public.menu_categories c where c.branch_id = p_source_branch_id;
    select coalesce(jsonb_object_agg(i.id::text, gen_random_uuid()), '{}'::jsonb) into v_item_map
      from public.menu_items i where i.branch_id = p_source_branch_id;
    select coalesce(jsonb_object_agg(g.id::text, gen_random_uuid()), '{}'::jsonb) into v_group_map
      from public.modifier_groups g where g.branch_id = p_source_branch_id;

    insert into public.menu_categories (
      id, branch_id, name, name_translations, description, icon_emoji, display_order, is_active, available_hours
    )
    select (v_cat_map ->> c.id::text)::uuid, p_target_branch_id, c.name, c.name_translations, c.description,
           c.icon_emoji, c.display_order, c.is_active, c.available_hours
      from public.menu_categories c
     where c.branch_id = p_source_branch_id;
    get diagnostics v_categories = row_count;

    -- Stock counts, sold-out-until and ratings are the source kitchen's live state, not menu.
    insert into public.menu_items (
      id, branch_id, category_id, name, name_translations, description, description_translations,
      price, cost, image_url, image_urls, is_active, is_recommended, is_new, available_channels,
      track_stock, low_stock_threshold, allergens, dietary_tags, prep_time_minutes, calories,
      display_order, layout_config, slug, station, availability_schedule, requires_age_verification
    )
    select (v_item_map ->> i.id::text)::uuid, p_target_branch_id, (v_cat_map ->> i.category_id::text)::uuid,
           i.name, i.name_translations, i.description, i.description_translations,
           i.price, i.cost, i.image_url, i.image_urls, i.is_active, i.is_recommended, i.is_new, i.available_channels,
           i.track_stock, i.low_stock_threshold, i.allergens, i.dietary_tags, i.prep_time_minutes, i.calories,
           i.display_order, i.layout_config, i.slug, i.station, i.availability_schedule, i.requires_age_verification
      from public.menu_items i
     where i.branch_id = p_source_branch_id;
    get diagnostics v_items = row_count;

    insert into public.modifier_groups (
      id, branch_id, name, name_translations, selection_type, is_required, min_select, max_select, display_order
    )
    select (v_group_map ->> g.id::text)::uuid, p_target_branch_id, g.name, g.name_translations, g.selection_type,
           g.is_required, g.min_select, g.max_select, g.display_order
      from public.modifier_groups g
     where g.branch_id = p_source_branch_id;
    get diagnostics v_groups = row_count;

    insert into public.modifier_options (group_id, name, name_translations, price_delta, is_default, is_active, display_order)
    select (v_group_map ->> o.group_id::text)::uuid, o.name, o.name_translations, o.price_delta,
           o.is_default, o.is_active, o.display_order
      from public.modifier_options o
      join public.modifier_groups g on g.id = o.group_id
     where g.branch_id = p_source_branch_id;

    -- A link to another branch's group has no copy to point at, so it is left behind.
    insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order)
    select (v_item_map ->> m.menu_item_id::text)::uuid, (v_group_map ->> m.modifier_group_id::text)::uuid, m.display_order
      from public.menu_item_modifiers m
      join public.menu_items i on i.id = m.menu_item_id
     where i.branch_id = p_source_branch_id
       and v_group_map ? m.modifier_group_id::text;
  end if;

  if coalesce(p_copy_hours, false) then
    -- Replaced, not merged, like set_branch_hours: copying hours means "open when that branch is".
    delete from public.branch_hours where branch_id = p_target_branch_id;
    insert into public.branch_hours (branch_id, day_of_week, opens_at, closes_at)
    select p_target_branch_id, h.day_of_week, h.opens_at, h.closes_at
      from public.branch_hours h
     where h.branch_id = p_source_branch_id;
    get diagnostics v_hours = row_count;
  end if;

  if coalesce(p_copy_settings, false) then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_settings
      from jsonb_each(coalesce(v_source.settings, '{}'::jsonb)) e
     where e.key = any (v_setting_keys);

    if v_settings <> '{}'::jsonb then
      update public.branches
         set settings = coalesce(settings, '{}'::jsonb) || v_settings
       where id = p_target_branch_id;
      v_settings_copied := true;
    end if;

    -- delivery_hours_enabled copied without its windows would close delivery all week.
    delete from public.branch_delivery_hours where branch_id = p_target_branch_id;
    insert into public.branch_delivery_hours (branch_id, day_of_week, opens_at, closes_at)
    select p_target_branch_id, h.day_of_week, h.opens_at, h.closes_at
      from public.branch_delivery_hours h
     where h.branch_id = p_source_branch_id;
  end if;

  return jsonb_build_object(
    'categories_copied', v_categories,
    'items_copied', v_items,
    'modifier_groups_copied', v_groups,
    'hours_copied', v_hours,
    'settings_copied', v_settings_copied
  );
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 6. set_staff_branch_scope
-- ---------------------------------------------------------------------------------------------
create or replace function public.set_staff_branch_scope(p_staff_id uuid, p_branch_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.staff_members%rowtype;
  v_restaurant_wide boolean;
begin
  if v_uid is null then raise exception 'auth_required'; end if;

  select * into v_row from public.staff_members where id = p_staff_id;
  if not found then raise exception 'staff_not_found'; end if;

  -- The owner reaches every branch through the restaurant itself; the branch on their row is
  -- just where they signed up, not a scope anyone should edit.
  if v_row.role = 'owner' then raise exception 'owner_scope_fixed'; end if;

  if p_branch_id is not null and not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.restaurant_id = v_row.restaurant_id
  ) then
    raise exception 'invalid_branch';
  end if;

  -- "Every branch" may only be handed out, or taken away, by someone who holds staff.manage
  -- across the whole restaurant; otherwise a branch-scoped admin could widen anyone, themselves
  -- included.
  v_restaurant_wide := private.user_owns_restaurant(v_row.restaurant_id)
    or exists (
      select 1 from public.staff_members sm
      join public.role_capabilities rc on rc.role = sm.role::text and rc.capability = 'staff.manage'
      where sm.restaurant_id = v_row.restaurant_id
        and sm.user_id = v_uid
        and sm.status = 'active'
        and sm.branch_id is null
    );

  if not (
    (case when v_row.branch_id is null then v_restaurant_wide
          else private.staff_has_capability(v_row.branch_id, 'staff.manage') end)
    and
    (case when p_branch_id is null then v_restaurant_wide
          else private.staff_has_capability(p_branch_id, 'staff.manage') end)
  ) then
    raise exception 'not_authorized';
  end if;

  -- Only the owner may move an admin, as only the owner may add one (invite-staff).
  if v_row.role = 'admin' and not private.user_owns_restaurant(v_row.restaurant_id) then
    raise exception 'not_authorized';
  end if;

  if v_row.branch_id is not distinct from p_branch_id then
    return jsonb_build_object('ok', true, 'staff_id', v_row.id, 'branch_id', p_branch_id, 'changed', false);
  end if;

  update public.staff_members set branch_id = p_branch_id where id = v_row.id;

  insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_row.restaurant_id, coalesce(p_branch_id, v_row.branch_id), v_uid, 'staff', 'staff_branch_scope_changed',
          'staff_member', v_row.id,
          jsonb_build_object('role', v_row.role, 'from_branch_id', v_row.branch_id, 'to_branch_id', p_branch_id));

  return jsonb_build_object('ok', true, 'staff_id', v_row.id, 'branch_id', p_branch_id, 'changed', true);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 8. set_restaurant_suspended: restore exactly what the suspension hid
-- ---------------------------------------------------------------------------------------------
create table if not exists private.platform_suspension_snapshots (
  restaurant_id     uuid primary key references public.restaurants(id) on delete cascade,
  active_branch_ids uuid[] not null,
  suspended_at      timestamptz not null default now(),
  suspended_by      uuid
);
revoke all on table private.platform_suspension_snapshots from public, anon, authenticated;

create or replace function public.set_restaurant_suspended(p_restaurant_id uuid, p_suspended boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ids uuid[];
begin
  if not private.user_is_platform_admin() then
    raise exception 'not_platform_admin';
  end if;

  if p_suspended then
    -- Remember which branches were open. A second Suspend keeps the first snapshot, because by
    -- then every branch is already hidden and a new one would record nothing.
    insert into private.platform_suspension_snapshots (restaurant_id, active_branch_ids, suspended_by)
    select p_restaurant_id, coalesce(array_agg(b.id), '{}'::uuid[]), auth.uid()
      from public.branches b
     where b.restaurant_id = p_restaurant_id and b.is_active
    on conflict (restaurant_id) do nothing;

    update public.branches set is_active = false
     where restaurant_id = p_restaurant_id and is_active;
    return;
  end if;

  select s.active_branch_ids into v_ids
    from private.platform_suspension_snapshots s where s.restaurant_id = p_restaurant_id;
  if not found then
    -- Suspended before snapshots existed: nothing says which branches the merchant had hidden,
    -- so keep the old reactivate-everything behaviour.
    select coalesce(array_agg(b.id), '{}'::uuid[]) into v_ids
      from public.branches b where b.restaurant_id = p_restaurant_id;
  end if;

  perform set_config('favornoms.restoring_restaurant_id', p_restaurant_id::text, true);
  update public.branches set is_active = true
   where restaurant_id = p_restaurant_id and id = any (v_ids) and not is_active;
  perform set_config('favornoms.restoring_restaurant_id', '', true);

  delete from private.platform_suspension_snapshots where restaurant_id = p_restaurant_id;
end $function$;

-- ---------------------------------------------------------------------------------------------
-- Grants. PUBLIC holds EXECUTE on every new function by default and anon inherits it, so
-- revoke from public by name (20260827212000_revoke_public_execute_on_new_functions.sql).
-- private.user_branch_ids keeps its existing grants; see item 7 in the header.
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.create_restaurant_with_branch(text, text, text, text, text, text, jsonb, double precision, double precision) from public, anon;
grant  execute on function public.create_restaurant_with_branch(text, text, text, text, text, text, jsonb, double precision, double precision) to authenticated;

revoke execute on function public.create_branch(uuid, text, text, text, text, uuid, double precision, double precision) from public, anon;
grant  execute on function public.create_branch(uuid, text, text, text, text, uuid, double precision, double precision) to authenticated;

revoke execute on function public.request_package_change(uuid, text, text[], integer, text) from public, anon;
grant  execute on function public.request_package_change(uuid, text, text[], integer, text) to authenticated;

revoke execute on function public.copy_branch_setup(uuid, uuid, boolean, boolean, boolean) from public, anon;
grant  execute on function public.copy_branch_setup(uuid, uuid, boolean, boolean, boolean) to authenticated;

revoke execute on function public.set_staff_branch_scope(uuid, uuid) from public, anon;
grant  execute on function public.set_staff_branch_scope(uuid, uuid) to authenticated;

revoke execute on function public.get_latest_billing_decision(uuid) from public, anon;
grant  execute on function public.get_latest_billing_decision(uuid) to authenticated;

revoke execute on function public.check_plan_limit(uuid, text) from public, anon;
grant  execute on function public.check_plan_limit(uuid, text) to authenticated;

revoke execute on function public.platform_financial_summary() from public, anon;
grant  execute on function public.platform_financial_summary() to authenticated;

revoke execute on function public.set_restaurant_suspended(uuid, boolean) from public, anon;
grant  execute on function public.set_restaurant_suspended(uuid, boolean) to authenticated;

-- Internal only: reached from SECURITY DEFINER functions, never over /rest/v1/rpc.
revoke execute on function private.billing_apply_selection(uuid, text, text[], integer, text, timestamp with time zone, timestamp with time zone, timestamp with time zone) from public, anon, authenticated;
revoke execute on function private.entitlements_json(uuid) from public, anon, authenticated;

-- Trigger functions have no business being RPC endpoints at all.
revoke execute on function public.enforce_branch_limit() from public, anon, authenticated;

commit;
