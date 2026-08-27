-- Named capabilities instead of role-string arrays scattered across the app.
--
-- `role` is text, not staff_role, on purpose: it decouples the matrix from the enum
-- so rows can be seeded for a role before/independently of the enum, and the table
-- survives if the role set is ever reworked. Joins cast (sm.role::text = rc.role).
create table if not exists public.role_capabilities (
  role       text not null,
  capability text not null,
  primary key (role, capability)
);

alter table public.role_capabilities enable row level security;

drop policy if exists role_capabilities_read on public.role_capabilities;
create policy role_capabilities_read on public.role_capabilities
  for select to authenticated using (true);

revoke insert, update, delete on public.role_capabilities from authenticated, anon;

delete from public.role_capabilities;

insert into public.role_capabilities (role, capability) values
  -- OWNER — everything, including the two things nobody else gets.
  ('owner','backoffice.access'), ('owner','dashboard.view'), ('owner','orders.view'),
  ('owner','orders.refund'), ('owner','orders.cancel'), ('owner','counter.access'),
  ('owner','kitchen.access'), ('owner','menu.manage'), ('owner','menu.availability'),
  ('owner','inventory.manage'), ('owner','promos.manage'), ('owner','customers.view'),
  ('owner','loyalty.manage'), ('owner','payments.view'), ('owner','payments.decide'),
  ('owner','delivery.manage'), ('owner','drivers.manage'), ('owner','reports.view'),
  ('owner','staff.manage'), ('owner','staff.timelog'), ('owner','branch.settings'),
  ('owner','brand.edit'), ('owner','billing.manage'), ('owner','hq.view'),

  -- ADMIN — the owner's deputy. Everything except billing and touching the owner.
  ('admin','backoffice.access'), ('admin','dashboard.view'), ('admin','orders.view'),
  ('admin','orders.refund'), ('admin','orders.cancel'), ('admin','counter.access'),
  ('admin','kitchen.access'), ('admin','menu.manage'), ('admin','menu.availability'),
  ('admin','inventory.manage'), ('admin','promos.manage'), ('admin','customers.view'),
  ('admin','loyalty.manage'), ('admin','payments.view'), ('admin','payments.decide'),
  ('admin','delivery.manage'), ('admin','drivers.manage'), ('admin','reports.view'),
  ('admin','staff.manage'), ('admin','staff.timelog'), ('admin','branch.settings'),
  ('admin','brand.edit'),

  -- MANAGER — day-to-day operations. No billing, no brand, no HQ, and cannot
  -- invite staff (staff.manage), but may read the shift log.
  ('manager','backoffice.access'), ('manager','dashboard.view'), ('manager','orders.view'),
  ('manager','orders.refund'), ('manager','orders.cancel'), ('manager','counter.access'),
  ('manager','kitchen.access'), ('manager','menu.manage'), ('manager','menu.availability'),
  ('manager','inventory.manage'), ('manager','promos.manage'), ('manager','customers.view'),
  ('manager','payments.view'), ('manager','payments.decide'), ('manager','delivery.manage'),
  ('manager','drivers.manage'), ('manager','reports.view'), ('manager','staff.timelog'),

  -- CASHIER — the counter. Takes money, applies discounts, reprints receipts,
  -- cancels BEFORE payment. Refund after payment is deliberately absent.
  ('cashier','counter.access'), ('cashier','orders.view'), ('cashier','orders.cancel'),
  ('cashier','payments.view'), ('cashier','promos.apply'), ('cashier','customers.view'),
  ('cashier','kitchen.status'), ('cashier','receipt.reprint'),

  -- SERVER — dine-in only. Builds a ticket, sends it to the kitchen, watches it.
  ('server','counter.access'), ('server','orders.view.own'), ('server','orders.create'),
  ('server','kitchen.status'),

  -- KITCHEN — the pass. Cook states and stock/86 only.
  ('kitchen','kitchen.access'), ('kitchen','menu.availability'),

  -- DRIVER — no back office at all. Riders work in the driver app, where access is
  -- scoped by drivers.user_id and driver_approvals.
  ('driver','driver.self'),

  -- STAFF — the pre-existing generic role, unchanged so this is a no-op for tenants.
  ('staff','counter.access')
on conflict do nothing;

create or replace function private.staff_has_capability(p_branch_id uuid, p_capability text)
returns boolean language sql stable security definer set search_path to 'public','pg_temp' as $$
  select coalesce(
    private.user_is_platform_admin()
    or exists (
      select 1
        from public.branches b
        join public.restaurants r on r.id = b.restaurant_id
       where b.id = p_branch_id and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1
        from public.branches b
        join public.staff_members sm on sm.restaurant_id = b.restaurant_id
        join public.role_capabilities rc on rc.role = sm.role::text
       where b.id = p_branch_id
         and sm.user_id = auth.uid()
         and sm.status = 'active'
         and (sm.branch_id is null or sm.branch_id = b.id)
         and rc.capability = p_capability
    ),
  false);
$$;

revoke execute on function private.staff_has_capability(uuid, text) from anon;
grant execute on function private.staff_has_capability(uuid, text) to authenticated;

create or replace function public.my_capabilities(p_branch_id uuid)
returns setof text language sql stable security definer set search_path to 'public','pg_temp' as $$
  select rc.capability
    from public.branches b
    join public.staff_members sm on sm.restaurant_id = b.restaurant_id
    join public.role_capabilities rc on rc.role = sm.role::text
   where b.id = p_branch_id
     and sm.user_id = auth.uid()
     and sm.status = 'active'
     and (sm.branch_id is null or sm.branch_id = b.id)
  union
  select rc.capability from public.role_capabilities rc
   where rc.role = 'owner'
     and (
       private.user_is_platform_admin()
       or exists (select 1 from public.branches b
                    join public.restaurants r on r.id = b.restaurant_id
                   where b.id = p_branch_id and r.owner_user_id = auth.uid())
     );
$$;

revoke execute on function public.my_capabilities(uuid) from anon;
grant execute on function public.my_capabilities(uuid) to authenticated;
