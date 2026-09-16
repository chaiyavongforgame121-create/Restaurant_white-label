-- Tier names and the "what this unlocks" lines become the merchant's words.
--
-- 20260916090000 handed over the earn rate and the thresholds; the labels (Bronze/Silver/Gold/
-- Platinum) and the benefit line under each one were still the platform's English, written into the
-- customer page. A Thai restaurant could set the points for a tier it could not name.
--
-- The KEYS stay bronze/silver/gold/platinum: they are the loyalty_tier enum stored against every
-- customer, and renaming those would rewrite history. Only what a diner reads changes.
--
-- loyalty_settings grows two optional objects:
--   labels: { bronze: text, … }     -- absent or blank falls back to the platform's name
--   perks:  { bronze: [text], … }   -- ABSENT means "use the platform's stock line"; an empty array
--                                      means the merchant deliberately says nothing extra. The
--                                      "Unlocked at N points" line is NOT stored -- the page draws
--                                      it from the threshold, so it cannot go stale when the
--                                      merchant moves a tier.

begin;

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

-- One function, now carrying the words too. The five-argument version from 20260916090000 is
-- dropped rather than left beside this one: PostgREST picks an overload from the arguments sent, so
-- two same-named functions would make which one runs depend on what a client forgot to send.
drop function if exists public.set_loyalty_settings(uuid, numeric, integer, integer, integer);

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
  if p_silver is null or p_gold is null or p_platinum is null
     or p_silver < 1 or p_gold <= p_silver or p_platinum <= p_gold then
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

  update public.loyalty_points lp
     set tier = public.tier_for_points(p_restaurant_id, lp.lifetime_earned::int)::loyalty_tier
   where lp.restaurant_id = p_restaurant_id
     and lp.tier is distinct from public.tier_for_points(p_restaurant_id, lp.lifetime_earned::int)::loyalty_tier;

  return public.loyalty_settings_for(p_restaurant_id);
end $function$;

revoke execute on function public.set_loyalty_settings(uuid, numeric, integer, integer, integer, jsonb, jsonb) from public, anon;
grant  execute on function public.set_loyalty_settings(uuid, numeric, integer, integer, integer, jsonb, jsonb) to authenticated;

commit;
