# Short storefront addresses from the App name — 2026-10-26 (owner decision)

"When the App name changes, the customer URL must follow it." The owner chose the short form:
`app.favornoms.com/r/hamburger` instead of `app.favornoms.com/r/demo-favornoms/brooklyn`.

## 1. The web address

- Each branch may have a **web address** `branches.public_slug` (text, null = none). With one, the branch's storefront
  lives at `/r/<public_slug>/…` (menu `/r/hamburger`, cart `/r/hamburger/cart`, an order `/r/hamburger/orders/…`).
  Without one it stays at the long form `/r/<restaurant-slug>/<branch-slug>/…`.
- Format: the slug rule (`^[a-z0-9](-?[a-z0-9])*$`, 2–64 characters). Unique across the whole platform,
  case-insensitively, and in **one namespace with restaurant slugs**: the first segment after `/r/` names either a
  restaurant (long form) or a branch's web address, never both. So a web address may not equal any `restaurants.slug`
  or any restaurant-level alias, and a restaurant slug may not equal any web address or web-address alias. A web
  address another branch gave up (a web-address alias, §2) is refused for every other branch too, whether that branch
  is switched on or off; only the branch it points at may take it back. A small reserved list is refused too (`r`,
  `api`, `auth`, `admin`, `app`, `www`, `help`, `privacy`, `terms`, `ccpa`).
- It is set in the branch's **Branding** card, under App name: a "Web address" field pre-filled from the App name
  (lower-case, accents stripped — "Phở Hà Nội" → "pho-ha-noi"; a name that gives nothing, e.g. Thai, leaves the field
  for the merchant to type in Latin letters), editable, with the full address shown and an availability check as they
  type. Saved by `public.set_branch_public_slug(p_branch_id uuid, p_slug text)` (null clears it): `branch.settings`
  at that branch (owner and platform admins included), validates format, reserved words and the namespace, returns the
  new address or a precise error (`slug_invalid`, `slug_reserved`, `slug_taken`). `public.check_public_slug(p_branch_id,
  p_slug)` answers availability for the field. Direct writes to the column are refused (the branch guard).
- The two demo branches with an App name get theirs in the migration: Hamburger → `hamburger`, Food Thai Thai →
  `food-thai-thai` (only when free).

## 2. Old addresses keep working

- When a web address changes or is cleared, the old one becomes an alias (`storefront_path_aliases`, pointing at the
  branch id) so `/r/<old>/…` 308s to the branch's current address.
- That stays true for good: no other branch may take the old address (`slug_taken` from `check_public_slug` and
  `set_branch_public_slug` alike, so a suggestion from the App name is not written), because the branch's printed QR
  codes, installed apps and sent links still carry it and a live address would win over the alias. Only the branch it
  points at may take it back. Releasing one for someone else would be an explicit platform action.
- The long form of a branch that has a web address 308s to the short form: `/r/demo-favornoms/brooklyn/cart?t=abc` →
  `/r/hamburger/cart?t=abc`. Restaurant and branch slug aliases still work and land on the short form.
- Every redirect is a real 308 from the middleware, keeps the rest of the path and the whole query string, and is never
  cached (a stale redirect can loop). A live address always wins over an alias.

## 3. How a short address is served

- `public.resolve_storefront_path(p_first, p_second)` answers, for the first two segments after `/r/`:
  `live` (a long-form pair of a branch with no web address), `short` (p_first is a live web address; also returns the
  branch's restaurant and branch slugs), `redirect` (to a target path: short form or long form) or `none`.
- The middleware **rewrites** `/r/<web-address>/<rest>` internally to `/r/<restaurant>/<branch>/<rest>` (the browser
  keeps the short URL) and tells the app the public base with a request header; `live` and `short` answers are cached
  per instance, `none` for a minute, `redirect` never.
- Everything that builds a customer link uses the branch's **public base** (`/r/<web-address>` or the long form), never
  the route params: storefront navigation and links (server and client — client components get the base from the
  layout, not `useParams`), the app shell's active tab, sign-in / OAuth `next`, Stripe return URLs, the PWA manifest
  `start_url` and `scope` (the app `id` stays the same), `sw.js` path patterns (no-store pages and the tenant root must
  match both forms), the sitemap, admin QR codes and the platform console's storefront links, notify-worker's order and
  storefront links, and the landing page's demo link.
