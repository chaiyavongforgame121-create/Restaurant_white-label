-- Isolation leftovers: four small database items the branch-separation work left behind.
--
-- Each one was checked against the live database first.
--
--   * public.edit_pending_order failed on every call: it inserted order_items.name and
--     order_items.line_total, and those columns do not exist (the real ones are item_name and
--     subtotal). Nothing calls it. The storefront's "Edit instructions" button was removed on
--     2026-08-16, the back office uses admin_edit_order_notes, and neither apps/, packages/ nor
--     supabase/functions names it. It is dropped rather than repaired. A repaired version would let
--     a diner rebuild a pending or confirmed order at base prices: modifiers, combos, happy-hour
--     prices, promos and tax would all be lost, and the total would change after payment. The one
--     test that calls it (supabase/tests/branch_staff_parity.sql) runs its check only while it exists.
--   * private.customer_id_for_user() returned ONE customers row for the caller (the oldest). A diner
--     now has a row per branch, so any policy or function using it would have seen only the first
--     branch. Nothing uses it: no function body, policy, view, default or constraint names it, and
--     private.order_ids_for_customer already reads every row of the caller. anon could also run it.
--     Dropped.
--   * public.register_push_subscription stored whichever recipient the browser named. A signed-in
--     stranger could register their device against a rider's id (diners see it on their order) or
--     another diner's customers row. The recipient must now be the caller's own row
--     (customers.user_id, drivers.user_id or an active staff_members.user_id = auth.uid()), else
--     'not_your_recipient'. A browser has one endpoint. The ON CONFLICT (endpoint) path moves it to
--     the caller and the recipient they name, so a device another login used before, or the same
--     login at another branch's row, is no longer kept for the previous recipient. The direct INSERT
--     policy on push_subscriptions is dropped so the check cannot be skipped: nothing inserts
--     there except this function (SECURITY DEFINER) and the service role. Reading and deleting
--     your own rows is unchanged.
--   * public.sweep_abandoned_carts addressed a cart to the diner's customers row at ANY branch of
--     the restaurant ("that branch's own row first"). A cart left at Food Thai Thai could therefore
--     be sent to the Hamburger record. The row must now belong to the cart's own branch, and a cart
--     whose diner has no record there is left alone. The address is the one the cart was saved
--     with (abandoned_carts.customer_email, carried in variables.email). notify-worker now reads it
--     from there, so the sweep no longer skips a diner whose branch record has no email of its own
--     (most of them: phone sign-ins). Synthetic @…favornoms.local addresses are never picked.
--     notifications_outbox.branch_id is still written.
--
-- Sections 5-8 were added on 2026-09-19 and applied as a delta on top of 1-4. Each was checked
-- against the live database and every client write first.
--
--   * Cancelled and refunded orders stay closed. Nothing on the server checked a status change, so
--     anyone with UPDATE on orders (every staff member, through orders_staff) could move a cancelled
--     or refunded order back to preparing/ready/completed, and completing it then ran the loyalty
--     award and the tip split for an order that was never paid for. A BEFORE UPDATE OF status
--     trigger now refuses every change out of 'refunded' and every change out of 'cancelled' except
--     to 'refunded' (refund_order: money taken for an order that was then cancelled goes back) for
--     every signed-in caller; a session with no JWT (service role, cron, SQL console) can still
--     correct a status, as guard_staff_role_escalation trusts it, and the tests rely on that. No
--     product flow reopens a cancel: the kitchen's Undo and every other status write are guarded on
--     the status they came from, and the kitchen's Reject (cancel_order) has no Undo. The reopen
--     branches in the stock, loyalty and credit triggers (take again, loyalty_points_already_spent,
--     gift_card_already_spent) stay as they are and now run only for such a correction. Two
--     writers that could finish an order whatever its status now skip a closed one instead of
--     failing on the guard: a delivery marked delivered after its order was cancelled
--     (deliveries_sync_order_status) and the self-delivery "delivered" step (advance_self_delivery).
--     The rider's step still succeeds.
--   * order_items: staff access was FOR ALL with no capability, so a kitchen account could
--     `update order_items set unit_price = 0`. Only place-order (service role) writes lines, the
--     kitchen tick goes through set_order_item_prep_status, and the stock and cancel triggers run as
--     their owner, so staff access is now SELECT only and anon/authenticated lose the table's write
--     privileges.
--   * Branding bucket: a file under {restaurant}/{branch}/... belongs to that branch. Writing there
--     (insert, update, delete) now also needs brand.edit, branch.settings or menu.manage AT THAT
--     BRANCH, so an admin of Hamburger can no longer put files into Food Thai Thai's folder. Today's
--     uploads (logos, heroes, icons, the payment QR) are flat files under {restaurant}/ and keep
--     working exactly as before; combo photos live in branch-assets under combos/{branch}/, which
--     already needs menu.manage at that branch. Replacing or deleting a branding file was already
--     limited to people who administer the whole restaurant.
--   * accept_staff_invite: an invitation to a branch this account was removed from failed with
--     already_staff_here (uniq_staff_user_branch keeps one row per account and branch). The removed
--     row is now brought back with the invitation's role and permissions, the person keeps their
--     history on it, and the spent invitation is deleted as cancel_staff_invite deletes one. An
--     active or suspended row is still refused. guard_staff_role_escalation learns that exact case.
--
-- Already done when checked, so not repeated here: duplicate_menu_item starts copies untracked
-- (track_stock false, stock null) and v_low_stock_items is security_invoker and filtered to
-- private.user_branch_ids().
--
-- Sections 9-10 were added later on 2026-09-19, after review, and applied as a second delta.
--
--   * orders: staff access was FOR ALL with no capability, so any staff member of the branch
--     (kitchen, cashier) could rewrite an order's amounts, make up an order for a diner, or delete
--     one, and completing the result ran the loyalty award and the tip split on the invented
--     figures. Staff now read, and UPDATE only (same branch rule); anon and authenticated lose
--     INSERT, DELETE and TRUNCATE and may update the status column only, which is all today's apps
--     write (kitchen advance and Undo, counter confirm). Orders are made by place-order and
--     stripe-webhook (service role); every other change is a SECURITY DEFINER function or trigger.
--     One exception, for the till already deployed: the counter on main puts a cashier's discount
--     on the sale it has just rung up with a direct UPDATE of discount_amount and total
--     (record_counter_payment then settles that figure). Those two columns stay writable, and
--     tg_orders_money_guard lets exactly that write through: a counter sale a few minutes old,
--     not yet past confirmed, no discount yet, the discount at most the subtotal and taken off
--     the total, by someone with counter.access there. Everything else is 'order_money_locked'.
--     The new counter sends discount_percent to place-order, so once no older till is in use the
--     grant on those two columns and the trigger can go.
--   * menu_items.out_of_stock, a stored generated column (tracked and at or below zero), granted
--     to anon. The storefront reads track_stock and stock_quantity only to work out "sold out"
--     and so shows every visitor the raw count; once it reads out_of_stock instead,
--     `revoke select (stock_quantity) on public.menu_items from anon` hides the count from signed-out
--     visitors. That revoke is NOT made here: the storefront deployed today, and the one in the
--     repo, still select stock_quantity as anon, and the revoke would break the menu for them.
--     A signed-in diner reads menu_items as `authenticated`, like staff, so hiding the count from
--     them too needs a storefront view.

-- 1. edit_pending_order ---------------------------------------------------------------------------

drop function if exists public.edit_pending_order(uuid, jsonb);

-- 2. private.customer_id_for_user -----------------------------------------------------------------

drop function if exists private.customer_id_for_user();

-- 3. register_push_subscription -------------------------------------------------------------------

create or replace function public.register_push_subscription(
  p_recipient_type text,
  p_recipient_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null::text
)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_owned boolean;
begin
  if v_uid is null then
    raise exception 'auth_required';
  end if;
  if p_recipient_type not in ('customer','driver','staff') then
    raise exception 'invalid_recipient_type';
  end if;

  -- Only a recipient row the caller owns: their own customers row (one per branch), their rider
  -- profile, or a staff row of theirs that is still active.
  v_owned := case p_recipient_type
               when 'customer' then exists (
                 select 1 from public.customers c where c.id = p_recipient_id and c.user_id = v_uid)
               when 'driver' then exists (
                 select 1 from public.drivers d where d.id = p_recipient_id and d.user_id = v_uid)
               else exists (
                 select 1 from public.staff_members s
                  where s.id = p_recipient_id and s.user_id = v_uid and s.status = 'active')
             end;
  if not v_owned then
    raise exception 'not_your_recipient';
  end if;

  insert into public.push_subscriptions
    (user_id, recipient_type, recipient_id, endpoint, p256dh, auth, user_agent, last_used_at)
  values
    (v_uid, p_recipient_type, p_recipient_id, p_endpoint, p_p256dh, p_auth, p_user_agent, now())
  on conflict (endpoint) do update
    -- One endpoint is one browser. It now belongs to the caller and to the recipient they
    -- named, not to whoever registered it first.
    set user_id = excluded.user_id,
        recipient_type = excluded.recipient_type,
        recipient_id = excluded.recipient_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        last_used_at = now()
  returning id into v_id;

  return v_id;
end $function$;

revoke execute on function public.register_push_subscription(text, uuid, text, text, text, text) from public, anon;
grant execute on function public.register_push_subscription(text, uuid, text, text, text, text) to authenticated, service_role;

-- Every legitimate write goes through the function above, which runs as its owner.
drop policy if exists push_subs_owner_insert on public.push_subscriptions;

-- 4. sweep_abandoned_carts ------------------------------------------------------------------------

create or replace function public.sweep_abandoned_carts()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_count int;
begin
  -- The outbox only accepts customer, staff and driver recipients (recipient_type CHECK), so a
  -- cart is sent to the diner's customers row AT THE CART'S BRANCH. Each branch keeps its own
  -- customers, so the row of another branch of the same restaurant is never used, and a cart
  -- whose diner has no row at that branch is left alone.
  -- The address is the one the cart was saved with. notify-worker reads variables.email first,
  -- after checking it against this cart, so the branch row does not need an email of its own.
  -- A synthetic @…favornoms.local address cannot receive mail, so that cart is left alone too.
  with eligible as (
    select ac.id,
           (select c.id
              from public.customers c
             where c.user_id = ac.user_id
               and c.branch_id = ac.branch_id
             order by c.created_at, c.id
             limit 1) as customer_id
      from public.abandoned_carts ac
     where ac.notified_at is null
       and ac.recovered_order_id is null
       and ac.created_at <  now() - interval '1 hour'
       and nullif(btrim(ac.customer_email), '') is not null
       and not private.is_synthetic_email(btrim(ac.customer_email))
       and ac.user_id is not null
       and ac.branch_id is not null
  ),
  picks as (
    update public.abandoned_carts ac
      set notified_at = now()
      from eligible e
     where ac.id = e.id
       and e.customer_id is not null
    returning ac.id, btrim(ac.customer_email) as customer_email, ac.subtotal, ac.branch_id, e.customer_id
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

-- Cron (postgres) and the service role only, as 20260918110000 left it.
revoke execute on function public.sweep_abandoned_carts() from public, anon, authenticated;
grant execute on function public.sweep_abandoned_carts() to service_role;

-- 5. Cancelled and refunded orders stay closed ----------------------------------------------------

create or replace function private.tg_orders_final_status()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  -- No JWT = service role, cron, SQL console, migrations: trusted by construction, as in
  -- guard_staff_role_escalation. A correction made there still runs the reopen hooks (stock taken
  -- again, points and credits reclaimed). Every signed-in caller, staff or platform admin, is held.
  if auth.uid() is null then
    return new;
  end if;
  -- A cancelled order may still be marked refunded: money taken for an order that was then
  -- cancelled goes back through refund_order. Nothing else leaves cancelled, nothing leaves refunded.
  if old.status = 'refunded' or (old.status = 'cancelled' and new.status <> 'refunded') then
    raise exception 'order_status_final:%', old.status
      using errcode = 'P0001',
            hint = 'A cancelled or refunded order stays closed. Ring the order up again instead.';
  end if;
  return new;
end $function$;

-- Named to sort first among the BEFORE UPDATE triggers on orders, so a refused reopen reports this
-- reason and not, say, tg_block_unpaid_transfer_progress's.
drop trigger if exists orders_a_final_status_guard on public.orders;
create trigger orders_a_final_status_guard
  before update of status on public.orders
  for each row execute function private.tg_orders_final_status();

-- A delivery marked delivered after its order was cancelled or refunded leaves the order as it is
-- (a picked-up delivery is not cancelled with its order, so the rider can still finish the trip).
create or replace function public.deliveries_sync_order_status()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if (TG_OP <> 'UPDATE') then
    return new;
  end if;
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'picked_up' then
    update public.orders
       set status = 'out_for_delivery'
     where id = new.order_id
       and status in ('confirmed','preparing','ready');

  elsif new.status = 'delivered' then
    -- Never out of cancelled or refunded: orders_a_final_status_guard refuses that, and completing
    -- it would award points and split a tip for an order that was not paid for.
    update public.orders
       set status = 'completed',
           completed_at = coalesce(completed_at, now())
     where id = new.order_id
       and status not in ('completed', 'cancelled', 'refunded');
  end if;

  return new;
end;
$function$;

create or replace function public.advance_self_delivery(p_delivery_id uuid, p_to text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch uuid;
  v_order  uuid;
  v_mode   text;
  v_status text;
begin
  select d.branch_id, d.order_id, d.status::text into v_branch, v_order, v_status
    from public.deliveries d where d.id = p_delivery_id;
  if v_branch is null then raise exception 'delivery_not_found' using errcode = 'P0001'; end if;

  if not private.staff_has_capability(v_branch, 'delivery.manage') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  select coalesce(b.settings->>'delivery_mode','platform') into v_mode
    from public.branches b where b.id = v_branch;
  if v_mode <> 'self' then
    raise exception 'not_self_delivery' using errcode = 'P0001';
  end if;

  if p_to = 'picked_up' then
    if v_status not in ('assigned','dispatching','pending') then
      raise exception 'bad_transition' using errcode = 'P0001';
    end if;
    update public.deliveries
       set status = 'picked_up', picked_up_at = coalesce(picked_up_at, now())
     where id = p_delivery_id;
    update public.orders set status = 'out_for_delivery'
     where id = v_order and status in ('ready','confirmed','preparing');

  elsif p_to = 'delivered' then
    if v_status <> 'picked_up' then
      raise exception 'bad_transition' using errcode = 'P0001';
    end if;
    update public.deliveries
       set status = 'delivered', delivered_at = coalesce(delivered_at, now())
     where id = p_delivery_id;
    -- A cancelled or refunded order stays closed (orders_a_final_status_guard).
    update public.orders set status = 'completed'
     where id = v_order and status not in ('cancelled', 'refunded');

  else
    raise exception 'bad_target' using errcode = 'P0001';
  end if;

  insert into public.audit_logs(branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_branch, auth.uid(), 'staff', 'self_delivery_' || p_to, 'delivery', p_delivery_id, '{}'::jsonb);
end $function$;

-- 6. order_items: staff read; lines are written by place-order and SECURITY DEFINER functions ----

drop policy if exists order_items_staff on public.order_items;
drop policy if exists order_items_staff_read on public.order_items;
create policy order_items_staff_read on public.order_items
  for select to authenticated
  using (order_id in (select orders.id from public.orders
                       where orders.branch_id in (select private.user_branch_ids())));

-- Nothing signed in writes order_items directly: place-order uses the service role, the kitchen
-- tick is set_order_item_prep_status, and the stock and cancel triggers run as their owner.
revoke insert, update, delete, truncate on public.order_items from anon, authenticated;

-- 7. Branding bucket: a branch's folder needs a capability at that branch -------------------------

-- True unless the object sits in a branch's folder ({restaurant}/{branch}/...) and the caller has
-- none of brand.edit, branch.settings or menu.manage at that branch. Any other path answers true
-- and is left to the policies' restaurant-level rules.
create or replace function private.branding_branch_folder_ok(p_name text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select private.staff_has_capability(b.id, 'brand.edit')
        or private.staff_has_capability(b.id, 'branch.settings')
        or private.staff_has_capability(b.id, 'menu.manage')
      from public.branches b
     where b.id::text = lower((storage.foldername(p_name))[2])
       and b.restaurant_id::text = (storage.foldername(p_name))[1]
  ), true);
$function$;

revoke execute on function private.branding_branch_folder_ok(text) from public, anon;
grant execute on function private.branding_branch_folder_ok(text) to authenticated, service_role;

-- Uploading: the restaurant's owner (or a platform admin) or back-office staff of the restaurant,
-- as before, and inside a branch's folder only with a capability at that branch.
drop policy if exists branding_owner_insert on storage.objects;
create policy branding_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'branding'
    and exists (
      select 1 from public.restaurants r
       where r.id::text = (storage.foldername(objects.name))[1]
         and (r.owner_user_id = auth.uid() or private.user_is_platform_admin())
      union all
      select 1 from public.staff_members sm
       where sm.restaurant_id::text = (storage.foldername(objects.name))[1]
         and sm.user_id = auth.uid()
         and sm.status = 'active'
         and sm.role in ('owner', 'admin', 'manager')
    )
    and private.branding_branch_folder_ok(objects.name)
  );

drop policy if exists branding_owner_update on storage.objects;
create policy branding_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'branding' and private.administers_restaurant_folder(name)
         and private.branding_branch_folder_ok(name))
  with check (bucket_id = 'branding' and private.administers_restaurant_folder(name)
              and private.branding_branch_folder_ok(name));

drop policy if exists branding_owner_delete on storage.objects;
create policy branding_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'branding' and private.administers_restaurant_folder(name)
         and private.branding_branch_folder_ok(name));

-- 8. Re-invited after being removed: the removed row comes back ----------------------------------

create or replace function public.accept_staff_invite(p_staff_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed boolean;
  v_row public.staff_members%rowtype;
  v_old public.staff_members%rowtype;
begin
  if v_uid is null then raise exception 'sign_in_required'; end if;

  select lower(u.email), u.email_confirmed_at is not null
    into v_email, v_confirmed
    from auth.users u where u.id = v_uid;

  select * into v_row from public.staff_members where id = p_staff_id for update;
  if not found then raise exception 'invite_not_found'; end if;

  -- Opening the link twice, or reloading the page after accepting, is not an error.
  if v_row.user_id = v_uid and v_row.status = 'active' then
    return jsonb_build_object('staff_id', v_row.id, 'restaurant_id', v_row.restaurant_id,
      'branch_id', v_row.branch_id, 'role', v_row.role, 'already_accepted', true);
  end if;

  if v_row.status <> 'pending' or v_row.user_id is not null then raise exception 'invite_not_pending'; end if;
  if v_email is null or v_email <> lower(v_row.invited_email) then raise exception 'invite_email_mismatch'; end if;
  if not v_confirmed then raise exception 'email_not_confirmed'; end if;

  begin
    update public.staff_members
       set user_id = v_uid, status = 'active', accepted_at = now()
     where id = v_row.id;
  exception when unique_violation then
    -- uniq_staff_user_branch: this account already has a row at the same branch (or
    -- restaurant-wide). A row the owner REMOVED comes back with this invitation's role and
    -- permissions, so the person keeps one row per branch and its history (shifts, sales rung up),
    -- and the spent invitation is deleted, as cancel_staff_invite deletes one. An active or
    -- suspended row is still refused: that person is on the team (Reactivate is on the Staff page).
    select * into v_old
      from public.staff_members
     where user_id = v_uid
       and restaurant_id = v_row.restaurant_id
       and branch_id is not distinct from v_row.branch_id
       and id <> v_row.id
       for update;
    if not found or v_old.status <> 'removed' then
      raise exception 'already_staff_here';
    end if;

    -- guard_staff_role_escalation allows exactly this while the invitation still exists.
    update public.staff_members
       set role = v_row.role,
           permissions = v_row.permissions,
           invited_email = v_row.invited_email,
           invited_at = v_row.invited_at,
           status = 'active',
           accepted_at = now()
     where id = v_old.id;
    delete from public.staff_members where id = v_row.id;

    return jsonb_build_object('staff_id', v_old.id, 'restaurant_id', v_old.restaurant_id,
      'branch_id', v_old.branch_id, 'role', v_row.role, 'already_accepted', false, 'revived', true);
  end;

  return jsonb_build_object('staff_id', v_row.id, 'restaurant_id', v_row.restaurant_id,
    'branch_id', v_row.branch_id, 'role', v_row.role, 'already_accepted', false);
end $function$;

revoke execute on function public.accept_staff_invite(uuid) from public, anon;
grant execute on function public.accept_staff_invite(uuid) to authenticated, service_role;

create or replace function private.guard_staff_role_escalation()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_is_claim boolean := false;
begin
  -- No JWT = service role / SQL console / migrations. Trusted by construction.
  if v_uid is null or private.user_is_platform_admin() then
    return new;
  end if;

  -- Claiming an invitation: pending and unclaimed, addressed to this account's confirmed email,
  -- becoming active as this account — and nothing else about the row changes.
  if tg_op = 'UPDATE' then
    v_is_claim :=
          old.status = 'pending'
      and old.user_id is null
      and new.user_id = v_uid
      and new.status = 'active'
      and new.role = old.role
      and new.branch_id is not distinct from old.branch_id
      and new.restaurant_id = old.restaurant_id
      and new.invited_email is not distinct from old.invited_email
      and new.permissions is not distinct from old.permissions
      and new.pin_hash is not distinct from old.pin_hash
      and exists (
        select 1 from auth.users u
         where u.id = v_uid
           and u.email_confirmed_at is not null
           and lower(u.email) = lower(old.invited_email)
      );
    if v_is_claim then
      return new;
    end if;

    -- Accepting an invitation to a branch this account was removed from (accept_staff_invite):
    -- the caller's own removed row becomes active with the role, permissions and address of an
    -- open invitation to the caller's confirmed email at the same restaurant and branch, and
    -- nothing else about it changes.
    v_is_claim :=
          old.status = 'removed'
      and old.user_id = v_uid
      and new.user_id = v_uid
      and new.status = 'active'
      and new.branch_id is not distinct from old.branch_id
      and new.restaurant_id = old.restaurant_id
      and new.pin_hash is not distinct from old.pin_hash
      and exists (
        select 1
          from public.staff_members inv
          join auth.users u on u.id = v_uid
         where inv.id <> old.id
           and inv.status = 'pending'
           and inv.user_id is null
           and inv.restaurant_id = new.restaurant_id
           and inv.branch_id is not distinct from new.branch_id
           and inv.role = new.role
           and inv.permissions is not distinct from new.permissions
           and inv.invited_email is not distinct from new.invited_email
           and u.email_confirmed_at is not null
           and lower(u.email) = lower(inv.invited_email)
      );
    if v_is_claim then
      return new;
    end if;
  end if;

  if tg_op = 'INSERT' and new.user_id = v_uid and not private.user_owns_restaurant(new.restaurant_id) then
    raise exception 'staff_self_insert_forbidden'
      using hint = 'Staff rows for yourself come from an invitation.';
  end if;

  if tg_op = 'UPDATE'
     and (old.user_id = v_uid or new.user_id = v_uid)
     and (new.role is distinct from old.role
          or new.status is distinct from old.status
          or new.branch_id is distinct from old.branch_id
          or new.user_id is distinct from old.user_id)
     and not private.user_owns_restaurant(new.restaurant_id) then
    raise exception 'staff_self_role_change_forbidden'
      using hint = 'You cannot change your own role, status or branch.';
  end if;

  if new.role in ('owner', 'admin')
     and (tg_op = 'INSERT'
          or new.role is distinct from old.role
          or new.invited_email is distinct from old.invited_email
          or new.branch_id is distinct from old.branch_id
          or new.user_id is distinct from old.user_id)
     and not private.user_owns_restaurant(new.restaurant_id) then
    raise exception 'staff_grant_owner_forbidden'
      using hint = 'Only the owner can create or change an owner or admin.';
  end if;

  return new;
end;
$function$;

-- 9. orders: staff read, and change the status only ----------------------------------------------

-- The FOR ALL policy let any staff member of the branch write any column, insert and delete.
drop policy if exists orders_staff on public.orders;
drop policy if exists orders_staff_read on public.orders;
create policy orders_staff_read on public.orders
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));

drop policy if exists orders_staff_update on public.orders;
create policy orders_staff_update on public.orders
  for update to authenticated
  using (branch_id in (select private.user_branch_ids()))
  with check (branch_id in (select private.user_branch_ids()));

-- Orders are made by place-order and stripe-webhook (service role), and every change other than
-- the status goes through a SECURITY DEFINER function or trigger, which runs as its owner.
-- Today's apps write the status and nothing else (the kitchen's advance and Undo, the counter's
-- confirm). discount_amount and total stay writable for one released client only: see
-- tg_orders_money_guard.
revoke insert, update, delete, truncate on public.orders from anon, authenticated;
grant update (status, discount_amount, total) on public.orders to authenticated;

-- The counter built before this release (counter-view.tsx on main) puts a cashier's discount on
-- the sale it has just rung up with a plain UPDATE of discount_amount and total, after
-- place-order and before record_counter_payment. The new build sends discount_percent to
-- place-order instead. Until every till runs the new build, that one write is let through and
-- every other direct write to the two columns is refused. It gives a cashier nothing new: the
-- till's discount already goes to 100%.
create or replace function private.tg_orders_money_guard()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Only a signed-in client writing the table itself. A SECURITY DEFINER function runs as its
  -- owner, the service role as itself; the column grants already trust both.
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.discount_amount is not distinct from old.discount_amount
     and new.total is not distinct from old.total then
    return new;
  end if;
  -- The old counter: a staff sale not yet in the kitchen's hands (a card sale is still pending;
  -- a cash sale is already confirmed, by its pending cash payment), a few minutes old, no
  -- discount on it yet, the discount no more than the subtotal and taken off the total (to the
  -- cent), by someone who works the counter at that branch. Once only: the second try finds a
  -- discount already there.
  if old.status in ('pending', 'confirmed')
     and old.source in ('counter', 'pos')
     and old.created_at > now() - interval '15 minutes'
     and coalesce(old.discount_amount, 0) = 0
     and coalesce(new.discount_amount, 0) > 0
     and new.discount_amount <= old.subtotal
     and abs(new.total - greatest(0, old.total - new.discount_amount)) <= 0.01
     and private.staff_has_capability(old.branch_id, 'counter.access')
  then
    return new;
  end if;
  raise exception 'order_money_locked'
    using errcode = 'P0001',
          hint = 'An order''s amounts are set by place-order. Discount the sale at the counter before charging.';
end $function$;

drop trigger if exists orders_money_guard on public.orders;
create trigger orders_money_guard
  before update of discount_amount, total on public.orders
  for each row execute function private.tg_orders_money_guard();

-- 10. menu_items.out_of_stock: the storefront's "sold out", without the count ---------------------

-- The same test the storefront makes today (packages/database menu query, cart re-price):
-- tracked and at or below zero. sold_out_until (the kitchen's 86) depends on the clock, so it
-- stays a column of its own and the storefront keeps checking it.
alter table public.menu_items
  add column if not exists out_of_stock boolean
    generated always as (track_stock is true and coalesce(stock_quantity, 0) <= 0) stored not null;

-- anon reads menu_items through column grants (20260918110000), so a new column needs its own.
grant select (out_of_stock) on public.menu_items to anon;
