# Phone + Password Auth (customer-auth / driver-auth)

OTP-less phone auth now requires a **user-chosen password** on every phone signup, for both
diners and drivers. The old deterministic `HMAC(phone, SERVICE_ROLE_KEY)` password is gone —
knowing a phone number is no longer enough to sign in through these functions.

This is **defense-in-depth**. It does **not** remove the need to apply `docs/AUTH-OTPLESS.sql`
(the DB-level `handle_new_user` / `provision_customer_for_branch` / `get_or_create_my_customer`
takeover guards). The raw `/auth/v1/signup` endpoint can still fire the trigger, so that guard
is the real protection for the `customers` / `drivers` rows; leave it in place.

Residual, accepted: there is still **no proof of phone ownership**. Whoever registers a number
first (and sets its password) squats it. For drivers this is capped by KYC + per-branch
approval (a squat lands `kyc_status='pending'` and receives no dispatch).

## Request / response contract (both functions, identical shape)

Mode is explicit, so login vs register is never inferred from account existence.

```
POST { mode:'login',  phone, password }                         -> signInWithPassword(syntheticEmail, password)
POST { mode:'signup', phone, password, ...profile }             -> admin.createUser({ email, password, email_confirm:true, user_metadata }) then sign in
```

- customer-auth also requires `branch_id`; profile field is optional `full_name`.
- driver-auth takes profile under `profile:{ full_name, vehicle_type?, vehicle_plate?, email? }`;
  `full_name` is required (missing -> `needs_profile`).

All expected outcomes are **HTTP 200** with a `status` field (mirrors the pre-existing code);
only method-not-allowed (405) and customer-auth rate-limit (429) use other codes.

| status | when |
| --- | --- |
| `login` (+access_token, refresh_token) | login succeeded |
| `signup` (+access_token, refresh_token) | signup succeeded, session minted |
| `invalid_phone` | phone did not normalize |
| `weak_password` | password < 8 chars (checked BEFORE any auth call) |
| `invalid_credentials` | login: no such account **or** wrong password (not distinguished — anti-enumeration) |
| `account_exists` | signup: phone already registered (tell them to log in) |
| `needs_profile` | driver-auth signup with no `full_name` |
| `invalid_branch` | customer-auth: `branch_id` missing / not a UUID / not a real branch |
| `error` (`mode_required` \| `signup_failed` \| `session_failed`) | contract violation or unexpected auth failure |

Password rule: **minimum 8 characters**, enforced server-side (`weak_password`) and hinted
client-side. No other complexity rule.

`account_exists` detection: `admin.createUser` returns an error whose `code` is `email_exists`
(newer GoTrue) or whose message matches `already ... regist` (older). Any other createUser
error is `error`/`signup_failed`. `invalid_credentials` on login = `signInWithPassword` returns
no session.

No response path mints a token without a successful `signInWithPassword`.

## Deploy

Both functions deploy with **`verify_jwt=false`** (they are the public entry point that mints
the session, so they cannot require a JWT).

- **customer-auth** — NOT yet deployed at all. First deploy.
- **driver-auth** — deployed (version 1) with the old HMAC password. Must be **REDEPLOYED**
  with this change.

```
supabase functions deploy customer-auth --no-verify-jwt
supabase functions deploy driver-auth   --no-verify-jwt
```

(Env already present on both: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`.
customer-auth additionally uses the `check_rate_limit` RPC + `rate_limits` table from v9.5 and
the `provision_customer_for_branch` RPC from `docs/AUTH-OTPLESS.sql`.)

Rate limiting is unchanged: customer-auth keeps its fail-open per-IP (`custauth:ip:*`, 30/10min)
and per-phone (`custauth:phone:*`, 10/10min) buckets; **driver-auth is left un-rate-limited**,
exactly as today (owner decision that a driver must never be locked out mid-shift; the same
reasoning that keeps it un-entitlement-gated). If a limiter is wanted later, mirror
customer-auth's fail-open `check_rate_limit` reuse.

## Legacy: 3 synthetic driver accounts must be reset (admin action, NOT automated)

There are **0** legacy phone customers (clean slate) but **3** legacy driver accounts
`d…@driver.favornoms.local` created with the old HMAC password. After this ships they will get
`invalid_credentials` on every login, because a user-chosen password can never match the HMAC.

Do **not** auto-migrate them — re-deriving/re-setting the HMAC password programmatically would
re-open the very takeover this change closes. Reset them by hand, one of two clean ways.

Read-only findings (verified 2026-08-11) that back the recommendation:

- `select count(*) from auth.users where email like '%@driver.favornoms.local'` → **3**.
- FK `drivers_user_id_fkey` (`drivers.user_id → auth.users`) is **ON DELETE SET NULL**
  (`confdeltype='n'`). So deleting the auth user does **not** delete the drivers row — it
  orphans it (`user_id → NULL`) and **preserves** the rider's history (earnings, withdrawals,
  deliveries, ratings all FK to `drivers.id`, which is untouched).
- `drivers` has a plain **UNIQUE(phone)**. `handle_new_user`'s
  `ON CONFLICT (phone) DO UPDATE SET user_id = EXCLUDED.user_id WHERE drivers.user_id IS NULL …`
  guard therefore **re-claims** that orphaned row on re-registration (the `user_id IS NULL`
  branch passes), so the rider keeps their id and history.
- `driver_earnings_ledger → drivers` is ON DELETE RESTRICT, but that never fires here because
  we are **not** deleting the drivers row — only the auth.users row.

**Option (a) — RECOMMENDED: delete the 3 `auth.users` rows; riders re-register.**
Each rider signs up again with a password they choose (no admin ever knows it — the point of
this change). Because of ON DELETE SET NULL + the ON CONFLICT(phone) guard above, re-signup
re-attaches to the existing orphaned drivers row, so **no drivers-row cleanup is needed** and
earnings/withdrawals/delivery history are preserved. Delete via the Auth dashboard
(Authentication → Users) or the Admin API `DELETE /auth/v1/admin/users/{id}`.

**Option (b) — zero-disruption: set a known temporary password.**
Use the Auth admin API `PUT /auth/v1/admin/users/{id}` (or dashboard → user → reset/update
password) to set a temp password ≥ 8 chars on each of the 3 users, then give it to the rider.
Nothing in the DB changes. Trade-off: an admin-known password persists until the rider changes
it, and there is **no self-serve password-change flow yet** — so (a), where each rider sets
their own secret, is the cleaner end state.

Do not run either from this lane — this note is for a human/admin to execute.
