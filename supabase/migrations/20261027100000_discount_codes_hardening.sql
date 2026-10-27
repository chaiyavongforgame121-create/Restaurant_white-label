-- Discount codes, hardened (the discount-code audit of 2026-10-27: defects D1, D2, D5, D6, D7 and
-- D12; D3 and D9 are read fixes in packages/database). Every function below that is replaced was
-- re-created from its live definition (pg_get_functiondef on 2026-10-27) with the same owner,
-- SECURITY DEFINER, search_path and grants; only the lines named here changed.
--
-- 1. A DELETED RESTAURANT KEEPS ITS CODE HISTORY (D5). billing_discount_redemptions.restaurant_id
--    is nullable and ON DELETE SET NULL (it was NOT NULL ... ON DELETE CASCADE, which erased a use
--    that was given away while redemption_count kept it: "1 of 1 used", "Given away $0"). A use
--    given away now stays on the code's ledger with no restaurant, which the console shows as
--    "Deleted restaurant", so the counter keeps matching its rows. A RESERVED use that loses its
--    restaurant or its request (deleting a restaurant deletes its requests) is given back as
--    before: billing_discount_redemptions_orphan_release deletes the row, and the existing release
--    trigger takes the use off the counter.
--
-- 2. THE CODES TABLE IS WRITTEN ONLY THROUGH THE RPCs (D6). authenticated keeps SELECT, under a
--    select-only policy for platform admins; INSERT and UPDATE are revoked. The console's RPCs are
--    SECURITY DEFINER and never needed them, while a direct write could move redemption_count or
--    store a code no merchant can ever type (lower case, padded).
--
-- 3. THE SERVER REFUSES WHAT THE CONSOLE REFUSES (D7). platform_create_discount_code and
--    platform_update_discount_code, all 22023 with the reason as the message:
--      code_invalid_chars            after upper-case and trim, a code is letters, digits and dashes,
--                                    starting and ending with a letter or digit (the console's
--                                    DISCOUNT_CODE_PATTERN);
--      code_too_long                 at most 40 characters (create only: a code never changes), the
--                                    console's DISCOUNT_CODE_MAX_LENGTH and the most a Stripe line
--                                    names (displayCode in _shared/stripe-billing.ts);
--      product_not_one_time:<code>   every product a code names is sold one-time today (an active
--                                    billing_products row with a one-time price). An edit may keep a
--                                    product the code already names, so an old code stays editable;
--      ends_before_start             ends_at must be after starts_at;
--      per_restaurant_limit_invalid  a limit below 1 is refused, no longer stored as 1 (blank or
--                                    absent still means 1).
--
-- 4. AN ABANDONED CARD CHECKOUT GIVES ITS CODE BACK (D2). public.billing_cancel_expired_checkout
--    (service role) is what stripe-webhook calls on checkout.session.expired, once Stripe holds no
--    other open session for the request. Under the request's row lock it cancels the request
--    (billing_cancel_stripe_request: charges void, the code's use released, cancelled) only while
--    it is still pending on the card rail, still paid through exactly that session and tied to no
--    invoice or subscription change. private.billing_release_stale_checkouts, hourly (pg_cron
--    billing-release-stale-checkouts), is the safety net for an expiry the webhook never handled:
--    it lets go of a checkout request left 96 hours since its session was stored. A session lives
--    24 hours at most and Stripe retries a webhook for three days, so a paid one settled long
--    before.
--
-- 5. THE CARD LINE NAMES THE CODE (D12). billing_checkout_context's charges also carry amount (the
--    list price), discount_code and discount_amount, so stripe-billing can call a discounted
--    one-time line "FavorNoms Plan, first-time setup, list price $199.00 (code TEST50, −$99.50)".
--    Additive: an edge function that does not read them is unaffected.
--
-- 6. THE PRICE CONFIRMED IS THE PRICE FILED (D1). request_package_change takes p_expected_one_time
--    and p_expected_monthly, default null (not checked), so every existing caller works unchanged.
--    When either differs from what the server prices now (an operator edited the code, the catalog
--    was repriced) nothing is filed or replaced, and the answer is {ok:false, reason:'quote_changed',
--    error:'quote_changed', one_time_total, monthly_total, discount_code, discount_amount,
--    expected_one_time, expected_monthly} for the merchant to confirm again. It is not a failed
--    code check: the guessing limit does not count it. A refused code still answers
--    discount_invalid first. The six-argument signature is dropped: the eight-argument one answers
--    every call it answered, by position or by name, and keeping both would make those calls
--    ambiguous.
--
-- Run order: this migration, then the edge functions (stripe-webhook, stripe-billing), then the
-- admin app that sends p_expected_*. Each step works with the one before it.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. Redemptions outlive their restaurant (D5)
-- ---------------------------------------------------------------------------------------------

alter table public.billing_discount_redemptions
  alter column restaurant_id drop not null;

alter table public.billing_discount_redemptions
  drop constraint if exists billing_discount_redemptions_restaurant_id_fkey;
alter table public.billing_discount_redemptions
  add constraint billing_discount_redemptions_restaurant_id_fkey
  foreign key (restaurant_id) references public.restaurants(id) on delete set null;

comment on column public.billing_discount_redemptions.restaurant_id is
  'The restaurant that used the code; null once that restaurant was deleted. A use it was given stays on the ledger (redemption_count keeps counting it); a use it only reserved is given back (billing_discount_redemptions_orphan_release).';

-- A reservation whose restaurant or request is gone can never be approved: it is deleted, which
-- the release trigger turns into one use fewer on the code. Only reservations: a 'redeemed' row is
-- money given away and stays.
create or replace function private.tg_billing_discount_orphan_release()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  delete from public.billing_discount_redemptions
   where id = new.id
     and status = 'reserved';
  return null;
end $function$;

revoke all on function private.tg_billing_discount_orphan_release() from public, anon, authenticated;

drop trigger if exists billing_discount_redemptions_orphan_release on public.billing_discount_redemptions;
create trigger billing_discount_redemptions_orphan_release
  after update of restaurant_id, request_id on public.billing_discount_redemptions
  for each row
  when (new.status = 'reserved' and (new.restaurant_id is null or new.request_id is null))
  execute function private.tg_billing_discount_orphan_release();

-- ---------------------------------------------------------------------------------------------
-- 2. The codes table: read by platform admins, written only by the RPCs (D6)
-- ---------------------------------------------------------------------------------------------

revoke insert, update on public.billing_discount_codes from authenticated;

drop policy if exists billing_discount_codes_platform_admin on public.billing_discount_codes;
create policy billing_discount_codes_platform_admin on public.billing_discount_codes
  for select to authenticated
  using (private.user_is_platform_admin());

comment on table public.billing_discount_codes is
  'Platform-issued codes that come off the ONE-TIME total only (the plan''s first-time setup and each additional branch''s setup). Keeping the recurring bill out of it leaves the monthly figure one number everyone can check. code is stored and compared upper-case; product_codes empty means every one-time charge. Written only by platform_create_discount_code / platform_update_discount_code (and the redemption ledger''s counter); platform admins may read it.';

-- ---------------------------------------------------------------------------------------------
-- 3. Console writes check what the console checks (D7)
-- ---------------------------------------------------------------------------------------------

-- The first of p_codes a code may not name: anything not sold one-time today (an active
-- billing_products row with a one-time price), a blank included. p_kept are products the code
-- already names, which an edit may leave on it. Null when every one is fine.
create or replace function private.billing_discount_unsold_product(p_codes text[], p_kept text[] default '{}'::text[])
returns text
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(t.c, '')
    from unnest(coalesce(p_codes, '{}'::text[])) with ordinality t(c, ord)
   where t.c is null
      or (not (t.c = any (coalesce(p_kept, '{}'::text[])))
          and not exists (select 1 from public.billing_products p
                           where p.code = t.c and p.is_active and p.one_time_price > 0))
   order by t.ord
   limit 1;
$function$;

revoke all on function private.billing_discount_unsold_product(text[], text[]) from public, anon, authenticated;

-- The live body with the checks in section 3 of the header added; the insert is unchanged except
-- that it takes the checked values.
create or replace function public.platform_create_discount_code(p jsonb)
 returns billing_discount_codes
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_code     text := upper(btrim(coalesce(p ->> 'code', '')));
  v_products text[];
  v_bad      text;
  v_per      integer;
  v_starts   timestamptz;
  v_ends     timestamptz;
  v          public.billing_discount_codes%rowtype;
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  if v_code = '' then raise exception 'code_required'; end if;
  -- What a merchant can type off a flyer: the console's DISCOUNT_CODE_PATTERN.
  if v_code !~ '^[A-Z0-9]([A-Z0-9-]*[A-Z0-9])?$' then
    raise exception using errcode = '22023', message = 'code_invalid_chars';
  end if;
  -- The console's DISCOUNT_CODE_MAX_LENGTH, and the most a Stripe line names (displayCode).
  if char_length(v_code) > 40 then
    raise exception using errcode = '22023', message = 'code_too_long';
  end if;
  if coalesce(p ->> 'kind', '') not in ('percent', 'fixed') then raise exception 'kind_invalid'; end if;

  v_products := coalesce((select array_agg(value) from jsonb_array_elements_text(
                  case when jsonb_typeof(p -> 'product_codes') = 'array'
                       then p -> 'product_codes' else '[]'::jsonb end)), '{}'::text[]);
  -- A code for a product nobody buys once would answer not_applicable to every merchant.
  v_bad := private.billing_discount_unsold_product(v_products);
  if v_bad is not null then
    raise exception using errcode = '22023', message = 'product_not_one_time:' || v_bad;
  end if;

  -- Blank means the default, 1. Anything below 1 is a mistake to point out, not to round up.
  v_per := coalesce(nullif(p ->> 'per_restaurant_limit', '')::integer, 1);
  if v_per < 1 then
    raise exception using errcode = '22023', message = 'per_restaurant_limit_invalid';
  end if;

  v_starts := coalesce(nullif(p ->> 'starts_at', '')::timestamptz, now());
  v_ends   := nullif(p ->> 'ends_at', '')::timestamptz;
  -- An end at or before the start is a code no merchant can ever use.
  if v_ends is not null and v_ends <= v_starts then
    raise exception using errcode = '22023', message = 'ends_before_start';
  end if;

  insert into public.billing_discount_codes
    (code, description, kind, value, product_codes, max_redemptions, per_restaurant_limit,
     starts_at, ends_at, is_active, created_by)
  values
    (v_code,
     nullif(btrim(coalesce(p ->> 'description', '')), ''),
     p ->> 'kind',
     coalesce((p ->> 'value')::numeric, 0),
     v_products,
     nullif(p ->> 'max_redemptions', '')::integer,
     v_per,
     v_starts,
     v_ends,
     coalesce((p ->> 'is_active')::boolean, true),
     auth.uid())
  returning * into v;

  return v;
end $function$;

comment on function public.platform_create_discount_code(jsonb) is
  'Platform admin: a new discount code from the console''s draft. Raises forbidden, code_required, code_invalid_chars, code_too_long, kind_invalid, product_not_one_time:<code>, per_restaurant_limit_invalid, ends_before_start (code_invalid_chars, code_too_long and the last three 22023), or the table''s own checks (value, percent range, max_redemptions, the unique code).';

revoke all on function public.platform_create_discount_code(jsonb) from public, anon;
grant execute on function public.platform_create_discount_code(jsonb) to authenticated, service_role;

-- The live body with the checks in section 3 of the header added. The row is read first (and
-- locked), so a product or date check can see what the code already says; an absent key still
-- means "leave alone".
create or replace function public.platform_update_discount_code(p_id uuid, p jsonb)
 returns billing_discount_codes
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old      public.billing_discount_codes%rowtype;
  v_products text[];
  v_bad      text;
  v_per      integer;
  v_starts   timestamptz;
  v_ends     timestamptz;
  v          public.billing_discount_codes%rowtype;
begin
  if not private.user_is_platform_admin() then raise exception 'forbidden'; end if;
  if p ? 'kind' and coalesce(p ->> 'kind', '') not in ('percent', 'fixed') then
    raise exception 'kind_invalid';
  end if;

  select * into v_old from public.billing_discount_codes where id = p_id for update;
  if not found then raise exception 'code_not_found'; end if;

  v_products := v_old.product_codes;
  if p ? 'product_codes' then
    v_products := coalesce((select array_agg(value) from jsonb_array_elements_text(
                    case when jsonb_typeof(p -> 'product_codes') = 'array'
                         then p -> 'product_codes' else '[]'::jsonb end)), '{}'::text[]);
    -- A product the code already names may stay (it was sold when the code was written); a new
    -- one must be sold one-time today.
    v_bad := private.billing_discount_unsold_product(v_products, v_old.product_codes);
    if v_bad is not null then
      raise exception using errcode = '22023', message = 'product_not_one_time:' || v_bad;
    end if;
  end if;

  v_per := v_old.per_restaurant_limit;
  if p ? 'per_restaurant_limit' then
    v_per := coalesce(nullif(p ->> 'per_restaurant_limit', '')::integer, 1);
    if v_per < 1 then
      raise exception using errcode = '22023', message = 'per_restaurant_limit_invalid';
    end if;
  end if;

  v_starts := case when p ? 'starts_at'
                   then coalesce(nullif(p ->> 'starts_at', '')::timestamptz, v_old.starts_at)
                   else v_old.starts_at end;
  v_ends   := case when p ? 'ends_at' then nullif(p ->> 'ends_at', '')::timestamptz
                   else v_old.ends_at end;
  if (p ? 'starts_at' or p ? 'ends_at') and v_ends is not null and v_ends <= v_starts then
    raise exception using errcode = '22023', message = 'ends_before_start';
  end if;

  -- An absent key means "leave alone", so deactivating a code cannot clobber its dates. The
  -- redemption counter is never writable from here: it is the ledger's job.
  update public.billing_discount_codes c
     set description          = case when p ? 'description'
                                     then nullif(btrim(coalesce(p ->> 'description', '')), '')
                                     else c.description end,
         kind                 = case when p ? 'kind' then p ->> 'kind' else c.kind end,
         value                = case when p ? 'value' then coalesce((p ->> 'value')::numeric, c.value)
                                     else c.value end,
         product_codes        = v_products,
         max_redemptions      = case when p ? 'max_redemptions'
                                     then nullif(p ->> 'max_redemptions', '')::integer
                                     else c.max_redemptions end,
         per_restaurant_limit = v_per,
         starts_at            = v_starts,
         ends_at              = v_ends,
         is_active            = case when p ? 'is_active'
                                     then coalesce((p ->> 'is_active')::boolean, c.is_active)
                                     else c.is_active end,
         updated_at           = now()
   where c.id = p_id
  returning * into v;

  if v.id is null then raise exception 'code_not_found'; end if;
  return v;
end $function$;

comment on function public.platform_update_discount_code(uuid, jsonb) is
  'Platform admin: change a discount code; an absent key leaves that field alone, and the code itself and its counter are never changed here. Raises forbidden, kind_invalid, code_not_found, product_not_one_time:<code> (a product the code already names may stay), per_restaurant_limit_invalid, ends_before_start (the last three 22023), or the table''s own checks.';

revoke all on function public.platform_update_discount_code(uuid, jsonb) from public, anon;
grant execute on function public.platform_update_discount_code(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. An abandoned card checkout gives its code back (D2)
-- ---------------------------------------------------------------------------------------------

-- Called by stripe-webhook on checkout.session.expired, once Stripe has no other open session for
-- the request. The request is cancelled exactly as a card payment that will never be completed is
-- (billing_cancel_stripe_request) -- but only while that session is still the one paying it:
-- stripe-billing stores a newer session, or moves a change on to an invoice, under the same row
-- lock, and either means the merchant can still pay. {cancelled, reason}: request_not_found,
-- request_not_pending, not_card_request (a manual request the platform can still approve),
-- invoice_in_progress, other_session.
create or replace function public.billing_cancel_expired_checkout(p_request_id uuid, p_session_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_req public.billing_requests%rowtype;
begin
  if p_session_id is null or p_session_id !~ '^cs_[A-Za-z0-9_]+$' then
    raise exception 'invalid_checkout_session_id';
  end if;

  select * into v_req from public.billing_requests where id = p_request_id for update;
  if not found then
    return jsonb_build_object('cancelled', false, 'reason', 'request_not_found');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('cancelled', false, 'reason', 'request_not_pending', 'status', v_req.status);
  end if;
  if v_req.rail is distinct from 'stripe' then
    return jsonb_build_object('cancelled', false, 'reason', 'not_card_request');
  end if;
  if v_req.stripe_invoice_id is not null or v_req.stripe_change_started_at is not null then
    return jsonb_build_object('cancelled', false, 'reason', 'invoice_in_progress');
  end if;
  if v_req.stripe_checkout_session_id is distinct from p_session_id then
    return jsonb_build_object('cancelled', false, 'reason', 'other_session');
  end if;

  perform public.billing_cancel_stripe_request(v_req.id, 'Card checkout expired unpaid');
  return jsonb_build_object('cancelled', true, 'request_id', v_req.id,
                            'restaurant_id', v_req.restaurant_id,
                            'discount_code', v_req.discount_code);
end $function$;

comment on function public.billing_cancel_expired_checkout(uuid, text) is
  'Service role (stripe-webhook, checkout.session.expired): cancels the pending card request this expired Checkout session was paying -- charges void, the discount code''s use released -- unless the request has moved on to another session or to an invoice. {cancelled:true, request_id, restaurant_id, discount_code} or {cancelled:false, reason}. Raises invalid_checkout_session_id.';

revoke all on function public.billing_cancel_expired_checkout(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_cancel_expired_checkout(uuid, text) to service_role;

-- The safety net: a pending request paid through a Checkout session, with no invoice and no
-- subscription change, whose session was stored more than 96 hours ago. That session expired 72
-- hours ago at the latest and any payment for it has had Stripe's three days of webhook retries,
-- so nothing can pay it any more: it is cancelled like an expired checkout. Skips a row another
-- transaction holds (a merchant filing a new request), which the next run meets again.
create or replace function private.billing_release_stale_checkouts()
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
     where br.status = 'pending'
       and br.rail = 'stripe'
       and br.stripe_checkout_session_id is not null
       and br.stripe_invoice_id is null
       and br.stripe_change_started_at is null
       and br.updated_at < now() - interval '96 hours'
     order by br.created_at
     for update skip locked
  loop
    -- Warn: the webhook should have let it go when its session expired.
    perform public.billing_log_event('stripe.checkout_stale_released', 'warn',
      'a card checkout left unpaid was let go', v_req.restaurant_id,
      jsonb_build_object('request_id', v_req.id, 'session', v_req.stripe_checkout_session_id,
                         'session_stored_at', v_req.updated_at, 'discount_code', v_req.discount_code));
    perform public.billing_cancel_stripe_request(v_req.id, 'Card checkout expired unpaid');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $function$;

comment on function private.billing_release_stale_checkouts() is
  'pg_cron billing-release-stale-checkouts, hourly: cancels pending card requests paid through a Checkout session stored more than 96 hours ago, with no invoice or subscription change (billing_cancel_stripe_request: charges void, the code''s use released). The safety net for a checkout.session.expired the webhook never handled. Returns how many.';

revoke all on function private.billing_release_stale_checkouts() from public, anon, authenticated;

do $cron$
begin
  -- A job of that name with another schedule, command or switched off is put back (unschedule by
  -- name, then schedule below, as the other cron migrations do). One that matches is not touched.
  if exists (select 1 from cron.job
              where jobname = 'billing-release-stale-checkouts'
                and (schedule <> '23 * * * *'
                     or btrim(command) <> 'select private.billing_release_stale_checkouts()'
                     or not active)) then
    perform cron.unschedule('billing-release-stale-checkouts');
  end if;

  if not exists (select 1 from cron.job where jobname = 'billing-release-stale-checkouts') then
    perform cron.schedule('billing-release-stale-checkouts', '23 * * * *',
                          'select private.billing_release_stale_checkouts()');
  end if;
end
$cron$;

-- ---------------------------------------------------------------------------------------------
-- 5. The checkout context names each charge's list price and code (D12)
-- ---------------------------------------------------------------------------------------------

-- The live body with one change: each charge also carries amount, discount_code and
-- discount_amount.
create or replace function public.billing_checkout_context(p_request_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_req      public.billing_requests%rowtype;
  v_plan     public.billing_products%rowtype;
  v_seat     public.billing_products%rowtype;
  v_extra    integer;
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

  -- The monthly lines Stripe bills are the ones billing_compute will sum once this request is
  -- applied: the plan once and every seat past the included ones. There is no delivery line
  -- (docs/PACKAGING-2026-10-24.md §4.2), whatever an old request's delivery_branch_ids says.
  v_extra := greatest(v_req.branch_seats - coalesce(v_plan.included_seats, 0), 0);

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'code', v_plan.code, 'quantity', 1,
    'unit_amount_cents', round(coalesce(v_plan.monthly_price, 0) * 100)::integer));
  if v_extra > 0 and v_seat.code is not null then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', v_seat.code, 'quantity', v_extra,
      'unit_amount_cents', round(coalesce(v_seat.monthly_price, 0) * 100)::integer));
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
    -- What is charged once, at its NET amount (after the code). A $0 line -- a fee a code took
    -- off in full -- is left out: there is nothing to collect, and settling marks it paid with the
    -- rest of the request. amount (the list price), discount_code and discount_amount are only
    -- for the line's name on Stripe (D12); net_amount is what is charged.
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'code', c.code,
               'branch_id', c.branch_id,
               'net_amount', c.net_amount,
               'amount', c.amount,
               'discount_code', c.discount_code,
               'discount_amount', c.discount_amount)
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
  'The stripe-billing edge function, with the CALLER''s JWT: everything needed to charge a pending package request by card. {ok:false, error:forbidden} unless the caller holds billing.manage for its restaurant (or the request does not exist); request_not_pending once it is no longer on order; plan_not_billable; plan_limit_exceeded (with detail, branches_used, branch_seats) when its seats no longer cover the active branches. monthly_lines are in cents; charges are the non-zero one-time charges at their net amount in dollars, with the list amount, discount_code and discount_amount each was priced from.';

revoke all on function public.billing_checkout_context(uuid) from public, anon;
grant execute on function public.billing_checkout_context(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. request_package_change: the figures the merchant confirmed (D1)
-- ---------------------------------------------------------------------------------------------

drop function if exists public.request_package_change(uuid, text, integer, uuid[], text, text);

-- The live body with three changes: the two p_expected_* parameters, the quote_changed check
-- just before anything is filed (raised inside the writing block, so the superseded request is
-- left exactly as it was), and its answer after the block.
create or replace function public.request_package_change(p_restaurant_id uuid, p_plan_code text, p_branch_seats integer DEFAULT 1, p_delivery_branch_ids uuid[] DEFAULT '{}'::uuid[], p_discount_code text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_expected_one_time numeric DEFAULT NULL::numeric, p_expected_monthly numeric DEFAULT NULL::numeric)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan     public.billing_products%rowtype;
  v_seats    integer;
  v_ids_superseded uuid[];
  v_open     integer;
  v_monthly  numeric(10,2) := 0;
  v_code     text := nullif(upper(btrim(coalesce(p_discount_code, ''))), '');
  v_priced   jsonb;
  v_quote    jsonb;
  v_row      public.billing_requests%rowtype;
  v_reason   text;
  v_changed  boolean := false;
begin
  -- p_delivery_branch_ids is accepted and ignored (docs/PACKAGING-2026-10-24.md §4.2): delivery is
  -- in the plan at every branch. The request records addons = '{}' and delivery_branch_ids = '{}'.
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

  -- The plan's monthly price for the first branch and the extra branch's for every seat past the
  -- included ones: the same sum billing_compute makes once the request is applied.
  v_monthly := v_plan.monthly_price
             + greatest(v_seats - coalesce(v_plan.included_seats, 0), 0)
               * coalesce((select monthly_price from public.billing_products where code = 'extra_branch'), 0);

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

    v_priced := private.billing_price_one_time(p_restaurant_id, v_plan.code, v_seats, '{}'::uuid[]);

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

    -- D1. The merchant confirmed figures on screen, and a card on file is charged whatever is
    -- filed here. When they differ -- an operator edited the code, the catalog was repriced --
    -- nothing is filed and the merchant is shown the new figures to confirm. Null: not checked.
    if (p_expected_one_time is not null
        and round(p_expected_one_time, 2)
            is distinct from round(coalesce((v_quote ->> 'net_total')::numeric, 0), 2))
       or (p_expected_monthly is not null
           and round(p_expected_monthly, 2) is distinct from round(v_monthly, 2)) then
      raise exception using errcode = 'FNB02', message = 'quote_changed';
    end if;

    insert into public.billing_requests
      (restaurant_id, requested_by, plan_code, addons, branch_seats, monthly_total, note,
       delivery_branch_ids, one_time_total, discount_code, discount_amount)
    values
      (p_restaurant_id, auth.uid(), v_plan.code,
       '{}'::text[],
       v_seats, v_monthly, p_note,
       '{}'::uuid[],
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
  exception
    when sqlstate 'FNB01' then
      get stacked diagnostics v_reason = message_text;
    when sqlstate 'FNB02' then
      v_changed := true;
  end;

  -- Not a failed code check: nothing is counted against the guessing limit. v_quote is what the
  -- server priced inside the block (a local variable keeps its value when the block rolls back).
  if v_changed then
    return jsonb_build_object(
      'ok', false, 'reason', 'quote_changed', 'error', 'quote_changed',
      'one_time_total', coalesce((v_quote ->> 'net_total')::numeric, 0),
      'monthly_total', v_monthly,
      'discount_code', case when coalesce((v_quote ->> 'amount_off')::numeric, 0) > 0 then v_code end,
      'discount_amount', coalesce((v_quote ->> 'amount_off')::numeric, 0),
      'expected_one_time', p_expected_one_time,
      'expected_monthly', p_expected_monthly);
  end if;

  if v_reason is not null then
    perform private.billing_discount_note_failure(p_restaurant_id, v_reason);
    return jsonb_build_object('ok', false, 'reason', v_reason,
                              'error', 'discount_invalid:' || v_reason);
  end if;

  return to_jsonb(v_row) || jsonb_build_object('ok', true, 'request_id', v_row.id);
end $function$;

comment on function public.request_package_change(uuid, text, integer, uuid[], text, text, numeric, numeric) is
  'The owner (billing.manage) files a package change; the server prices it, replaces the restaurant''s pending request and reserves the code''s use. p_expected_one_time / p_expected_monthly (null = not checked) are the figures the merchant confirmed: when the server''s differ, nothing is filed and the answer is {ok:false, reason:quote_changed, one_time_total, monthly_total, discount_code, discount_amount}. A refused code answers {ok:false, reason, error:discount_invalid:<reason>}.';

revoke all on function public.request_package_change(uuid, text, integer, uuid[], text, text, numeric, numeric) from public, anon;
grant execute on function public.request_package_change(uuid, text, integer, uuid[], text, text, numeric, numeric) to authenticated, service_role;

-- The new signature and billing_cancel_expired_checkout, for PostgREST now rather than on its
-- next reload.
notify pgrst, 'reload schema';

commit;
