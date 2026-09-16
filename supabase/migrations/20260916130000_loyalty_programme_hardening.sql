-- Four more holes in the loyalty programme, all confirmed live with rolled-back tests.
--
-- 1. A STALE EDITOR SILENTLY UNDID THE OWNER'S SAVE. The admin card sends the full desired state,
--    and set_loyalty_settings replaced labels/perks/rate/tiers wholesale. A second tab, a second
--    device, or Next's back/forward cache (which remounts the card from the pre-save RSC payload)
--    would send the programme as it was when that page loaded: the Thai names reverted to Gold,
--    the rate and thresholds reverted, every badge was re-graded against the old numbers -- and the
--    function returned normally, so the card said "Saved". The editor now sends the version it
--    loaded; the row is locked and a mismatch raises stale_settings instead of overwriting.
--    restaurants.updated_at cannot be that version: branding and name edits bump it too, so any
--    unrelated save would read as a conflict. The version is an md5 of loyalty_settings itself.
--
-- 2. THE RPC IS NOW THE ONLY WRITE PATH. 20260916110000 stopped non-owners PATCHing the column, but
--    an owner's raw PATCH still skipped validation, the re-grade and (now) the version check. The
--    function raises a transaction-local flag around its own UPDATE and lowers it straight after,
--    and the guard refuses any end-user change to loyalty_settings made without it. Clients cannot
--    raise it themselves: PostgREST exposes neither set_config nor any setting outside request.*. Service-role writers are
--    still exempt, as before.
--
-- 3. POINTS COULD OVERFLOW AND BLOCK ORDER COMPLETION. The award trigger computed
--    floor(subtotal * rate)::int and added it to integer columns. With the rate now up to 100 and
--    currencies like KRW/VND/IDR, one customer's lifetime_earned passes 2^31 after a couple of
--    thousand orders; from then on the AFTER UPDATE trigger raised and staff could never mark that
--    customer's orders completed. Points per order are capped, and the running totals saturate at
--    the integer maximum instead of raising. issue_birthday_rewards gets the same saturation, since
--    one failure there aborts the whole day's birthday run.
--
-- 4. recompute_loyalty_tiers() graded every member row on the platform through two nested SECURITY
--    DEFINER calls per row -- the cost 20260916110000 removed from set_loyalty_settings -- and was
--    still executable by any signed-in user, so a customer could loop it over PostgREST. Only the
--    daily cron (private.run_loyalty_housekeeping, as postgres) needs it: execute is revoked from
--    client roles, and it resolves each restaurant's ladder once and grades inline.

begin;

-- ---------------------------------------------------------------------------------------------
-- 2. Guard: loyalty_settings changes only through set_loyalty_settings().
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

  if private.user_is_platform_admin() or old.owner_user_id = auth.uid() then
    return new;
  end if;
  if new.id                 is distinct from old.id
     or new.owner_user_id      is distinct from old.owner_user_id
     or new.slug               is distinct from old.slug
     or new.custom_domain      is distinct from old.custom_domain
     or new.franchise_group_id is distinct from old.franchise_group_id
     or new.stripe_customer_id is distinct from old.stripe_customer_id
     or new.feature_overrides  is distinct from old.feature_overrides then
    raise exception 'restaurant_privileged_column_denied'
      using hint = 'Only the restaurant owner or a platform admin may change ownership, slug, custom domain, billing or feature-override columns.';
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 1. The version an editor loaded, published with the programme.
-- ---------------------------------------------------------------------------------------------
create or replace function public.loyalty_program(p_branch_id uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'points_per_currency', (s ->> 'points_per_currency')::numeric,
    'scope', r.loyalty_scope,
    -- jsonb text output is canonical (keys sorted, whitespace normalised), so equal settings always
    -- hash equal. Nothing secret: every field it covers is already in this response.
    'version', md5(coalesce(r.loyalty_settings, '{}'::jsonb)::text),
    'tiers', jsonb_build_array(
      jsonb_build_object('key', 'bronze',   'threshold', 0,
                         'label', s -> 'labels' ->> 'bronze',   'perks', s -> 'perks' -> 'bronze'),
      jsonb_build_object('key', 'silver',   'threshold', (s ->> 'silver')::int,
                         'label', s -> 'labels' ->> 'silver',   'perks', s -> 'perks' -> 'silver'),
      jsonb_build_object('key', 'gold',     'threshold', (s ->> 'gold')::int,
                         'label', s -> 'labels' ->> 'gold',     'perks', s -> 'perks' -> 'gold'),
      jsonb_build_object('key', 'platinum', 'threshold', (s ->> 'platinum')::int,
                         'label', s -> 'labels' ->> 'platinum', 'perks', s -> 'perks' -> 'platinum')))
  from public.branches b
  join public.restaurants r on r.id = b.restaurant_id
  cross join lateral public.loyalty_settings_for(r.id) s
  where b.id = p_branch_id;
$function$;

-- The seven-argument version is dropped, as the five-argument one was before it: two overloads of
-- the same name make PostgREST's choice depend on which arguments a client happened to send, and
-- the whole point here is that a client which does not send the version cannot save.
drop function if exists public.set_loyalty_settings(uuid, numeric, integer, integer, integer, jsonb, jsonb);

create or replace function public.set_loyalty_settings(
  p_restaurant_id uuid,
  p_expected_version text,
  p_points_per_currency numeric,
  p_silver integer,
  p_gold integer,
  p_platinum integer,
  p_labels jsonb default null,
  p_perks jsonb default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_rate     numeric := round(coalesce(p_points_per_currency, 1), 2);
  v_keys     text[]  := array['bronze', 'silver', 'gold', 'platinum'];
  v_key      text;
  v_label    text;
  v_perks    jsonb;
  v_labels   jsonb := '{}'::jsonb;
  v_perkset  jsonb := '{}'::jsonb;
  v_current  jsonb;
  v_new      jsonb;
begin
  if not private.user_owns_restaurant(p_restaurant_id) then raise exception 'not_authorized'; end if;
  if v_rate <= 0 or v_rate > 100 then raise exception 'bad_rate:%', v_rate; end if;
  if p_silver is null or p_gold is null or p_platinum is null
     or p_silver < 1 or p_gold <= p_silver or p_platinum <= p_gold or p_platinum > 999999999 then
    raise exception 'bad_tiers:%,%,%', p_silver, p_gold, p_platinum;
  end if;
  if p_labels is not null and jsonb_typeof(p_labels) <> 'object' then raise exception 'bad_labels'; end if;
  if p_perks  is not null and jsonb_typeof(p_perks)  <> 'object' then raise exception 'bad_perks';  end if;

  foreach v_key in array v_keys loop
    if p_labels is not null then
      v_label := nullif(trim(p_labels ->> v_key), '');
      if v_label is not null then
        if length(v_label) > 24 then raise exception 'label_too_long:%', v_key; end if;
        v_labels := v_labels || jsonb_build_object(v_key, v_label);
      end if;
    end if;

    if p_perks is not null and p_perks ? v_key then
      v_perks := p_perks -> v_key;
      if jsonb_typeof(v_perks) <> 'array' then raise exception 'bad_perks:%', v_key; end if;
      if jsonb_array_length(v_perks) > 6 then raise exception 'too_many_perks:%', v_key; end if;
      if exists (select 1 from jsonb_array_elements(v_perks) e where jsonb_typeof(e) <> 'string') then
        raise exception 'bad_perk_line:%', v_key;
      end if;
      if exists (select 1 from jsonb_array_elements(v_perks) e where length(e #>> '{}') > 200) then
        raise exception 'perk_too_long:%', v_key;
      end if;
      v_perkset := v_perkset || jsonb_build_object(v_key, coalesce((
        select jsonb_agg(trim(e #>> '{}'))
          from jsonb_array_elements(v_perks) e
         where nullif(trim(e #>> '{}'), '') is not null), '[]'::jsonb));
    end if;
  end loop;

  -- Locked before comparing, so two saves arriving together cannot both see the old version.
  select coalesce(loyalty_settings, '{}'::jsonb) into v_current
    from public.restaurants where id = p_restaurant_id
     for update;
  if p_expected_version is distinct from md5(v_current::text) then
    raise exception 'stale_settings';
  end if;

  v_new := jsonb_build_object(
    'points_per_currency', v_rate,
    'tiers', jsonb_build_object('silver', p_silver, 'gold', p_gold, 'platinum', p_platinum),
    'labels', case when p_labels is null then coalesce(v_current -> 'labels', '{}'::jsonb) else v_labels end,
    'perks',  case when p_perks  is null then coalesce(v_current -> 'perks',  '{}'::jsonb) else v_perkset end);

  perform set_config('favornoms.loyalty_settings_write', 'on', true);
  update public.restaurants
     set loyalty_settings = v_new,
         updated_at = now()
   where id = p_restaurant_id;
  perform set_config('favornoms.loyalty_settings_write', 'off', true);

  update public.loyalty_points lp
     set tier = (case
                   when lp.lifetime_earned >= p_platinum then 'platinum'
                   when lp.lifetime_earned >= p_gold     then 'gold'
                   when lp.lifetime_earned >= p_silver   then 'silver'
                   else 'bronze'
                 end)::loyalty_tier
   where lp.restaurant_id = p_restaurant_id
     and lp.tier is distinct from (case
                   when lp.lifetime_earned >= p_platinum then 'platinum'
                   when lp.lifetime_earned >= p_gold     then 'gold'
                   when lp.lifetime_earned >= p_silver   then 'silver'
                   else 'bronze'
                 end)::loyalty_tier;

  -- The editor re-seeds from this, so its next save carries the version it just wrote.
  return public.loyalty_settings_for(p_restaurant_id)
         || jsonb_build_object('version', md5(v_new::text));
end $function$;

revoke execute on function public.set_loyalty_settings(uuid, text, numeric, integer, integer, integer, jsonb, jsonb) from public, anon;
grant  execute on function public.set_loyalty_settings(uuid, text, numeric, integer, integer, integer, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Points saturate instead of overflowing.
-- ---------------------------------------------------------------------------------------------
create or replace function public.orders_on_complete_award_loyalty()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  c_max constant bigint := 2147483647;
  v_points int;
  v_balance int;
  v_lifetime int;
  v_tier loyalty_tier;
  v_scope text;
  v_restaurant_id uuid;
  v_txn_id uuid;
  v_rate numeric;
begin
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;
  if new.customer_id is null then
    return new;
  end if;

  select b.restaurant_id, r.loyalty_scope
    into v_restaurant_id, v_scope
    from public.branches b
    join public.restaurants r on r.id = b.restaurant_id
   where b.id = new.branch_id;
  if v_restaurant_id is null then
    return new;
  end if;

  -- Worked out in numeric and capped before the cast: an award that cannot fit must never be the
  -- reason an order cannot be completed.
  v_rate := (public.loyalty_settings_for(v_restaurant_id) ->> 'points_per_currency')::numeric;
  v_points := least(floor(coalesce(new.subtotal, 0) * v_rate), 1000000000)::int;
  if v_points <= 0 then
    return new;
  end if;

  -- Claim first. The partial unique index makes this the single source of
  -- truth for "has this order already paid out?" -- so an order that bounces
  -- completed -> ready -> completed can never be credited twice.
  insert into public.loyalty_transactions(
    branch_id, restaurant_id, customer_id, points, balance_after, type,
    reference_type, reference_id, description
  ) values (
    case when v_scope = 'brand' then null else new.branch_id end,
    v_restaurant_id, new.customer_id, v_points, 0, 'earned', 'order', new.id,
    'Earned from order ' || new.order_number
  )
  on conflict do nothing
  returning id into v_txn_id;

  if v_txn_id is null then
    return new;  -- already awarded for this order
  end if;

  if v_scope = 'brand' then
    insert into public.loyalty_points(restaurant_id, branch_id, customer_id, points_balance, lifetime_earned)
    values (v_restaurant_id, null, new.customer_id, v_points, v_points)
    on conflict (restaurant_id, customer_id) where branch_id is null and restaurant_id is not null do update
      set points_balance  = least(public.loyalty_points.points_balance::bigint  + v_points, c_max)::int,
          lifetime_earned = least(public.loyalty_points.lifetime_earned::bigint + v_points, c_max)::int,
          updated_at = now()
    returning points_balance, lifetime_earned into v_balance, v_lifetime;
  else
    insert into public.loyalty_points(branch_id, customer_id, points_balance, lifetime_earned, restaurant_id)
    values (new.branch_id, new.customer_id, v_points, v_points, v_restaurant_id)
    on conflict (branch_id, customer_id) where branch_id is not null do update
      set points_balance  = least(public.loyalty_points.points_balance::bigint  + v_points, c_max)::int,
          lifetime_earned = least(public.loyalty_points.lifetime_earned::bigint + v_points, c_max)::int,
          updated_at = now()
    returning points_balance, lifetime_earned into v_balance, v_lifetime;
  end if;

  v_tier := public.tier_for_points(v_restaurant_id, v_lifetime)::loyalty_tier;

  if v_scope = 'brand' then
    update public.loyalty_points set tier = v_tier
     where restaurant_id = v_restaurant_id and customer_id = new.customer_id and branch_id is null;
  else
    update public.loyalty_points set tier = v_tier
     where branch_id = new.branch_id and customer_id = new.customer_id;
  end if;

  update public.loyalty_transactions set balance_after = v_balance where id = v_txn_id;

  return new;
end $function$;

create or replace function public.issue_birthday_rewards()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_year int := extract(year from now())::int;
  v_today_md text := to_char(now(), 'MM-DD');
  v_count int;
begin
  with eligible as (
    select c.id as customer_id, c.branch_id from public.customers c
     where c.birthday is not null and to_char(c.birthday, 'MM-DD') = v_today_md
       and not exists (select 1 from public.birthday_rewards br where br.customer_id = c.id and br.year = v_year)
  ),
  inserts as (
    insert into public.birthday_rewards (customer_id, branch_id, year, points)
      select customer_id, branch_id, v_year, 500 from eligible
      returning customer_id, branch_id, points
  ),
  apply as (
    -- Saturates like the award trigger: one balance at the ceiling must not abort everyone's gift.
    update public.loyalty_points lp
       set points_balance = least(lp.points_balance::bigint + i.points, 2147483647)::int, updated_at = now()
      from inserts i
      join public.branches b on b.id = i.branch_id
      join public.restaurants r on r.id = b.restaurant_id
     where lp.customer_id = i.customer_id
       and ( (r.loyalty_scope = 'brand' and lp.restaurant_id = b.restaurant_id and lp.branch_id is null)
          or (r.loyalty_scope <> 'brand' and lp.branch_id = i.branch_id) )
     returning lp.customer_id
  ),
  notify as (
    insert into public.notifications_outbox (channel, recipient_type, recipient_id, template, variables)
      select 'email', 'customer', customer_id, 'birthday_reward', jsonb_build_object('points', points) from inserts
  )
  select count(*) into v_count from inserts;
  return v_count;
end; $function$;

-- ---------------------------------------------------------------------------------------------
-- 4. Nightly re-grade: one ladder lookup per restaurant, and not callable by clients.
-- ---------------------------------------------------------------------------------------------
create or replace function public.recompute_loyalty_tiers()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_count int;
begin
  -- greatest() keeps the ladder monotonic exactly as tier_for_points() does, in case thresholds were
  -- ever stored out of order before validation existed.
  -- materialized: the settings lookup runs once per restaurant, never once per member row, whatever
  -- join order the planner picks.
  with ladder as materialized (
    select r.id as restaurant_id,
           (s ->> 'silver')::int as silver,
           greatest((s ->> 'gold')::int, (s ->> 'silver')::int) as gold,
           greatest((s ->> 'platinum')::int, (s ->> 'gold')::int, (s ->> 'silver')::int) as platinum
      from public.restaurants r
     cross join lateral public.loyalty_settings_for(r.id) s
  )
  update public.loyalty_points lp
     set tier = (case
                   when lp.lifetime_earned >= l.platinum then 'platinum'
                   when lp.lifetime_earned >= l.gold     then 'gold'
                   when lp.lifetime_earned >= l.silver   then 'silver'
                   else 'bronze'
                 end)::loyalty_tier
    from ladder l
   where lp.restaurant_id = l.restaurant_id
     and lp.tier is distinct from (case
                   when lp.lifetime_earned >= l.platinum then 'platinum'
                   when lp.lifetime_earned >= l.gold     then 'gold'
                   when lp.lifetime_earned >= l.silver   then 'silver'
                   else 'bronze'
                 end)::loyalty_tier;
  get diagnostics v_count = row_count;
  return v_count;
end; $function$;

revoke execute on function public.recompute_loyalty_tiers() from public, anon, authenticated;
revoke execute on function public.issue_birthday_rewards() from public, anon, authenticated;

commit;
