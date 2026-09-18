-- Loyalty is per branch, completely. The owner's rule: every branch of a restaurant keeps its own
-- customers, points, rewards and programme; only the diner's login and the account's billing are
-- shared. The owner opened a second branch (Food Thai Thai) and found that changing loyalty on one
-- branch changed the other. Verified live before this migration:
--
-- 1. THE REWARD CATALOGUE WAS ONE LIST PER RESTAURANT. loyalty_rewards had only restaurant_id, the
--    admin page read and wrote it by restaurant, and list_loyalty_rewards joined on the restaurant,
--    so "Get discount" showed (and was editable) at both branches. Rewards now carry branch_id (NOT
--    NULL). The one live reward was created 2026-09-12, three days before Food Thai Thai existed, so
--    it goes to Hamburger: a free-item reward goes to its item's branch, anything else to the oldest
--    branch of the restaurant that existed when the reward was created. Food Thai Thai starts empty.
--    A free item must now be on the SAME branch's menu (it only had to be in the same restaurant),
--    and a reward cannot be moved to another branch after the fact.
--
-- 2. THE PROGRAMME (earn rate, tier thresholds, names, perks) WAS ONE JSON PER RESTAURANT.
--    restaurants.loyalty_settings fed loyalty_program for both branches (same version hash), and
--    set_loyalty_settings re-graded every member of the restaurant. It now lives in
--    public.branch_loyalty_settings, one row per branch, with no write grant or write policy at all:
--    set_loyalty_settings (SECURITY DEFINER) is the only writer. That is deliberately not a
--    branches.settings key: managers may write branches.settings, and the programme is loyalty.manage
--    (owner, admin). Every branch gets its restaurant's current settings as its starting programme
--    (they were last saved 2026-09-16, while both branches existed). A branch without a row -- one
--    created after this migration -- runs on the platform defaults, so nothing needs seeding. A new
--    birthday_points key (default 500, the old hard-coded gift; 0 turns the gift off) joins the
--    programme. restaurants.loyalty_settings is legacy from here on and nothing reads it.
--
-- 3. SWITCHING loyalty_scope TO 'branch' ORPHANED EVERY HAMBURGER BALANCE. A platform admin flipped
--    Coastal Grill to 'branch' on 2026-09-15 without moving data, so the 9 brand-pool balance rows
--    (branch_id NULL, 771 points, e.g. customer "B." 6275fa01 with 178) and the 34 NULL-branch ledger
--    rows became unreachable: members saw 0 points and an empty history. Every one of those rows
--    predates Food Thai Thai and all order-linked ones are Hamburger orders. The backfill:
--      * a ledger row takes its order's branch, else its customer's branch, else the restaurant's
--        oldest branch (live: all 34 go to Hamburger);
--      * a balance row takes the branch holding most of that customer's pool ledger rows (the ones
--        just attributed, not rows already filed under a branch), else the customer's branch, else
--        the oldest branch (live: all 9 go to Hamburger, no conflicts; Food Thai Thai keeps its own
--        116-point row). On a conflict the two rows are merged by summing.
--        Rows are MOVED AS THEY ARE, not rebuilt from the ledger: the two already drift (094225ea holds
--        13 against a ledger of 9), and a rebuild would silently change members' balances.
--    Then branch_id is NOT NULL on both tables, the brand-pool index and check go, loyalty_scope is
--    pinned to 'branch' by a CHECK (the Brands page toggle becomes harmless until it is removed), and
--    every 'brand' code path is gone from the functions. restaurant_id is derived from branch_id by a
--    trigger on both tables, so no writer can file a row under the wrong restaurant.
--
-- 4. STAFF OF ONE BRANCH READ ANOTHER BRANCH'S BALANCES. loyalty_points_staff_read and
--    loyalty_tx_staff_read had a restaurant-wide arm (user_restaurant_ids), so the Hamburger kitchen
--    account read Food Thai Thai's rows. Both are now branch-only. Rewards are read by staff with
--    loyalty.manage or customers.view AT THAT BRANCH and written with loyalty.manage at that branch
--    (owner + admin, as the sidebar already showed it), instead of owner-only restaurant-wide. The
--    RPC gate follows the same capability.
--
-- 5. POINTS SPENT ON AN ORDER THAT WAS THEN CANCELLED WERE KEPT, and the diner's history hid the
--    debit (list_my_loyalty_transactions only showed order rows of completed orders). An AFTER UPDATE
--    trigger on orders now gives the points back when an order becomes cancelled or refunded before
--    it was completed: an 'adjusted' ledger row (reference_type 'order_return') and the balance
--    restored on that branch's row. If the order is later taken out of cancelled/refunded (a kitchen
--    Undo racing a cancel, a recall), the same trigger takes those points again with a negative
--    'order_return' row -- or refuses the move when they have been spent since -- so a reward can
--    never end up free. Each step moves only the difference between what the order spent and what
--    its 'order_return' rows already gave back, under the order's row lock, so a replay (a second
--    cancel, cancelled -> refunded) moves nothing. The two orders already cancelled that way
--    (customer 6d3a764b, 100 + 50 points, August) get the same return now. The history shows every
--    row of the branch, redeemed ones included.
--
-- 6. BIRTHDAY GIFTS were one per restaurant, hard-coded at 500, and credited nothing (and wrote no
--    ledger row) when the member had no balance row at their first branch. Now: one per (customer,
--    branch, year), the branch's own birthday_points, the balance row is upserted and a ledger row is
--    written. The nightly tier re-grade uses each branch's own ladder.
--
-- Also: storefront RPCs find the diner's rows by (their customers rows, this branch), which works
-- whether customers are one row per restaurant or one row per branch; redeem_loyalty_points is
-- dropped (no caller since the reward catalogue); excess table grants are revoked (anon had
-- INSERT/UPDATE/DELETE/TRUNCATE on loyalty_rewards and birthday_rewards; RLS covered the DML, but
-- nothing needs the privilege). adjust_loyalty_points lets loyalty.manage staff correct one
-- member's balance at their branch: the balance and an 'adjusted' ledger row move together, instead
-- of a raw table edit that leaves the history unable to explain the balance.

begin;

-- =============================================================================================
-- 3a. Pin the scope. 'branch' is the only mode.
-- =============================================================================================
update public.restaurants set loyalty_scope = 'branch' where loyalty_scope is distinct from 'branch';
alter table public.restaurants alter column loyalty_scope set default 'branch';
alter table public.restaurants drop constraint if exists restaurants_loyalty_scope_check;
alter table public.restaurants add constraint restaurants_loyalty_scope_check check (loyalty_scope = 'branch');
comment on column public.restaurants.loyalty_scope is
  'Legacy. Loyalty is always per branch (CHECK pins it to ''branch''); nothing reads this column.';
comment on column public.restaurants.loyalty_settings is
  'Legacy. The loyalty programme lives in public.branch_loyalty_settings, one row per branch.';

-- =============================================================================================
-- 3b. Ledger rows: every row belongs to a branch.
-- =============================================================================================
-- Kept for 3c: the brand pool's balance follows the pool's OWN history (these rows), not rows that
-- were already filed under a branch. Live, Bobby (70d15b7e) has 1 pool row at Hamburger and 3
-- branch rows at Food Thai Thai; counting all of them would have poured his Hamburger points into
-- Food Thai Thai's balance.
create temp table _loyalty_ledger_target on commit drop as
select t.id, t.customer_id, t.created_at,
       coalesce(
         (select o.branch_id
            from public.orders o
            join public.branches ob on ob.id = o.branch_id
           where t.reference_type = 'order' and o.id = t.reference_id
             and ob.restaurant_id = coalesce(t.restaurant_id, c.restaurant_id)),
         (select cb.id from public.branches cb
           where cb.id = c.branch_id and cb.restaurant_id = coalesce(t.restaurant_id, c.restaurant_id)),
         (select ob.id from public.branches ob
           where ob.restaurant_id = coalesce(t.restaurant_id, c.restaurant_id)
           order by ob.created_at, ob.id limit 1)
       ) as branch_id
  from public.loyalty_transactions t
  left join public.customers c on c.id = t.customer_id
 where t.branch_id is null;

update public.loyalty_transactions t
   set branch_id = tg.branch_id
  from _loyalty_ledger_target tg
 where t.id = tg.id and tg.branch_id is not null;

update public.loyalty_transactions t
   set restaurant_id = b.restaurant_id
  from public.branches b
 where b.id = t.branch_id and t.restaurant_id is distinct from b.restaurant_id;

-- =============================================================================================
-- 3c. Balance rows: move each brand-pool row to a branch, merging on a conflict.
-- =============================================================================================
create temp table _loyalty_pool_target on commit drop as
select lp.id, lp.customer_id, x.restaurant_id,
       coalesce(
         (select lt.branch_id
            from _loyalty_ledger_target lt
            join public.branches tb on tb.id = lt.branch_id
           where lt.customer_id = lp.customer_id and tb.restaurant_id = x.restaurant_id
           group by lt.branch_id
           order by count(*) desc, max(lt.created_at) desc, lt.branch_id
           limit 1),
         (select cb.id from public.customers c
            join public.branches cb on cb.id = c.branch_id
           where c.id = lp.customer_id and cb.restaurant_id = x.restaurant_id),
         (select ob.id from public.branches ob
           where ob.restaurant_id = x.restaurant_id
           order by ob.created_at, ob.id limit 1)
       ) as branch_id
  from public.loyalty_points lp
 cross join lateral (
   select coalesce(lp.restaurant_id,
                   (select c.restaurant_id from public.customers c where c.id = lp.customer_id)) as restaurant_id
 ) x
 where lp.branch_id is null;

-- A branch row already exists for that customer: add the pool into it (saturating, as the award
-- trigger does), then drop the pool row.
update public.loyalty_points dst
   set points_balance  = least(dst.points_balance::bigint  + src.points_balance, 2147483647)::int,
       lifetime_earned = least(dst.lifetime_earned::bigint + src.lifetime_earned, 2147483647)::int,
       lifetime_spent  = least(dst.lifetime_spent::bigint  + src.lifetime_spent, 2147483647)::int,
       updated_at = now()
  from _loyalty_pool_target tg
  join public.loyalty_points src on src.id = tg.id
 where dst.branch_id = tg.branch_id
   and dst.customer_id = tg.customer_id;

delete from public.loyalty_points lp
 using _loyalty_pool_target tg
 where lp.id = tg.id
   and exists (select 1 from public.loyalty_points dst
                where dst.branch_id = tg.branch_id and dst.customer_id = tg.customer_id);

-- No branch row yet: the pool row simply becomes the branch row, untouched.
update public.loyalty_points lp
   set branch_id = tg.branch_id,
       restaurant_id = tg.restaurant_id
  from _loyalty_pool_target tg
 where lp.id = tg.id and tg.branch_id is not null;

update public.loyalty_points lp
   set restaurant_id = b.restaurant_id
  from public.branches b
 where b.id = lp.branch_id and lp.restaurant_id is distinct from b.restaurant_id;

-- =============================================================================================
-- 3d. Branch is mandatory; the brand pool's index and check go.
-- =============================================================================================
alter table public.loyalty_transactions
  alter column branch_id set not null,
  alter column restaurant_id set not null;
alter table public.loyalty_points
  alter column branch_id set not null,
  alter column restaurant_id set not null;

alter table public.loyalty_points drop constraint if exists loyalty_points_scope_check;
drop index if exists public.loyalty_points_brand_scope_uidx;
-- Full (not partial) unique index: `on conflict (branch_id, customer_id)` infers it with or without
-- the old `where branch_id is not null` predicate, so existing upserts keep working.
create unique index if not exists loyalty_points_branch_customer_uidx
  on public.loyalty_points (branch_id, customer_id);
drop index if exists public.loyalty_points_branch_scope_uidx;
create index if not exists loyalty_points_customer_idx on public.loyalty_points (customer_id);
-- The cancel trigger below looks up an order's ledger rows on every cancellation.
create index if not exists loyalty_transactions_reference_idx
  on public.loyalty_transactions (reference_id) where reference_id is not null;

-- restaurant_id is a copy of the branch's restaurant, never an independent choice.
create or replace function private.loyalty_row_restaurant_from_branch()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  -- NULL for an unknown branch, which the NOT NULL on restaurant_id then refuses.
  new.restaurant_id := (select b.restaurant_id from public.branches b where b.id = new.branch_id);
  return new;
end $function$;
revoke execute on function private.loyalty_row_restaurant_from_branch() from public, anon, authenticated;

drop trigger if exists loyalty_points_restaurant_from_branch on public.loyalty_points;
create trigger loyalty_points_restaurant_from_branch
  before insert or update of branch_id, restaurant_id on public.loyalty_points
  for each row execute function private.loyalty_row_restaurant_from_branch();

drop trigger if exists loyalty_transactions_restaurant_from_branch on public.loyalty_transactions;
create trigger loyalty_transactions_restaurant_from_branch
  before insert or update of branch_id, restaurant_id on public.loyalty_transactions
  for each row execute function private.loyalty_row_restaurant_from_branch();

-- =============================================================================================
-- 1. Rewards belong to a branch.
-- =============================================================================================
alter table public.loyalty_rewards
  add column if not exists branch_id uuid references public.branches(id) on delete cascade;

update public.loyalty_rewards lr
   set branch_id = coalesce(
         (select mi.branch_id
            from public.menu_items mi
            join public.branches mb on mb.id = mi.branch_id
           where mi.id = lr.menu_item_id and mb.restaurant_id = lr.restaurant_id),
         (select b.id from public.branches b
           where b.restaurant_id = lr.restaurant_id and b.created_at <= lr.created_at
           order by b.created_at, b.id limit 1),
         (select b.id from public.branches b
           where b.restaurant_id = lr.restaurant_id
           order by b.created_at, b.id limit 1))
 where lr.branch_id is null;

alter table public.loyalty_rewards alter column branch_id set not null;
create index if not exists loyalty_rewards_branch_idx
  on public.loyalty_rewards (branch_id, is_active, sort_order);
drop index if exists public.loyalty_rewards_restaurant_idx;

create or replace function private.guard_loyalty_reward_menu_item()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_restaurant uuid;
begin
  if tg_op = 'UPDATE' and new.branch_id is distinct from old.branch_id then
    raise exception 'loyalty_reward_branch_immutable'
      using hint = 'A reward belongs to the branch it was created at. Create it again at the other branch.';
  end if;

  select b.restaurant_id into v_restaurant from public.branches b where b.id = new.branch_id;
  if v_restaurant is null then
    raise exception 'loyalty_reward_branch_required'
      using hint = 'Every reward belongs to one branch; send branch_id.';
  end if;
  -- Derived, so the restaurant a client sends can never disagree with the branch.
  new.restaurant_id := v_restaurant;

  if new.menu_item_id is not null and not exists (
    select 1 from public.menu_items mi
     where mi.id = new.menu_item_id and mi.branch_id = new.branch_id
  ) then
    raise exception 'loyalty_reward_menu_item_other_branch'
      using hint = 'The free item must be on this branch''s own menu.';
  end if;
  return new;
end $function$;
revoke execute on function private.guard_loyalty_reward_menu_item() from public, anon, authenticated;

-- =============================================================================================
-- 2. The programme, one row per branch.
-- =============================================================================================
create table if not exists public.branch_loyalty_settings (
  branch_id     uuid primary key references public.branches(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  settings      jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id) on delete set null
);
comment on table public.branch_loyalty_settings is
  'One branch''s loyalty programme (earn rate, tier thresholds, names, perks, birthday gift). Written only by set_loyalty_settings(); a branch without a row runs on the platform defaults.';

alter table public.branch_loyalty_settings enable row level security;
revoke all on public.branch_loyalty_settings from public, anon, authenticated;
grant select on public.branch_loyalty_settings to authenticated;
grant all on public.branch_loyalty_settings to service_role;
drop policy if exists branch_loyalty_settings_staff_read on public.branch_loyalty_settings;
create policy branch_loyalty_settings_staff_read on public.branch_loyalty_settings
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));

insert into public.branch_loyalty_settings (branch_id, restaurant_id, settings)
select b.id, b.restaurant_id,
       case when jsonb_typeof(r.loyalty_settings) = 'object' then r.loyalty_settings else '{}'::jsonb end
  from public.branches b
  join public.restaurants r on r.id = b.restaurant_id
on conflict (branch_id) do nothing;

-- Readers first: tier_for_points and loyalty_program are SQL functions validated against it.
drop function if exists public.tier_for_points(uuid, integer);
drop function if exists public.loyalty_settings_for(uuid);

create function public.loyalty_settings_for(p_branch_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'points_per_currency',
      coalesce((case when (s ->> 'points_per_currency') ~ '^[0-9]{1,3}(\.[0-9]{1,2})?$'
                      and (s ->> 'points_per_currency')::numeric > 0
                      and (s ->> 'points_per_currency')::numeric <= 100
                     then (s ->> 'points_per_currency')::numeric end), 1),
    'silver',
      coalesce((case when (s -> 'tiers' ->> 'silver') ~ '^[0-9]{1,9}$'
                     then (s -> 'tiers' ->> 'silver')::int end), 10000),
    'gold',
      coalesce((case when (s -> 'tiers' ->> 'gold') ~ '^[0-9]{1,9}$'
                     then (s -> 'tiers' ->> 'gold')::int end), 30000),
    'platinum',
      coalesce((case when (s -> 'tiers' ->> 'platinum') ~ '^[0-9]{1,9}$'
                     then (s -> 'tiers' ->> 'platinum')::int end), 100000),
    -- 0 turns the birthday gift off; 500 is what every member got before it was configurable.
    'birthday_points',
      coalesce((case when (s ->> 'birthday_points') ~ '^[0-9]{1,7}$'
                      and (s ->> 'birthday_points')::int <= 1000000
                     then (s ->> 'birthday_points')::int end), 500),
    'labels', jsonb_build_object(
      'bronze',   coalesce(nullif(trim(s -> 'labels' ->> 'bronze'), ''), 'Bronze'),
      'silver',   coalesce(nullif(trim(s -> 'labels' ->> 'silver'), ''), 'Silver'),
      'gold',     coalesce(nullif(trim(s -> 'labels' ->> 'gold'), ''), 'Gold'),
      'platinum', coalesce(nullif(trim(s -> 'labels' ->> 'platinum'), ''), 'Platinum')),
    -- json null, not an empty array: the caller must be able to tell "never set" from "set to
    -- nothing", because only the first one should show the platform's stock copy.
    'perks', jsonb_build_object(
      'bronze',   case when jsonb_typeof(s -> 'perks' -> 'bronze') = 'array'
                       then s -> 'perks' -> 'bronze' else 'null'::jsonb end,
      'silver',   case when jsonb_typeof(s -> 'perks' -> 'silver') = 'array'
                       then s -> 'perks' -> 'silver' else 'null'::jsonb end,
      'gold',     case when jsonb_typeof(s -> 'perks' -> 'gold') = 'array'
                       then s -> 'perks' -> 'gold' else 'null'::jsonb end,
      'platinum', case when jsonb_typeof(s -> 'perks' -> 'platinum') = 'array'
                       then s -> 'perks' -> 'platinum' else 'null'::jsonb end))
  from public.branches b
  left join public.branch_loyalty_settings bls on bls.branch_id = b.id
  cross join lateral (select coalesce(bls.settings, '{}'::jsonb) as s) x
  where b.id = p_branch_id;
$function$;
revoke execute on function public.loyalty_settings_for(uuid) from public, anon, authenticated;
grant  execute on function public.loyalty_settings_for(uuid) to service_role;

create function public.tier_for_points(p_branch_id uuid, p_points integer)
 returns text
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select case
    when p_points >= greatest((s ->> 'platinum')::int, (s ->> 'gold')::int, (s ->> 'silver')::int) then 'platinum'
    when p_points >= greatest((s ->> 'gold')::int, (s ->> 'silver')::int) then 'gold'
    when p_points >= (s ->> 'silver')::int then 'silver'
    else 'bronze'
  end
  from public.loyalty_settings_for(p_branch_id) s;
$function$;
revoke execute on function public.tier_for_points(uuid, integer) from public;
grant  execute on function public.tier_for_points(uuid, integer) to anon, authenticated, service_role;

create or replace function public.loyalty_program(p_branch_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'points_per_currency', (s ->> 'points_per_currency')::numeric,
    -- Always 'branch'. Kept for clients that still read the key.
    'scope', 'branch',
    -- The version of THIS branch's stored settings. jsonb text output is canonical (keys sorted,
    -- whitespace normalised), so equal settings always hash equal. A branch without a row hashes
    -- '{}', which is also what set_loyalty_settings compares against before its first save.
    'version', md5(coalesce(bls.settings, '{}'::jsonb)::text),
    'birthday_points', (s ->> 'birthday_points')::int,
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
  left join public.branch_loyalty_settings bls on bls.branch_id = b.id
  cross join lateral public.loyalty_settings_for(b.id) s
  where b.id = p_branch_id;
$function$;

-- The restaurant-keyed version goes: a client still sending p_restaurant_id must fail, not save a
-- programme onto a branch it did not name.
drop function if exists public.set_loyalty_settings(uuid, text, numeric, integer, integer, integer, jsonb, jsonb);

create or replace function public.set_loyalty_settings(
  p_branch_id uuid,
  p_expected_version text,
  p_points_per_currency numeric,
  p_silver integer,
  p_gold integer,
  p_platinum integer,
  p_labels jsonb default null,
  p_perks jsonb default null,
  p_birthday_points integer default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_rate       numeric := round(coalesce(p_points_per_currency, 1), 2);
  v_keys       text[]  := array['bronze', 'silver', 'gold', 'platinum'];
  v_key        text;
  v_label      text;
  v_perks      jsonb;
  v_labels     jsonb := '{}'::jsonb;
  v_perkset    jsonb := '{}'::jsonb;
  v_restaurant uuid;
  v_current    jsonb;
  v_new        jsonb;
begin
  -- loyalty.manage at THIS branch: owner (any branch), admin of this branch or of every branch, the
  -- restaurant's owner_user_id, platform admin. An admin of another branch is refused.
  select b.restaurant_id into v_restaurant from public.branches b where b.id = p_branch_id;
  if v_restaurant is null or not private.staff_has_capability(p_branch_id, 'loyalty.manage') then
    raise exception 'not_authorized';
  end if;
  if v_rate <= 0 or v_rate > 100 then raise exception 'bad_rate:%', v_rate; end if;
  if p_silver is null or p_gold is null or p_platinum is null
     or p_silver < 1 or p_gold <= p_silver or p_platinum <= p_gold or p_platinum > 999999999 then
    raise exception 'bad_tiers:%,%,%', p_silver, p_gold, p_platinum;
  end if;
  if p_birthday_points is not null and (p_birthday_points < 0 or p_birthday_points > 1000000) then
    raise exception 'bad_birthday_points:%', p_birthday_points;
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

  -- A branch that never saved gets its row now ('{}', the same version loyalty_program published),
  -- and the row is locked before comparing, so two saves arriving together cannot both see the
  -- old version.
  insert into public.branch_loyalty_settings (branch_id, restaurant_id)
  values (p_branch_id, v_restaurant)
  on conflict (branch_id) do nothing;
  select settings into v_current
    from public.branch_loyalty_settings
   where branch_id = p_branch_id
     for update;
  if p_expected_version is distinct from md5(v_current::text) then
    raise exception 'stale_settings';
  end if;

  v_new := jsonb_build_object(
    'points_per_currency', v_rate,
    'tiers', jsonb_build_object('silver', p_silver, 'gold', p_gold, 'platinum', p_platinum),
    'labels', case when p_labels is null then coalesce(v_current -> 'labels', '{}'::jsonb) else v_labels end,
    'perks',  case when p_perks  is null then coalesce(v_current -> 'perks',  '{}'::jsonb) else v_perkset end)
    -- Left out = keep what is stored (or the default when nothing is).
    || case when p_birthday_points is not null then jsonb_build_object('birthday_points', p_birthday_points)
            when v_current ? 'birthday_points' then jsonb_build_object('birthday_points', v_current -> 'birthday_points')
            else '{}'::jsonb end;

  update public.branch_loyalty_settings
     set settings = v_new,
         restaurant_id = v_restaurant,
         updated_at = now(),
         updated_by = auth.uid()
   where branch_id = p_branch_id;

  -- Re-grade this branch's members only. Another branch's badges follow another branch's ladder.
  update public.loyalty_points lp
     set tier = (case
                   when lp.lifetime_earned >= p_platinum then 'platinum'
                   when lp.lifetime_earned >= p_gold     then 'gold'
                   when lp.lifetime_earned >= p_silver   then 'silver'
                   else 'bronze'
                 end)::loyalty_tier
   where lp.branch_id = p_branch_id
     and lp.tier is distinct from (case
                   when lp.lifetime_earned >= p_platinum then 'platinum'
                   when lp.lifetime_earned >= p_gold     then 'gold'
                   when lp.lifetime_earned >= p_silver   then 'silver'
                   else 'bronze'
                 end)::loyalty_tier;

  -- The editor re-seeds from this, so its next save carries the version it just wrote.
  return public.loyalty_settings_for(p_branch_id)
         || jsonb_build_object('version', md5(v_new::text));
end $function$;

revoke execute on function public.set_loyalty_settings(uuid, text, numeric, integer, integer, integer, jsonb, jsonb, integer) from public, anon;
grant  execute on function public.set_loyalty_settings(uuid, text, numeric, integer, integer, integer, jsonb, jsonb, integer) to authenticated, service_role;

-- =============================================================================================
-- Earning: the order's branch, that branch's rate and ladder.
-- =============================================================================================
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

  select b.restaurant_id into v_restaurant_id from public.branches b where b.id = new.branch_id;
  if v_restaurant_id is null then
    return new;
  end if;

  -- Worked out in numeric and capped before the cast: an award that cannot fit must never be the
  -- reason an order cannot be completed.
  v_rate := coalesce((public.loyalty_settings_for(new.branch_id) ->> 'points_per_currency')::numeric, 1);
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
    new.branch_id, v_restaurant_id, new.customer_id, v_points, 0, 'earned', 'order', new.id,
    'Earned from order ' || new.order_number
  )
  on conflict do nothing
  returning id into v_txn_id;

  if v_txn_id is null then
    return new;  -- already awarded for this order
  end if;

  insert into public.loyalty_points(branch_id, customer_id, points_balance, lifetime_earned, restaurant_id)
  values (new.branch_id, new.customer_id, v_points, v_points, v_restaurant_id)
  on conflict (branch_id, customer_id) do update
    set points_balance  = least(public.loyalty_points.points_balance::bigint  + v_points, c_max)::int,
        lifetime_earned = least(public.loyalty_points.lifetime_earned::bigint + v_points, c_max)::int,
        updated_at = now()
  returning points_balance, lifetime_earned into v_balance, v_lifetime;

  v_tier := public.tier_for_points(new.branch_id, v_lifetime)::loyalty_tier;
  update public.loyalty_points set tier = v_tier
   where branch_id = new.branch_id and customer_id = new.customer_id
     and tier is distinct from v_tier;

  update public.loyalty_transactions set balance_after = v_balance where id = v_txn_id;

  return new;
end $function$;

-- =============================================================================================
-- 5. Points come back when an order is cancelled or refunded before completion, and go out again
--    if that order is put back in progress.
-- =============================================================================================
-- Every return-related row of an order is an 'adjusted' row with reference_type 'order_return':
-- plus when points come back, minus when a reopened order takes them again. Their sum is what the
-- order currently holds given back, so each step moves only the difference and a replay moves
-- nothing. A one-return-per-order unique index cannot express cancel -> reopen -> cancel, so the
-- guarantee is the order's row lock instead: the status UPDATE that fires the trigger holds it, and
-- both functions take it first for any other caller.
drop index if exists public.loyalty_transactions_returned_once_per_order;

create or replace function private.return_loyalty_for_order(p_order_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  c_max constant bigint := 2147483647;
  v_order record;
  r record;
  v_owed int;
  v_balance int;
  v_total bigint := 0;
begin
  select o.id, o.order_number, o.status::text as status into v_order
    from public.orders o where o.id = p_order_id
     for update;
  if v_order.id is null then
    return 0;
  end if;

  -- Per balance row the order's points came out of (one in practice): what it spent, less what its
  -- 'order_return' rows already gave back.
  for r in
    select t.branch_id, t.customer_id,
           coalesce(sum(-t.points::bigint) filter (where t.type = 'redeemed' and t.reference_type = 'order'), 0)
         - coalesce(sum(t.points::bigint)  filter (where t.reference_type = 'order_return'), 0) as owed
      from public.loyalty_transactions t
     where t.reference_id = p_order_id
       and ((t.type = 'redeemed' and t.reference_type = 'order') or t.reference_type = 'order_return')
     group by t.branch_id, t.customer_id
  loop
    continue when r.owed <= 0;
    v_owed := least(r.owed, c_max)::int;

    insert into public.loyalty_points(branch_id, customer_id, points_balance)
    values (r.branch_id, r.customer_id, v_owed)
    on conflict (branch_id, customer_id) do update
      set points_balance = least(public.loyalty_points.points_balance::bigint + v_owed, c_max)::int,
          lifetime_spent = greatest(public.loyalty_points.lifetime_spent::bigint - v_owed, 0)::int,
          updated_at = now()
    returning points_balance into v_balance;

    insert into public.loyalty_transactions(
      branch_id, customer_id, points, balance_after, type, reference_type, reference_id, description
    ) values (
      r.branch_id, r.customer_id, v_owed, v_balance, 'adjusted', 'order_return', p_order_id,
      'Points returned - order ' || v_order.order_number || ' ' || v_order.status
    );
    v_total := v_total + v_owed;
  end loop;
  return least(v_total, c_max)::int;
end $function$;
revoke execute on function private.return_loyalty_for_order(uuid) from public, anon, authenticated;

create or replace function private.reclaim_loyalty_for_order(p_order_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  c_max constant bigint := 2147483647;
  v_order record;
  r record;
  v_back int;
  v_balance int;
  v_total bigint := 0;
begin
  select o.id, o.order_number into v_order
    from public.orders o where o.id = p_order_id
     for update;
  if v_order.id is null then
    return 0;
  end if;

  for r in
    select t.branch_id, t.customer_id, sum(t.points::bigint) as back
      from public.loyalty_transactions t
     where t.reference_id = p_order_id and t.reference_type = 'order_return'
     group by t.branch_id, t.customer_id
    having sum(t.points::bigint) > 0
  loop
    v_back := least(r.back, c_max)::int;
    update public.loyalty_points lp
       set points_balance = lp.points_balance - v_back,
           lifetime_spent = least(lp.lifetime_spent::bigint + v_back, c_max)::int,
           updated_at = now()
     where lp.branch_id = r.branch_id and lp.customer_id = r.customer_id
       and lp.points_balance >= v_back
    returning lp.points_balance into v_balance;
    -- Spent again since they came back: reopening would hand the reward out for free.
    if not found then
      raise exception 'loyalty_points_already_spent'
        using hint = 'The points this order gave back have been spent since. Leave it cancelled and ring the order up again.';
    end if;

    insert into public.loyalty_transactions(
      branch_id, customer_id, points, balance_after, type, reference_type, reference_id, description
    ) values (
      r.branch_id, r.customer_id, -v_back, v_balance, 'adjusted', 'order_return', p_order_id,
      'Points spent again - order ' || v_order.order_number || ' reopened'
    );
    v_total := v_total + v_back;
  end loop;
  return least(v_total, c_max)::int;
end $function$;
revoke execute on function private.reclaim_loyalty_for_order(uuid) from public, anon, authenticated;

create or replace function private.orders_return_loyalty_on_cancel()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Only an order that never completed: points spent on a meal that was served stay spent, even if
  -- the money is refunded afterwards.
  if new.status in ('cancelled', 'refunded')
     and old.status not in ('completed', 'cancelled', 'refunded')
     and new.completed_at is null then
    perform private.return_loyalty_for_order(new.id);
  -- Taken out of cancelled/refunded: whatever came back goes out again (nothing, if nothing did).
  elsif old.status in ('cancelled', 'refunded')
     and new.status not in ('cancelled', 'refunded') then
    perform private.reclaim_loyalty_for_order(new.id);
  end if;
  return new;
end $function$;
revoke execute on function private.orders_return_loyalty_on_cancel() from public, anon, authenticated;

drop trigger if exists orders_return_loyalty_on_cancel on public.orders;
create trigger orders_return_loyalty_on_cancel
  after update on public.orders
  for each row when (new.status is distinct from old.status)
  execute function private.orders_return_loyalty_on_cancel();

-- The orders already cancelled that way kept the points (live: 6d3a764b, 100 + 50 in August).
select private.return_loyalty_for_order(o.id)
  from public.orders o
 where o.status in ('cancelled', 'refunded')
   and o.completed_at is null
   and exists (select 1 from public.loyalty_transactions t
                where t.reference_type = 'order' and t.reference_id = o.id and t.type = 'redeemed');

-- =============================================================================================
-- 4. Storefront reads, by branch. The diner's rows are "any customers row of theirs" at this
--    branch, which is right whether customers are one row per restaurant or one per branch.
-- =============================================================================================
create or replace function public.get_loyalty_balance(p_branch_id uuid)
 returns table(points_balance integer, lifetime_earned integer, lifetime_spent integer, tier text, scope text)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select least(sum(lp.points_balance::bigint), 2147483647)::int,
         least(sum(lp.lifetime_earned::bigint), 2147483647)::int,
         least(sum(lp.lifetime_spent::bigint), 2147483647)::int,
         -- One row is the normal case: its stored, server-graded tier. Two rows at one branch can
         -- only exist while customer records are being merged; grade their sum on this branch.
         case when count(*) = 1 then max(lp.tier::text)
              else public.tier_for_points(p_branch_id, least(sum(lp.lifetime_earned::bigint), 2147483647)::int)
         end,
         'branch'::text
    from public.loyalty_points lp
   where lp.branch_id = p_branch_id
     and lp.customer_id in (select c.id from public.customers c where c.user_id = auth.uid())
  having count(*) > 0;
$function$;

-- Every row of this branch, including points spent on an order that has not completed (the
-- balance already moved, so hiding the row left a balance the history could not explain) and the
-- points returned when such an order was cancelled.
create or replace function public.list_my_loyalty_transactions(p_branch_id uuid, p_limit integer default 20)
 returns setof public.loyalty_transactions
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select t.*
    from public.loyalty_transactions t
   where t.branch_id = p_branch_id
     and t.customer_id in (select c.id from public.customers c where c.user_id = auth.uid())
   order by t.created_at desc, t.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 200);
$function$;

create or replace function public.list_loyalty_rewards(p_branch_id uuid)
 returns table(id uuid, name text, description text, kind text, points_cost integer, value numeric, max_discount numeric, min_subtotal numeric, menu_item_id uuid, menu_item_name text, menu_item_image_url text, menu_item_price numeric)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select lr.id, lr.name, lr.description, lr.kind,
         lr.points_cost, lr.value, lr.max_discount,
         lr.min_subtotal, lr.menu_item_id,
         mi.name, mi.image_url, mi.price
    from public.loyalty_rewards lr
    left join public.menu_items mi on mi.id = lr.menu_item_id
   where lr.branch_id = p_branch_id
     and lr.is_active
     and (
       lr.kind <> 'free_item'
       or (mi.id is not null and mi.branch_id = p_branch_id and mi.is_active)
     )
   order by lr.sort_order, lr.points_cost, lr.name;
$function$;

-- Points buy named rewards through place-order; this free-form debit has had no caller since the
-- reward catalogue replaced the points slider, and it still took points without an order.
drop function if exists public.redeem_loyalty_points(uuid, integer, uuid);

-- Staff correction of one member's balance at one branch. The balance row and its ledger row move
-- in one transaction, so the history always explains the balance. Only the balance moves:
-- lifetime_earned (the tier) is what the member earned from orders, as with the birthday gift.
-- The reason is shown to the member in their points history.
create or replace function public.adjust_loyalty_points(
  p_branch_id uuid,
  p_customer_id uuid,
  p_delta integer,
  p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  c_max constant bigint := 2147483647;
  v_reason text := nullif(trim(p_reason), '');
  v_balance int;
  v_txn_id uuid;
begin
  if p_branch_id is null or not private.staff_has_capability(p_branch_id, 'loyalty.manage') then
    raise exception 'not_authorized';
  end if;
  if p_delta is null or p_delta = 0 or p_delta < -1000000 or p_delta > 1000000 then
    raise exception 'bad_delta:%', p_delta;
  end if;
  if v_reason is null or length(v_reason) > 200 then
    raise exception 'bad_reason';
  end if;
  -- A member of THIS branch: their customer record is filed here, or they hold points here. Another
  -- branch's customer id is refused, so a balance can never be created somewhere it does not belong.
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.branch_id = p_branch_id)
     and not exists (select 1 from public.loyalty_points lp
                      where lp.customer_id = p_customer_id and lp.branch_id = p_branch_id) then
    raise exception 'customer_not_in_branch';
  end if;

  if p_delta > 0 then
    insert into public.loyalty_points (branch_id, customer_id, points_balance)
    values (p_branch_id, p_customer_id, p_delta)
    on conflict (branch_id, customer_id) do update
      set points_balance = least(public.loyalty_points.points_balance::bigint + p_delta, c_max)::int,
          updated_at = now()
    returning points_balance into v_balance;
  else
    update public.loyalty_points lp
       set points_balance = lp.points_balance + p_delta,
           updated_at = now()
     where lp.branch_id = p_branch_id and lp.customer_id = p_customer_id
       and lp.points_balance + p_delta >= 0
    returning lp.points_balance into v_balance;
    if not found then
      raise exception 'insufficient_points';
    end if;
  end if;

  insert into public.loyalty_transactions (branch_id, customer_id, points, balance_after, type,
                                           reference_type, description)
  values (p_branch_id, p_customer_id, p_delta, v_balance, 'adjusted', 'manual', v_reason)
  returning id into v_txn_id;

  return jsonb_build_object('points_balance', v_balance, 'transaction_id', v_txn_id);
end $function$;
revoke execute on function public.adjust_loyalty_points(uuid, uuid, integer, text) from public, anon;
grant  execute on function public.adjust_loyalty_points(uuid, uuid, integer, text) to authenticated, service_role;

-- =============================================================================================
-- 6. Birthday gifts and the nightly re-grade, per branch.
-- =============================================================================================
alter table public.birthday_rewards drop constraint if exists birthday_rewards_customer_id_year_key;
alter table public.birthday_rewards drop constraint if exists birthday_rewards_customer_branch_year_key;
alter table public.birthday_rewards
  add constraint birthday_rewards_customer_branch_year_key unique (customer_id, branch_id, year);

create or replace function public.issue_birthday_rewards()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  c_max constant bigint := 2147483647;
  v_year int := extract(year from now())::int;
  v_today_md text := to_char(now(), 'MM-DD');
  v_count int := 0;
  r record;
  v_gift_id uuid;
  v_balance int;
begin
  -- Each branch a member belongs to (a balance row there, or the branch their customer record is
  -- filed under) gives its own gift, at its own amount. 0 = that branch has the gift switched off.
  for r in
    with today as (
      select c.id, c.branch_id, c.restaurant_id
        from public.customers c
       where c.birthday is not null and to_char(c.birthday, 'MM-DD') = v_today_md
    ),
    pairs as (
      select lp.customer_id, lp.branch_id from public.loyalty_points lp join today on today.id = lp.customer_id
      union
      select today.id, today.branch_id from today where today.branch_id is not null
    )
    select p.customer_id, p.branch_id, b.name as branch_name,
           (public.loyalty_settings_for(p.branch_id) ->> 'birthday_points')::int as points
      from pairs p
      join today on today.id = p.customer_id
      join public.branches b on b.id = p.branch_id and b.restaurant_id = today.restaurant_id and b.is_active
     where not exists (select 1 from public.birthday_rewards br
                        where br.customer_id = p.customer_id and br.branch_id = p.branch_id and br.year = v_year)
  loop
    continue when coalesce(r.points, 0) <= 0;

    insert into public.birthday_rewards (customer_id, branch_id, year, points)
    values (r.customer_id, r.branch_id, v_year, r.points)
    on conflict do nothing
    returning id into v_gift_id;
    continue when v_gift_id is null;

    -- Saturates like the award trigger: one balance at the ceiling must not abort everyone's gift.
    insert into public.loyalty_points (branch_id, customer_id, points_balance)
    values (r.branch_id, r.customer_id, r.points)
    on conflict (branch_id, customer_id) do update
      set points_balance = least(public.loyalty_points.points_balance::bigint + r.points, c_max)::int,
          updated_at = now()
    returning points_balance into v_balance;

    insert into public.loyalty_transactions (branch_id, customer_id, points, balance_after, type,
                                             reference_type, reference_id, description)
    values (r.branch_id, r.customer_id, r.points, v_balance, 'adjusted', 'birthday', v_gift_id,
            'Birthday gift');

    insert into public.notifications_outbox (channel, recipient_type, recipient_id, branch_id, template, variables)
    values ('email', 'customer', r.customer_id, r.branch_id, 'birthday_reward',
            jsonb_build_object('points', r.points, 'branch_name', r.branch_name));

    v_count := v_count + 1;
  end loop;
  return v_count;
end; $function$;

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
  -- materialized: the settings lookup runs once per branch, never once per member row, whatever
  -- join order the planner picks.
  with ladder as materialized (
    select b.id as branch_id,
           (s ->> 'silver')::int as silver,
           greatest((s ->> 'gold')::int, (s ->> 'silver')::int) as gold,
           greatest((s ->> 'platinum')::int, (s ->> 'gold')::int, (s ->> 'silver')::int) as platinum
      from public.branches b
     cross join lateral public.loyalty_settings_for(b.id) s
  )
  update public.loyalty_points lp
     set tier = (case
                   when lp.lifetime_earned >= l.platinum then 'platinum'
                   when lp.lifetime_earned >= l.gold     then 'gold'
                   when lp.lifetime_earned >= l.silver   then 'silver'
                   else 'bronze'
                 end)::loyalty_tier
    from ladder l
   where lp.branch_id = l.branch_id
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

-- The moved rows are graded on their branch's ladder now (live: no badge changes).
select public.recompute_loyalty_tiers();

-- =============================================================================================
-- 4/6. RLS and grants.
-- =============================================================================================
drop policy if exists loyalty_points_staff_read on public.loyalty_points;
create policy loyalty_points_staff_read on public.loyalty_points
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));

drop policy if exists loyalty_tx_staff_read on public.loyalty_transactions;
create policy loyalty_tx_staff_read on public.loyalty_transactions
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));

drop policy if exists loyalty_rewards_owner_delete on public.loyalty_rewards;
drop policy if exists loyalty_rewards_owner_insert on public.loyalty_rewards;
drop policy if exists loyalty_rewards_owner_update on public.loyalty_rewards;
drop policy if exists loyalty_rewards_staff_read on public.loyalty_rewards;
drop policy if exists loyalty_rewards_branch_read on public.loyalty_rewards;
drop policy if exists loyalty_rewards_branch_insert on public.loyalty_rewards;
drop policy if exists loyalty_rewards_branch_update on public.loyalty_rewards;
drop policy if exists loyalty_rewards_branch_delete on public.loyalty_rewards;

-- Diners never read the table: list_loyalty_rewards (SECURITY DEFINER) serves them active rewards.
create policy loyalty_rewards_branch_read on public.loyalty_rewards
  for select to authenticated
  using (private.staff_has_capability(branch_id, 'loyalty.manage')
      or private.staff_has_capability(branch_id, 'customers.view'));
create policy loyalty_rewards_branch_insert on public.loyalty_rewards
  for insert to authenticated
  with check (private.staff_has_capability(branch_id, 'loyalty.manage'));
create policy loyalty_rewards_branch_update on public.loyalty_rewards
  for update to authenticated
  using (private.staff_has_capability(branch_id, 'loyalty.manage'))
  with check (private.staff_has_capability(branch_id, 'loyalty.manage'));
create policy loyalty_rewards_branch_delete on public.loyalty_rewards
  for delete to authenticated
  using (private.staff_has_capability(branch_id, 'loyalty.manage'));

revoke all on public.loyalty_rewards from anon;
revoke truncate, references, trigger on public.loyalty_rewards from authenticated;
revoke all on public.birthday_rewards from anon;
revoke insert, update, delete, truncate, references, trigger on public.birthday_rewards from authenticated;
revoke all on public.loyalty_points from anon;
revoke all on public.loyalty_transactions from anon;
revoke references, trigger on public.loyalty_points from authenticated;
revoke references, trigger on public.loyalty_transactions from authenticated;

commit;
