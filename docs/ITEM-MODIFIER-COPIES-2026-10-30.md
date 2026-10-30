# A dish's own option groups — 2026-10-30 (owner decision)

"When I delete an option of a modifier inside a dish, it deletes it from the main modifier too. I only
want to pick the group to show it; if I change or delete something, save it in that dish only, never
over the main modifier."

## 1. Two kinds of option group

- **Library group** (`modifier_groups.owner_menu_item_id` null): listed on the Modifier groups page
  (`/b/<branch>/menu/modifiers`). Any dish of the branch may show it. Editing it there changes every dish
  that shows it directly.
- **A dish's own group** (`owner_menu_item_id` = the dish): shown on that dish only, never listed in the
  library, deleted with the dish. Either the dish's copy of a library group (`source_group_id` = that
  library group) or a group made in the dish's editor (no source).

Every group that existed before 2026-10-30 is a library group.

## 2. The dish's editor never writes to a library group

- The first change made to a library group in a dish's editor (rename, rules, an option's name, price,
  default or active switch, adding, deleting or reordering an option) gives the dish its own copy
  (`customize_item_modifier_group`): the group and its options are copied, the dish shows the copy where it
  showed the library group, and the change lands on the copy. The library group and every other dish are
  untouched; later library edits do not reach the copy. A click that changes nothing makes no copy.
- Moving a group up or down on a dish is per dish already and copies nothing.
- **Remove** takes a library group off this dish only; a dish's own group is deleted.
- **Use the library version** (`reset_item_modifier_group`) puts the library group back where the copy was
  and deletes the copy.
- **Add group** makes a group that belongs to the dish. **Add from Modifier groups** shows a library group
  on the dish (also for a dish not saved yet).
- The Modifier groups page shows "N customized" for dishes that carry their own copy, and its link picker
  will not put a library group on a dish that already shows its own copy of it (the database refuses it
  too).

## 3. A dish orders only its own groups' options

place-order (v11.10) refuses an option whose group is not shown on that line's dish
(`400 modifier_inactive, reason not_on_item, item_id`): a cart built before a copy cannot still order an
option the copy deleted. The storefront cart takes such a line out when it opens, the checkout takes out
only that dish's lines, and Order again carries a past choice over to the dish's copy by name (or leaves a
dish out rather than re-add it without a required choice).

## 4. Other places

- `copy_branch_setup` copies library groups first, then the dishes' own groups pointing at the target's
  dishes and library groups.
- `duplicate_menu_item` copies no option groups (unchanged; it never did).
- Migration `20261030100000_item_modifier_copies.sql`, rolled-back checks
  `supabase/tests/item_modifier_copies.sql`. Deploy order: place-order v11.10, then the migration, then the
  admin and storefront together.
