-- Three holes in the loyalty programme settings, found reviewing 20260916090000/100000.
--
-- 1. THE COLUMN WAS NOT ACTUALLY OWNER-ONLY. set_loyalty_settings() gates on
--    private.user_owns_restaurant(), but restaurants_staff_update lets any active manager or admin
--    UPDATE the table, and private.guard_restaurant_privileged_columns() is a DENYLIST naming
--    seven columns. loyalty_settings was not one of them, so a manager could
--      PATCH /rest/v1/restaurants?id=eq.<r>  {"loyalty_settings":{"points_per_currency":100,…}}
--    and skip the owner check, the range validation and the re-grade in one request: every
--    customer earning 100x points out of the owner's margin, with nothing in the UI to show it.
--    A denylist means every column added later is writable by a manager by default; this one has
--    money behind it.
--
-- 2. The re-grade called two nested SECURITY DEFINER functions per member row. Postgres cannot
--    inline those, so a restaurant with a large member base could blow authenticated's 8s
--    statement_timeout and lose the settings write with it -- the save would fail forever, with a
--    raw timeout message. The thresholds are validated one line above, so the same grading is done
--    inline from those values instead.
--
-- 3. loyalty_settings_for() checked that the rate LOOKED like a number but not that it was a
--    sensible one. A row carrying 0 (from a hand edit, or from hole 1) made the award trigger
--    grant nothing while the storefront still advertised the platform's rate, and an enormous
--    value overflowed the ::int casts. Digits are now bounded and the value range-checked, so the
--    resolver always returns something the trigger can use.

begin;

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

  -- Deliberately ABOVE the owner/platform-admin early return, and gated on the same helper
  -- set_loyalty_settings() uses: user_owns_restaurant() also accepts an active staff_members row
  -- with role 'owner', which `old.owner_user_id = auth.uid()` does not -- and this project has
  -- owners who are exactly that.
  if new.loyalty_settings is distinct from old.loyalty_settings
     and not private.user_owns_restaurant(old.id) then
    raise exception 'restaurant_privileged_column_denied'
      using hint = 'Only the restaurant owner may change the loyalty programme, through set_loyalty_settings().';
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

-- Digits are bounded before every cast (a 40-digit "threshold" would raise out of ::int and take
-- order completion down with it) and the rate has to be a rate, not just numeric-shaped.
create or replace function public.loyalty_settings_for(p_restaurant_id uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'points_per_currency',
      coalesce((case when (r.loyalty_settings ->> 'points_per_currency') ~ '^[0-9]{1,3}(\.[0-9]{1,2})?$'
                      and (r.loyalty_settings ->> 'points_per_currency')::numeric > 0
                      and (r.loyalty_settings ->> 'points_per_currency')::numeric <= 100
                     then (r.loyalty_settings ->> 'points_per_currency')::numeric end), 1),
    'silver',
      coalesce((case when (r.loyalty_settings -> 'tiers' ->> 'silver') ~ '^[0-9]{1,9}$'
                     then (r.loyalty_settings -> 'tiers' ->> 'silver')::int end), 10000),
    'gold',
      coalesce((case when (r.loyalty_settings -> 'tiers' ->> 'gold') ~ '^[0-9]{1,9}$'
                     then (r.loyalty_settings -> 'tiers' ->> 'gold')::int end), 30000),
    'platinum',
      coalesce((case when (r.loyalty_settings -> 'tiers' ->> 'platinum') ~ '^[0-9]{1,9}$'
                     then (r.loyalty_settings -> 'tiers' ->> 'platinum')::int end), 100000),
    'labels', jsonb_build_object(
      'bronze',   coalesce(nullif(trim(r.loyalty_settings -> 'labels' ->> 'bronze'), ''), 'Bronze'),
      'silver',   coalesce(nullif(trim(r.loyalty_settings -> 'labels' ->> 'silver'), ''), 'Silver'),
      'gold',     coalesce(nullif(trim(r.loyalty_settings -> 'labels' ->> 'gold'), ''), 'Gold'),
      'platinum', coalesce(nullif(trim(r.loyalty_settings -> 'labels' ->> 'platinum'), ''), 'Platinum')),
    -- json null, not an empty array: the caller must be able to tell "never set" from "set to
    -- nothing", because only the first one should show the platform's stock copy.
    'perks', jsonb_build_object(
      'bronze',   case when jsonb_typeof(r.loyalty_settings -> 'perks' -> 'bronze') = 'array'
                       then r.loyalty_settings -> 'perks' -> 'bronze' else 'null'::jsonb end,
      'silver',   case when jsonb_typeof(r.loyalty_settings -> 'perks' -> 'silver') = 'array'
                       then r.loyalty_settings -> 'perks' -> 'silver' else 'null'::jsonb end,
      'gold',     case when jsonb_typeof(r.loyalty_settings -> 'perks' -> 'gold') = 'array'
                       then r.loyalty_settings -> 'perks' -> 'gold' else 'null'::jsonb end,
      'platinum', case when jsonb_typeof(r.loyalty_settings -> 'perks' -> 'platinum') = 'array'
                       then r.loyalty_settings -> 'perks' -> 'platinum' else 'null'::jsonb end))
  from public.restaurants r
  where r.id = p_restaurant_id;
$function$;

create or replace function public.set_loyalty_settings(
  p_restaurant_id uuid,
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
begin
  if not private.user_owns_restaurant(p_restaurant_id) then raise exception 'not_authorized'; end if;
  if v_rate <= 0 or v_rate > 100 then raise exception 'bad_rate:%', v_rate; end if;
  -- Bounded above as well as ordered: the resolver refuses to read a threshold of more than nine
  -- digits, so storing one would silently fall back to the platform's number.
  if p_silver is null or p_gold is null or p_platinum is null
     or p_silver < 1 or p_gold <= p_silver or p_platinum <= p_gold or p_platinum > 999999999 then
    raise exception 'bad_tiers:%,%,%', p_silver, p_gold, p_platinum;
  end if;
  if p_labels is not null and jsonb_typeof(p_labels) <> 'object' then raise exception 'bad_labels'; end if;
  if p_perks  is not null and jsonb_typeof(p_perks)  <> 'object' then raise exception 'bad_perks';  end if;

  foreach v_key in array v_keys loop
    -- A blank name is not stored, so clearing the box restores the platform's name rather than
    -- leaving a nameless badge on the customer's account.
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
      -- Blank lines are dropped, so a stray newline does not publish an empty bullet.
      v_perkset := v_perkset || jsonb_build_object(v_key, coalesce((
        select jsonb_agg(trim(e #>> '{}'))
          from jsonb_array_elements(v_perks) e
         where nullif(trim(e #>> '{}'), '') is not null), '[]'::jsonb));
    end if;
  end loop;

  select coalesce(loyalty_settings, '{}'::jsonb) into v_current
    from public.restaurants where id = p_restaurant_id;

  update public.restaurants
     set loyalty_settings = jsonb_build_object(
           'points_per_currency', v_rate,
           'tiers', jsonb_build_object('silver', p_silver, 'gold', p_gold, 'platinum', p_platinum),
           -- Words are only replaced when the caller sent them: a client that knows nothing about
           -- labels cannot wipe the merchant's copy by saving the numbers.
           'labels', case when p_labels is null then coalesce(v_current -> 'labels', '{}'::jsonb) else v_labels end,
           'perks',  case when p_perks  is null then coalesce(v_current -> 'perks',  '{}'::jsonb) else v_perkset end),
         updated_at = now()
   where id = p_restaurant_id;

  -- Graded inline from the values validated above: identical to tier_for_points(), but without two
  -- nested SECURITY DEFINER calls per member row -- which is what keeps the whole save inside the
  -- 8s statement_timeout once a restaurant has a real member base. It stays in this transaction on
  -- purpose: the screen promises every badge was re-checked, so a half-done ladder is not an option.
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

  return public.loyalty_settings_for(p_restaurant_id);
end $function$;

commit;
