-- Dine-in table sessions: a table QR becomes a sitting, not a standing licence to order.
--
-- What exists today is a localStorage key. `table-pin.tsx` writes {id, number, label,
-- branchId, scannedAt} under one key with a four-hour client-side clock, and that is the
-- entire notion of "this phone is at table 7". Nothing server-side knows a table is
-- occupied, so two phones at one table are two unrelated strangers with two unrelated
-- bills; clearing site data or opening incognito starts a third; and settling the bill does
-- nothing at all to the code on the tent -- the only thing that ever ends a "session" is the
-- diner's own clock, on the diner's own device. Meanwhile place-order takes
-- `payload.table_id` verbatim: the FK proves the row exists, not that it belongs to the
-- branch being ordered from, and there is no session check because there is no session.
--
-- This makes the sitting a real row. A scan joins the ONE open session at that table, every
-- round is an order belonging to it, the bill is the sum of those rounds, and settling
-- closes it -- after which the QR is inert until staff seat the next party.
--
-- THE PARTIAL UNIQUE INDEX BELOW IS LOAD-BEARING. `table_sessions_one_open_per_table`
-- (unique on table_id where status <> 'closed') is the whole reason a second phone joins
-- the same bill instead of opening a rival one. Removing it, or allowing a second
-- non-closed row per table, silently reintroduces the bug this migration exists to fix.
--
-- Three parts, in one file:
--   1. the table setup the merchant asked for (a table TYPE, and a numeric sort order)
--   2. sessions, participants, the orders link, the consistency trigger, RLS and the RPCs
--   3. orders_public_insert / order_items_public_insert dropped, and the branch defaults


-- =====================================================================
-- PART 1 -- TABLE SETUP
-- =====================================================================

alter table public.tables add column if not exists table_type text not null default 'standard';
alter table public.tables drop constraint if exists tables_table_type_check;
alter table public.tables add constraint tables_table_type_check
  check (table_type in ('standard','booth','bar','high_top','private_room','outdoor','counter'));
comment on column public.tables.table_type is
  'What kind of table this is. `shape` stays the floor-plan glyph; this is what the floor calls it.';

alter table public.tables add column if not exists sort_order integer not null default 0;
comment on column public.tables.sort_order is
  'Display order. table_number is text, so ORDER BY table_number puts 10 before 2.';

-- Backfilled from the digits in the number, which is what a floor actually means by order.
update public.tables
   set sort_order = coalesce(nullif(regexp_replace(table_number, '\D', '', 'g'), '')::int, 0)
 where sort_order = 0;


-- =====================================================================
-- PART 2 -- THE SITTING
-- =====================================================================

create table if not exists public.table_sessions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  table_id  uuid not null references public.tables(id)   on delete cascade,
  status text not null default 'open',
  session_code text not null default lpad((floor(random() * 10000))::int::text, 4, '0'),
  party_size integer,
  opened_at timestamptz not null default now(),
  opened_via text not null default 'scan',
  opened_by_user  uuid references auth.users(id) on delete set null,
  opened_by_staff uuid references public.staff_members(id) on delete set null,
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '4 hours',
  bill_requested_at timestamptz,
  closed_at timestamptz,
  closed_reason text,
  closed_by_user  uuid references auth.users(id) on delete set null,
  closed_by_staff uuid references public.staff_members(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  constraint table_sessions_status_check check (status in ('open','locked','closed')),
  constraint table_sessions_via_check check (opened_via in ('scan','staff','counter')),
  constraint table_sessions_reason_check
    check (closed_reason is null
           or closed_reason in ('paid','abandoned','staff_closed','voided','merged')),
  constraint table_sessions_closed_shape check ((status = 'closed') = (closed_at is not null))
);
comment on table public.table_sessions is
  'One sitting at one table. Open = the QR can order; closed = it cannot until staff seat the next party.';
comment on column public.table_sessions.session_code is
  'Read off the floor board when seating. Only asked for when the branch turns require_join_code on, and never returned by the anon-callable resolver.';

-- The rule that makes a second phone join the SAME sitting: a rival one cannot exist.
create unique index if not exists table_sessions_one_open_per_table
  on public.table_sessions (table_id) where status <> 'closed';
create index if not exists table_sessions_branch_status_idx
  on public.table_sessions (branch_id, status, opened_at desc);
create index if not exists table_sessions_stale_idx
  on public.table_sessions (status, expires_at) where status <> 'closed';

create table if not exists public.table_session_participants (
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index if not exists tsp_user_idx on public.table_session_participants (user_id);
-- Deliberately no customer_id here. Joining must not mint a customers row -- the /orders
-- page already establishes that a passive page view must not create a customer, and
-- place-order creates one when an order is actually placed. "Is this order mine" is
-- answered by private.customer_ids_for_user() inside the bill function instead.

alter table public.orders add column if not exists session_id uuid
  references public.table_sessions(id) on delete set null;
alter table public.orders add column if not exists session_seq integer;
comment on column public.orders.session_seq is
  'Which round of the sitting this is. 1 = the first order at the table.';
create index if not exists orders_session_idx on public.orders (session_id, session_seq);


-- CONSISTENCY -----------------------------------------------------------------
create or replace function private.tg_orders_table_and_session()
returns trigger
language plpgsql security definer set search_path to 'public','pg_temp' as $function$
declare
  v_branch uuid;
  v_table  uuid;
  v_status text;
begin
  -- orders.table_id is client-supplied and its FK only proves the row exists. Without this,
  -- a token lifted from one restaurant's tent stamped an order at THIS branch with THAT
  -- branch's table, and the ticket was walked to a table that is not here.
  if new.table_id is not null
     and not exists (select 1 from public.tables t
                      where t.id = new.table_id and t.branch_id = new.branch_id) then
    raise exception 'table_not_in_branch' using errcode = 'P0001';
  end if;

  if new.session_id is null then
    return new;
  end if;

  select s.branch_id, s.table_id, s.status
    into v_branch, v_table, v_status
    from public.table_sessions s where s.id = new.session_id;
  if v_branch is null then
    raise exception 'session_not_found' using errcode = 'P0001';
  end if;
  if v_branch <> new.branch_id then
    raise exception 'session_branch_mismatch' using errcode = 'P0001';
  end if;
  if new.table_id is null then
    new.table_id := v_table;
  elsif new.table_id <> v_table then
    raise exception 'session_table_mismatch' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if v_status <> 'open' then
      raise exception 'table_session_closed' using errcode = 'P0001';
    end if;
    -- The round number is assigned here rather than by the caller, so two phones ordering
    -- at the same moment cannot both call themselves round 3.
    if new.session_seq is null then
      select coalesce(max(o.session_seq), 0) + 1 into new.session_seq
        from public.orders o where o.session_id = new.session_id;
    end if;
    update public.table_sessions set last_activity_at = now() where id = new.session_id;
  end if;

  return new;
end $function$;
revoke execute on function private.tg_orders_table_and_session() from public, anon, authenticated;

drop trigger if exists orders_table_and_session on public.orders;
create trigger orders_table_and_session
  before insert or update of table_id, session_id on public.orders
  for each row execute function private.tg_orders_table_and_session();


-- RLS -------------------------------------------------------------------------
alter table public.table_sessions enable row level security;
alter table public.table_session_participants enable row level security;

create or replace function private.table_session_ids_for_user()
returns setof uuid
language sql stable security definer set search_path to 'public','pg_temp' as $function$
  select p.session_id from public.table_session_participants p
   where p.user_id = (select auth.uid());
$function$;
comment on function private.table_session_ids_for_user() is
  'Every sitting the caller has joined. security definer for the same reason customer_ids_for_user is: a policy must not depend on another table keeping a self-select policy.';
revoke execute on function private.table_session_ids_for_user() from public, anon;
grant  execute on function private.table_session_ids_for_user() to authenticated;

drop policy if exists table_sessions_staff_read on public.table_sessions;
create policy table_sessions_staff_read on public.table_sessions
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));

drop policy if exists table_sessions_staff_update on public.table_sessions;
create policy table_sessions_staff_update on public.table_sessions
  for update to authenticated
  using (private.staff_has_capability(branch_id, 'counter.access'))
  with check (private.staff_has_capability(branch_id, 'counter.access'));

drop policy if exists table_sessions_diner_read on public.table_sessions;
create policy table_sessions_diner_read on public.table_sessions
  for select to authenticated
  using (id in (select private.table_session_ids_for_user()));

-- No INSERT and no DELETE policy anywhere, on purpose: a sitting is minted only by
-- open_table_session / join_table_session, which prove possession of the token or of the
-- capability first. A browser must never be able to seat itself at a table.

drop policy if exists tsp_self_read on public.table_session_participants;
create policy tsp_self_read on public.table_session_participants
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists tsp_staff_read on public.table_session_participants;
create policy tsp_staff_read on public.table_session_participants
  for select to authenticated
  using (session_id in (select s.id from public.table_sessions s
                         where s.branch_id in (select private.user_branch_ids())));


-- RESOLVER --------------------------------------------------------------------
-- The return signature changes, so this one has to be dropped rather than replaced.
drop function if exists public.resolve_table_qr(text);
create or replace function public.resolve_table_qr(p_token text)
returns table (
  branch_id          uuid,
  branch_slug        text,
  branch_name        text,
  restaurant_slug    text,
  table_id           uuid,
  table_number       text,
  display_name       text,
  session_id         uuid,
  session_status     text,
  accepting_orders   boolean,
  requires_join_code boolean,
  session_mode       text
)
language sql stable security definer set search_path to 'public','pg_temp' as $function$
  select b.id, b.slug, b.name, r.slug, t.id, t.table_number, t.display_name,
         s.id,
         coalesce(s.status, 'none'),
         coalesce(s.status = 'open', false),
         coalesce((b.settings->'dine_in'->>'require_join_code')::boolean, false),
         coalesce(b.settings->'dine_in'->>'session_mode', 'auto')
    from public.tables t
    join public.branches b    on b.id = t.branch_id
    join public.restaurants r on r.id = b.restaurant_id
    left join public.table_sessions s on s.table_id = t.id and s.status <> 'closed'
   where t.qr_code_token = p_token
     and t.is_active
     and b.is_active
   limit 1;
$function$;
-- session_code is deliberately NOT returned: this is the one function anon can call, and
-- the token on the tent is effectively public. It stays granted to anon because the
-- storefront has to resolve the code before anybody has signed in.
revoke execute on function public.resolve_table_qr(text) from public;
grant  execute on function public.resolve_table_qr(text) to anon, authenticated;


-- JOIN (the diner) ------------------------------------------------------------
create or replace function public.join_table_session(p_token text, p_code text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','pg_temp' as $function$
declare
  v_uid uuid := auth.uid();
  v_tid uuid;
  v_bid uuid;
  v_num text;
  v_disp text;
  v_active boolean;
  v_settings jsonb;
  v_mode text;
  v_need_code boolean;
  v_ttl int;
  s public.table_sessions%rowtype;
  v_member boolean;
begin
  -- The storefront's sign-in requirement is client-side javascript. This is the server one.
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;

  select t.id, t.branch_id, t.table_number, t.display_name
    into v_tid, v_bid, v_num, v_disp
    from public.tables t where t.qr_code_token = p_token and t.is_active;
  if v_tid is null then
    raise exception 'table_not_found' using errcode = 'P0001';
  end if;

  select b.is_active, coalesce(b.settings, '{}'::jsonb) into v_active, v_settings
    from public.branches b where b.id = v_bid;
  if not v_active then
    raise exception 'branch_inactive' using errcode = 'P0001';
  end if;

  v_mode      := coalesce(v_settings->'dine_in'->>'session_mode', 'auto');
  v_need_code := coalesce((v_settings->'dine_in'->>'require_join_code')::boolean, false);
  v_ttl       := greatest(30, least(1440, coalesce((v_settings->'dine_in'->>'ttl_min')::int, 240)));

  select * into s from public.table_sessions
   where table_id = v_tid and status <> 'closed' limit 1;

  if s.id is null then
    if v_mode <> 'auto' then
      raise exception 'table_not_seated' using errcode = 'P0001';
    end if;
    begin
      insert into public.table_sessions (branch_id, table_id, opened_via, opened_by_user, expires_at)
      values (v_bid, v_tid, 'scan', v_uid, now() + make_interval(mins => v_ttl))
      returning * into s;
    exception when unique_violation then
      -- Two phones scanned in the same instant. table_sessions_one_open_per_table is what
      -- guarantees they end up on ONE bill; the loser simply reads the winner's row.
      select * into s from public.table_sessions
       where table_id = v_tid and status <> 'closed' limit 1;
    end;
    update public.tables set status = 'occupied' where id = v_tid;
    insert into public.audit_logs (branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
    values (v_bid, v_uid, 'customer', 'table_session_opened', 'table_session', s.id,
            jsonb_build_object('table_id', v_tid, 'via', 'scan'));
  else
    v_member := exists (select 1 from public.table_session_participants p
                         where p.session_id = s.id and p.user_id = v_uid);
    if s.status = 'locked' and not v_member then
      raise exception 'table_session_locked' using errcode = 'P0001';
    end if;
    if v_need_code and not v_member and coalesce(p_code, '') <> s.session_code then
      raise exception 'join_code_required' using errcode = 'P0001';
    end if;
  end if;

  insert into public.table_session_participants (session_id, user_id, is_host)
  values (s.id, v_uid, s.opened_by_user is not distinct from v_uid)
  on conflict (session_id, user_id) do nothing;

  update public.table_sessions set last_activity_at = now() where id = s.id;

  return jsonb_build_object(
    'session_id', s.id,
    'status', s.status,
    'branch_id', v_bid,
    'table_id', v_tid,
    'table_number', v_num,
    'table_label', coalesce(nullif(btrim(v_disp), ''), 'Table ' || v_num),
    'opened_at', s.opened_at,
    'expires_at', s.expires_at,
    'session_code', s.session_code);
end $function$;
revoke execute on function public.join_table_session(text, text) from public, anon;
grant  execute on function public.join_table_session(text, text) to authenticated;


-- THE BILL --------------------------------------------------------------------
create or replace function public.get_table_session_bill(p_session_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public','pg_temp' as $function$
declare
  v_uid uuid := auth.uid();
  s public.table_sessions%rowtype;
  v_staff boolean;
  v_member boolean;
  v_rows jsonb;
  v_label text;
begin
  select * into s from public.table_sessions where id = p_session_id;
  if s.id is null then
    raise exception 'session_not_found' using errcode = 'P0001';
  end if;
  v_staff  := private.staff_has_capability(s.branch_id, 'counter.access')
           or private.staff_has_capability(s.branch_id, 'orders.view');
  v_member := exists (select 1 from public.table_session_participants p
                       where p.session_id = s.id and p.user_id = v_uid);
  if not (v_staff or v_member) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  select coalesce(nullif(btrim(t.display_name), ''), 'Table ' || t.table_number) into v_label
    from public.tables t where t.id = s.table_id;

  -- customer_phone is never projected, and customer_name only reaches staff: a table-mate
  -- is not entitled to the phone number of whoever else is sitting there.
  select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
             'order_id', o.id,
             'order_number', o.order_number,
             'round', o.session_seq,
             'status', o.status::text,
             'created_at', o.created_at,
             'subtotal', o.subtotal,
             'tax_amount', o.tax_amount,
             'service_fee', o.service_fee,
             'tip_amount', o.tip_amount,
             'discount_amount', o.discount_amount,
             'total', o.total,
             'mine', (o.customer_id in (select private.customer_ids_for_user())),
             'paid', exists (select 1 from public.payments p
                              where p.order_id = o.id and p.status = 'completed'),
             'items', coalesce((select jsonb_agg(jsonb_build_object(
                                         'name', oi.item_name,
                                         'quantity', oi.quantity,
                                         'unit_price', oi.unit_price,
                                         'subtotal', oi.subtotal,
                                         'notes', oi.notes) order by oi.created_at)
                                  from public.order_items oi where oi.order_id = o.id),
                               '[]'::jsonb))
           || case when v_staff then jsonb_build_object('customer_name', o.customer_name)
                   else '{}'::jsonb end as x
      from public.orders o
     where o.session_id = s.id and o.status not in ('cancelled', 'refunded')
  ) q;

  return jsonb_build_object(
    'session_id', s.id,
    'status', s.status,
    'table_id', s.table_id,
    'table_label', v_label,
    'opened_at', s.opened_at,
    'closed_at', s.closed_at,
    'closed_reason', s.closed_reason,
    'bill_requested_at', s.bill_requested_at,
    'party_size', s.party_size,
    'is_staff', v_staff,
    'orders', v_rows,
    'order_count', jsonb_array_length(v_rows),
    'running_total', coalesce((select sum(o.total) from public.orders o
                                where o.session_id = s.id
                                  and o.status not in ('cancelled', 'refunded')), 0),
    'outstanding', coalesce((select sum(o.total) from public.orders o
                              where o.session_id = s.id
                                and o.status not in ('cancelled', 'refunded')
                                and not exists (select 1 from public.payments p
                                                 where p.order_id = o.id
                                                   and p.status = 'completed')), 0),
    'session_code', case when v_staff or v_member then s.session_code else null end);
end $function$;
revoke execute on function public.get_table_session_bill(uuid) from public, anon;
grant  execute on function public.get_table_session_bill(uuid) to authenticated;


-- STAFF ACTIONS ---------------------------------------------------------------
create or replace function public.open_table_session(p_table_id uuid, p_party_size integer default null)
returns uuid
language plpgsql volatile security definer set search_path to 'public','pg_temp' as $function$
declare
  v_bid uuid;
  v_staff uuid;
  v_ttl int;
  v_id uuid;
begin
  select branch_id into v_bid from public.tables where id = p_table_id and is_active;
  if v_bid is null then
    raise exception 'table_not_found' using errcode = 'P0001';
  end if;
  if not private.staff_has_capability(v_bid, 'counter.access') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  select id into v_id from public.table_sessions
   where table_id = p_table_id and status <> 'closed' limit 1;
  if v_id is not null then
    -- Idempotent: seating a table that is already seated is a no-op, not a second bill.
    if p_party_size is not null then
      update public.table_sessions set party_size = p_party_size where id = v_id;
    end if;
    update public.tables set status = 'occupied' where id = p_table_id;
    return v_id;
  end if;

  -- The same lookup record_counter_payment uses: the *_by_staff columns reference
  -- staff_members(id), and the restaurant's owner or a platform admin has no staff row.
  select sm.id into v_staff from public.staff_members sm
    join public.branches b on b.restaurant_id = sm.restaurant_id
   where b.id = v_bid and sm.user_id = auth.uid() and sm.status = 'active'
   limit 1;

  select greatest(30, least(1440, coalesce((b.settings->'dine_in'->>'ttl_min')::int, 240)))
    into v_ttl from public.branches b where b.id = v_bid;

  insert into public.table_sessions
    (branch_id, table_id, opened_via, opened_by_user, opened_by_staff, party_size, expires_at)
  values
    (v_bid, p_table_id, 'staff', auth.uid(), v_staff, p_party_size,
     now() + make_interval(mins => coalesce(v_ttl, 240)))
  returning id into v_id;

  update public.tables set status = 'occupied' where id = p_table_id;
  insert into public.audit_logs (branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_bid, auth.uid(), 'staff', 'table_session_opened', 'table_session', v_id,
          jsonb_build_object('table_id', p_table_id, 'via', 'staff', 'party_size', p_party_size));
  return v_id;
end $function$;
revoke execute on function public.open_table_session(uuid, integer) from public, anon;
grant  execute on function public.open_table_session(uuid, integer) to authenticated;


create or replace function public.set_table_session_status(p_session_id uuid, p_status text)
returns void
language plpgsql volatile security definer set search_path to 'public','pg_temp' as $function$
declare
  s public.table_sessions%rowtype;
begin
  if p_status not in ('open', 'locked') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;
  select * into s from public.table_sessions where id = p_session_id;
  if s.id is null then
    raise exception 'session_not_found' using errcode = 'P0001';
  end if;
  if s.status = 'closed' then
    raise exception 'session_already_closed' using errcode = 'P0001';
  end if;

  -- A diner may lock the sitting ("we're ready for the bill"); only staff may unlock it
  -- again, or a table-mate could re-open a bill the party had just closed.
  if p_status = 'open' and not private.staff_has_capability(s.branch_id, 'counter.access') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if p_status = 'locked'
     and not private.staff_has_capability(s.branch_id, 'counter.access')
     and not exists (select 1 from public.table_session_participants p
                      where p.session_id = s.id and p.user_id = auth.uid()) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  update public.table_sessions
     set status = p_status,
         bill_requested_at = case when p_status = 'locked' then coalesce(bill_requested_at, now())
                                  else null end,
         last_activity_at = now()
   where id = p_session_id;
end $function$;
revoke execute on function public.set_table_session_status(uuid, text) from public, anon;
grant  execute on function public.set_table_session_status(uuid, text) to authenticated;


create or replace function public.settle_table_session(p_session_id uuid, p_tendered numeric default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','pg_temp' as $function$
declare
  s public.table_sessions%rowtype;
  v_staff uuid;
  o record;
  v_settled int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_total numeric := 0;
begin
  select * into s from public.table_sessions where id = p_session_id;
  if s.id is null then
    raise exception 'session_not_found' using errcode = 'P0001';
  end if;
  if not (private.staff_has_capability(s.branch_id, 'counter.access')
          or private.staff_has_capability(s.branch_id, 'payments.decide')) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if s.status = 'closed' then
    return jsonb_build_object('already_closed', true, 'session_id', s.id,
                              'orders_settled', 0, 'skipped', '[]'::jsonb, 'total', 0);
  end if;

  for o in select id, order_number, status from public.orders
            where session_id = s.id and status not in ('cancelled', 'refunded')
            order by session_seq loop
    begin
      -- Reuses the one function allowed to say money arrived: it re-reads orders.total,
      -- refuses a QR transfer (those settle against a photograph via decide_payment_proof),
      -- stamps the staff member and writes its own audit row -- per order, which is what a
      -- split bill needs. A refusal is collected rather than swallowed, so the floor board
      -- can say "that round still needs its slip approved" instead of claiming it is paid.
      perform public.record_counter_payment(o.id, null::numeric);
      v_settled := v_settled + 1;
      if o.status = 'ready' then
        update public.orders set status = 'completed' where id = o.id and status = 'ready';
      end if;
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('order_number', o.order_number, 'reason', sqlerrm);
    end;
  end loop;

  select coalesce(sum(total), 0) into v_total from public.orders
   where session_id = s.id and status not in ('cancelled', 'refunded');

  select sm.id into v_staff from public.staff_members sm
    join public.branches b on b.restaurant_id = sm.restaurant_id
   where b.id = s.branch_id and sm.user_id = auth.uid() and sm.status = 'active'
   limit 1;

  update public.table_sessions
     set status = 'closed', closed_at = now(), closed_reason = 'paid',
         closed_by_user = auth.uid(), closed_by_staff = coalesce(v_staff, closed_by_staff)
   where id = s.id;

  -- 'dirty', not 'open': the plates are still on it. The floor board's Clear action, or the
  -- next open_table_session, is what puts the table back into service.
  update public.tables set status = 'dirty' where id = s.table_id;

  insert into public.audit_logs (branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (s.branch_id, auth.uid(), 'staff', 'table_session_settled', 'table_session', s.id,
          jsonb_build_object('orders_settled', v_settled, 'skipped', v_skipped,
                             'total', v_total, 'tendered', p_tendered));

  return jsonb_build_object('session_id', s.id, 'orders_settled', v_settled,
                            'skipped', v_skipped, 'total', v_total);
end $function$;
revoke execute on function public.settle_table_session(uuid, numeric) from public, anon;
grant  execute on function public.settle_table_session(uuid, numeric) to authenticated;


create or replace function public.close_table_session(
  p_session_id uuid,
  p_reason text default 'staff_closed',
  p_note text default null
)
returns void
language plpgsql volatile security definer set search_path to 'public','pg_temp' as $function$
declare
  s public.table_sessions%rowtype;
  v_staff uuid;
  v_out numeric;
begin
  if p_reason not in ('staff_closed', 'voided', 'abandoned') then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;
  select * into s from public.table_sessions where id = p_session_id;
  if s.id is null then
    raise exception 'session_not_found' using errcode = 'P0001';
  end if;
  if s.status = 'closed' then
    return;
  end if;

  select coalesce(sum(o.total), 0) into v_out from public.orders o
   where o.session_id = s.id
     and o.status not in ('cancelled', 'refunded')
     and not exists (select 1 from public.payments p
                      where p.order_id = o.id and p.status = 'completed');

  -- Walking away from money is a manager's decision, not a cashier's.
  if v_out > 0 and not private.staff_has_capability(s.branch_id, 'payments.decide') then
    raise exception 'unpaid_needs_manager' using errcode = 'P0001';
  end if;
  if v_out = 0 and not private.staff_has_capability(s.branch_id, 'counter.access') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  select sm.id into v_staff from public.staff_members sm
    join public.branches b on b.restaurant_id = sm.restaurant_id
   where b.id = s.branch_id and sm.user_id = auth.uid() and sm.status = 'active'
   limit 1;

  update public.table_sessions
     set status = 'closed', closed_at = now(), closed_reason = p_reason,
         closed_by_user = auth.uid(), closed_by_staff = coalesce(v_staff, closed_by_staff),
         notes = coalesce(p_note, notes)
   where id = s.id;
  update public.tables set status = case when v_out > 0 then 'dirty' else 'open' end
   where id = s.table_id;

  insert into public.audit_logs (branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (s.branch_id, auth.uid(), 'staff', 'table_session_closed', 'table_session', s.id,
          jsonb_build_object('reason', p_reason, 'unpaid_total', v_out, 'note', p_note));
end $function$;
revoke execute on function public.close_table_session(uuid, text, text) from public, anon;
grant  execute on function public.close_table_session(uuid, text, text) to authenticated;


-- ABANDONMENT -----------------------------------------------------------------
create or replace function private.close_abandoned_table_sessions()
returns integer
language plpgsql volatile security definer set search_path to 'public','pg_temp' as $function$
declare
  v_closed int;
begin
  -- Someone scanned to read the menu and walked out. Nothing was ordered, so nothing is
  -- lost by closing it, and leaving it open holds that table's QR hostage all evening.
  with dead as (
    update public.table_sessions s
       set status = 'closed', closed_at = now(), closed_reason = 'abandoned'
     where s.status <> 'closed'
       and s.last_activity_at < now() - interval '60 minutes'
       and not exists (select 1 from public.orders o where o.session_id = s.id)
    returning s.table_id)
  select count(*) into v_closed from dead;

  update public.tables t set status = 'open'
   where t.status = 'occupied'
     and not exists (select 1 from public.table_sessions s
                      where s.table_id = t.id and s.status <> 'closed');

  -- A sitting that DID order is never auto-closed: that would write off real money with
  -- nobody looking. It is locked instead -- no new food goes out, the QR tells the diner to
  -- ask a member of staff, and the floor board flags it until someone settles or voids it.
  update public.table_sessions
     set status = 'locked', bill_requested_at = coalesce(bill_requested_at, now())
   where status = 'open'
     and expires_at < now()
     and exists (select 1 from public.orders o where o.session_id = table_sessions.id);

  return v_closed;
end $function$;
revoke execute on function private.close_abandoned_table_sessions() from public, anon, authenticated;

do $$ begin
  perform cron.unschedule('close-abandoned-table-sessions');
exception when others then null; end $$;
select cron.schedule('close-abandoned-table-sessions', '*/5 * * * *',
                     $$select private.close_abandoned_table_sessions()$$);


-- REALTIME --------------------------------------------------------------------
-- The floor board and the diner's phone both have to notice a settled bill without a
-- reload; orders is published already.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'table_sessions'
  ) then
    alter publication supabase_realtime add table public.table_sessions;
  end if;
end $$;


-- =====================================================================
-- PART 3 -- CLOSE THE DIRECT-INSERT HOLE, AND THE BRANCH DEFAULTS
-- =====================================================================

-- Two policies let anon INSERT an order and its lines straight over PostgREST with any
-- total, any table_id and now any session_id, bypassing place-order's pricing entirely:
--
--   create policy orders_public_insert on public.orders
--     for insert to anon, authenticated
--     with check (exists (select 1 from public.branches b
--                          where b.id = orders.branch_id and b.is_active)
--                 and status = 'pending');
--   create policy order_items_public_insert on public.order_items
--     for insert to anon, authenticated
--     with check (exists (select 1 from public.orders o
--                          where o.id = order_items.order_id and o.status = 'pending'));
--
-- (recorded verbatim so this part can be put back on its own if something unseen depended
-- on it.)
--
-- Nothing legitimate loses anything: place-order writes with the service role, which
-- bypasses RLS entirely, and a repo-wide grep finds no `.from('orders').insert` or
-- `.from('order_items').insert` in any app or package. And no session rule means anything
-- while a browser can write its own order row with any session_id it likes.
drop policy if exists orders_public_insert on public.orders;
drop policy if exists order_items_public_insert on public.order_items;

-- branches.settings.dine_in -- how this branch wants its tables to behave:
--   session_mode       'auto'  a scan opens the sitting (the Suki Teenoi behaviour)
--                      'staff' only a member of staff can seat a table
--   ttl_min            30..1440; how long an untouched sitting is believed
--   require_join_code  a second phone must type the 4-digit code staff read off the board
-- Backfilled for every branch so the resolver and the settings screen read an explicit
-- value rather than each re-deriving the same defaults.
update public.branches
   set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('dine_in',
         coalesce(settings->'dine_in', '{}'::jsonb) || jsonb_build_object(
           'session_mode',      coalesce(settings->'dine_in'->>'session_mode', 'auto'),
           'ttl_min',           coalesce((settings->'dine_in'->>'ttl_min')::int, 240),
           'require_join_code', coalesce((settings->'dine_in'->>'require_join_code')::boolean, false)));
