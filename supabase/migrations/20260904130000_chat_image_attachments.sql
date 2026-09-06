-- The driver ↔ customer chat can carry a photo.
--
-- The thread is the only channel a rider and a diner share once the food leaves the
-- restaurant, and the two questions it exists to answer — "which door?" and "is this the
-- right bag?" — are both pictures. Typing a gate code a third time is not a substitute for
-- a photo of the gate.
--
-- The photos get their own PRIVATE bucket rather than joining the rider's proof photos in
-- `branch-assets`, which is public: a chat photo can show the inside of someone's home.

alter table public.delivery_messages
  add column if not exists attachment_path   text,
  add column if not exists attachment_width  int,
  add column if not exists attachment_height int;

comment on column public.delivery_messages.attachment_path is
  'Object path in the private chat-attachments bucket, shaped <delivery_id>/<uuid>.<ext>. Null for text-only messages.';
comment on column public.delivery_messages.attachment_width is
  'Stored size of the compressed image, so a bubble can reserve its space and the thread does not jump as photos decode.';

-- Mirrors payment-proofs: private, size-capped, image MIME types only, and idempotent so
-- re-running the file cannot widen it by accident. png is on the list because Safari
-- silently hands back image/png when asked to encode webp.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-attachments', 'chat-attachments', false, 5242880,
        array['image/jpeg','image/webp','image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Folder helper, mirroring private.owns_order_folder from 20260827193700. Two deliberate
-- choices here:
--
-- The join on deliveries rather than a ::uuid cast of the path segment means a junk first
-- segment evaluates to false instead of raising 22P02 from inside a storage policy.
--
-- Participation is resolved from the customer and driver rows rather than through
-- public.is_delivery_participant(uuid). That predicate also gates the message rows, and it
-- may be scoped to the active statuses — the composer closes when the delivery ends. A
-- storage policy must NOT close with it: the thread stays readable after delivery, so a
-- status-scoped read would leave a finished conversation showing its words and broken
-- images. Nothing new is exposed either way; the reader still has to be one of the two
-- people on the delivery.
create or replace function private.in_delivery_chat_folder(p_name text)
returns boolean language sql stable security definer set search_path to 'public','pg_temp' as $$
  select exists (
    select 1
      from public.deliveries d
      left join public.orders o on o.id = d.order_id
      left join public.customers c on c.id = o.customer_id
      left join public.drivers dr on dr.id = d.driver_id
     where d.id::text = (storage.foldername(p_name))[1]
       and (c.user_id = auth.uid() or dr.user_id = auth.uid())
  );
$$;

revoke execute on function private.in_delivery_chat_folder(text) from public, anon;
grant execute on function private.in_delivery_chat_folder(text) to authenticated;

drop policy if exists chat_attachments_participant_insert on storage.objects;
create policy chat_attachments_participant_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-attachments' and private.in_delivery_chat_folder(name));

drop policy if exists chat_attachments_participant_read on storage.objects;
create policy chat_attachments_participant_read on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-attachments' and private.in_delivery_chat_folder(name));

-- No update and no delete policy on purpose: every send writes a fresh uuid, so nothing
-- ever needs overwriting, and neither party may remove a photo the other is looking at.
