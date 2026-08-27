-- Until now every one of these tables was readable by ANY active staff member of the
-- branch, because the policies gated on private.user_branch_ids() — "are you staff
-- here" — and never on what kind of staff. A kitchen tablet could therefore read every
-- payment, every customer record and the whole staff roster by calling the API directly,
-- whatever the screen showed. The brief is explicit that Kitchen and Server must not see
-- customer, payment, staff or sales data, so the boundary moves into RLS.
--
-- Each policy keeps its existing branch/restaurant scope and gains a capability test.
-- Self-access is preserved throughout: a person can always read their own row, which is
-- what sign-in and the branch layout depend on.

-- PAYMENTS ------------------------------------------------------------------
drop policy if exists payments_staff on public.payments;

create policy payments_staff_read on public.payments
  for select to authenticated
  using (private.staff_has_capability(branch_id, 'payments.view'));

create policy payments_staff_write on public.payments
  for insert to authenticated
  with check (private.staff_has_capability(branch_id, 'payments.decide'));

create policy payments_staff_update on public.payments
  for update to authenticated
  using (private.staff_has_capability(branch_id, 'payments.decide'))
  with check (private.staff_has_capability(branch_id, 'payments.decide'));

-- CUSTOMERS -----------------------------------------------------------------
drop policy if exists customers_staff on public.customers;

create policy customers_staff_read on public.customers
  for select to authenticated
  using (branch_id in (select private.user_branch_ids())
         and private.staff_has_capability(branch_id, 'customers.view'));

create policy customers_staff_write on public.customers
  for update to authenticated
  using (branch_id in (select private.user_branch_ids())
         and private.staff_has_capability(branch_id, 'customers.view'))
  with check (branch_id in (select private.user_branch_ids())
              and private.staff_has_capability(branch_id, 'customers.view'));

create policy customers_staff_insert on public.customers
  for insert to authenticated
  with check (branch_id in (select private.user_branch_ids())
              and private.staff_has_capability(branch_id, 'customers.view'));

-- STAFF ROSTER --------------------------------------------------------------
-- staff_self_read (unchanged) is what sign-in and getBranchAccess rely on, so narrowing
-- the roster cannot lock anyone out of their own account.
drop policy if exists staff_roster_read on public.staff_members;

create policy staff_roster_read on public.staff_members
  for select to authenticated
  using (
    private.user_is_platform_admin()
    or exists (
      select 1 from public.branches b
       where b.restaurant_id = staff_members.restaurant_id
         and (private.staff_has_capability(b.id, 'staff.manage')
              or private.staff_has_capability(b.id, 'staff.timelog'))
    )
  );

-- DRIVER EARNINGS -----------------------------------------------------------
-- ledger_driver_own (unchanged) keeps a rider's own earnings visible to them.
drop policy if exists ledger_branch_staff_read on public.driver_earnings_ledger;

create policy ledger_branch_staff_read on public.driver_earnings_ledger
  for select to authenticated
  using (branch_id in (select private.user_branch_ids())
         and private.staff_has_capability(branch_id, 'drivers.manage'));
