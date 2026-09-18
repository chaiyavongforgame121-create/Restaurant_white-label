-- Tenant and branch isolation: close the holes found while checking the second branch.
--
-- The owner's rule is that every branch is its own shop: nothing crosses from one branch to
-- another, let alone from one restaurant to another, except the diner's login and the account's
-- billing. The audit of the new branch (Food Thai Thai) found these gaps in the database itself.
-- Each was reproduced against the live data first (rolled back); supabase/tests/tenant_isolation.sql
-- proves the fixes.
--
--   1. Cross-tenant takeover (critical). private.user_branch_ids() trusted staff_members.branch_id
--      without checking that the branch belongs to the row's own restaurant, and nothing else tied
--      the two columns together. A staff row saying "restaurant Somtam Zab, branch Food Thai Thai"
--      read every Food Thai Thai order and repriced its whole menu. The arm now joins branches on
--      the restaurant, private.user_has_role_in_branch gets the same join, and a composite foreign
--      key (branch_id, restaurant_id) -> branches(id, restaurant_id) makes such a row impossible
--      on staff_members, customers, loyalty_points, loyalty_transactions and gift_cards (MATCH
--      SIMPLE: a NULL branch or restaurant is still allowed). Tables with a mismatching row are
--      skipped with a warning rather than failing the migration, except staff_members, which must
--      be clean. staff_has_capability and user_manages_branch already joined on the restaurant.
--   2. Storage. driver-kyc (IDs, licences, payout QRs) was readable by any owner, admin or manager
--      of ANY restaurant; now only by staff holding drivers.manage at a branch where that rider
--      has an application (driver_approvals) or a payout request (driver_withdrawals). receipts:
--      same shape, now keyed on a branch (or order) folder and orders.view; nothing writes that
--      bucket yet, so this defines the convention <branch_id>/... . branch-assets writes were open
--      to any merchant manager on the platform; staff may now write only menu/, imports/ and
--      combos/<branch_id>/... for a branch where they hold menu.manage (the rider's pickup/, pod/
--      and failed/ photos keep their own policy), and see those folders through a read policy so
--      a replace or delete there reaches the row. The shared branding folder is restaurant-wide,
--      so replacing or deleting a file in it now needs the restaurant's owner or a restaurant-wide
--      admin instead of brand.edit at any one branch (the app never replaces or deletes there, it
--      always uploads a new name). The branding bucket gets the image types the app uploads and a
--      10 MB cap (it had neither; the largest file today is 4.1 MB).
--   3. Client-callable SECURITY DEFINER functions without a caller check. check_rate_limit let any
--      signed-in user fill another diner's order bucket (place-order then answered 429);
--      find_dispatch_candidates and dispatch_candidate_diagnostics listed any tenant's online
--      riders; sweep_abandoned_carts could be fired by anyone. Only service-role code calls them
--      (place-order, customer-auth, driver-auth, import-menu, dispatch-driver) or cron and other
--      definer functions owned by postgres, so EXECUTE is now service_role only.
--      sweep_abandoned_carts also records the cart's branch on the outbox row, so notify-worker
--      can name the right storefront, and addresses the diner's customer row: its 'walkin'
--      recipient broke the outbox CHECK, so the first eligible cart would have failed the cron
--      job (nothing writes abandoned_carts yet, so it never has). Only a customer row with an
--      address notify-worker can send to is picked. mark_messages_read checks the participant
--      itself.
--   4. set_driver_kyc_status let any owner, admin or manager anywhere verify any rider. It now
--      needs drivers.manage at a branch the rider applied to, and, because kyc_status is one
--      platform-wide column that dispatch reads everywhere, at every branch the rider works with
--      or has applied to (branches that turned the rider down aside); otherwise a platform admin
--      decides.
--   5. promos_public_read_active let anyone list every tenant's active promo codes. The storefront
--      only ever checks a code through validate_promo_code (SECURITY DEFINER), so it is dropped.
--   6. Menu writes. The FOR ALL staff policies on menu_items, menu_categories, modifier_groups,
--      modifier_options, menu_item_modifiers, combo_sets and combo_items let every staff role
--      write: the kitchen could set a combo's price to 0. Reads stay as they were; INSERT, UPDATE
--      and DELETE need menu.manage for the row's branch (menu_items UPDATE also inventory.manage,
--      for the inventory page's stock-tracking toggles). Every other menu write in the apps goes
--      through SECURITY DEFINER functions with their own checks (set_item_86, reorders, save_combo).
--      A dish could also be given another branch's (or restaurant's) modifier group, which the
--      storefront then rendered and place-order refused; a trigger now refuses that pair.
--   7. restaurants and brands are shared by every branch, yet a manager or admin of any one branch
--      could rename or repaint them (and so every other branch). Changing them now needs the owner,
--      a restaurant-wide admin (active staff row with no branch, role owner or admin) or a platform
--      admin. The USING side stays as broad as before on purpose, so a branch-scoped admin gets a
--      permission error (42501, shown as "not allowed") instead of a save that silently did nothing.
--   8. order_ratings and support_tickets took branch_id (and a rating's driver_id) from the client,
--      so a review could be filed on another branch's storefront. BEFORE triggers now take the
--      branch from the order and the rider from its delivery, and a diner may only write for an
--      order of one of their own customers rows. A ticket sent with no customer (the storefront
--      looked the customer up by branch, which fails at any branch but the diner's first) is
--      completed from the order when the caller owns it, which also makes "Report a problem"
--      work at Food Thai Thai. A ticket with no order goes only to the branch of the customer row
--      it is filed as.
--   9. Anonymous visitors could read every restaurant's food cost (menu_items.cost). anon keeps
--      SELECT on every other column; staff and signed-in diners are unaffected. Stock columns stay
--      readable: the storefront and the guest cart use them to show what is sold out.
--      NOTE: anon's SELECT on menu_items is now column by column. A NEW menu_items column that the
--      storefront must read signed out needs its own `grant select (col) on menu_items to anon`.

-- 1. Branch belongs to the row's restaurant --------------------------------------------------------

create unique index if not exists branches_id_restaurant_uidx
  on public.branches (id, restaurant_id);

do $$
declare
  r record;
  v_bad bigint;
begin
  for r in
    select *
      from (values
        ('staff_members',        'staff_members_branch_in_restaurant_fkey',        'cascade'),
        ('customers',            'customers_branch_in_restaurant_fkey',            'cascade'),
        ('loyalty_points',       'loyalty_points_branch_in_restaurant_fkey',       'cascade'),
        ('loyalty_transactions', 'loyalty_transactions_branch_in_restaurant_fkey', 'cascade'),
        -- Mirrors gift_cards.branch_id's own ON DELETE SET NULL: the card survives, unbranched.
        ('gift_cards',           'gift_cards_branch_in_restaurant_fkey',           'set null (branch_id)')
      ) as t(tbl, con, on_delete)
  loop
    if exists (
      select 1 from pg_constraint
       where conname = r.con and conrelid = format('public.%I', r.tbl)::regclass
    ) then
      continue;
    end if;

    execute format(
      'select count(*) from public.%I x join public.branches b on b.id = x.branch_id
        where x.restaurant_id is not null and b.restaurant_id <> x.restaurant_id',
      r.tbl)
      into v_bad;

    if v_bad > 0 then
      if r.tbl = 'staff_members' then
        raise exception 'staff_members has % row(s) whose branch belongs to another restaurant', v_bad
          using hint = 'Those rows grant access to another tenant''s branch: correct or remove them first.';
      end if;
      raise warning '% has % row(s) whose branch belongs to another restaurant; % not added',
        r.tbl, v_bad, r.con;
      continue;
    end if;

    -- The action matches the single-column branch_id key already on the table, so deleting a
    -- branch does the same thing whichever of the two keys fires first.
    execute format(
      'alter table public.%I add constraint %I foreign key (branch_id, restaurant_id)
         references public.branches (id, restaurant_id) on delete %s',
      r.tbl, r.con, r.on_delete);
  end loop;
end;
$$;

create or replace function private.user_branch_ids()
 returns setof uuid
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  -- The branch must belong to the staff row's own restaurant. Without the join a row saying
  -- "restaurant A, branch of restaurant B" opened restaurant B's branch to restaurant A's staff.
  SELECT b.id
  FROM public.staff_members sm
  JOIN public.branches b ON b.id = sm.branch_id AND b.restaurant_id = sm.restaurant_id
  WHERE sm.user_id = auth.uid()
    AND sm.status = 'active'
  UNION
  SELECT b.id
  FROM public.staff_members sm
  JOIN public.branches b ON b.restaurant_id = sm.restaurant_id
  WHERE sm.user_id = auth.uid()
    AND sm.status = 'active'
    AND sm.branch_id IS NULL
  UNION
  SELECT b.id
  FROM public.restaurants r
  JOIN public.branches b ON b.restaurant_id = r.id
  WHERE r.owner_user_id = auth.uid()
  UNION
  -- An owner staff row tied to one branch still owns the whole restaurant, as
  -- private.user_owns_restaurant already says; without this arm that owner's second
  -- branch showed no orders.
  SELECT b.id
  FROM public.staff_members sm
  JOIN public.branches b ON b.restaurant_id = sm.restaurant_id
  WHERE sm.user_id = auth.uid()
    AND sm.status = 'active'
    AND sm.role = 'owner'
  UNION
  SELECT b.id
  FROM public.branches b
  WHERE private.user_is_platform_admin();
$function$;

create or replace function private.user_has_role_in_branch(p_branch_id uuid, p_role staff_role)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.branches b
    JOIN public.restaurants r ON r.id = b.restaurant_id
    WHERE b.id = p_branch_id AND r.owner_user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1
    FROM public.staff_members sm
    JOIN public.branches b ON b.id = p_branch_id
    WHERE sm.user_id = auth.uid()
      AND sm.status = 'active'
      AND sm.role = p_role
      -- Every arm is inside the branch's own restaurant, including the exact-branch one.
      AND sm.restaurant_id = b.restaurant_id
      AND (sm.branch_id = p_branch_id OR sm.branch_id IS NULL OR sm.role = 'owner')
  );
$function$;

-- The restaurant-level rows (restaurants, brands, the shared branding folder) are every branch's,
-- so only someone who runs the whole restaurant may change them.
create or replace function private.user_administers_restaurant(p_restaurant_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    private.user_owns_restaurant(p_restaurant_id)
    or exists (
      select 1 from public.staff_members sm
       where sm.restaurant_id = p_restaurant_id
         and sm.user_id = auth.uid()
         and sm.status = 'active'
         and sm.branch_id is null
         and sm.role in ('owner', 'admin')
    ),
    false);
$function$;

revoke all on function private.user_administers_restaurant(uuid) from public;
grant execute on function private.user_administers_restaurant(uuid) to authenticated;

-- 2. Storage ----------------------------------------------------------------------------------------

-- driver-kyc/<driver_id>/... : the rider's documents and payout QR. Staff see a rider's folder once
-- the rider has applied to, or asked for a payout at, a branch where they hold drivers.manage.
create or replace function private.manages_driver_folder(p_name text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select private.user_is_platform_admin()
      or exists (
           select 1 from public.driver_approvals da
            where da.driver_id::text = split_part(p_name, '/', 1)
              and private.staff_has_capability(da.branch_id, 'drivers.manage')
         )
      or exists (
           select 1 from public.driver_withdrawals w
            where w.driver_id::text = split_part(p_name, '/', 1)
              and w.branch_id is not null
              and private.staff_has_capability(w.branch_id, 'drivers.manage')
         );
$function$;

-- receipts/<branch_id>/... (or <order_id>/...): readable by staff who may see that branch's orders.
create or replace function private.staffs_receipt_folder(p_name text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select exists (
           select 1 from public.branches b
            where b.id::text = (storage.foldername(p_name))[1]
              and private.staff_has_capability(b.id, 'orders.view')
         )
      or exists (
           select 1 from public.orders o
            where o.id::text = (storage.foldername(p_name))[1]
              and private.staff_has_capability(o.branch_id, 'orders.view')
         );
$function$;

-- branch-assets/{menu|imports|combos}/<branch_id>/... : dish photos, menu-import scans, combo
-- photos (menu-manager.tsx, menu-import-view.tsx). Written by the branch's menu managers only.
create or replace function private.manages_branch_asset_folder(p_name text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    (storage.foldername(p_name))[1] in ('menu', 'imports', 'combos')
    and exists (
      select 1 from public.branches b
       where b.id::text = (storage.foldername(p_name))[2]
         and private.staff_has_capability(b.id, 'menu.manage')
    ),
    false);
$function$;

-- branding/<restaurant_id>/... : the restaurant-wide folder.
create or replace function private.administers_restaurant_folder(p_name text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.restaurants r
     where r.id::text = (storage.foldername(p_name))[1]
       and private.user_administers_restaurant(r.id)
  );
$function$;

revoke all on function private.manages_driver_folder(text)         from public;
revoke all on function private.staffs_receipt_folder(text)         from public;
revoke all on function private.manages_branch_asset_folder(text)   from public;
revoke all on function private.administers_restaurant_folder(text) from public;
grant execute on function private.manages_driver_folder(text)         to authenticated;
grant execute on function private.staffs_receipt_folder(text)         to authenticated;
grant execute on function private.manages_branch_asset_folder(text)   to authenticated;
grant execute on function private.administers_restaurant_folder(text) to authenticated;

drop policy if exists driver_kyc_admin_read on storage.objects;
create policy driver_kyc_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'driver-kyc' and private.manages_driver_folder(name));

drop policy if exists receipts_staff_read on storage.objects;
create policy receipts_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and private.staffs_receipt_folder(name));

drop policy if exists branch_assets_staff_write on storage.objects;
create policy branch_assets_staff_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'branch-assets' and private.manages_branch_asset_folder(name));

-- The bucket is public, so photos are read through their public URL and no read policy existed.
-- Postgres only lets UPDATE and DELETE reach rows a SELECT policy shows, so without this one the
-- two policies below matched nothing: a replace (upsert) or a delete in the branch's own folder
-- quietly did 0 rows. Staff see only the folders they may write.
drop policy if exists branch_assets_staff_read on storage.objects;
create policy branch_assets_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'branch-assets' and private.manages_branch_asset_folder(name));

drop policy if exists branch_assets_staff_update on storage.objects;
create policy branch_assets_staff_update on storage.objects
  for update to authenticated
  using (bucket_id = 'branch-assets' and private.manages_branch_asset_folder(name))
  with check (bucket_id = 'branch-assets' and private.manages_branch_asset_folder(name));

drop policy if exists branch_assets_staff_delete on storage.objects;
create policy branch_assets_staff_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'branch-assets' and private.manages_branch_asset_folder(name));

drop policy if exists branding_owner_update on storage.objects;
create policy branding_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'branding' and private.administers_restaurant_folder(name))
  with check (bucket_id = 'branding' and private.administers_restaurant_folder(name));

drop policy if exists branding_owner_delete on storage.objects;
create policy branding_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'branding' and private.administers_restaurant_folder(name));

-- What ImageUpload / IconUpload send (accept="image/*"; logos may be SVG, which the uploader
-- handles). The branch payment QR on Food Thai Thai is 3 MB; phone photos run a little larger.
update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif', 'image/avif'],
       file_size_limit    = 10485760
 where id = 'branding';

-- 3. Definer functions that only trusted code calls ------------------------------------------------

revoke execute on function public.check_rate_limit(text, integer, integer)                 from public, anon, authenticated;
revoke execute on function public.find_dispatch_candidates(uuid, numeric, uuid[])          from public, anon, authenticated;
revoke execute on function public.dispatch_candidate_diagnostics(uuid, numeric)            from public, anon, authenticated;
revoke execute on function public.sweep_abandoned_carts()                                  from public, anon, authenticated;
grant  execute on function public.check_rate_limit(text, integer, integer)                 to service_role;
grant  execute on function public.find_dispatch_candidates(uuid, numeric, uuid[])          to service_role;
grant  execute on function public.dispatch_candidate_diagnostics(uuid, numeric)            to service_role;
grant  execute on function public.sweep_abandoned_carts()                                  to service_role;

create or replace function public.sweep_abandoned_carts()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_count int;
begin
  -- The outbox only accepts customer, staff and driver recipients (recipient_type CHECK), and
  -- notify-worker finds an email address only for those, so the old 'walkin' row could never be
  -- written: the first eligible cart would have failed this cron job every 15 minutes. A cart is
  -- now sent to the diner's customer row in the cart branch's restaurant (that branch's own row
  -- first); a cart with no such diner is left alone.
  -- notify-worker takes the address from customers.email, not from the variables, and most rows
  -- have no email (phone sign-ins; some carry the synthetic @customer.favornoms.local address).
  -- Only a row it can actually send to is picked, so a cart is never marked notified for an
  -- email that fails with recipient_no_email.
  with eligible as (
    select ac.id,
           (select c.id
              from public.customers c
              join public.branches b on b.id = ac.branch_id
             where c.user_id = ac.user_id
               and c.restaurant_id = b.restaurant_id
               and nullif(btrim(c.email), '') is not null
               and c.email not ilike '%@customer.favornoms.local'
             order by (c.branch_id = ac.branch_id) desc, c.created_at
             limit 1) as customer_id
      from public.abandoned_carts ac
     where ac.notified_at is null
       and ac.recovered_order_id is null
       and ac.created_at <  now() - interval '1 hour'
       and ac.customer_email is not null
       and ac.user_id is not null
       and ac.branch_id is not null
  ),
  picks as (
    update public.abandoned_carts ac
      set notified_at = now()
      from eligible e
     where ac.id = e.id
       and e.customer_id is not null
    returning ac.id, ac.customer_email, ac.subtotal, ac.branch_id, e.customer_id
  ),
  notify as (
    -- branch_id on the row itself, not only in the variables: notify-worker reads the row's
    -- branch to put that branch's storefront name and icon on the email.
    insert into public.notifications_outbox (branch_id, channel, recipient_type, recipient_id, template, variables)
      select branch_id, 'email', 'customer', customer_id, 'abandoned_cart',
             jsonb_build_object('email', customer_email, 'subtotal', subtotal, 'branch_id', branch_id, 'cart_id', id)
      from picks
  )
  select count(*) into v_count from picks;
  return v_count;
end;
$function$;

create or replace function public.mark_messages_read(p_delivery_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_assignment uuid;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  select a.id into v_assignment
    from public.delivery_assignments a
   where a.delivery_id = p_delivery_id and a.ended_at is null
   order by a.seq desc
   limit 1;
  if v_assignment is null then return; end if;
  -- The same participant check as mark_thread_read: the rider, the diner, or delivery staff.
  if not public.can_read_thread(v_assignment) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  perform public.mark_thread_read(v_assignment);
end;
$function$;

-- 4. KYC decisions stay inside the rider's branches -------------------------------------------------

create or replace function public.set_driver_kyc_status(p_driver_id uuid, p_status driver_kyc_status, p_notes text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  -- drivers.manage at a branch this rider applied to. Any owner, admin or manager of any
  -- restaurant used to pass.
  if not (
    private.user_is_platform_admin()
    or exists (
      select 1 from public.driver_approvals da
       where da.driver_id = p_driver_id
         and private.staff_has_capability(da.branch_id, 'drivers.manage')
    )
  ) then
    raise exception 'forbidden';
  end if;

  -- drivers.kyc_status is one column for the whole platform and dispatch at every branch reads
  -- it, so a decision here reaches every branch the rider works with or has applied to. Staff
  -- decide only when they hold drivers.manage at all of those branches; a branch that turned the
  -- rider down is not affected. A rider shared with another restaurant, or with a branch this
  -- admin does not run, is decided by the owner of every branch involved or a platform admin.
  if not private.user_is_platform_admin() and exists (
       select 1 from public.driver_approvals da
        where da.driver_id = p_driver_id
          and da.status <> 'rejected'
          and not private.staff_has_capability(da.branch_id, 'drivers.manage')) then
    raise exception 'forbidden: kyc_shared_with_other_branch'
      using errcode = '42501',
            hint = 'This rider also works with a branch you do not manage; that branch''s owner or a platform admin decides.';
  end if;

  update public.drivers
  set
    kyc_status = p_status,
    kyc_verified_at = case when p_status = 'verified' then now() else kyc_verified_at end,
    updated_at = now()
  where id = p_driver_id;

  insert into public.audit_logs(actor_type, actor_id, action, entity_type, entity_id, metadata)
  values (
    'staff', auth.uid(),
    'driver_kyc_' || p_status::text,
    'driver', p_driver_id,
    jsonb_build_object('notes', p_notes)
  );
end;
$function$;

-- 5. Promo codes are checked, never listed ----------------------------------------------------------

drop policy if exists promos_public_read_active on public.promos;

-- 6. Menu writes need menu.manage -------------------------------------------------------------------

-- menu_items
drop policy if exists menu_items_staff        on public.menu_items;
drop policy if exists menu_items_staff_read   on public.menu_items;
drop policy if exists menu_items_staff_insert on public.menu_items;
drop policy if exists menu_items_staff_update on public.menu_items;
drop policy if exists menu_items_staff_delete on public.menu_items;
create policy menu_items_staff_read on public.menu_items
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));
create policy menu_items_staff_insert on public.menu_items
  for insert to authenticated
  with check (private.staff_has_capability(branch_id, 'menu.manage'));
-- inventory.manage too: the inventory page switches stock tracking on the row itself.
create policy menu_items_staff_update on public.menu_items
  for update to authenticated
  using (private.staff_has_capability(branch_id, 'menu.manage')
         or private.staff_has_capability(branch_id, 'inventory.manage'))
  with check (private.staff_has_capability(branch_id, 'menu.manage')
              or private.staff_has_capability(branch_id, 'inventory.manage'));
create policy menu_items_staff_delete on public.menu_items
  for delete to authenticated
  using (private.staff_has_capability(branch_id, 'menu.manage'));

-- menu_categories
drop policy if exists menu_cat_staff        on public.menu_categories;
drop policy if exists menu_cat_staff_read   on public.menu_categories;
drop policy if exists menu_cat_staff_insert on public.menu_categories;
drop policy if exists menu_cat_staff_update on public.menu_categories;
drop policy if exists menu_cat_staff_delete on public.menu_categories;
create policy menu_cat_staff_read on public.menu_categories
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));
create policy menu_cat_staff_insert on public.menu_categories
  for insert to authenticated
  with check (private.staff_has_capability(branch_id, 'menu.manage'));
create policy menu_cat_staff_update on public.menu_categories
  for update to authenticated
  using (private.staff_has_capability(branch_id, 'menu.manage'))
  with check (private.staff_has_capability(branch_id, 'menu.manage'));
create policy menu_cat_staff_delete on public.menu_categories
  for delete to authenticated
  using (private.staff_has_capability(branch_id, 'menu.manage'));

-- modifier_groups
drop policy if exists modifier_groups_staff        on public.modifier_groups;
drop policy if exists modifier_groups_staff_read   on public.modifier_groups;
drop policy if exists modifier_groups_staff_insert on public.modifier_groups;
drop policy if exists modifier_groups_staff_update on public.modifier_groups;
drop policy if exists modifier_groups_staff_delete on public.modifier_groups;
create policy modifier_groups_staff_read on public.modifier_groups
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));
create policy modifier_groups_staff_insert on public.modifier_groups
  for insert to authenticated
  with check (private.staff_has_capability(branch_id, 'menu.manage'));
create policy modifier_groups_staff_update on public.modifier_groups
  for update to authenticated
  using (private.staff_has_capability(branch_id, 'menu.manage'))
  with check (private.staff_has_capability(branch_id, 'menu.manage'));
create policy modifier_groups_staff_delete on public.modifier_groups
  for delete to authenticated
  using (private.staff_has_capability(branch_id, 'menu.manage'));

-- modifier_options (branch through the group)
drop policy if exists modifier_options_staff        on public.modifier_options;
drop policy if exists modifier_options_staff_read   on public.modifier_options;
drop policy if exists modifier_options_staff_insert on public.modifier_options;
drop policy if exists modifier_options_staff_update on public.modifier_options;
drop policy if exists modifier_options_staff_delete on public.modifier_options;
create policy modifier_options_staff_read on public.modifier_options
  for select to authenticated
  using (group_id in (select mg.id from public.modifier_groups mg
                       where mg.branch_id in (select private.user_branch_ids())));
create policy modifier_options_staff_insert on public.modifier_options
  for insert to authenticated
  with check (exists (select 1 from public.modifier_groups mg
                       where mg.id = modifier_options.group_id
                         and private.staff_has_capability(mg.branch_id, 'menu.manage')));
create policy modifier_options_staff_update on public.modifier_options
  for update to authenticated
  using (exists (select 1 from public.modifier_groups mg
                  where mg.id = modifier_options.group_id
                    and private.staff_has_capability(mg.branch_id, 'menu.manage')))
  with check (exists (select 1 from public.modifier_groups mg
                       where mg.id = modifier_options.group_id
                         and private.staff_has_capability(mg.branch_id, 'menu.manage')));
create policy modifier_options_staff_delete on public.modifier_options
  for delete to authenticated
  using (exists (select 1 from public.modifier_groups mg
                  where mg.id = modifier_options.group_id
                    and private.staff_has_capability(mg.branch_id, 'menu.manage')));

-- menu_item_modifiers (branch through the dish; the trigger below keeps the group in it)
drop policy if exists menu_item_mod_staff        on public.menu_item_modifiers;
drop policy if exists menu_item_mod_staff_read   on public.menu_item_modifiers;
drop policy if exists menu_item_mod_staff_insert on public.menu_item_modifiers;
drop policy if exists menu_item_mod_staff_update on public.menu_item_modifiers;
drop policy if exists menu_item_mod_staff_delete on public.menu_item_modifiers;
create policy menu_item_mod_staff_read on public.menu_item_modifiers
  for select to authenticated
  using (menu_item_id in (select mi.id from public.menu_items mi
                           where mi.branch_id in (select private.user_branch_ids())));
create policy menu_item_mod_staff_insert on public.menu_item_modifiers
  for insert to authenticated
  with check (exists (select 1 from public.menu_items mi
                       where mi.id = menu_item_modifiers.menu_item_id
                         and private.staff_has_capability(mi.branch_id, 'menu.manage')));
create policy menu_item_mod_staff_update on public.menu_item_modifiers
  for update to authenticated
  using (exists (select 1 from public.menu_items mi
                  where mi.id = menu_item_modifiers.menu_item_id
                    and private.staff_has_capability(mi.branch_id, 'menu.manage')))
  with check (exists (select 1 from public.menu_items mi
                       where mi.id = menu_item_modifiers.menu_item_id
                         and private.staff_has_capability(mi.branch_id, 'menu.manage')));
create policy menu_item_mod_staff_delete on public.menu_item_modifiers
  for delete to authenticated
  using (exists (select 1 from public.menu_items mi
                  where mi.id = menu_item_modifiers.menu_item_id
                    and private.staff_has_capability(mi.branch_id, 'menu.manage')));

-- combo_sets
drop policy if exists combo_sets_staff        on public.combo_sets;
drop policy if exists combo_sets_staff_read   on public.combo_sets;
drop policy if exists combo_sets_staff_insert on public.combo_sets;
drop policy if exists combo_sets_staff_update on public.combo_sets;
drop policy if exists combo_sets_staff_delete on public.combo_sets;
create policy combo_sets_staff_read on public.combo_sets
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));
create policy combo_sets_staff_insert on public.combo_sets
  for insert to authenticated
  with check (private.staff_has_capability(branch_id, 'menu.manage'));
create policy combo_sets_staff_update on public.combo_sets
  for update to authenticated
  using (private.staff_has_capability(branch_id, 'menu.manage'))
  with check (private.staff_has_capability(branch_id, 'menu.manage'));
create policy combo_sets_staff_delete on public.combo_sets
  for delete to authenticated
  using (private.staff_has_capability(branch_id, 'menu.manage'));

-- combo_items (branch through the combo)
drop policy if exists combo_items_staff        on public.combo_items;
drop policy if exists combo_items_staff_read   on public.combo_items;
drop policy if exists combo_items_staff_insert on public.combo_items;
drop policy if exists combo_items_staff_update on public.combo_items;
drop policy if exists combo_items_staff_delete on public.combo_items;
create policy combo_items_staff_read on public.combo_items
  for select to authenticated
  using (combo_id in (select cs.id from public.combo_sets cs
                       where cs.branch_id in (select private.user_branch_ids())));
create policy combo_items_staff_insert on public.combo_items
  for insert to authenticated
  with check (exists (select 1 from public.combo_sets cs
                       where cs.id = combo_items.combo_id
                         and private.staff_has_capability(cs.branch_id, 'menu.manage')));
create policy combo_items_staff_update on public.combo_items
  for update to authenticated
  using (exists (select 1 from public.combo_sets cs
                  where cs.id = combo_items.combo_id
                    and private.staff_has_capability(cs.branch_id, 'menu.manage')))
  with check (exists (select 1 from public.combo_sets cs
                       where cs.id = combo_items.combo_id
                         and private.staff_has_capability(cs.branch_id, 'menu.manage')));
create policy combo_items_staff_delete on public.combo_items
  for delete to authenticated
  using (exists (select 1 from public.combo_sets cs
                  where cs.id = combo_items.combo_id
                    and private.staff_has_capability(cs.branch_id, 'menu.manage')));

-- A dish's modifier groups come from the dish's own branch. Runs as its owner so a group the
-- caller cannot see is still recognised as foreign (the foreign key ignores RLS).
create or replace function private.tg_menu_item_modifiers_same_branch()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_item_branch  uuid;
  v_group_branch uuid;
begin
  select mi.branch_id into v_item_branch  from public.menu_items mi      where mi.id = new.menu_item_id;
  select mg.branch_id into v_group_branch from public.modifier_groups mg where mg.id = new.modifier_group_id;
  -- A row that does not exist is the foreign key's to report.
  if v_item_branch is null or v_group_branch is null then
    return new;
  end if;
  if v_item_branch <> v_group_branch then
    raise exception 'modifier_group_branch_mismatch'
      using errcode = '23514',
            detail  = format('modifier group %s is not on the menu of this dish''s branch', new.modifier_group_id);
  end if;
  return new;
end;
$function$;

revoke all on function private.tg_menu_item_modifiers_same_branch() from public;

drop trigger if exists trg_menu_item_modifiers_same_branch on public.menu_item_modifiers;
create trigger trg_menu_item_modifiers_same_branch
  before insert or update of menu_item_id, modifier_group_id on public.menu_item_modifiers
  for each row execute function private.tg_menu_item_modifiers_same_branch();

-- 7. Restaurant-level rows need the whole restaurant ------------------------------------------------

-- USING stays as broad as before so a branch-scoped manager or admin reaches the WITH CHECK and
-- gets 42501, which the brands page shows as "not allowed", instead of an UPDATE that silently
-- matched nothing and reported success.
drop policy if exists restaurants_staff_update on public.restaurants;
create policy restaurants_staff_update on public.restaurants
  for update to authenticated
  using (private.user_manages_restaurant(id))
  with check (private.user_administers_restaurant(id));

drop policy if exists brands_brand_edit_update on public.brands;
create policy brands_brand_edit_update on public.brands
  for update to authenticated
  using (private.user_owns_restaurant(restaurant_id)
         or exists (select 1 from public.branches b
                     where b.restaurant_id = brands.restaurant_id
                       and private.staff_has_capability(b.id, 'brand.edit')))
  with check (private.user_administers_restaurant(restaurant_id));

drop policy if exists brands_default_brand_insert on public.brands;
create policy brands_default_brand_insert on public.brands
  for insert to authenticated
  with check (not private.restaurant_has_brand(restaurant_id)
              and private.user_administers_restaurant(restaurant_id));

-- 8. Ratings and tickets take their branch from the order -------------------------------------------

create or replace function private.tg_order_ratings_from_order()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch   uuid;
  v_customer uuid;
begin
  select o.branch_id, o.customer_id into v_branch, v_customer
    from public.orders o where o.id = new.order_id;
  if not found then
    return new;  -- the foreign key reports it
  end if;

  -- The branch and rider are facts of the order, whatever the client sent.
  new.branch_id := v_branch;
  new.driver_id := (select d.driver_id from public.deliveries d where d.order_id = new.order_id);

  -- Service role and platform admins are trusted; everyone else rates only their own order.
  if auth.uid() is not null and not private.user_is_platform_admin() then
    if v_customer is null
       or new.customer_id is distinct from v_customer
       or not exists (select 1 from public.customers c
                       where c.id = new.customer_id and c.user_id = auth.uid()) then
      raise exception 'rating_not_your_order'
        using errcode = '42501', hint = 'Only the diner who placed the order can rate it.';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.tg_order_ratings_from_order() from public;

drop trigger if exists trg_order_ratings_from_order on public.order_ratings;
create trigger trg_order_ratings_from_order
  before insert or update on public.order_ratings
  for each row execute function private.tg_order_ratings_from_order();

create or replace function private.tg_support_tickets_from_order()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid      uuid := auth.uid();
  v_branch   uuid;
  v_customer uuid;
  v_found    boolean := false;
begin
  if new.order_id is not null then
    select o.branch_id, o.customer_id into v_branch, v_customer
      from public.orders o where o.id = new.order_id;
    v_found := found;
    if v_found then
      new.branch_id := v_branch;
      -- The storefront looked the customer up by (user, branch), which finds nothing at any
      -- branch but the diner's first, and sent NULL. The order knows whose it is.
      if new.customer_id is null and v_customer is not null and v_uid is not null
         and exists (select 1 from public.customers c where c.id = v_customer and c.user_id = v_uid) then
        new.customer_id := v_customer;
      end if;
    end if;
  end if;

  -- Service role, platform admins and staff who see this branch's orders are trusted.
  if v_uid is null
     or private.user_is_platform_admin()
     or private.staff_has_capability(new.branch_id, 'orders.view') then
    return new;
  end if;

  if new.customer_id is null
     or not exists (select 1 from public.customers c
                     where c.id = new.customer_id and c.user_id = v_uid) then
    raise exception 'ticket_not_your_customer'
      using errcode = '42501', hint = 'A ticket is filed as one of your own customer profiles.';
  end if;
  if v_found and new.customer_id is distinct from v_customer then
    raise exception 'ticket_not_your_order'
      using errcode = '42501', hint = 'Only the diner who placed the order can report a problem with it.';
  end if;
  -- Customer rows are per branch, so a ticket with no order goes only to the branch that owns the
  -- customer row it is filed as (a Hamburger row cannot file at Food Thai Thai).
  if new.order_id is null and not exists (
       select 1 from public.customers c
        where c.id = new.customer_id and c.branch_id = new.branch_id) then
    raise exception 'ticket_branch_mismatch'
      using errcode = '42501', hint = 'A ticket goes to the branch you are a customer of.';
  end if;
  return new;
end;
$function$;

revoke all on function private.tg_support_tickets_from_order() from public;

drop trigger if exists trg_support_tickets_from_order on public.support_tickets;
create trigger trg_support_tickets_from_order
  before insert or update on public.support_tickets
  for each row execute function private.tg_support_tickets_from_order();

-- 9. Food cost is not public ------------------------------------------------------------------------

-- Every column but cost, listed from the catalogue when this runs so a column another migration
-- added today is not dropped from the storefront by accident.
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
    into v_cols
    from pg_attribute a
   where a.attrelid = 'public.menu_items'::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attname <> 'cost';
  revoke select on public.menu_items from anon;
  execute format('grant select (%s) on public.menu_items to anon', v_cols);
end;
$$;
