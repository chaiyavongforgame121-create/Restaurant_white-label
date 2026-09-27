-- Platform billing through Stripe: the review fixes (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §9).
-- 20260926100000_platform_billing_stripe built the card rail; an adversarial review then confirmed
-- the defects this file fixes on the SQL side. Every rule below names the finding it answers.
--
-- 1. DEADLINES (§9.1; money-sql-5, money-sql-7). private.billing_deadline is the one deadline, and
--    billing_compute and billing_expire_tick both call it. Stripe charges a renewal about an hour
--    after the period ends (up to 72 h in the worst case), so a deadline of exactly
--    current_period_end took every card restaurant offline at every renewal, and the cron then
--    relabelled it expired before the failure that should have started the 7-day grace could
--    arrive. While a row is on the Stripe rail its deadline is at least the period end plus the
--    grace days; a cancelled Stripe row keeps what it paid for and any grace already running.
--
-- 2. ONE LIVE SUBSCRIPTION PER RESTAURANT (§9.2; money-sql-2, money-sql-3). A first purchase that
--    settles over a row still carrying another Stripe subscription answers
--    replaced_subscription_id, so the caller cancels that one at Stripe. The manual rail
--    (approval, billing_set_package) clears a dead subscription's ids off the row it applies to,
--    so a subscription Stripe has ended can never make the row "Stripe-managed" again.
--
-- 3. A CHANGE WAITING ON ITS INVOICE CANNOT BE REPLACED OR REJECTED (§9.3; money-sql-1). Stripe
--    applies a pending subscription update the moment its invoice is paid, whatever we did with
--    the request meanwhile. request_package_change and decide_billing_request(reject) refuse
--    payment_in_progress while that invoice is open; billing_request_for_invoice finds the request
--    whatever its status, so a payment for one that is no longer pending is refunded (the caller).
--    The invoice's page is kept on the request (stripe_invoice_url) for the plan page.
--
-- 4. MONEY TAKEN BUT NOT APPLIED IS GIVEN BACK (§9.5; money-sql-4). billing_checkout_context
--    refuses plan_limit_exceeded before anything is charged. A settle that still fails says which
--    kind it was, so the caller refunds the right way.
--
-- 5. STRIPE AND OUR BILL AGREE (§9.6; money-sql-6, ui-platform-4). A delivering branch of a Stripe
--    restaurant cannot be hidden, moved or deleted (stripe_delivery_active): Stripe would go on
--    billing its delivery. subscriptions.stripe_monthly_amount is Stripe's recurring total, and it
--    is the next charge the Stripe rail shows.
--
-- 6. STRIPE IDS AND THE CARD ARE PRIVATE (§9.7; SEC-SQL-1, SEC-SQL-2, SEC-EDGE-1). The customer and
--    the card move to billing_stripe_customers (RLS on, no policies). restaurants.stripe_customer_id
--    was readable by anon and insertable by any signed-in user, and the invoice resolver trusted
--    it: it is emptied and a CHECK keeps it empty for every role. The card columns of
--    subscriptions are emptied, and signed-in users lose SELECT on subscriptions' Stripe columns.
--
-- 7. WEBHOOK ROBUSTNESS (§9.8; WH-5, WH-6, money-sql-8). Events are claimed with a lease
--    (stripe_event_claim / stripe_event_done), so a worker killed mid-handler does not turn every
--    retry into a duplicate. A refunded invoice is marked refunded, and the merchant's last invoice
--    is the latest PAID one of the CURRENT subscription. The dormant stripe_sync_subscription (the
--    free-month bug) loses its service-role grant.
--
-- 8. SETTINGS AND READS (§9.9; SEC-EDGE-2, UIM-4, UIM-6, ui-platform-2). platform_settings.billing
--    is patched atomically (billing_settings_merge), so a merchant's portal call can no longer
--    write back a switch the platform admin just turned off. cancel_at counts as cancelling in
--    billing_rail_json. entitlements_json gains billing_rail, which every member can read.
--
-- Live bodies were read with pg_get_functiondef before each replacement and are kept except where
-- a comment says otherwise.

-- ---------------------------------------------------------------------------------------------
-- 1. Columns and the customer table.
-- ---------------------------------------------------------------------------------------------

-- Stripe's recurring total for the subscription (the sum of its recurring items), in dollars. Set
-- at settlement and on every status sync. Our own monthly_total is priced from today's catalog and
-- today's branches; Stripe charges what the subscription says (ui-platform-4).
alter table public.subscriptions
  add column if not exists stripe_monthly_amount numeric(10,2);

-- Stripe's hosted page for the invoice a subscription change is waiting on (3-D Secure or a
-- declined card). The plan page links to it; while it is open the request cannot be replaced.
alter table public.billing_requests
  add column if not exists stripe_invoice_url text;

-- Stripe's invoice statuses, plus ours: an invoice whose payment we refunded (a stale checkout).
do $$ begin
  alter table public.billing_invoices
    add constraint billing_invoices_status_check
    check (status in ('draft', 'open', 'paid', 'uncollectible', 'void', 'refunded'));
exception when duplicate_object then null; end $$;

-- The restaurant's Stripe customer and the card on file. Nobody signed in reads this table: the
-- merchant sees the card through get_billing_overview (billing.manage), the platform through
-- list_restaurant_subscriptions, the edge functions through the service role.
create table if not exists public.billing_stripe_customers (
  restaurant_id      uuid primary key references public.restaurants(id) on delete cascade,
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'),
  card_brand         text,
  card_last4         text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_exp_month     integer,
  card_exp_year      integer,
  updated_at         timestamptz not null default now()
);

alter table public.billing_stripe_customers enable row level security;
revoke all on public.billing_stripe_customers from public, anon, authenticated;
grant all on public.billing_stripe_customers to service_role;

comment on table public.billing_stripe_customers is
  'The platform Stripe customer of each restaurant that has paid by card, and its card on file (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §9.7). RLS on, no policies: written and read only by the service role and SECURITY DEFINER functions.';

-- What was on restaurants and subscriptions moves here: the subscription's customer first (it is
-- the one its live subscription belongs to), then the restaurant's. A customer id already taken by
-- another restaurant is left behind rather than guessed at.
insert into public.billing_stripe_customers
  (restaurant_id, stripe_customer_id, card_brand, card_last4, card_exp_month, card_exp_year)
select r.id,
       coalesce(nullif(s.stripe_customer_id, ''), nullif(r.stripe_customer_id, '')),
       s.card_brand,
       case when s.card_last4 ~ '^[0-9]{4}$' then s.card_last4 end,
       s.card_exp_month,
       s.card_exp_year
  from public.restaurants r
  left join public.subscriptions s on s.restaurant_id = r.id
 where coalesce(nullif(s.stripe_customer_id, ''), nullif(r.stripe_customer_id, '')) ~ '^cus_[A-Za-z0-9_]+$'
on conflict do nothing;

-- Emptied and never written again. The migration runs without a JWT, so the restaurant guard
-- lets these through.
update public.restaurants set stripe_customer_id = null where stripe_customer_id is not null;
update public.subscriptions
   set card_brand = null, card_last4 = null, card_exp_month = null, card_exp_year = null
 where card_brand is not null or card_last4 is not null
    or card_exp_month is not null or card_exp_year is not null;

-- The column stays (a drop would break every reader at once) but can hold nothing: the guard
-- trigger only ever saw UPDATEs, so any signed-in user could INSERT a restaurant carrying a
-- victim's customer id and have the victim's invoices resolved to it (SEC-SQL-1). A CHECK covers
-- INSERT and UPDATE for every role, the service role included.
do $$ begin
  alter table public.restaurants
    add constraint restaurants_stripe_customer_id_retired check (stripe_customer_id is null);
exception when duplicate_object then null; end $$;

comment on column public.restaurants.stripe_customer_id is
  'Retired 2026-09-27 and always null (CHECK restaurants_stripe_customer_id_retired). The Stripe customer lives in billing_stripe_customers.';

-- Every member of a restaurant reads its subscriptions row (plan, status, period). The Stripe ids
-- and the card are the billing owner's (billing_branch_context hides them from everyone else), so
-- signed-in users read every column but those (SEC-SQL-2). Column grants fail closed: a column
-- added later is not readable until it is granted here.
revoke select on public.subscriptions from authenticated;
do $$
declare v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'subscriptions'
     and column_name not in ('stripe_customer_id', 'stripe_subscription_id', 'payment_method_id',
                             'card_brand', 'card_last4', 'card_exp_month', 'card_exp_year');
  execute format('grant select (%s) on public.subscriptions to authenticated', v_cols);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. The deadline (§9.1).
-- ---------------------------------------------------------------------------------------------

-- When a subscriptions row stops granting access. Called by billing_compute (the gates, the
-- storefront, branches.entitled_through) and billing_expire_tick (the label), so the two cannot
-- disagree.
--   * On the Stripe rail (a Stripe subscription id and trialing/active/past_due, the statuses
--     billing_is_stripe_managed counts): the period end plus the grace days, or the grace or the
--     trial if later. Stripe charges a renewal about an hour after the period ends, and a failure
--     must land while the restaurant is still on the Stripe rail so it starts the grace
--     (money-sql-5, money-sql-7). Smart Retries end within a week (§7.3), inside this window.
--   * A cancelled Stripe row: what it paid for, and a grace that was already running (D9). No
--     slack: nothing will be charged.
--   * Every other row: as before -- the period end or the trial, and while past_due or cancelled
--     a grace (only the Stripe rail writes one).
create or replace function private.billing_deadline(
  p_status                 text,
  p_stripe_subscription_id text,
  p_current_period_end     timestamptz,
  p_trial_ends_at          timestamptz,
  p_grace_until            timestamptz)
returns timestamptz
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select case
           when p_status not in ('trialing', 'active', 'past_due', 'cancelled') or p_status is null
             then null
           when p_stripe_subscription_id is not null and p_status in ('trialing', 'active', 'past_due')
             then greatest(p_current_period_end + make_interval(days => private.billing_grace_days()),
                           p_grace_until, p_trial_ends_at)
           when p_stripe_subscription_id is not null and p_status = 'cancelled'
             then greatest(p_current_period_end, p_grace_until)
           else greatest(p_current_period_end, p_trial_ends_at,
                         case when p_status in ('past_due', 'cancelled') then p_grace_until end)
         end;
$function$;

comment on function private.billing_deadline(text, text, timestamptz, timestamptz, timestamptz) is
  'The deadline of a subscriptions row (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §9.1): on the Stripe rail greatest(period end + grace days, grace_until, trial_ends_at); a cancelled Stripe row greatest(period end, grace_until); any other row greatest(period end, trial_ends_at, grace_until while past_due/cancelled). Null for expired/none. billing_compute and billing_expire_tick both use it.';

-- The live body with one change: the deadline comes from private.billing_deadline.
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

    -- Deadline: private.billing_deadline, the one the expiry cron uses too. On the Stripe rail it
    -- runs past the period end by the grace days, because Stripe charges the renewal after the
    -- period has ended and a declined card must not take a restaurant offline in the middle of
    -- service (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md D9, §9.1).
    v_entitled_through := private.billing_deadline(v_status, v_sub.stripe_subscription_id,
                                                   v_sub.current_period_end, v_sub.trial_ends_at,
                                                   v_sub.grace_until);

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

-- The live body with one change: the deadline comes from private.billing_deadline.
create or replace function private.billing_expire_tick()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_count integer := 0;
begin
  with expired as (
    update public.subscriptions s
       set status = 'expired', updated_at = now()
     where s.status in ('trialing', 'active', 'past_due', 'cancelled')
       and private.billing_deadline(s.status::text, s.stripe_subscription_id, s.current_period_end,
                                    s.trial_ends_at, s.grace_until) <= now()
    returning s.restaurant_id
  )
  select count(*) into v_count from expired;

  if v_count > 0 then
    perform public.billing_log_event('billing.expired', 'info',
      v_count || ' subscription(s) passed their period end', null, null);
  end if;
  return v_count;
end $function$;

comment on function private.billing_expire_tick() is
  'pg_cron billing-expire-tick, every 10 minutes: a subscription whose deadline (private.billing_deadline, the one billing_compute uses) has passed becomes expired. The access gates compare the deadline themselves; this only moves the label.';

-- ---------------------------------------------------------------------------------------------
-- 3. The manual rail leaves no dead Stripe subscription behind (§9.2, money-sql-3).
-- ---------------------------------------------------------------------------------------------

-- A subscription Stripe has ended (cancelled, expired, a Checkout replaced) stays on the row until
-- something else is applied, and billing_is_stripe_managed would count it again the moment the
-- manual rail made the row active: the console would refuse approvals, the plan page would try to
-- change a dead subscription and the portal would open it. The manual rail calls this on a row that
-- is NOT managed, before it applies the package. The customer and the card stay: they are what a
-- later card purchase reuses.
create or replace function private.billing_detach_stripe_subscription(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_old text;
begin
  if p_restaurant_id is null or private.billing_is_stripe_managed(p_restaurant_id) then return; end if;

  select stripe_subscription_id into v_old from public.subscriptions where restaurant_id = p_restaurant_id;

  update public.subscriptions
     set stripe_subscription_id = null,
         cancel_at_period_end   = false,
         cancel_at              = null,
         grace_until            = null,
         next_billing_at        = null,
         stripe_monthly_amount  = null,
         updated_at             = now()
   where restaurant_id = p_restaurant_id
     and (stripe_subscription_id is not null or coalesce(cancel_at_period_end, false)
          or cancel_at is not null or grace_until is not null or next_billing_at is not null
          or stripe_monthly_amount is not null);

  update public.subscription_items si
     set stripe_subscription_item_id = null, updated_at = now()
    from public.subscriptions s
   where s.restaurant_id = p_restaurant_id
     and si.subscription_id = s.id
     and si.stripe_subscription_item_id is not null;

  if v_old is not null then
    perform public.billing_log_event('stripe.subscription_detached', 'info',
      'the manual rail took over from a Stripe subscription that no longer bills', p_restaurant_id,
      jsonb_build_object('subscription', v_old));
  end if;
end $function$;

-- The live body with two changes: rejecting a change that waits on its invoice is refused
-- (payment_in_progress, §9.3), and approving detaches a dead Stripe subscription first (§9.2).
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

  -- ...except a subscription change that is waiting on its invoice (3-D Secure, a declined card).
  -- Stripe applies that change the moment the invoice is paid, whatever this request says, so
  -- rejecting it here would charge the merchant for a package nobody grants (money-sql-1). The
  -- merchant finishes on Stripe's page, or Stripe discards the change after about 23 hours and
  -- the webhook cancels the request.
  if not p_approve and v_req.rail = 'stripe' and v_req.stripe_invoice_id is not null then
    raise exception 'payment_in_progress'
      using hint = 'This change is waiting for its card payment on Stripe; it is cancelled by itself if the merchant does not pay.';
  end if;

  if p_approve then
    perform private.billing_detach_stripe_subscription(v_req.restaurant_id);

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

-- The live body with one change: a dead Stripe subscription is detached first (§9.2).
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
  perform private.billing_detach_stripe_subscription(p_restaurant_id);
  return private.billing_apply_selection(
    p_restaurant_id, p_plan_code, coalesce(p_delivery_branch_ids, '{}'::uuid[]),
    p_branch_seats, p_status, null, p_period_end, null);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 4. A change waiting on its invoice cannot be replaced (§9.3, money-sql-1).
-- ---------------------------------------------------------------------------------------------

-- The live body with one change: after the per-restaurant lock, a pending card change that waits
-- on its invoice refuses the new request (payment_in_progress).
create or replace function public.request_package_change(p_restaurant_id uuid, p_plan_code text, p_branch_seats integer default 1, p_delivery_branch_ids uuid[] default '{}'::uuid[], p_discount_code text default null::text, p_note text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan     public.billing_products%rowtype;
  v_seats    integer;
  v_ids      uuid[];
  v_ids_superseded uuid[];
  v_delivers integer;
  v_open     integer;
  v_monthly  numeric(10,2) := 0;
  v_code     text := nullif(upper(btrim(coalesce(p_discount_code, ''))), '');
  v_priced   jsonb;
  v_quote    jsonb;
  v_row      public.billing_requests%rowtype;
  v_reason   text;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  -- Whoever holds billing.manage for this restaurant -- today the owner alone. Any member used to
  -- pass, and a cashier's request then locked the owner's own plan page until the platform acted
  -- on it; the fix for that let the owner's admin through too, which public.role_capabilities
  -- never agreed to. See private.user_can_manage_billing.
  if not private.user_can_manage_billing(p_restaurant_id) then
    raise exception 'forbidden';
  end if;

  -- Nonsense in, nothing priced: see private.billing_seats_in_range.
  v_seats := private.billing_seats_in_range(p_branch_seats);

  select * into v_plan from public.billing_products where code = p_plan_code and kind = 'plan' and is_active;
  if not found then raise exception 'unknown_plan:%', p_plan_code; end if;

  -- The trial is granted once at signup, never sold.
  if coalesce(v_plan.trial_days, 0) > 0 then
    raise exception 'plan_not_purchasable:%', p_plan_code;
  end if;

  -- The same floor private.billing_apply_selection enforces when the request is APPROVED. It was
  -- only there, so a request for fewer seats than the restaurant has open branches queued
  -- happily and then failed with plan_limit_exceeded every single time a platform operator
  -- pressed Approve -- the refusal landing on the operator instead of on the merchant who asked
  -- for it, with the request stuck pending for ever (PKG-6). Refuse it at the door, in the
  -- merchant's own call, where describeBillingError() already turns it into "you are using N of
  -- M branch seats". Hidden branches hold no seat, which is why this counts only the active ones.
  select count(*) into v_open
    from public.branches where restaurant_id = p_restaurant_id and is_active;
  if v_seats < v_open then
    raise exception 'plan_limit_exceeded:branches:%/%', v_open, v_seats using errcode = 'P0001';
  end if;

  -- Only this restaurant's ACTIVE branches, each once. A hidden branch takes no orders and
  -- billing_compute bills no delivery for it, so quoting it here would put a figure on the request
  -- that the approved bill never matches.
  select coalesce(array_agg(distinct b.id), '{}'::uuid[]) into v_ids
    from public.branches b
   where b.restaurant_id = p_restaurant_id
     and b.is_active
     and b.id = any (coalesce(p_delivery_branch_ids, '{}'::uuid[]));
  v_delivers := coalesce(array_length(v_ids, 1), 0);

  -- 29 per branch, and 29 more for every branch that delivers.
  v_monthly := v_plan.monthly_price
             + greatest(v_seats - coalesce(v_plan.included_seats, 0), 0)
               * coalesce((select monthly_price from public.billing_products where code = 'extra_branch'), 0)
             + v_delivers
               * coalesce((select monthly_price from public.billing_products where code = 'delivery'), 0);

  -- One request at a time per restaurant. Two submits in the same instant would otherwise both
  -- void "the" pending request, both price against the same ledger and both reserve a code.
  perform pg_advisory_xact_lock(hashtextextended('favornoms.billing_request:' || p_restaurant_id::text, 0));

  -- A card change that is waiting on its invoice (3-D Secure, a declined card) cannot be
  -- replaced: Stripe applies it the moment that invoice is paid, whatever happened to the request
  -- meanwhile, so superseding it would charge the merchant for a package nobody grants
  -- (money-sql-1, docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §9.3). The pending rows are locked
  -- first, so an edge function marking the request at this very moment is waited for and seen.
  -- A Checkout (a first purchase, no invoice yet) can still be replaced: its other sessions are
  -- expired and a late payment is refunded (D12).
  perform 1 from public.billing_requests
   where restaurant_id = p_restaurant_id and status = 'pending'
   for update;
  if exists (select 1 from public.billing_requests
              where restaurant_id = p_restaurant_id and status = 'pending'
                and rail = 'stripe' and stripe_invoice_id is not null) then
    raise exception 'payment_in_progress' using errcode = 'P0001',
      hint = 'A package change is waiting for its card payment on Stripe; finish paying it there, or wait until Stripe drops it.';
  end if;

  -- Past the guessing limit every code check answers rate_limited, this one included; see
  -- private.billing_discount_throttled. Checked before anything is voided, so a refused call
  -- leaves the merchant's queued request exactly as it was.
  if v_code is not null and private.billing_discount_throttled(p_restaurant_id) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited',
                              'error', 'discount_invalid:rate_limited');
  end if;

  -- Everything that writes lives in this block, so a code refused anywhere inside it (the quote,
  -- or the reservation losing a race for the last use) rolls ALL of it back -- the superseded
  -- request is not cancelled, nothing is filed -- while the failed attempt, written after the
  -- block, still counts.
  begin
    -- VOID FIRST, PRICE AFTER. A superseded request's charges are void, not pending: they were
    -- never agreed to. This used to run AFTER billing_price_one_time while billing_paid_state()
    -- counted every non-void charge as bought, so the ordinary "I picked the wrong branch, let me
    -- resubmit" flow priced the replacement against the very rows this call was about to throw
    -- away and handed the whole one-time bill over for $0 (PKG-1, MONEY-1, PKG-01). The ledger
    -- is now paid-only as well, so the order no longer changes the price -- but voiding first
    -- still matters for the code: the superseded request's reservation is given back here, before
    -- the new one is quoted, so re-sending the same code is not refused as already used.
    select coalesce(array_agg(id), '{}'::uuid[]) into v_ids_superseded
      from public.billing_requests
     where restaurant_id = p_restaurant_id and status = 'pending';

    update public.billing_charges c
       set status = 'void'
     where c.status = 'pending'
       and c.request_id = any (v_ids_superseded);

    perform private.billing_release_discount(v_ids_superseded);

    update public.billing_requests
       set status = 'cancelled', updated_at = now()
     where id = any (v_ids_superseded);

    v_priced := private.billing_price_one_time(p_restaurant_id, v_plan.code, v_seats, v_ids);

    if v_code is null then
      v_quote := private.billing_discount_none(v_priced -> 'lines', (v_priced ->> 'total')::numeric, null);
    else
      v_quote := private.billing_discount_quote(p_restaurant_id, v_code, v_priced -> 'lines');
      -- The code was good enough to show a price a moment ago; if it no longer applies the
      -- merchant is told, not quietly charged the full amount.
      if coalesce((v_quote ->> 'valid')::boolean, false) is not true then
        raise exception using errcode = 'FNB01',
          message = coalesce(v_quote ->> 'reason', 'invalid_code');
      end if;
    end if;

    insert into public.billing_requests
      (restaurant_id, requested_by, plan_code, addons, branch_seats, monthly_total, note,
       delivery_branch_ids, one_time_total, discount_code, discount_amount)
    values
      (p_restaurant_id, auth.uid(), v_plan.code,
       case when v_delivers > 0 then array['delivery'] else '{}'::text[] end,
       v_seats, v_monthly, p_note,
       v_ids,
       coalesce((v_quote ->> 'net_total')::numeric, 0),
       -- Only a code that took something off is recorded against the request.
       case when coalesce((v_quote ->> 'amount_off')::numeric, 0) > 0 then v_code end,
       coalesce((v_quote ->> 'amount_off')::numeric, 0))
    returning * into v_row;

    -- Reserve the use now, tied to this request. Approval keeps it; rejection or the next
    -- request gives it back.
    if v_code is not null and coalesce((v_quote ->> 'amount_off')::numeric, 0) > 0 then
      v_reason := private.billing_reserve_discount(
        p_restaurant_id, (v_quote ->> 'code_id')::uuid, v_row.id,
        (v_quote ->> 'amount_off')::numeric);
      if v_reason is not null then
        raise exception using errcode = 'FNB01', message = v_reason;
      end if;
    end if;

    insert into public.billing_charges
      (restaurant_id, branch_id, code, amount, discount_code, discount_amount, net_amount,
       status, request_id, created_by)
    select p_restaurant_id, nullif(ln ->> 'branch_id', '')::uuid, ln ->> 'code',
           coalesce((ln ->> 'amount')::numeric, 0),
           nullif(ln ->> 'discount_code', ''),
           coalesce((ln ->> 'discount_amount')::numeric, 0),
           coalesce((ln ->> 'net_amount')::numeric, 0),
           'pending', v_row.id, auth.uid()
      from jsonb_array_elements(coalesce(v_quote -> 'lines', '[]'::jsonb)) t(ln);
  exception when sqlstate 'FNB01' then
    get stacked diagnostics v_reason = message_text;
  end;

  if v_reason is not null then
    perform private.billing_discount_note_failure(p_restaurant_id, v_reason);
    return jsonb_build_object('ok', false, 'reason', v_reason,
                              'error', 'discount_invalid:' || v_reason);
  end if;

  return to_jsonb(v_row) || jsonb_build_object('ok', true, 'request_id', v_row.id);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 5. The customer and the card live in billing_stripe_customers (§9.7).
-- ---------------------------------------------------------------------------------------------

-- A money amount from the edge (dollars), or null when it is not one.
create or replace function private.billing_money_or_null(p numeric)
returns numeric
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select case when p >= 0 and p < 100000000 then round(p, 2) end;
$function$;

-- Store the restaurant's customer and, when given, its card. p_switch says whether a different
-- customer may replace the stored one (a first purchase, or a restaurant not on the Stripe rail);
-- otherwise a card that belongs to another customer is not this restaurant's card on file.
-- Answers null when stored, or why not.
create or replace function private.billing_store_customer(
  p_restaurant_id uuid,
  p_customer_id   text,
  p_card          jsonb,
  p_switch        boolean)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_card jsonb := private.billing_card(p_card);
  v_cur  public.billing_stripe_customers%rowtype;
begin
  if p_restaurant_id is null then return 'restaurant_required'; end if;
  if p_customer_id is not null and p_customer_id !~ '^cus_[A-Za-z0-9_]+$' then
    return 'invalid_customer_id';
  end if;
  -- One customer, one restaurant: the invoice resolver trusts this table.
  if p_customer_id is not null and exists (
       select 1 from public.billing_stripe_customers c
        where c.stripe_customer_id = p_customer_id and c.restaurant_id <> p_restaurant_id) then
    return 'customer_of_another_restaurant';
  end if;

  select * into v_cur from public.billing_stripe_customers where restaurant_id = p_restaurant_id for update;
  if not found then
    if p_customer_id is null then return 'no_customer'; end if;
    insert into public.billing_stripe_customers
      (restaurant_id, stripe_customer_id, card_brand, card_last4, card_exp_month, card_exp_year)
    values
      (p_restaurant_id, p_customer_id, v_card ->> 'brand', v_card ->> 'last4',
       (v_card ->> 'exp_month')::integer, (v_card ->> 'exp_year')::integer)
    on conflict (restaurant_id) do nothing;
    return null;
  end if;

  if p_customer_id is not null and p_customer_id <> v_cur.stripe_customer_id then
    if not coalesce(p_switch, false) then return 'another_customer'; end if;
    -- A new customer: the old one's card is not on it.
    update public.billing_stripe_customers
       set stripe_customer_id = p_customer_id,
           card_brand         = v_card ->> 'brand',
           card_last4         = v_card ->> 'last4',
           card_exp_month     = (v_card ->> 'exp_month')::integer,
           card_exp_year      = (v_card ->> 'exp_year')::integer,
           updated_at         = now()
     where restaurant_id = p_restaurant_id;
    return null;
  end if;

  if v_card is not null then
    update public.billing_stripe_customers
       set card_brand     = v_card ->> 'brand',
           card_last4     = v_card ->> 'last4',
           card_exp_month = (v_card ->> 'exp_month')::integer,
           card_exp_year  = (v_card ->> 'exp_year')::integer,
           updated_at     = now()
     where restaurant_id = p_restaurant_id;
  end if;
  return null;
end $function$;

create or replace function public.billing_set_stripe_customer(p_restaurant_id uuid, p_customer_id text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_managed boolean;
  v_refusal text;
begin
  if p_customer_id is null or p_customer_id !~ '^cus_[A-Za-z0-9_]+$' then
    raise exception 'invalid_customer_id';
  end if;
  if not exists (select 1 from public.restaurants where id = p_restaurant_id) then
    raise exception 'restaurant_not_found';
  end if;

  -- A restaurant that already pays through a Stripe subscription keeps the customer that
  -- subscription belongs to.
  v_managed := private.billing_is_stripe_managed(p_restaurant_id);
  v_refusal := private.billing_store_customer(p_restaurant_id, p_customer_id, null, not v_managed);
  if v_refusal = 'customer_of_another_restaurant' then
    raise exception 'customer_of_another_restaurant';
  end if;

  if not v_managed then
    update public.subscriptions
       set stripe_customer_id = p_customer_id, updated_at = now()
     where restaurant_id = p_restaurant_id
       and stripe_customer_id is distinct from p_customer_id;
  end if;
end $function$;

comment on function public.billing_set_stripe_customer(uuid, text) is
  'Service role: the Stripe customer created for the restaurant, stored in billing_stripe_customers (and on its subscriptions row) unless the restaurant is already on a Stripe subscription, which keeps its own. Raises invalid_customer_id / restaurant_not_found / customer_of_another_restaurant.';

-- Whose invoice this is: by the subscription first (ours, then one we have recorded an invoice
-- of), then by the customer -- billing_stripe_customers (service role only, one restaurant per
-- customer), then a subscriptions row, but only when exactly one carries it. Nothing a signed-in
-- user can write is trusted, and nothing is guessed by age (SEC-SQL-1).
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
    (select c.restaurant_id from public.billing_stripe_customers c
      where p_customer_id is not null and c.stripe_customer_id = p_customer_id),
    (select (array_agg(s.restaurant_id))[1] from public.subscriptions s
      where p_customer_id is not null and s.stripe_customer_id = p_customer_id
     having count(*) = 1));
$function$;

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
  -- they cannot. The subscription's own customer first (the portal must open the one it bills).
  if v_can then
    select * into v_sub from public.subscriptions s where s.restaurant_id = v_rid limit 1;
    select coalesce(v_sub.stripe_customer_id,
                    (select c.stripe_customer_id from public.billing_stripe_customers c where c.restaurant_id = v_rid))
      into v_cus;
  end if;

  return jsonb_build_object(
    'ok', true,
    'restaurant_id', v_rid,
    'can_manage', v_can,
    'stripe_customer_id', case when v_can then v_cus end,
    'stripe_subscription_id', case when v_can then v_sub.stripe_subscription_id end,
    'stripe_managed', v_can and private.billing_is_stripe_managed(v_rid));
end $function$;

-- The live body with two changes: the restaurant's customer comes from billing_stripe_customers,
-- and a request whose seats no longer cover the active branches is refused before anything is
-- charged (plan_limit_exceeded, §9.5 / money-sql-4).
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
  v_open     integer;
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

  -- The seat floor billing_apply_selection enforces at settlement. A branch opened after the
  -- request was filed (a trial with spare seats, say) would make the settle fail AFTER the card
  -- was charged; refusing here charges nobody. The merchant files a request with enough seats.
  select count(*) into v_open
    from public.branches b where b.restaurant_id = v_req.restaurant_id and b.is_active;
  if v_req.branch_seats < v_open then
    return jsonb_build_object('ok', false, 'error', 'plan_limit_exceeded',
                              'detail', format('plan_limit_exceeded:branches:%s/%s', v_open, v_req.branch_seats),
                              'branches_used', v_open, 'branch_seats', v_req.branch_seats);
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
               'stripe_customer_id', (select c.stripe_customer_id from public.billing_stripe_customers c
                                       where c.restaurant_id = r.id),
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
  'The stripe-billing edge function, with the CALLER''s JWT: everything needed to charge a pending package request by card. {ok:false, error:forbidden} unless the caller holds billing.manage for its restaurant (or the request does not exist); request_not_pending once it is no longer on order; plan_not_billable; plan_limit_exceeded (with detail, branches_used, branch_seats) when its seats no longer cover the active branches. monthly_lines are in cents; charges are the non-zero one-time charges at their net amount in dollars.';

-- ---------------------------------------------------------------------------------------------
-- 6. Marking a request and finding it from an invoice (§9.3, §9.4).
-- ---------------------------------------------------------------------------------------------

drop function if exists public.billing_mark_request_stripe(uuid, text, text);
create function public.billing_mark_request_stripe(
  p_request_id          uuid,
  p_checkout_session_id text,
  p_invoice_id          text,
  p_invoice_url         text default null)
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
  -- The merchant is sent to this page, so it is https and nothing else.
  if p_invoice_url is not null and p_invoice_url !~ '^https://[^\s"<>]+$' then
    raise exception 'invalid_invoice_url';
  end if;

  -- The request is now being paid by exactly this session (a first purchase) or this invoice (a
  -- change waiting for 3-D Secure or a new card). A new session replaces the old one's id: the
  -- edge function expires the old session before it opens a new one.
  update public.billing_requests
     set rail                       = 'stripe',
         stripe_checkout_session_id = p_checkout_session_id,
         stripe_invoice_id          = p_invoice_id,
         stripe_invoice_url         = case when p_invoice_id is not null then p_invoice_url end,
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

comment on function public.billing_mark_request_stripe(uuid, text, text, text) is
  'Service role: the pending request is being paid by card, through this Checkout session or this subscription-change invoice (with Stripe''s hosted page for it, https only). While it waits on an invoice the request cannot be replaced or rejected (payment_in_progress). Raises request_not_pending / request_not_found / invalid_*.';

-- Whatever its status now: a payment can arrive for a change that was cancelled or rejected
-- meanwhile, and the caller must then refund it and put the subscription back (money-sql-1).
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
   order by br.created_at desc
   limit 1;
$function$;

comment on function public.billing_request_for_invoice(text) is
  'Service role: the request a subscription-change invoice was raised for, WHATEVER its status (settle answers duplicate for an approved one and request_not_pending for a cancelled/rejected one, which the caller refunds).';

-- ---------------------------------------------------------------------------------------------
-- 7. Settling and syncing (§9.2, §9.5, §9.6, §9.7).
-- ---------------------------------------------------------------------------------------------

-- The live body with these changes: a first purchase over a row that still carries another
-- subscription answers replaced_subscription_id (the caller cancels it, money-sql-2); Stripe's
-- recurring total is stored (p_monthly_amount, dollars); the customer and the card go to
-- billing_stripe_customers; a customer already another restaurant's is refused before anything is
-- applied; a settle_failed says its kind (the caller refunds a first purchase and reverts a change).
drop function if exists public.billing_settle_stripe_request(uuid, text, text, text, timestamptz, jsonb, jsonb);
create function public.billing_settle_stripe_request(
  p_request_id             uuid,
  p_stripe_customer_id     text,
  p_stripe_subscription_id text,
  p_invoice_id             text,
  p_paid_through           timestamptz,
  p_items                  jsonb,
  p_card                   jsonb,
  p_monthly_amount         numeric default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_req      public.billing_requests%rowtype;
  v_sub      public.subscriptions%rowtype;
  v_has_sub  boolean;
  v_managed  boolean;
  v_kind     text;
  v_ent      jsonb;
  v_card     jsonb := private.billing_card(p_card);
  v_monthly  numeric := private.billing_money_or_null(p_monthly_amount);
  v_end      timestamptz;
  v_replaced text;
  v_msg      text;
  v_state    text;
  v_payload  jsonb;
begin
  v_payload := jsonb_build_object('request_id', p_request_id, 'customer', p_stripe_customer_id,
                                  'subscription', p_stripe_subscription_id, 'invoice', p_invoice_id,
                                  'paid_through', p_paid_through, 'monthly_amount', p_monthly_amount);

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
  -- their request, a change paid after it was cancelled, or a second payment for one already
  -- settled. The caller refunds it in full (D12, §9.3).
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

  v_kind := case when v_managed then 'change' else 'first_purchase' end;

  if exists (select 1 from public.subscriptions s
              where s.stripe_subscription_id = p_stripe_subscription_id
                and s.restaurant_id <> v_req.restaurant_id) then
    perform public.billing_log_event('stripe.settle_failed', 'error', 'subscription_of_another_restaurant',
                                     v_req.restaurant_id, v_payload);
    return jsonb_build_object('ok', false, 'reason', 'settle_failed', 'kind', v_kind,
                              'detail', 'subscription_of_another_restaurant',
                              'request_id', v_req.id, 'restaurant_id', v_req.restaurant_id);
  end if;

  -- The invoice resolver trusts one restaurant per customer; a payment made through another
  -- restaurant's customer is not applied here (the caller refunds it).
  if exists (select 1 from public.billing_stripe_customers c
              where c.stripe_customer_id = p_stripe_customer_id
                and c.restaurant_id <> v_req.restaurant_id) then
    perform public.billing_log_event('stripe.settle_failed', 'error', 'customer_of_another_restaurant',
                                     v_req.restaurant_id, v_payload);
    return jsonb_build_object('ok', false, 'reason', 'settle_failed', 'kind', v_kind,
                              'detail', 'customer_of_another_restaurant',
                              'request_id', v_req.id, 'restaurant_id', v_req.restaurant_id);
  end if;

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
      return jsonb_build_object('ok', false, 'reason', 'settle_failed', 'kind', v_kind, 'detail', v_msg,
                                'request_id', v_req.id, 'restaurant_id', v_req.restaurant_id);
  end;

  if v_kind = 'first_purchase' then
    -- The row may still carry a subscription Stripe has not ended (a renewal that failed past the
    -- grace, say): Stripe would go on retrying it on the card this purchase just saved. The caller
    -- cancels it at Stripe (money-sql-2, §9.2).
    if v_has_sub and v_sub.stripe_subscription_id is not null
       and v_sub.stripe_subscription_id <> p_stripe_subscription_id then
      v_replaced := v_sub.stripe_subscription_id;
      perform public.billing_log_event('stripe.subscription_replaced', 'warn', v_replaced, v_req.restaurant_id,
                                       v_payload || jsonb_build_object('replaced_subscription_id', v_replaced));
    end if;

    select current_period_end into v_end from public.subscriptions where restaurant_id = v_req.restaurant_id;
    update public.subscriptions
       set stripe_customer_id     = p_stripe_customer_id,
           stripe_subscription_id = p_stripe_subscription_id,
           next_billing_at        = v_end,
           grace_until            = null,
           cancel_at_period_end   = false,
           cancel_at              = null,
           stripe_monthly_amount  = v_monthly,
           updated_at             = now()
     where restaurant_id = v_req.restaurant_id;
  else
    -- What Stripe bills from now on. Unknown means our own total is shown until the next sync.
    update public.subscriptions
       set stripe_monthly_amount = v_monthly, updated_at = now()
     where restaurant_id = v_req.restaurant_id
       and stripe_monthly_amount is distinct from v_monthly;
  end if;

  perform private.billing_store_customer(v_req.restaurant_id, p_stripe_customer_id, v_card,
                                         v_kind = 'first_purchase');

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
    'replaced_subscription_id', v_replaced,
    'current_period_end', (select current_period_end from public.subscriptions where restaurant_id = v_req.restaurant_id),
    -- Read again: the Stripe ids written above change the deadline (§9.1).
    'entitlements', private.entitlements_json(v_req.restaurant_id));
end $function$;

comment on function public.billing_settle_stripe_request(uuid, text, text, text, timestamptz, jsonb, jsonb, numeric) is
  'Service role: a package request paid by card. First purchase (not yet Stripe-managed): the package is applied active, paid through p_paid_through, with the Stripe ids stored; replaced_subscription_id names a different subscription the row still carried (cancel it at Stripe). Change (the same subscription): applied keeping the current period. p_monthly_amount is Stripe''s recurring total in dollars (null = unknown). The customer and the card go to billing_stripe_customers. Returns {ok:true, duplicate, kind, replaced_subscription_id} | {ok:false, reason: request_not_pending (refund it, D12; also when another subscription already bills the restaurant) | settle_failed (with kind; logged, never retried -- refund it) | request_not_found | invalid_arguments}.';

-- The live body with these changes: the card goes to billing_stripe_customers, and Stripe's
-- recurring total (p_monthly_amount, dollars) is stored when given.
drop function if exists public.billing_sync_stripe_status(text, text, boolean, timestamptz, timestamptz, jsonb);
create function public.billing_sync_stripe_status(
  p_stripe_subscription_id text,
  p_status                 text,
  p_cancel_at_period_end   boolean,
  p_cancel_at              timestamptz,
  p_next_billing_at        timestamptz,
  p_card                   jsonb,
  p_monthly_amount         numeric default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sub     public.subscriptions%rowtype;
  v_old     text;
  v_new     text;
  v_grace   timestamptz;
  v_full    boolean := p_status is not null;
  v_card    jsonb := private.billing_card(p_card);
  v_monthly numeric := private.billing_money_or_null(p_monthly_amount);
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
     set status                = v_new::public.subscription_status,
         grace_until           = v_grace,
         cancel_at_period_end  = case when v_full then coalesce(p_cancel_at_period_end, false)
                                      else coalesce(p_cancel_at_period_end, cancel_at_period_end) end,
         cancel_at             = case when v_full then p_cancel_at else coalesce(p_cancel_at, cancel_at) end,
         next_billing_at       = case when v_full then p_next_billing_at else coalesce(p_next_billing_at, next_billing_at) end,
         cancelled_at          = case when v_new in ('cancelled', 'expired') then coalesce(cancelled_at, now())
                                      when v_new <> v_old then null
                                      else cancelled_at end,
         -- Stripe's recurring total when the caller read it; kept otherwise (§9.6).
         stripe_monthly_amount = coalesce(v_monthly, stripe_monthly_amount),
         updated_at            = now()
   where id = v_sub.id;

  -- The card is the customer's (billing_stripe_customers), and only the customer this
  -- subscription belongs to is updated.
  if v_card is not null then
    perform private.billing_store_customer(v_sub.restaurant_id, v_sub.stripe_customer_id, v_card, false);
  end if;

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

comment on function public.billing_sync_stripe_status(text, text, boolean, timestamptz, timestamptz, jsonb, numeric) is
  'Service role: status, cancel flags, card and recurring total (p_monthly_amount, dollars; kept when null) from a re-fetched Stripe subscription, for the restaurant it bills. trialing|active -> active, past_due|unpaid -> past_due (grace starts once), canceled -> cancelled (a grace already running is kept), paused -> expired, incomplete* -> unchanged. A null p_status updates only what is given (the card). The card goes to billing_stripe_customers. NEVER moves current_period_end.';

-- ---------------------------------------------------------------------------------------------
-- 8. Invoices: refunded is final, and only known statuses are stored (§9.8).
-- ---------------------------------------------------------------------------------------------

-- The live body with one change: refunded, like paid and void, is final -- a late invoice.paid
-- for a payment we refunded must not show it as paid again.
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
    status                 = case when bi.status in ('paid', 'void', 'refunded') then bi.status else excluded.status end,
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

-- The live body with one change: a status Stripe does not have is stored as open (not applied)
-- instead of breaking billing_invoices_status_check and making Stripe redeliver for ever.
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
  if v_status not in ('draft', 'open', 'paid', 'uncollectible', 'void') then
    v_status := 'open';
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

-- A payment we gave back (a stale Checkout, a change paid after it was cancelled): the invoice is
-- no longer "paid" anywhere we show it (WH-6, money-sql-8). An invoice not recorded yet is left to
-- invoice.paid, which records it under a subscription the restaurant does not have, so it is never
-- shown as the last invoice either.
create or replace function public.billing_mark_invoice_refunded(p_invoice_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_row public.billing_invoices;
begin
  if coalesce(p_invoice_id, '') !~ '^in_[A-Za-z0-9_]+$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_invoice');
  end if;

  update public.billing_invoices
     set status = 'refunded', updated_at = now()
   where stripe_invoice_id = p_invoice_id
     and status <> 'refunded'
  returning * into v_row;

  if not found then
    select * into v_row from public.billing_invoices where stripe_invoice_id = p_invoice_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'unknown_invoice');
    end if;
    return jsonb_build_object('ok', true, 'changed', false, 'restaurant_id', v_row.restaurant_id,
                              'invoice_id', p_invoice_id, 'status', v_row.status);
  end if;

  perform public.billing_log_event('stripe.invoice_refunded', 'warn', p_invoice_id, v_row.restaurant_id,
                                   jsonb_build_object('invoice', p_invoice_id, 'amount_paid', v_row.amount_paid,
                                                      'subscription', v_row.stripe_subscription_id));
  return jsonb_build_object('ok', true, 'changed', true, 'restaurant_id', v_row.restaurant_id,
                            'invoice_id', p_invoice_id, 'status', 'refunded');
end $function$;

comment on function public.billing_mark_invoice_refunded(text) is
  'Service role: the invoice''s payment was refunded in full; it is stored as refunded (final: a late invoice.paid does not make it paid again). {ok:true, changed, restaurant_id} | {ok:false, reason: invalid_invoice | unknown_invoice}.';

-- ---------------------------------------------------------------------------------------------
-- 9. What the merchant and the platform read.
-- ---------------------------------------------------------------------------------------------

-- The `billing` object of get_billing_overview and list_restaurant_subscriptions
-- (parseBillingRailInfo in packages/database/src/queries/billing.ts). Changes from the live body:
--   * next_charge_at is null once the subscription is set to end, by either flag (UIM-4,
--     ui-platform-2): Stripe charges nothing more.
--   * next_charge_amount on the Stripe rail is Stripe's recurring total (ui-platform-4).
--   * card and stripe_customer come from billing_stripe_customers (§9.7).
--   * last_invoice is the latest PAID invoice of the CURRENT subscription (WH-6, money-sql-8).
--   * pending_invoice_url: the page of the invoice a pending change waits on (§9.3).
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
    'stripe_customer',      coalesce(c.stripe_customer_id, s.stripe_customer_id) is not null,
    -- Only the Stripe rail charges by itself, and not once the subscription is set to end.
    'next_charge_at',       case
                              when m.managed
                                   and not coalesce(s.cancel_at_period_end, false)
                                   and s.cancel_at is null
                              then coalesce(s.next_billing_at, s.current_period_end)
                            end,
    'next_charge_amount',   case when m.managed then coalesce(s.stripe_monthly_amount, be.monthly_total)
                                 else be.monthly_total end,
    'cancel_at_period_end', coalesce(s.cancel_at_period_end, false),
    'cancel_at',            s.cancel_at,
    'grace_until',          s.grace_until,
    'card',                 case when c.card_last4 is not null then jsonb_build_object(
                              'brand', c.card_brand, 'last4', c.card_last4,
                              'exp_month', c.card_exp_month, 'exp_year', c.card_exp_year) end,
    'last_invoice',         (select private.billing_invoice_summary(bi)
                               from public.billing_invoices bi
                              where bi.restaurant_id = p_restaurant_id
                                and s.stripe_subscription_id is not null
                                and bi.stripe_subscription_id = s.stripe_subscription_id
                                and bi.status = 'paid'
                              order by bi.created_at desc, bi.id desc
                              limit 1),
    'pending_request_rail', pr.rail,
    'pending_invoice_url',  case when pr.rail = 'stripe' and pr.stripe_invoice_id is not null
                                 then pr.stripe_invoice_url end)
  from (select private.billing_is_stripe_managed(p_restaurant_id) as managed) m
  left join public.subscriptions s on s.restaurant_id = p_restaurant_id
  left join public.billing_entitlements be on be.restaurant_id = p_restaurant_id
  left join public.billing_stripe_customers c on c.restaurant_id = p_restaurant_id
  left join lateral (
    select br.rail, br.stripe_invoice_id, br.stripe_invoice_url
      from public.billing_requests br
     where br.restaurant_id = p_restaurant_id and br.status = 'pending'
     order by br.created_at desc
     limit 1) pr on true;
$function$;

-- The live body with one change: the customer comes from billing_stripe_customers when the
-- subscription carries none.
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
        'stripe_customer_id',     coalesce(s.stripe_customer_id, c.stripe_customer_id),
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
    left join public.billing_stripe_customers c on c.restaurant_id = r.id
  ), '[]'::jsonb);
end $function$;

-- The live body with one key added: billing_rail ('stripe' | 'manual'). Every member reads this
-- payload (get_entitlements, get_branch_entitlements), and the dashboard needs to know that a card
-- restaurant renews by itself, so managers are not told to renew a package that will not lapse
-- (UIM-6). It says only which rail -- the ids and the card stay with billing.manage.
create or replace function private.entitlements_json(p_restaurant_id uuid, p_branch_id uuid default null::uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'restaurant_id',    p_restaurant_id,
    'branch_id',        p_branch_id,
    'plan_code',        coalesce(be.plan_code, 'none'),
    'status',           coalesce(be.status, 'none'),
    'billing_rail',     case when private.billing_is_stripe_managed(p_restaurant_id) then 'stripe' else 'manual' end,
    'entitled',         coalesce(be.entitled_through is not null and be.entitled_through > now(), false),
    'entitled_through', be.entitled_through,
    'trial_ends_at',    be.trial_ends_at,
    'branch_seats',     coalesce(be.branch_seats, 0),
    -- A hidden branch holds no seat, so it must not block lowering the seat count.
    'branches_used',    (select count(*) from public.branches b where b.restaurant_id = p_restaurant_id and b.is_active),
    'monthly_total',    coalesce(be.monthly_total, 0),
    -- RAW grants, deadline excluded (hasFeature() in the client adds the deadline back). A
    -- branch payload overrides the one key that is per branch, so every existing
    -- hasFeature(ent, 'delivery') call site becomes per-branch without being touched.
    'features',         case
                          when p_branch_id is null then coalesce(be.features, '{}'::jsonb)
                          else coalesce(be.features, '{}'::jsonb)
                               || jsonb_build_object('delivery',
                                    private.branch_feature_granted(p_branch_id, 'delivery'))
                        end,
    'addons',           to_jsonb(coalesce(be.addons, '{}'::text[])),
    -- Active branches only: a hidden branch takes no orders, and the plan page lists the
    -- branches the merchant can actually switch.
    'delivery_branch_ids', coalesce((
                             select jsonb_agg(b.id order by b.created_at, b.id)
                               from public.branches b
                              where b.restaurant_id = p_restaurant_id
                                and b.is_active
                                and private.branch_feature_granted(b.id, 'delivery')
                           ), '[]'::jsonb),
    -- The branches whose $59 is already bought, so a screen that offers "turn delivery back on"
    -- can say it costs nothing once without reading the billing ledger (which is the owner's).
    -- The same list private.billing_paid_state prices against.
    'delivery_unlocked_branch_ids', private.delivery_unlocked_branch_ids(p_restaurant_id)
  )
  from (select 1) one
  left join public.billing_entitlements be on be.restaurant_id = p_restaurant_id;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 10. A delivering branch of a Stripe restaurant stays until its delivery is turned off (§9.6).
-- ---------------------------------------------------------------------------------------------

-- billing_compute derives the delivery quantity from the ACTIVE branches that hold an active
-- delivery add-on, so hiding, moving or deleting such a branch lowered the bill we show while
-- Stripe went on charging the same quantity every month (money-sql-6). On the Stripe rail the
-- merchant turns delivery off for that branch on the plan page first, which changes the
-- subscription at Stripe too. Everything else is let through:
--   * a restaurant that is not on the Stripe rail, or a branch without active delivery;
--   * a whole restaurant being deleted (its row is already gone when its branches cascade);
--   * the platform admin: suspension hides every branch and still works on a card restaurant
--     (D11), and Restore puts the same branches back.
create or replace function private.guard_branch_stripe_delivery()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if exists (select 1 from public.restaurants r where r.id = old.restaurant_id)
     and not private.user_is_platform_admin()
     and private.billing_is_stripe_managed(old.restaurant_id)
     and exists (select 1 from public.branch_addons ba
                  where ba.branch_id = old.id and ba.code = 'delivery' and ba.active) then
    raise exception 'stripe_delivery_active' using errcode = 'P0001',
      hint = 'Stripe bills delivery for this branch every month. Turn delivery off for it on the plan page first.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;

-- Named to sort before branches_enforce_plan_limit_*: BEFORE triggers fire in name order, and
-- the merchant should hear why the branch has to stay, not that a seat is missing elsewhere.
drop trigger if exists branches_block_stripe_delivery_loss on public.branches;
create trigger branches_block_stripe_delivery_loss
  before update of is_active, restaurant_id on public.branches
  for each row
  when (old.is_active and (not new.is_active or old.restaurant_id is distinct from new.restaurant_id))
  execute function private.guard_branch_stripe_delivery();

drop trigger if exists branches_block_stripe_delivery_loss_delete on public.branches;
create trigger branches_block_stripe_delivery_loss_delete
  before delete on public.branches
  for each row
  when (old.is_active)
  execute function private.guard_branch_stripe_delivery();

-- ---------------------------------------------------------------------------------------------
-- 11. Webhook events are claimed with a lease (§9.8, WH-5).
-- ---------------------------------------------------------------------------------------------

-- stripe_event_seen marks an event before it is handled, so a worker killed in the middle (a hung
-- Stripe re-read, the wall-clock limit) left it 'received' for ever and every retry was answered
-- "duplicate": a renewal paid and never recorded. A claim is a lease instead: a 'received' row
-- older than the lease can be claimed again, and stripe_event_done marks it 'handled' once the
-- handler has finished. stripe_event_seen / stripe_event_forget stay as they are for the Connect
-- webhook.
create or replace function public.stripe_event_claim(p_event_id text, p_type text, p_lease_seconds integer default 300)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 86400));
begin
  -- No id means we cannot dedupe at all. Fail closed, as stripe_event_seen does.
  if coalesce(p_event_id, '') = '' then return false; end if;

  insert into public.billing_events (stripe_event_id, type, level, note)
  values (p_event_id, coalesce(nullif(p_type, ''), 'unknown'), 'info', 'received')
  on conflict (stripe_event_id) do nothing;
  if found then return true; end if;

  -- An abandoned claim. The row lock makes two retries racing for it take turns, and the second
  -- one then sees a fresh lease and backs off.
  update public.billing_events
     set created_at = now(),
         payload    = coalesce(payload, '{}'::jsonb)
                      || jsonb_build_object('claims', coalesce((payload ->> 'claims')::integer, 1) + 1,
                                            'reclaimed_at', now())
   where stripe_event_id = p_event_id
     and note = 'received'
     and created_at < now() - v_lease;
  return found;
end $function$;

comment on function public.stripe_event_claim(text, text, integer) is
  'Service role, platform webhook: true when this delivery should handle the event -- it is new, or an earlier claim is still ''received'' after p_lease_seconds (30..86400, default 300) and is taken over. false for an event handled or being handled. Call stripe_event_done after handling.';

create or replace function public.stripe_event_done(p_event_id text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  update public.billing_events
     set note = 'handled'
   where stripe_event_id = p_event_id
     and note = 'received';
end $function$;

comment on function public.stripe_event_done(text) is
  'Service role, platform webhook: the claimed event was handled; it can never be claimed again.';

-- ---------------------------------------------------------------------------------------------
-- 12. platform_settings.billing is patched, never rewritten (§9.9, SEC-EDGE-2).
-- ---------------------------------------------------------------------------------------------

-- The edge function used to read the whole object and write it back. A merchant opening the portal
-- in the middle of the platform admin switching card billing off wrote the old switch back, and
-- card billing was silently on again. One atomic UPDATE, touching only the keys given; a key given
-- as null is removed. The known keys are type-checked.
create or replace function public.billing_settings_merge(p_patch jsonb, p_updated_by uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_billing jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid_billing_settings';
  end if;
  if p_patch ? 'stripe_enabled' and jsonb_typeof(p_patch -> 'stripe_enabled') not in ('boolean', 'null') then
    raise exception 'invalid_billing_setting:stripe_enabled';
  end if;
  if p_patch ? 'portal_configuration_id'
     and not (jsonb_typeof(p_patch -> 'portal_configuration_id') = 'null'
              or (jsonb_typeof(p_patch -> 'portal_configuration_id') = 'string'
                  and (p_patch ->> 'portal_configuration_id') ~ '^[A-Za-z0-9_]{1,255}$')) then
    raise exception 'invalid_billing_setting:portal_configuration_id';
  end if;
  if p_patch ? 'grace_days'
     and not (jsonb_typeof(p_patch -> 'grace_days') = 'null'
              or (jsonb_typeof(p_patch -> 'grace_days') = 'number'
                  and (p_patch ->> 'grace_days')::numeric between 0 and 60)) then
    raise exception 'invalid_billing_setting:grace_days';
  end if;

  update public.platform_settings ps
     set billing    = (coalesce(ps.billing, '{}'::jsonb) || p_patch)
                      - coalesce((select array_agg(e.key) from jsonb_each(p_patch) e
                                   where e.value = 'null'::jsonb), '{}'::text[]),
         updated_at = now(),
         updated_by = coalesce(p_updated_by, ps.updated_by)
   where ps.id = 1
  returning ps.billing into v_billing;

  if not found then raise exception 'platform_settings_missing'; end if;
  return v_billing;
end $function$;

comment on function public.billing_settings_merge(jsonb, uuid) is
  'Service role: platform_settings.billing = billing || p_patch in one statement (a key patched to null is removed). stripe_enabled must be a boolean, portal_configuration_id an id, grace_days 0..60. Returns the new object.';

-- ---------------------------------------------------------------------------------------------
-- 13. Grants.
-- ---------------------------------------------------------------------------------------------

revoke all on function private.billing_deadline(text, text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function private.billing_detach_stripe_subscription(uuid) from public, anon, authenticated;
revoke all on function private.billing_money_or_null(numeric) from public, anon, authenticated;
revoke all on function private.billing_store_customer(uuid, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function private.guard_branch_stripe_delivery() from public, anon, authenticated;
revoke all on function private.billing_compute(uuid) from public, anon, authenticated;
revoke all on function private.billing_expire_tick() from public, anon, authenticated;
revoke all on function private.billing_invoice_restaurant(text, text) from public, anon, authenticated;
revoke all on function private.billing_upsert_invoice(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.billing_rail_json(uuid) from public, anon, authenticated;
revoke all on function private.entitlements_json(uuid, uuid) from public, anon, authenticated;

-- Re-created above; their grants are kept by CREATE OR REPLACE and restated here.
revoke all on function public.decide_billing_request(uuid, boolean, text) from public, anon;
grant execute on function public.decide_billing_request(uuid, boolean, text) to authenticated, service_role;
revoke all on function public.billing_set_package(uuid, text, integer, uuid[], text, timestamptz) from public, anon;
grant execute on function public.billing_set_package(uuid, text, integer, uuid[], text, timestamptz) to authenticated, service_role;
revoke all on function public.request_package_change(uuid, text, integer, uuid[], text, text) from public, anon;
grant execute on function public.request_package_change(uuid, text, integer, uuid[], text, text) to authenticated, service_role;
revoke all on function public.billing_checkout_context(uuid) from public, anon;
grant execute on function public.billing_checkout_context(uuid) to authenticated, service_role;
revoke all on function public.billing_branch_context(uuid) from public, anon;
grant execute on function public.billing_branch_context(uuid) to authenticated, service_role;
revoke all on function public.list_restaurant_subscriptions() from public, anon;
grant execute on function public.list_restaurant_subscriptions() to authenticated, service_role;

-- The edge function and the webhook only.
revoke all on function public.billing_mark_request_stripe(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.billing_mark_request_stripe(uuid, text, text, text) to service_role;
revoke all on function public.billing_set_stripe_customer(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_set_stripe_customer(uuid, text) to service_role;
revoke all on function public.billing_settle_stripe_request(uuid, text, text, text, timestamptz, jsonb, jsonb, numeric) from public, anon, authenticated;
grant execute on function public.billing_settle_stripe_request(uuid, text, text, text, timestamptz, jsonb, jsonb, numeric) to service_role;
revoke all on function public.billing_sync_stripe_status(text, text, boolean, timestamptz, timestamptz, jsonb, numeric) from public, anon, authenticated;
grant execute on function public.billing_sync_stripe_status(text, text, boolean, timestamptz, timestamptz, jsonb, numeric) to service_role;
revoke all on function public.billing_record_stripe_invoice(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_record_stripe_invoice(jsonb, timestamptz) to service_role;
revoke all on function public.billing_request_for_invoice(text) from public, anon, authenticated;
grant execute on function public.billing_request_for_invoice(text) to service_role;
revoke all on function public.billing_mark_invoice_refunded(text) from public, anon, authenticated;
grant execute on function public.billing_mark_invoice_refunded(text) to service_role;
revoke all on function public.stripe_event_claim(text, text, integer) from public, anon, authenticated;
grant execute on function public.stripe_event_claim(text, text, integer) to service_role;
revoke all on function public.stripe_event_done(text) from public, anon, authenticated;
grant execute on function public.stripe_event_done(text) to service_role;
revoke all on function public.billing_settings_merge(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.billing_settings_merge(jsonb, uuid) to service_role;

-- The dormant rail's writer: it re-derived the period on every subscription event and handed out a
-- free month each time. Nothing may call it any more; the old webhook that did is replaced.
revoke all on function public.stripe_sync_subscription(uuid, text, text, text, jsonb, timestamptz, timestamptz, timestamptz, boolean)
  from public, anon, authenticated, service_role;
