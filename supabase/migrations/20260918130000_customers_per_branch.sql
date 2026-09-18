-- One customer record per branch.
--
-- The owner's rule: every branch of a restaurant keeps its own customers, points, reports and
-- settings; only the diner's login (auth.users) and the account's billing are shared. The owner
-- opened a second branch (Food Thai Thai) and its Customers page showed one nameless row with 0
-- orders, while Bobby's Food Thai Thai orders were counted on Hamburger's page. Verified live
-- before this migration:
--
-- 1. CUSTOMERS WERE ONE ROW PER (RESTAURANT, USER). customers_restaurant_user_uidx and
--    customers_restaurant_phone_uidx made the first branch a diner touched their "home", and every
--    later branch reused that row. Bobby (user 1e74fba1) has 4 orders at Food Thai Thai (3 completed,
--    $152.73) filed under his Hamburger row 70d15b7e, together with his Food Thai Thai points row
--    32938ee8 (116 points) and its 3 ledger rows. Food Thai Thai's only row belonged to
--    driver@test.com, minted by get_or_create_my_customer when that account opened the checkout.
--    From here on a diner has one row per branch they use: (branch_id, user_id) is unique, and so is
--    (branch_id, phone). The merchant's record, stats, address book, marketing consent and loyalty
--    wallet are that branch's own.
--
-- 2. THE STATS TRIGGER SUMMED A ROW'S ORDERS AT EVERY BRANCH. customers_refresh_order_stats only
--    existed in the live database (history is squashed); its canonical body is below. It is per
--    branch by construction once a row is, and a new BEFORE trigger on orders keeps an order's
--    customer row at the order's own branch, so the two can never mix again: a signed-in diner's
--    other-branch row is swapped for their row at this branch (made on the spot if need be), and
--    anything else is refused (customer_branch_mismatch). Every row's totals are recomputed at the
--    end. The trigger also fills a blank profile name from the diner's latest real order name, the
--    same fallback the Customers page shows, so the list's Name sort and search see it too.
--
-- 3. COUNTER SALES WERE FILED UNDER THE CASHIER. place-order resolved the customer from the caller's
--    session before it knew the caller was staff, so the till's walk-ins became the cashier's own
--    orders: "Bird" (A-2609-333322, Food Thai Thai) under the owner's row "B.", and three Hamburger
--    counter orders under a "Walk-in" row (+10000000000) that place-order minted for owner@test.com.
--    None is completed and no loyalty row references them (checked before applying). They lose the
--    customer (a walk-in is nobody's account), and the "Walk-in" row, left referenced by nothing, is
--    deleted. From here on the same BEFORE trigger files every counter/POS sale that names a staff
--    member's or the owner's own row as a walk-in, at any branch (it would otherwise earn them the
--    points), and the till's placeholder number can no longer be stored on a customer at all
--    (customers_phone_not_placeholder), so the junk row cannot come back. place-order itself is
--    fixed separately.
--
-- 4. ROWS WERE CREATED BLANK AND NEVER FILLED. get_or_create_my_customer copied only
--    meta.full_name (Google puts the name in meta.name) and never the email, so a diner who ordered
--    under a typed name still showed as "—". New rows take coalesce(full_name, name) and the login
--    email unless it is one of the synthetic *.favornoms.local addresses phone and driver accounts
--    get. Existing blank names are filled from the latest real order name at that branch (never a
--    till placeholder such as "Walk-in" or "Table 4"), blank emails from the login.
--
-- 5. A DINER COULD REWRITE THEIR OWN ROW FREELY. customers_self was FOR ALL and authenticated held
--    every privilege on every column, so a signed-in diner could set their own total_spent, move the
--    row to another branch or delete it (anon held the same grants; RLS was the only wall). Diners
--    now read and update their own rows only, and only the profile columns the storefront writes
--    (full_name, phone, email, marketing_consent) plus birthday, gender and preferred_language. Rows
--    are created only by trusted code (get_or_create_my_customer, handle_new_user, place-order).
--
-- 6. REPORTS. get_branch_customers_report read loyalty from the whole restaurant (a NULL-branch
--    "brand" arm) and its Lifetime column was restaurant-wide; get_top_customers_ltv and
--    get_cohort_retention let only a staff row pinned to exactly this branch in, which refuses the
--    owner on every branch but the one their row names. All three are per branch and gated by
--    private.staff_has_capability(branch, 'reports.view'), and all three name a customer the way the
--    Customers page does: full name, else their latest real order name here, else their email. The
--    customers report's per-diner figures count COMPLETED orders, the Customers page's rule: it
--    counted refunded and still-cooking orders, so a diner's spend in a range could exceed their
--    lifetime spend printed beside it.
--
-- 7. THE NAME SORT IGNORED THE NAME SHOWN. The list sorted on full_name alone, so a row the page
--    names by its email sat after every named row in an A-Z list. customers.sort_name is the shown
--    name, lower-cased (profile name, else a real email), stored so the list can sort on it.
--
-- The data split (section 3) re-points, for each (customer row, other branch) pair: that branch's
-- orders, loyalty_points and loyalty_transactions rows (non-NULL branch_id only: NULL-branch loyalty
-- rows belong to the loyalty migration, which files them by their order's branch, so this works
-- whichever of the two runs first), the promo_redemptions of those orders, and that branch's
-- order_ratings, support_tickets, recurring_orders and birthday_rewards. The address book is copied.
-- The new row copies the profile, starts with marketing_consent false (consent was given to one
-- branch, not the next) and is dated by the diner's first activity at that branch.
--
-- Not here, handed off: place-order must resolve (branch_id, user_id) and must not attach a
-- staff-placed order to the cashier; validate_promo_code must count a promo's per-customer limit
-- on the diner's row at the promo's branch; cancel_order and edit_pending_order must not assume
-- one customers row per user (the auth engineer's migration covers the latter two).

-- =============================================================================================
-- 0. Small helpers shared by the backfill and the reports below.
-- =============================================================================================
-- The login emails a person never chose: c{digits}@customer.favornoms.local for phone sign-in,
-- d{digits}@driver.favornoms.local for riders, and the demo accounts' @favornoms.local.
create or replace function private.is_synthetic_email(p_email text)
 returns boolean
 language sql
 immutable
 set search_path to 'pg_temp'
as $function$
  select coalesce(p_email ~* '@([a-z0-9-]+\.)*favornoms\.local$', false);
$function$;

-- The names the till writes when it does not know who it is serving. They are not a customer's
-- name and must never be copied onto one.
create or replace function private.is_placeholder_customer_name(p_name text)
 returns boolean
 language sql
 immutable
 set search_path to 'pg_temp'
as $function$
  select coalesce(btrim(p_name), '') = ''
      or lower(btrim(p_name)) ~ '^(walk[- ]?in|guest|customer|deleted user|table\s*\S+)$';
$function$;

revoke all on function private.is_synthetic_email(text) from public, anon, authenticated;
revoke all on function private.is_placeholder_customer_name(text) from public, anon, authenticated;

-- =============================================================================================
-- 1. The restaurant-level identity indexes go first: the split below writes a second row for the
--    same (restaurant, user). Dropping them locks customers until commit, so nothing can write a
--    row under the old rule meanwhile.
-- =============================================================================================
drop index if exists public.customers_restaurant_user_uidx;
drop index if exists public.customers_restaurant_phone_uidx;

-- =============================================================================================
-- 2. Counter and POS sales filed under a staff member's (or the owner's) own customer row lose the
--    customer. Done before the split so it never mints the owner a row at the branch they sold at.
-- =============================================================================================
update public.orders o
   set customer_id = null
  from public.customers c
 where o.customer_id = c.id
   and o.source in ('counter', 'pos')
   and c.user_id is not null
   and (exists (select 1 from public.staff_members sm
                 where sm.user_id = c.user_id
                   and sm.restaurant_id = c.restaurant_id
                   and sm.status = 'active')
        or exists (select 1 from public.restaurants r
                    where r.id = c.restaurant_id and r.owner_user_id = c.user_id));

-- The till's placeholder phone is nobody's number. A row holding it that nothing references any
-- more (live: 024e9def "Walk-in", owner@test.com) is junk.
delete from public.customers c
 where c.phone = '+10000000000'
   and not exists (select 1 from public.orders x where x.customer_id = c.id)
   and not exists (select 1 from public.loyalty_points x where x.customer_id = c.id)
   and not exists (select 1 from public.loyalty_transactions x where x.customer_id = c.id)
   and not exists (select 1 from public.customer_addresses x where x.customer_id = c.id)
   and not exists (select 1 from public.promo_redemptions x where x.customer_id = c.id)
   and not exists (select 1 from public.order_ratings x where x.customer_id = c.id)
   and not exists (select 1 from public.support_tickets x where x.customer_id = c.id)
   and not exists (select 1 from public.recurring_orders x where x.customer_id = c.id)
   and not exists (select 1 from public.birthday_rewards x where x.customer_id = c.id)
   and not exists (select 1 from public.referral_redemptions x where x.referred_customer_id = c.id);

-- =============================================================================================
-- 3. Split every customer row that carries another branch's activity.
-- =============================================================================================
do $split$
declare
  r      record;
  v_new  uuid;
  v_made boolean;
begin
  for r in
    with activity as (
      select o.customer_id, o.branch_id, o.created_at as at
        from public.orders o where o.customer_id is not null
      union all
      select lp.customer_id, lp.branch_id, lp.updated_at
        from public.loyalty_points lp where lp.branch_id is not null
      union all
      select lt.customer_id, lt.branch_id, lt.created_at
        from public.loyalty_transactions lt where lt.branch_id is not null
      union all
      select x.customer_id, coalesce(o.branch_id, x.branch_id), x.created_at
        from public.order_ratings x left join public.orders o on o.id = x.order_id
      union all
      select x.customer_id, coalesce(o.branch_id, x.branch_id), x.created_at
        from public.support_tickets x left join public.orders o on o.id = x.order_id
       where x.customer_id is not null
      union all
      select x.customer_id, x.branch_id, x.created_at from public.recurring_orders x
      union all
      select x.customer_id, x.branch_id, coalesce(x.issued_at, now()) from public.birthday_rewards x
    )
    select c.id as old_id, a.branch_id as target_branch, b.restaurant_id as target_restaurant,
           min(a.at) as first_at
      from activity a
      join public.customers c on c.id = a.customer_id
      join public.branches b on b.id = a.branch_id
     where a.branch_id <> c.branch_id
       -- Another tenant's branch is never a place to copy a diner's profile to.
       and b.restaurant_id = c.restaurant_id
     group by c.id, a.branch_id, b.restaurant_id
     order by c.id, min(a.at)
  loop
    v_made := false;

    -- The diner may already hold a row there (a login row by user, a guest row by phone).
    select n.id into v_new
      from public.customers c
      join public.customers n on n.branch_id = r.target_branch and n.id <> c.id
     where c.id = r.old_id
       and ((c.user_id is not null and n.user_id = c.user_id)
            or (c.user_id is null and n.user_id is null and c.phone is not null and n.phone = c.phone))
     order by n.created_at
     limit 1;

    if v_new is null then
      insert into public.customers (restaurant_id, branch_id, user_id, phone, email, full_name,
                                    birthday, gender, preferred_language, marketing_consent, created_at)
      select r.target_restaurant, r.target_branch, c.user_id,
             case when exists (select 1 from public.customers x
                                where x.branch_id = r.target_branch and x.phone = c.phone)
                  then null else c.phone end,
             c.email, c.full_name, c.birthday, c.gender, c.preferred_language, false,
             least(coalesce(r.first_at, now()), now())
        from public.customers c where c.id = r.old_id
      returning id into v_new;
      v_made := true;
    end if;

    update public.orders set customer_id = v_new
     where customer_id = r.old_id and branch_id = r.target_branch;

    -- A reused row may already hold a wallet at that branch: fold the old one into it.
    update public.loyalty_points t
       set points_balance  = t.points_balance + s.points_balance,
           lifetime_earned = t.lifetime_earned + s.lifetime_earned,
           lifetime_spent  = t.lifetime_spent + s.lifetime_spent,
           updated_at      = now()
      from public.loyalty_points s
     where s.customer_id = r.old_id and s.branch_id = r.target_branch
       and t.customer_id = v_new and t.branch_id = r.target_branch;
    delete from public.loyalty_points s
     where s.customer_id = r.old_id and s.branch_id = r.target_branch
       and exists (select 1 from public.loyalty_points t
                    where t.customer_id = v_new and t.branch_id = r.target_branch);
    update public.loyalty_points set customer_id = v_new
     where customer_id = r.old_id and branch_id = r.target_branch;

    update public.loyalty_transactions set customer_id = v_new
     where customer_id = r.old_id and branch_id = r.target_branch;

    update public.promo_redemptions set customer_id = v_new
     where customer_id = r.old_id
       and order_id in (select o.id from public.orders o where o.branch_id = r.target_branch);

    update public.order_ratings x set customer_id = v_new
     where x.customer_id = r.old_id
       and coalesce((select o.branch_id from public.orders o where o.id = x.order_id), x.branch_id)
           = r.target_branch;

    update public.support_tickets x set customer_id = v_new
     where x.customer_id = r.old_id
       and coalesce((select o.branch_id from public.orders o where o.id = x.order_id), x.branch_id)
           = r.target_branch;

    update public.recurring_orders set customer_id = v_new
     where customer_id = r.old_id and branch_id = r.target_branch;

    update public.birthday_rewards set customer_id = v_new
     where customer_id = r.old_id and branch_id = r.target_branch;

    -- The address book comes along once, onto a row made here. lat/lng are generated from
    -- geo_location.
    if v_made then
      insert into public.customer_addresses (customer_id, label, address_line1, address_line2,
                                             district, province, postal_code, geo_location,
                                             is_default, delivery_notes, created_at, city, state)
      select v_new, a.label, a.address_line1, a.address_line2, a.district, a.province,
             a.postal_code, a.geo_location, a.is_default, a.delivery_notes, a.created_at,
             a.city, a.state
        from public.customer_addresses a
       where a.customer_id = r.old_id;
    end if;

    raise notice 'customers split: % -> % at branch % (%)',
      r.old_id, v_new, r.target_branch, case when v_made then 'new row' else 'existing row' end;
  end loop;
end
$split$;

-- =============================================================================================
-- 4. Per-branch identity from here on. Built after the split, which is what makes them hold.
--    idx_customers_branch_phone is covered by the partial unique index.
-- =============================================================================================
create unique index if not exists customers_branch_user_uidx
  on public.customers (branch_id, user_id) where user_id is not null;
create unique index if not exists customers_branch_phone_uidx
  on public.customers (branch_id, phone) where phone is not null;
drop index if exists public.idx_customers_branch_phone;

comment on column public.customers.branch_id is
  'The branch this customer record belongs to. One row per (branch, user) and per (branch, phone): '
  'a diner who uses two branches has two rows, each with its own stats, addresses, consent and loyalty.';

-- The till stamps +10000000000 on a sale when nobody gave a number. It identifies nobody, and a
-- row holding it is how the "Walk-in" junk row came about (place-order minted one for whoever was
-- at the till). Refused outright; the deployed place-order reads a refused insert as "no customer"
-- and files the sale as a walk-in. Any row still holding it loses the number first.
update public.customers set phone = null where phone = '+10000000000';
alter table public.customers drop constraint if exists customers_phone_not_placeholder;
alter table public.customers add constraint customers_phone_not_placeholder
  check (phone is distinct from '+10000000000');

-- The name the Customers list shows, lower-cased, for its Name sort: the profile name (filled from
-- the latest real order name by customers_refresh_order_stats), else a real email. NULL for a row
-- known by neither, which the list puts last.
alter table public.customers add column if not exists sort_name text
  generated always as (
    lower(coalesce(
      nullif(btrim(full_name), ''),
      case when email ~* '@([a-z0-9-]+\.)*favornoms\.local$' then null
           else nullif(btrim(email), '') end))
  ) stored;
comment on column public.customers.sort_name is
  'Lower-cased display name for sorting: full_name, else a real (non-synthetic) email. Generated.';
create index if not exists customers_branch_sort_name_idx
  on public.customers (branch_id, sort_name);

-- =============================================================================================
-- 5. Stats. The canonical body of the trigger function (previously live-only): total_orders and
--    total_spent count COMPLETED orders, last_order_at is the latest order that was not cancelled.
--    Per branch because the row is. New: a blank profile name takes the diner's latest real order
--    name (never a till placeholder), which is what the Customers page showed for it anyway; now
--    the stored name, and so the list's search and Name sort, agree with the page.
-- =============================================================================================
create or replace function public.customers_refresh_order_stats()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ids uuid[];
  v_cust uuid;
begin
  v_ids := array_remove(array[
    case when tg_op <> 'INSERT' then old.customer_id end,
    case when tg_op <> 'DELETE' then new.customer_id end
  ], null);

  foreach v_cust in array v_ids loop
    update public.customers c
       set total_orders  = s.cnt,
           total_spent   = s.spend,
           last_order_at = s.last_at,
           full_name     = case when nullif(btrim(c.full_name), '') is null
                                then coalesce(s.order_name, c.full_name)
                                else c.full_name end
      from (
        select count(*) filter (where o.status = 'completed')                       as cnt,
               coalesce(sum(o.total) filter (where o.status = 'completed'), 0)      as spend,
               max(o.created_at) filter (where o.status <> 'cancelled')             as last_at,
               (select btrim(n.customer_name) from public.orders n
                 where n.customer_id = v_cust
                   and not private.is_placeholder_customer_name(n.customer_name)
                 order by n.created_at desc limit 1)                                as order_name
          from public.orders o
         where o.customer_id = v_cust
      ) s
     where c.id = v_cust;
  end loop;

  return case when tg_op = 'DELETE' then old else new end;
end $function$;

-- A trigger function; firing it needs no EXECUTE, and nobody should call it directly.
revoke all on function public.customers_refresh_order_stats() from public, anon, authenticated;

update public.customers c
   set total_orders  = s.cnt,
       total_spent   = s.spend,
       last_order_at = s.last_at
  from (
    select c2.id,
           count(o.id) filter (where o.status = 'completed')                    as cnt,
           coalesce(sum(o.total) filter (where o.status = 'completed'), 0)      as spend,
           max(o.created_at) filter (where o.status <> 'cancelled')             as last_at
      from public.customers c2
      left join public.orders o on o.customer_id = c2.id
     group by c2.id
  ) s
 where s.id = c.id
   and (c.total_orders, c.total_spent, c.last_order_at)
       is distinct from (s.cnt::int, s.spend, s.last_at);

-- Blank names from the latest real order name the diner gave at that branch.
update public.customers c
   set full_name = x.name
  from (
    select distinct on (o.customer_id) o.customer_id, btrim(o.customer_name) as name
      from public.orders o
      join public.customers c2 on c2.id = o.customer_id and c2.branch_id = o.branch_id
     where not private.is_placeholder_customer_name(o.customer_name)
     order by o.customer_id, o.created_at desc
  ) x
 where c.id = x.customer_id
   and nullif(btrim(c.full_name), '') is null;

-- Blank emails from the login, unless it is a synthetic one.
update public.customers c
   set email = lower(btrim(u.email))
  from auth.users u
 where u.id = c.user_id
   and c.email is null
   and nullif(btrim(u.email), '') is not null
   and not private.is_synthetic_email(u.email);

-- =============================================================================================
-- 6. An order's customer row is always the order's branch's, and a till sale is never the
--    cashier's.
-- =============================================================================================
create or replace function private.tg_orders_customer_same_branch()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_cust public.customers%rowtype;
  v_rest uuid;
  v_id   uuid;
begin
  if new.customer_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.customer_id is not distinct from old.customer_id
     and new.branch_id is not distinct from old.branch_id then
    return new;
  end if;
  select * into v_cust from public.customers c where c.id = new.customer_id;
  -- A missing row is the foreign key's to report.
  if not found then
    return new;
  end if;
  select b.restaurant_id into v_rest from public.branches b where b.id = new.branch_id;

  -- A till sale belongs to the person at the till, never to the one ringing it up. The old
  -- place-order resolved the customer from the caller's session, so counter sales landed on the
  -- cashier's own row (or the owner's, when the owner rang them up) and would have earned them the
  -- points on completion. Such a sale, and one naming another branch's record, is filed as a
  -- walk-in: the cashier has already taken the money, so it is never refused. A real diner's row
  -- at this branch (a number the cashier looked up) stays.
  if new.source in ('counter', 'pos') then
    if v_cust.branch_id is distinct from new.branch_id
       or (v_cust.user_id is not null
           and (exists (select 1 from public.staff_members sm
                         where sm.user_id = v_cust.user_id
                           and sm.restaurant_id = v_rest
                           and sm.status = 'active')
                or exists (select 1 from public.restaurants r
                            where r.id = v_rest and r.owner_user_id = v_cust.user_id))) then
      new.customer_id := null;
    end if;
    return new;
  end if;

  if v_cust.branch_id is not distinct from new.branch_id then
    return new;
  end if;

  -- Another branch's record of a signed-in diner of this restaurant: the order is filed under the
  -- same diner's record at THIS branch, made here the way get_or_create_my_customer makes it when
  -- they have none yet (profile copied, marketing consent not: it was given to the other branch).
  -- A caller that still looks customers up by restaurant then attributes the order correctly
  -- instead of failing it.
  if v_cust.user_id is not null and v_cust.restaurant_id = v_rest then
    select c.id into v_id from public.customers c
     where c.branch_id = new.branch_id and c.user_id = v_cust.user_id;
    if v_id is null then
      begin
        insert into public.customers (restaurant_id, branch_id, user_id, phone, email, full_name,
                                      birthday, gender, preferred_language, marketing_consent)
        values (v_rest, new.branch_id, v_cust.user_id,
                case when exists (select 1 from public.customers x
                                   where x.branch_id = new.branch_id and x.phone = v_cust.phone)
                     then null else v_cust.phone end,
                v_cust.email, v_cust.full_name, v_cust.birthday, v_cust.gender,
                v_cust.preferred_language, false)
        returning id into v_id;
      exception when unique_violation then
        -- A concurrent request made it first.
        select c.id into v_id from public.customers c
         where c.branch_id = new.branch_id and c.user_id = v_cust.user_id;
      end;
    end if;
    if v_id is not null then
      new.customer_id := v_id;
      return new;
    end if;
  end if;

  raise exception 'customer_branch_mismatch'
    using errcode = 'P0001',
          detail = 'orders.customer_id must be the diner''s customers row at the order''s own branch.';
end $function$;

revoke all on function private.tg_orders_customer_same_branch() from public, anon, authenticated;

drop trigger if exists orders_customer_same_branch on public.orders;
create trigger orders_customer_same_branch
  before insert or update of customer_id, branch_id on public.orders
  for each row execute function private.tg_orders_customer_same_branch();

-- =============================================================================================
-- 7. Identity functions, per branch.
-- =============================================================================================
create or replace function public.get_or_create_my_customer(p_branch_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user  uuid := auth.uid();
  v_rest  uuid;
  v_cid   uuid;
  v_phone text;
  v_name  text;
  v_email text;
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select restaurant_id into v_rest from public.branches where id = p_branch_id;
  if v_rest is null then raise exception 'branch_not_found'; end if;

  -- 1) This user's record at THIS branch. Another branch's row is another merchant record.
  select id into v_cid from public.customers
   where user_id = v_user and branch_id = p_branch_id;
  if v_cid is not null then return v_cid; end if;

  -- Google keeps the name in meta.name, the phone lane in meta.full_name.
  -- The till's placeholder number is nobody's (customers_phone_not_placeholder).
  select nullif(coalesce(u.phone, u.raw_user_meta_data ->> 'phone'), '+10000000000'),
         nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name')), ''),
         case when private.is_synthetic_email(u.email) then null
              else lower(nullif(btrim(u.email), '')) end
    into v_phone, v_name, v_email
    from auth.users u where u.id = v_user;

  -- 2) Adopt an UNCLAIMED guest row with the same phone at this branch (walk-in / POS order).
  if v_phone is not null then
    update public.customers
       set user_id   = v_user,
           full_name = coalesce(nullif(btrim(full_name), ''), v_name),
           email     = coalesce(email, v_email)
     where branch_id = p_branch_id and phone = v_phone and user_id is null
     returning id into v_cid;
    if v_cid is not null then return v_cid; end if;

    -- 3) Phone held by another account at this branch -> do not steal it; drop the phone.
    if exists (select 1 from public.customers
                where branch_id = p_branch_id and phone = v_phone) then
      v_phone := null;
    end if;
  end if;

  begin
    insert into public.customers (restaurant_id, branch_id, user_id, phone, email, full_name, preferred_language)
    values (v_rest, p_branch_id, v_user, v_phone, v_email, v_name, 'en')
    returning id into v_cid;
  exception when unique_violation then
    -- A concurrent call won the (branch_id, user_id) race, or the phone was taken meanwhile.
    select id into v_cid from public.customers
     where user_id = v_user and branch_id = p_branch_id;
    if v_cid is null then
      insert into public.customers (restaurant_id, branch_id, user_id, phone, email, full_name, preferred_language)
      values (v_rest, p_branch_id, v_user, null, v_email, v_name, 'en')
      returning id into v_cid;
    end if;
  end;

  if v_cid is null then
    raise exception 'customer_identity_unavailable';
  end if;
  return v_cid;
end $function$;

-- Sign-in's top-up (customer-auth, the OAuth callback): the same resolution, but it never raises,
-- because a provisioning hiccup must not fail a sign-in.
create or replace function public.provision_customer_for_branch(p_branch_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then return null; end if;
  if not exists (select 1 from public.branches where id = p_branch_id) then return null; end if;
  return public.get_or_create_my_customer(p_branch_id);
end $function$;

create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_signup_type text;
  v_branch_id   uuid;
  v_restaurant_id uuid;
  v_full_name   text;
  v_phone       text;
  v_email       text;
BEGIN
  v_signup_type := NEW.raw_user_meta_data ->> 'signup_type';
  v_branch_id   := NULLIF(NEW.raw_user_meta_data ->> 'branch_id', '')::uuid;
  v_full_name   := NULLIF(BTRIM(COALESCE(NEW.raw_user_meta_data ->> 'full_name',
                                         NEW.raw_user_meta_data ->> 'name')), '');
  v_phone       := COALESCE(NEW.phone, NEW.raw_user_meta_data ->> 'phone');
  v_email       := CASE WHEN private.is_synthetic_email(NEW.email) THEN NULL
                        ELSE LOWER(NULLIF(BTRIM(NEW.email), '')) END;

  IF v_signup_type = 'customer' AND v_branch_id IS NOT NULL THEN
    SELECT restaurant_id INTO v_restaurant_id FROM public.branches WHERE id = v_branch_id;
    IF v_restaurant_id IS NOT NULL THEN
      -- The row for the branch they signed up at; any other branch gets its own on first use.
      -- The till's placeholder number is nobody's (customers_phone_not_placeholder).
      INSERT INTO public.customers (restaurant_id, branch_id, user_id, phone, email, full_name, preferred_language)
      VALUES (v_restaurant_id, v_branch_id, NEW.id, NULLIF(v_phone, '+10000000000'), v_email, v_full_name, 'en')
      ON CONFLICT (branch_id, phone) WHERE phone IS NOT NULL DO UPDATE
        SET user_id   = EXCLUDED.user_id,
            full_name = COALESCE(NULLIF(BTRIM(public.customers.full_name), ''), EXCLUDED.full_name),
            email     = COALESCE(public.customers.email, EXCLUDED.email)
        WHERE public.customers.user_id IS NULL OR public.customers.user_id = EXCLUDED.user_id;
    END IF;
  ELSIF v_signup_type = 'driver' THEN
    INSERT INTO public.drivers (user_id, phone, full_name, vehicle_type, kyc_status)
    VALUES (NEW.id, v_phone, COALESCE(v_full_name, 'Driver'), 'motorcycle', 'pending')
    ON CONFLICT (phone) DO UPDATE SET user_id = EXCLUDED.user_id
      WHERE public.drivers.user_id IS NULL OR public.drivers.user_id = EXCLUDED.user_id;
  END IF;
  RETURN NEW;
END;
$function$;

-- =============================================================================================
-- 8. What a diner and staff may do to the table.
-- =============================================================================================
-- Rows are made by trusted code only; a diner updates the profile of their own rows and nothing
-- else. anon has no policy at all, so its privileges were never needed.
revoke all on public.customers from anon;
revoke insert, update, delete, truncate, references, trigger on public.customers from authenticated;
grant select on public.customers to authenticated;
grant update (full_name, phone, email, marketing_consent, birthday, gender, preferred_language)
  on public.customers to authenticated;

drop policy if exists customers_self on public.customers;
drop policy if exists customers_self_read on public.customers;
drop policy if exists customers_self_update on public.customers;
create policy customers_self_read on public.customers
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy customers_self_update on public.customers
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Nothing inserts customers as a signed-in user (the storefront and the till go through the
-- functions above and place-order), and INSERT is no longer granted.
drop policy if exists customers_staff_insert on public.customers;

-- =============================================================================================
-- 9. Reports, per branch.
-- =============================================================================================
create or replace function public.get_branch_customers_report(p_branch_id uuid, p_from date, p_to date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tz     text;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
  d_from   date := least(p_from, p_to);
  d_to     date := greatest(p_from, p_to);
begin
  if not private.staff_has_capability(p_branch_id, 'reports.view') then
    raise exception 'not authorized to read reports for this branch'
      using errcode = '42501';
  end if;

  if d_from is null or d_to is null then
    raise exception 'range_required' using errcode = 'P0001';
  end if;
  if d_to - d_from > 366 then
    raise exception 'range_too_wide' using errcode = 'P0001';
  end if;

  select coalesce(nullif(b.timezone, ''), 'UTC')
    into v_tz
    from public.branches b where b.id = p_branch_id;
  if v_tz is null then v_tz := 'UTC'; end if;

  v_from := (d_from::timestamp) at time zone v_tz;
  v_to   := ((d_to + 1)::timestamp) at time zone v_tz;

  with win as (
    -- Order-level lines (guest orders, coupons) follow the rest of the reports: every order in
    -- the range that was not cancelled.
    select o.id, o.customer_id, o.total, o.promo_code, o.promo_discount, o.created_at, o.status
      from public.orders o
     where o.branch_id = p_branch_id
       and o.created_at >= v_from and o.created_at < v_to
       and o.status <> 'cancelled'
  ),
  first_order as (
    -- Over ALL of this branch's history, not the window, so a returning regular never looks new.
    select o.customer_id, min(o.created_at) as first_at
      from public.orders o
     where o.branch_id = p_branch_id and o.customer_id is not null and o.status <> 'cancelled'
     group by o.customer_id
  ),
  per_cust as (
    -- Per-diner figures count COMPLETED orders, the Customers page's rule
    -- (customers_refresh_order_stats): an order still being made, or one refunded, is not money
    -- the diner spent here. So a range figure can never exceed the lifetime one beside it.
    select w.customer_id, count(*) as orders, round(coalesce(sum(w.total), 0), 2) as spend,
           max(w.created_at) as last_at
      from win w
     where w.customer_id is not null and w.status = 'completed'
     group by w.customer_id
  ),
  top_cust as (
    select p.customer_id::text as customer_id,
           coalesce(n.name, 'Guest') as name,
           -- False when name is the report's own placeholder, not a customer's real name.
           (n.name is not null) as has_name,
           p.orders, p.spend, p.last_at,
           -- The customer row is this branch's, so these are this branch's completed orders:
           -- the same figures as the Customers page.
           c.total_orders as lifetime_orders, c.total_spent as lifetime_spent,
           (select lp.tier::text from public.loyalty_points lp
             where lp.customer_id = c.id and lp.branch_id = p_branch_id
             limit 1) as tier
      from per_cust p
      join public.customers c on c.id = p.customer_id
      cross join lateral (
        select coalesce(
          nullif(btrim(c.full_name), ''),
          (select btrim(o.customer_name) from public.orders o
            where o.customer_id = c.id and o.branch_id = p_branch_id
              and not private.is_placeholder_customer_name(o.customer_name)
            order by o.created_at desc limit 1),
          case when private.is_synthetic_email(c.email) then null else nullif(btrim(c.email), '') end
        ) as name
      ) n
     order by p.spend desc limit 20
  ),
  loy as (
    -- This branch's points only. Order-linked rows still carrying a NULL branch (written under the
    -- retired brand scope) count by their order's branch until the loyalty backfill stamps them.
    select lt.type, lt.points, lt.reference_type
      from public.loyalty_transactions lt
     where lt.created_at >= v_from and lt.created_at < v_to
       and (lt.branch_id = p_branch_id
            or (lt.branch_id is null and lt.reference_type = 'order'
                and lt.reference_id in (select id from public.orders where branch_id = p_branch_id)))
  ),
  coupons as (
    select w.promo_code as code, count(*) as uses,
           round(coalesce(sum(w.promo_discount), 0), 2) as discount,
           count(distinct w.customer_id) as customers
      from win w where w.promo_code is not null group by 1 order by 2 desc
  )
  select jsonb_build_object(
    'from', d_from, 'to', d_to, 'timezone', v_tz,
    'totals', jsonb_build_object(
      -- Customer records of this branch: every diner who signed in or ordered here.
      'total_customers',    (select count(*) from public.customers where branch_id = p_branch_id),
      'active_customers',   (select count(*) from per_cust),
      'new_customers',      (select count(*) from per_cust p join first_order f
                                                     on f.customer_id = p.customer_id
                              where f.first_at >= v_from and f.first_at < v_to),
      'returning_customers',(select count(*) from per_cust p join first_order f
                                                     on f.customer_id = p.customer_id
                              where f.first_at < v_from),
      -- Surfaced, never hidden: an unattributable order would otherwise make
      -- new + returning silently fail to add up to the order count.
      'guest_orders',       (select count(*) from win where customer_id is null),
      'repeat_customers',   (select count(*) from per_cust where orders >= 2),
      'avg_orders_per_customer',
        round(coalesce((select sum(orders)::numeric from per_cust)
                     / nullif((select count(*) from per_cust), 0), 0), 2),
      'avg_spend_per_customer',
        round(coalesce((select sum(spend) from per_cust)
                     / nullif((select count(*) from per_cust), 0), 0), 2),
      -- Disjoint on purpose: a manual redemption is a 'redeemed' row too, and counting it
      -- in both lines would make the loyalty card fail to reconcile against itself.
      'points_earned',   coalesce((select sum(points) from loy
                                    where type = 'earned' and reference_type = 'order'), 0),
      'points_redeemed', coalesce((select -sum(points) from loy
                                    where type = 'redeemed' and reference_type = 'order'), 0),
      'points_manual',   coalesce((select sum(points) from loy
                                    where reference_type is distinct from 'order'), 0),
      'coupon_uses',     (select count(*) from win where promo_code is not null),
      'coupon_discount', round(coalesce((select sum(promo_discount) from win), 0), 2)),
    'top_customers', coalesce((select jsonb_agg(to_jsonb(t) order by t.spend desc) from top_cust t), '[]'::jsonb),
    'by_coupon',     coalesce((select jsonb_agg(to_jsonb(c)) from coupons c), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

create or replace function public.get_top_customers_ltv(p_branch_id uuid, p_limit integer default 20)
 returns table(customer_id uuid, full_name text, total_orders integer, total_spent numeric,
               avg_order_value numeric, last_order_at timestamp with time zone, loyalty_tier text)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select
    c.id,
    coalesce(
      nullif(btrim(c.full_name), ''),
      (select btrim(o.customer_name) from public.orders o
        where o.customer_id = c.id and o.branch_id = p_branch_id
          and not private.is_placeholder_customer_name(o.customer_name)
        order by o.created_at desc limit 1),
      case when private.is_synthetic_email(c.email) then null else nullif(btrim(c.email), '') end
    ),
    c.total_orders,
    c.total_spent,
    case when c.total_orders > 0 then round(c.total_spent / c.total_orders, 2) else 0 end,
    c.last_order_at,
    (select lp.tier::text from public.loyalty_points lp
      where lp.customer_id = c.id and lp.branch_id = p_branch_id limit 1)
  from public.customers c
  where c.branch_id = p_branch_id
    and private.staff_has_capability(p_branch_id, 'reports.view')
  order by c.total_spent desc nulls last, c.id
  limit greatest(0, p_limit);
$function$;

create or replace function public.get_cohort_retention(p_branch_id uuid, p_weeks integer default 8)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_weeks  int := least(greatest(coalesce(p_weeks, 8), 1), 104);
begin
  if not private.staff_has_capability(p_branch_id, 'reports.view') then
    raise exception 'not_authorized';
  end if;

  with branch_orders as (
    select o.customer_id, o.created_at
      from public.orders o
     where o.branch_id = p_branch_id
       and o.customer_id is not null
       and o.status <> 'cancelled'
  ),
  first_orders as (
    -- The diner's first order at this branch EVER: taking it inside the window made every
    -- returning regular look like a new cohort.
    select customer_id, date_trunc('week', min(created_at))::date as cohort_week
      from branch_orders
     group by customer_id
  ),
  cohorts as (
    select * from first_orders
     where cohort_week >= date_trunc('week', now() - make_interval(weeks => v_weeks))::date
  ),
  retained as (
    -- Offsets from calendar weeks, so a cohort that crosses New Year keeps counting up.
    select c.cohort_week,
           ((date_trunc('week', bo.created_at)::date - c.cohort_week) / 7) as week_offset,
           count(distinct c.customer_id) as retained_customers
      from cohorts c
      join branch_orders bo on bo.customer_id = c.customer_id
     group by c.cohort_week, 2
  ),
  cohort_size as (
    select cohort_week, count(*) as size from cohorts group by cohort_week
  )
  select jsonb_agg(jsonb_build_object(
    'cohort_week', r.cohort_week,
    'week_offset', r.week_offset,
    'retained', r.retained_customers,
    'cohort_size', cs.size,
    'retention_rate', round((r.retained_customers::numeric / cs.size) * 100, 1)
  ) order by r.cohort_week, r.week_offset)
  into v_result
  from retained r
  join cohort_size cs on cs.cohort_week = r.cohort_week;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

revoke all on function public.get_branch_customers_report(uuid, date, date) from public, anon;
revoke all on function public.get_top_customers_ltv(uuid, integer) from public, anon;
revoke all on function public.get_cohort_retention(uuid, integer) from public, anon;
grant execute on function public.get_branch_customers_report(uuid, date, date) to authenticated, service_role;
grant execute on function public.get_top_customers_ltv(uuid, integer) to authenticated, service_role;
grant execute on function public.get_cohort_retention(uuid, integer) to authenticated, service_role;

-- customers.sort_name is new: have PostgREST pick it up now rather than on its next reload.
notify pgrst, 'reload schema';
