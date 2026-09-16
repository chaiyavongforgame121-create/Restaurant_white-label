-- Branch-scoped policies follow the same "who manages this branch" rule as everything else.
--
-- A merchant with two branches could not save opening hours for the second one:
--   new row violates row-level security policy for table "branch_hours"
-- Every one of these policies was written by hand as
--   exists (select 1 from staff_members where user_id = auth.uid()
--             and branch_id = <table>.branch_id and role in (...))
-- which is wrong in three ways that the database's own helpers already get right:
--   * the restaurant's OWNER is not considered at all unless they happen to hold a staff row
--     on that exact branch — and create_branch does not write one, so the branch a merchant
--     just opened is a branch they cannot configure;
--   * a staff row with branch_id NULL means "all branches" everywhere else, and matched nothing
--     here;
--   * status was never checked, so an invited-but-not-accepted row counted as access.
-- private.user_manages_branch() (owner/admin/manager), private.user_branch_ids() (any branch the
-- caller works in) and private.user_owns_restaurant() are the existing, tested answers; these
-- policies now use them. Nothing here widens a role's reach beyond what its screen already
-- allowed for the branch it was written against.

begin;

-- Weekly opening hours.
drop policy if exists branch_hours_owner_manager_write on public.branch_hours;
create policy branch_hours_owner_manager_write on public.branch_hours
  for all to public
  using (private.user_manages_branch(branch_id))
  with check (private.user_manages_branch(branch_id));

-- Holiday closures.
drop policy if exists branch_closures_owner_manager_write on public.branch_closures;
create policy branch_closures_owner_manager_write on public.branch_closures
  for all to public
  using (private.user_manages_branch(branch_id))
  with check (private.user_manages_branch(branch_id));

-- Promotions.
drop policy if exists promos_owner_manager_write on public.promos;
create policy promos_owner_manager_write on public.promos
  for all to public
  using (private.user_manages_branch(branch_id))
  with check (private.user_manages_branch(branch_id));

-- Happy hours.
drop policy if exists happy_hours_owner_manager on public.happy_hours;
create policy happy_hours_owner_manager on public.happy_hours
  for all to public
  using (private.user_manages_branch(branch_id))
  with check (private.user_manages_branch(branch_id));

-- Rider peak-hour bonuses.
drop policy if exists peak_hour_owner_manager on public.peak_hour_bonuses;
create policy peak_hour_owner_manager on public.peak_hour_bonuses
  for all to public
  using (private.user_manages_branch(branch_id))
  with check (private.user_manages_branch(branch_id));

-- Tax invoices: managers write, and anyone who works in the branch may read.
drop policy if exists tax_invoices_owner_manager_write on public.tax_invoices;
create policy tax_invoices_owner_manager_write on public.tax_invoices
  for all to public
  using (private.user_manages_branch(branch_id))
  with check (private.user_manages_branch(branch_id));

drop policy if exists tax_invoices_staff_read on public.tax_invoices;
create policy tax_invoices_staff_read on public.tax_invoices
  for select to public
  using (branch_id in (select private.user_branch_ids()));

-- Food safety logs: the whole branch team, kitchen and cashiers included.
drop policy if exists food_safety_branch_staff on public.food_safety_logs;
create policy food_safety_branch_staff on public.food_safety_logs
  for all to public
  using (branch_id in (select private.user_branch_ids()))
  with check (branch_id in (select private.user_branch_ids()));

-- Integrations stay owner-only, but "owner" now means the restaurant's owner too.
drop policy if exists integrations_owner_only on public.integrations;
create policy integrations_owner_only on public.integrations
  for all to public
  using (exists (
    select 1 from public.branches b
     where b.id = integrations.branch_id and private.user_owns_restaurant(b.restaurant_id)))
  with check (exists (
    select 1 from public.branches b
     where b.id = integrations.branch_id and private.user_owns_restaurant(b.restaurant_id)));

-- Gift cards: the buyer, or whoever manages the branch that issued it.
drop policy if exists gift_cards_owner_read on public.gift_cards;
create policy gift_cards_owner_read on public.gift_cards
  for select to public
  using (purchased_by = auth.uid() or (branch_id is not null and private.user_manages_branch(branch_id)));

-- Duplicating a dish carried its own copy of the same hand-written check, so Copy on a branch
-- the merchant owns but holds no staff row for raised not_authorized.
create or replace function public.duplicate_menu_item(p_item_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_src public.menu_items%rowtype;
  v_new_id uuid;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into v_src from public.menu_items where id = p_item_id;
  if not found then raise exception 'item_not_found'; end if;
  if not private.user_manages_branch(v_src.branch_id) then raise exception 'not_authorized'; end if;
  insert into public.menu_items (
    branch_id, category_id, name, name_translations, description, description_translations,
    price, cost, image_url, image_urls, is_active, is_recommended, is_new, available_channels,
    track_stock, stock_quantity, low_stock_threshold, allergens, dietary_tags, prep_time_minutes,
    calories, station, display_order
  ) values (
    v_src.branch_id, v_src.category_id, v_src.name || ' (Copy)', v_src.name_translations,
    v_src.description, v_src.description_translations, v_src.price, v_src.cost, v_src.image_url,
    v_src.image_urls, false, v_src.is_recommended, false, v_src.available_channels,
    v_src.track_stock, v_src.stock_quantity, v_src.low_stock_threshold, v_src.allergens,
    v_src.dietary_tags, v_src.prep_time_minutes, v_src.calories, v_src.station, v_src.display_order + 1
  ) returning id into v_new_id;
  return v_new_id;
end $function$;

commit;
