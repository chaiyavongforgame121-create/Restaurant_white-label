-- A cancelled delivery had no reason, no clean chat, and no place in the rider's history.
--
-- Three defects with one shape. public.deliveries carries a UNIQUE index on order_id, so one
-- order has exactly one delivery row for its whole life and every re-dispatch is an UPDATE of
-- that same row: driver_cancel_delivery, reject_dispatch, private.expire_dispatch_offers,
-- requeue_failed_delivery, staff_assign_driver and dispatch-driver all just move driver_id.
-- Because delivery_messages is keyed on delivery_id and is_delivery_participant() resolves
-- the rider through the CURRENT deliveries.driver_id, a replacement rider inherits the whole
-- previous conversation — and the rider who actually wrote it loses access to their own words.
-- On the live project, delivery 74dc33b7-5520-4ac9-ba24-74b7338ca442 (order A-2609-127534)
-- carries five messages from two different driver user ids: ba17072f… wrote "Crash" and "I
-- have to cancel" at 15:31 and cancelled; e2553fa0… took the job at 15:36, could read both,
-- and sent a photo into the same thread at 15:38. private.in_delivery_chat_folder has the
-- identical flaw, so the replacement rider could sign URLs for the old rider's photos too.
--
-- The same missing concept explains the other two defects. A rider's cancelled job leaves no
-- trace anywhere they can read (driver_earnings_ledger only gets a row on 'delivered', and
-- deliveries_driver_assigned stops matching the moment driver_id moves away), and a free-text
-- cancellation reason has nowhere durable to live: cancel_order wrote only status_history, a
-- pre-pickup driver cancel wrote only dispatch_history, and requeue_failed_delivery erased
-- failed_reason outright. Not one of those is read by a single line of application code.
--
-- delivery_assignments is one row per (delivery, rider) turn. It owns the chat thread, it
-- carries the reason the turn ended, and it is the rider's history record. It keeps driver_id
-- for ever, which is also what lets the rider's app hear that a job was taken away from them:
-- Realtime matches an UPDATE against the NEW row, so the deliveries filter the driver app
-- subscribes with (driver_id=eq.<rider>) never fired for the paths that clear driver_id.

-- 1. The table -----------------------------------------------------------------------------
create table if not exists public.delivery_assignments (
  id          uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries(id) on delete cascade,
  order_id    uuid not null references public.orders(id)     on delete cascade,
  branch_id   uuid not null references public.branches(id)   on delete cascade,
  driver_id   uuid not null references public.drivers(id),
  seq         integer not null,
  status      text not null default 'offered'
    check (status in ('offered','accepted','delivered','cancelled','failed','expired','rejected','reassigned')),
  offered_at  timestamptz not null default now(),
  accepted_at timestamptz,
  ended_at    timestamptz,
  end_kind    text check (end_kind in (
                'delivered','driver_cancelled','driver_cancelled_after_pickup','failed_at_door',
                'order_cancelled','offer_expired','rejected','reassigned_by_staff','requeued_by_staff')),
  end_reason  text,
  earnings    numeric,
  created_at  timestamptz not null default now(),
  unique (delivery_id, seq)
);

comment on table public.delivery_assignments is
  'One rider''s turn at one delivery. The chat thread, the cancellation reason and the rider''s '
  'job history all hang off this row rather than off deliveries, which is reused across every '
  're-dispatch and loses driver_id the moment a turn ends.';
comment on column public.delivery_assignments.end_reason is
  'Free text typed by whoever ended the turn — the rider''s "Other", the merchant''s note. Shown '
  'in the rider''s history, on the merchant''s Live deliveries board and on the customer''s page.';

-- 2. Message ownership ---------------------------------------------------------------------
alter table public.delivery_messages
  add column if not exists assignment_id uuid references public.delivery_assignments(id) on delete cascade;

comment on column public.delivery_messages.assignment_id is
  'The rider turn this message belongs to. delivery_id is kept for the staff audit view and for '
  'photos uploaded before the storage folder became the assignment id.';

-- 3. Backfill. Indexes come after, so a half-built history cannot trip the partial unique. ---
with offers as (
  select d.id as delivery_id, d.order_id, d.branch_id, d.status as delivery_status,
         d.accepted_at, d.delivered_at, d.failed_reason, d.driver_earnings,
         (e->>'driver_id')::uuid as driver_id,
         coalesce((e->>'at')::timestamptz, d.created_at) as offered_at,
         row_number() over (partition by d.id order by ord) as seq,
         lead(coalesce((e->>'at')::timestamptz, d.created_at)) over (partition by d.id order by ord) as next_at
    from public.deliveries d
    cross join lateral jsonb_array_elements(coalesce(d.dispatch_history, '[]'::jsonb))
                 with ordinality as t(e, ord)
   where e->>'type' = 'offered'
     and (e->>'driver_id') is not null
     and exists (select 1 from public.drivers dr where dr.id = (e->>'driver_id')::uuid)
)
insert into public.delivery_assignments
  (delivery_id, order_id, branch_id, driver_id, seq, status, offered_at, accepted_at, ended_at, end_kind, end_reason, earnings)
select o.delivery_id, o.order_id, o.branch_id, o.driver_id, o.seq,
       case when o.next_at is not null           then 'reassigned'
            when o.delivery_status = 'delivered' then 'delivered'
            when o.delivery_status = 'failed'    then 'failed'
            when o.delivery_status = 'cancelled' then 'cancelled'
            else 'accepted' end,
       o.offered_at,
       case when o.next_at is null then o.accepted_at end,
       case when o.next_at is not null then o.next_at
            when o.delivery_status in ('delivered','failed','cancelled')
              then coalesce(o.delivered_at, now()) end,
       case when o.next_at is not null           then 'reassigned_by_staff'
            when o.delivery_status = 'delivered' then 'delivered'
            when o.delivery_status = 'failed'    then 'failed_at_door'
            when o.delivery_status = 'cancelled' then 'order_cancelled' end,
       case when o.next_at is null and o.delivery_status in ('failed','cancelled')
              then o.failed_reason end,
       case when o.next_at is null then o.driver_earnings end
  from offers o
on conflict (delivery_id, seq) do nothing;

-- Rows that carry a rider but whose dispatch_history pre-dates the 'offered' stamp, or whose
-- history was trimmed to the last nine entries by expire_dispatch_offers.
insert into public.delivery_assignments
  (delivery_id, order_id, branch_id, driver_id, seq, status, offered_at, accepted_at, ended_at, end_kind, end_reason, earnings)
select d.id, d.order_id, d.branch_id, d.driver_id, 1,
       case d.status when 'delivered' then 'delivered' when 'failed' then 'failed'
                     when 'cancelled' then 'cancelled' else 'accepted' end,
       coalesce(d.assigned_at, d.created_at), d.accepted_at,
       case when d.status in ('delivered','failed','cancelled') then coalesce(d.delivered_at, now()) end,
       case d.status when 'delivered' then 'delivered' when 'failed' then 'failed_at_door'
                     when 'cancelled' then 'order_cancelled' end,
       case when d.status in ('failed','cancelled') then d.failed_reason end,
       d.driver_earnings
  from public.deliveries d
 where d.driver_id is not null
   and not exists (select 1 from public.delivery_assignments a where a.delivery_id = d.id)
on conflict (delivery_id, seq) do nothing;

-- A delivery that has messages but neither a rider nor a usable history would leave those
-- messages with no thread — and the SELECT policy below makes an unowned message invisible to
-- everyone, which is worse than the leak it replaces. Recover the rider from who wrote them.
insert into public.delivery_assignments
  (delivery_id, order_id, branch_id, driver_id, seq, status, offered_at, ended_at, end_kind)
select d.id, d.order_id, d.branch_id, dr.id, 1, 'reassigned',
       coalesce(d.assigned_at, d.created_at), now(), 'reassigned_by_staff'
  from public.deliveries d
  join lateral (
    select m.sender_user_id
      from public.delivery_messages m
     where m.delivery_id = d.id and m.sender_role = 'driver'
     order by m.created_at
     limit 1
  ) first_msg on true
  join public.drivers dr on dr.user_id = first_msg.sender_user_id
 where not exists (select 1 from public.delivery_assignments a where a.delivery_id = d.id)
on conflict (delivery_id, seq) do nothing;

-- A turn whose rider is not the one holding the delivery now is over, whatever the history
-- said. Both of these run before delivery_assignments_one_live exists for a reason: the
-- partial unique index would otherwise reject the backfill it is meant to protect.
update public.delivery_assignments a
   set ended_at  = coalesce(a.ended_at, now()),
       end_kind  = coalesce(a.end_kind, 'reassigned_by_staff'),
       status    = case when a.status in ('offered','accepted') then 'reassigned' else a.status end
  from public.deliveries d
 where d.id = a.delivery_id
   and a.ended_at is null
   and d.driver_id is distinct from a.driver_id;

update public.delivery_assignments a
   set ended_at  = coalesce(a.ended_at, now()),
       end_kind  = coalesce(a.end_kind, 'reassigned_by_staff'),
       status    = case when a.status in ('offered','accepted') then 'reassigned' else a.status end
 where a.ended_at is null
   and exists (select 1 from public.delivery_assignments b
                where b.delivery_id = a.delivery_id and b.ended_at is null and b.seq > a.seq);

-- Each existing message joins the turn whose window contains it. This is what actually splits
-- A-2609-127534: 15:31 goes to seq 1, 15:38 and 15:41 go to seq 2.
update public.delivery_messages m
   set assignment_id = a.id
  from public.delivery_assignments a
 where m.assignment_id is null
   and a.delivery_id = m.delivery_id
   and m.created_at >= a.offered_at
   and (a.ended_at is null or m.created_at < a.ended_at);

update public.delivery_messages m
   set assignment_id = a.id
  from public.delivery_assignments a
 where m.assignment_id is null and a.delivery_id = m.delivery_id and a.seq = 1;

-- 4. Indexes --------------------------------------------------------------------------------
create unique index if not exists delivery_assignments_one_live
  on public.delivery_assignments (delivery_id) where ended_at is null;
create index if not exists delivery_assignments_driver_idx
  on public.delivery_assignments (driver_id, offered_at desc);
create index if not exists delivery_assignments_branch_idx
  on public.delivery_assignments (branch_id, offered_at desc);
create index if not exists delivery_messages_assignment_idx
  on public.delivery_messages (assignment_id, created_at);

-- 5. RLS. Only security definer code writes, so there is no insert/update/delete policy. -----
alter table public.delivery_assignments enable row level security;

drop policy if exists delivery_assignments_driver_read on public.delivery_assignments;
create policy delivery_assignments_driver_read on public.delivery_assignments
  for select to authenticated
  using (driver_id = private.driver_id_for_user());

drop policy if exists delivery_assignments_customer_read on public.delivery_assignments;
create policy delivery_assignments_customer_read on public.delivery_assignments
  for select to authenticated
  using (order_id in (select private.order_ids_for_customer()));

drop policy if exists delivery_assignments_staff_read on public.delivery_assignments;
create policy delivery_assignments_staff_read on public.delivery_assignments
  for select to authenticated
  using (private.staff_has_capability(branch_id, 'delivery.manage'));

-- The rider app subscribes to this table so a job pulled out from under them reaches the
-- phone. Guarded because re-running an unconditional ALTER PUBLICATION raises.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename = 'delivery_assignments'
  ) then
    alter publication supabase_realtime add table public.delivery_assignments;
  end if;
end $$;

-- 6. Lifecycle. Every driver_id move is caught here, so dispatch-driver needs no redeploy. ---
create or replace function public.deliveries_sync_assignments()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_seq int;
begin
  if new.driver_id is distinct from old.driver_id then
    -- The RPCs below stamp end_kind/end_reason BEFORE they move driver_id, so coalesce keeps
    -- whatever a human actually said; this branch only catches the paths that say nothing
    -- (a dispatch-driver reset, a bare reassign). Closing every other open turn on the
    -- delivery — not just old.driver_id's — is what keeps delivery_assignments_one_live safe.
    update public.delivery_assignments
       set ended_at = coalesce(ended_at, now()),
           status   = case when status in ('offered','accepted') then 'reassigned' else status end,
           end_kind = coalesce(end_kind, 'reassigned_by_staff')
     where delivery_id = new.id
       and ended_at is null
       and driver_id is distinct from new.driver_id;

    if new.driver_id is not null
       and not exists (
         select 1 from public.delivery_assignments
          where delivery_id = new.id and driver_id = new.driver_id and ended_at is null
       ) then
      select coalesce(max(seq), 0) + 1 into v_seq
        from public.delivery_assignments where delivery_id = new.id;
      insert into public.delivery_assignments
        (delivery_id, order_id, branch_id, driver_id, seq, status, offered_at, earnings)
      values (new.id, new.order_id, new.branch_id, new.driver_id, v_seq, 'offered', now(), new.driver_earnings);
    end if;
  end if;

  if new.accepted_at is not null and old.accepted_at is null and new.driver_id is not null then
    update public.delivery_assignments
       set accepted_at = new.accepted_at, status = 'accepted'
     where delivery_id = new.id and driver_id = new.driver_id and ended_at is null;
  end if;

  if new.status is distinct from old.status and new.status in ('delivered','failed','cancelled') then
    update public.delivery_assignments
       set ended_at   = coalesce(ended_at, now()),
           status     = new.status::text,
           end_kind   = coalesce(end_kind, case new.status
                                             when 'delivered' then 'delivered'
                                             when 'failed'    then 'failed_at_door'
                                             else 'order_cancelled' end),
           end_reason = coalesce(end_reason, new.failed_reason),
           earnings   = coalesce(earnings, new.driver_earnings)
     where delivery_id = new.id and ended_at is null;
  end if;

  return new;
end;
$function$;

revoke execute on function public.deliveries_sync_assignments() from public, anon, authenticated;

drop trigger if exists deliveries_sync_assignments on public.deliveries;
create trigger deliveries_sync_assignments
  after update on public.deliveries
  for each row execute function public.deliveries_sync_assignments();

-- 7. Every message gets a thread, even from a cached client that does not send one. ----------
-- An installed PWA still serving the previous bundle inserts delivery_id alone; without this
-- its message would be written with a null assignment_id and become invisible to both parties.
create or replace function public.delivery_messages_set_assignment()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.assignment_id is null then
    select a.id into new.assignment_id
      from public.delivery_assignments a
     where a.delivery_id = new.delivery_id and a.ended_at is null
     order by a.seq desc
     limit 1;
  end if;
  if new.assignment_id is null then
    raise exception 'no_live_assignment' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

revoke execute on function public.delivery_messages_set_assignment() from public, anon, authenticated;

drop trigger if exists delivery_messages_set_assignment on public.delivery_messages;
create trigger delivery_messages_set_assignment
  before insert on public.delivery_messages
  for each row execute function public.delivery_messages_set_assignment();

-- 8. Chat access is a property of the TURN, not of the delivery. -----------------------------
create or replace function public.can_read_thread(p_assignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1
      from public.delivery_assignments a
      left join public.drivers   dr on dr.id = a.driver_id
      left join public.orders    o  on o.id  = a.order_id
      left join public.customers c  on c.id  = o.customer_id
     where a.id = p_assignment_id
       and (dr.user_id = auth.uid()
            or c.user_id = auth.uid()
            or private.staff_has_capability(a.branch_id, 'delivery.manage'))
  );
$function$;

revoke execute on function public.can_read_thread(uuid) from public, anon;
grant  execute on function public.can_read_thread(uuid) to authenticated;

-- is_delivery_participant() is left in place: other policies still call it, and it is correct
-- for anything genuinely scoped to the delivery. It is simply the wrong question to ask of a
-- message, which belongs to one turn and not to the row that outlives every rider.
drop policy if exists delivery_messages_select on public.delivery_messages;
create policy delivery_messages_select on public.delivery_messages
  for select to authenticated
  using (assignment_id is not null and public.can_read_thread(assignment_id));

-- WITH CHECK is evaluated on the final tuple, i.e. after the BEFORE trigger above has resolved
-- assignment_id, so a client that sends only delivery_id still passes.
drop policy if exists delivery_messages_insert on public.delivery_messages;
create policy delivery_messages_insert on public.delivery_messages
  for insert to authenticated
  with check (
    sender_user_id = auth.uid()
    and exists (
      select 1
        from public.delivery_assignments a
        join public.deliveries d on d.id = a.delivery_id
        left join public.drivers   dr on dr.id = a.driver_id
        left join public.orders    o  on o.id  = a.order_id
        left join public.customers c  on c.id  = o.customer_id
       where a.id = delivery_messages.assignment_id
         and a.delivery_id = delivery_messages.delivery_id
         and a.ended_at is null
         and d.status in ('assigned','picked_up','in_transit')
         and (   (delivery_messages.sender_role = 'driver'   and dr.user_id = auth.uid())
              or (delivery_messages.sender_role = 'customer' and c.user_id = auth.uid()))
    )
  );

create or replace function public.mark_thread_read(p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  if not public.can_read_thread(p_assignment_id) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  update public.delivery_messages
     set read_at = now()
   where assignment_id = p_assignment_id
     and read_at is null
     and sender_user_id <> auth.uid();
end;
$function$;

revoke execute on function public.mark_thread_read(uuid) from public, anon;
grant  execute on function public.mark_thread_read(uuid) to authenticated;

-- Kept, and narrowed to the live turn, so an installed PWA on the previous bundle does not
-- start erroring mid-delivery — and does not mark the previous rider's messages read either.
create or replace function public.mark_messages_read(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_assignment uuid;
begin
  select a.id into v_assignment
    from public.delivery_assignments a
   where a.delivery_id = p_delivery_id and a.ended_at is null
   order by a.seq desc
   limit 1;
  if v_assignment is null then return; end if;
  perform public.mark_thread_read(v_assignment);
end;
$function$;

revoke execute on function public.mark_messages_read(uuid) from public, anon;
grant  execute on function public.mark_messages_read(uuid) to authenticated;

-- A push must reach the party the thread belongs to, not whoever holds the job right now.
create or replace function public.tg_delivery_message_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v record;
  v_recipient_type text;
  v_recipient_id uuid;
begin
  select a.branch_id, a.order_id, a.driver_id, o.order_number, o.customer_id
    into v
    from public.delivery_assignments a
    join public.orders o on o.id = a.order_id
   where a.id = new.assignment_id;
  if not found then return new; end if;

  if new.sender_role = 'customer' then
    v_recipient_type := 'driver';
    v_recipient_id := v.driver_id;
  else
    v_recipient_type := 'customer';
    v_recipient_id := v.customer_id;
  end if;
  if v_recipient_id is null then return new; end if;

  if exists (
    select 1 from public.notifications_outbox
     where template = 'new_message'
       and status = 'pending'
       and recipient_id = v_recipient_id
       and (variables->>'assignment_id') = new.assignment_id::text
  ) then
    return new;
  end if;

  insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
  values (v.branch_id, v_recipient_type, v_recipient_id, 'push', 'new_message',
          jsonb_build_object(
            'assignment_id', new.assignment_id,
            'delivery_id', new.delivery_id,
            'order_id', v.order_id,
            'order_number', v.order_number,
            'sender', new.sender_role,
            'preview', left(new.body, 80)
          ));
  return new;
end;
$function$;

revoke execute on function public.tg_delivery_message_notify() from public, anon, authenticated;

-- 9. Photos. New uploads land under <assignment_id>/; objects already stored under
-- <delivery_id>/ stay readable through the message row that points at them, which is now
-- thread-scoped — so the replacement rider loses the old rider's photos with the old words.
create or replace function private.in_delivery_chat_folder(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1
      from public.delivery_messages m
      join public.delivery_assignments a on a.id = m.assignment_id
      left join public.orders    o  on o.id  = a.order_id
      left join public.customers c  on c.id  = o.customer_id
      left join public.drivers   dr on dr.id = a.driver_id
     where m.attachment_path = p_name
       and (c.user_id = auth.uid() or dr.user_id = auth.uid())
  )
  or exists (
    -- The upload happens before the message row exists, so it is authorised by the caller
    -- holding the LIVE assignment whose id is the folder. The join keeps a junk first segment
    -- evaluating to false instead of raising 22P02 from inside a storage policy.
    select 1
      from public.delivery_assignments a
      left join public.orders    o  on o.id  = a.order_id
      left join public.customers c  on c.id  = o.customer_id
      left join public.drivers   dr on dr.id = a.driver_id
     where a.id::text = (storage.foldername(p_name))[1]
       and a.ended_at is null
       and (c.user_id = auth.uid() or dr.user_id = auth.uid())
  );
$function$;

revoke execute on function private.in_delivery_chat_folder(text) from public, anon;
grant  execute on function private.in_delivery_chat_folder(text) to authenticated;

-- 10. Cancellation reasons get somewhere to live and someone to read them. -------------------
-- Everything outside the assignment stamp and the reason trimming is byte-for-byte the body
-- this replaces.
create or replace function public.driver_cancel_delivery(p_delivery_id uuid, p_reason text default 'driver_cancelled')
returns void
language plpgsql
security definer
set search_path to 'public', 'net', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_driver_id uuid;
  d record;
  v_url text;
  v_key text;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select id into v_driver_id from public.drivers where user_id = v_user;
  if v_driver_id is null then raise exception 'driver_not_found'; end if;

  select * into d from public.deliveries
  where id = p_delivery_id and driver_id = v_driver_id
  for update;
  if not found then raise exception 'forbidden'; end if;

  -- Cancelling any leg dissolves the pair: the other leg continues as a solo job
  -- and this one re-dispatches as a solo job.
  if d.batch_id is not null then
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = d.batch_id;
  end if;

  if d.status = 'assigned' then
    -- Stamped BEFORE driver_id moves, so the trigger's coalesce keeps what the rider typed
    -- rather than overwriting it with the generic 'reassigned_by_staff'.
    update public.delivery_assignments
       set ended_at = now(), status = 'cancelled',
           end_kind = 'driver_cancelled', end_reason = v_reason
     where delivery_id = p_delivery_id and driver_id = v_driver_id and ended_at is null;

    update public.deliveries
    set driver_id = null,
        status = 'dispatching',
        offered_at = null,
        offer_expires_at = null,
        accepted_at = null,
        dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
          || jsonb_build_object('type','driver_cancelled','driver_id', v_driver_id, 'reason', v_reason, 'at', now())
    where id = p_delivery_id;

    update public.drivers
    set cooldown_until = now() + interval '10 minutes',
        reject_streak = reject_streak + 1
    where id = v_driver_id;

    v_url := private.get_setting('supabase_url');
    v_key := private.get_setting('service_role_key');
    if v_url is not null and v_key is not null then
      perform net.http_post(
        url := v_url || '/functions/v1/dispatch-driver',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
        body := jsonb_build_object('delivery_id', p_delivery_id),
        timeout_milliseconds := 5000
      );
    end if;
  elsif d.status in ('picked_up','in_transit') then
    update public.delivery_assignments
       set ended_at = now(), status = 'failed',
           end_kind = 'driver_cancelled_after_pickup', end_reason = v_reason
     where delivery_id = p_delivery_id and driver_id = v_driver_id and ended_at is null;

    update public.deliveries
    set status = 'failed',
        failed_reason = v_reason,
        dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
          || jsonb_build_object('type','driver_cancelled_after_pickup','driver_id', v_driver_id, 'reason', v_reason, 'at', now())
    where id = p_delivery_id;

    insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
    values (d.branch_id, 'staff', d.branch_id, 'in_app', 'delivery_returned',
            jsonb_build_object('delivery_id', d.id, 'order_id', d.order_id, 'reason', v_reason));
  else
    raise exception 'not_cancellable';
  end if;
end;
$function$;

revoke execute on function public.driver_cancel_delivery(uuid, text) from public, anon;
grant  execute on function public.driver_cancel_delivery(uuid, text) to authenticated;

create or replace function public.fail_delivery(p_delivery_id uuid, p_reason text, p_photo_url text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_driver_id uuid;
  d record;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select id into v_driver_id from public.drivers where user_id = v_user;
  if v_driver_id is null then raise exception 'driver_not_found'; end if;

  select * into d from public.deliveries
  where id = p_delivery_id and driver_id = v_driver_id
  for update;
  if not found then raise exception 'forbidden'; end if;
  if d.status not in ('picked_up','in_transit') then raise exception 'not_failable'; end if;

  update public.delivery_assignments
     set ended_at = now(), status = 'failed',
         end_kind = 'failed_at_door', end_reason = v_reason
   where delivery_id = p_delivery_id and driver_id = v_driver_id and ended_at is null;

  update public.deliveries
  set status = 'failed',
      failed_reason = v_reason,
      failed_photo_url = p_photo_url,
      dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
        || jsonb_build_object('type','failed_at_door','driver_id', v_driver_id, 'reason', v_reason, 'at', now())
  where id = p_delivery_id;

  insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
  values (d.branch_id, 'staff', d.branch_id, 'in_app', 'delivery_failed_at_door',
          jsonb_build_object('delivery_id', d.id, 'order_id', d.order_id, 'reason', v_reason, 'photo_url', p_photo_url));
end;
$function$;

revoke execute on function public.fail_delivery(uuid, text, text) from public, anon;
grant  execute on function public.fail_delivery(uuid, text, text) to authenticated;

-- requeue_failed_delivery still clears failed_reason — the job is being retried and the board
-- must stop calling it failed — but the reason now survives on the turn that ended instead of
-- being erased outright, which is what made a re-dispatched job unexplainable afterwards.
create or replace function public.requeue_failed_delivery(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'net', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  d record;
  v_url text;
  v_key text;
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then raise exception 'not_found'; end if;

  perform 1 from public.staff_members sm
  where sm.user_id = v_user
    and sm.branch_id = d.branch_id
    and sm.status = 'active';
  if not found then raise exception 'forbidden'; end if;
  if d.status <> 'failed' then raise exception 'not_failed'; end if;

  -- A requeued job restarts solo; any old pairing is dissolved.
  if d.batch_id is not null then
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = d.batch_id;
  end if;

  update public.delivery_assignments
     set ended_at   = coalesce(ended_at, now()),
         status     = 'failed',
         end_kind   = coalesce(end_kind, 'requeued_by_staff'),
         end_reason = coalesce(end_reason, d.failed_reason)
   where delivery_id = p_delivery_id and ended_at is null;

  update public.deliveries
  set status = 'dispatching',
      driver_id = null,
      accepted_at = null,
      offered_at = null,
      offer_expires_at = null,
      failed_reason = null,
      failed_photo_url = null,
      dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
        || jsonb_build_object('type','requeued_by_staff','at', now())
  where id = p_delivery_id;

  v_url := private.get_setting('supabase_url');
  v_key := private.get_setting('service_role_key');
  if v_url is not null and v_key is not null then
    perform net.http_post(
      url := v_url || '/functions/v1/dispatch-driver',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := jsonb_build_object('delivery_id', p_delivery_id),
      timeout_milliseconds := 5000
    );
  end if;
end;
$function$;

revoke execute on function public.requeue_failed_delivery(uuid) from public, anon;
grant  execute on function public.requeue_failed_delivery(uuid) to authenticated;

-- A rider's history has to tell "you declined" from "it lapsed", so the two paths that clear
-- driver_id without anybody typing anything stamp their own end_kind first.
create or replace function public.reject_dispatch(p_delivery_id uuid, p_reason text default 'declined')
returns void
language plpgsql
security definer
set search_path to 'public', 'net', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_driver_id uuid;
  v_row record;
  r record;
  v_redispatch_id uuid;
  v_url text; v_key text;
begin
  if v_user_id is null then raise exception 'auth_required'; end if;
  select id into v_driver_id from public.drivers where user_id = v_user_id;
  if v_driver_id is null then raise exception 'driver_not_found'; end if;

  select * into v_row from public.deliveries
  where id = p_delivery_id and driver_id = v_driver_id
  for update;
  if not found then raise exception 'forbidden'; end if;
  if v_row.accepted_at is not null then return; end if;

  if v_row.batch_id is null then
    update public.delivery_assignments
       set ended_at = now(), status = 'rejected', end_kind = 'rejected', end_reason = p_reason
     where delivery_id = p_delivery_id and driver_id = v_driver_id and ended_at is null;

    update public.deliveries
    set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
        dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
          || jsonb_build_object('type','rejected','at',now(),'reason',p_reason,'driver_id',v_driver_id)
    where id = p_delivery_id;
    v_redispatch_id := p_delivery_id;
    perform private.record_driver_penalty(v_driver_id, 'reject', p_delivery_id);
  else
    for r in
      select id, batch_seq from public.deliveries
      where batch_id = v_row.batch_id and driver_id = v_driver_id and accepted_at is null
      order by id
      for update
    loop
      update public.delivery_assignments
         set ended_at = now(), status = 'rejected', end_kind = 'rejected', end_reason = p_reason
       where delivery_id = r.id and driver_id = v_driver_id and ended_at is null;

      update public.deliveries
      set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
          dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
            || jsonb_build_object('type','rejected','at',now(),'reason',p_reason,'driver_id',v_driver_id,'batch',true)
      where id = r.id;
      if r.batch_seq = 1 then v_redispatch_id := r.id; end if;
    end loop;
    v_redispatch_id := coalesce(v_redispatch_id, p_delivery_id);
    -- Explicit DECLINE of a stacked offer: penalty-free (bigger ask; Deliveroo model).
    -- TIMEOUT (client countdown lapsed): counts once — ignoring an offer strands
    -- customers regardless of batch-ness, matching the server sweep.
    if p_reason = 'timeout' then
      perform private.record_driver_penalty(v_driver_id, 'timeout', p_delivery_id);
    end if;
  end if;

  v_url := private.get_setting('supabase_url');
  v_key := private.get_setting('service_role_key');
  if v_url is not null and v_key is not null then
    perform net.http_post(
      url := v_url || '/functions/v1/dispatch-driver',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := jsonb_build_object('delivery_id', v_redispatch_id),
      timeout_milliseconds := 5000);
  end if;
end;
$function$;

revoke execute on function public.reject_dispatch(uuid, text) from public, anon;
grant  execute on function public.reject_dispatch(uuid, text) to authenticated;

-- The assignment UPDATE sits INSIDE the per-row loop on purpose: pg_cron runs this, the loop
-- already holds `for update skip locked` on each row, and hoisting it out would close turns
-- for offers this pass deliberately skipped.
create or replace function private.expire_dispatch_offers()
returns void
language plpgsql
security definer
set search_path to 'public', 'net', 'private', 'pg_temp'
as $function$
declare
  r record;
  b record;
  v_url text; v_key text;
  v_redispatch_id uuid;
begin
  v_url := private.get_setting('supabase_url');
  v_key := private.get_setting('service_role_key');

  for r in
    select d.id, d.driver_id, d.order_id, d.branch_id, d.batch_id
    from public.deliveries d
    where d.status = 'assigned' and d.accepted_at is null
      and d.offer_expires_at is not null and d.offer_expires_at < now()
    for update skip locked
  loop
    -- A batch-mate processed earlier in this loop may have released this row already.
    perform 1 from public.deliveries where id = r.id and status = 'assigned' and accepted_at is null;
    if not found then continue; end if;

    if r.batch_id is null then
      update public.delivery_assignments
         set ended_at = now(), status = 'expired', end_kind = 'offer_expired'
       where delivery_id = r.id and driver_id = r.driver_id and ended_at is null;

      update public.deliveries
      set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
          dispatch_history =
            coalesce((
              select jsonb_agg(elem order by ord)
              from (
                select elem, ord
                from jsonb_array_elements(coalesce(dispatch_history, '[]'::jsonb)) with ordinality as t(elem, ord)
                order by ord desc limit 9
              ) tail
            ), '[]'::jsonb)
            || jsonb_build_object('type','offer_expired','driver_id', r.driver_id, 'at', now())
      where id = r.id;
      v_redispatch_id := r.id;
    else
      v_redispatch_id := null;
      for b in
        select id, batch_seq from public.deliveries
        where batch_id = r.batch_id and driver_id = r.driver_id and accepted_at is null
        order by id
      loop
        update public.delivery_assignments
           set ended_at = now(), status = 'expired', end_kind = 'offer_expired'
         where delivery_id = b.id and driver_id = r.driver_id and ended_at is null;

        update public.deliveries
        set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
            dispatch_history =
              coalesce((
                select jsonb_agg(elem order by ord)
                from (
                  select elem, ord
                  from jsonb_array_elements(coalesce(dispatch_history, '[]'::jsonb)) with ordinality as t(elem, ord)
                  order by ord desc limit 9
                ) tail
              ), '[]'::jsonb)
              || jsonb_build_object('type','offer_expired','driver_id', r.driver_id, 'at', now(), 'batch', true)
        where id = b.id;
        if b.batch_seq = 1 then v_redispatch_id := b.id; end if;
      end loop;
      v_redispatch_id := coalesce(v_redispatch_id, r.id);
    end if;

    if r.driver_id is not null then
      perform private.record_driver_penalty(r.driver_id, 'timeout', r.id);
    end if;

    if v_url is not null and v_key is not null then
      perform net.http_post(
        url := v_url || '/functions/v1/dispatch-driver',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
        body := jsonb_build_object('delivery_id', v_redispatch_id, 'order_id', r.order_id),
        timeout_milliseconds := 5000);
    end if;
  end loop;
end;
$function$;

revoke execute on function private.expire_dispatch_offers() from public, anon, authenticated;

-- cancel_order finally writes the column the customer's tracking page has always read. Until
-- now orders.cancellation_reason was written by exactly one function — decide_payment_proof —
-- so every staff, kitchen and customer cancellation showed the generic fallback sentence.
create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_customer_id uuid;
  v_order public.orders%rowtype;
  v_is_staff boolean;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found'; end if;
  select id into v_customer_id from public.customers where user_id = v_uid;
  v_is_staff := exists (
    select 1 from public.staff_members
     where user_id = v_uid and branch_id = v_order.branch_id and role in ('owner','admin','manager','cashier','kitchen')
  );
  if not v_is_staff and (v_customer_id is null or v_order.customer_id <> v_customer_id) then
    raise exception 'not_authorized';
  end if;
  if v_order.status in ('completed','cancelled','refunded') then
    raise exception 'cannot_cancel_status:%', v_order.status;
  end if;
  if not v_is_staff and v_order.status not in ('pending','confirmed') then
    raise exception 'too_late_for_customer_cancel';
  end if;

  update public.orders
     set status = 'cancelled',
         cancellation_reason = coalesce(v_reason, cancellation_reason),
         status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object(
           'status', 'cancelled', 'at', now(), 'by', case when v_is_staff then 'staff' else 'customer' end,
           'reason', v_reason
         )
   where id = p_order_id;

  update public.menu_items mi
     set stock_quantity = stock_quantity + oi.quantity
    from public.order_items oi
   where oi.order_id = p_order_id
     and oi.menu_item_id = mi.id
     and mi.track_stock = true;

  return jsonb_build_object('ok', true, 'order_id', p_order_id);
end $function$;

revoke execute on function public.cancel_order(uuid, text) from public, anon;
grant  execute on function public.cancel_order(uuid, text) to authenticated;

-- refund_order had the same gap: it wrote its reason into status_history and audit_logs, so a
-- fully-refunded order reached the diner's page with nothing on it at all. Everything else is
-- byte-for-byte the body this replaces.
create or replace function public.refund_order(p_order_id uuid, p_amount numeric, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found'; end if;
  if not exists (
    select 1 from public.staff_members
     where user_id = v_uid and branch_id = v_order.branch_id and role in ('owner','admin','manager')
  ) then raise exception 'not_authorized'; end if;
  if p_amount <= 0 or p_amount > v_order.total then
    raise exception 'invalid_refund_amount';
  end if;
  -- Mark order; actual Omise refund call happens in refund-payment edge function
  update public.orders
     set status = case when p_amount >= v_order.total then 'refunded' else status end,
         cancellation_reason = case when p_amount >= v_order.total
                                    then coalesce(v_reason, cancellation_reason)
                                    else cancellation_reason end,
         status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object(
           'status', 'refund', 'at', now(), 'by', v_uid, 'amount', p_amount, 'reason', v_reason
         )
   where id = p_order_id;
  insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  select b.restaurant_id, v_order.branch_id, v_uid, 'staff', 'refund', 'order', p_order_id,
         jsonb_build_object('amount', p_amount, 'reason', v_reason)
    from public.branches b where b.id = v_order.branch_id;
  return jsonb_build_object('ok', true, 'amount', p_amount);
end $function$;

revoke execute on function public.refund_order(uuid, numeric, text) from public, anon;
grant  execute on function public.refund_order(uuid, numeric, text) to authenticated;

-- ...and the order → delivery sync carries the words down, so the assignment trigger in §6 can
-- close the rider's turn with the merchant's own sentence rather than a bare status.
-- Everything else is byte-for-byte 20260904152000.
create or replace function public.orders_cancel_syncs_delivery()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if new.status is not distinct from old.status then return new; end if;
  if new.status not in ('cancelled', 'refunded') then return new; end if;

  update public.deliveries
     set status = 'cancelled',
         offer_expires_at = null,
         failed_reason = coalesce(failed_reason, new.cancellation_reason),
         dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
           || jsonb_build_object('type', 'order_' || new.status::text,
                                 'reason', new.cancellation_reason, 'at', now())
   where order_id = new.id
     and status in ('pending', 'dispatching', 'assigned', 'failed');

  return new;
end;
$function$;

revoke execute on function public.orders_cancel_syncs_delivery() from public, anon, authenticated;

-- 11. What the rider and the merchant read back. ---------------------------------------------
-- The rider's own history cannot be a plain select: deliveries_driver_assigned stops matching
-- the instant driver_id moves away, so the row a rider wants to look back at is exactly the
-- one they may no longer read.
create or replace function public.driver_job_history(p_since timestamptz default null, p_limit integer default 100)
returns table (
  assignment_id uuid,
  delivery_id uuid,
  order_number text,
  branch_id uuid,
  branch_name text,
  restaurant_name text,
  status text,
  end_kind text,
  end_reason text,
  offered_at timestamptz,
  accepted_at timestamptz,
  ended_at timestamptz,
  earned numeric,
  ledger_status text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_driver uuid := private.driver_id_for_user();
begin
  if v_driver is null then raise exception 'not_a_driver'; end if;
  return query
    select a.id, a.delivery_id, o.order_number::text, a.branch_id, b.name::text, r.name::text,
           a.status::text, a.end_kind::text, a.end_reason::text,
           a.offered_at, a.accepted_at, a.ended_at,
           l.total, l.status::text
      from public.delivery_assignments a
      join public.orders   o on o.id = a.order_id
      join public.branches b on b.id = a.branch_id
      left join public.restaurants r on r.id = b.restaurant_id
      left join lateral (
        select le.total, le.status
          from public.driver_earnings_ledger le
         where le.delivery_id = a.delivery_id and le.driver_id = a.driver_id
         order by le.created_at desc
         limit 1
      ) l on true
     where a.driver_id = v_driver
       and a.offered_at >= coalesce(p_since, now() - interval '30 days')
     order by a.offered_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$function$;

revoke execute on function public.driver_job_history(timestamptz, integer) from public, anon;
grant  execute on function public.driver_job_history(timestamptz, integer) to authenticated;

-- Staff can still audit the whole conversation of one delivery, turn by turn — the split is a
-- privacy boundary between riders, not a hole in the merchant's record.
create or replace function public.delivery_thread_history(p_delivery_id uuid)
returns table (
  assignment_id uuid,
  seq integer,
  driver_id uuid,
  driver_name text,
  status text,
  end_kind text,
  end_reason text,
  offered_at timestamptz,
  ended_at timestamptz,
  message_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch uuid;
begin
  select branch_id into v_branch from public.deliveries where id = p_delivery_id;
  if v_branch is null then raise exception 'not_found'; end if;
  if not private.staff_has_capability(v_branch, 'delivery.manage') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  return query
    select a.id, a.seq, a.driver_id, dr.full_name::text, a.status::text,
           a.end_kind::text, a.end_reason::text, a.offered_at, a.ended_at,
           (select count(*) from public.delivery_messages m where m.assignment_id = a.id)
      from public.delivery_assignments a
      left join public.drivers dr on dr.id = a.driver_id
     where a.delivery_id = p_delivery_id
     order by a.seq;
end;
$function$;

revoke execute on function public.delivery_thread_history(uuid) from public, anon;
grant  execute on function public.delivery_thread_history(uuid) to authenticated;
