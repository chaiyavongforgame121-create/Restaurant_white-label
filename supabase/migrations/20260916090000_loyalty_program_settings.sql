-- The loyalty program becomes the merchant's to set.
--
-- Until now a restaurant could edit the reward catalogue and nothing else: "1 point per $1" was
-- floor(subtotal) inside the award trigger, and Bronze/Silver/Gold/Platinum were 0/10k/30k/100k
-- written into tier_for_lifetime_points, into that same trigger, AND into the customer page. A
-- merchant whose average ticket is $8 needed 1,250 completed orders to reach Silver, with no way
-- to say otherwise.
--
-- restaurants.loyalty_settings now holds { points_per_currency, tiers: { silver, gold, platinum } }.
-- Missing or unreadable values fall back to exactly today's numbers, so nothing changes for a
-- restaurant that never opens the screen.

begin;

alter table public.restaurants
  add column if not exists loyalty_settings jsonb not null default '{}'::jsonb;

-- Resolved settings, defaults filled in. Text is matched against a number pattern before casting:
-- the column is jsonb, and a hand-edited row must not be able to break order completion.
create or replace function public.loyalty_settings_for(p_restaurant_id uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'points_per_currency',
      coalesce((case when (r.loyalty_settings ->> 'points_per_currency') ~ '^[0-9]+(\.[0-9]+)?$'
                     then (r.loyalty_settings ->> 'points_per_currency')::numeric end), 1),
    'silver',
      coalesce((case when (r.loyalty_settings -> 'tiers' ->> 'silver') ~ '^[0-9]+$'
                     then (r.loyalty_settings -> 'tiers' ->> 'silver')::int end), 10000),
    'gold',
      coalesce((case when (r.loyalty_settings -> 'tiers' ->> 'gold') ~ '^[0-9]+$'
                     then (r.loyalty_settings -> 'tiers' ->> 'gold')::int end), 30000),
    'platinum',
      coalesce((case when (r.loyalty_settings -> 'tiers' ->> 'platinum') ~ '^[0-9]+$'
                     then (r.loyalty_settings -> 'tiers' ->> 'platinum')::int end), 100000))
  from public.restaurants r
  where r.id = p_restaurant_id;
$function$;

-- The tier a lifetime total earns AT THIS RESTAURANT. greatest() keeps the ladder monotonic even
-- if thresholds were ever stored out of order.
create or replace function public.tier_for_points(p_restaurant_id uuid, p_points integer)
 returns text
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select case
    when p_points >= greatest((s ->> 'platinum')::int, (s ->> 'gold')::int, (s ->> 'silver')::int) then 'platinum'
    when p_points >= greatest((s ->> 'gold')::int, (s ->> 'silver')::int) then 'gold'
    when p_points >= (s ->> 'silver')::int then 'silver'
    else 'bronze'
  end
  from public.loyalty_settings_for(p_restaurant_id) s;
$function$;

-- What the storefront draws: the rate for "How points work", and the ladder itself.
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
    'tiers', jsonb_build_array(
      jsonb_build_object('key', 'bronze',   'threshold', 0),
      jsonb_build_object('key', 'silver',   'threshold', (s ->> 'silver')::int),
      jsonb_build_object('key', 'gold',     'threshold', (s ->> 'gold')::int),
      jsonb_build_object('key', 'platinum', 'threshold', (s ->> 'platinum')::int)))
  from public.branches b
  join public.restaurants r on r.id = b.restaurant_id
  cross join lateral public.loyalty_settings_for(r.id) s
  where b.id = p_branch_id;
$function$;

-- Owner-only, like the reward catalogue and for the same reason: it comes out of the restaurant's
-- own margin, at every branch.
create or replace function public.set_loyalty_settings(
  p_restaurant_id uuid,
  p_points_per_currency numeric,
  p_silver integer,
  p_gold integer,
  p_platinum integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_rate numeric := round(coalesce(p_points_per_currency, 1), 2);
begin
  if not private.user_owns_restaurant(p_restaurant_id) then raise exception 'not_authorized'; end if;
  if v_rate <= 0 or v_rate > 100 then raise exception 'bad_rate:%', v_rate; end if;
  if p_silver is null or p_gold is null or p_platinum is null
     or p_silver < 1 or p_gold <= p_silver or p_platinum <= p_gold then
    raise exception 'bad_tiers:%,%,%', p_silver, p_gold, p_platinum;
  end if;

  update public.restaurants
     set loyalty_settings = jsonb_build_object(
           'points_per_currency', v_rate,
           'tiers', jsonb_build_object('silver', p_silver, 'gold', p_gold, 'platinum', p_platinum)),
         updated_at = now()
   where id = p_restaurant_id;

  -- Re-grade everyone against the new ladder at once: a customer holding a Gold badge the
  -- restaurant no longer grants is worse than a badge that changes the moment the rule does.
  update public.loyalty_points lp
     set tier = public.tier_for_points(p_restaurant_id, lp.lifetime_earned::int)::loyalty_tier
   where lp.restaurant_id = p_restaurant_id
     and lp.tier is distinct from public.tier_for_points(p_restaurant_id, lp.lifetime_earned::int)::loyalty_tier;

  return public.loyalty_settings_for(p_restaurant_id);
end $function$;

-- Housekeeping now grades each restaurant by its own ladder instead of one set of platform numbers.
create or replace function public.recompute_loyalty_tiers()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_count int;
begin
  update public.loyalty_points lp
     set tier = public.tier_for_points(lp.restaurant_id, lp.lifetime_earned::int)::loyalty_tier
   where lp.restaurant_id is not null
     and lp.tier is distinct from public.tier_for_points(lp.restaurant_id, lp.lifetime_earned::int)::loyalty_tier;
  get diagnostics v_count = row_count;
  return v_count;
end; $function$;

-- Earning follows the merchant's rate, and the badge follows their ladder.
create or replace function public.orders_on_complete_award_loyalty()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
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

  v_rate := (public.loyalty_settings_for(v_restaurant_id) ->> 'points_per_currency')::numeric;
  v_points := floor(coalesce(new.subtotal, 0) * v_rate)::int;
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
      set points_balance = public.loyalty_points.points_balance + v_points,
          lifetime_earned = public.loyalty_points.lifetime_earned + v_points,
          updated_at = now()
    returning points_balance, lifetime_earned into v_balance, v_lifetime;
  else
    insert into public.loyalty_points(branch_id, customer_id, points_balance, lifetime_earned, restaurant_id)
    values (new.branch_id, new.customer_id, v_points, v_points, v_restaurant_id)
    on conflict (branch_id, customer_id) where branch_id is not null do update
      set points_balance = public.loyalty_points.points_balance + v_points,
          lifetime_earned = public.loyalty_points.lifetime_earned + v_points,
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

revoke execute on function public.loyalty_settings_for(uuid) from public, anon, authenticated;
revoke execute on function public.set_loyalty_settings(uuid, numeric, integer, integer, integer) from public, anon;
grant  execute on function public.set_loyalty_settings(uuid, numeric, integer, integer, integer) to authenticated;
grant  execute on function public.loyalty_program(uuid) to anon, authenticated;
grant  execute on function public.tier_for_points(uuid, integer) to anon, authenticated;

commit;
