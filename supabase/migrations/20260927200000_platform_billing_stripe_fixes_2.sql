-- Platform billing through Stripe: the second review fixes (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §10).
-- 20260927100000_platform_billing_stripe_fixes answered the first review; a focused re-review of it
-- confirmed the defects this file fixes on the SQL side. Every rule below names the finding it answers.
--
-- 1. A CARD CHANGE LOCK ALWAYS ENDS (§10.1, §10.4; money-rr-1, money-rr-4). A request tied to an
--    invoice (billing_requests.stripe_invoice_marked_at) or whose subscription update has been sent
--    (stripe_change_started_at, billing_mark_change_started) cannot be replaced or rejected
--    (payment_in_progress) -- but only for 23 hours, the window in which Stripe can still apply the
--    change it holds. A standalone fee invoice is never voided by Stripe, and a lost
--    pending_update_expired left the restaurant unable to change its package until it paid. Past the
--    window the next request_package_change cancels the old request (charges void, code released,
--    'card payment window expired') and goes on, and an operator's reject goes through; a late
--    payment of that invoice is refunded by the webhook (§9.3). The in-flight marker also locks a
--    change whose invoice id was never stored because the function died after Stripe answered.
--
-- 2. DELIVERY FOLLOWS ACTIVE BRANCHES (§10.3; money-rr-3). billing_apply_selection switches
--    delivery on only for active branches, and hiding a branch of a Stripe-managed restaurant (only a
--    platform admin gets past branches_block_stripe_delivery_loss) switches its delivery add-on off,
--    so showing it again never grants delivery Stripe does not bill. A platform suspension is the
--    exception: Stripe goes on billing, and Restore shows the same branches again.
--
-- 3. A CHANGE IS NEVER SETTLED AS A FIRST PURCHASE (§10.5; money-rr-7). A payment for the
--    subscription the row already holds, on a row that is no longer on the Stripe rail (it expired
--    while the change waited on 3-D Secure), answers not_managed without applying anything; the
--    caller refunds it and puts the subscription back.
--
-- 4. EVENTS: CLAIMED / HANDLED / IN FLIGHT (§10.7; SEC-R2-2, money-rr-6). stripe_event_claim says
--    which, so the webhook answers a delivery that meets a live lease with a retryable status
--    instead of 200 "duplicate".
--
-- 5. cancel_at COUNTS AS CANCELLING ONLY ON OR BEFORE THE NEXT RENEWAL (§10.8; ui-rr-2), in
--    billing_rail_json's next_charge_at; entitlements_json gains billing_ends_at by the same rule
--    (ui-rr-3), so managers see a cancelling card restaurant's end date.
--
-- 6. get_pending_billing_request hides the Stripe ids and the invoice page from staff without
--    billing.manage (SEC-R2-1). Its source is in a migration for the first time.
--
-- 7. billing_subscription_is_current tells the webhook whether any restaurant row holds a
--    subscription (money-rr-2: a paid renewal or change of one nobody holds is refunded).
--
-- Live bodies were read with pg_get_functiondef before each replacement and are kept except where
-- a comment says otherwise.

-- ---------------------------------------------------------------------------------------------
-- 1. When a request was tied to its invoice, and when its subscription update was sent.
-- ---------------------------------------------------------------------------------------------

alter table public.billing_requests
  add column if not exists stripe_invoice_marked_at timestamptz,
  add column if not exists stripe_change_started_at timestamptz;

comment on column public.billing_requests.stripe_invoice_marked_at is
  'When the request was tied to stripe_invoice_id (billing_mark_request_stripe). The payment_in_progress lock it holds ends 23 hours later (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §10.1).';
comment on column public.billing_requests.stripe_change_started_at is
  'When the edge function last sent this request''s subscription update to Stripe (billing_mark_change_started). Locks the request for 23 hours even when the invoice id was never stored (money-rr-4).';

-- A request tied to an invoice before this column existed counts from its last update.
update public.billing_requests
   set stripe_invoice_marked_at = coalesce(updated_at, created_at)
 where stripe_invoice_id is not null
   and stripe_invoice_marked_at is null;

-- ---------------------------------------------------------------------------------------------
-- 2. The card payment lock (§10.1; money-rr-1, money-rr-4).
-- ---------------------------------------------------------------------------------------------

-- How a request stands with a card payment Stripe may still apply:
--   'active'  -- pending on the card rail, tied to an invoice or with its subscription update sent,
--                less than 23 hours ago (the later of the two). Stripe keeps a pending update and an
--                idempotency key for about a day, so within this window the change can still land
--                whatever happens to the request; replacing or rejecting it would charge the
--                merchant for a package nobody grants.
--   'expired' -- the same, 23 hours or more ago. The request is cancelled by whoever meets it next;
--                a payment that still arrives for its invoice is refunded (§9.3).
--   null      -- no lock.
-- A lock with no timestamp (tied to an invoice by an older writer) counts from the last update.
create or replace function private.billing_card_lock(p_req public.billing_requests)
returns text
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select case
           when p_req.status is distinct from 'pending'
                or p_req.rail is distinct from 'stripe'
                or (p_req.stripe_invoice_id is null and p_req.stripe_change_started_at is null) then null
           when coalesce(greatest(p_req.stripe_invoice_marked_at, p_req.stripe_change_started_at),
                         p_req.updated_at, p_req.created_at) > now() - interval '23 hours' then 'active'
           else 'expired'
         end;
$function$;

comment on function private.billing_card_lock(public.billing_requests) is
  'active | expired | null: whether a pending card-rail request is still inside the 23-hour window in which Stripe can apply its invoice or subscription update (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §10.1).';

-- Cancels the restaurant's pending requests whose card payment window has run out, exactly as a
-- payment that will never be completed is cancelled (billing_cancel_stripe_request: charges void,
-- code reservation released, cancelled). Returns how many. The caller holds the restaurant's
-- pending rows.
create or replace function private.billing_release_expired_card_locks(p_restaurant_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_req public.billing_requests%rowtype;
  v_n   integer := 0;
begin
  for v_req in
    select br.* from public.billing_requests br
     where br.restaurant_id = p_restaurant_id
       and br.status = 'pending'
       and private.billing_card_lock(br) = 'expired'
     order by br.created_at
     for update
  loop
    -- Warn: if the merchant still pays that invoice, the webhook refunds it.
    perform public.billing_log_event('stripe.card_lock_expired', 'warn', 'card payment window expired',
      v_req.restaurant_id,
      jsonb_build_object('request_id', v_req.id, 'invoice', v_req.stripe_invoice_id,
                         'invoice_marked_at', v_req.stripe_invoice_marked_at,
                         'change_started_at', v_req.stripe_change_started_at));
    perform public.billing_cancel_stripe_request(v_req.id, 'card payment window expired');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 3. Marking a request (§10.1).
-- ---------------------------------------------------------------------------------------------

-- The live body with one change: stripe_invoice_marked_at is set when the request is tied to an
-- invoice. Marking the SAME invoice again (a retried start) keeps the time it was first tied, so
-- the window cannot be stretched; a checkout (no invoice) clears it.
create or replace function public.billing_mark_request_stripe(
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
         stripe_invoice_marked_at   = case
                                        when p_invoice_id is null then null
                                        when stripe_invoice_id is not distinct from p_invoice_id
                                             and stripe_invoice_marked_at is not null
                                          then stripe_invoice_marked_at
                                        else now()
                                      end,
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
  'Service role: the pending request is being paid by card, through this Checkout session or this subscription-change invoice (with Stripe''s hosted page for it, https only; stripe_invoice_marked_at is when it was first tied to that invoice). For 23 hours after that the request cannot be replaced or rejected (payment_in_progress). Raises request_not_pending / request_not_found / invalid_*.';

-- Called by the edge function just before it sends a request's subscription update to Stripe. If
-- the function dies after Stripe applied the change but before the invoice id is stored, this
-- marker still locks the request for 23 hours (money-rr-4), and the rail says the merchant is
-- paying by card. Each call restarts the window: the latest send is the one that may land. It
-- refuses a request that is no longer pending, so a change superseded meanwhile is never sent.
create or replace function public.billing_mark_change_started(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  update public.billing_requests
     set rail                     = 'stripe',
         stripe_change_started_at = now(),
         updated_at               = now()
   where id = p_request_id
     and status = 'pending';

  if not found then
    if exists (select 1 from public.billing_requests where id = p_request_id) then
      raise exception 'request_not_pending';
    end if;
    raise exception 'request_not_found';
  end if;
end $function$;

comment on function public.billing_mark_change_started(uuid) is
  'Service role: the edge function is about to send this pending request''s subscription update to Stripe. Sets rail = stripe and stripe_change_started_at = now(); the request then cannot be replaced or rejected for 23 hours (payment_in_progress), invoice or not. Raises request_not_pending / request_not_found.';

-- ---------------------------------------------------------------------------------------------
-- 4. Replacing or rejecting a locked request (§10.1).
-- ---------------------------------------------------------------------------------------------

-- The live body with one change: the payment_in_progress lock is private.billing_card_lock --
-- invoice or in-flight update, 23 hours -- and a lock that has run out is released: the old
-- request is cancelled ('card payment window expired') and the new one is filed.
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

  -- A card change that Stripe can still apply (its invoice is open, or its subscription update was
  -- sent, less than 23 hours ago) cannot be replaced: Stripe applies it the moment that invoice is
  -- paid, whatever happened to the request meanwhile, so superseding it would charge the merchant
  -- for a package nobody grants (money-sql-1, §9.3). The pending rows are locked first, so an edge
  -- function marking the request at this very moment is waited for and seen. Past the window the
  -- lock is released: the old request is cancelled here, outside the block below, so it stays
  -- cancelled whatever this call answers (money-rr-1, §10.1). A Checkout (a first purchase, no
  -- invoice yet) can still be replaced: its other sessions are expired and a late payment is
  -- refunded (D12).
  perform 1 from public.billing_requests
   where restaurant_id = p_restaurant_id and status = 'pending'
   for update;
  perform private.billing_release_expired_card_locks(p_restaurant_id);
  if exists (select 1 from public.billing_requests br
              where br.restaurant_id = p_restaurant_id and br.status = 'pending'
                and private.billing_card_lock(br) = 'active') then
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

-- The live body with one change: rejecting is refused (payment_in_progress) only while the card
-- payment lock is live (private.billing_card_lock -- invoice or in-flight update, 23 hours). Past
-- the window the reject goes through; with no note of the operator's it records why.
create or replace function public.decide_billing_request(p_id uuid, p_approve boolean, p_note text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_req  public.billing_requests%rowtype;
  v_ent  jsonb;
  v_lock text;
  v_note text := p_note;
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

  -- ...except a subscription change Stripe can still apply: its invoice is open, or its update was
  -- sent, less than 23 hours ago. Stripe applies that change the moment the invoice is paid,
  -- whatever this request says, so rejecting it here would charge the merchant for a package
  -- nobody grants (money-sql-1). Past the window it is let through (money-rr-1, §10.1): a payment
  -- that still arrives for that invoice is refunded by the webhook.
  if not p_approve then
    v_lock := private.billing_card_lock(v_req);
    if v_lock = 'active' then
      raise exception 'payment_in_progress'
        using hint = 'This change is waiting for its card payment on Stripe; it can be rejected 23 hours after it started if the merchant does not pay.';
    elsif v_lock = 'expired' then
      v_note := coalesce(nullif(btrim(p_note), ''), 'card payment window expired');
      perform public.billing_log_event('stripe.card_lock_expired', 'warn', 'card payment window expired',
        v_req.restaurant_id,
        jsonb_build_object('request_id', v_req.id, 'invoice', v_req.stripe_invoice_id,
                           'invoice_marked_at', v_req.stripe_invoice_marked_at,
                           'change_started_at', v_req.stripe_change_started_at, 'rejected', true));
    end if;
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
         decision_note = v_note,
         updated_at    = now()
   where id = p_id;

  return jsonb_build_object('ok', true, 'approved', p_approve, 'entitlements', v_ent);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 5. Delivery follows active branches (§10.3, money-rr-3).
-- ---------------------------------------------------------------------------------------------

-- The live body with one change: the delivery branches are this restaurant's ACTIVE branches.
create or replace function private.billing_apply_selection(p_restaurant_id uuid, p_plan_code text, p_delivery_branch_ids uuid[], p_branch_seats integer, p_status text DEFAULT 'active'::text, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_trial_ends_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan          public.billing_products%rowtype;
  v_seat          public.billing_products%rowtype;
  v_delivery      public.billing_products%rowtype;
  v_sub_id        uuid;
  v_seats         integer := greatest(coalesce(p_branch_seats, 1), 1);
  v_extra         integer;
  v_start         timestamptz := coalesce(p_period_start, now());
  v_end           timestamptz;
  v_trial_ends_at timestamptz := p_trial_ends_at;
  v_used          integer;
  v_keep          text[];
  v_ids           uuid[];
  v_delivers      integer;
  v_seat_price    numeric(10,2);
begin
  if p_restaurant_id is null then raise exception 'restaurant_required'; end if;

  select * into v_plan from public.billing_products where code = p_plan_code and kind = 'plan';
  if not found then raise exception 'unknown_plan:%', p_plan_code; end if;

  select * into v_seat from public.billing_products where code = 'extra_branch';
  select * into v_delivery from public.billing_products where code = 'delivery';

  -- Only this restaurant's own ACTIVE branches, each one once. A stray id from another tenant would
  -- otherwise be billed for here and unlocked for delivery. A branch hidden since the request was
  -- filed is left out too (money-rr-3): Stripe was priced from the branches open when the payment
  -- started (billing_checkout_context), so switching a hidden branch on here would hand it
  -- delivery that nobody bills the moment it is shown again.
  select coalesce(array_agg(distinct b.id), '{}'::uuid[]) into v_ids
    from public.branches b
   where b.restaurant_id = p_restaurant_id
     and b.is_active
     and b.id = any (coalesce(p_delivery_branch_ids, '{}'::uuid[]));

  -- A trial delivers from every branch by rule, so it neither bills a delivery line nor spends
  -- any branch's one-time unlock.
  if coalesce(v_plan.trial_days, 0) > 0 then
    v_ids := '{}'::uuid[];
  end if;
  v_delivers := coalesce(array_length(v_ids, 1), 0);

  -- The trial is $0 with everything on (docs/PACKAGING-2026-09-23.md §1), and that includes the
  -- branches beyond the first: the platform console can raise a trial's seats in one click, and
  -- charging the extra-branch line's $29 for each of them put "$29 every month" on a free trial's
  -- plan page. The seat LINE still has to exist -- billing_compute reads the seat count off it,
  -- and deleting it would strand the merchant's second branch outside enforce_branch_limit -- so
  -- the seat is kept and priced at the trial plan's own monthly price (0). This is the same rule
  -- as seatPrice() in packages/shared/src/utils/entitlements.ts, and the two must stay in step.
  -- billing_compute zeroes a trial's total as well, so the line's price is for the record: what
  -- the merchant is billed cannot depend on this writer getting it right.
  v_seat_price := case
                    when coalesce(v_plan.trial_days, 0) > 0 then coalesce(v_plan.monthly_price, 0)
                    else coalesce(v_seat.monthly_price, 0)
                  end;

  -- Never strand an active branch outside the paid seat count. Hidden branches hold no
  -- seat; un-hiding one later needs a free seat (enforce_branch_limit).
  select count(*) into v_used from public.branches where restaurant_id = p_restaurant_id and is_active;
  if v_seats < v_used then
    raise exception 'plan_limit_exceeded:branches:%/%', v_used, v_seats using errcode = 'P0001';
  end if;

  if v_plan.trial_days > 0 then
    v_trial_ends_at := coalesce(v_trial_ends_at, v_start + make_interval(days => v_plan.trial_days));
    v_end := coalesce(p_period_end, v_trial_ends_at);
  else
    v_end := coalesce(p_period_end, v_start + interval '1 month');
  end if;

  insert into public.subscriptions as s
    (restaurant_id, status, billing_cycle, current_period_start, current_period_end,
     branch_count, unit_price, plan_code, trial_ends_at)
  values
    (p_restaurant_id, coalesce(p_status, 'active')::public.subscription_status, 'monthly', v_start, v_end,
     v_seats, v_plan.monthly_price, v_plan.code, v_trial_ends_at)
  on conflict (restaurant_id) do update set
    status               = excluded.status,
    billing_cycle        = excluded.billing_cycle,
    current_period_start = excluded.current_period_start,
    current_period_end   = excluded.current_period_end,
    branch_count         = excluded.branch_count,
    unit_price           = excluded.unit_price,
    plan_code            = excluded.plan_code,
    trial_ends_at        = excluded.trial_ends_at,
    cancelled_at         = case when excluded.status in ('cancelled','expired')
                                then coalesce(s.cancelled_at, now()) else null end,
    updated_at           = now()
  returning id into v_sub_id;

  v_keep := array[v_plan.code];

  insert into public.subscription_items (subscription_id, product_code, quantity, unit_price)
  values (v_sub_id, v_plan.code, 1, v_plan.monthly_price)
  on conflict (subscription_id, product_code) do update set
    quantity = 1, unit_price = excluded.unit_price, updated_at = now();

  v_extra := greatest(v_seats - coalesce(v_plan.included_seats, 0), 0);
  if v_extra > 0 and v_seat.code is not null then
    v_keep := v_keep || v_seat.code;
    insert into public.subscription_items (subscription_id, product_code, quantity, unit_price)
    values (v_sub_id, v_seat.code, v_extra, v_seat_price)
    on conflict (subscription_id, product_code) do update set
      quantity = excluded.quantity, unit_price = excluded.unit_price, updated_at = now();
  end if;

  -- One delivery line, quantity = the number of delivering branches. That is the whole of
  -- "$29 more a month for every branch that delivers".
  if v_delivers > 0 and v_delivery.code is not null then
    v_keep := v_keep || v_delivery.code;
    insert into public.subscription_items (subscription_id, product_code, quantity, unit_price)
    values (v_sub_id, v_delivery.code, v_delivers, v_delivery.monthly_price)
    on conflict (subscription_id, product_code) do update set
      quantity = excluded.quantity, unit_price = excluded.unit_price, updated_at = now();
  end if;

  -- Downgrades must leave zero orphan line items.
  delete from public.subscription_items
   where subscription_id = v_sub_id and product_code <> all (v_keep);

  -- The chosen branches on, every other branch of this restaurant off. unlocked_at is never
  -- rewritten: the $59 is paid once ever, so switching a branch back on later is free.
  if v_delivery.code is not null then
    insert into public.branch_addons (branch_id, code, active)
    select b.id, 'delivery', true
      from public.branches b
     where b.id = any (v_ids)
    on conflict (branch_id, code) do update set active = true, updated_at = now();

    update public.branch_addons ba
       set active = false, updated_at = now()
     where ba.code = 'delivery'
       and ba.active
       and not (ba.branch_id = any (v_ids))
       and ba.branch_id in (select b.id from public.branches b where b.restaurant_id = p_restaurant_id);
  end if;

  perform private.billing_compute(p_restaurant_id);
  return private.entitlements_json(p_restaurant_id);
end $function$;

-- A branch of a Stripe-managed restaurant that is hidden loses its delivery add-on. Only a platform
-- admin gets this far with a delivering branch (branches_block_stripe_delivery_loss refuses
-- everyone else), and nothing re-checked delivery when the branch was shown again, so it came back
-- delivering while Stripe billed one delivery fewer (money-rr-3). The $59 unlock (unlocked_at) is
-- kept, so turning it back on from the plan page costs nothing once. A platform suspension is left
-- alone: it hides every open branch while Stripe goes on billing them, and Restore shows the same
-- branches again (set_restaurant_suspended writes the snapshot before it hides them).
create or replace function private.tg_branches_stripe_delivery_off()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not private.billing_is_stripe_managed(new.restaurant_id) then return null; end if;

  if exists (select 1 from private.platform_suspension_snapshots s
              where s.restaurant_id = new.restaurant_id
                and new.id = any (s.active_branch_ids)) then
    return null;
  end if;

  update public.branch_addons
     set active = false, updated_at = now()
   where branch_id = new.id and code = 'delivery' and active;

  if found then
    perform public.billing_log_event('stripe.delivery_branch_hidden', 'warn',
      'a hidden branch of a card restaurant lost its delivery add-on', new.restaurant_id,
      jsonb_build_object('branch_id', new.id));
    perform private.billing_compute(new.restaurant_id);
  end if;
  return null;
end $function$;

drop trigger if exists branches_stripe_delivery_off_on_hide on public.branches;
create trigger branches_stripe_delivery_off_on_hide
  after update of is_active on public.branches
  for each row
  when (old.is_active and not new.is_active)
  execute function private.tg_branches_stripe_delivery_off();

-- ---------------------------------------------------------------------------------------------
-- 6. A change is never settled as a first purchase (§10.5, money-rr-7).
-- ---------------------------------------------------------------------------------------------

-- The live body with one change: a payment for the subscription the row already holds is a
-- change, and a change on a row that is no longer Stripe-managed (it expired, or was cancelled,
-- while the change waited on 3-D Secure) answers not_managed and writes nothing. Settled as a
-- first purchase it made the row active and paid through the period Stripe had not been paid for.
-- The caller refunds the payment and puts the subscription's quantities back. A first purchase
-- (a new subscription, or a row that holds another one) is settled as before.
create or replace function public.billing_settle_stripe_request(
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

  -- A change of the subscription this row holds, on a row that has left the Stripe rail: nothing
  -- is applied, and the caller refunds and reverts it (money-rr-7, §10.5).
  if not v_managed and v_has_sub and v_sub.stripe_subscription_id = p_stripe_subscription_id then
    perform public.billing_log_event('stripe.settle_refused', 'warn', 'not_managed:' || v_sub.status::text,
                                     v_req.restaurant_id, v_payload);
    return jsonb_build_object('ok', false, 'reason', 'not_managed', 'kind', 'change',
                              'subscription_status', v_sub.status::text,
                              'request_id', v_req.id, 'restaurant_id', v_req.restaurant_id);
  end if;

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
  'Service role: a package request paid by card. First purchase (a subscription the row does not hold, on a row not Stripe-managed): the package is applied active, paid through p_paid_through, with the Stripe ids stored; replaced_subscription_id names a different subscription the row still carried (cancel it at Stripe). Change (the subscription the row holds, row Stripe-managed): applied keeping the current period. p_monthly_amount is Stripe''s recurring total in dollars (null = unknown). The customer and the card go to billing_stripe_customers. Returns {ok:true, duplicate, kind, replaced_subscription_id} | {ok:false, reason: request_not_pending (refund it, D12; also when another subscription already bills the restaurant) | not_managed (kind change, subscription_status: the row holds this subscription but is no longer Stripe-managed; nothing written -- refund and revert it, §10.5) | settle_failed (with kind; logged, never retried -- refund it) | request_not_found | invalid_arguments}.';

-- ---------------------------------------------------------------------------------------------
-- 7. Webhook events: claimed, handled or in flight (§10.7; SEC-R2-2, money-rr-6).
-- ---------------------------------------------------------------------------------------------

-- The same lease as before; the answer says which of three things is true, so the webhook can
-- tell a delivery it must not handle (handled: 200) from one that meets a claim still running or
-- abandoned inside its lease (in_flight: a retryable status, so Stripe delivers again and a retry
-- after the lease reclaims it). A boolean answered both with false, and the webhook's 200
-- "duplicate" ended Stripe's retries for an event whose worker then died (WH-5 incomplete).
drop function if exists public.stripe_event_claim(text, text, integer);
create function public.stripe_event_claim(p_event_id text, p_type text, p_lease_seconds integer default 300)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 86400));
  v_note  text;
begin
  -- No id means we cannot dedupe at all. Fail closed, as stripe_event_seen does: never handled.
  if coalesce(p_event_id, '') = '' then return 'handled'; end if;

  insert into public.billing_events (stripe_event_id, type, level, note)
  values (p_event_id, coalesce(nullif(p_type, ''), 'unknown'), 'info', 'received')
  on conflict (stripe_event_id) do nothing;
  if found then return 'claimed'; end if;

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
  if found then return 'claimed'; end if;

  select note into v_note from public.billing_events where stripe_event_id = p_event_id;
  -- Still 'received' inside its lease: another worker holds it. Gone: a failed worker released it
  -- between the two statements above, so the retry this answer asks for claims it afresh.
  if v_note is null or v_note = 'received' then return 'in_flight'; end if;
  return 'handled';
end $function$;

comment on function public.stripe_event_claim(text, text, integer) is
  'Service role, platform webhook: ''claimed'' when this delivery should handle the event (it is new, or an earlier claim is still ''received'' after p_lease_seconds, 30..86400, default 300, and is taken over) -- call stripe_event_done after handling; ''in_flight'' while an earlier claim is still inside its lease (answer a retryable status so Stripe delivers it again); ''handled'' once it was handled (answer 200), or when there is no event id to dedupe on.';

-- ---------------------------------------------------------------------------------------------
-- 8. What the rail and the entitlements say about a cancelling subscription (§10.8; ui-rr-2, ui-rr-3).
-- ---------------------------------------------------------------------------------------------

-- The live body with one change: next_charge_at is null only when the subscription ends before its
-- next renewal -- cancel_at_period_end, or a cancel_at on or before that renewal. Stripe's "cancel
-- on a custom date" months out still charges every renewal until then, and the screens said
-- "will not renew" (ui-rr-2). The rest is as 20260927100000 left it.
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
    -- Only the Stripe rail charges by itself, and not once the subscription ends before its next
    -- renewal.
    'next_charge_at',       case
                              when m.managed
                                   and not coalesce(s.cancel_at_period_end, false)
                                   and (s.cancel_at is null
                                        or s.cancel_at > coalesce(s.next_billing_at, s.current_period_end))
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

-- The live body with one key added: billing_ends_at, the date a Stripe-managed subscription ends
-- because it is set to cancel before its next renewal -- cancel_at when that falls on or before the
-- renewal, else the period end when cancel_at_period_end -- and null otherwise (the same rule as
-- next_charge_at, so exactly one of the two is set on the Stripe rail). Every member reads this
-- payload; the date is not sensitive, and managers are warned before the store goes dark
-- (ui-rr-3). The Stripe-managed test is made once for both keys.
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
    'billing_rail',     case when m.managed then 'stripe' else 'manual' end,
    'billing_ends_at',  case
                          when not m.managed then null
                          when s.cancel_at is not null
                               and s.cancel_at <= coalesce(s.next_billing_at, s.current_period_end)
                            then s.cancel_at
                          when coalesce(s.cancel_at_period_end, false) then s.current_period_end
                        end,
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
  from (select private.billing_is_stripe_managed(p_restaurant_id) as managed) m
  left join public.billing_entitlements be on be.restaurant_id = p_restaurant_id
  left join public.subscriptions s on s.restaurant_id = p_restaurant_id;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 9. The pending request, as every member reads it (SEC-R2-1).
-- ---------------------------------------------------------------------------------------------

-- The live body (it was only ever in the database: supabase/migrations had it as a comment) with
-- one change: the Stripe ids and the hosted invoice page are left out for anyone who does not hold
-- billing.manage for the restaurant. That page shows the owner's billing name, email and address
-- and offers payment; get_billing_overview, the plan page's source for it, is billing.manage-only
-- already.
create or replace function public.get_pending_billing_request(p_restaurant_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  if p_restaurant_id not in (select private.user_restaurant_ids())
     and not private.user_is_platform_admin() then
    raise exception 'forbidden';
  end if;
  return (
    select case
             when private.user_can_manage_billing(p_restaurant_id) then to_jsonb(br)
             else to_jsonb(br) - 'stripe_invoice_url' - 'stripe_invoice_id' - 'stripe_checkout_session_id'
           end
      from public.billing_requests br
     where br.restaurant_id = p_restaurant_id and br.status = 'pending'
     order by br.created_at desc limit 1
  );
end $function$;

comment on function public.get_pending_billing_request(uuid) is
  'The restaurant''s newest pending package request, for any of its members (or a platform admin). stripe_invoice_url, stripe_invoice_id and stripe_checkout_session_id only for billing.manage.';

-- ---------------------------------------------------------------------------------------------
-- 10. Whether a subscription is anyone's (§10.2, money-rr-2).
-- ---------------------------------------------------------------------------------------------

-- The webhook refunds a renewal or change invoice paid for a subscription no restaurant row holds
-- (one the manual rail detached while Stripe was still retrying it) and cancels it. Any status
-- counts: a row that still holds the subscription is the restaurant's, whatever it says.
create or replace function public.billing_subscription_is_current(p_stripe_subscription_id text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(p_stripe_subscription_id, '') <> ''
         and exists (select 1 from public.subscriptions s
                      where s.stripe_subscription_id = p_stripe_subscription_id);
$function$;

comment on function public.billing_subscription_is_current(text) is
  'Service role, platform webhook: true when a subscriptions row holds this Stripe subscription id (any status); false for one no restaurant holds, or no id.';

-- ---------------------------------------------------------------------------------------------
-- 11. Grants.
-- ---------------------------------------------------------------------------------------------

revoke all on function private.billing_card_lock(public.billing_requests) from public, anon, authenticated;
revoke all on function private.billing_release_expired_card_locks(uuid) from public, anon, authenticated;
revoke all on function private.tg_branches_stripe_delivery_off() from public, anon, authenticated;
revoke all on function private.billing_apply_selection(uuid, text, uuid[], integer, text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function private.billing_rail_json(uuid) from public, anon, authenticated;
revoke all on function private.entitlements_json(uuid, uuid) from public, anon, authenticated;

-- Re-created above; their grants are kept by CREATE OR REPLACE and restated here.
revoke all on function public.decide_billing_request(uuid, boolean, text) from public, anon;
grant execute on function public.decide_billing_request(uuid, boolean, text) to authenticated, service_role;
revoke all on function public.request_package_change(uuid, text, integer, uuid[], text, text) from public, anon;
grant execute on function public.request_package_change(uuid, text, integer, uuid[], text, text) to authenticated, service_role;
revoke all on function public.get_pending_billing_request(uuid) from public, anon;
grant execute on function public.get_pending_billing_request(uuid) to authenticated, service_role;

-- The edge function and the webhook only.
revoke all on function public.billing_mark_request_stripe(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.billing_mark_request_stripe(uuid, text, text, text) to service_role;
revoke all on function public.billing_mark_change_started(uuid) from public, anon, authenticated;
grant execute on function public.billing_mark_change_started(uuid) to service_role;
revoke all on function public.billing_settle_stripe_request(uuid, text, text, text, timestamptz, jsonb, jsonb, numeric) from public, anon, authenticated;
grant execute on function public.billing_settle_stripe_request(uuid, text, text, text, timestamptz, jsonb, jsonb, numeric) to service_role;
revoke all on function public.stripe_event_claim(text, text, integer) from public, anon, authenticated;
grant execute on function public.stripe_event_claim(text, text, integer) to service_role;
revoke all on function public.billing_subscription_is_current(text) from public, anon, authenticated;
grant execute on function public.billing_subscription_is_current(text) to service_role;
