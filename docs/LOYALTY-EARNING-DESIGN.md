# Loyalty — Points EARNING rules engine (design proposal)

Status: **PROPOSAL — not implemented.** Produced 2026-08-22 by a 12-agent research workflow
(live-schema audit + study of Square / Toast / Starbucks / Paytronix / Talon.One / Voucherify,
3 competing designs judged on owner usability, implementation risk and long-term flexibility).

## 0. What exists today

The Loyalty screen in the admin is the **spending** side only: a catalog of rewards
(`loyalty_rewards`, restaurant-scoped, 0 rows in production today).

The **earning** side is not configurable at all:

- `public.orders_on_complete_award_loyalty()` hardcodes `v_points := floor(coalesce(new.subtotal,0))::int`
  — 1 point per $1 of subtotal. There is no rate column, no settings table, no multiplier, no tier
  bonus, and no per-channel or per-item rule anywhere in the DB or the codebase.
- Tier thresholds are inlined in the same function (>=100000 platinum / >=30000 gold / >=10000 silver).
- The basis is **pre-discount** (`subtotal` and `discount_amount` are separate columns), so redeeming
  a reward does not reduce the points earned on that order.
- Guest orders never earn (`new.customer_id is null` -> return).
- The trigger is `AFTER UPDATE` only, so an order written already-completed never earns.
- Idempotency is claim-first against the partial unique index `loyalty_transactions_earned_once_per_order`.
- Second earning source: `issue_birthday_rewards()` (pg_cron jobid 3, `0 6 * * *`), hardcoded 500 points
  — and it writes **no** `loyalty_transactions` row and does **not** bump `lifetime_earned`.

## 1. Recommendation

Ship Design 1's shape — a small, closed, arithmetic-only rule table evaluated inside the existing `public.orders_on_complete_award_loyalty()` trigger — but fix its fatal flaw by making conditions COMPOSE within one rule instead of being mutually exclusive rule "shapes". One `loyalty_earn_rules` row carries every condition dimension as a nullable/empty-array column (min subtotal, days, time window, channels, branches, required items), all AND-ed, so "spend $50 on a Tuesday during happy hour at the Airport branch" is one row, not an impossible combination. A new `loyalty_settings` row per restaurant turns today's hard-coded `floor(subtotal)` into configurable `points_per_dollar` + earning basis, and a new `loyalty_earn_awards` table (PK `(order_id, rule_id)`) stores the per-rule breakdown, doubles as the idempotency claim for bonuses, and is the substrate for both the per-customer rolling caps and the reporting screen. `place-order` is not touched at all: earning stays entirely in the completion trigger, so checkout latency and the redemption path are unchanged. Exactly one `type='earned'` ledger row per order is still written (base + bonus summed), so the existing `loyalty_transactions_earned_once_per_order` partial unique index remains the single source of truth for "has this order paid out?" with zero index surgery.

### Why this shape

Design 1 won two of three judge lenses (owner usability 8, implementation risk 8) and only lost expressiveness (4) because its CHECK constraint made rule types mutually exclusive — that is a one-column-layout fix, not a redesign, whereas Design 2's expressiveness came from a JSON condition DSL that no restaurant owner can predict and Design 3 shipped three separate runtime aborts. Live-DB verification killed several assumptions in all three candidates: `loyalty_transactions_type_check` only permits `earned|redeemed|expired|adjusted`, so Design 2/3's new `bonus` ledger type would be rejected outright, and `loyalty_transactions_earned_once_per_order` is UNIQUE on `reference_id WHERE type='earned' AND reference_type='order'`, so a second earned row per order is impossible — which forces the correct answer (one summed ledger row + a separate breakdown table) rather than making it a preference. Design 3's `on conflict (customer_id, restaurant_id, branch_id)` does not match any index that exists (only `loyalty_points_pkey`, `loyalty_points_branch_scope_uidx`, `loyalty_points_brand_scope_uidx`) and would 42P10-abort every order completion; the verified trigger source already uses the two correct scope-branched inference clauses and my design copies them byte-for-byte. Design 3's post-discount basis `subtotal - discount_amount - promo_discount` double-counts the promo because `place-order/index.ts:705` writes `discount_amount: loyaltyDollarsOff + promoDiscount` AND `promo_discount` separately — the correct expression is `greatest(subtotal - discount_amount, 0)`. Two grafts the judges asked for turned out to be unnecessary after verification and were dropped: `list_my_loyalty_transactions` does NOT naively filter `completed_at is not null` (it is an OR-chain that admits non-order rows and orders that no longer exist), and `orders_after_status_update()` only ever SETS `completed_at`, never clears it, so clawback rows on refunded orders are already visible; and `private.guard_loyalty_reward_menu_item` lives in schema `private`, not `public`, so the new guard trigger mirrors it there.

## 2. Rule types in v1

| Rule | Owner-facing label | Example |
|---|---|---|
| `spend_threshold` | When the order is at least $X | "$50 club" — set Minimum order to 50.00, Reward to "+200 bonus points". An $80 order earns 80 base + 200 = 280 points. Set Cap per customer to 200 points / 30 days to stop it being farmed weekly. |
| `time_window` | Only on these days, between these times | "Happy hour double points" — tick Mon–Fri, 15:00 to 18:00, Reward "2x points". A $30 order at 16:20 local branch time earns 30 base + 30 bonus = 60. Overnight windows work: 21:00 to 02:00 is stored as-is and matched across midnight. |
| `item_purchase` | Only when the order contains these items | "Try the new burrito" — pick Chicken Burrito from the picker, Quantity at least 1, Reward "+150 bonus points". The picker resolves the name across every branch that carries it, so the rule fires at all of them even though menu_items rows are branch-scoped. |
| `channel` | Only for pickup / delivery / dine-in / QR orders | "Pickup pays" — tick Pickup only, Reward "1.5x points". Used as an extra condition on any of the above, e.g. pickup AND over $30. |
| `branch` | Only at these branches | "Airport launch week" — tick Airport, set Runs from/until to the launch dates, Reward "2x points". Points still land in the one brand-wide balance; only the earning is branch-restricted. |
| `combined` | (any of the above, ticked together on one rule) | "Tuesday big-spender lunch" — Minimum order 50.00 + Tue only + 11:00–14:00 + Airport branch, Reward "3x points". This is one row; it is the case Design 1's original shape constraint made impossible to store. |

## 3. Stacking rule (how the points add up)

Rules can only ADD points; a matching rule never reduces the base. Given one completed order: (1) BASE is always paid — floor(basis x points_per_dollar), where basis is orders.subtotal by default, or greatest(subtotal - discount_amount, 0) if the owner switches to post-discount. (2) Among all matching MULTIPLIER rules, exactly ONE applies — the largest multiplier, ties broken by highest priority, then oldest created_at. Its bonus is floor(base x (multiplier - 1)). Multipliers never compound and never sum: 2x and 1.5x matching together pay 2x, not 3x and not 2.5x. This mirrors Square's documented "a purchase can earn points for only one promotion". (3) EVERY matching FLAT-BONUS rule adds its points, all of them, evaluated in a fixed order (priority desc, then created_at asc) so caps and trimming are deterministic and two concurrent completions cannot invert lock order. (4) Each rule's own contribution is then clipped by its max_bonus_points_per_order and by its rolling per-customer cap (per_customer_cap_points within per_customer_cap_days, measured against loyalty_earn_awards). (5) A hard ceiling applies last: total awarded can never exceed floor(base x max_total_multiplier), default 3.0. Flat bonuses are trimmed first, from lowest priority upward; the multiplier bonus is trimmed last. (6) The order is credited with ONE loyalty_transactions row of type 'earned' whose points = base + bonus, keeping loyalty_transactions_earned_once_per_order as the sole idempotency claim; the per-rule split is recorded in loyalty_earn_awards keyed (order_id, rule_id). An order that bounces completed -> ready -> completed cannot double-award, because the claim insert returns no id the second time and the function exits before touching loyalty_points. (7) Worst case is therefore always printable in the editor as a closed form: "the most any single order can earn is 3x its base points".

## 4. Data model + SQL

```sql
-- =============================================================================
-- migration: loyalty_earning_rules_v1
-- Verified against live schema 2026-08-22. loyalty_scope is locked to 'brand',
-- so earning rules are RESTAURANT-scoped, like loyalty_rewards.
-- =============================================================================

-- 1. Per-restaurant base earning settings -------------------------------------
create table public.loyalty_settings (
  restaurant_id        uuid primary key references public.restaurants(id) on delete cascade,
  points_per_dollar    numeric(6,2) not null default 1.00
                       check (points_per_dollar > 0 and points_per_dollar <= 100),
  -- 'pre_discount' reproduces today's floor(orders.subtotal) exactly.
  earning_basis        text not null default 'pre_discount'
                       check (earning_basis in ('pre_discount','post_discount')),
  earn_on_staff_placed boolean not null default true,
  max_total_multiplier numeric(4,2) not null default 3.00
                       check (max_total_multiplier >= 1 and max_total_multiplier <= 10),
  claw_back_on_refund  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.loyalty_settings enable row level security;
-- Declared PER COMMAND, never FOR ALL: anon has no EXECUTE on
-- private.user_owns_restaurant, and a FOR ALL policy would hard-error anon reads.
create policy loyalty_settings_staff_read on public.loyalty_settings
  for select using (private.user_manages_restaurant(restaurant_id));
create policy loyalty_settings_owner_insert on public.loyalty_settings
  for insert with check (private.user_owns_restaurant(restaurant_id));
create policy loyalty_settings_owner_update on public.loyalty_settings
  for update using (private.user_owns_restaurant(restaurant_id))
              with check (private.user_owns_restaurant(restaurant_id));

insert into public.loyalty_settings (restaurant_id)
select id from public.restaurants on conflict (restaurant_id) do nothing;

-- 2. The rules ----------------------------------------------------------------
create table public.loyalty_earn_rules (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 80),

  -- REWARD: exactly one of the two.
  multiplier    numeric(4,2) check (multiplier > 1 and multiplier <= 10),
  bonus_points  integer      check (bonus_points > 0 and bonus_points <= 100000),

  -- CONDITIONS. Empty array / NULL / 0 = "unconstrained on this dimension".
  -- All non-empty conditions are AND-ed. This is the fix to Design 1: one rule
  -- may constrain any combination of dimensions at once.
  min_subtotal        numeric(10,2)     not null default 0 check (min_subtotal >= 0),
  days_of_week        smallint[]        not null default '{}'::smallint[]
                      check (days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]),
  start_time          time,
  end_time            time,
  channels            public.order_channel[] not null default '{}'::public.order_channel[],
  branch_ids          uuid[]            not null default '{}'::uuid[],
  -- menu_items are BRANCH-scoped (menu_items.branch_id NOT NULL, menu_categories
  -- has no restaurant_id), and 7/63 live order_items rows have a NULL
  -- menu_item_id (combo children). So the matcher runs on normalised item NAMES;
  -- the ids are kept only to redraw the picker and to run the tenancy guard.
  required_item_ids   uuid[]            not null default '{}'::uuid[],
  required_item_names text[]            not null default '{}'::text[],
  required_item_qty   integer           not null default 1 check (required_item_qty between 1 and 99),

  -- GUARDRAILS
  starts_at                  timestamptz,
  ends_at                    timestamptz,
  max_bonus_points_per_order integer check (max_bonus_points_per_order > 0),
  per_customer_cap_points    integer check (per_customer_cap_points > 0),
  per_customer_cap_days      integer check (per_customer_cap_days between 1 and 365),

  priority   integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint loyalty_earn_rules_one_reward
    check (num_nonnulls(multiplier, bonus_points) = 1),
  constraint loyalty_earn_rules_time_window
    check ((start_time is null) = (end_time is null) and start_time is distinct from end_time),
  constraint loyalty_earn_rules_dates
    check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint loyalty_earn_rules_cap_pair
    check ((per_customer_cap_points is null) = (per_customer_cap_days is null)),
  constraint loyalty_earn_rules_item_pair
    check (cardinality(required_item_ids) = 0 or cardinality(required_item_names) > 0)
);
create index loyalty_earn_rules_live_idx
  on public.loyalty_earn_rules (restaurant_id, is_active, priority desc, created_at);

alter table public.loyalty_earn_rules enable row level security;
create policy loyalty_earn_rules_staff_read on public.loyalty_earn_rules
  for select using (private.user_manages_restaurant(restaurant_id));
create policy loyalty_earn_rules_owner_insert on public.loyalty_earn_rules
  for insert with check (private.user_owns_restaurant(restaurant_id));
create policy loyalty_earn_rules_owner_update on public.loyalty_earn_rules
  for update using (private.user_owns_restaurant(restaurant_id))
              with check (private.user_owns_restaurant(restaurant_id));
create policy loyalty_earn_rules_owner_delete on public.loyalty_earn_rules
  for delete using (private.user_owns_restaurant(restaurant_id));

-- Cross-tenant guard, mirroring private.guard_loyalty_reward_menu_item().
create or replace function private.guard_loyalty_earn_rule_refs()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $$
begin
  if cardinality(new.branch_ids) > 0 and exists (
    select 1 from unnest(new.branch_ids) bid
     where not exists (select 1 from public.branches b
                        where b.id = bid and b.restaurant_id = new.restaurant_id)
  ) then
    raise exception 'loyalty_earn_rule_branch_foreign'
      using hint = 'Those branches belong to a different restaurant.';
  end if;
  if cardinality(new.required_item_ids) > 0 and exists (
    select 1 from unnest(new.required_item_ids) iid
     where not exists (select 1 from public.menu_items mi
                         join public.branches b on b.id = mi.branch_id
                        where mi.id = iid and b.restaurant_id = new.restaurant_id)
  ) then
    raise exception 'loyalty_earn_rule_item_foreign'
      using hint = 'That menu item belongs to a different restaurant.';
  end if;
  new.required_item_names := coalesce(
    (select array_agg(distinct lower(btrim(n))) from unnest(new.required_item_names) n
      where btrim(coalesce(n,'')) <> ''), '{}'::text[]);
  new.updated_at := now();
  return new;
end $$;
create trigger loyalty_earn_rules_guard
  before insert or update on public.loyalty_earn_rules
  for each row execute function private.guard_loyalty_earn_rule_refs();

-- 3. Per-rule breakdown: audit + reporting + rolling-cap substrate -------------
create table public.loyalty_earn_awards (
  order_id      uuid not null references public.orders(id) on delete cascade,
  rule_id       uuid not null references public.loyalty_earn_rules(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  points        integer not null check (points >= 0),
  awarded_at    timestamptz not null default now(),
  primary key (order_id, rule_id)
);
create index loyalty_earn_awards_rule_idx on public.loyalty_earn_awards (rule_id, awarded_at desc);
create index loyalty_earn_awards_cap_idx  on public.loyalty_earn_awards (customer_id, rule_id, awarded_at desc);
alter table public.loyalty_earn_awards enable row level security;
create policy loyalty_earn_awards_staff_read on public.loyalty_earn_awards
  for select using (private.user_manages_restaurant(restaurant_id));
-- No write policies: only the SECURITY DEFINER trigger inserts here.

-- 4. Clawback debt. loyalty_points_points_balance_check forbids a negative
--    balance, so a refund larger than the current balance becomes a debt that
--    the next earn pays off first.
alter table public.loyalty_points
  add column points_owed integer not null default 0 check (points_owed >= 0);

-- 5. Evaluator. ONE set of predicates, exposed as boolean columns so the live
--    trigger and the admin "Test it" preview cannot drift apart, and so the
--    preview can say WHY a rule did not fire.
create or replace function private.evaluate_earn_rules(
  p_restaurant_id uuid,
  p_branch_id     uuid,
  p_subtotal      numeric,
  p_at            timestamptz,
  p_channel       public.order_channel,
  p_items         jsonb          -- [{"name":"large pizza","qty":2}, ...]
) returns table (
  rule_id uuid, rule_name text, multiplier numeric, bonus_points integer,
  max_bonus_points_per_order integer, per_customer_cap_points integer,
  per_customer_cap_days integer, priority integer, created_at timestamptz,
  ok_dates boolean, ok_min boolean, ok_days boolean, ok_time boolean,
  ok_channel boolean, ok_branch boolean, ok_items boolean, matched boolean
) language sql stable security definer
set search_path to 'public','pg_temp' as $$
  with ctx as (
    select (p_at at time zone b.timezone) as local_ts,
           extract(dow from (p_at at time zone b.timezone))::smallint as dow,
           (p_at at time zone b.timezone)::time as tod
      from public.branches b where b.id = p_branch_id
  ),
  items as (
    select lower(btrim(x->>'name')) as nm, coalesce((x->>'qty')::int, 1) as qty
      from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x
  ),
  ev as (
    select r.id, r.name, r.multiplier, r.bonus_points, r.max_bonus_points_per_order,
           r.per_customer_cap_points, r.per_customer_cap_days, r.priority, r.created_at,
           (r.starts_at is null or p_at >= r.starts_at)
             and (r.ends_at is null or p_at < r.ends_at)                       as ok_dates,
           (p_subtotal >= r.min_subtotal)                                       as ok_min,
           (cardinality(r.days_of_week) = 0 or c.dow = any(r.days_of_week))     as ok_days,
           (r.start_time is null
              or (r.start_time <  r.end_time and c.tod >= r.start_time and c.tod < r.end_time)
              or (r.start_time >  r.end_time and (c.tod >= r.start_time or c.tod < r.end_time)))
                                                                                as ok_time,
           (cardinality(r.channels)   = 0 or p_channel  = any(r.channels))      as ok_channel,
           (cardinality(r.branch_ids) = 0 or p_branch_id = any(r.branch_ids))   as ok_branch,
           (cardinality(r.required_item_names) = 0 or coalesce(
              (select sum(i.qty) from items i where i.nm = any(r.required_item_names)), 0)
              >= r.required_item_qty)                                           as ok_items
      from public.loyalty_earn_rules r cross join ctx c
     where r.restaurant_id = p_restaurant_id and r.is_active
  )
  select ev.*, (ok_dates and ok_min and ok_days and ok_time
                and ok_channel and ok_branch and ok_items) as matched
    from ev order by ev.priority desc, ev.created_at;
$$;

-- 6. Award calculator. Returns {base, bonus, total, lines[], why[]}.
create or replace function private.compute_earn_award(
  p_restaurant_id uuid, p_branch_id uuid, p_customer_id uuid,
  p_subtotal numeric, p_discount numeric, p_at timestamptz,
  p_channel public.order_channel, p_items jsonb, p_staff_placed boolean
) returns jsonb language plpgsql stable security definer
set search_path to 'public','pg_temp' as $$
declare
  s      public.loyalty_settings%rowtype;
  v_basis numeric; v_base int; v_ceiling int;
  v_bonus int := 0; v_pts int; v_used int;
  v_best record; r record;
  v_lines jsonb := '[]'::jsonb; v_why jsonb := '[]'::jsonb;
begin
  select * into s from public.loyalty_settings where restaurant_id = p_restaurant_id;
  if not found then
    s.points_per_dollar := 1.00; s.earning_basis := 'pre_discount';
    s.earn_on_staff_placed := true; s.max_total_multiplier := 3.00;
  end if;

  -- orders.discount_amount ALREADY includes promo_discount (place-order writes
  -- discount_amount = loyaltyDollarsOff + promoDiscount), so promo is not
  -- subtracted a second time here.
  v_basis := case when s.earning_basis = 'post_discount'
                  then greatest(coalesce(p_subtotal,0) - coalesce(p_discount,0), 0)
                  else coalesce(p_subtotal,0) end;
  v_base := floor(v_basis * s.points_per_dollar)::int;

  if p_staff_placed and not s.earn_on_staff_placed then
    return jsonb_build_object('base',0,'bonus',0,'total',0,'lines','[]'::jsonb,
      'why', jsonb_build_array('Staff-placed orders do not earn points.'));
  end if;
  if v_base <= 0 then
    return jsonb_build_object('base',0,'bonus',0,'total',0,'lines','[]'::jsonb,'why',v_why);
  end if;
  v_ceiling := floor(v_base * s.max_total_multiplier)::int;

  -- (a) Exactly ONE multiplier rule wins: biggest multiplier, then priority,
  --     then oldest. Matches Square's "a purchase can earn points for only one
  --     promotion" and keeps the owner-facing maths printable.
  select e.* into v_best
    from private.evaluate_earn_rules(p_restaurant_id, p_branch_id, p_subtotal,
                                     p_at, p_channel, p_items) e
   where e.matched and e.multiplier is not null
   order by e.multiplier desc, e.priority desc, e.created_at
   limit 1;
  if v_best.rule_id is not null then
    v_pts := floor(v_base * (v_best.multiplier - 1))::int;
    v_pts := least(v_pts, coalesce(v_best.max_bonus_points_per_order, v_pts));
    if v_best.per_customer_cap_points is not null and p_customer_id is not null then
      select coalesce(sum(a.points),0) into v_used from public.loyalty_earn_awards a
       where a.customer_id = p_customer_id and a.rule_id = v_best.rule_id
         and a.awarded_at >= p_at - make_interval(days => v_best.per_customer_cap_days);
      v_pts := greatest(least(v_pts, v_best.per_customer_cap_points - v_used), 0);
    end if;
    if v_pts > 0 then
      v_bonus := v_pts;
      v_lines := v_lines || jsonb_build_object('rule_id', v_best.rule_id,
                   'name', v_best.rule_name, 'kind','multiplier','points', v_pts);
    end if;
  end if;

  -- (b) EVERY matching flat-bonus rule adds, in a FIXED order (priority desc,
  --     created_at asc) so caps and the ceiling trim deterministically and two
  --     concurrent completions can never invert lock order.
  for r in select e.* from private.evaluate_earn_rules(p_restaurant_id, p_branch_id,
                            p_subtotal, p_at, p_channel, p_items) e
            where e.matched and e.bonus_points is not null
            order by e.priority desc, e.created_at
  loop
    v_pts := least(r.bonus_points, coalesce(r.max_bonus_points_per_order, r.bonus_points));
    if r.per_customer_cap_points is not null and p_customer_id is not null then
      select coalesce(sum(a.points),0) into v_used from public.loyalty_earn_awards a
       where a.customer_id = p_customer_id and a.rule_id = r.rule_id
         and a.awarded_at >= p_at - make_interval(days => r.per_customer_cap_days);
      v_pts := greatest(least(v_pts, r.per_customer_cap_points - v_used), 0);
    end if;
    v_pts := least(v_pts, greatest(v_ceiling - v_base - v_bonus, 0));  -- ceiling
    if v_pts > 0 then
      v_bonus := v_bonus + v_pts;
      v_lines := v_lines || jsonb_build_object('rule_id', r.rule_id,
                   'name', r.rule_name, 'kind','bonus','points', v_pts);
    end if;
  end loop;

  v_bonus := least(v_bonus, greatest(v_ceiling - v_base, 0));
  return jsonb_build_object('base', v_base, 'bonus', v_bonus,
                            'total', v_base + v_bonus, 'lines', v_lines, 'why', v_why);
end $$;

-- 7. Rewrite of the live award trigger. Same claim-first shape, same two
--    scope-branched ON CONFLICT inference clauses, same single 'earned' row.
create or replace function public.orders_on_complete_award_loyalty()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $$
declare
  v_award jsonb; v_points int; v_owed int; v_applied int;
  v_balance int; v_lifetime int; v_tier loyalty_tier;
  v_scope text; v_restaurant_id uuid; v_txn_id uuid; v_line jsonb;
begin
  if new.status <> 'completed' or old.status = 'completed' then return new; end if;
  if new.customer_id is null then return new; end if;

  select b.restaurant_id, r.loyalty_scope into v_restaurant_id, v_scope
    from public.branches b join public.restaurants r on r.id = b.restaurant_id
   where b.id = new.branch_id;

  v_award := private.compute_earn_award(
    v_restaurant_id, new.branch_id, new.customer_id, coalesce(new.subtotal,0),
    coalesce(new.discount_amount,0), coalesce(new.created_at, now()), new.channel,
    coalesce((select jsonb_agg(jsonb_build_object('name', oi.item_name, 'qty', oi.quantity))
                from public.order_items oi where oi.order_id = new.id), '[]'::jsonb),
    new.staff_id is not null);
  v_points := coalesce((v_award->>'total')::int, 0);
  if v_points <= 0 then return new; end if;

  -- Pay off any clawback debt before crediting.
  select coalesce(points_owed,0) into v_owed from public.loyalty_points
   where customer_id = new.customer_id
     and ((v_scope = 'brand' and restaurant_id = v_restaurant_id and branch_id is null)
       or (v_scope <> 'brand' and branch_id = new.branch_id));
  v_applied := greatest(v_points - coalesce(v_owed,0), 0);

  insert into public.loyalty_transactions(
    branch_id, restaurant_id, customer_id, points, balance_after, type,
    reference_type, reference_id, description
  ) values (
    case when v_scope = 'brand' then null else new.branch_id end,
    v_restaurant_id, new.customer_id, v_applied, 0, 'earned', 'order', new.id,
    case when (v_award->>'bonus')::int > 0
         then 'Earned from order ' || new.order_number || ' (' || (v_award->>'base')
              || ' base + ' || (v_award->>'bonus') || ' bonus)'
         else 'Earned from order ' || new.order_number end
  )
  on conflict do nothing
  returning id into v_txn_id;
  if v_txn_id is null then return new; end if;   -- already awarded for this order

  for v_line in select * from jsonb_array_elements(v_award->'lines') loop
    insert into public.loyalty_earn_awards(order_id, rule_id, restaurant_id, customer_id, points)
    values (new.id, (v_line->>'rule_id')::uuid, v_restaurant_id, new.customer_id,
            (v_line->>'points')::int)
    on conflict (order_id, rule_id) do nothing;
  end loop;

  if v_scope = 'brand' then
    insert into public.loyalty_points(restaurant_id, branch_id, customer_id,
                                      points_balance, lifetime_earned, points_owed)
    values (v_restaurant_id, null, new.customer_id, v_applied, v_applied, 0)
    on conflict (restaurant_id, customer_id) where branch_id is null and restaurant_id is not null do update
      set points_balance = public.loyalty_points.points_balance + v_applied,
          lifetime_earned = public.loyalty_points.lifetime_earned + v_applied,
          points_owed = greatest(public.loyalty_points.points_owed - v_points, 0),
          updated_at = now()
    returning points_balance, lifetime_earned into v_balance, v_lifetime;
  else
    insert into public.loyalty_points(branch_id, customer_id, points_balance,
                                      lifetime_earned, restaurant_id, points_owed)
    values (new.branch_id, new.customer_id, v_applied, v_applied, v_restaurant_id, 0)
    on conflict (branch_id, customer_id) where branch_id is not null do update
      set points_balance = public.loyalty_points.points_balance + v_applied,
          lifetime_earned = public.loyalty_points.lifetime_earned + v_applied,
          points_owed = greatest(public.loyalty_points.points_owed - v_points, 0),
          updated_at = now()
    returning points_balance, lifetime_earned into v_balance, v_lifetime;
  end if;

  v_tier := public.tier_for_lifetime_points(v_lifetime)::loyalty_tier;
  if v_scope = 'brand' then
    update public.loyalty_points set tier = v_tier
     where restaurant_id = v_restaurant_id and customer_id = new.customer_id and branch_id is null;
  else
    update public.loyalty_points set tier = v_tier
     where branch_id = new.branch_id and customer_id = new.customer_id;
  end if;

  update public.loyalty_transactions set balance_after = v_balance where id = v_txn_id;
  return new;
end $$;

-- 8. Clawback on refund / cancellation. Separate trigger, mutually exclusive
--    WHEN clause so it can never race the award trigger on the same row.
create or replace function public.orders_on_reverse_claw_back_loyalty()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $$
declare
  v_scope text; v_rest uuid; v_earned int; v_take int; v_bal int; v_owed int;
begin
  if new.status not in ('refunded','cancelled') or old.status not in ('completed') then
    return new;
  end if;
  select b.restaurant_id, r.loyalty_scope into v_rest, v_scope
    from public.branches b join public.restaurants r on r.id = b.restaurant_id
   where b.id = new.branch_id;
  if not exists (select 1 from public.loyalty_settings
                  where restaurant_id = v_rest and claw_back_on_refund) then
    return new;
  end if;
  select t.points into v_earned from public.loyalty_transactions t
   where t.reference_type = 'order' and t.reference_id = new.id and t.type = 'earned';
  if coalesce(v_earned,0) <= 0 then return new; end if;

  update public.loyalty_points lp
     set points_balance = greatest(lp.points_balance - v_earned, 0),
         points_owed    = lp.points_owed + greatest(v_earned - lp.points_balance, 0),
         updated_at     = now()
   where lp.customer_id = new.customer_id
     and ((v_scope = 'brand' and lp.restaurant_id = v_rest and lp.branch_id is null)
       or (v_scope <> 'brand' and lp.branch_id = new.branch_id))
  returning lp.points_balance into v_bal;
  if not found then return new; end if;

  insert into public.loyalty_transactions(
    branch_id, restaurant_id, customer_id, points, balance_after, type,
    reference_type, reference_id, description)
  values (case when v_scope = 'brand' then null else new.branch_id end,
          v_rest, new.customer_id, -v_earned, v_bal, 'adjusted', 'order', new.id,
          'Points reversed — order ' || new.order_number || ' was ' || new.status);
  return new;
end $$;
create trigger orders_claw_back_loyalty_on_reverse
  after update on public.orders for each row
  when (new.status is distinct from old.status)
  execute function public.orders_on_reverse_claw_back_loyalty();

-- 9. Owner-facing dry run ("Test it"). Owner-gated; writes nothing.
create or replace function public.preview_earn_award(
  p_branch_id uuid, p_subtotal numeric, p_at timestamptz,
  p_channel public.order_channel, p_item_names text[]
) returns jsonb language plpgsql stable security definer
set search_path to 'public','pg_temp' as $$
declare v_rest uuid; v_items jsonb;
begin
  select restaurant_id into v_rest from public.branches where id = p_branch_id;
  if v_rest is null or not private.user_owns_restaurant(v_rest) then
    raise exception 'not_authorized';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', n, 'qty', 1)), '[]'::jsonb)
    into v_items from unnest(coalesce(p_item_names,'{}'::text[])) n;
  return private.compute_earn_award(v_rest, p_branch_id, null, p_subtotal, 0,
                                    p_at, p_channel, v_items, false)
       || jsonb_build_object('rules', (
            select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb)
              from private.evaluate_earn_rules(v_rest, p_branch_id, p_subtotal,
                                               p_at, p_channel, v_items) e));
end $$;

-- 10. Diner-facing "Ways to earn". RPC only — no public SELECT policy on the
--     rules table, so caps, budgets and priorities never leak to the storefront.
create or replace function public.list_ways_to_earn(p_branch_id uuid)
returns table (name text, multiplier numeric, bonus_points integer,
               days_of_week smallint[], start_time time, end_time time,
               min_subtotal numeric, item_names text[])
language sql stable security definer
set search_path to 'public','pg_temp' as $$
  select r.name, r.multiplier, r.bonus_points, r.days_of_week, r.start_time,
         r.end_time, r.min_subtotal, r.required_item_names
    from public.loyalty_earn_rules r
    join public.branches b on b.id = p_branch_id and b.restaurant_id = r.restaurant_id
   where r.is_active
     and (r.starts_at is null or now() >= r.starts_at)
     and (r.ends_at   is null or now() <  r.ends_at)
     and (cardinality(r.branch_ids) = 0 or p_branch_id = any(r.branch_ids))
   order by r.priority desc, r.created_at;
$$;

grant execute on function public.preview_earn_award(uuid, numeric, timestamptz,
  public.order_channel, text[]) to authenticated;
grant execute on function public.list_ways_to_earn(uuid) to anon, authenticated;
revoke all on function private.evaluate_earn_rules(uuid, uuid, numeric, timestamptz,
  public.order_channel, jsonb) from public, anon, authenticated;
revoke all on function private.compute_earn_award(uuid, uuid, uuid, numeric, numeric,
  timestamptz, public.order_channel, jsonb, boolean) from public, anon, authenticated;
```

## 5. Admin UX

New owner-only page at /b/[branchId]/loyalty/earning, reached by a two-tab strip added to the existing Loyalty screen ("Rewards" | "How points are earned"). The same owner gate as loyalty/page.tsx:26-39 is copied verbatim (platform admin OR staff_members role='owner' status='active' for this restaurant), because RLS refuses a manager's write silently and the page must not look like it worked.

TOP CARD — "The basics". Two fields and two switches, no jargon: "Points per $1 spent" (number, default 1); "Count the discount?" (radio: "Points on the full order total (before discounts)" / "Points on what they actually paid"); "Staff-entered orders earn points" (switch, on); "Most an order can ever earn" (dropdown: 2x / 3x / 5x the normal rate, default 3x). Under it, one live sentence: "A $40 order earns 40 points today, and never more than 120 points however many rules match."

RULES LIST. Cards, newest-effective first, each showing a Badge (Live / Scheduled / Ended / Paused), the generated one-sentence description, "Earned N times, M points in the last 30 days" pulled from loyalty_earn_awards, and up/down chevrons for priority (the admin has no drag-and-drop anywhere — copy move() from happy-hours-manager.tsx:94-116). Pause / Edit / Delete icon buttons.

EDITOR (inline Card, same Field + .input idiom as rewards-manager.tsx:387-394). Section 1 "What they get": radio "Multiply their points" (x, 1.25-10) or "Give extra points" (flat number). Section 2 "When it applies" — every condition is a tickbox that reveals its control, and leaving a box unticked means "no limit on this": [ ] Order is at least $__ ; [ ] Only on certain days (the 7 day chips from happy-hours-manager, DAY_LABELS at :33) ; [ ] Only between __ and __ (defaults 15:00-18:00, with the note "times are this branch's local time" — branches.timezone) ; [ ] Only for [pickup][delivery][dine-in][QR] ; [ ] Only at [branch checkboxes] ; [ ] Only when the order contains [item picker] at least [1] of. The item picker groups by item NAME across the restaurant and shows "on the menu at 2 of 3 branches" so an owner learns why it might not fire everywhere. Section 3 "Limits" (collapsed by default): Runs from / until; "Most bonus points from this rule per order"; "Most a customer can get from this rule: __ points every __ days".

FOOTER OF THE EDITOR, always visible, three things: (a) the same generated sentence the list shows — "Between 3pm and 6pm, Mon-Fri, orders earn 2x points" — regenerated on every keystroke by one shared describeEarnRule() so the list, the editor and the diner's "Ways to earn" can never disagree; (b) an inline amber warning when the new rule overlaps a live one, naming it: "This overlaps 'Happy hour double points'. Only the bigger multiplier will apply."; (c) a "Test it" row — subtotal, date/time, channel, items — calling public.preview_earn_award and printing the full arithmetic: "40 base + 40 (Happy hour double points) = 80 points". When a rule does NOT fire, the same panel says which condition failed in owner English ("the order was $22, this rule needs $50").

COST PANEL, above the rules list: "If these rules had been running for the last 30 days you would have given away about 14,300 extra points — roughly $143 of rewards" — backtested by replaying completed orders through private.compute_earn_award. The dollar figure is DERIVED from the cheapest reward in loyalty_rewards (points_cost vs its dollar value), never asked for as a separate number the owner would have to keep in sync.

ERRORS. Every write does .select('id') and treats zero rows as denied (the DENIED constant at rewards-manager.tsx:368), and describeError() gains loyalty_earn_rule_branch_foreign, loyalty_earn_rule_item_foreign, loyalty_earn_rules_one_reward, loyalty_earn_rules_time_window and loyalty_earn_rules_cap_pair. Error text uses text-danger, never text-destructive — that token does not exist in the Tailwind config and renders invisible (the existing bug at loyalty/page.tsx:46, promos-manager.tsx:120, happy-hours-manager.tsx:140).

DINER SIDE. A "Ways to earn points" list on the account loyalty screen and a "You'll earn N points" line at checkout, both from list_ways_to_earn / a client mirror of the base rate, replacing the hardcoded "1 point per $1" copy.

## 6. Files and functions to change

- DB (new, verified absent): public.loyalty_settings, public.loyalty_earn_rules, public.loyalty_earn_awards tables; column public.loyalty_points.points_owed
- DB (rewrite, verified present): public.orders_on_complete_award_loyalty() — currently sets v_points := floor(coalesce(new.subtotal,0))::int and inlines the tier thresholds; replace with private.compute_earn_award(...) and public.tier_for_lifetime_points(integer) RETURNS text. Its two ON CONFLICT inference clauses — (restaurant_id, customer_id) WHERE branch_id is null and restaurant_id is not null, and (branch_id, customer_id) WHERE branch_id is not null — are copied unchanged; they are the only ones matching loyalty_points_brand_scope_uidx / loyalty_points_branch_scope_uidx
- DB (new functions): private.evaluate_earn_rules(uuid,uuid,numeric,timestamptz,order_channel,jsonb), private.compute_earn_award(...), private.guard_loyalty_earn_rule_refs() (mirrors private.guard_loyalty_reward_menu_item(), which lives in schema private, NOT public), public.preview_earn_award(...), public.list_ways_to_earn(uuid), public.orders_on_reverse_claw_back_loyalty()
- DB (unchanged, deliberately): trigger orders_award_loyalty_on_complete on public.orders; index loyalty_transactions_earned_once_per_order; constraint loyalty_transactions_type_check (only earned|redeemed|expired|adjusted are legal — no new ledger type is introduced); public.list_my_loyalty_transactions(uuid,integer) (its OR-chain already admits type='adjusted' rows, and public.orders_after_status_update() only ever SETS completed_at, never clears it, so clawbacks stay visible); public.get_loyalty_balance(uuid); public.refund_order(uuid,numeric,text)
- D:\Projects\restaurant_white_label\supabase\functions\place-order\index.ts — NO CHANGE. Earning stays in the completion trigger; the redemption block (:585-670), the taxableBase line (:674) and the non-atomic debit (:762-776) are untouched
- D:\Projects\restaurant_white_label\apps\admin\src\app\b\[branchId]\loyalty\page.tsx — extract the owner gate at :26-39 into a shared helper reused by the new route; add the two-tab strip; fix text-destructive -> text-danger at :46
- D:\Projects\restaurant_white_label\apps\admin\src\app\b\[branchId]\loyalty\earning\page.tsx — NEW. Owner-gated server page loading loyalty_settings, loyalty_earn_rules, the restaurant's branches, and menu_items grouped by name across all branches
- D:\Projects\restaurant_white_label\apps\admin\src\app\b\[branchId]\loyalty\earning\_components\earn-rules-manager.tsx — NEW. Client component; copies the .select('id')/DENIED pattern from rewards-manager.tsx:97-142, the Field helper at :387-394, and the chevron move() reorder from happy-hours-manager.tsx:94-116 and DAY_LABELS at :33
- D:\Projects\restaurant_white_label\apps\admin\src\app\b\[branchId]\loyalty\_components\rewards-manager.tsx — extend describeError() at :375-385 with the five new constraint names; add the cross-link to the earning tab in the multi-branch banner at :192-197
- D:\Projects\restaurant_white_label\packages\database\src\queries\loyalty.ts — add listEarnRules(), listWaysToEarn(), previewEarnAward() and the shared pure describeEarnRule() sentence generator, next to the existing loyaltyRewardDiscount() client mirror at :114-133. redeemLoyaltyPoints() at :52-65 is dead (no callers) and should be deleted in the same pass
- D:\Projects\restaurant_white_label\apps\web\src\app\r\[restaurant]\[branch]\account\loyalty\_components\loyalty-view.tsx — the hardcoded 1-point-per-$1 copy in "How points work" and the repeat of the earn rate must read points_per_dollar; add a "Ways to earn" list from list_ways_to_earn
- D:\Projects\restaurant_white_label\apps\web\src\app\r\[restaurant]\[branch]\checkout\_components\checkout-view.tsx — add the "You'll earn N points" line beside the existing Redeem section
- D:\Projects\restaurant_white_label\apps\admin\src\components\sidebar.tsx:99 — the owner-gated { href: `${base}/loyalty`, label: 'Loyalty rewards' } entry becomes 'Loyalty' (the page now has two tabs)
- D:\Projects\restaurant_white_label\docs\ADMIN-GUIDE-TH.md — add the earning-rules section; the guide currently documents only the reward catalog

## 7. Phasing

1. Phase 1 — Make today's behaviour data, and stop the leak. Create loyalty_settings (seeded 1.00 / pre_discount for every existing restaurant, so nothing changes on day one), add loyalty_points.points_owed, rewrite orders_on_complete_award_loyalty() to read settings and call tier_for_lifetime_points(), and add the clawback trigger. Ship the "The basics" card only. Verification: complete an order and confirm one 'earned' row with the same points as before; bounce it completed -> ready -> completed and confirm no second row; refund it and confirm one 'adjusted' row appears in the diner's history.

2. Phase 2 — The rules themselves. loyalty_earn_rules + loyalty_earn_awards + the guard trigger + evaluate/compute functions, the owner editor with all six condition tickboxes, the generated sentence, the overlap warning and describeError() mappings. Verification: build one rule of each of the owner's three kinds, place a qualifying and a near-miss order for each, and check the loyalty_earn_awards breakdown matches the ledger row.

3. Phase 3 — Make it predictable. The "Test it" dry-run panel (preview_earn_award) including the why-it-did-NOT-fire reasons, the 30-day backtested cost estimate derived from the reward catalog, and the per-rule performance counts on each card.

4. Phase 4 — Tell the diner. list_ways_to_earn on the account loyalty screen, the "You'll earn N points" line at checkout, and the Thai admin guide section. Deliberately last: a diner shown a rule the owner is still tuning is worse than a diner shown nothing.

5. OUT OF v1, explicitly: tier-based multipliers (gold earns 1.5x) — tiers exist but are cosmetic today; first-order and signup bonuses (with OTP-less phone auth, phone is not identity, so a signup bonus is a farming primitive); referral and streak/visit-count rules; global campaign budgets ("stop after 100,000 points") — the per-customer rolling cap plus the 3x ceiling bound the exposure without a hot contended counter row; points expiry; category-based rules (menu_categories.branch_id is NOT NULL with no restaurant_id, so a category rule would silently cover one branch); and any per-branch override of the base rate.

## 8. Open questions for the owner

- Do points come off the full order or off what the customer actually paid? Toast earns on pre-tax, non-discounted amounts and that is what we do today (floor(orders.subtotal)), but it means a diner who redeems a $10 reward still earns points on the $10 they did not pay. Switching to post-discount is one setting, but it changes every existing customer's earn rate the day it flips.

- When a refunded order's points have already been spent on a reward, do we (a) leave the customer with a negative-equivalent debt that their next order pays off — what the design does — (b) write it off, or (c) void the reward they redeemed? (a) is honest accounting but will produce "why did I only get 5 points" support tickets.

- Should a happy-hour earning rule be judged by when the customer ORDERED or when the kitchen COMPLETED the order? The design uses order-placed time, because that is what the diner saw on the menu — but for a scheduled pre-order placed at 9am for a 5pm pickup, that means the 5pm happy-hour rule does not fire. Which do you want for pre-orders?

- Should orders your staff enter (phone orders, POS) earn points at all? The switch defaults to yes, which means a staff member can enter an order under a regular's phone number and mint points with no card present.

- What is one point actually worth to you? We can derive it from the cheapest reward in your catalog for the cost estimate, but if you intend points to be worth something different from what the catalog implies, the "you gave away $143" number will be wrong.

- Loyalty is one balance across all your branches (locked decision). A branch-restricted earning rule therefore means "earn faster here, spend anywhere". Is a branch manager allowed to ask for one, or do earning rules stay a head-office-only lever? Today only the owner can create them.

- Do you want a hard stop — "this promotion ends after 100,000 bonus points across all customers" — or are the per-customer cap and the 3x-per-order ceiling enough? A global budget needs a single contended counter row on the order-completion path, which is the one place we do not want lock contention.

## 9. Risks

- The award trigger runs INSIDE the transaction that marks an order completed. Any exception raised by the new evaluator — a bad interval, a null timezone, an arithmetic overflow — rolls back the completion itself, so the kitchen cannot close the ticket. Mitigation: every condition is arithmetic or array containment (no subqueries in CHECK constraints, unlike Design 1's rejected days_of_week check), the item lookup is a single indexed aggregate over order_items, and phase 1 ships the refactor with zero rules configured so the new code path is exercised on real traffic before any rule exists.

- The evaluator adds two extra table scans per completion (loyalty_earn_rules for the restaurant, order_items for the order). With a handful of rules this is sub-millisecond, but loyalty_earn_rules_live_idx must exist before any tenant has more than a few dozen rules, and the per-customer cap query must stay on loyalty_earn_awards_cap_idx.

- The per-customer rolling cap reads loyalty_earn_awards inside the same transaction that writes it. Two orders completing concurrently for the same customer can each see the other's pre-state and both award up to the cap, overshooting it by one order's worth. Accepted: the 3x per-order ceiling bounds the damage, and taking a lock here would serialise order completion.

- Item rules match on normalised item NAME, not menu_item_id, because menu_items are branch-scoped and 7 of 63 live order_items rows have a NULL menu_item_id. Two genuinely different items sharing a name at different branches will both fire the rule, and renaming an item silently breaks the rule. The editor must warn on save; a stored-name mismatch is invisible otherwise.

- Changing points_per_dollar changes the earn rate for everyone immediately, including customers mid-way to a reward. There is no grandfathering. The setting needs a confirm dialog stating the current base rate and the new one.

- The clawback trigger fires on completed -> refunded/cancelled only. refund_order() only moves orders.status when p_amount >= v_order.total, so a partial refund claws back nothing today. That is existing behaviour, not a regression, but the owner will read it as a bug the first time they issue a $5 refund on a $60 order.

- loyalty_points_points_balance_check forbids a negative balance, so clawback becomes debt in points_owed. If that column is ever ignored by a future write path, the debt silently vanishes and the customer keeps points for a refunded order.

- Bonus points are a real, unbudgeted liability. Nothing in this design caps total giveaway across customers — only per order and per customer. A rule of "+500 points on orders over $20" with a 1000-order week is a 500,000-point liability the owner will not have modelled until the cost panel lands in phase 3.

- The admin has no drag-and-drop anywhere; rule priority uses the same chevron reorder as happy hours. Owners who expect drag-to-reorder will read the chevrons as broken.

- Anon has no EXECUTE on private.user_owns_restaurant. Declaring any policy on the new tables as FOR ALL instead of per-command would hard-error storefront reads that touch them — the exact failure mode already hit once on the brands public-read path.

## 10. Competitor evidence

- Square's LoyaltyProgramAccrualRule defines exactly the rule taxonomy we are shipping — SPEND ("Earn one point for each dollar spent"), VISIT with a minimum_amount_money, and ITEM_VARIATION / CATEGORY rules that qualify specific catalog objects — which is why v1's three owner-facing rule types are spend-threshold, time-window and specific-item rather than a general condition DSL: https://developer.squareup.com/reference/square/objects/LoyaltyProgramAccrualRule

- Square's LoyaltyPromotion carries precisely the fields our loyalty_earn_rules row carries — an incentive that is either "multiplying base program points or by adding a specified number of points", available_time for scheduling, trigger_limit to control "how often a buyer can earn promotion points during a specified interval", minimum_spend_amount_money, and qualifying_item_variation_ids — confirming multiplier-vs-flat as the right two reward shapes and per-customer trigger limits as a first-class field, not an afterthought: https://developer.squareup.com/reference/square/objects/LoyaltyPromotion

- Square's promotions guide is the direct precedent for our stacking rule: "A purchase can earn points for only one promotion. If a purchase qualifies for multiple promotions, Square selects the most recently created promotion." It also confirms bonuses add on top of the base rather than replacing it — "5 program points with a points multiplier of 1.25 earns 6 total points", "5 program points with a points addition of 3 earns 8 total points": https://developer.squareup.com/docs/loyalty-api/loyalty-promotions

- Square caps a program at "a maximum of 10 loyalty promotions with an ACTIVE or SCHEDULED status", which is the industry's admission that an unbounded rule set is unmanageable — our equivalent guardrail is the max_total_multiplier ceiling plus the overlap warning at edit time rather than a hard rule count: https://developer.squareup.com/docs/loyalty-api/loyalty-promotions

- Toast Loyalty, the closest direct competitor for our restaurant owners, configures earning as a single points-per-dollar number and states that "points are only earned on pre-taxed, non-discounted amounts, and guests do not earn points on tips, taxes, or gift card purchases" — backing both loyalty_settings.points_per_dollar as the one basic dial and pre_discount as the default earning_basis: https://support.toasttab.com/en/article/How-Guests-Earn-Points-with-Toast-Loyalty

- Toast's getting-started flow proves the owner-facing model we are matching: an amount-based program where "you configure how many points a guest earns per dollar", with tiered rewards configured separately from earning — the same split we keep between the Rewards tab and the new Earning tab: https://support.toasttab.com/en/article/Getting-Started-Toast-Loyalty

- Starbucks Double/Triple Star Days are the canonical consumer-facing multiplier promotion — "earn twice or triple the number of Stars for your qualifying purchase", with Starbucks reserving "the right to exclude certain products and merchandise" — which is why our multiplier is a first-class rule reward and why item/channel conditions are exclusions the owner can state up front: https://www.starbucks.com/rewards/terms/

- Paytronix's workflow model — triggers fired "when a guest crosses a predefined spend threshold (e.g. $150 in a month or $500 lifetime spend)" paired with "a bonus points multiplier, limited-time free item, or custom perk" — is the enterprise precedent for the rolling-window per-customer cap (per_customer_cap_points / per_customer_cap_days) rather than a calendar-month reset: https://www.paytronix.com/blog/loyalty-platform-software
