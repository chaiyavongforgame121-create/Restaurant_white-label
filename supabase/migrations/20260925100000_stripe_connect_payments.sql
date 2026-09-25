-- Card payments through Stripe Connect, paid straight to each branch (owner decision 2026-09-24,
-- docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md). The foundation the three Stripe edge functions build on.
--
-- 1. WHERE A BRANCH'S CARD MONEY GOES. public.branch_payment_accounts holds the Stripe connected
--    account each branch is paid into. It is its own table, written by the service role alone
--    (the stripe-connect-onboard and stripe-connect-webhook functions), because the obvious place,
--    branches.settings, is writable key by key by anyone holding branch.settings and readable by
--    every diner: a dishonest admin could have pointed the branch's card money at their own
--    account. Staff holding branch.settings may READ their branch's row; nobody signed in writes it.
--    Several branches may share one account (one business, one bank).
--
-- 2. WHAT THE STOREFRONT MAY KNOW. private.branch_card_ready() says whether the branch's account
--    can take charges, and storefront_status() carries that one boolean as 'card_ready'. The
--    account id itself never reaches a diner.
--
-- 3. A STRIPE PAYMENT ROW IS STRIPE'S. A diner's card payment is a payments row with
--    gateway='stripe', gateway_charge_id = the PaymentIntent id (unique per gateway from now on),
--    and gateway_metadata.stripe_account = the account it was charged on. Only the service role
--    may write such a row: payments_staff_update let a manager mark any row completed, and
--    decide_payment_proof / record_counter_payment would have settled a card row that Stripe never
--    charged. Its status moves from verified webhook events, or from a server-side re-read of the
--    PaymentIntent, through public.stripe_connect_apply_payment_intent() below. Money that arrived
--    is recorded even when the order's own rules refuse to confirm it. And every payment, of any
--    method, belongs to its order's branch (payments_order_same_branch): the staff policies check
--    only the row's own branch, so another restaurant could otherwise attach a payment to this one's
--    order.
--
-- 4. NOTHING REACHES THE KITCHEN UNPAID. A card order placed online waits exactly as a transfer
--    order waits for its slip: orders.awaiting_payment stays true until its payment is completed
--    (the payments -> orders sync trigger now covers card), and the order cannot be moved on by
--    staff before that (tg_block_unpaid_transfer_progress now covers card). An unpaid card order is
--    cancelled after 30 minutes by private.expire_unpaid_card_orders() (pg_cron, every minute),
--    which gives its stock, points and credits back through the usual cancel triggers.
--
-- 5. REFUNDS AND DISPUTES ARE RECORDED. public.payment_refunds is one row per Stripe refund,
--    whether the back office asked for it or the restaurant refunded in its own Stripe Dashboard;
--    a payment refunded in full becomes 'refunded'. A refund row only moves forward (failed and
--    canceled are final), so a late, stale event cannot count money as returned that was not. A
--    dispute is recorded on the payment's gateway_metadata and in audit_logs, as the old
--    stripe-webhook did.
--
-- "Online card payment" means, everywhere below: payments.method = 'card', payments.gateway =
-- 'stripe', and an order placed on the storefront (orders.source = 'web'). A card taken at the
-- counter or on the POS is swiped on the restaurant's own terminal and only recorded here, and
-- place-order labelled those rows 'stripe' too, so the source is what tells the two apart.

-- ---------------------------------------------------------------------------------------------
-- 1. branch_payment_accounts
-- ---------------------------------------------------------------------------------------------

create table if not exists public.branch_payment_accounts (
  branch_id          uuid primary key references public.branches(id) on delete cascade,
  stripe_account_id  text not null check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  charges_enabled    boolean not null default false,
  payouts_enabled    boolean not null default false,
  details_submitted  boolean not null default false,
  requirements_due   text[] not null default '{}',
  disabled_reason    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.branch_payment_accounts is
  'The Stripe connected account (Standard-type controller settings, direct charges) each branch is paid into. Written ONLY by the service role (stripe-connect-onboard, stripe-connect-webhook); never taken from a client and never kept in branches.settings. Several branches may share one stripe_account_id. The flags mirror the Stripe Account object; requirements_due is currently_due plus past_due.';

-- The Connect webhook routes by account id, and one account may pay several branches.
create index if not exists branch_payment_accounts_account_idx
  on public.branch_payment_accounts (stripe_account_id);

drop trigger if exists set_updated_at_branch_payment_accounts on public.branch_payment_accounts;
create trigger set_updated_at_branch_payment_accounts
  before update on public.branch_payment_accounts
  for each row execute function moddatetime(updated_at);

alter table public.branch_payment_accounts enable row level security;
revoke all on public.branch_payment_accounts from public, anon, authenticated;
grant select on public.branch_payment_accounts to authenticated;
grant all on public.branch_payment_accounts to service_role;

-- branch.settings is what the Branch settings page is gated on (owner and admin), and
-- staff_has_capability already answers yes for platform admins, which is the platform console's
-- read. There is deliberately no insert/update/delete policy: where the money goes is decided in
-- stripe-connect-onboard, after it has checked billing.manage.
drop policy if exists branch_payment_accounts_settings_read on public.branch_payment_accounts;
create policy branch_payment_accounts_settings_read on public.branch_payment_accounts
  for select to authenticated
  using (private.staff_has_capability(branch_id, 'branch.settings'));

-- ---------------------------------------------------------------------------------------------
-- 2. private.branch_card_ready and storefront_status.card_ready
-- ---------------------------------------------------------------------------------------------

create or replace function private.branch_card_ready(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1
      from public.branch_payment_accounts a
     where a.branch_id = p_branch_id
       and a.charges_enabled
  );
$function$;

comment on function private.branch_card_ready(uuid) is
  'Can this branch take a card online right now? Its connected account has charges_enabled. Says nothing about the card_payment entitlement, which storefront_status reports separately as card_payment.';

revoke all on function private.branch_card_ready(uuid) from public, anon, authenticated;

-- Re-created from the live definition with every key kept; 'card_ready' is the only addition, in
-- the answer and in the fallback for an unknown branch.
create or replace function public.storefront_status(p_branch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select jsonb_build_object(
      'entitled',           coalesce(b.entitled_through is not null and b.entitled_through > now(), false),
      'delivery',           coalesce(private.branch_has_feature(b.id, 'delivery')
                                     and public.is_delivery_available(b.id), false),
      'delivery_entitled',  coalesce(private.branch_has_feature(b.id, 'delivery'), false),
      'delivery_available', public.is_delivery_available(b.id),
      'delivery_hours_on',  coalesce((b.settings->>'delivery_hours_enabled')::boolean, false),
      'delivery_mode',      coalesce(b.settings->>'delivery_mode', 'platform'),
      'delivery_windows',   coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_delivery_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      -- Sold with the base, so it stays restaurant-wide.
      'card_payment',       coalesce(b.entitled_through > now() and (be.features -> 'card_payment') = to_jsonb(true), false),
      -- The branch's own Stripe account can take charges. The checkout offers card only when
      -- card_payment AND card_ready are both true; the account id itself is never exposed.
      'card_ready',         private.branch_card_ready(b.id),

      'timezone',           coalesce(b.timezone, 'America/New_York'),
      -- Empty array means "no hours configured", which is_branch_open() treats as
      -- always-open. The client must read it the same way, so the distinction between
      -- "no hours" and "closed all week" is preserved rather than flattened to [].
      'opening_hours',      coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      'scheduling_enabled', coalesce((b.settings->>'scheduling_enabled')::boolean, true),
      'schedule_min_lead_min', greatest(0, coalesce((b.settings->>'schedule_min_lead_min')::int, 15)),
      'schedule_max_days',     greatest(0, coalesce((b.settings->>'schedule_max_days')::int, 14)),
      'schedule_slot_minutes', greatest(5, coalesce((b.settings->>'schedule_slot_minutes')::int, 15))
    )
    from public.branches b
    left join public.billing_entitlements be on be.restaurant_id = b.restaurant_id
    where b.id = p_branch_id
  ), jsonb_build_object('entitled', false, 'delivery', false, 'delivery_entitled', false,
                        'delivery_available', false, 'delivery_hours_on', false,
                        'delivery_mode', 'platform', 'delivery_windows', '[]'::jsonb,
                        'card_payment', false, 'card_ready', false,
                        'timezone', 'America/New_York', 'opening_hours', '[]'::jsonb,
                        'scheduling_enabled', false,
                        'schedule_min_lead_min', 15, 'schedule_max_days', 14,
                        'schedule_slot_minutes', 15));
$function$;

-- ---------------------------------------------------------------------------------------------
-- 3. One payments row per PaymentIntent
-- ---------------------------------------------------------------------------------------------

-- stripe-create-payment-intent used to upsert on gateway_charge_id with no unique index behind
-- it, so the upsert could never have worked, and nothing stopped two rows claiming one charge.
-- Partial: every non-gateway row has a null charge id. A partial index cannot back an ON
-- CONFLICT from PostgREST, so writers update the row by its id instead of upserting on this.
create unique index if not exists payments_gateway_charge_uidx
  on public.payments (gateway, gateway_charge_id)
  where gateway_charge_id is not null;

-- place-order wrote gateway='stripe' on every card order, counter sales and the storefront's
-- "pay the driver by card" alike, although no Stripe call was ever made: no row has a charge id.
-- Left as they are, the card rules below would read those rows as unpaid Stripe payments, hide
-- their live orders from the kitchen on the next payments write and refuse to move them on.
-- They are card payments taken on the restaurant's own reader, which is a null gateway.
update public.payments p
   set gateway = null,
       gateway_metadata = coalesce(p.gateway_metadata, '{}'::jsonb)
                          || jsonb_build_object('stripe_label_retired_at', now())
 where p.method = 'card'
   and p.gateway = 'stripe'
   and p.gateway_charge_id is null
   and not (coalesce(p.gateway_metadata, '{}'::jsonb) ? 'stripe_account')
   and p.created_at < timestamptz '2026-09-25 00:00:00+00';

-- ---------------------------------------------------------------------------------------------
-- 4. The online card payment rules
-- ---------------------------------------------------------------------------------------------

create or replace function private.is_online_card_payment(p_method text, p_gateway text, p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    p_method = 'card'
    and p_gateway = 'stripe'
    and coalesce((select o.source from public.orders o where o.id = p_order_id), 'web') = 'web',
  false);
$function$;

comment on function private.is_online_card_payment(text, text, uuid) is
  'A diner''s card payment charged through Stripe on the storefront: method card, gateway stripe, order source web. Counter and POS card sales are swiped on the restaurant''s own reader and are not.';

revoke all on function private.is_online_card_payment(text, text, uuid) from public, anon, authenticated;

-- The payments -> orders sync, extended to card. Transfer keeps its exact old rule. A card order
-- waits while it has an online card payment and none of them has been paid (a refunded payment
-- was paid). A closed order never waits: the expiry voids its payment after cancelling nothing
-- but the order, and a late payment on it is refunded, so neither should pull it back into the
-- "awaiting" lists. The orders UPDATE stays unconditional: the dashboard's realtime bucket
-- listens for it on every payments write (live-model.ts).
create or replace function private.sync_order_awaiting_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_order uuid := coalesce(new.order_id, old.order_id);
begin
  if v_order is null then return null; end if;
  update public.orders o
     set awaiting_payment =
           exists (
             select 1 from public.payments p
              where p.order_id = v_order
                and p.method = 'transfer'
                and p.status <> 'completed'
           )
           or (
             o.status not in ('cancelled', 'refunded', 'completed')
             and coalesce(o.source, 'web') = 'web'
             and exists (
               select 1 from public.payments p
                where p.order_id = v_order
                  and p.method = 'card'
                  and p.gateway = 'stripe'
             )
             and not exists (
               select 1 from public.payments p
                where p.order_id = v_order
                  and p.method = 'card'
                  and p.gateway = 'stripe'
                  and p.status in ('completed', 'refunded')
             )
           )
   where o.id = v_order;
  return null;
end;
$function$;

revoke all on function private.sync_order_awaiting_payment() from public, anon, authenticated;

-- Staff cannot move an unpaid order on: a transfer without an approved slip (unchanged) and now an
-- online card payment Stripe has not confirmed. Cancelling is still allowed.
create or replace function public.tg_block_unpaid_transfer_progress()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.status = old.status then return new; end if;
  if new.status not in ('confirmed','preparing','ready','out_for_delivery','completed') then
    return new;
  end if;
  if exists (select 1 from public.payments p
              where p.order_id = new.id and p.method = 'transfer')
     and not exists (select 1 from public.payments p
                      where p.order_id = new.id and p.method = 'transfer'
                        and p.status = 'completed')
  then
    raise exception 'transfer_payment_not_approved' using errcode = 'P0001';
  end if;
  if coalesce(new.source, 'web') = 'web'
     and exists (select 1 from public.payments p
                  where p.order_id = new.id and p.method = 'card' and p.gateway = 'stripe')
     and not exists (select 1 from public.payments p
                      where p.order_id = new.id and p.method = 'card' and p.gateway = 'stripe'
                        and p.status in ('completed', 'refunded'))
  then
    raise exception 'card_payment_not_completed'
      using errcode = 'P0001',
            hint = 'The diner''s card payment has not gone through yet. The order moves on by itself once Stripe confirms it.';
  end if;
  return new;
end $function$;

revoke all on function public.tg_block_unpaid_transfer_progress() from public, anon, authenticated;

-- Only the service role writes an online card payment. auth.uid() is null for the edge functions
-- (service key), pg_cron and the SQL console, and set for every signed-in caller, including one
-- running a SECURITY DEFINER function such as decide_payment_proof or record_counter_payment.
create or replace function private.tg_payments_stripe_server_only()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    return new;
  end if;
  if private.is_online_card_payment(new.method, new.gateway, new.order_id)
     or (tg_op = 'UPDATE' and private.is_online_card_payment(old.method, old.gateway, old.order_id))
  then
    raise exception 'stripe_payment_server_only'
      using errcode = '42501',
            hint = 'A card payment taken online is recorded from Stripe only. Refund it from the order; do not edit the payment.';
  end if;
  return new;
end $function$;

revoke all on function private.tg_payments_stripe_server_only() from public, anon, authenticated;

drop trigger if exists payments_stripe_server_only on public.payments;
create trigger payments_stripe_server_only
  before insert or update on public.payments
  for each row execute function private.tg_payments_stripe_server_only();

-- A payment belongs to its order's branch. payments_staff_write and payments_staff_update check
-- payments.decide at the NEW row's branch_id only, and nothing tied that branch to the order's, so
-- any restaurant owner (a trial sign-up included) could hang a payment of their own branch on
-- another restaurant's order, given its id. On an online card order that is how money gets lost:
-- a foreign pending transfer row makes tg_block_unpaid_transfer_progress refuse the confirm when
-- the diner's card succeeds, and the expiry skips any order with a transfer row. The rule holds
-- for every writer, the service role included (place-order always writes the order's own branch;
-- no live row disagrees), so it is checked for everyone rather than only for signed-in callers.
create or replace function private.tg_payments_order_same_branch()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch uuid;
begin
  if tg_op = 'UPDATE'
     and new.order_id is not distinct from old.order_id
     and new.branch_id is not distinct from old.branch_id then
    return new;
  end if;
  -- SECURITY DEFINER so the check sees the order even when the caller's RLS hides it, which is
  -- exactly the case being refused. A missing order is the foreign key's to report.
  select o.branch_id into v_branch from public.orders o where o.id = new.order_id;
  if found and new.branch_id is distinct from v_branch then
    raise exception 'payment_branch_mismatch'
      using errcode = 'P0001',
            detail = 'payments.branch_id must be the branch of the order the payment is for.';
  end if;
  return new;
end $function$;

revoke all on function private.tg_payments_order_same_branch() from public, anon, authenticated;

-- "payments_order_" sorts before "payments_stripe_", so a payment aimed at another branch's order
-- is refused for what it is before any card rule looks at it.
drop trigger if exists payments_order_same_branch on public.payments;
create trigger payments_order_same_branch
  before insert or update of order_id, branch_id on public.payments
  for each row execute function private.tg_payments_order_same_branch();

-- ---------------------------------------------------------------------------------------------
-- 5. payment_refunds
-- ---------------------------------------------------------------------------------------------

create table if not exists public.payment_refunds (
  id                uuid primary key default gen_random_uuid(),
  payment_id        uuid not null references public.payments(id) on delete restrict,
  order_id          uuid not null references public.orders(id) on delete restrict,
  branch_id         uuid not null references public.branches(id) on delete restrict,
  amount            numeric(10,2) not null check (amount > 0),
  stripe_refund_id  text unique,
  status            text not null default 'pending'
                    check (status in ('pending', 'succeeded', 'failed', 'canceled')),
  reason            text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.payment_refunds is
  'One row per Stripe refund of a payment, made from the back office or directly in the branch''s Stripe Dashboard (the Connect webhook records those). Written by the service role only. status follows the Stripe Refund (requires_action is kept as pending). created_by is the auth user who asked for it; null when Stripe or the platform refunded on its own.';
comment on column public.payment_refunds.created_by is
  'auth.users.id of whoever asked for the refund in the back office; null for a refund made in Stripe''s Dashboard or refunded automatically (a payment that arrived after its order closed).';

create index if not exists payment_refunds_payment_idx on public.payment_refunds (payment_id);
create index if not exists payment_refunds_order_idx on public.payment_refunds (order_id);
create index if not exists payment_refunds_branch_created_idx on public.payment_refunds (branch_id, created_at desc);

drop trigger if exists set_updated_at_payment_refunds on public.payment_refunds;
create trigger set_updated_at_payment_refunds
  before update on public.payment_refunds
  for each row execute function moddatetime(updated_at);

alter table public.payment_refunds enable row level security;
revoke all on public.payment_refunds from public, anon, authenticated;
grant select on public.payment_refunds to authenticated;
grant all on public.payment_refunds to service_role;

-- The same readers as payments: staff holding payments.view at the branch, and the diner whose
-- order it is. No write policy: a refund exists because Stripe made it.
drop policy if exists payment_refunds_staff_read on public.payment_refunds;
create policy payment_refunds_staff_read on public.payment_refunds
  for select to authenticated
  using (private.staff_has_capability(branch_id, 'payments.view'));

drop policy if exists payment_refunds_customer_own on public.payment_refunds;
create policy payment_refunds_customer_own on public.payment_refunds
  for select to authenticated
  using (order_id in (
    select o.id from public.orders o
     where o.customer_id in (select c.id from public.customers c where c.user_id = (select auth.uid()))
  ));

-- ---------------------------------------------------------------------------------------------
-- 6. Applying Stripe objects (service role only: the Connect webhook and the payment re-check)
-- ---------------------------------------------------------------------------------------------

-- The payments row a Stripe object is about, locked, provided it was charged on p_account. The
-- PaymentIntent id is the key; the payment_id in the PaymentIntent's metadata is the fallback for
-- a row whose charge id was never written (the payment function created the intent and then
-- failed before saving it); the charge id is the last resort for objects that name only a charge.
-- The account check is what stops one connected account's events from touching another branch's
-- payment.
--
-- Locks are taken order first, then payment: the same order as the expiry job, which locks the
-- order and then voids its payments, so the two cannot deadlock over one order.
create or replace function private.stripe_connect_payment_for(
  p_account text,
  p_intent_id text,
  p_payment_id_hint text,
  p_charge_id text default null
)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
  v_order uuid;
  v_payment public.payments%rowtype;
  v_expected text;
begin
  if nullif(p_intent_id, '') is not null then
    select p.id, p.order_id into v_id, v_order
      from public.payments p
     where p.gateway = 'stripe' and p.gateway_charge_id = p_intent_id;
  end if;
  if v_id is null
     and p_payment_id_hint ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select p.id, p.order_id into v_id, v_order
      from public.payments p
     where p.id = p_payment_id_hint::uuid
       and p.gateway = 'stripe'
       and p.method = 'card'
       and (p.gateway_charge_id is null or p.gateway_charge_id = p_intent_id);
  end if;
  if v_id is null and nullif(p_charge_id, '') is not null then
    select p.id, p.order_id into v_id, v_order
      from public.payments p
     where p.gateway = 'stripe' and p.gateway_metadata ->> 'latest_charge' = p_charge_id
     order by p.created_at desc
     limit 1;
  end if;
  if v_id is null then
    return null;
  end if;

  perform 1 from public.orders o where o.id = v_order for update;
  select * into v_payment from public.payments p where p.id = v_id for update;

  v_expected := coalesce(
    nullif(v_payment.gateway_metadata ->> 'stripe_account', ''),
    (select a.stripe_account_id from public.branch_payment_accounts a where a.branch_id = v_payment.branch_id)
  );
  if v_expected is distinct from p_account then
    raise exception 'stripe_account_mismatch' using errcode = 'P0001';
  end if;
  return v_payment;
end $function$;

revoke all on function private.stripe_connect_payment_for(text, text, text, text) from public, anon, authenticated;

-- Apply a PaymentIntent, as delivered in payment_intent.* events or as re-read from Stripe after
-- the diner confirms. p_intent is the PaymentIntent object exactly as Stripe returns it.
--
-- Status: succeeded -> completed, canceled -> voided, a failed attempt -> failed; anything else
-- (processing, requires_action, a fresh intent) leaves the status alone and is only noted in
-- gateway_metadata.stripe_status. Completed and refunded are never moved back, so an old event
-- delivered late cannot undo a payment, and a failed or voided payment's metadata is not rewritten
-- by an old in-flight snapshot either. A payment the expiry voided can still complete: the money
-- did arrive, and the answer says it must go back.
--
-- Completing the payment clears orders.awaiting_payment through the sync trigger and confirms a
-- pending order, as approving a transfer slip does. A confirm the order's own rules refuse does not
-- undo the payment: it is answered as order_confirm_error and logged. The answer's action is
-- 'refund_required' when money arrived for an order that can no longer be cooked (cancelled or refunded, usually
-- by the 30-minute expiry) or when the amount or currency is not what the payment asked for; the
-- caller refunds refund_amount_cents on the connected account (idempotency key
-- 'late_payment_refund:<pi id>') and records it with stripe_connect_record_refund.
create or replace function public.stripe_connect_apply_payment_intent(p_account text, p_intent jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_pi          text := p_intent ->> 'id';
  v_pi_status   text := p_intent ->> 'status';
  v_payment     public.payments%rowtype;
  v_order       public.orders%rowtype;
  v_restaurant  uuid;
  v_received    bigint := coalesce(nullif(p_intent ->> 'amount_received', '')::bigint, 0);
  v_currency    text := lower(coalesce(p_intent ->> 'currency', ''));
  v_expected    bigint;
  v_target      public.payment_status;
  v_final       public.payment_status;
  v_mismatch    boolean := false;
  v_error       text;
  v_charge      text;
  v_refunded    bigint;
  v_action      text;
  v_reason      text;
  v_refundable  bigint := 0;
  v_in_flight   boolean;
  v_confirm_error text;
begin
  if coalesce(p_account, '') !~ '^acct_' or coalesce(v_pi, '') !~ '^pi_' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;

  begin
    v_payment := private.stripe_connect_payment_for(
      p_account, v_pi, p_intent -> 'metadata' ->> 'payment_id', null);
  exception when others then
    if sqlerrm = 'stripe_account_mismatch' then
      return jsonb_build_object('ok', false, 'error', 'account_mismatch', 'payment_intent', v_pi,
                                'account', p_account);
    end if;
    raise;
  end;
  if v_payment.id is null then
    return jsonb_build_object('ok', false, 'error', 'payment_not_found', 'payment_intent', v_pi);
  end if;

  select * into v_order from public.orders where id = v_payment.order_id for update;
  select b.restaurant_id into v_restaurant from public.branches b where b.id = v_payment.branch_id;

  if jsonb_typeof(p_intent -> 'last_payment_error') = 'object' then
    v_error := left(coalesce(p_intent -> 'last_payment_error' ->> 'message',
                             p_intent -> 'last_payment_error' ->> 'code', 'unknown'), 300);
  end if;
  v_charge := case jsonb_typeof(p_intent -> 'latest_charge')
                when 'string' then p_intent ->> 'latest_charge'
                when 'object' then p_intent -> 'latest_charge' ->> 'id'
              end;

  v_target := case
    when v_pi_status = 'succeeded' then 'completed'::public.payment_status
    when v_pi_status = 'canceled' then 'voided'::public.payment_status
    when v_pi_status = 'requires_payment_method' and v_error is not null then 'failed'::public.payment_status
  end;

  v_expected := round(v_payment.amount * 100)::bigint;
  if v_target = 'completed' and (v_received <> v_expected or v_currency <> 'usd') then
    -- Money arrived, but not the money this payment asked for. The order is not released on it.
    v_mismatch := true;
    v_target := null;
  end if;

  if v_target is not null then
    if v_payment.status in ('completed', 'refunded') then
      v_target := null;
    elsif v_target = v_payment.status then
      v_target := null;
    elsif v_target = 'failed' and v_payment.status = 'voided' then
      v_target := null;
    end if;
  end if;

  -- A snapshot of an attempt still under way: processing, requires_action, a fresh intent. Only
  -- succeeded, canceled and a declined attempt (requires_payment_method with an error) are final.
  v_in_flight := v_pi_status not in ('succeeded', 'canceled')
                 and not (v_pi_status = 'requires_payment_method' and v_error is not null);

  -- A paid payment keeps the metadata of the event that paid it; only another success may touch it.
  -- A failed or voided payment likewise keeps its metadata against an in-flight snapshot: Stripe
  -- does not deliver events in order, so the 'processing' snapshot of an attempt can land after
  -- the failure that ended it, and written down it would read as a payment still under way. Such a
  -- snapshot changes no status anyway; the next final one (a retry that succeeds or fails) is
  -- written as usual.
  if (v_payment.status not in ('completed', 'refunded') or v_pi_status = 'succeeded')
     and not (v_payment.status in ('failed', 'voided') and v_in_flight) then
    update public.payments
       set status = coalesce(v_target, status),
           paid_at = case when v_target = 'completed' then coalesce(paid_at, now()) else paid_at end,
           gateway_charge_id = coalesce(gateway_charge_id, v_pi),
           gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'stripe_account', p_account,
                  'stripe_status', v_pi_status,
                  'pending', coalesce(v_target, status) = 'pending')
             || jsonb_strip_nulls(jsonb_build_object(
                  'latest_charge', v_charge,
                  'amount_received', case when v_received > 0 then round(v_received / 100.0, 2) end,
                  'last_payment_error', v_error,
                  'amount_mismatch', case when v_mismatch then true end,
                  'paid_currency', case when v_mismatch then v_currency end))
     where id = v_payment.id
     returning status into v_final;
  else
    v_final := v_payment.status;
  end if;

  -- The confirm runs in its own subtransaction. The payment above is a fact from Stripe and is kept
  -- whatever the order's own rules say: if a trigger refuses the confirm (an unapproved transfer row
  -- on the same order, say), raising here would roll the completed payment back with it, the
  -- webhook would answer 500 on every retry for three days, and once Stripe gave up the money would
  -- sit on the branch's account with nothing recording it. So a refusal is written down instead;
  -- the paid order stays pending where staff can see it, and a later apply of the same success
  -- tries the confirm again. Contention errors are re-raised: a retry is the right answer to them.
  if v_final = 'completed' and v_order.status = 'pending' then
    begin
      update public.orders
         set status = 'confirmed',
             confirmed_at = coalesce(confirmed_at, now())
       where id = v_order.id
         and status = 'pending';
      v_order.status := 'confirmed';
    exception
      when serialization_failure or deadlock_detected or lock_not_available or query_canceled then
        raise;
      when others then
        v_confirm_error := left(sqlerrm, 300);
    end;
  end if;

  -- Money that is on the connected account for an order nobody will cook goes back.
  if v_pi_status = 'succeeded'
     and (v_mismatch or (v_final in ('completed', 'voided') and v_order.status in ('cancelled', 'refunded'))) then
    select coalesce(round(sum(r.amount) * 100), 0)::bigint into v_refunded
      from public.payment_refunds r
     where r.payment_id = v_payment.id
       and r.status in ('pending', 'succeeded');
    v_refundable := greatest(v_received - v_refunded, 0);
    if v_refundable > 0 then
      v_action := 'refund_required';
      v_reason := case when v_mismatch then 'amount_mismatch' else 'order_closed' end;
    end if;
  end if;

  if v_target is not null or v_action is not null then
    insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
    values (v_restaurant, v_payment.branch_id, null, 'system',
            case when v_action is not null then 'card_payment_refund_required'
                 else 'card_payment_' || v_final::text end,
            'payment', v_payment.id,
            jsonb_strip_nulls(jsonb_build_object(
              'order_id', v_order.id, 'payment_intent', v_pi, 'stripe_status', v_pi_status,
              'amount_received', round(v_received / 100.0, 2), 'reason', v_reason, 'error', v_error)));
  end if;

  -- On the order's history, so whoever finds a paid order still pending sees why. Once, when this
  -- call completed the payment: the order page's status re-check applies the same success again
  -- while the diner waits, and each of those would otherwise add the same line.
  if v_confirm_error is not null and v_target = 'completed' then
    insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
    values (v_restaurant, v_payment.branch_id, null, 'system', 'card_payment_order_not_confirmed',
            'order', v_order.id,
            jsonb_build_object('payment_id', v_payment.id, 'payment_intent', v_pi, 'error', v_confirm_error));
  end if;

  return jsonb_build_object(
    'ok', true,
    'payment_id', v_payment.id,
    'order_id', v_order.id,
    'branch_id', v_payment.branch_id,
    'restaurant_id', v_restaurant,
    'payment_intent', v_pi,
    'status', v_final,
    'changed', v_target is not null,
    'order_status', v_order.status,
    'action', v_action,
    'reason', v_reason,
    'refund_amount_cents', case when v_action is not null then v_refundable end,
    'order_confirm_error', v_confirm_error
  );
end $function$;

comment on function public.stripe_connect_apply_payment_intent(text, jsonb) is
  'Service role only. Applies a Stripe PaymentIntent (event payload or a fresh retrieve) charged on connected account p_account to its payments row, completing it and confirming the order when it succeeded. Returns {ok, payment_id, order_id, status, changed, order_status, action, reason, refund_amount_cents, order_confirm_error}; action = refund_required means the caller must refund refund_amount_cents on the connected account. order_confirm_error is set when the payment was completed but a rule on the order refused its confirm (the payment is kept; the order stays pending).';

revoke all on function public.stripe_connect_apply_payment_intent(text, jsonb) from public, anon, authenticated;
grant execute on function public.stripe_connect_apply_payment_intent(text, jsonb) to service_role;

-- Record a Stripe Refund (refund.created / refund.updated / refund.failed, a charge.refunded
-- listing, or the object stripe-refund just created). Upserts by stripe_refund_id, so the
-- back-office call and the webhook meet on one row. A row only moves forward: a late event never
-- takes it back to pending, a refund that fails after succeeding is recorded as failed, and a
-- failed or canceled refund stays so whatever snapshot arrives after it. Once the succeeded
-- refunds cover the payment it becomes 'refunded', and back to 'completed' if one of them later
-- fails.
create or replace function public.stripe_connect_record_refund(
  p_account text,
  p_refund jsonb,
  p_created_by uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id         text := p_refund ->> 'id';
  v_pi         text;
  v_charge     text;
  v_status     text;
  v_amount     numeric(10,2);
  v_payment    public.payments%rowtype;
  v_row        public.payment_refunds%rowtype;
  v_succeeded  numeric;
  v_new_status public.payment_status;
  v_restaurant uuid;
begin
  if coalesce(p_account, '') !~ '^acct_' or coalesce(v_id, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  v_pi := case jsonb_typeof(p_refund -> 'payment_intent')
            when 'string' then p_refund ->> 'payment_intent'
            when 'object' then p_refund -> 'payment_intent' ->> 'id'
          end;
  v_charge := case jsonb_typeof(p_refund -> 'charge')
                when 'string' then p_refund ->> 'charge'
                when 'object' then p_refund -> 'charge' ->> 'id'
              end;
  v_status := case p_refund ->> 'status'
                when 'succeeded' then 'succeeded'
                when 'failed' then 'failed'
                when 'canceled' then 'canceled'
                else 'pending'
              end;
  v_amount := round(coalesce(nullif(p_refund ->> 'amount', '')::numeric, 0) / 100, 2);
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_amount', 'refund', v_id);
  end if;

  begin
    v_payment := private.stripe_connect_payment_for(
      p_account, v_pi, p_refund -> 'metadata' ->> 'payment_id', v_charge);
  exception when others then
    if sqlerrm = 'stripe_account_mismatch' then
      return jsonb_build_object('ok', false, 'error', 'account_mismatch', 'refund', v_id, 'account', p_account);
    end if;
    raise;
  end;
  if v_payment.id is null then
    -- A refund of a charge this platform never made (the restaurant's own Dashboard sales).
    return jsonb_build_object('ok', false, 'error', 'payment_not_found', 'refund', v_id);
  end if;

  insert into public.payment_refunds as r
         (payment_id, order_id, branch_id, amount, stripe_refund_id, status, reason, created_by)
  values (v_payment.id, v_payment.order_id, v_payment.branch_id, v_amount, v_id, v_status,
          left(coalesce(nullif(btrim(p_reason), ''),
                        nullif(btrim(p_refund -> 'metadata' ->> 'reason'), ''),
                        nullif(p_refund ->> 'reason', '')), 300),
          coalesce(p_created_by,
                   case when (p_refund -> 'metadata' ->> 'created_by')
                             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        then (p_refund -> 'metadata' ->> 'created_by')::uuid end))
  on conflict (stripe_refund_id) do update
     -- Stripe's refund moves pending -> succeeded -> (rarely) failed, or pending -> canceled, and
     -- failed and canceled are final. Its events arrive in any order and a retried delivery can
     -- come hours late, so a snapshot only moves the row forward: a stale 'succeeded' never covers
     -- a refund that has since failed (the diner would be told the money went back, and the order
     -- could be closed on it), and nothing goes back to pending.
     set status = case
                    when r.status in ('failed', 'canceled') then r.status
                    when r.status = 'succeeded' and excluded.status = 'pending' then r.status
                    else excluded.status
                  end,
         amount = excluded.amount,
         reason = coalesce(r.reason, excluded.reason),
         created_by = coalesce(r.created_by, excluded.created_by)
  returning * into v_row;

  select coalesce(sum(amount), 0) into v_succeeded
    from public.payment_refunds
   where payment_id = v_payment.id and status = 'succeeded';

  v_new_status := case
    when v_payment.status = 'completed' and v_succeeded >= v_payment.amount then 'refunded'::public.payment_status
    when v_payment.status = 'refunded' and v_succeeded < v_payment.amount then 'completed'::public.payment_status
    else v_payment.status
  end;

  update public.payments
     set status = v_new_status,
         gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
           || jsonb_build_object('amount_refunded', v_succeeded)
           || case when v_new_status = 'refunded' and v_payment.status <> 'refunded'
                   then jsonb_build_object('refunded_at', now()) else '{}'::jsonb end
   where id = v_payment.id;

  select b.restaurant_id into v_restaurant from public.branches b where b.id = v_payment.branch_id;

  return jsonb_build_object(
    'ok', true,
    'refund_id', v_row.id,
    'stripe_refund_id', v_id,
    'refund_status', v_row.status,
    'payment_id', v_payment.id,
    'order_id', v_payment.order_id,
    'branch_id', v_payment.branch_id,
    'restaurant_id', v_restaurant,
    'payment_status', v_new_status,
    'amount_refunded', v_succeeded
  );
end $function$;

comment on function public.stripe_connect_record_refund(text, jsonb, uuid, text) is
  'Service role only. Upserts a Stripe Refund object (charged on connected account p_account) into payment_refunds by stripe_refund_id and marks the payment refunded once succeeded refunds cover it. p_created_by / p_reason are kept from the first writer that gave them.';

revoke all on function public.stripe_connect_record_refund(text, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.stripe_connect_record_refund(text, jsonb, uuid, text) to service_role;

-- charge.refunded carries the Charge, not its refunds. The webhook lists the charge's refunds from
-- Stripe and records each (stripe_connect_record_refund), which settles the payment from the refund
-- rows; this function is only its fallback when that listing cannot be read, and then it is given
-- the Charge as the webhook has just retrieved it.
--
-- p_charge MUST be a fresh retrieve, never the event's own snapshot: a charge.refunded delivered
-- late (a retry, hours on) still says refunded = true for a refund that has failed since, and taken
-- at its word it would mark the payment refunded and let the order be closed with nothing sent
-- back. For the same reason the charge's amount_refunded replaces the recorded one instead of
-- only ever raising it, and a charge that is no longer refunded in full takes a payment this
-- function marked refunded back to completed, unless the succeeded refund rows still cover it.
create or replace function public.stripe_connect_apply_charge_refunded(p_account text, p_charge jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_pi        text;
  v_charge    text := p_charge ->> 'id';
  v_payment   public.payments%rowtype;
  v_has_amount boolean := jsonb_typeof(p_charge -> 'amount_refunded') = 'number';
  v_refunded  numeric := round(coalesce(nullif(p_charge ->> 'amount_refunded', '')::numeric, 0) / 100, 2);
  -- Null when the object does not say: then the status is left as it is, in either direction.
  v_full      boolean := case jsonb_typeof(p_charge -> 'refunded')
                           when 'boolean' then (p_charge ->> 'refunded')::boolean end;
  v_succeeded numeric;
  v_status    public.payment_status;
begin
  if coalesce(p_account, '') !~ '^acct_' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  v_pi := case jsonb_typeof(p_charge -> 'payment_intent')
            when 'string' then p_charge ->> 'payment_intent'
            when 'object' then p_charge -> 'payment_intent' ->> 'id'
          end;
  begin
    v_payment := private.stripe_connect_payment_for(
      p_account, v_pi, p_charge -> 'metadata' ->> 'payment_id', v_charge);
  exception when others then
    if sqlerrm = 'stripe_account_mismatch' then
      return jsonb_build_object('ok', false, 'error', 'account_mismatch', 'charge', v_charge, 'account', p_account);
    end if;
    raise;
  end;
  if v_payment.id is null then
    return jsonb_build_object('ok', false, 'error', 'payment_not_found', 'charge', v_charge);
  end if;

  select coalesce(sum(r.amount), 0) into v_succeeded
    from public.payment_refunds r
   where r.payment_id = v_payment.id and r.status = 'succeeded';

  v_status := case
    when v_full is true and v_payment.status = 'completed' then 'refunded'::public.payment_status
    when v_full is false and v_payment.status = 'refunded' and v_succeeded < v_payment.amount
      then 'completed'::public.payment_status
    else v_payment.status
  end;
  update public.payments
     set status = v_status,
         gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
           || jsonb_build_object('refund_charge_id', v_charge)
           || case when v_has_amount then jsonb_build_object('amount_refunded', v_refunded)
                   else '{}'::jsonb end
           || case when v_status = 'refunded' and v_payment.status <> 'refunded'
                   then jsonb_build_object('refunded_at', now()) else '{}'::jsonb end
   where id = v_payment.id;

  return jsonb_build_object('ok', true, 'payment_id', v_payment.id, 'order_id', v_payment.order_id,
                            'payment_status', v_status,
                            'amount_refunded', case when v_has_amount then v_refunded end);
end $function$;

revoke all on function public.stripe_connect_apply_charge_refunded(text, jsonb) from public, anon, authenticated;
grant execute on function public.stripe_connect_apply_charge_refunded(text, jsonb) to service_role;

-- A dispute is not a refund: the money is held while the bank decides, and the restaurant answers
-- it in its own Stripe Dashboard. The payment's status stays as it is (payment_status has no
-- 'disputed'); the dispute is recorded next to it in gateway_metadata, under the same keys the
-- old stripe-webhook used, and in audit_logs so it shows on the order's history.
create or replace function public.stripe_connect_record_dispute(p_account text, p_dispute jsonb, p_event_type text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_pi         text;
  v_charge     text;
  v_payment    public.payments%rowtype;
  v_restaurant uuid;
  v_closed     boolean := p_event_type = 'charge.dispute.closed';
  v_due        bigint := nullif(p_dispute -> 'evidence_details' ->> 'due_by', '')::bigint;
  v_status     text := p_dispute ->> 'status';
begin
  if coalesce(p_account, '') !~ '^acct_' or coalesce(p_dispute ->> 'id', '') = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  v_pi := case jsonb_typeof(p_dispute -> 'payment_intent')
            when 'string' then p_dispute ->> 'payment_intent'
            when 'object' then p_dispute -> 'payment_intent' ->> 'id'
          end;
  v_charge := case jsonb_typeof(p_dispute -> 'charge')
                when 'string' then p_dispute ->> 'charge'
                when 'object' then p_dispute -> 'charge' ->> 'id'
              end;
  begin
    v_payment := private.stripe_connect_payment_for(p_account, v_pi, null, v_charge);
  exception when others then
    if sqlerrm = 'stripe_account_mismatch' then
      return jsonb_build_object('ok', false, 'error', 'account_mismatch', 'dispute', p_dispute ->> 'id');
    end if;
    raise;
  end;
  if v_payment.id is null then
    return jsonb_build_object('ok', false, 'error', 'payment_not_found', 'dispute', p_dispute ->> 'id');
  end if;

  -- A dispute's outcome is final: won, lost, and warning_closed (an inquiry that ended without a
  -- chargeback). Stripe delivers events out of order, so a late snapshot of the same dispute from
  -- before its outcome must not replace it: the status decides whether the money is with the
  -- restaurant, and so whether cancelling the order needs a refund (order_card_refund_due exempts
  -- needs_response, under_review and lost). A stale 'needs_response' after 'won' would have let
  -- staff cancel a paid order with the money still in the branch's account.
  if v_payment.gateway_metadata ->> 'dispute_id' = p_dispute ->> 'id'
     and v_payment.gateway_metadata ->> 'dispute_status' in ('won', 'lost', 'warning_closed')
     and coalesce(v_status, '') not in ('won', 'lost', 'warning_closed') then
    v_status := v_payment.gateway_metadata ->> 'dispute_status';
  end if;

  update public.payments
     set gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
           || jsonb_strip_nulls(jsonb_build_object(
                'dispute_id', p_dispute ->> 'id',
                'dispute_reason', coalesce(p_dispute ->> 'reason', 'unknown'),
                'dispute_amount', round(coalesce(nullif(p_dispute ->> 'amount', '')::numeric, 0) / 100, 2),
                'dispute_status', v_status,
                'dispute_evidence_due_by', case when v_due is not null then to_timestamp(v_due) end,
                'disputed_at', coalesce(gateway_metadata -> 'disputed_at', to_jsonb(now())),
                'dispute_closed_at', case when v_closed then to_jsonb(now()) end))
   where id = v_payment.id;

  select b.restaurant_id into v_restaurant from public.branches b where b.id = v_payment.branch_id;

  insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_restaurant, v_payment.branch_id, null, 'system',
          case p_event_type
            when 'charge.dispute.created' then 'payment_dispute_opened'
            when 'charge.dispute.closed' then 'payment_dispute_closed'
            else 'payment_dispute_updated'
          end,
          'payment', v_payment.id,
          jsonb_strip_nulls(jsonb_build_object(
            'order_id', v_payment.order_id, 'dispute_id', p_dispute ->> 'id',
            'reason', p_dispute ->> 'reason', 'status', p_dispute ->> 'status',
            'amount', round(coalesce(nullif(p_dispute ->> 'amount', '')::numeric, 0) / 100, 2))));

  return jsonb_build_object('ok', true, 'payment_id', v_payment.id, 'order_id', v_payment.order_id,
                            'branch_id', v_payment.branch_id, 'restaurant_id', v_restaurant,
                            'dispute_status', v_status);
end $function$;

revoke all on function public.stripe_connect_record_dispute(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.stripe_connect_record_dispute(text, jsonb, text) to service_role;

-- stripe_event_seen marks an event before it is handled, so an event whose handling failed was
-- answered "duplicate" on every retry and never applied. The Connect webhook calls this when a
-- handler throws, before returning 500, so Stripe's retry is handled for real.
create or replace function public.stripe_event_forget(p_event_id text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  delete from public.billing_events
   where stripe_event_id = p_event_id
     and note = 'received';
  return found;
end $function$;

revoke all on function public.stripe_event_forget(text) from public, anon, authenticated;
grant execute on function public.stripe_event_forget(text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. Unpaid card orders expire after 30 minutes
-- ---------------------------------------------------------------------------------------------

-- Cancelled the way every other path cancels: a status update, after which the orders triggers
-- give back stock (orders_restore_stock_on_cancel), points and credits, and close the delivery.
-- The unpaid payment rows are voided first. A payment that succeeds after this is refunded by the
-- webhook (see stripe_connect_apply_payment_intent).
--
-- A payment Stripe still reports as processing is left to finish, but only for a pending payment
-- and only until an hour after the order was placed. The payment function takes cards alone
-- (CARD_PAYMENT_METHOD_TYPES in stripe-create-payment-intent/logic.ts), and a card settles in
-- seconds, so an hour is ample; without the cap a payment stuck in processing (a bank debit takes
-- up to four business days) kept the order waiting with its stock held, and on success sent it to
-- the kitchen as new work days after the diner ordered. Past the hour the order is cancelled like
-- any other, and money that still arrives is refunded as a late payment. A failed or voided
-- payment is not exempt whatever its stripe_status says: the processing snapshot of a declined
-- attempt can be delivered after its failure.
create or replace function private.expire_unpaid_card_orders()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count integer := 0;
  r record;
begin
  for r in
    select o.id, o.branch_id, o.created_at
      from public.orders o
     where o.status = 'pending'
       and o.awaiting_payment
       and o.created_at < now() - interval '30 minutes'
       and coalesce(o.source, 'web') = 'web'
       and exists (select 1 from public.payments p
                    where p.order_id = o.id and p.method = 'card' and p.gateway = 'stripe')
       and not exists (select 1 from public.payments p
                        where p.order_id = o.id and p.method = 'card' and p.gateway = 'stripe'
                          and p.status in ('completed', 'refunded'))
       and not (o.created_at >= now() - interval '60 minutes'
                and exists (select 1 from public.payments p
                             where p.order_id = o.id and p.method = 'card' and p.gateway = 'stripe'
                               and p.status = 'pending'
                               and p.gateway_metadata ->> 'stripe_status' = 'processing'))
       -- A transfer slip waits for the restaurant, not for the clock.
       and not exists (select 1 from public.payments p
                        where p.order_id = o.id and p.method = 'transfer')
     order by o.created_at
     limit 200
     for update of o skip locked
  loop
    update public.payments
       set status = 'voided',
           gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
                              || jsonb_build_object('pending', false, 'expired_at', now())
     where order_id = r.id
       and method = 'card'
       and gateway = 'stripe'
       and status in ('pending', 'failed');

    update public.orders
       set status = 'cancelled',
           awaiting_payment = false,
           cancellation_reason = coalesce(cancellation_reason,
                                          'The card payment was not completed within 30 minutes.')
     where id = r.id
       and status = 'pending';

    insert into public.audit_logs (branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
    -- The real age, not the 30: an order a processing payment kept waiting is cancelled later.
    values (r.branch_id, null, 'system', 'order_card_payment_expired', 'order', r.id,
            jsonb_build_object('after_minutes', floor(extract(epoch from now() - r.created_at) / 60)::int));

    v_count := v_count + 1;
  end loop;
  return v_count;
end $function$;

comment on function private.expire_unpaid_card_orders() is
  'pg_cron, every minute: cancels storefront card orders still awaiting payment 30 minutes after they were placed (60 while a pending payment is still processing at Stripe) and voids their unpaid payments. Stock, points and credits come back through the orders cancel triggers.';

revoke all on function private.expire_unpaid_card_orders() from public, anon, authenticated;

do $$ begin
  perform cron.unschedule('expire-unpaid-card-orders');
exception when others then null; end $$;
select cron.schedule('expire-unpaid-card-orders', '* * * * *',
                     $$select private.expire_unpaid_card_orders()$$);
