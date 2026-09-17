# Translating the interface — conventions

Languages: **en** (source), **es**, **vi**, **th**. Library: `next-intl` 3.26 in `apps/web`,
`apps/admin`, `apps/driver`. The language comes from a per-app cookie (see
`UI_LOCALE_COOKIE` in `packages/shared/src/i18n`), else the browser's `Accept-Language`, else
English. English sits under every language at runtime, so an untranslated key shows English.

Read `docs/i18n/GLOSSARY.md` before writing a single translation.

## Where messages live

- `apps/<app>/messages/<locale>/<namespace>.json` — one file per namespace per language. Each file
  is the object under that top-level key: `t('checkout.title')` reads `title` from
  `messages/<locale>/checkout.json`.
- The namespace list is `scripts/i18n/namespaces.json`; the loader
  `apps/<app>/src/i18n/messages.ts` is generated. **Do not edit either** — use the namespaces you
  were assigned. If you truly need another, report it instead of creating it.
- Words printed by `packages/ui` components live in `packages/ui/src/components/ui-strings.tsx`
  (`useUiStrings()`), not in app catalogues.
- The language picker is `<LocaleSwitcher />` from `apps/<app>/src/components/locale-switcher.tsx`.
  It writes the cookie and calls `router.refresh()`, so the new language arrives without a reload
  and a rung-up till, a kitchen board or an invite link's one-time tokens survive the switch. Do
  not use `LanguageSwitcher` from `@favornoms/ui` directly: without `onChange` it reloads the page.
- Placeholder names a database function invents ('Combos', 'Guest', 'Rider') are flagged by the
  function (`band`, `has_name`), and only flagged rows are translated. Never decide by comparing the
  text: a merchant can name a category "Combos".

## Using translations

- Client component: `const t = useTranslations('orders');` then `t('list.empty')`.
- Server component / route / metadata: `const t = await getTranslations('orders');` Replace a static
  `export const metadata` that needs translating with `export async function generateMetadata()`.
- Pure `.ts` modules (models, label tables, reducers) cannot call hooks: have them return a **key
  and params** (or a stable code) and translate where it is rendered. Update their unit tests.
- Module-level label tables: keep the table keyed by the stable value and translate at render:
  `t(\`status.\${order.status}\`)`. Never `t(variable)` with an unbounded value.
- Keys: camelCase, grouped by screen then element: `checkout.payment.cashHint`. Reuse the
  namespace's existing keys where the text is the same.

## Message syntax (ICU)

- Variables: `"Hi {name}"` → `t('greeting', { name })`.
- Plurals — never build English suffixes:
  `"{count, plural, one {# item} other {# items}}"`. Spanish needs `one`/`other`; Thai and
  Vietnamese use only `other` (write `{count, plural, other {# รายการ}}`).
- Choices: `"{role, select, owner {…} other {…}}"`.
- Inline markup: one message per sentence, with tags, rendered with `t.rich`:
  `"Sent to <strong>{email}</strong>."` → `t.rich('sent', { email, strong: (c) => <strong>{c}</strong> })`.
  Links the same way (`link: (c) => <Link href=…>{c}</Link>`).
- Never concatenate translated fragments or assume English word order.
- Apostrophes: in ICU a single quote escapes; write `’` (typographic) in text, or `''` for a literal `'`.

## What must NOT be translated

- **Merchant and user content**: menu item/category names, descriptions, ingredients, modifier
  group/option names, restaurant/branch/brand names, addresses, customer or staff names, order notes,
  review text, chat messages people typed.
- **Data written to the database or sent to the server**, and **values compared in code**. Examples
  already in the code: driver cancel/fail reasons sent as text, chat quick replies sent to customers,
  `'Rejected by kitchen'` written to `orders.cancellation_reason`, allergen presets saved on items,
  loyalty default perk text compared before saving, `=== 'Delivered'`, `UNKNOWN_RESTAURANT_LABEL`
  equality, weekday keys returned by report RPCs. Keep the stored/compared value in English (or a
  code) and translate **only what is displayed**, via a value→label map.
- Error **codes**, enum values, URLs, CSS classes, `console.*`, analytics event names, test ids,
  ARIA roles.
- Legal pages (`/privacy`, `/terms`, `/ccpa`) stay English.
- Printed receipts (`packages/ui/src/printer`) stay English — thermal printer code pages cannot
  print Thai or Vietnamese.

## Errors

- Map known codes to messages in your namespace or the app's `errors` namespace (if assigned).
- An unknown server message must not be shown raw: show a translated generic message
  (`errors.generic` style) and keep the raw text only for logs. Log where support can read it: a
  server component's `console.error` reaches the runtime logs; a client one only reaches the
  user's own devtools.
- A generic "try again" is wrong when retrying cannot work (sold out, rate limited, a unique
  phone number, a session that is gone). Give those codes their own sentence that says what to do.

## Dates, times, numbers, money

- Money: keep `formatCurrency` (US format in every language).
- Dates and times: use next-intl's formatter (`const format = useFormatter(); format.dateTime(d, {…})`,
  server: `getFormatter()`), or `intlLocaleFor(locale)` from `@favornoms/shared` when calling `Intl`
  directly. Never call `toLocaleString()`/`toLocaleDateString()` without a locale. Thai dates stay
  Gregorian (`intlLocaleFor` handles it).
- Relative words ("Today", "Tomorrow", "min", "mi") are translations too.

## Quality bar

- Natural, short UI text a native speaker would ship — not word-for-word. Follow the glossary and
  keep the same term for the same thing within an area.
- Mind length: Spanish and Vietnamese run ~30% longer than English. Buttons, tabs, badges and
  kitchen/counter tiles must still fit; prefer the shorter natural phrasing.
- Thai: no spaces between words except where Thai uses them (between phrases/sentences).

## Before you finish

1. `pnpm --filter @favornoms/<app> exec tsc --noEmit -p tsconfig.json` passes.
2. `pnpm --filter @favornoms/shared exec vitest run src/i18n -t "<app> <namespace>.json"` passes for
   each namespace you touched (same keys, placeholders and tags in all four languages).
3. Unit tests of any file you changed still pass (`pnpm --filter @favornoms/<app> exec vitest run <path>`).
4. No user-visible English string left in your files except the exclusions above.
