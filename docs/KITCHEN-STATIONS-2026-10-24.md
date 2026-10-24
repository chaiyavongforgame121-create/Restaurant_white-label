# Kitchen stations the merchant manages — 2026-10-24 (owner request)

"How do I add a kitchen station on the menu page? Adding, removing and editing must reach the other pages too."

Until now the stations were a fixed list in code (`hot`, `cold`, `bar`, `dessert`, `expo`). Each branch now keeps its
own list: add, rename, reorder and delete, by anyone who may edit the menu (`menu.manage`).

## 1. Identity: a key that never changes, a name that can

- `public.kitchen_stations(id, branch_id, key, name, display_order, created_at, updated_at)`.
- **`key`** is what `menu_items.station`, `order_items.station`, `order_items.combo_contents[].station` and the kitchen
  board's `?station=` already hold. It never changes after insert (a guard refuses it), so a rename rewrites no dish and
  no order line, an open board keeps every ticket where it is, and a tablet pinned to `?station=hot` keeps its filter.
  - The five built-ins keep their keys `hot`, `cold`, `bar`, `dessert`, `expo`.
  - A new station gets an opaque key `st_<10 hex>` from the database (Thai names do not slugify, and a name-based key
    would go stale on rename). The client never chooses it.
  - CHECK `key ~ '^[a-z0-9_-]{1,40}$'` and `key <> '_none'` (the board's "No station" pill).
- **`name`**: what people see, 1–40 characters after trimming. A built-in may have `name = null`, which means "show the
  built-in's translated label" (`stations.<key>` in every language); renaming a built-in sets `name`, and clearing it
  goes back to the translation. A custom station always has a name. Names are unique per branch (case-insensitive).
- `display_order`: the order everywhere (menu dropdown, stations sheet, kitchen pills).

`menu_items (branch_id, station)` references `kitchen_stations (branch_id, key)` (NO ACTION, MATCH SIMPLE), so a dish
can only name a station its branch has; `null` is "No station". An empty string is stored as `null`. Order lines and
combo snapshots get no foreign key: they are history.

## 2. Rules

- **Every branch starts with the five built-ins** (display_order 10–50, `name` null): existing branches by backfill,
  new branches by an AFTER INSERT trigger on `branches`.
- **Read**: staff of the branch (`private.user_branch_ids()`), so the kitchen and the counter can label lines.
  **Insert / update**: `private.staff_has_capability(branch_id, 'menu.manage')`. **Delete**: only through
  `public.delete_kitchen_station`.
- **Delete** — `public.delete_kitchen_station(p_station_id uuid, p_move_to text default null, p_clear boolean default
  false) returns int`: `menu.manage` at that branch; `p_move_to` is another station key of the same branch, or null
  for "No station". "No station" must be asked for with `p_clear => true`: with neither a target nor `p_clear`, a
  station still on a dish is refused (`station_in_use`), so a page that last saw the station unused cannot empty one
  that another device has since given dishes. It moves the station's dishes (the existing follow trigger then moves
  their unmade lines on active orders), then also moves what that trigger deliberately leaves: lines already made on
  active orders and the combo entries naming the deleted key, so no ticket on an open board is left under a key nobody
  can name. Closed orders keep the old key; one that comes back onto the board (the kitchen's Undo of a bump) has its
  lines and combo entries under a deleted key moved to their dish's current station, or none. A combo line's entries
  take their dishes' current stations when the line is inserted. Accepted: a line inserted in the milliseconds while a
  delete runs can keep the deleted key (it shows under All and its own pill). Returns how many dishes moved.
- **Reorder** — `public.reorder_kitchen_stations(p_branch_id uuid, p_ids uuid[])`, `menu.manage`, all ids of the
  branch in their new order.
- **Copy a branch's setup** (`copy_branch_setup`, menu part) copies the source's stations into the target (by key,
  names and order included) before the dishes. **Franchise broadcast** (`broadcast_franchise_menu`) adds to each target
  the source stations its broadcast dishes use, by key, leaving the target's own stations alone.
- `kitchen_stations` is in the `supabase_realtime` publication. It does not bump the storefront version: customers
  never see stations.

## 3. Surfaces

- **Menu page**: the item dialog's Kitchen station list is the branch's stations in order ("No station" first), with
  a "+ New" that creates one inline (like categories); a **Kitchen stations** sheet (like Categories) lists them with
  rename, reorder, add, and delete with "move its dishes to …". Labels: `name`, or the built-in's translation.
- **Kitchen board**: station pills and labels come from the branch's stations (state seeded by the server read,
  re-read on any `kitchen_stations` realtime event and on reconnect/focus). Pills are the stations in use (an active
  dish or a line on the board), in `display_order`, plus "No station" when a line has none, plus any unknown key from
  an old line, last. A merchant-typed name is shown as typed (no CSS capitalize). If the filtered station is deleted,
  the board falls back to All and clears `?station=`.
- **CSV import**: a station is matched by key or name (case-insensitive, also the built-in labels); an unknown name
  creates the station, as unknown categories already do; a blank station is "No station" (it used to become `expo`).
- **Copy setup / franchise** copy texts mention stations.
- The POS counter's read-only kitchen view, receipts, reports and the storefront do not use stations.
