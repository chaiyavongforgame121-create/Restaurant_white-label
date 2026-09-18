-- The SQL half of place-order: order numbers, the staff check, promos, gift cards and points.
--
-- The owner opened a second branch (Food Thai Thai) and asked that every branch be completely
-- separate. place-order (the edge function that writes every storefront and counter order) leaned
-- on SQL helpers that were either unreachable, restaurant-wide or not atomic. Verified live before
-- this migration:
--
-- 1. ORDER NUMBERS WERE RANDOM. place-order called private.generate_order_number through PostgREST,
--    which does not expose the private schema (and service_role had no EXECUTE on it anyway), so
--    every order fell back to `A-<UTC yymm>-<Date.now() % 1000000>`. orders has
--    UNIQUE (branch_id, order_number); two sales whose millisecond clocks agreed mod 1,000,000 in the
--    same month collided and the second one failed as a bare 500. The function itself was
--    count(*) + 1, which races and reuses a number after a delete, in a hard-coded Bangkok month.
--    public.next_order_number(branch) is an atomic per-branch counter (private.branch_order_counters,
--    INSERT ... ON CONFLICT DO UPDATE ... RETURNING), per month in the BRANCH's timezone, formatted
--    A-YYMM-NNNN. Every existing number has six random digits, so a four-digit sequence cannot meet
--    one; the function still skips any number already taken at the branch, so a counter that ever
--    reaches six digits cannot collide either. service_role only.
--
-- 2. THE STAFF CHECK WAS RESTAURANT-WIDE. place-order treated any active staff row of the restaurant
--    as staff of the ordering branch, so a Hamburger cashier could ring up Food Thai Thai orders
--    (bypassing its payment matrix), while the owner known only through restaurants.owner_user_id,
--    or a platform admin, was not staff anywhere. public.staff_can_ring_up(user, branch) is
--    private.staff_has_capability(branch, 'counter.access') for a given user instead of auth.uid():
--    owner rows cover every branch, restaurant-wide rows (branch_id null) cover every branch, other
--    rows only their own, plus owner_user_id and platform admins. service_role only.
--
-- 3. THE PER-CUSTOMER PROMO LIMIT WAS NEVER ENFORCED ON THE SERVER. place-order validates with the
--    service role, where auth.uid() is null, so validate_promo_code skipped the limit; and it looked
--    the diner up by user alone, which picks an arbitrary row now that customers are one row per
--    branch. validate_promo_code gains p_customer_id (honoured only for the service role; a signed-in
--    caller is always resolved as themselves at the promo's branch). The count itself was a
--    read-then-write in the edge function, so two orders could both pass max_redemptions:
--    public.redeem_promo_for_order is a conditional increment that refuses beyond the cap and checks
--    the per-customer limit under the promo's row lock. service_role only.
--
-- 4. GIFT CARDS WERE GOOD EVERYWHERE, AND ANY DINER COULD DRAIN ONE. check_gift_card(code) and
--    redeem_gift_card(code, order, max) matched the code alone: a Hamburger card checked out at Food
--    Thai Thai, in any tenant, and authenticated held EXECUTE on redeem_gift_card, so a signed-in
--    diner could empty any card against any order id. place-order also took the credit off the total
--    before redeeming and ignored a failed redeem ("best-effort"), i.e. free food.
--    check_gift_card(code, branch) only finds a card of that branch; called without a branch (the
--    old one-argument form, still used by a storefront tab opened before this change) it answers
--    invalid, so no cross-tenant path is left. redeem_gift_card only redeems against an order of the
--    card's own branch and is service_role only (place-order is its only caller).
--
-- 5. POINTS WERE DEBITED NON-ATOMICALLY. place-order read the balance, inserted the order, re-read the
--    balance and wrote max(0, before - cost) with no condition: two checkouts spending the same 500
--    points both got the reward, and a failed debit was only logged. public.loyalty_debit_for_order
--    is a conditional debit (points_balance >= points) plus the 'redeemed' ledger row with the
--    branch, in one transaction, raising insufficient_points. service_role only.
--
-- 6. ALL OR NOTHING. public.reserve_order_credits runs the points debit, the promo redemption and the
--    gift card redemption for a just-inserted order in ONE transaction: any refusal
--    (insufficient_points, promo_exhausted, promo_unavailable, per_customer_limit_reached,
--    gift_card_changed) undoes all three, and place-order deletes the order it had just inserted.
--    public.release_order_credits gives all three back for an order place-order is abandoning after
--    they were reserved (its order lines failed to insert). Both service_role only.
--
-- 7. order_items.combo_contents (jsonb): the dishes of a combo line as sold, [{menu_item_id, name,
--    quantity (per ONE combo), station}]. Already added by 20260918160000_kitchen_ops so the kitchen
--    board could select it; repeated here with IF NOT EXISTS because place-order is what fills it.
--
-- Revised the same day after review (applied as a delta; this file is what is live):
--
-- 8. THE TILL'S CUSTOMER LOOKUP MATCHED TEXT, NOT NUMBERS. The counter sends the number it typed as
--    E.164 ('+16266386401'); the storefront stores what the diner typed ('6266386401',
--    '(626) 638-6401'). Food Thai Thai's only customer with a phone was never found.
--    public.find_branch_customer_by_phone(branch, phone) compares digits: the same digits, or a
--    number stored without a country code that the E.164 number is behind a calling code it can be
--    read under (the branch's own, or +1). service_role only.
--
-- 9. A CANCELLED ORDER KEPT THE GIFT-CARD MONEY AND THE PROMO USE. Only points came back (through
--    orders_return_loyalty_on_cancel). orders_return_credits_on_cancel now gives an order that never
--    completed its gift-card credit and its promo use back when it is cancelled or refunded, and takes
--    them again if it is reopened, on the same rule as the points. To make that exact and repeatable,
--    each use carries a returned_at mark (gift_card_redemptions and promo_redemptions), and a walk-in's
--    promo use now has its promo_redemptions row too (customer_id is nullable for it), so every counted
--    use has a row to give back. Per-customer limits count only rows that were not given back.
--    release_order_credits works from those rows instead of trusting its p_promo_id, so place-order
--    can call it after a reservation whose outcome it does not know.
--
-- Revised again after a second review (applied as a delta; this file is what is live):
--
-- 10. THE PHONE LOOKUP ACCEPTED ANY COUNTRY CODE. Its national fallback took any 1-3 leading digits
--     as a country code, so '+44 626 638 6401' and '+91 626 638 6401' both found the diner who
--     stored '626 638 6401', and the sale earned that diner points at a branch they never visited.
--     A number stored without a country code is now read only under the branch's own calling code
--     (from its timezone, as the counter reads a number typed without a +) or +1, the country the
--     storefront and sign-in fall back to; a number stored with its + needs the exact digits.
--
-- 11. ONE LOCK ORDER FOR CREDITS. reserve_order_credits took the points row, then the promo, then
--     the gift card; a cancel gives them back gift card, promo, points (orders_return_credits_on_cancel
--     fires before orders_return_loyalty_on_cancel: same-event triggers run in name order), and so
--     does release_order_credits. A diner cancelling one order while checking out another with the
--     same card and points could deadlock the two. reserve_order_credits now locks the card and the
--     promo first, in that order, and only then debits the points.
--
-- Nothing here changes business data.

-- =============================================================================================
-- 7. order_items.combo_contents
-- =============================================================================================
alter table public.order_items add column if not exists combo_contents jsonb;

-- 9. Marks for a use given back by a cancel, and a row for a walk-in's promo use (see the header).
alter table public.gift_card_redemptions add column if not exists returned_at timestamptz;
alter table public.promo_redemptions add column if not exists returned_at timestamptz;
alter table public.promo_redemptions alter column customer_id drop not null;

-- =============================================================================================
-- 1. Order numbers
-- =============================================================================================
create table if not exists private.branch_order_counters (
  branch_id uuid not null references public.branches(id) on delete cascade,
  -- YYMM in the branch's own timezone: numbering restarts with the month the branch sees.
  period text not null,
  last_seq integer not null default 0 check (last_seq >= 0),
  primary key (branch_id, period)
);
revoke all on table private.branch_order_counters from public, anon, authenticated;

create or replace function public.next_order_number(p_branch_id uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tz text;
  v_period text;
  v_seq integer;
  v_number text;
  v_tries integer := 0;
begin
  select coalesce(nullif(btrim(b.timezone), ''), 'UTC') into v_tz
    from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'branch_not_found' using errcode = 'P0001';
  end if;
  v_period := to_char(now() at time zone v_tz, 'YYMM');

  loop
    v_tries := v_tries + 1;
    -- The row lock taken by ON CONFLICT DO UPDATE serialises concurrent sales at one branch, so
    -- no two callers are ever handed the same sequence number.
    insert into private.branch_order_counters as c (branch_id, period, last_seq)
    values (p_branch_id, v_period, 1)
    on conflict (branch_id, period) do update set last_seq = c.last_seq + 1
    returning c.last_seq into v_seq;

    -- lpad would TRUNCATE a longer number ('12345' -> '1234'), so it only pads.
    v_number := 'A-' || v_period || '-'
             || case when v_seq < 10000 then lpad(v_seq::text, 4, '0') else v_seq::text end;

    -- Skip a number the branch already holds (a legacy random number, should the sequence ever
    -- reach six digits in a month that has them).
    exit when not exists (select 1 from public.orders o
                           where o.branch_id = p_branch_id and o.order_number = v_number);
    if v_tries >= 1000 then
      raise exception 'order_number_exhausted' using errcode = 'P0001';
    end if;
  end loop;
  return v_number;
end
$function$;
revoke all on function public.next_order_number(uuid) from public, anon, authenticated;
grant execute on function public.next_order_number(uuid) to service_role;

-- =============================================================================================
-- 2. Staff check for staff-placed orders
-- =============================================================================================
create or replace function public.staff_can_ring_up(p_user_id uuid, p_branch_id uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  -- private.staff_has_capability(p_branch_id, 'counter.access'), asked about p_user_id rather than
  -- auth.uid(): place-order runs as the service role and passes the verified caller.
  select coalesce(
    p_user_id is not null
    and (
      -- Platform admin: the flag private.user_is_platform_admin() reads from the JWT, at its source.
      exists (
        select 1 from auth.users u
         where u.id = p_user_id
           and coalesce(u.raw_app_meta_data ->> 'is_platform_admin', '') = 'true'
      )
      or exists (
        select 1
          from public.branches b
          join public.restaurants r on r.id = b.restaurant_id
         where b.id = p_branch_id and r.owner_user_id = p_user_id
      )
      or exists (
        select 1
          from public.branches b
          join public.staff_members sm on sm.restaurant_id = b.restaurant_id
          join public.role_capabilities rc on rc.role = sm.role::text
         where b.id = p_branch_id
           and sm.user_id = p_user_id
           and sm.status = 'active'
           and (sm.role = 'owner' or sm.branch_id is null or sm.branch_id = b.id)
           and rc.capability = 'counter.access'
      )
    ),
  false);
$function$;
revoke all on function public.staff_can_ring_up(uuid, uuid) from public, anon, authenticated;
grant execute on function public.staff_can_ring_up(uuid, uuid) to service_role;

-- =============================================================================================
-- 3. Promos
-- =============================================================================================
-- The three-argument form is replaced, not overloaded: PostgREST cannot choose between
-- (uuid, text, numeric) and (uuid, text, numeric, uuid default null) for a three-argument call.
-- The storefront's call (p_branch_id, p_code, p_subtotal) resolves to the new function unchanged.
drop function if exists public.validate_promo_code(uuid, text, numeric);

create or replace function public.validate_promo_code(
  p_branch_id uuid,
  p_code text,
  p_subtotal numeric,
  p_customer_id uuid default null)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_customer_id uuid;
  v_promo public.promos%rowtype;
  v_used integer;
  v_amount numeric;
begin
  select * into v_promo from public.promos
   where branch_id = p_branch_id and lower(code) = lower(p_code)
     and is_active and now() between starts_at and coalesce(ends_at, now() + interval '100 years');
  if not found then return jsonb_build_object('valid', false, 'error', 'invalid_code'); end if;
  if v_promo.max_redemptions is not null and v_promo.redemption_count >= v_promo.max_redemptions then
    return jsonb_build_object('valid', false, 'error', 'promo_exhausted');
  end if;
  if p_subtotal < v_promo.min_subtotal then
    return jsonb_build_object('valid', false, 'error', 'min_subtotal_not_met', 'min_subtotal', v_promo.min_subtotal);
  end if;

  -- Whose per-customer limit. A signed-in caller is always themselves, at the promo's branch
  -- (customers are one row per branch). p_customer_id is for place-order, which runs as the service
  -- role with no auth.uid() and has already resolved the diner; anyone else passing it is ignored,
  -- so it cannot be used to probe another diner's redemptions.
  if v_uid is not null then
    select c.id into v_customer_id from public.customers c
     where c.user_id = v_uid and c.branch_id = p_branch_id
     order by c.created_at, c.id
     limit 1;
  elsif p_customer_id is not null and coalesce(auth.role(), '') = 'service_role' then
    select c.id into v_customer_id from public.customers c
     where c.id = p_customer_id and c.branch_id = p_branch_id;
  end if;
  if v_customer_id is not null then
    -- A use given back by a cancelled order does not count.
    select count(*) into v_used from public.promo_redemptions
     where promo_id = v_promo.id and customer_id = v_customer_id and returned_at is null;
    if v_used >= v_promo.per_customer_limit then
      return jsonb_build_object('valid', false, 'error', 'per_customer_limit_reached');
    end if;
  end if;

  v_amount := case v_promo.kind
    when 'percent_off' then round(p_subtotal * v_promo.value / 100, 2)
    when 'fixed_off' then least(v_promo.value, p_subtotal)
    when 'free_delivery' then 0
    else 0
  end;
  return jsonb_build_object('valid', true, 'kind', v_promo.kind, 'amount_off', v_amount,
    'free_delivery', v_promo.kind = 'free_delivery', 'promo_id', v_promo.id);
end $function$;
revoke all on function public.validate_promo_code(uuid, text, numeric, uuid) from public;
grant execute on function public.validate_promo_code(uuid, text, numeric, uuid) to anon, authenticated, service_role;

-- One use of a promo by one order, counted atomically. The UPDATE's condition is the cap, so two
-- concurrent orders cannot both take the last redemption; the per-customer count runs after the
-- promo's row lock is held, so the same diner's two concurrent orders are counted one after the other.
-- Every counted use gets its promo_redemptions row, a walk-in's with customer_id null: the row is
-- what a cancel gives back (private.return_order_credits) and what release_order_credits undoes.
create or replace function public.redeem_promo_for_order(
  p_promo_id uuid,
  p_order_id uuid,
  p_customer_id uuid default null,
  p_amount_off numeric default 0)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch uuid;
  v_promo public.promos%rowtype;
  v_used integer;
begin
  select o.branch_id into v_branch from public.orders o where o.id = p_order_id;
  if v_branch is null then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  update public.promos p
     set redemption_count = p.redemption_count + 1
   where p.id = p_promo_id
     and p.branch_id = v_branch
     and p.is_active
     and now() between p.starts_at and coalesce(p.ends_at, 'infinity'::timestamptz)
     and (p.max_redemptions is null or p.redemption_count < p.max_redemptions)
  returning p.* into v_promo;
  if not found then
    if exists (select 1 from public.promos p
                where p.id = p_promo_id and p.branch_id = v_branch
                  and p.max_redemptions is not null and p.redemption_count >= p.max_redemptions) then
      raise exception 'promo_exhausted' using errcode = 'P0001';
    end if;
    raise exception 'promo_unavailable' using errcode = 'P0001';
  end if;

  if p_customer_id is not null then
    if not exists (select 1 from public.customers c where c.id = p_customer_id and c.branch_id = v_branch) then
      raise exception 'customer_branch_mismatch' using errcode = 'P0001';
    end if;
    select count(*) into v_used from public.promo_redemptions r
     where r.promo_id = p_promo_id and r.customer_id = p_customer_id
       and r.order_id is distinct from p_order_id
       and r.returned_at is null;
    if v_used >= v_promo.per_customer_limit then
      raise exception 'per_customer_limit_reached' using errcode = 'P0001';
    end if;
  end if;
  insert into public.promo_redemptions (promo_id, customer_id, order_id, amount_off)
  values (p_promo_id, p_customer_id, p_order_id, greatest(0, coalesce(p_amount_off, 0)))
  on conflict (promo_id, order_id) do nothing;
  return v_promo.redemption_count;
end
$function$;
revoke all on function public.redeem_promo_for_order(uuid, uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.redeem_promo_for_order(uuid, uuid, uuid, numeric) to service_role;

-- =============================================================================================
-- 4. Gift cards
-- =============================================================================================
-- One function with an optional branch rather than two overloads: a call naming only p_code (a
-- storefront tab from before this change) reaches it with p_branch_id null and is told the code is
-- invalid, instead of being answered about a card of any branch of any restaurant.
drop function if exists public.check_gift_card(text);

create or replace function public.check_gift_card(p_code text, p_branch_id uuid default null)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_card public.gift_cards%rowtype;
begin
  if p_branch_id is null or p_code is null then
    return jsonb_build_object('valid', false, 'reason', 'invalid_or_redeemed');
  end if;
  select * into v_card from public.gift_cards
    where upper(code) = upper(p_code) and branch_id = p_branch_id and status = 'active';
  if not found then return jsonb_build_object('valid', false, 'reason', 'invalid_or_redeemed'); end if;
  if v_card.expires_at is not null and v_card.expires_at < now() then
    return jsonb_build_object('valid', false, 'reason', 'expired');
  end if;
  return jsonb_build_object('valid', true, 'balance', v_card.balance, 'currency', v_card.currency);
end;
$function$;
revoke all on function public.check_gift_card(text, uuid) from public;
grant execute on function public.check_gift_card(text, uuid) to anon, authenticated, service_role;

create or replace function public.redeem_gift_card(p_code text, p_order_id uuid, p_max_amount numeric)
 returns numeric
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_card public.gift_cards%rowtype;
  v_applied numeric;
  v_branch uuid;
begin
  -- A card is spent only at the branch that issued it.
  select o.branch_id into v_branch from public.orders o where o.id = p_order_id;
  if v_branch is null then raise exception 'order_not_found'; end if;

  select * into v_card from public.gift_cards
    where upper(code) = upper(p_code) and status = 'active' and branch_id = v_branch
    for update;
  if not found then raise exception 'invalid_code'; end if;
  if v_card.balance <= 0 then raise exception 'card_empty'; end if;
  if v_card.expires_at is not null and v_card.expires_at < now() then
    raise exception 'card_expired';
  end if;
  v_applied := least(v_card.balance, greatest(0, p_max_amount));
  if v_applied <= 0 then return 0; end if;

  update public.gift_cards
     set balance = balance - v_applied,
         status = case when balance - v_applied <= 0 then 'redeemed' else status end,
         updated_at = now()
   where id = v_card.id;

  insert into public.gift_card_redemptions (gift_card_id, order_id, amount, redeemed_by)
    values (v_card.id, p_order_id, v_applied, auth.uid());

  return v_applied;
end;
$function$;
revoke all on function public.redeem_gift_card(text, uuid, numeric) from public, anon, authenticated;
grant execute on function public.redeem_gift_card(text, uuid, numeric) to service_role;

-- =============================================================================================
-- 5. Points spent on an order
-- =============================================================================================
create or replace function public.loyalty_debit_for_order(
  p_branch_id uuid,
  p_customer_id uuid,
  p_points integer,
  p_order_id uuid,
  p_description text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_order record;
  v_balance integer;
begin
  if p_points is null or p_points <= 0 then
    raise exception 'invalid_points' using errcode = 'P0001';
  end if;
  select o.id, o.branch_id, o.customer_id into v_order
    from public.orders o where o.id = p_order_id;
  if v_order.id is null then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;
  -- The points come out of the wallet of the order's own diner at the order's own branch.
  if v_order.branch_id is distinct from p_branch_id
     or v_order.customer_id is distinct from p_customer_id then
    raise exception 'order_customer_mismatch' using errcode = 'P0001';
  end if;

  update public.loyalty_points lp
     set points_balance = lp.points_balance - p_points,
         lifetime_spent = least(lp.lifetime_spent::bigint + p_points, 2147483647)::int,
         updated_at = now()
   where lp.branch_id = p_branch_id
     and lp.customer_id = p_customer_id
     and lp.points_balance >= p_points
  returning lp.points_balance into v_balance;
  if not found then
    raise exception 'insufficient_points' using errcode = 'P0001';
  end if;

  -- reference_type 'order' + type 'redeemed' is what private.return_loyalty_for_order gives back
  -- when the order is cancelled, and what the diner's history names. restaurant_id is filled from
  -- the branch by loyalty_transactions_restaurant_from_branch.
  insert into public.loyalty_transactions (
    branch_id, customer_id, points, balance_after, type, reference_type, reference_id, description
  ) values (
    p_branch_id, p_customer_id, -p_points, v_balance, 'redeemed', 'order', p_order_id,
    coalesce(nullif(btrim(p_description), ''), 'Reward')
  );
  return v_balance;
end
$function$;
revoke all on function public.loyalty_debit_for_order(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.loyalty_debit_for_order(uuid, uuid, integer, uuid, text) to service_role;

-- =============================================================================================
-- 6. All or nothing
-- =============================================================================================
create or replace function public.reserve_order_credits(
  p_order_id uuid,
  p_customer_id uuid default null,
  p_points integer default 0,
  p_points_description text default null,
  p_promo_id uuid default null,
  p_promo_amount numeric default 0,
  p_gift_card_code text default null,
  p_gift_card_amount numeric default 0)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch uuid;
  v_balance integer;
  v_count integer;
  v_applied numeric := 0;
begin
  select o.branch_id into v_branch from public.orders o where o.id = p_order_id;
  if v_branch is null then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  -- One lock order for every path that moves credits: the gift card, then the promo, then the
  -- points. A cancel gives them back in that order (orders_return_credits_on_cancel, then
  -- orders_return_loyalty_on_cancel) and so does release_order_credits, so this checkout and a
  -- cancel of the same diner's other order wait for each other instead of deadlocking.
  if p_gift_card_code is not null and coalesce(p_gift_card_amount, 0) > 0 then
    perform 1 from public.gift_cards g
     where upper(g.code) = upper(p_gift_card_code) and g.branch_id = v_branch
     order by g.id
       for update;
  end if;
  if p_promo_id is not null then
    perform 1 from public.promos p where p.id = p_promo_id for update;
  end if;

  if coalesce(p_points, 0) > 0 then
    if p_customer_id is null then
      raise exception 'redeem_requires_auth' using errcode = 'P0001';
    end if;
    v_balance := public.loyalty_debit_for_order(v_branch, p_customer_id, p_points, p_order_id, p_points_description);
  end if;

  if p_promo_id is not null then
    v_count := public.redeem_promo_for_order(p_promo_id, p_order_id, p_customer_id, p_promo_amount);
  end if;

  if p_gift_card_code is not null and coalesce(p_gift_card_amount, 0) > 0 then
    begin
      v_applied := public.redeem_gift_card(p_gift_card_code, p_order_id, p_gift_card_amount);
    exception when others then
      -- Spent, emptied, expired or disabled since the checkout checked it.
      raise exception 'gift_card_changed' using errcode = 'P0001';
    end;
    -- The order was priced with the full credit; a partial one would leave it short.
    if round(coalesce(v_applied, 0), 2) < round(p_gift_card_amount, 2) then
      raise exception 'gift_card_changed' using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object(
    'points_balance', v_balance,
    'promo_redemption_count', v_count,
    'gift_card_applied', v_applied);
end
$function$;
revoke all on function public.reserve_order_credits(uuid, uuid, integer, text, uuid, numeric, text, numeric) from public, anon, authenticated;
grant execute on function public.reserve_order_credits(uuid, uuid, integer, text, uuid, numeric, text, numeric) to service_role;

-- Undo reserve_order_credits for an order place-order is about to delete (it never reached the
-- kitchen). The order never happened, so its ledger rows go rather than being answered by
-- 'order_return' rows. It works only from what the reservation left behind (redemption rows and
-- ledger rows), so it is safe to call when place-order does not know whether the reservation
-- committed, and harmless when nothing was reserved. p_promo_id is no longer needed (every counted
-- promo use has its row now) and is kept only so the deployed caller's arguments still match.
create or replace function public.release_order_credits(p_order_id uuid, p_promo_id uuid default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_status text;
  r record;
begin
  select o.status::text into v_status from public.orders o where o.id = p_order_id for update;
  if v_status is null then
    return;
  end if;
  if v_status <> 'pending' then
    raise exception 'order_not_pending' using errcode = 'P0001';
  end if;

  -- One card at a time, in id order, so two releases cannot deadlock. A use already given back
  -- (returned_at) is not credited twice.
  for r in
    select g.gift_card_id, sum(g.amount) as amount
      from public.gift_card_redemptions g
     where g.order_id = p_order_id and g.returned_at is null
     group by g.gift_card_id
     order by g.gift_card_id
  loop
    update public.gift_cards
       set balance = balance + r.amount,
           status = case when status = 'redeemed' then 'active' else status end,
           updated_at = now()
     where id = r.gift_card_id;
  end loop;
  delete from public.gift_card_redemptions where order_id = p_order_id;

  for r in
    select pr.promo_id, count(*)::int as uses
      from public.promo_redemptions pr
     where pr.order_id = p_order_id and pr.returned_at is null
     group by pr.promo_id
     order by pr.promo_id
  loop
    update public.promos set redemption_count = greatest(0, redemption_count - r.uses) where id = r.promo_id;
  end loop;
  delete from public.promo_redemptions where order_id = p_order_id;

  for r in
    select t.id, t.branch_id, t.customer_id, -t.points as pts
      from public.loyalty_transactions t
     where t.reference_id = p_order_id and t.reference_type = 'order' and t.type = 'redeemed'
  loop
    update public.loyalty_points
       set points_balance = least(points_balance::bigint + r.pts, 2147483647)::int,
           lifetime_spent = greatest(lifetime_spent - r.pts, 0),
           updated_at = now()
     where branch_id = r.branch_id and customer_id = r.customer_id;
    delete from public.loyalty_transactions where id = r.id;
  end loop;
end
$function$;
revoke all on function public.release_order_credits(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_order_credits(uuid, uuid) to service_role;

-- =============================================================================================
-- 8. The till's customer lookup, by digits
-- =============================================================================================
-- p_phone is what the counter sends (E.164). A branch customer matches when their stored number has
-- the same digits in any format ('+1 (626) 638-6401'), or was stored without a country code
-- ('6266386401', '081 592 9554') and the E.164 number is that national number, as stored or with
-- its trunk 0 dropped, behind a calling code it can be read under: the branch's own country, which
-- is its timezone's (the counter reads a number typed without a + the same way; keep this list in
-- step with ZONE_COUNTRY in apps/admin/src/app/counter/[branchId]/_components/counter-phone.ts),
-- or +1, the country the
-- storefront and sign-in fall back to. Under any other calling code the national digits belong to
-- somebody else: '+44 626 638 6401' is not the diner who stored '626 638 6401'. Eight national
-- digits at least, so a short number ('111111') never matches as the tail of a long one. An exact
-- digit match wins, then a record with a login, then the oldest. Read only: place-order files the
-- sale under the row and never claims or changes it.
create or replace function public.find_branch_customer_by_phone(p_branch_id uuid, p_phone text)
 returns uuid
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  with q as (
    select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d
  ),
  cc as (
    select x.code
      from public.branches b
     cross join lateral (values
       (case b.timezone
          when 'Asia/Bangkok' then '66'
          when 'Asia/Ho_Chi_Minh' then '84'
          when 'Asia/Saigon' then '84'
          when 'Asia/Phnom_Penh' then '855'
          when 'Asia/Vientiane' then '856'
          when 'Asia/Yangon' then '95'
          when 'Asia/Kuala_Lumpur' then '60'
          when 'Asia/Singapore' then '65'
          when 'Europe/Madrid' then '34'
          when 'Europe/London' then '44'
          when 'America/Mexico_City' then '52'
          else '1'
        end),
       ('1')) as x(code)
     where b.id = p_branch_id
  )
  select c.id
    from public.customers c
   cross join q
   cross join lateral (select regexp_replace(c.phone, '\D', '', 'g') as d) s
   cross join lateral (select ltrim(s.d, '0') as n) t
   where c.branch_id = p_branch_id
     and c.phone is not null
     and length(q.d) between 7 and 15
     and q.d <> '10000000000'
     and (
       s.d = q.d
       or (left(btrim(c.phone), 1) <> '+'
           and length(t.n) >= 8
           and exists (select 1 from cc where q.d in (cc.code || s.d, cc.code || t.n)))
     )
   order by (s.d = q.d) desc, (c.user_id is not null) desc, c.created_at, c.id
   limit 1;
$function$;
revoke all on function public.find_branch_customer_by_phone(uuid, text) from public, anon, authenticated;
grant execute on function public.find_branch_customer_by_phone(uuid, text) to service_role;

-- =============================================================================================
-- 9. Gift-card credit and promo uses come back with a cancelled order
-- =============================================================================================
-- Give an order's gift-card credit and promo uses back. Each use is marked returned_at rather than
-- deleted: the card's history keeps the redemption, a second call finds nothing left to give, and
-- reopening the order knows exactly what to take again.
create or replace function private.return_order_credits(p_order_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
begin
  -- One card at a time, in id order (the same lock order as release_order_credits).
  for r in
    select g.gift_card_id, sum(g.amount) as amount
      from public.gift_card_redemptions g
     where g.order_id = p_order_id and g.returned_at is null
     group by g.gift_card_id
     order by g.gift_card_id
  loop
    -- A card emptied by this order is good again; a card disabled or expired since stays so, with
    -- its balance restored for whoever sorts it out.
    update public.gift_cards
       set balance = balance + r.amount,
           status = case when status = 'redeemed' then 'active' else status end,
           updated_at = now()
     where id = r.gift_card_id;
  end loop;
  update public.gift_card_redemptions
     set returned_at = now()
   where order_id = p_order_id and returned_at is null;

  for r in
    select pr.promo_id, count(*)::int as uses
      from public.promo_redemptions pr
     where pr.order_id = p_order_id and pr.returned_at is null
     group by pr.promo_id
     order by pr.promo_id
  loop
    update public.promos set redemption_count = greatest(0, redemption_count - r.uses) where id = r.promo_id;
  end loop;
  update public.promo_redemptions
     set returned_at = now()
   where order_id = p_order_id and returned_at is null;
end
$function$;

-- Reopened (taken out of cancelled/refunded): what came back goes out again, and only that. A card
-- spent since cannot cover it, and reopening would hand the credit out twice, so that is refused
-- like loyalty_points_already_spent. A promo use is simply counted again: the order held it first.
create or replace function private.reclaim_order_credits(p_order_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
begin
  for r in
    select g.gift_card_id, sum(g.amount) as amount
      from public.gift_card_redemptions g
     where g.order_id = p_order_id and g.returned_at is not null
     group by g.gift_card_id
     order by g.gift_card_id
  loop
    update public.gift_cards
       set balance = balance - r.amount,
           status = case when balance - r.amount <= 0 and status = 'active' then 'redeemed' else status end,
           updated_at = now()
     where id = r.gift_card_id
       and balance >= r.amount;
    if not found then
      raise exception 'gift_card_already_spent'
        using hint = 'The gift card credit this order gave back has been spent since. Leave it cancelled and ring the order up again.';
    end if;
  end loop;
  update public.gift_card_redemptions
     set returned_at = null
   where order_id = p_order_id and returned_at is not null;

  for r in
    select pr.promo_id, count(*)::int as uses
      from public.promo_redemptions pr
     where pr.order_id = p_order_id and pr.returned_at is not null
     group by pr.promo_id
     order by pr.promo_id
  loop
    update public.promos set redemption_count = redemption_count + r.uses where id = r.promo_id;
  end loop;
  update public.promo_redemptions
     set returned_at = null
   where order_id = p_order_id and returned_at is not null;
end
$function$;

-- The same rule as orders_return_loyalty_on_cancel: only an order that never completed gets its
-- credits back. A meal that was served and then refunded keeps its gift-card and promo use spent,
-- as it keeps its points spent; the refund covers the money that was paid.
create or replace function private.orders_return_credits_on_cancel()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.status in ('cancelled', 'refunded')
     and old.status not in ('completed', 'cancelled', 'refunded')
     and new.completed_at is null then
    perform private.return_order_credits(new.id);
  elsif old.status in ('cancelled', 'refunded')
     and new.status not in ('cancelled', 'refunded') then
    -- Works from the returned_at marks, so an order cancelled before this trigger existed (nothing
    -- was given back) takes nothing again.
    perform private.reclaim_order_credits(new.id);
  end if;
  return new;
end
$function$;
revoke all on function private.return_order_credits(uuid) from public, anon, authenticated;
revoke all on function private.reclaim_order_credits(uuid) from public, anon, authenticated;
revoke all on function private.orders_return_credits_on_cancel() from public, anon, authenticated;

drop trigger if exists orders_return_credits_on_cancel on public.orders;
create trigger orders_return_credits_on_cancel
  after update of status on public.orders
  for each row
  when (new.status is distinct from old.status)
  execute function private.orders_return_credits_on_cancel();
