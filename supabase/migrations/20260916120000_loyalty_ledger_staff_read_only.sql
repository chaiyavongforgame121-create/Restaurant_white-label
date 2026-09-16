-- Staff could write the loyalty ledger directly. They now only read it.
--
-- loyalty_points_staff and loyalty_tx_staff were FOR ALL policies whose test is "any active staff
-- row at this branch or restaurant" -- private.user_branch_ids() / user_restaurant_ids() do not look
-- at role. So a kitchen or cashier account could
--   PATCH /rest/v1/loyalty_points?restaurant_id=eq.<r>  {"points_balance":999999,"tier":"platinum"}
-- (proved live, rolled back: 9 rows changed by a 'kitchen' user) and then redeem those points for
-- real discounts: redeem_loyalty_points and place-order only check points_balance >= cost. The same
-- policy on loyalty_transactions let them insert, rewrite or delete the history an owner would use
-- to notice.
--
-- Nothing legitimate writes either table as a client role. Every writer is SECURITY DEFINER
-- (orders_on_complete_award_loyalty, redeem_loyalty_points, recompute_loyalty_tiers,
-- issue_birthday_rewards, delete_my_account, set_loyalty_settings -- checked against pg_proc), and
-- place-order writes with the service-role client. So staff keep exactly what the admin screens use
-- -- SELECT -- and the table privileges are narrowed to match, so a future FOR ALL policy cannot
-- quietly reopen this.
--
-- No owner write policy either: a hand-edited balance with no matching ledger row is how the two
-- drift apart. If manual adjustments are ever needed they belong in an owner-gated SECURITY DEFINER
-- function that moves the balance and writes the ledger row together.

begin;

drop policy if exists loyalty_points_staff on public.loyalty_points;
create policy loyalty_points_staff_read on public.loyalty_points
  for select to authenticated
  using ((branch_id is not null and branch_id in (select private.user_branch_ids()))
      or (restaurant_id is not null and restaurant_id in (select private.user_restaurant_ids())));

drop policy if exists loyalty_tx_staff on public.loyalty_transactions;
create policy loyalty_tx_staff_read on public.loyalty_transactions
  for select to authenticated
  using ((branch_id is not null and branch_id in (select private.user_branch_ids()))
      or (restaurant_id is not null and restaurant_id in (select private.user_restaurant_ids())));

revoke insert, update, delete, truncate on public.loyalty_points       from anon, authenticated;
revoke insert, update, delete, truncate on public.loyalty_transactions from anon, authenticated;

commit;
