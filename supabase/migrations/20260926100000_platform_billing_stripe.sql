-- Platform billing through Stripe: restaurants pay Favornoms by card (owner request 2026-09-26,
-- docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §3). This is the platform's own income -- the package
-- a restaurant buys (docs/PACKAGING-2026-09-23.md) -- and never diners paying restaurants, which is
-- Stripe Connect (20260925100000_stripe_connect_payments). The two share the platform's Stripe
-- account and the billing_events dedupe ledger, and nothing else.
--
-- 1. TWO RAILS. A restaurant is on the `stripe` rail while it has a live Stripe subscription
--    (private.billing_is_stripe_managed, the one definition every guard and UI flag uses), and on
--    the `manual` rail otherwise: the existing request -> platform approval path, kept for bank
--    transfers and special deals. The switch is platform_settings.billing->'stripe_enabled',
--    written only by the stripe-billing edge function (service role) after it has checked that the
--    keys and the webhook secret are set.
--
-- 2. REQUEST FIRST, THEN PAY. The merchant still files request_package_change, which prices
--    everything and reserves the discount code. The edge function then takes the card payment FOR
--    THAT REQUEST (billing_checkout_context / billing_mark_request_stripe) and, once Stripe says it
--    is paid, settles it here (billing_settle_stripe_request): the same billing_apply_selection the
--    manual approval uses, the request's one-time charges marked paid with the invoice that paid
--    them, the code's reservation redeemed, the request approved. Both rails therefore go through
--    one writer and cannot drift. A payment for a request that is no longer pending is refused, and
--    the caller refunds it (D12).
--
-- 3. PAID-THROUGH ONLY MOVES WHEN MONEY ARRIVES (D8). subscriptions.current_period_end is set when
--    a purchase settles and moved forward only by a paid invoice (billing_record_stripe_invoice).
--    Subscription events change the status and the cancel flags, never the date: the dormant rail
--    re-derived the period on every event and handed out a free month each time.
--
-- 4. SEVEN DAYS OF GRACE (D9). A failed renewal makes the restaurant past_due and it keeps working
--    until subscriptions.grace_until = paid-through + grace_days (platform_settings.billing, 7 when
--    absent). billing_compute and billing_expire_tick both read the grace, so the gates, the
--    storefront and the cron agree on when a restaurant goes dark. If Stripe gives up and cancels
--    during the grace, the grace is kept, so access still ends at the later of the paid-through date
--    and the grace (D9), not the moment the cancellation arrives.
--
-- 5. MANUAL CONTROLS ARE REFUSED ON A STRIPE RESTAURANT (D11). billing_set_package and approving a
--    request (a Stripe restaurant's, or any request awaiting a card payment) raise stripe_managed,
--    so our records and Stripe never disagree. Rejecting still works: it is how an operator clears
--    a checkout the merchant abandoned.
--
-- 6. restaurants.stripe_customer_id IS STRIPE'S. The column is readable by anyone who can read the
--    restaurant, and the owner could write it. Once the customer is what the portal and Checkout
--    are opened for, an owner could have pasted another restaurant's customer id into their own row
--    and opened that customer's portal: its card, invoices and cancel button. Only the service role
--    writes it now.
--
-- Every new function is SECURITY DEFINER with a pinned search_path and EXECUTE revoked from public.
-- The ones the edge function runs with the merchant's own JWT (billing_checkout_context,
-- billing_branch_context) check user_can_manage_billing themselves; the ones only the edge function
-- and the webhook may run are granted to service_role alone. Stripe objects are passed in as Stripe
-- sends them: amounts in cents, times as unix seconds (ISO strings are accepted too).

-- ---------------------------------------------------------------------------------------------
-- 1. Columns and the invoice ledger.
-- ---------------------------------------------------------------------------------------------

-- keys: stripe_enabled boolean, portal_configuration_id text, grace_days int (7 when absent).
alter table public.platform_settings
  add column if not exists billing jsonb not null default '{}'::jsonb;

alter table public.billing_requests
  add column if not exists rail text not null default 'manual',
  add column if not exists stripe_checkout_session_id text,
  -- The invoice a subscription change is waiting on (payment_behavior=pending_if_incomplete), or,
  -- once settled, the invoice that paid the request.
  add column if not exists stripe_invoice_id text,
  add column if not exists paid_at timestamptz;

do $$ begin
  alter table public.billing_requests
    add constraint billing_requests_rail_check check (rail in ('manual', 'stripe'));
exception when duplicate_object then null; end $$;

-- A Checkout session pays for exactly one request.
create unique index if not exists billing_requests_checkout_session_uniq
  on public.billing_requests (stripe_checkout_session_id) where stripe_checkout_session_id is not null;
create index if not exists billing_requests_stripe_invoice_idx
  on public.billing_requests (stripe_invoice_id) where stripe_invoice_id is not null;

alter table public.billing_charges
  add column if not exists stripe_invoice_id text;

-- Already there and now used: stripe_customer_id, stripe_subscription_id, next_billing_at,
-- cancel_at_period_end.
alter table public.subscriptions
  add column if not exists grace_until timestamptz,
  add column if not exists card_brand text,
  add column if not exists card_last4 text,
  add column if not exists card_exp_month int,
  add column if not exists card_exp_year int,
  add column if not exists cancel_at timestamptz;

-- Every invoice Stripe raised for a restaurant's package: the first purchase, each renewal, each
-- change. The merchant reads it through get_billing_overview and the platform through
-- list_restaurant_subscriptions; nobody reads the table directly.
create table if not exists public.billing_invoices (
  id                     uuid primary key default gen_random_uuid(),
  restaurant_id          uuid not null references public.restaurants(id) on delete cascade,
  stripe_invoice_id      text not null unique,
  stripe_subscription_id text,
  billing_reason         text,          -- subscription_create | subscription_cycle | subscription_update | ...
  status                 text not null, -- paid | open | uncollectible | void
  amount_due             numeric(10,2) not null default 0,
  amount_paid            numeric(10,2) not null default 0,
  currency               text not null default 'usd',
  period_start           timestamptz,
  period_end             timestamptz,
  hosted_invoice_url     text,
  paid_at                timestamptz,
  attempt_count          int not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists billing_invoices_restaurant_idx
  on public.billing_invoices (restaurant_id, created_at desc);
create index if not exists billing_invoices_subscription_idx
  on public.billing_invoices (stripe_subscription_id) where stripe_subscription_id is not null;

alter table public.billing_invoices enable row level security;
revoke all on public.billing_invoices from public, anon, authenticated;
grant all on public.billing_invoices to service_role;

comment on table public.billing_invoices is
  'Stripe invoices for platform packages (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md). Written by the stripe-webhook edge function through billing_record_stripe_invoice(_failed); read through get_billing_overview and list_restaurant_subscriptions. RLS on, no policies.';

-- ---------------------------------------------------------------------------------------------
-- 2. Small helpers.
-- ---------------------------------------------------------------------------------------------

-- Grace after a failed renewal, in days. An unreadable or out-of-range setting reads as the default.
create or replace function private.billing_grace_days()
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select case
             when jsonb_typeof(ps.billing -> 'grace_days') = 'number'
                  and (ps.billing ->> 'grace_days')::numeric between 0 and 60
             then floor((ps.billing ->> 'grace_days')::numeric)::integer
           end
      from public.platform_settings ps
     where ps.id = 1), 7);
$function$;

-- THE definition of "on the Stripe rail". A subscription the merchant has set to cancel at the end
-- of its period is still 'active' (with cancel_at_period_end) until Stripe ends it, so it counts.
create or replace function private.billing_is_stripe_managed(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select s.stripe_subscription_id is not null
           and s.status in ('trialing', 'active', 'past_due')
      from public.subscriptions s
     where s.restaurant_id = p_restaurant_id
     limit 1), false);
$function$;

comment on function private.billing_is_stripe_managed(uuid) is
  'True while the restaurant pays through a live Stripe subscription (subscriptions.stripe_subscription_id set and status trialing/active/past_due). Every stripe_managed guard and the rail flag of every billing payload read this.';

-- A Stripe time: unix seconds (as Stripe sends it) or an ISO string. Anything else is null.
create or replace function private.billing_json_ts(p jsonb)
returns timestamptz
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare v text;
begin
  if p is null or jsonb_typeof(p) not in ('number', 'string') then return null; end if;
  v := p #>> '{}';
  if v ~ '^[0-9]+(\.[0-9]+)?$' then
    if v::numeric <= 0 then return null; end if;
    return to_timestamp(v::double precision);
  end if;
  return v::timestamptz;
exception when others then
  return null;
end $function$;

-- A Stripe amount in cents, as dollars. Anything unreadable is 0.
create or replace function private.billing_json_dollars(p jsonb)
returns numeric
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select case
           when jsonb_typeof(p) in ('number', 'string') and (p #>> '{}') ~ '^-?[0-9]+$'
           then round((p #>> '{}')::numeric / 100, 2)
           else 0
         end;
$function$;

-- A Stripe id that may arrive expanded ({id: ...}) or as the id itself.
create or replace function private.billing_json_id(p jsonb)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select nullif(case jsonb_typeof(p)
                  when 'string' then p #>> '{}'
                  when 'object' then p ->> 'id'
                end, '');
$function$;

-- The card to store, from mapCard()'s {brand,last4,exp_month,exp_year}. Null unless it is one.
create or replace function private.billing_card(p jsonb)
returns jsonb
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select case
           when jsonb_typeof(p) = 'object'
                and coalesce(p ->> 'last4', '') ~ '^[0-9]{4}$'
                and coalesce(btrim(p ->> 'brand'), '') <> ''
           then jsonb_build_object(
                  'brand', left(btrim(p ->> 'brand'), 40),
                  'last4', p ->> 'last4',
                  'exp_month', case when coalesce(p ->> 'exp_month', '') ~ '^[0-9]{1,2}$'
                                    then (p ->> 'exp_month')::integer end,
                  'exp_year', case when coalesce(p ->> 'exp_year', '') ~ '^[0-9]{4}$'
                                   then (p ->> 'exp_year')::integer end)
         end;
$function$;

-- The subscription an invoice belongs to: basil's parent.subscription_details.subscription, or the
-- legacy top-level `subscription` (either may be expanded).
create or replace function private.billing_invoice_subscription(p_invoice jsonb)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(private.billing_json_id(p_invoice -> 'subscription'),
                  private.billing_json_id(p_invoice #> '{parent,subscription_details,subscription}'));
$function$;

-- Whose invoice this is: by the subscription first (ours, then one we have seen an invoice of),
-- then by the customer. restaurants.stripe_customer_id is only ever written by the service role
-- (section 9), so it can be trusted for this.
create or replace function private.billing_invoice_restaurant(p_subscription_id text, p_customer_id text)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    (select s.restaurant_id from public.subscriptions s
      where p_subscription_id is not null and s.stripe_subscription_id = p_subscription_id limit 1),
    (select bi.restaurant_id from public.billing_invoices bi
      where p_subscription_id is not null and bi.stripe_subscription_id = p_subscription_id
      order by bi.created_at desc limit 1),
    (select r.id from public.restaurants r
      where p_customer_id is not null and r.stripe_customer_id = p_customer_id
      order by r.created_at limit 1),
    (select s.restaurant_id from public.subscriptions s
      where p_customer_id is not null and s.stripe_customer_id = p_customer_id limit 1));
$function$;

-- Upsert one invoice. A paid or void invoice is final: a late failure event does not reopen it.
create or replace function private.billing_upsert_invoice(p_restaurant_id uuid, p_invoice jsonb, p_status text)
returns public.billing_invoices
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_row     public.billing_invoices;
  v_paid_at timestamptz := coalesce(private.billing_json_ts(p_invoice -> 'paid_at'),
                                    private.billing_json_ts(p_invoice #> '{status_transitions,paid_at}'));
begin
  insert into public.billing_invoices as bi
    (restaurant_id, stripe_invoice_id, stripe_subscription_id, billing_reason, status,
     amount_due, amount_paid, currency, period_start, period_end, hosted_invoice_url, paid_at,
     attempt_count)
  values
    (p_restaurant_id,
     p_invoice ->> 'id',
     private.billing_invoice_subscription(p_invoice),
     nullif(p_invoice ->> 'billing_reason', ''),
     p_status,
     private.billing_json_dollars(p_invoice -> 'amount_due'),
     private.billing_json_dollars(p_invoice -> 'amount_paid'),
     coalesce(nullif(lower(p_invoice ->> 'currency'), ''), 'usd'),
     private.billing_json_ts(p_invoice -> 'period_start'),
     private.billing_json_ts(p_invoice -> 'period_end'),
     nullif(p_invoice ->> 'hosted_invoice_url', ''),
     case when p_status = 'paid' then coalesce(v_paid_at, now()) else v_paid_at end,
     case when coalesce(p_invoice ->> 'attempt_count', '') ~ '^[0-9]{1,6}$'
          then (p_invoice ->> 'attempt_count')::integer else 0 end)
  on conflict (stripe_invoice_id) do update set
    stripe_subscription_id = coalesce(excluded.stripe_subscription_id, bi.stripe_subscription_id),
    billing_reason         = coalesce(excluded.billing_reason, bi.billing_reason),
    status                 = case when bi.status in ('paid', 'void') then bi.status else excluded.status end,
    amount_due             = excluded.amount_due,
    amount_paid            = greatest(bi.amount_paid, excluded.amount_paid),
    currency               = excluded.currency,
    period_start           = coalesce(excluded.period_start, bi.period_start),
    period_end             = coalesce(excluded.period_end, bi.period_end),
    hosted_invoice_url     = coalesce(excluded.hosted_invoice_url, bi.hosted_invoice_url),
    paid_at                = coalesce(bi.paid_at, excluded.paid_at),
    attempt_count          = greatest(bi.attempt_count, excluded.attempt_count),
    updated_at             = now()
  returning * into v_row;
  return v_row;
end $function$;

-- The invoice shape every payload uses (parseInvoiceSummary in packages/database billing.ts).
create or replace function private.billing_invoice_summary(p public.billing_invoices)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select case when (p).id is null then null else jsonb_build_object(
    'amount_paid',        (p).amount_paid,
    'amount_due',         (p).amount_due,
    'status',             (p).status,
    'paid_at',            (p).paid_at,
    'hosted_invoice_url', (p).hosted_invoice_url,
    'billing_reason',     (p).billing_reason,
    'attempt_count',      (p).attempt_count) end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 3. The deadline counts the grace.
-- ---------------------------------------------------------------------------------------------

-- The live body (20260923100000) with one change: the deadline of a past_due restaurant is its
-- grace, and a cancellation that arrived during the grace keeps it (D9).
create or replace function private.billing_compute(p_restaurant_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sub              public.subscriptions%rowtype;
  v_plan_code        text := 'none';
  v_status           text := 'none';
  v_entitled_through timestamptz;
  v_trial_ends_at    timestamptz;
  v_seats            integer := 0;
  v_total            numeric(10,2) := 0;
  v_features         jsonb := '{}'::jsonb;
  v_addons           text[] := '{}'::text[];
  v_overrides        jsonb := '{}'::jsonb;
  v_delivers         integer := 0;
  v_delivery_price   numeric(10,2);
begin
  if p_restaurant_id is null then return; end if;
  -- Mid-cascade (a restaurant being deleted takes its subscription with it) the restaurant row is
  -- already gone, and writing its entitlements would break billing_entitlements_restaurant_id_fkey
  -- and roll the whole delete back.
  if not exists (select 1 from public.restaurants where id = p_restaurant_id) then return; end if;

  select * into v_sub
  from public.subscriptions
  where restaurant_id = p_restaurant_id
  limit 1;

  if found then
    v_status        := v_sub.status::text;
    v_trial_ends_at := v_sub.trial_ends_at;

    -- Deadline. past_due and cancelled keep access until the paid period ends -- and past the
    -- period end until grace_until: a declined renewal card must not take a restaurant offline in
    -- the middle of service (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md D9). Only the Stripe rail
    -- ever writes grace_until, and billing_sync_stripe_status keeps it on a cancelled row only when
    -- Stripe gave up during the grace. greatest() ignores the NULL of every other row.
    if v_status in ('trialing', 'active', 'past_due', 'cancelled') then
      v_entitled_through := greatest(v_sub.current_period_end, v_sub.trial_ends_at,
                                     case when v_status in ('past_due', 'cancelled')
                                          then v_sub.grace_until end);
    else
      v_entitled_through := null;
    end if;

    -- The delivery line is DERIVED, never trusted from the snapshot. Its quantity was only ever
    -- written by billing_apply_selection, but branches are deleted and hidden outside it, and a
    -- deleted or hidden branch went on being billed $29 a month for ever: billing_entitlements
    -- said 116 while the same payload's delivery_branch_ids listed one branch and the plan page
    -- read 87 off it -- and, the page not being dirty, the merchant could not even resubmit to
    -- correct it (MONEY-2). The truth is the same one entitlements_json and branch_has_feature
    -- use: this restaurant's ACTIVE branches that hold an active delivery add-on. The branches
    -- table's own triggers (below) run this on every delete and hide, so the bill moves the
    -- moment the branch does.
    --
    -- Updated in place, never inserted: an operator's feature_overrides grant writes branch_addons
    -- rows without selling anything, and creating a line here would turn that comp into a charge.
    -- At zero the line is kept at quantity 1 (subscription_items_quantity_check forbids 0) priced
    -- at 0, so the restaurant keeps its delivery grant -- features.delivery comes off this line --
    -- and un-hiding a branch simply prices it again.
    select count(*) into v_delivers
      from public.branch_addons ba
      join public.branches b on b.id = ba.branch_id
     where b.restaurant_id = p_restaurant_id
       and b.is_active
       and ba.code = 'delivery'
       and ba.active;

    select monthly_price into v_delivery_price from public.billing_products where code = 'delivery';

    update public.subscription_items si
       set quantity   = greatest(v_delivers, 1),
           unit_price = case when v_delivers > 0 then coalesce(v_delivery_price, si.unit_price) else 0 end,
           updated_at = now()
     where si.subscription_id = v_sub.id
       and si.product_code = 'delivery'
       and (si.quantity, si.unit_price) is distinct from
           (greatest(v_delivers, 1),
            case when v_delivers > 0 then coalesce(v_delivery_price, si.unit_price) else 0 end);

    -- One row per line item: seats, money, add-on list, plan code. monthly_total is the sum of
    -- unit_price * quantity, which under the 2026-09-23 packaging is 29 x branch_seats plus 29 x
    -- delivering branches: the delivery line's quantity IS the number of delivering branches.
    select
      coalesce(sum(coalesce(bp.included_seats, 0) + coalesce(bp.seats_per_unit, 0) * si.quantity), 0),
      coalesce(sum(si.unit_price * si.quantity), 0),
      -- A product that sells SEATS is not a feature add-on. extra_branch used to land here, the
      -- plan page copied this array into its selection, and the seat was then priced twice.
      coalesce(array_agg(distinct bp.code)
               filter (where bp.kind = 'addon' and coalesce(bp.seats_per_unit, 0) = 0), '{}'::text[]),
      coalesce(min(bp.code) filter (where bp.kind = 'plan'), 'none')
    into v_seats, v_total, v_addons, v_plan_code
    from public.subscription_items si
    join public.billing_products bp on bp.code = si.product_code
    where si.subscription_id = v_sub.id;

    -- Feature grants are a set union, computed separately so it cannot skew the sums. Which
    -- BRANCHES a per-branch key covers is branch_addons' job, not this row's.
    select coalesce(jsonb_object_agg(k, true), '{}'::jsonb)
    into v_features
    from (
      select distinct f.key as k
      from public.subscription_items si
      join public.billing_products bp on bp.code = si.product_code
      cross join lateral jsonb_each(bp.features) f
      where si.subscription_id = v_sub.id
        and f.value = to_jsonb(true)
    ) keys;

    if coalesce(v_sub.plan_code, '') <> '' and v_plan_code = 'none' then
      v_plan_code := v_sub.plan_code;
    end if;

    -- A trial is $0 a month, whatever its lines say (docs/PACKAGING-2026-09-23.md §1). The
    -- platform console can give a trial more seats in one click, and a line priced from the
    -- catalog -- a seat line written before the trial rule existed, or by any future writer that
    -- forgets it -- would otherwise put "$29 every month" on a free trial's plan page (MONEY-5).
    -- Decided here, where the bill is summed, so no writer has to remember it.
    if exists (select 1 from public.billing_products bp
                where bp.code = v_plan_code and coalesce(bp.trial_days, 0) > 0) then
      v_total := 0;
    end if;
  end if;

  -- The override is applied LAST, on top of whatever the package resolved to,
  -- and outside the `found` branch so it also covers a restaurant with no
  -- subscription row at all. A forced-on key still needs entitled_through to be
  -- live: this switch controls WHICH features, never WHETHER they are paid for.
  -- For delivery it says the account may have delivery at all; branch_addons still
  -- says which branches, so the switch cannot quietly re-grant every branch.
  select coalesce(r.feature_overrides, '{}'::jsonb)
    into v_overrides
  from public.restaurants r
  where r.id = p_restaurant_id;

  if coalesce(v_overrides, '{}'::jsonb) <> '{}'::jsonb then
    select coalesce(jsonb_object_agg(merged.k, true), '{}'::jsonb)
      into v_features
    from (
      -- kept from the package, unless explicitly switched off
      select k from jsonb_object_keys(v_features) as k
      where coalesce(v_overrides -> k, 'null'::jsonb) is distinct from to_jsonb(false)
      union
      -- granted by the switch alone
      select e.key from jsonb_each(v_overrides) e where e.value = to_jsonb(true)
    ) merged(k);
  end if;

  insert into public.billing_entitlements as be
    (restaurant_id, plan_code, status, entitled_through, trial_ends_at,
     branch_seats, monthly_total, features, addons, computed_at)
  values
    (p_restaurant_id, v_plan_code, v_status, v_entitled_through, v_trial_ends_at,
     v_seats, v_total, v_features, v_addons, now())
  on conflict (restaurant_id) do update set
    plan_code        = excluded.plan_code,
    status           = excluded.status,
    entitled_through = excluded.entitled_through,
    trial_ends_at    = excluded.trial_ends_at,
    branch_seats     = excluded.branch_seats,
    monthly_total    = excluded.monthly_total,
    features         = excluded.features,
    addons           = excluded.addons,
    computed_at      = now();

  update public.branches
     set entitled_through = v_entitled_through
   where restaurant_id = p_restaurant_id
     and entitled_through is distinct from v_entitled_through;
end $function$;

-- Until now this function and its cron job lived only in the database, so rebuilding it from the
-- repo would have lost the thing that ends a lapsed package. Same body; the deadline is the one
-- billing_compute computes, grace included.
create or replace function private.billing_expire_tick()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_count integer := 0;
begin
  with expired as (
    update public.subscriptions
       set status = 'expired', updated_at = now()
     where status in ('trialing', 'active', 'past_due', 'cancelled')
       and greatest(current_period_end, trial_ends_at,
                    case when status in ('past_due', 'cancelled') then grace_until end) <= now()
    returning restaurant_id
  )
  select count(*) into v_count from expired;

  if v_count > 0 then
    perform public.billing_log_event('billing.expired', 'info',
      v_count || ' subscription(s) passed their period end', null, null);
  end if;
  return v_count;
end $function$;

comment on function private.billing_expire_tick() is
  'pg_cron billing-expire-tick, every 10 minutes: a subscription whose deadline (greatest of current_period_end, trial_ends_at and, while past_due or cancelled, grace_until) has passed becomes expired. The access gates compare the deadline themselves; this only moves the label.';

revoke all on function private.billing_expire_tick() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'billing-expire-tick') then
    perform cron.unschedule('billing-expire-tick');
  end if;
end $$;
select cron.schedule('billing-expire-tick', '*/10 * * * *', $$select private.billing_expire_tick()$$);

-- ---------------------------------------------------------------------------------------------
-- 4. Manual controls refuse a Stripe restaurant (D11).
-- ---------------------------------------------------------------------------------------------

create or replace function public.decide_billing_request(p_id uuid, p_approve boolean, p_note text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_req public.billing_requests%rowtype;
  v_ent jsonb;
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;

  select * into v_req from public.billing_requests where id = p_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_req.status <> 'pending' then raise exception 'request_already_decided'; end if;

  -- A request the merchant is paying by card is settled by Stripe's payment, and a restaurant on
  -- the Stripe rail changes its package through its subscription. Approving by hand would apply a
  -- package nobody was charged for, or one Stripe goes on billing differently. Rejecting stays
  -- open: it is how an operator clears a checkout the merchant abandoned (a payment that still
  -- arrives for it is refunded, D12).
  if p_approve and (v_req.rail = 'stripe' or private.billing_is_stripe_managed(v_req.restaurant_id)) then
    raise exception 'stripe_managed'
      using hint = 'This restaurant pays by card through Stripe; its package changes when Stripe is paid.';
  end if;

  if p_approve then
    v_ent := private.billing_apply_selection(
      v_req.restaurant_id, v_req.plan_code, coalesce(v_req.delivery_branch_ids, '{}'::uuid[]),
      v_req.branch_seats, 'active', null, null, null);

    -- On the manual rail money is collected out of band, so approval IS payment.
    update public.billing_charges
       set status = 'paid', paid_at = now()
     where request_id = v_req.id and status = 'pending';

    update public.billing_discount_redemptions
       set status = 'redeemed', redeemed_at = now()
     where request_id = v_req.id and status = 'reserved';
  else
    update public.billing_charges
       set status = 'void'
     where request_id = v_req.id and status = 'pending';

    perform private.billing_release_discount(array[v_req.id]);
  end if;

  update public.billing_requests
     set status        = case when p_approve then 'approved' else 'rejected' end,
         decided_by    = auth.uid(),
         decided_at    = now(),
         decision_note = p_note,
         updated_at    = now()
   where id = p_id;

  return jsonb_build_object('ok', true, 'approved', p_approve, 'entitlements', v_ent);
end $function$;

create or replace function public.billing_set_package(p_restaurant_id uuid, p_plan_code text, p_branch_seats integer default 1, p_delivery_branch_ids uuid[] default '{}'::uuid[], p_status text default 'active'::text, p_period_end timestamptz default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  -- Stripe bills this restaurant; a package applied here would not be what Stripe charges, and
  -- the next paid invoice would move a period this call had just rewritten. Feature switches and
  -- suspension are separate calls and still work.
  if private.billing_is_stripe_managed(p_restaurant_id) then
    raise exception 'stripe_managed'
      using hint = 'This restaurant pays by card through Stripe; change it in Stripe or from its plan page.';
  end if;
  return private.billing_apply_selection(
    p_restaurant_id, p_plan_code, coalesce(p_delivery_branch_ids, '{}'::uuid[]),
    p_branch_seats, p_status, null, p_period_end, null);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 5. What the stripe-billing edge function reads with the caller's JWT.
-- ---------------------------------------------------------------------------------------------

create or replace function public.billing_stripe_enabled()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select ps.billing -> 'stripe_enabled' = 'true'::jsonb
      from public.platform_settings ps
     where ps.id = 1), false);
$function$;

comment on function public.billing_stripe_enabled() is
  'Has the platform switched card billing on (platform_settings.billing.stripe_enabled)? Only the stripe-billing edge function writes the switch, after checking the keys and the webhook secret.';

create or replace function public.billing_checkout_context(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_req      public.billing_requests%rowtype;
  v_plan     public.billing_products%rowtype;
  v_seat     public.billing_products%rowtype;
  v_delivery public.billing_products%rowtype;
  v_extra    integer;
  v_delivers integer;
  v_lines    jsonb := '[]'::jsonb;
  v_sub      jsonb;
begin
  select * into v_req from public.billing_requests where id = p_request_id;
  -- An unknown request and a stranger's request answer the same, so this says nothing about
  -- which request ids exist.
  if not found or not private.user_can_manage_billing(v_req.restaurant_id) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  -- Only a request that is still on order can be paid for. A superseded or decided one would be
  -- refunded on arrival (D12); refusing here means nobody is charged for it in the first place.
  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'request_not_pending', 'status', v_req.status);
  end if;

  select * into v_plan from public.billing_products where code = v_req.plan_code and kind = 'plan';
  if not found or coalesce(v_plan.trial_days, 0) > 0 then
    return jsonb_build_object('ok', false, 'error', 'plan_not_billable');
  end if;
  select * into v_seat from public.billing_products where code = 'extra_branch';
  select * into v_delivery from public.billing_products where code = 'delivery';

  -- The monthly lines Stripe bills are the ones billing_compute will sum once this request is
  -- applied: the plan once, every seat past the included ones, and one delivery line per ACTIVE
  -- branch of this restaurant the request makes deliver.
  v_extra := greatest(v_req.branch_seats - coalesce(v_plan.included_seats, 0), 0);
  select count(distinct b.id) into v_delivers
    from public.branches b
   where b.restaurant_id = v_req.restaurant_id
     and b.is_active
     and b.id = any (coalesce(v_req.delivery_branch_ids, '{}'::uuid[]));

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'code', v_plan.code, 'quantity', 1,
    'unit_amount_cents', round(coalesce(v_plan.monthly_price, 0) * 100)::integer));
  if v_extra > 0 and v_seat.code is not null then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', v_seat.code, 'quantity', v_extra,
      'unit_amount_cents', round(coalesce(v_seat.monthly_price, 0) * 100)::integer));
  end if;
  if v_delivers > 0 and v_delivery.code is not null then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', v_delivery.code, 'quantity', v_delivers,
      'unit_amount_cents', round(coalesce(v_delivery.monthly_price, 0) * 100)::integer));
  end if;

  select jsonb_build_object(
           'status', s.status,
           'plan_code', s.plan_code,
           'stripe_subscription_id', s.stripe_subscription_id,
           'stripe_customer_id', s.stripe_customer_id,
           'current_period_end', s.current_period_end,
           'trial_ends_at', s.trial_ends_at,
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'product_code', si.product_code,
                      'quantity', si.quantity,
                      'stripe_subscription_item_id', si.stripe_subscription_item_id)
                    order by si.product_code)
               from public.subscription_items si
              where si.subscription_id = s.id), '[]'::jsonb))
    into v_sub
    from public.subscriptions s
   where s.restaurant_id = v_req.restaurant_id
   limit 1;

  return jsonb_build_object(
    'ok', true,
    'request', to_jsonb(v_req),
    'restaurant', (
      select jsonb_build_object(
               'id', r.id,
               'name', r.name,
               'slug', r.slug,
               'stripe_customer_id', r.stripe_customer_id,
               -- As stored. The edge function leaves out an address no mail can reach.
               'owner_email', u.email)
        from public.restaurants r
        left join auth.users u on u.id = r.owner_user_id
       where r.id = v_req.restaurant_id),
    -- What is charged once, at its NET amount (after the code). A $0 line -- today a branch's
    -- delivery unlock -- is left out: there is nothing to collect, and settling marks it paid with
    -- the rest of the request.
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'code', c.code,
               'branch_id', c.branch_id,
               'net_amount', c.net_amount)
             order by c.created_at, c.id)
        from public.billing_charges c
       where c.request_id = v_req.id
         and c.status = 'pending'
         and c.net_amount > 0), '[]'::jsonb),
    'monthly_lines', v_lines,
    'subscription', v_sub,
    'stripe_managed', private.billing_is_stripe_managed(v_req.restaurant_id));
end $function$;

comment on function public.billing_checkout_context(uuid) is
  'The stripe-billing edge function, with the CALLER''s JWT: everything needed to charge a pending package request by card. {ok:false, error:forbidden} unless the caller holds billing.manage for its restaurant (or the request does not exist); {ok:false, error:request_not_pending} once it is no longer on order. monthly_lines are in cents; charges are the non-zero one-time charges at their net amount in dollars.';

create or replace function public.billing_branch_context(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_rid uuid;
  v_can boolean;
  v_sub public.subscriptions%rowtype;
  v_cus text;
begin
  select b.restaurant_id into v_rid from public.branches b where b.id = p_branch_id;
  if v_rid is null then
    return jsonb_build_object('ok', false, 'error', 'branch_not_found');
  end if;

  v_can := private.user_can_manage_billing(v_rid);

  -- The Stripe ids are the billing owner's: someone who cannot manage billing learns only that
  -- they cannot.
  if v_can then
    select * into v_sub from public.subscriptions s where s.restaurant_id = v_rid limit 1;
    select coalesce(v_sub.stripe_customer_id, r.stripe_customer_id) into v_cus
      from public.restaurants r where r.id = v_rid;
  end if;

  return jsonb_build_object(
    'ok', true,
    'restaurant_id', v_rid,
    'can_manage', v_can,
    'stripe_customer_id', case when v_can then v_cus end,
    'stripe_subscription_id', case when v_can then v_sub.stripe_subscription_id end,
    'stripe_managed', v_can and private.billing_is_stripe_managed(v_rid));
end $function$;

comment on function public.billing_branch_context(uuid) is
  'The stripe-billing edge function, with the CALLER''s JWT: the restaurant a branch belongs to and whether the caller may manage its billing. The Stripe customer/subscription ids and stripe_managed are only filled in for someone who may.';

-- ---------------------------------------------------------------------------------------------
-- 6. What the edge function and the webhook write (service role only).
-- ---------------------------------------------------------------------------------------------

create or replace function public.billing_mark_request_stripe(p_request_id uuid, p_checkout_session_id text, p_invoice_id text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_checkout_session_id is not null and p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$' then
    raise exception 'invalid_checkout_session_id';
  end if;
  if p_invoice_id is not null and p_invoice_id !~ '^in_[A-Za-z0-9_]+$' then
    raise exception 'invalid_invoice_id';
  end if;

  -- The request is now being paid by exactly this session (a first purchase) or this invoice (a
  -- change waiting for 3-D Secure or a new card). A new session replaces the old one's id: the
  -- edge function expires the old session before it opens a new one.
  update public.billing_requests
     set rail                       = 'stripe',
         stripe_checkout_session_id = p_checkout_session_id,
         stripe_invoice_id          = p_invoice_id,
         updated_at                 = now()
   where id = p_request_id
     and status = 'pending';

  if not found then
    if exists (select 1 from public.billing_requests where id = p_request_id) then
      raise exception 'request_not_pending';
    end if;
    raise exception 'request_not_found';
  end if;
end $function$;

comment on function public.billing_mark_request_stripe(uuid, text, text) is
  'Service role: the pending request is being paid by card, through this Checkout session or this subscription-change invoice. Raises request_not_pending / request_not_found.';

create or replace function public.billing_set_stripe_customer(p_restaurant_id uuid, p_customer_id text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_customer_id is null or p_customer_id !~ '^cus_[A-Za-z0-9_]+$' then
    raise exception 'invalid_customer_id';
  end if;

  update public.restaurants
     set stripe_customer_id = p_customer_id
   where id = p_restaurant_id
     and stripe_customer_id is distinct from p_customer_id;
  if not found and not exists (select 1 from public.restaurants where id = p_restaurant_id) then
    raise exception 'restaurant_not_found';
  end if;

  -- A row that already pays through a Stripe subscription keeps the customer that subscription
  -- belongs to.
  update public.subscriptions
     set stripe_customer_id = p_customer_id, updated_at = now()
   where restaurant_id = p_restaurant_id
     and stripe_subscription_id is null
     and stripe_customer_id is distinct from p_customer_id;
end $function$;

comment on function public.billing_set_stripe_customer(uuid, text) is
  'Service role: the Stripe customer created for the restaurant, stored on restaurants and on its subscriptions row if that row is not already on a Stripe subscription.';

create or replace function public.billing_settle_stripe_request(
  p_request_id             uuid,
  p_stripe_customer_id     text,
  p_stripe_subscription_id text,
  p_invoice_id             text,
  p_paid_through           timestamptz,
  p_items                  jsonb,
  p_card                   jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_req     public.billing_requests%rowtype;
  v_sub     public.subscriptions%rowtype;
  v_has_sub boolean;
  v_managed boolean;
  v_kind    text;
  v_ent     jsonb;
  v_card    jsonb := private.billing_card(p_card);
  v_end     timestamptz;
  v_msg     text;
  v_state   text;
  v_payload jsonb;
begin
  v_payload := jsonb_build_object('request_id', p_request_id, 'customer', p_stripe_customer_id,
                                  'subscription', p_stripe_subscription_id, 'invoice', p_invoice_id,
                                  'paid_through', p_paid_through);

  if coalesce(p_stripe_subscription_id, '') = '' or coalesce(p_stripe_customer_id, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_arguments');
  end if;

  select * into v_req from public.billing_requests where id = p_request_id for update;
  if not found then
    perform public.billing_log_event('stripe.settle_refused', 'warn', 'request_not_found', null, v_payload);
    return jsonb_build_object('ok', false, 'reason', 'request_not_found');
  end if;

  -- The same payment told twice (Checkout's return page and the webhook, or a redelivery). The
  -- invoice that paid it is the evidence; when nothing was due there is no invoice, and the
  -- subscription the request was settled onto is.
  if v_req.status = 'approved' and v_req.rail = 'stripe' and v_req.paid_at is not null
     and ((p_invoice_id is not null and v_req.stripe_invoice_id = p_invoice_id)
          or (p_invoice_id is null and v_req.stripe_invoice_id is null
              and exists (select 1 from public.subscriptions s
                           where s.restaurant_id = v_req.restaurant_id
                             and s.stripe_subscription_id = p_stripe_subscription_id))) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'request_id', v_req.id,
                              'restaurant_id', v_req.restaurant_id);
  end if;

  -- Paid for something the merchant no longer wants: a stale Checkout tab paid after they changed
  -- their request, or a second payment for one already settled. The caller refunds it in full and
  -- cancels the subscription it created (D12).
  if v_req.status <> 'pending' then
    perform public.billing_log_event('stripe.settle_refused', 'warn', 'request_not_pending:' || v_req.status,
                                     v_req.restaurant_id, v_payload);
    return jsonb_build_object('ok', false, 'reason', 'request_not_pending', 'status', v_req.status,
                              'request_id', v_req.id, 'restaurant_id', v_req.restaurant_id);
  end if;

  select * into v_sub from public.subscriptions where restaurant_id = v_req.restaurant_id for update;
  v_has_sub := found;
  v_managed := v_has_sub and v_sub.stripe_subscription_id is not null
               and v_sub.status in ('trialing', 'active', 'past_due');

  -- One subscription per restaurant. A Checkout that completes while another subscription already
  -- bills the restaurant created a second one: the caller must refund it and cancel it exactly as
  -- for a stale request, so it is answered the same way.
  if v_managed and v_sub.stripe_subscription_id <> p_stripe_subscription_id then
    perform public.billing_log_event('stripe.settle_refused', 'warn', 'another_subscription',
                                     v_req.restaurant_id, v_payload);
    return jsonb_build_object('ok', false, 'reason', 'request_not_pending', 'status', v_req.status,
                              'detail', 'another_subscription',
                              'request_id', v_req.id, 'restaurant_id', v_req.restaurant_id);
  end if;

  if exists (select 1 from public.subscriptions s
              where s.stripe_subscription_id = p_stripe_subscription_id
                and s.restaurant_id <> v_req.restaurant_id) then
    perform public.billing_log_event('stripe.settle_failed', 'error', 'subscription_of_another_restaurant',
                                     v_req.restaurant_id, v_payload);
    return jsonb_build_object('ok', false, 'reason', 'settle_failed',
                              'detail', 'subscription_of_another_restaurant');
  end if;

  v_kind := case when v_managed then 'change' else 'first_purchase' end;

  -- The one writer both rails share. A refusal from it (the seats no longer cover the active
  -- branches, the plan was withdrawn) cannot be fixed by retrying, so it is logged and answered
  -- instead of raised: a raise would make the webhook answer 500 and Stripe redeliver forever.
  -- Lock and serialization failures are the exception -- a retry does fix those.
  begin
    if v_kind = 'first_purchase' then
      -- Paid through the first charge date (the rest of a trial, or of a manually paid month, D5)
      -- or the end of the first paid period. The trial ends here in our records (D6).
      v_ent := private.billing_apply_selection(
        v_req.restaurant_id, v_req.plan_code, coalesce(v_req.delivery_branch_ids, '{}'::uuid[]),
        v_req.branch_seats, 'active', now(),
        case when p_paid_through > now() then p_paid_through end, null);
    else
      -- A change keeps the period Stripe is billing; what it cost was charged on the invoice.
      v_ent := private.billing_apply_selection(
        v_req.restaurant_id, v_req.plan_code, coalesce(v_req.delivery_branch_ids, '{}'::uuid[]),
        v_req.branch_seats, v_sub.status::text, v_sub.current_period_start, v_sub.current_period_end, null);
    end if;
  exception
    when deadlock_detected or serialization_failure or lock_not_available or query_canceled then
      raise;
    when others then
      get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
      perform public.billing_log_event('stripe.settle_failed', 'error', v_msg, v_req.restaurant_id,
                                       v_payload || jsonb_build_object('sqlstate', v_state, 'kind', v_kind));
      return jsonb_build_object('ok', false, 'reason', 'settle_failed', 'detail', v_msg,
                                'request_id', v_req.id, 'restaurant_id', v_req.restaurant_id);
  end;

  if v_kind = 'first_purchase' then
    select current_period_end into v_end from public.subscriptions where restaurant_id = v_req.restaurant_id;
    update public.subscriptions
       set stripe_customer_id     = p_stripe_customer_id,
           stripe_subscription_id = p_stripe_subscription_id,
           next_billing_at        = v_end,
           grace_until            = null,
           cancel_at_period_end   = false,
           cancel_at              = null,
           card_brand             = coalesce(v_card ->> 'brand', card_brand),
           card_last4             = coalesce(v_card ->> 'last4', card_last4),
           card_exp_month         = case when v_card is not null then (v_card ->> 'exp_month')::integer else card_exp_month end,
           card_exp_year          = case when v_card is not null then (v_card ->> 'exp_year')::integer else card_exp_year end,
           updated_at             = now()
     where restaurant_id = v_req.restaurant_id;

    update public.restaurants
       set stripe_customer_id = p_stripe_customer_id
     where id = v_req.restaurant_id
       and stripe_customer_id is null;
  elsif v_card is not null then
    update public.subscriptions
       set card_brand     = v_card ->> 'brand',
           card_last4     = v_card ->> 'last4',
           card_exp_month = (v_card ->> 'exp_month')::integer,
           card_exp_year  = (v_card ->> 'exp_year')::integer,
           updated_at     = now()
     where restaurant_id = v_req.restaurant_id;
  end if;

  -- Stripe's item ids, so the next change updates these lines instead of adding new ones.
  update public.subscription_items si
     set stripe_subscription_item_id = i.item_id, updated_at = now()
    from (select e ->> 'product_code' as code, nullif(e ->> 'stripe_subscription_item_id', '') as item_id
            from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) e) i,
         public.subscriptions s
   where s.restaurant_id = v_req.restaurant_id
     and si.subscription_id = s.id
     and si.product_code = i.code
     and i.item_id is not null
     and si.stripe_subscription_item_id is distinct from i.item_id;

  update public.billing_charges
     set status = 'paid', paid_at = now(), stripe_invoice_id = p_invoice_id
   where request_id = v_req.id and status = 'pending';

  update public.billing_discount_redemptions
     set status = 'redeemed', redeemed_at = now()
   where request_id = v_req.id and status = 'reserved';

  update public.billing_requests
     set status            = 'approved',
         rail              = 'stripe',
         paid_at           = now(),
         decided_by        = null,
         decided_at        = now(),
         decision_note     = 'Paid by card (Stripe)',
         stripe_invoice_id = coalesce(p_invoice_id, stripe_invoice_id),
         updated_at        = now()
   where id = v_req.id;

  perform public.billing_log_event('stripe.request_settled', 'info', v_kind, v_req.restaurant_id,
                                   v_payload || jsonb_build_object('kind', v_kind));

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'kind', v_kind,
    'request_id', v_req.id,
    'restaurant_id', v_req.restaurant_id,
    'current_period_end', (select current_period_end from public.subscriptions where restaurant_id = v_req.restaurant_id),
    'entitlements', v_ent);
end $function$;

comment on function public.billing_settle_stripe_request(uuid, text, text, text, timestamptz, jsonb, jsonb) is
  'Service role: a package request paid by card. First purchase (not yet Stripe-managed): the package is applied active, paid through p_paid_through, with the Stripe ids and card stored. Change (the same subscription): applied keeping the current period. Then the request''s charges are paid (with the invoice), its code redeemed and the request approved. Returns {ok:true, duplicate, kind} | {ok:false, reason: request_not_pending (refund it, D12; also when another subscription already bills the restaurant) | settle_failed (logged, never retried) | request_not_found | invalid_arguments}.';

create or replace function public.billing_cancel_stripe_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_req public.billing_requests%rowtype;
begin
  select * into v_req from public.billing_requests where id = p_request_id for update;
  if not found or v_req.status <> 'pending' then return; end if;

  -- Never paid, so never bought: the charges were only on order and the code's use goes back.
  update public.billing_charges
     set status = 'void'
   where request_id = v_req.id and status = 'pending';

  perform private.billing_release_discount(array[v_req.id]);

  update public.billing_requests
     set status        = 'cancelled',
         decided_at    = now(),
         decision_note = coalesce(nullif(btrim(p_reason), ''), 'Card payment not completed'),
         updated_at    = now()
   where id = v_req.id;

  perform public.billing_log_event('stripe.request_cancelled', 'info', p_reason, v_req.restaurant_id,
                                   jsonb_build_object('request_id', v_req.id));
end $function$;

comment on function public.billing_cancel_stripe_request(uuid, text) is
  'Service role: a card payment that will never be completed (a pending subscription update expired, a checkout replaced). pending -> cancelled, its charges void, its code reservation released. No-op when not pending.';

create or replace function public.billing_sync_stripe_status(
  p_stripe_subscription_id text,
  p_status                 text,
  p_cancel_at_period_end   boolean,
  p_cancel_at              timestamptz,
  p_next_billing_at        timestamptz,
  p_card                   jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sub   public.subscriptions%rowtype;
  v_old   text;
  v_new   text;
  v_grace timestamptz;
  v_full  boolean := p_status is not null;
  v_card  jsonb := private.billing_card(p_card);
begin
  if coalesce(p_stripe_subscription_id, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'unknown_subscription');
  end if;

  -- Only the restaurant this subscription bills today. A subscription it has left behind resolves
  -- to nothing.
  select * into v_sub from public.subscriptions
   where stripe_subscription_id = p_stripe_subscription_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_subscription');
  end if;

  v_old := v_sub.status::text;
  -- incomplete / incomplete_expired: nothing was paid and nothing was lost -- the status the
  -- restaurant had stands (the dormant rail read incomplete as past_due, which grants access).
  -- A null status is a card-only update.
  v_new := case lower(coalesce(p_status, ''))
             when 'trialing' then 'active'
             when 'active'   then 'active'
             when 'past_due' then 'past_due'
             when 'unpaid'   then 'past_due'
             when 'canceled' then 'cancelled'
             when 'paused'   then 'expired'
             else v_old
           end;
  -- A restaurant that has already gone dark stays expired until money arrives (invoice.paid) or
  -- Stripe calls it active again; past_due and cancelled would only relabel it.
  if v_old = 'expired' and v_new in ('past_due', 'cancelled') then
    v_new := 'expired';
  end if;

  v_grace := v_sub.grace_until;
  if v_new = 'past_due' then
    -- Entering past_due starts the grace once; later retries do not extend it.
    v_grace := coalesce(v_grace, v_sub.current_period_end + make_interval(days => private.billing_grace_days()));
  elsif v_new = v_old then
    null;
  elsif v_new = 'cancelled' and v_old = 'past_due' then
    -- Stripe gave up during the grace: access still ends at the later of paid-through and grace (D9).
    null;
  else
    v_grace := null;
  end if;

  -- Never current_period_end: only a paid invoice moves it (D8).
  update public.subscriptions
     set status               = v_new::public.subscription_status,
         grace_until          = v_grace,
         cancel_at_period_end = case when v_full then coalesce(p_cancel_at_period_end, false)
                                     else coalesce(p_cancel_at_period_end, cancel_at_period_end) end,
         cancel_at            = case when v_full then p_cancel_at else coalesce(p_cancel_at, cancel_at) end,
         next_billing_at      = case when v_full then p_next_billing_at else coalesce(p_next_billing_at, next_billing_at) end,
         cancelled_at         = case when v_new in ('cancelled', 'expired') then coalesce(cancelled_at, now())
                                     when v_new <> v_old then null
                                     else cancelled_at end,
         card_brand           = coalesce(v_card ->> 'brand', card_brand),
         card_last4           = coalesce(v_card ->> 'last4', card_last4),
         card_exp_month       = case when v_card is not null then (v_card ->> 'exp_month')::integer else card_exp_month end,
         card_exp_year        = case when v_card is not null then (v_card ->> 'exp_year')::integer else card_exp_year end,
         updated_at           = now()
   where id = v_sub.id;

  if v_new <> v_old then
    perform public.billing_log_event('stripe.status_changed',
                                     case when v_new in ('past_due', 'expired') then 'warn' else 'info' end,
                                     v_old || ' -> ' || v_new, v_sub.restaurant_id,
                                     jsonb_build_object('subscription', p_stripe_subscription_id,
                                                        'stripe_status', p_status, 'grace_until', v_grace));
  end if;

  return jsonb_build_object(
    'ok', true,
    'restaurant_id', v_sub.restaurant_id,
    'status', v_new,
    'previous_status', v_old,
    'changed', v_new <> v_old,
    'grace_until', v_grace,
    'current_period_end', v_sub.current_period_end);
end $function$;

comment on function public.billing_sync_stripe_status(text, text, boolean, timestamptz, timestamptz, jsonb) is
  'Service role: status, cancel flags and card from a re-fetched Stripe subscription, for the restaurant it bills. trialing|active -> active, past_due|unpaid -> past_due (grace starts once), canceled -> cancelled (a grace already running is kept), paused -> expired, incomplete* -> unchanged. A null p_status updates only what is given (the card). NEVER moves current_period_end.';

create or replace function public.billing_record_stripe_invoice(p_invoice jsonb, p_paid_through timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id      text := p_invoice ->> 'id';
  v_sub_id  text := private.billing_invoice_subscription(p_invoice);
  v_cus     text := private.billing_json_id(p_invoice -> 'customer');
  v_status  text := coalesce(nullif(lower(p_invoice ->> 'status'), ''), 'paid');
  v_rid     uuid;
  v_sub     public.subscriptions%rowtype;
  v_row     public.billing_invoices;
  v_applied boolean := false;
begin
  if coalesce(v_id, '') !~ '^in_[A-Za-z0-9_]+$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_invoice');
  end if;

  v_rid := private.billing_invoice_restaurant(v_sub_id, v_cus);
  if v_rid is null then
    perform public.billing_log_event('stripe.unresolved_invoice', 'warn', v_id, null,
                                     jsonb_build_object('invoice', v_id, 'subscription', v_sub_id, 'customer', v_cus));
    return jsonb_build_object('ok', false, 'reason', 'unknown_customer');
  end if;

  v_row := private.billing_upsert_invoice(v_rid, p_invoice, v_status);

  -- Money arrived for the subscription that bills the restaurant today: the paid-through date moves
  -- FORWARD to the period this invoice paid for, never back (a late, older invoice changes
  -- nothing), and a failed renewal it settles is over.
  if v_row.status = 'paid' and v_sub_id is not null and p_paid_through is not null then
    select * into v_sub from public.subscriptions
     where restaurant_id = v_rid and stripe_subscription_id = v_sub_id
     for update;
    if found then
      update public.subscriptions
         set current_period_end = greatest(current_period_end, p_paid_through),
             next_billing_at    = greatest(current_period_end, p_paid_through),
             -- A subscription Stripe already ended stays cancelled; it has the days it paid for.
             status             = case when status = 'cancelled' then status else 'active' end,
             cancelled_at       = case when status = 'cancelled' then cancelled_at end,
             grace_until        = null,
             updated_at         = now()
       where id = v_sub.id;
      v_applied := true;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'restaurant_id', v_rid,
    'invoice_id', v_id,
    'status', v_row.status,
    'applied', v_applied,
    'current_period_end', (select current_period_end from public.subscriptions where restaurant_id = v_rid));
end $function$;

comment on function public.billing_record_stripe_invoice(jsonb, timestamptz) is
  'Service role, invoice.paid: records the invoice (p_invoice as Stripe sends it -- amounts in cents, times in unix seconds; subscription top-level or under parent.subscription_details) and, when it is paid and belongs to the subscription billing the restaurant, moves current_period_end forward to p_paid_through, sets the status active and ends any grace.';

create or replace function public.billing_record_stripe_invoice_failed(p_invoice jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id       text := p_invoice ->> 'id';
  v_sub_id   text := private.billing_invoice_subscription(p_invoice);
  v_cus      text := private.billing_json_id(p_invoice -> 'customer');
  v_status   text := lower(coalesce(p_invoice ->> 'status', ''));
  v_rid      uuid;
  v_sub      public.subscriptions%rowtype;
  v_row      public.billing_invoices;
  v_past_due boolean := false;
begin
  if coalesce(v_id, '') !~ '^in_[A-Za-z0-9_]+$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_invoice');
  end if;
  if v_status not in ('open', 'uncollectible', 'void', 'paid') then
    v_status := 'open';
  end if;

  v_rid := private.billing_invoice_restaurant(v_sub_id, v_cus);
  if v_rid is null then
    perform public.billing_log_event('stripe.unresolved_invoice', 'warn', v_id, null,
                                     jsonb_build_object('invoice', v_id, 'subscription', v_sub_id, 'customer', v_cus));
    return jsonb_build_object('ok', false, 'reason', 'unknown_customer');
  end if;

  v_row := private.billing_upsert_invoice(v_rid, p_invoice, v_status);

  -- Only a failed RENEWAL of the subscription billing the restaurant makes it past_due. A change
  -- that failed waits as a pending update and the package stays as it was; an invoice that has
  -- been paid since (events arrive in any order) is not a failure any more.
  if v_row.status = 'open' and v_row.billing_reason = 'subscription_cycle' and v_sub_id is not null then
    select * into v_sub from public.subscriptions
     where restaurant_id = v_rid and stripe_subscription_id = v_sub_id
       and status in ('active', 'past_due')
     for update;
    if found then
      update public.subscriptions
         set status      = 'past_due',
             grace_until = coalesce(grace_until,
                                    current_period_end + make_interval(days => private.billing_grace_days())),
             updated_at  = now()
       where id = v_sub.id;
      v_past_due := true;
      if v_sub.status <> 'past_due' then
        perform public.billing_log_event('stripe.renewal_failed', 'warn', v_id, v_rid,
                                         jsonb_build_object('invoice', v_id, 'attempt_count', v_row.attempt_count));
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'restaurant_id', v_rid,
    'invoice_id', v_id,
    'invoice_status', v_row.status,
    'past_due', v_past_due,
    'grace_until', (select grace_until from public.subscriptions where restaurant_id = v_rid));
end $function$;

comment on function public.billing_record_stripe_invoice_failed(jsonb) is
  'Service role, invoice.payment_failed / payment_action_required: records the invoice as open with its attempt count and, for a renewal (billing_reason subscription_cycle) of the subscription billing the restaurant, makes it past_due with grace_until = paid-through + grace days, set once.';

create or replace function public.billing_request_for_invoice(p_invoice_id text)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select br.id
    from public.billing_requests br
   where p_invoice_id is not null
     and br.stripe_invoice_id = p_invoice_id
     and br.status = 'pending'
   order by br.created_at desc
   limit 1;
$function$;

comment on function public.billing_request_for_invoice(text) is
  'Service role: the pending request a subscription-change invoice was waiting on, if any.';

-- ---------------------------------------------------------------------------------------------
-- 7. What the merchant and the platform read.
-- ---------------------------------------------------------------------------------------------

-- The `billing` object of get_billing_overview and list_restaurant_subscriptions
-- (parseBillingRailInfo in packages/database/src/queries/billing.ts).
create or replace function private.billing_rail_json(p_restaurant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'stripe_enabled',       public.billing_stripe_enabled(),
    'rail',                 case when m.managed then 'stripe' else 'manual' end,
    'status',               coalesce(s.status::text, be.status, 'none'),
    'stripe_customer',      coalesce(s.stripe_customer_id, r.stripe_customer_id) is not null,
    -- Only the Stripe rail charges by itself, and not once the subscription is set to end first.
    'next_charge_at',       case
                              when m.managed
                                   and not coalesce(s.cancel_at_period_end, false)
                                   and (s.cancel_at is null
                                        or s.cancel_at > coalesce(s.next_billing_at, s.current_period_end))
                              then coalesce(s.next_billing_at, s.current_period_end)
                            end,
    'next_charge_amount',   be.monthly_total,
    'cancel_at_period_end', coalesce(s.cancel_at_period_end, false),
    'cancel_at',            s.cancel_at,
    'grace_until',          s.grace_until,
    'card',                 case when s.card_last4 is not null then jsonb_build_object(
                              'brand', s.card_brand, 'last4', s.card_last4,
                              'exp_month', s.card_exp_month, 'exp_year', s.card_exp_year) end,
    'last_invoice',         (select private.billing_invoice_summary(bi)
                               from public.billing_invoices bi
                              where bi.restaurant_id = p_restaurant_id
                              order by bi.created_at desc, bi.id desc
                              limit 1),
    'pending_request_rail', (select br.rail
                               from public.billing_requests br
                              where br.restaurant_id = p_restaurant_id and br.status = 'pending'
                              order by br.created_at desc
                              limit 1))
  from (select private.billing_is_stripe_managed(p_restaurant_id) as managed) m
  left join public.restaurants r on r.id = p_restaurant_id
  left join public.subscriptions s on s.restaurant_id = p_restaurant_id
  left join public.billing_entitlements be on be.restaurant_id = p_restaurant_id;
$function$;

create or replace function public.get_billing_overview(p_restaurant_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_paid jsonb;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  -- The ledger of what this restaurant has paid is billing.manage's to read, and the matrix
  -- gives that to the owner alone. See private.user_can_manage_billing.
  if not private.user_can_manage_billing(p_restaurant_id) then
    raise exception 'forbidden';
  end if;

  v_paid := private.billing_paid_state(p_restaurant_id);

  return jsonb_build_object(
    'entitlements', private.entitlements_json(p_restaurant_id),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id,
               'name', b.name,
               -- Switched on today, deadline aside. For a trial that is every branch, and it says
               -- nothing about whether the $59 was bought -- delivery_unlocked does.
               'delivery_active', private.branch_feature_granted(b.id, 'delivery'),
               -- Unlocked = the $59 was PAID at some point, so switching this branch back on
               -- later costs nothing one-time.
               'delivery_unlocked', private.branch_delivery_unlocked(b.id)
             ) order by b.created_at, b.id)
        from public.branches b
       where b.restaurant_id = p_restaurant_id and b.is_active
    ), '[]'::jsonb),
    -- What is PAID. A pending request's charges are not in here; they are on order, and the
    -- request below says what they come to.
    'paid', v_paid,
    -- The restaurant's open request, if any, as the plan page shows it: what it will cost once
    -- (net of the code), which code and how much came off, and its rail (stripe = waiting for the
    -- card payment to finish). Its charges are in `charges` with status 'pending'.
    'pending_request', (
      select to_jsonb(br) from public.billing_requests br
       where br.restaurant_id = p_restaurant_id and br.status = 'pending'
       order by br.created_at desc limit 1),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'code', c.code,
               'branch_id', c.branch_id,
               'amount', c.amount,
               'discount_code', c.discount_code,
               'discount_amount', c.discount_amount,
               'net_amount', c.net_amount,
               'status', c.status,
               'request_id', c.request_id,
               'created_at', c.created_at,
               'paid_at', c.paid_at
             ) order by c.created_at desc, c.id)
        from public.billing_charges c
       where c.restaurant_id = p_restaurant_id
    ), '[]'::jsonb),
    -- How it pays: card through Stripe or the manual rail, and on the Stripe rail the next charge,
    -- the card, the last invoice and any failed renewal's grace.
    'billing', private.billing_rail_json(p_restaurant_id));
end $function$;

create or replace function public.list_restaurant_subscriptions()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'restaurant_id',          r.id,
        'restaurant_name',        r.name,
        'restaurant_slug',        r.slug,
        'created_at',             r.created_at,
        'entitlements',           private.entitlements_json(r.id),
        'feature_overrides',      coalesce(r.feature_overrides, '{}'::jsonb),
        'billing',                private.billing_rail_json(r.id),
        'stripe_customer_id',     coalesce(s.stripe_customer_id, r.stripe_customer_id),
        'stripe_subscription_id', s.stripe_subscription_id,
        -- A failed renewal Stripe is still retrying: what is owed and the page to pay it on.
        'open_invoice',           case when s.status = 'past_due' and s.stripe_subscription_id is not null then (
                                    select private.billing_invoice_summary(bi)
                                      from public.billing_invoices bi
                                     where bi.restaurant_id = r.id
                                       and bi.stripe_subscription_id = s.stripe_subscription_id
                                       and bi.status = 'open'
                                     order by bi.created_at desc, bi.id desc
                                     limit 1) end
      ) order by r.name
    )
    from public.restaurants r
    left join public.subscriptions s on s.restaurant_id = r.id
  ), '[]'::jsonb);
end $function$;

-- Same body as live; the rows now carry rail, stripe_checkout_session_id, stripe_invoice_id and
-- paid_at through to_jsonb.
create or replace function public.list_billing_requests(p_status text default 'pending'::text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'created_at' desc)
    from (
      select to_jsonb(br) || jsonb_build_object('restaurant_name', r.name, 'restaurant_slug', r.slug) as x
      from public.billing_requests br
      join public.restaurants r on r.id = br.restaurant_id
      where p_status is null or br.status = p_status
    ) s
  ), '[]'::jsonb);
end $function$;

create or replace function public.platform_billing_events(p_restaurant_id uuid default null, p_limit integer default 50)
returns jsonb[]
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  return coalesce((
    select array_agg(x order by created_at desc, id desc)
      from (
        select jsonb_build_object(
                 'id', e.id,
                 'stripe_event_id', e.stripe_event_id,
                 'type', e.type,
                 'level', e.level,
                 'note', e.note,
                 'restaurant_id', e.restaurant_id,
                 'payload', e.payload,
                 'created_at', e.created_at) as x,
               e.created_at, e.id
          from public.billing_events e
         where (p_restaurant_id is null or e.restaurant_id = p_restaurant_id)
           -- The same ledger holds the Connect webhook's events (diners paying restaurants).
           and e.type not like 'account.%'
           and e.type not like 'payment_intent.%'
           and e.type not like 'charge.%'
           and e.type not like 'refund.%'
           and e.type not like 'stripe_connect.%'
         order by e.created_at desc, e.id desc
         limit greatest(1, least(coalesce(p_limit, 50), 500))
      ) s
  ), '{}'::jsonb[]);
end $function$;

comment on function public.platform_billing_events(uuid, integer) is
  'Platform admin: package-billing events (webhook receipts, settlements, failures, expiries), newest first. Stripe Connect events are left out.';

-- ---------------------------------------------------------------------------------------------
-- 8. restaurants.stripe_customer_id is written by the service role only.
-- ---------------------------------------------------------------------------------------------

-- The live guard with one change: stripe_customer_id moves above the owner/platform-admin early
-- return (header, item 6).
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

  -- Also above it: the Stripe customer is the one the customer portal and Checkout are opened
  -- for, and every restaurant's is readable. An owner who could write it could open another
  -- restaurant's portal. Only the stripe-billing edge function (service role) sets it.
  if new.stripe_customer_id is distinct from old.stripe_customer_id then
    raise exception 'restaurant_privileged_column_denied'
      using hint = 'The Stripe customer is set by the platform when the restaurant first pays by card.';
  end if;

  if private.user_is_platform_admin() or old.owner_user_id = auth.uid() then
    return new;
  end if;
  if new.id                 is distinct from old.id
     or new.owner_user_id      is distinct from old.owner_user_id
     or new.slug               is distinct from old.slug
     or new.custom_domain      is distinct from old.custom_domain
     or new.franchise_group_id is distinct from old.franchise_group_id
     or new.feature_overrides  is distinct from old.feature_overrides then
    raise exception 'restaurant_privileged_column_denied'
      using hint = 'Only the restaurant owner or a platform admin may change ownership, slug, custom domain, billing or feature-override columns.';
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 9. Grants.
-- ---------------------------------------------------------------------------------------------

revoke all on function private.billing_grace_days() from public, anon, authenticated;
revoke all on function private.billing_is_stripe_managed(uuid) from public, anon, authenticated;
revoke all on function private.billing_json_ts(jsonb) from public, anon, authenticated;
revoke all on function private.billing_json_dollars(jsonb) from public, anon, authenticated;
revoke all on function private.billing_json_id(jsonb) from public, anon, authenticated;
revoke all on function private.billing_card(jsonb) from public, anon, authenticated;
revoke all on function private.billing_invoice_subscription(jsonb) from public, anon, authenticated;
revoke all on function private.billing_invoice_restaurant(text, text) from public, anon, authenticated;
revoke all on function private.billing_upsert_invoice(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.billing_invoice_summary(public.billing_invoices) from public, anon, authenticated;
revoke all on function private.billing_rail_json(uuid) from public, anon, authenticated;
revoke all on function private.billing_compute(uuid) from public, anon, authenticated;
revoke all on function private.guard_restaurant_privileged_columns() from public, anon, authenticated;

-- Signed-in callers; each checks who they are itself.
revoke all on function public.billing_stripe_enabled() from public, anon;
grant execute on function public.billing_stripe_enabled() to authenticated, service_role;
revoke all on function public.billing_checkout_context(uuid) from public, anon;
grant execute on function public.billing_checkout_context(uuid) to authenticated, service_role;
revoke all on function public.billing_branch_context(uuid) from public, anon;
grant execute on function public.billing_branch_context(uuid) to authenticated, service_role;
revoke all on function public.platform_billing_events(uuid, integer) from public, anon;
grant execute on function public.platform_billing_events(uuid, integer) to authenticated, service_role;

-- Re-created above; their grants are kept by CREATE OR REPLACE and restated here.
revoke all on function public.decide_billing_request(uuid, boolean, text) from public, anon;
grant execute on function public.decide_billing_request(uuid, boolean, text) to authenticated, service_role;
revoke all on function public.billing_set_package(uuid, text, integer, uuid[], text, timestamptz) from public, anon;
grant execute on function public.billing_set_package(uuid, text, integer, uuid[], text, timestamptz) to authenticated, service_role;
revoke all on function public.get_billing_overview(uuid) from public, anon;
grant execute on function public.get_billing_overview(uuid) to authenticated, service_role;
revoke all on function public.list_restaurant_subscriptions() from public, anon;
grant execute on function public.list_restaurant_subscriptions() to authenticated, service_role;
revoke all on function public.list_billing_requests(text) from public, anon;
grant execute on function public.list_billing_requests(text) to authenticated, service_role;

-- The edge function and the webhook only.
revoke all on function public.billing_mark_request_stripe(uuid, text, text) from public, anon, authenticated;
grant execute on function public.billing_mark_request_stripe(uuid, text, text) to service_role;
revoke all on function public.billing_set_stripe_customer(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_set_stripe_customer(uuid, text) to service_role;
revoke all on function public.billing_settle_stripe_request(uuid, text, text, text, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.billing_settle_stripe_request(uuid, text, text, text, timestamptz, jsonb, jsonb) to service_role;
revoke all on function public.billing_cancel_stripe_request(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_cancel_stripe_request(uuid, text) to service_role;
revoke all on function public.billing_sync_stripe_status(text, text, boolean, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.billing_sync_stripe_status(text, text, boolean, timestamptz, timestamptz, jsonb) to service_role;
revoke all on function public.billing_record_stripe_invoice(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_record_stripe_invoice(jsonb, timestamptz) to service_role;
revoke all on function public.billing_record_stripe_invoice_failed(jsonb) from public, anon, authenticated;
grant execute on function public.billing_record_stripe_invoice_failed(jsonb) to service_role;
revoke all on function public.billing_request_for_invoice(text) from public, anon, authenticated;
grant execute on function public.billing_request_for_invoice(text) to service_role;
