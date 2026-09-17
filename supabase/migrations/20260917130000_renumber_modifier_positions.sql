-- Option groups and options keep one position each.
--
-- The storefront and the counter now show option groups and options in the order the merchant
-- arranged them (menu_item_modifiers.display_order, modifier_options.display_order). Until now the
-- options were sorted by price, which hid the positions, and new rows were numbered with the list
-- length, so a row added after a deletion could share its position with another (one item here had
-- two groups at the same position). Ties are broken by creation time in the reader, but equal
-- positions also make "move up / move down" ambiguous, so every list is renumbered 0..n-1 in the
-- order it is shown today. Idempotent: rows already in place are not touched.

with ranked as (
  select o.id,
         row_number() over (
           partition by o.group_id
           order by coalesce(o.display_order, 0), o.created_at, o.id
         ) - 1 as pos
    from public.modifier_options o
)
update public.modifier_options o
   set display_order = r.pos
  from ranked r
 where o.id = r.id
   and o.display_order is distinct from r.pos;

with ranked as (
  select l.menu_item_id,
         l.modifier_group_id,
         row_number() over (
           partition by l.menu_item_id
           order by coalesce(l.display_order, 0), coalesce(g.display_order, 0), g.created_at, g.id
         ) - 1 as pos
    from public.menu_item_modifiers l
    join public.modifier_groups g on g.id = l.modifier_group_id
)
update public.menu_item_modifiers l
   set display_order = r.pos
  from ranked r
 where l.menu_item_id = r.menu_item_id
   and l.modifier_group_id = r.modifier_group_id
   and l.display_order is distinct from r.pos;
