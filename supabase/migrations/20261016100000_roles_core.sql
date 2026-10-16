-- Roles, core database rules (owner role spec, decisions D1, D4, D9 and D12 of the 2026-10-16
-- roles audit). Every function below that has no repo file was re-created from its live
-- definition (pg_get_functiondef on 2026-10-16) with the same arguments, answer and grants.
--
-- 1. THE CASHIER GETS THE BACK OFFICE'S DASHBOARD (D1) AND CHECKS TRANSFER SLIPS (D12).
--    role_capabilities gains (cashier, backoffice.access), (cashier, dashboard.view) and
--    (cashier, payments.verify). payments.verify is new: it approves or rejects a diner's transfer
--    slip that is still waiting (decide_payment_proof). payments.decide keeps everything else
--    about money (re-deciding a payment, record_counter_payment's overrides, closing a table with
--    an unpaid balance). The admin app still gates each back-office page on its own capability, so
--    backoffice.access opens the shell, not every screen.
--
-- 2. DECIDE_PAYMENT_PROOF follows the capability table. It hard-coded owner, admin and manager
--    (private.user_manages_branch). Now payments.decide decides any payment, as before, and
--    payments.verify decides a TRANSFER payment that is still PENDING, nothing else: a cashier who
--    could also "reject" a payment already taken would cancel a paid order through the back door
--    that section 5 closes.
--
-- 3. THE OLD MONEY RPCs ARE GATED. get_branch_reports (revenue by day, channel and category; no
--    app calls it any more) let any member of the branch read it; it now needs reports.view.
--    get_branch_payout_summary (each rider's earnings) needs drivers.manage, the right the Driver
--    payouts page is about. Platform admins pass both through staff_has_capability.
--
-- 4. A DIRECT orders.status WRITE NEEDS THE KITCHEN OR THE COUNTER. The column grant UPDATE(status)
--    and orders_staff_update let ANY active member of the branch, whatever their role, write any
--    status straight through the Data API, 'cancelled' and 'refunded' included, so orders.cancel,
--    orders.refund and kitchen.access were all bypassed. A new BEFORE UPDATE OF status trigger
--    holds writes made as the signed-in caller (current_user 'authenticated'):
--      * 'cancelled' and 'refunded' are refused (status_needs_rpc): cancel_order and refund_order
--        (and stripe-refund for a card) are the only ways in, and they check the capabilities;
--      * any other move needs kitchen.access or counter.access at the branch (not_authorized).
--    Inside a SECURITY DEFINER function current_user is the function's owner, so cancel_order,
--    refund_order, decide_payment_proof, recall_order, the counter payment RPCs and every trigger
--    that moves an order on (cash confirm, the delivery sync) are untouched, and so are the service
--    role, pg_cron and the SQL console. The kitchen's advance and Undo and the counter's confirm
--    are direct writes by holders of those capabilities, and keep working.
--
-- 5. CANCEL BEFORE PAYMENT (D4). cancel_order let orders.cancel (the cashier) or kitchen.access
--    cancel an order that had already been paid in cash, at the counter by card or by transfer:
--    the payment stayed completed and no refund was recorded. Now an order with money taken (a
--    payment completed, or refunded, for more than zero) needs orders.refund to cancel, with one
--    exception: the kitchen's Reject may still cancel, and with stripe-refund refund in full, a
--    paid order that is still 'pending'. Anyone else gets 'paid_order_needs_refund'. An unpaid
--    order is cancelled exactly as before (orders.cancel or kitchen.access). The diner's own
--    cancel is unchanged. stripe-refund's cancel: true asks for the same right (refund-plan.ts
--    mayRequest, KITCHEN_PAID_CANCEL_STATUSES).
--
-- 6. TOGGLE_ITEM_AVAILABILITY takes set_item_86's rule (kitchen.access, menu.availability or
--    inventory.manage) instead of a hard-coded role list that included the cashier.
--
-- 7. ADD BRANCH IS THE OWNER'S (D9). create_branch spends a paid branch seat, and the spec keeps
--    subscription and billing from the admin. It accepted brand.edit (owner and admin); it now
--    accepts the owner only: restaurants.owner_user_id, an active owner row, or a platform admin
--    (private.user_owns_restaurant). The block that gave a branch-scoped admin a staff row at the
--    branch they had just created is gone: every caller now already reaches every branch. The
--    answer keeps its creator_staff_id key, always null.
--
-- 8. AUDIT_LOGS CANNOT BE WRITTEN BY HAND. audit_insert let any member of a branch insert any row,
--    and refund_order totals earlier refunds of a cash, transfer or counter-card order from its
--    audit rows ('refund'), so a forged row could block a real refund (refund_exceeds_remaining)
--    or put made-up figures in the payments report. Every writer is a SECURITY DEFINER function
--    owned by postgres (live check: 20 functions insert into it, and no SECURITY INVOKER function
--    in any schema mentions it) or an edge function using the service role (place-order,
--    stripe-connect-onboard; no app inserts with a user's token), so the policy is dropped and
--    anon and authenticated lose INSERT, UPDATE, DELETE and TRUNCATE. Reading is unchanged
--    (audit_staff_read).

-- ---------------------------------------------------------------------------------------------
-- 1. Cashier capabilities
-- ---------------------------------------------------------------------------------------------

insert into public.role_capabilities (role, capability)
values ('cashier', 'backoffice.access'),
       ('cashier', 'dashboard.view'),
       ('cashier', 'payments.verify')
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------
-- 2. decide_payment_proof
-- ---------------------------------------------------------------------------------------------

create or replace function public.decide_payment_proof(p_payment_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch uuid;
  v_order uuid;
  v_method text;
  v_status text;
  v_staff uuid;
begin
  -- Locked: two people deciding the same slip at once must not both pass the 'still pending'
  -- check below (a reject cancels the order, a late approve would then complete its payment).
  -- The second waits here and reads the decision the first one made.
  select p.branch_id, p.order_id, p.method::text, p.status::text
    into v_branch, v_order, v_method, v_status
    from public.payments p where p.id = p_payment_id
     for update;
  if v_branch is null then
    raise exception 'payment_not_found' using errcode = 'P0001';
  end if;
  -- payments.decide (owner, admin, manager) decides any payment, as user_manages_branch let them.
  -- payments.verify (the cashier) checks that a diner's transfer arrived: a transfer slip that is
  -- still waiting, nothing else. Rejecting cancels the order, so letting it touch a payment that
  -- went through would be a cancel of a paid order without orders.refund.
  if not private.staff_has_capability(v_branch, 'payments.decide') then
    if not private.staff_has_capability(v_branch, 'payments.verify') then
      raise exception 'forbidden' using errcode = 'P0001';
    end if;
    if v_method <> 'transfer' then
      raise exception 'forbidden'
        using errcode = 'P0001',
              hint = 'Checking a transfer slip is the only payment decision this role can make.';
    end if;
    if v_status <> 'pending' then
      raise exception 'payment_not_pending'
        using errcode = 'P0001',
              hint = 'This slip has already been decided. Ask an owner, admin or manager to change it.';
    end if;
  end if;

  v_staff := private.staff_row_for_branch(v_branch);

  update public.payments
     set status = case when p_approve then 'completed'::payment_status else 'failed'::payment_status end,
         confirmed_by = v_staff,
         confirmed_at = now(),
         paid_at = case when p_approve then now() else paid_at end,
         gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
                            || jsonb_build_object('decision_note', p_note, 'decided_at', now())
                            || jsonb_build_object('pending', false)
   where id = p_payment_id;

  if p_approve then
    update public.orders
       set status = case when status = 'pending' then 'confirmed'::order_status else status end,
           awaiting_payment = false
     where id = v_order;
  else
    -- The stock this order took comes back through orders_restore_stock_on_cancel.
    update public.orders
       set status = 'cancelled',
           awaiting_payment = false,
           cancellation_reason = coalesce(nullif(btrim(p_note), ''), 'Payment slip was not accepted.'),
           status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object(
             'status', 'cancelled',
             'at', now(),
             'by', 'staff',
             'reason', coalesce(nullif(btrim(p_note), ''), 'Payment slip was not accepted.')
           )
     where id = v_order
       and status in ('pending', 'confirmed');
  end if;

  insert into public.audit_logs(branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_branch, auth.uid(), 'staff',
          case when p_approve then 'payment_proof_approved' else 'payment_proof_rejected' end,
          'payment', p_payment_id, jsonb_build_object('note', p_note));
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 3. The old money RPCs
-- ---------------------------------------------------------------------------------------------

create or replace function public.get_branch_reports(p_branch_id uuid, p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_since timestamptz := now() - make_interval(days => p_days);
  v_tz text;
  v_result jsonb;
begin
  -- Revenue totals, by day, channel and category: what reports.view is for. Branch membership let
  -- a cook or a cashier read them (20260908100000_branch_report_sections.sql recorded the gap).
  -- staff_has_capability also passes platform admins.
  if not private.staff_has_capability(p_branch_id, 'reports.view') then
    raise exception 'not authorized to read reports for this branch'
      using errcode = '42501';
  end if;

  select coalesce(nullif(b.timezone, ''), 'UTC') into v_tz
    from public.branches b where b.id = p_branch_id;
  if v_tz is null then v_tz := 'UTC'; end if;

  with relevant_orders as (
    select
      o.id, o.channel, o.status, o.total, o.subtotal, o.created_at,
      (o.created_at at time zone v_tz)::date as local_date,
      extract(hour from o.created_at at time zone v_tz)::int as local_hour,
      to_char(o.created_at at time zone v_tz, 'Dy') as local_dow
    from public.orders o
    where o.branch_id = p_branch_id
      and o.created_at >= v_since
      and o.status not in ('cancelled', 'refunded')
  ),
  daily as (
    select local_date as day, count(*) as orders, coalesce(sum(total), 0) as revenue
    from relevant_orders group by local_date order by local_date
  ),
  by_channel as (
    select channel, count(*) as orders, coalesce(sum(total), 0) as revenue
    from relevant_orders group by channel order by revenue desc
  ),
  by_status as (
    select status, count(*) as orders from relevant_orders group by status
  ),
  hour_heatmap as (
    select local_dow as dow, local_hour as hour, count(*) as orders, coalesce(sum(total), 0) as revenue
    from relevant_orders group by local_dow, local_hour
  ),
  top_items as (
    select oi.item_name as name, sum(oi.quantity) as quantity, coalesce(sum(oi.subtotal), 0) as revenue
    from public.order_items oi
    join relevant_orders ro on ro.id = oi.order_id
    group by oi.item_name order by revenue desc limit 10
  ),
  by_category as (
    select mc.name as category, sum(oi.quantity) as quantity, coalesce(sum(oi.subtotal), 0) as revenue
    from public.order_items oi
    join relevant_orders ro on ro.id = oi.order_id
    join public.menu_items mi on mi.id = oi.menu_item_id
    left join public.menu_categories mc on mc.id = mi.category_id
    group by mc.name order by revenue desc
  ),
  totals as (
    select count(*) as orders,
           coalesce(sum(total), 0) as revenue,
           coalesce(round(avg(total)::numeric, 2), 0) as avg_order_value,
           count(*) filter (where status = 'completed') as completed_orders
    from relevant_orders
  )
  select jsonb_build_object(
    'period_days', p_days,
    'since', v_since,
    'timezone', v_tz,
    'totals', (select to_jsonb(t) from totals t),
    'daily', coalesce((select jsonb_agg(to_jsonb(d) order by d.day) from daily d), '[]'::jsonb),
    'by_channel', coalesce((select jsonb_agg(to_jsonb(c)) from by_channel c), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(to_jsonb(s)) from by_status s), '[]'::jsonb),
    'hour_heatmap', coalesce((select jsonb_agg(to_jsonb(h)) from hour_heatmap h), '[]'::jsonb),
    'top_items', coalesce((select jsonb_agg(to_jsonb(i)) from top_items i), '[]'::jsonb),
    'by_category', coalesce((select jsonb_agg(to_jsonb(c)) from by_category c), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;

-- Each rider's earnings and payouts at the branch. Membership let every role read them; the
-- Driver payouts page (its only caller) is a drivers.manage screen. A caller without the right
-- gets no rows, as a non-member always did. staff_has_capability also passes platform admins.
create or replace function public.get_branch_payout_summary(p_branch_id uuid, p_weeks integer default 8)
returns table(driver_id uuid, driver_name text, payout_period_start date, payout_period_end date, delivery_count bigint, base_total numeric, distance_total numeric, tip_total numeric, accrued_total numeric, paid_total numeric, grand_total numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    l.driver_id, d.full_name, l.payout_period_start, l.payout_period_end,
    count(*),
    round(sum(l.base_pay), 2), round(sum(l.distance_pay), 2), round(sum(l.tip_net), 2),
    round(coalesce(sum(l.total) filter (where l.status = 'accrued'), 0), 2),
    round(coalesce(sum(l.total) filter (where l.status = 'paid'), 0), 2),
    round(sum(l.total), 2)
  from public.driver_earnings_ledger l
  join public.drivers d on d.id = l.driver_id
  where l.branch_id = p_branch_id
    and l.payout_period_start >= (date_trunc('week', now())::date - (greatest(p_weeks, 1) * 7))
    and private.staff_has_capability(p_branch_id, 'drivers.manage')
  group by l.driver_id, d.full_name, l.payout_period_start, l.payout_period_end
  order by l.payout_period_start desc, d.full_name;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. A direct orders.status write needs the kitchen or the counter
-- ---------------------------------------------------------------------------------------------

-- SECURITY INVOKER on purpose: current_user must be the caller's, which is the function owner
-- inside a SECURITY DEFINER function and 'authenticated' for a write straight through the Data API.
-- authenticated may already run private.staff_has_capability (RLS policies call it).
create or replace function private.tg_orders_direct_status_needs_capability()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  -- cancel_order, refund_order, decide_payment_proof, recall_order, the counter payment RPCs and
  -- the triggers that move an order on all run as their owner; the service role, pg_cron and the
  -- SQL console are not these roles either. anon holds no UPDATE on orders today; it is named so
  -- that a grant added by mistake does not open this.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.status in ('cancelled', 'refunded') then
    raise exception 'status_needs_rpc:%', new.status
      using errcode = 'P0001',
            hint = 'Cancel with cancel_order, refund with refund_order (stripe-refund for a card): they check orders.cancel and orders.refund.';
  end if;
  if not (private.staff_has_capability(new.branch_id, 'kitchen.access')
          or private.staff_has_capability(new.branch_id, 'counter.access')) then
    raise exception 'not_authorized'
      using errcode = 'P0001',
            hint = 'Moving an order on is the kitchen''s or the counter''s at this branch.';
  end if;
  return new;
end $function$;

revoke all on function private.tg_orders_direct_status_needs_capability() from public, anon, authenticated;

comment on function private.tg_orders_direct_status_needs_capability() is
  'BEFORE UPDATE OF status on orders, for writes made as the signed-in caller (current_user authenticated or anon): no move into cancelled or refunded (cancel_order / refund_order do that), and any other move needs kitchen.access or counter.access at the branch. SECURITY DEFINER functions, triggers and the service role pass.';

-- "orders_c_" so it runs after orders_a_final_status_guard (nothing leaves a closed order),
-- orders_b_card_refund_guard and orders_block_unpaid_transfer, whose answers stay the ones the
-- screens already word, and before orders_status_history_trigger writes history for a move that
-- is about to be refused.
drop trigger if exists orders_c_direct_status_needs_capability on public.orders;
create trigger orders_c_direct_status_needs_capability
  before update of status on public.orders
  for each row execute function private.tg_orders_direct_status_needs_capability();

-- ---------------------------------------------------------------------------------------------
-- 5. cancel_order: cancel before payment
-- ---------------------------------------------------------------------------------------------

-- Re-created from the live definition (20260925120000_card_refund_followups.sql, identical live)
-- with the same arguments, answer and grants. The only change is the paid-order rule (header,
-- section 5), checked before card_refund_required so that a cashier is told a manager has to do
-- it rather than being sent to a refund it may not make.
create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_is_staff boolean;
  v_kitchen boolean;
  v_kitchen_window boolean;
  v_is_customer boolean;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  -- Locked: stripe_connect_apply_payment_intent completes a payment under the same order lock, so
  -- the payment checks below see a payment that went through a moment ago rather than missing it.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  -- Staff who may cancel at this branch, and the kitchen, whose Reject is a cancel. The helper
  -- covers owner rows, restaurant-wide rows, owner_user_id, platform admins and active status.
  v_kitchen := private.staff_has_capability(v_order.branch_id, 'kitchen.access');
  v_is_staff := v_kitchen or private.staff_has_capability(v_order.branch_id, 'orders.cancel');
  -- A diner may cancel an order only when it names one of their customer rows. A walk-in order
  -- names nobody: the old `customer_id <> mine` was null there, and null never raised.
  v_is_customer := v_order.customer_id is not null
    and v_order.customer_id in (select c.id from public.customers c where c.user_id = v_uid);
  if not v_is_staff and not v_is_customer then
    raise exception 'not_authorized';
  end if;
  if v_order.status in ('completed','cancelled','refunded') then
    raise exception 'cannot_cancel_status:%', v_order.status;
  end if;
  if not v_is_staff and v_order.status not in ('pending','confirmed') then
    raise exception 'too_late_for_customer_cancel';
  end if;
  -- Once the diner's card payment has gone through, only the restaurant can give it back, so only
  -- the restaurant may cancel. A refunded payment counts: whatever happened, the restaurant did it.
  if not v_is_staff
     and coalesce(v_order.source, 'web') = 'web'
     and exists (select 1 from public.payments p
                  where p.order_id = v_order.id
                    and p.method = 'card'
                    and p.gateway = 'stripe'
                    and p.status in ('completed', 'refunded'))
  then
    raise exception 'card_paid_ask_restaurant'
      using errcode = 'P0001',
            hint = 'The card payment for this order has gone through. Ask the restaurant to cancel it; they refund the card when they do.';
  end if;
  -- Cancel before payment. Once money has been taken (cash, a card at the counter or online, an
  -- approved transfer), cancelling is giving it back, which is orders.refund (owner, admin,
  -- manager). The kitchen's Reject keeps a window: an order nobody has accepted yet. The list is
  -- the one stripe-refund's KITCHEN_PAID_CANCEL_STATUSES names, since its cancel: true asks for
  -- this same right before it refunds the card. A refunded payment counts, as above: whoever
  -- refunded it, closing the order is a manager's call.
  v_kitchen_window := v_order.status in ('pending');
  if v_is_staff
     and exists (select 1 from public.payments p
                  where p.order_id = v_order.id
                    and p.status in ('completed', 'refunded')
                    and p.amount > 0)
     and not private.staff_has_capability(v_order.branch_id, 'orders.refund')
     and not (v_kitchen and v_kitchen_window)
  then
    raise exception 'paid_order_needs_refund'
      using errcode = 'P0001',
            hint = 'This order has been paid. Cancelling it gives the money back, which takes an owner, admin or manager.';
  end if;
  if private.order_card_refund_due(v_order.id) > 0 then
    raise exception 'card_refund_required'
      using errcode = 'P0001',
            hint = 'Refund the card payment through Stripe first (stripe-refund with cancel: true refunds and cancels in one step).';
  end if;

  update public.orders
     set status = 'cancelled',
         cancellation_reason = coalesce(v_reason, cancellation_reason),
         status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object(
           'status', 'cancelled', 'at', now(), 'by', case when v_is_staff then 'staff' else 'customer' end,
           'reason', v_reason
         )
   where id = p_order_id;

  -- Stock is given back by the orders_restore_stock_on_cancel trigger, which every path into
  -- 'cancelled' goes through.

  return jsonb_build_object('ok', true, 'order_id', p_order_id);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 6. toggle_item_availability
-- ---------------------------------------------------------------------------------------------

-- Re-created from the live definition (20260916140000) with the same arguments and grants. Only
-- the parked apps/kds calls it.
create or replace function public.toggle_item_availability(p_item_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_branch_id uuid;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select mi.branch_id into v_branch_id
    from public.menu_items mi
   where mi.id = p_item_id;
  if v_branch_id is null then raise exception 'item_not_found'; end if;
  -- set_item_86's rule: the kitchen takes a dish off mid-service, the back office (menu or
  -- inventory) puts it back. The role list this replaced also let the cashier, who holds none of
  -- these, switch menu items on and off.
  if not (
    private.staff_has_capability(v_branch_id, 'kitchen.access')
    or private.staff_has_capability(v_branch_id, 'menu.availability')
    or private.staff_has_capability(v_branch_id, 'inventory.manage')
  ) then
    raise exception 'not_authorized'
      using hint = 'Your role cannot change what is on sale at this branch.';
  end if;
  update public.menu_items set is_active = p_active, updated_at = now() where id = p_item_id;
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 7. create_branch: the owner's
-- ---------------------------------------------------------------------------------------------

-- Re-created from the live definition (20260918190000_branch_setup.sql and later) with the same
-- arguments and grants. Changes: the owner-only rule, and the creator-row block removed (header,
-- section 7).
create or replace function public.create_branch(p_restaurant_id uuid, p_name text, p_slug text, p_address text default null, p_timezone text default 'America/New_York', p_brand_id uuid default null, p_lat double precision default null, p_lng double precision default null, p_sales_tax_rate numeric default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_branch_id uuid;
  v_seats integer := 0;
  v_used integer := 0;
  v_geo geography(Point, 4326);
  v_name text := btrim(coalesce(p_name, ''));
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_timezone text := btrim(coalesce(p_timezone, ''));
  v_tax numeric;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if v_name = '' or v_slug = '' then
    raise exception 'name_and_slug_required';
  end if;

  -- A new branch spends a paid seat on the subscription, and subscription and billing are the
  -- owner's alone (the admin has brand.edit but not billing.manage). The owner is
  -- restaurants.owner_user_id or an active owner row; platform admins pass too.
  if not private.user_owns_restaurant(p_restaurant_id) then
    raise exception 'not_authorized'
      using hint = 'Only the restaurant''s owner can add a branch.';
  end if;

  -- The same rule as branches_slug_check, said before the insert so the answer names the field.
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) < 2 or length(v_slug) > 64 then
    raise exception 'invalid_slug'
      using errcode = '22023',
            hint = 'Use 2 to 64 lowercase letters, digits and single hyphens, for example downtown-2.';
  end if;

  -- Opening hours, happy hour, scheduling and report days are all read in this zone, by Postgres
  -- and by the browser, so it must be a name both know.
  if not private.is_valid_timezone(v_timezone) then
    raise exception 'invalid_timezone'
      using errcode = '22023', hint = 'Pick a time zone from the list, for example Asia/Bangkok.';
  end if;

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

  -- A new branch used to start at 0% and the first orders went out untaxed. Unless the caller
  -- says otherwise it charges what the restaurant's first branch charges.
  if p_sales_tax_rate is null then
    select b.sales_tax_rate into v_tax
      from public.branches b
     where b.restaurant_id = p_restaurant_id
     order by b.is_active desc, b.created_at, b.id
     limit 1;
    v_tax := coalesce(v_tax, 0);
  else
    v_tax := p_sales_tax_rate;
  end if;
  if v_tax < 0 or v_tax >= 0.5 then
    raise exception 'invalid_tax_rate'
      using errcode = '22023', hint = 'A sales tax rate is a fraction from 0 up to 0.5, for example 0.07 for 7%.';
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

  begin
    insert into public.branches (
      restaurant_id, slug, name, address, timezone, brand_id, is_active, geo_location, settings, sales_tax_rate
    )
    values (
      p_restaurant_id, v_slug, v_name, nullif(btrim(p_address), ''), v_timezone, p_brand_id, true, v_geo,
      private.default_branch_settings(p_restaurant_id), v_tax
    )
    returning id into v_branch_id;
  exception when unique_violation then
    raise exception 'slug_taken'
      using errcode = '23505', hint = 'Another branch of this restaurant already uses that URL slug.';
  end;

  -- The creator needs no staff row of their own here: owner_user_id, owner rows and platform
  -- admins reach every branch of the restaurant.

  -- subscriptions.branch_count is recounted by the branches trigger (section 8).

  insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (p_restaurant_id, v_branch_id, v_uid, 'staff', 'branch_created', 'branch', v_branch_id,
          jsonb_build_object('name', v_name, 'slug', v_slug, 'timezone', v_timezone,
                             'sales_tax_rate', v_tax));

  return jsonb_build_object(
    'branch_id', v_branch_id,
    'slug', v_slug,
    'timezone', v_timezone,
    'sales_tax_rate', v_tax,
    'creator_staff_id', null
  );
end
$function$;

-- ---------------------------------------------------------------------------------------------
-- 8. audit_logs: written by trusted code only
-- ---------------------------------------------------------------------------------------------

-- SECURITY DEFINER functions owned by postgres (the table's owner) and the service role keep
-- writing; signed-in callers keep reading their branches' rows through audit_staff_read.
drop policy if exists audit_insert on public.audit_logs;
revoke insert, update, delete, truncate on table public.audit_logs from anon, authenticated;
