-- The merchant Customers list now renders each diner's address, which means
-- public.customer_addresses is read by a back-office screen for the first time.
--
-- Its staff policy asked only "are you staff at this branch":
--
--   customer_id in (select c.id from public.customers c
--                    where c.branch_id in (select private.user_branch_ids()))
--
-- while public.customers itself is gated on the customers.view capability
-- (customers_staff_read, added by 20260827210000_scope_sensitive_reads_by_capability.sql).
-- The two agreed only because PostgreSQL applies row-level security to a table
-- referenced inside another table's policy expression, so the nested select on
-- customers was itself filtered and a cook or a server saw nothing. That is a true
-- fact about the engine, not a rule this schema states — and home addresses are the
-- wrong place to depend on an implementation detail two policies apart. Say it out
-- loud instead, with the same predicate the parent table uses.
--
-- This narrows nobody's access in practice: every role that holds customers.view
-- (owner, admin, manager, cashier) keeps it, and the diner's own access is
-- customer_addresses_self, which is untouched.

drop policy if exists customer_addresses_staff on public.customer_addresses;

create policy customer_addresses_staff_read on public.customer_addresses
  for select to authenticated
  using (
    customer_id in (
      select c.id
        from public.customers c
       where private.staff_has_capability(c.branch_id, 'customers.view')
    )
  );

comment on policy customer_addresses_staff_read on public.customer_addresses is
  'Back-office reads of a diner''s saved addresses, gated on the same customers.view capability as public.customers itself.';
