-- Payments report: card refunds and disputes from Stripe, not only from refund_order's audit rows.
--
-- get_branch_payments_report (20260908100000_branch_report_sections.sql, section 6) read every
-- refund from audit_logs(action = 'refund'), because refund_order was the only thing that ever
-- "refunded" and it wrote nothing else. Since Stripe Connect (20260925100000) a card payment
-- taken online is refunded on the branch's own Stripe account and recorded in payment_refunds,
-- by the back office's stripe-refund function or, for a refund made straight in the branch's
-- Stripe Dashboard, by the Connect webhook. Read the old way the report would:
--
--   * miss every Dashboard refund (there is no audit row for it),
--   * count a back-office card refund the moment it was asked for, even if Stripe later failed
--     it (refund_order's audit row stays), and
--   * show nothing of disputes, which live on the payment (gateway_metadata.dispute_*).
--
-- So refunds are now read from two places that never overlap:
--
--   1. payment_refunds for every order whose payment went through Stripe (method 'card',
--      gateway 'stripe', a PaymentIntent id). Only 'succeeded' refunds count as refunded;
--      'pending' ones are their own figure (money Stripe is still sending back), and failed or
--      canceled ones moved no money and are only counted, so the owner can see they happened.
--   2. audit_logs refund rows for every other order (cash, QR transfer, a card swiped on the
--      restaurant's own terminal), exactly as before. The back office still calls refund_order
--      after a Stripe refund, for the order's status and history; those audit rows are skipped
--      here, so no card refund is counted twice.
--
-- Everything the report returned before is still returned under the same key with the same
-- meaning, so the report screen keeps working unchanged; `refunds` and `refund_count` simply
-- become right for card orders. New keys, for the screen to pick up:
--
--   totals.card_refunds            succeeded Stripe refunds (already inside totals.refunds)
--   totals.card_refunds_pending    Stripe refunds not settled yet (not inside totals.refunds)
--   totals.card_refund_failures    how many Stripe refunds failed or were canceled
--   disputes                       { count, open, amount, lost_amount, won_amount }, from the
--                                  dispute Stripe reported on a payment of this branch
--
-- Buckets: refunds by the day they were made (as before), disputes by the day the dispute was
-- opened (gateway_metadata.disputed_at, written by stripe_connect_record_dispute), both in the
-- branch's own timezone.

create or replace function public.get_branch_payments_report(
  p_branch_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_tz     text;
  v_rest   uuid;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
  d_from   date := least(p_from, p_to);
  d_to     date := greatest(p_from, p_to);
begin
  if not (private.user_is_platform_admin()
          or private.staff_has_capability(p_branch_id, 'reports.view')) then
    raise exception 'not authorized to read reports for this branch'
      using errcode = '42501';
  end if;

  if d_from is null or d_to is null then
    raise exception 'range_required' using errcode = 'P0001';
  end if;
  if d_to - d_from > 366 then
    raise exception 'range_too_wide' using errcode = 'P0001';
  end if;

  select coalesce(nullif(b.timezone, ''), 'UTC'), b.restaurant_id
    into v_tz, v_rest
    from public.branches b where b.id = p_branch_id;
  if v_tz is null then v_tz := 'UTC'; end if;

  v_from := (d_from::timestamp) at time zone v_tz;
  v_to   := ((d_to + 1)::timestamp) at time zone v_tz;

  with pay as (
    -- Bucketed by the ORDER's date, not paid_at: paid_at is null on every pending row,
    -- so a paid_at window would drop exactly the rows the merchant is chasing.
    select p.id, p.method, p.status, p.amount, p.paid_at,
           o.status as order_status, o.total, o.service_fee,
           (p.gateway_metadata->>'settled_via') as settled_via
      from public.payments p
      join public.orders o on o.id = p.order_id
     where p.branch_id = p_branch_id
       and o.created_at >= v_from and o.created_at < v_to
  ),
  methods as (select unnest(array['card','cash','transfer']) as method),
  statuses as (select unnest(enum_range(null::public.payment_status))::text as status),
  grid as (
    -- Every method x status cell, so an empty bucket renders 0 instead of vanishing and
    -- the merchant can see that "refunded" really is empty rather than missing.
    select m.method, s.status,
           coalesce((select count(*) from pay p
                      where p.method = m.method and p.status::text = s.status), 0) as count,
           round(coalesce((select sum(p.amount) from pay p
                            where p.method = m.method and p.status::text = s.status), 0), 2) as amount
      from methods m cross join statuses s
  ),
  -- Every Stripe refund of this branch made in the window, whatever became of it.
  stripe_refunds as (
    select r.amount, r.status, (r.created_at at time zone v_tz)::date as local_date
      from public.payment_refunds r
     where r.branch_id = p_branch_id
       and r.created_at >= v_from and r.created_at < v_to
  ),
  -- refund_order's audit rows, minus those for orders paid through Stripe: their money is
  -- counted from stripe_refunds, and refund_order is still called after a Stripe refund.
  audit_refunds as (
    select coalesce(nullif(a.metadata->>'amount', '')::numeric, 0) as amount,
           (a.created_at at time zone v_tz)::date as local_date
      from public.audit_logs a
     where a.branch_id = p_branch_id and a.action = 'refund' and a.entity_type = 'order'
       and a.created_at >= v_from and a.created_at < v_to
       and not exists (
         select 1 from public.payments sp
          where sp.order_id = a.entity_id
            and sp.method = 'card' and sp.gateway = 'stripe'
            and sp.gateway_charge_id is not null
       )
  ),
  -- Money that actually went back: every non-Stripe refund, and the Stripe ones Stripe settled.
  refunds as (
    select amount, local_date from audit_refunds
    union all
    select amount, local_date from stripe_refunds where status = 'succeeded'
  ),
  disputes as (
    select d.amount, d.status
      from (
        select coalesce(nullif(p.gateway_metadata->>'dispute_amount', '')::numeric, 0) as amount,
               coalesce(p.gateway_metadata->>'dispute_status', '') as status,
               -- jsonb holds whatever was written; one malformed stamp must cost that one row,
               -- not fail the whole report, so only a timestamp-shaped value is cast.
               case when p.gateway_metadata->>'disputed_at' ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}'
                    then (p.gateway_metadata->>'disputed_at')::timestamptz end as opened_at
          from public.payments p
         where p.branch_id = p_branch_id
           and p.gateway_metadata ? 'dispute_id'
      ) d
     where d.opened_at >= v_from and d.opened_at < v_to
  )
  select jsonb_build_object(
    'from', d_from, 'to', d_to, 'timezone', v_tz,
    'by_method_status', coalesce((select jsonb_agg(to_jsonb(g)) from grid g), '[]'::jsonb),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object(
        'method', m.method,
        'count',  (select count(*) from pay p where p.method = m.method),
        'amount', round(coalesce((select sum(p.amount) from pay p
                                   where p.method = m.method), 0), 2),
        'settled', round(coalesce((select sum(p.amount) from pay p
                                    where p.method = m.method and p.status = 'completed'), 0), 2)
      )) from methods m), '[]'::jsonb),
    'totals', jsonb_build_object(
      'payments', (select count(*) from pay),
      'settled',  round(coalesce((select sum(amount) from pay where status = 'completed'), 0), 2),
      'pending',  round(coalesce((select sum(amount) from pay where status = 'pending'), 0), 2),
      'failed',   round(coalesce((select sum(amount) from pay where status = 'failed'), 0), 2),
      -- Stripe card payments refunded in full are marked 'refunded' on the payment by
      -- stripe_connect_record_refund; every other payment still never is.
      'refunded_on_payments', round(coalesce((select sum(amount) from pay
                                               where status = 'refunded'), 0), 2),
      'voided_on_payments',   round(coalesce((select sum(amount) from pay
                                               where status = 'voided'), 0), 2),
      -- The real refund figure. NOT subtracted from the method totals above: the money
      -- genuinely arrived by that method; the refund is its own line.
      'refunds',      round(coalesce((select sum(amount) from refunds), 0), 2),
      'refund_count', (select count(*) from refunds),
      'card_refunds', round(coalesce((select sum(amount) from stripe_refunds
                                       where status = 'succeeded'), 0), 2),
      'card_refunds_pending', round(coalesce((select sum(amount) from stripe_refunds
                                               where status = 'pending'), 0), 2),
      'card_refund_failures', (select count(*) from stripe_refunds
                                where status in ('failed', 'canceled')),
      'service_fee_collected', round(coalesce((select sum(service_fee) from pay
                                                where order_status <> 'cancelled'), 0), 2),
      -- The actionable number 20260904160000_record_counter_payment exists for.
      'unsettled_on_completed_orders',
        round(coalesce((select sum(amount) from pay
                         where status = 'pending' and order_status = 'completed'), 0), 2),
      'backfilled_settlements',
        (select count(*) from pay where settled_via like 'backfill\_%')),
    'disputes', jsonb_build_object(
      'count', (select count(*) from disputes),
      -- Stripe's closed states are won, lost and warning_closed (an inquiry that was dropped);
      -- anything else still needs the restaurant, in its own Stripe Dashboard.
      'open', (select count(*) from disputes where status not in ('won', 'lost', 'warning_closed')),
      'amount', round(coalesce((select sum(amount) from disputes), 0), 2),
      'lost_amount', round(coalesce((select sum(amount) from disputes where status = 'lost'), 0), 2),
      'won_amount', round(coalesce((select sum(amount) from disputes where status = 'won'), 0), 2)),
    'refunds_daily', coalesce((select jsonb_agg(jsonb_build_object('day', r.local_date,
                                                                  'amount', r.amount))
                                 from refunds r), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_branch_payments_report(uuid, date, date) is
  'Method x status grid. `refunds` is money that went back: succeeded Stripe refunds from payment_refunds for orders paid through Stripe, and refund_order''s audit rows for every other order (never both for one order). Pending, failed and canceled Stripe refunds and disputes are returned beside it, not inside it.';

revoke execute on function public.get_branch_payments_report(uuid, date, date) from public, anon;
grant  execute on function public.get_branch_payments_report(uuid, date, date) to authenticated;
