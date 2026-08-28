# Who signs in where

Written 2026-08-29, after the merchant magic-link flow was found to be non-functional in
both dev and production. Describes what ships now, not an aspiration.

## The three apps

| App | Port (dev) | Production | Who |
|---|---|---|---|
| `apps/web` | 3000 | `restaurant-white-label-web.vercel.app` | diners |
| `apps/driver` | 3001 | `restaurant-white-label-driver.vercel.app` | riders |
| `apps/admin` | 3004 | `restaurant-white-label-admin.vercel.app` | every merchant-side role |

There is no separate kitchen or counter app. `apps/pos` and `apps/kds` were merged into
`apps/admin` and now live at `/counter/{branchId}` and `/kitchen/{branchId}`. A tablet in
the kitchen signs into the *same* app as the owner and is held to the kitchen role's
capabilities by `role_capabilities` and RLS.

## Sign-in method per role

| Role | Credential | Screen |
|---|---|---|
| Diner | phone + password, or Google | `/r/{restaurant}/{branch}/sign-in` |
| Driver | phone + password | `:3001/login` |
| Owner | email + password | `:3004/login` |
| Admin | email + password | `:3004/login` |
| Manager | email + password | `:3004/login` |
| Cashier | email + password | `:3004/login` |
| Server | email + password | `:3004/login` |
| Kitchen | email + password | `:3004/login` |

Merchant-side sign-in was magic-link **only** until 2026-08-29. Password is now the default
and the magic link is a fallback behind "Email me a link instead". The reasons for the
switch, in order of weight:

1. A cashier or line cook starting a shift on the restaurant's shared tablet cannot be made
   to open a personal inbox first. Many do not have a work email account at all.
2. `signInWithPassword` returns a session directly. No mail is sent, no redirect allow-list
   is consulted, and no single-use token can be burned by a mail scanner — which removes
   all three failure modes that made the magic link unreliable.
3. It degrades gracefully: if the project's mailer is rate-limited or misconfigured, staff
   can still get in.

## How a person gets their first password

`inviteUserByEmail` creates the account **without** a password, so every invited staff
member needs one issued to them once:

```
owner invites → email arrives → /auth/callback exchanges the code
              → /invite/accept links the staff_members row
              → "Set your password" → /auth/update-password?welcome=1
```

Anyone who predates this flow — including accounts created by the old magic-link-only
signup — has no password and must use **Forgot password?** once. That path is the same
`resetPasswordForEmail` used for genuine resets; GoTrue does not distinguish setting a
first password from replacing one.

## /auth/callback

`apps/admin/src/app/auth/callback/route.ts`. Every email-borne link must land here, never
on the destination page directly.

`@supabase/ssr`'s `createBrowserClient` speaks PKCE: the emailed link returns a `?code=`
that has to be exchanged for a session **server-side**. `apps/web` has had this route since
Google sign-in shipped. `apps/admin` never had one, which is why merchant magic links
silently did nothing — the code arrived and no one spent it. The commit that added the
`/t/[branchId]` secret access link says so in as many words ("the admin app has no
/auth/callback, so magic links do not complete in prod yet"); that link was a workaround
for this bug and can be deleted now that the cause is fixed.

The route handles both token shapes (`?code=` and `?token_hash=&type=`), translates
GoTrue's own `?error=` into readable copy on `/login`, and passes `next` through
`safeNext()` so a hostile link cannot redirect a freshly-minted staff session off-site.

## Two dashboard settings this depends on

Neither can be applied from SQL or a migration. Both are in `CONFIG-CHECKLIST.md`:

- **§1 Redirect URLs** — without the app's origin on the list, GoTrue discards it and sends
  the user to the Site URL instead. Affects magic links, invitations and password resets.
  Password sign-in is unaffected.

  Read back from the live project on 2026-08-29: the three **production** origins are all
  present and correct, so nothing is outstanding there. What is missing is
  `http://localhost:3004/**` and `http://localhost:3001/**` — local development only. That
  is the entire reason a merchant sign-in link opened on a dev machine lands on the
  customer storefront. See CONFIG-CHECKLIST §1 for the probe that reads the list back
  without sending mail.
- **§1b Custom SMTP** — the built-in mailer is rate-limited and returns
  `429 over_email_send_rate_limit`. Invitations and resets fail quietly when it trips.

## Test accounts

`owner@test.com`, `cashier@test.com`, `kitchen@test.com` and `demo-owner@favornoms.local`
carry passwords and active `staff_members` rows. Passwords are not recorded in this repo by
design; reset them from the Supabase dashboard if they are needed.
