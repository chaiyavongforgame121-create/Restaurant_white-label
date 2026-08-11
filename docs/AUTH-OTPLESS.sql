-- AUTH-OTPLESS.sql — SQL for the OTP-less phone login + Google OAuth lane.
-- DO NOT APPLY BLIND. Review, then run in the Supabase SQL editor.
-- Every statement is idempotent (CREATE OR REPLACE) and safe to re-run.
--
-- Context: diners now sign in either
--   (a) by phone, via the `customer-auth` edge function, which creates a synthetic auth
--       user  c{digits}@customer.favornoms.local  with the real phone in user_metadata
--       (auth.users.phone stays NULL — we never touch Supabase's phone provider), or
--   (b) with Google, via signInWithOAuth, which cannot carry user_metadata at all.
-- Both break assumptions the existing functions made, hence the patches below. Sections 1,
-- 2 and 3 additionally carry the SAME account-takeover guard on their customers upsert:
-- OTP-less signup makes a phone number an attacker-controlled string rather than proof of
-- identity, so no upsert here may re-point an already-owned customers row at its caller.


-- ---------------------------------------------------------------------------
-- 1. get_or_create_my_customer — read the phone from metadata as well.
--
-- WHY: the live version reads `u.phone` only. Synthetic-email accounts have
-- auth.users.phone = NULL, so it would insert customers.phone = NULL. That silently
-- defeats the `(restaurant_id, phone) WHERE phone IS NOT NULL` dedupe index, so the same
-- diner would accumulate a fresh customers row (and a fresh points balance) per call.
--
-- This is a copy of the LIVE definition (pg_get_functiondef, fetched 2026-08-11) with TWO
-- changes:
--   1. select u.phone       -> select coalesce(u.phone, u.raw_user_meta_data ->> 'phone')
--   2. the account-takeover guard on the ON CONFLICT DO UPDATE (see below)
--
-- NOT changed (pre-existing, unrelated to this lane): its INSERT can still raise
-- unique_violation on customers_restaurant_user_uidx under concurrent calls, because the
-- ON CONFLICT target only covers (restaurant_id, phone). provision_customer_for_branch
-- below guards against that; this one is left alone because that race is a 500 on a
-- settings screen, not a security hole, and swallowing it is a separate change.
--
-- !! SECURITY — takeover CLOSED HERE by change 2. The two changes must ship together. !!
-- Change 1 is what ARMS the hole. Before it, synthetic phone accounts had
-- auth.users.phone = NULL, so this INSERT wrote phone NULL, the index's
-- `where phone is not null` predicate never matched, and the unguarded
-- `do update set user_id = excluded.user_id` was unreachable for exactly the users who
-- can be impersonated. Reading the phone out of user_metadata makes it match. So applying
-- change 1 alone would OPEN a takeover reachable from the account Settings and Addresses
-- screens: sign in by phone (OTP-less — no SMS, so knowing the number is the whole
-- credential) with a victim's number, open Settings, and their customers row — and with it
-- loyalty_points, customer_addresses, promo_redemptions and order history — re-points at
-- the attacker. Change 2 is the same guard sections 2 and 3 carry, so all three upserts
-- that can claim a customers row now agree on what is claimable.
--
-- RESIDUAL, accepted: a genuine dual-account diner (Google *and* OTP-less phone at the
-- same brand) loses the silent merge. The guard cannot distinguish that diner from an
-- attacker — both present as "a different user_id already owns this phone" — so it
-- refuses, and the function returns NULL. Both live callers already tolerate NULL without
-- crashing (they bail on a falsy id): settings-view.tsx renders an empty profile form and
-- addresses-view.tsx an empty address book, and Save/Add silently no-op. Degraded, not
-- broken, and it fails in the safe direction. Merging two real identities needs a
-- verified-ownership step, which is a product decision and not this patch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_or_create_my_customer(p_branch_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  v_rest uuid;
  v_cid uuid;
  v_phone text;
  v_name text;
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select restaurant_id into v_rest from public.branches where id = p_branch_id;
  if v_rest is null then raise exception 'branch_not_found'; end if;

  select id into v_cid from public.customers
   where user_id = v_user and restaurant_id = v_rest order by created_at limit 1;
  if v_cid is not null then return v_cid; end if;

  -- CHANGED: phone now falls back to user_metadata for OTP-less phone accounts.
  select coalesce(u.phone, u.raw_user_meta_data ->> 'phone'),
         u.raw_user_meta_data ->> 'full_name'
    into v_phone, v_name
    from auth.users u where u.id = v_user;

  insert into public.customers (restaurant_id, branch_id, user_id, phone, full_name, preferred_language)
  values (v_rest, p_branch_id, v_user, v_phone, v_name, 'en')
  -- ADDED: account-takeover guard, identical to sections 2 and 3. Claim only an
  -- unclaimed GUEST row (user_id is null) or one already ours. See the header block.
  on conflict (restaurant_id, phone) where phone is not null do update set user_id = excluded.user_id
    where public.customers.user_id is null or public.customers.user_id = excluded.user_id
  returning id into v_cid;

  -- Recovery read, keyed on user_id and NEVER on phone. When the guard above refuses a
  -- foreign row the statement touches zero rows, returning yields nothing and v_cid stays
  -- null; this select then finds nothing either (the identical lookup at the top of the
  -- function already missed), so the function returns NULL rather than the foreign row.
  if v_cid is null then
    select id into v_cid from public.customers
     where user_id = v_user and restaurant_id = v_rest order by created_at limit 1;
  end if;
  return v_cid;
end $function$;


-- ---------------------------------------------------------------------------
-- 2. provision_customer_for_branch — idempotent "make sure I have a profile here".
--
-- WHY two callers need this:
--   • customer-auth: a returning diner signing in at a brand they have never ordered
--     from takes the LOGIN path, so on_auth_user_created never fires again and no
--     customers row exists for that restaurant.
--   • /auth/callback: signInWithOAuth has no `data` option, so a Google SIGNUP reaches
--     handle_new_user with no signup_type/branch_id and is skipped entirely.
--
-- Mirrors handle_new_user's customer branch exactly (same columns, same ON CONFLICT
-- shape) so the two cannot drift, plus an email column handle_new_user does not set.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_customer_for_branch(p_branch_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user  uuid := auth.uid();
  v_rest  uuid;
  v_cid   uuid;
  v_phone text;
  v_name  text;
  v_email text;
BEGIN
  -- Guard: callable only with a session. Returns NULL rather than raising so the
  -- non-fatal callers (edge function, OAuth callback) never turn this into a 500.
  IF v_user IS NULL THEN RETURN NULL; END IF;

  SELECT restaurant_id INTO v_rest FROM public.branches WHERE id = p_branch_id;
  IF v_rest IS NULL THEN RETURN NULL; END IF;

  -- Already have an identity at this brand (loyalty is brand-scoped, not branch-scoped).
  SELECT id INTO v_cid FROM public.customers
   WHERE user_id = v_user AND restaurant_id = v_rest ORDER BY created_at LIMIT 1;
  IF v_cid IS NOT NULL THEN RETURN v_cid; END IF;

  SELECT COALESCE(u.phone, u.raw_user_meta_data ->> 'phone'),
         COALESCE(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
         -- The synthetic c{digits}@customer.favornoms.local address is a login artefact,
         -- not a mailbox. Storing it would leak it into Settings and into any campaign
         -- that emails customers.email.
         NULLIF(CASE WHEN u.email LIKE '%@customer.favornoms.local' THEN '' ELSE u.email END, '')
    INTO v_phone, v_name, v_email
    FROM auth.users u WHERE u.id = v_user;

  -- Same ON CONFLICT shape as handle_new_user: claim the guest row this diner's phone
  -- already created, rather than starting a second points balance.
  --
  -- SECURITY GUARD (`WHERE customers.user_id IS NULL OR ... = EXCLUDED.user_id`):
  -- prevents ACCOUNT TAKEOVER. Phone sign-in is OTP-less, so anyone who knows a phone
  -- number can mint a session for it. Without this predicate the upsert would re-point an
  -- EXISTING, ALREADY-OWNED customers row at the caller — and a diner who signed in with
  -- Google or a magic link has phone P on their row as soon as place-order or Settings
  -- writes it. customers.id keys loyalty_points, customer_addresses, promo_redemptions and
  -- order history, so the victim's balance, address book and order history would all move
  -- to the attacker. The guard narrows the claim to what was actually intended: an
  -- unclaimed GUEST row (user_id IS NULL), or the caller's own row.
  --
  -- The second disjunct is not redundant: with only `user_id IS NULL`, a repeat call by
  -- the SAME user would update zero rows and RETURNING would yield nothing, so the
  -- function would report no id for a row it legitimately owns.
  --
  -- When the predicate is FALSE (a genuinely foreign row owns this phone) the statement
  -- affects zero rows and raises nothing, so v_cid stays NULL and we fall to the recovery
  -- SELECT below. That SELECT keys on `user_id = v_user`, NEVER on phone, so it cannot
  -- hand back the foreign row either — the function correctly returns NULL and the diner
  -- simply gets no profile at this brand rather than someone else's.
  --
  -- The EXCEPTION block matters. customers carries a SECOND partial unique index,
  -- customers_restaurant_user_uidx (restaurant_id, user_id) WHERE user_id IS NOT NULL,
  -- which the ON CONFLICT target does not cover. Two concurrent calls — or a Google user
  -- with phone NULL, where the phone conflict clause never applies — would otherwise raise
  -- and abort the caller's transaction. Both callers treat this as best-effort, so swallow
  -- the race and re-read the winner's row.
  BEGIN
    INSERT INTO public.customers (restaurant_id, branch_id, user_id, phone, email, full_name, preferred_language)
    VALUES (v_rest, p_branch_id, v_user, v_phone, v_email, v_name, 'en')
    ON CONFLICT (restaurant_id, phone) WHERE phone IS NOT NULL DO UPDATE SET user_id = EXCLUDED.user_id
      WHERE public.customers.user_id IS NULL OR public.customers.user_id = EXCLUDED.user_id
    RETURNING id INTO v_cid;
  EXCEPTION WHEN unique_violation THEN
    v_cid := NULL;
  END;

  -- Recovery read. Deliberately keyed on user_id (the authenticated caller), NOT on phone:
  -- if the guard above refused a foreign row, this must not quietly return that same row.
  IF v_cid IS NULL THEN
    SELECT id INTO v_cid FROM public.customers
     WHERE user_id = v_user AND restaurant_id = v_rest ORDER BY created_at LIMIT 1;
  END IF;
  RETURN v_cid;
END $function$;

REVOKE ALL ON FUNCTION public.provision_customer_for_branch(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.provision_customer_for_branch(uuid) TO authenticated;


-- ---------------------------------------------------------------------------
-- 3. handle_new_user — same account-takeover guard on BOTH branches.
--
-- WHY NOW: this trigger fires on every auth.users insert. Before this lane it only ever
-- saw customer signups that had gone through a magic link or a merchant form. OTP-less
-- phone signup now reaches it too, which means an unauthenticated party who knows a phone
-- number can drive this INSERT. Its `DO UPDATE SET user_id = EXCLUDED.user_id` had no
-- owner check, so a signup with victim phone P silently re-pointed the victim's existing
-- customers row — and with it loyalty_points, customer_addresses, promo_redemptions and
-- order history — at the freshly minted attacker account.
--
-- This is a byte-for-byte copy of the LIVE definition (pg_get_functiondef, fetched
-- 2026-08-11) with TWO additions: a WHERE on each branch's DO UPDATE. Both guards still
-- allow the intended case (claiming an unclaimed GUEST row, user_id IS NULL) and a repeat
-- signup by the same user, and nothing else.
--
-- The DRIVER branch carries the identical primitive and is the more urgent of the two:
-- driver-auth is already DEPLOYED and live (verify_jwt=false), and drivers has a plain
-- UNIQUE (phone) rather than a partial index, so the ON CONFLICT always fires. Knowing a
-- rider's phone number was enough to take over their driver account — their earnings,
-- withdrawals and delivery history. Guarding it here is not scope creep; leaving the
-- customer branch fixed while this one stayed open would just move the door.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_signup_type text;
  v_branch_id   uuid;
  v_restaurant_id uuid;
  v_full_name   text;
  v_phone       text;
BEGIN
  v_signup_type := NEW.raw_user_meta_data ->> 'signup_type';
  v_branch_id   := NULLIF(NEW.raw_user_meta_data ->> 'branch_id', '')::uuid;
  v_full_name   := NEW.raw_user_meta_data ->> 'full_name';
  v_phone       := COALESCE(NEW.phone, NEW.raw_user_meta_data ->> 'phone');

  IF v_signup_type = 'customer' AND v_branch_id IS NOT NULL THEN
    SELECT restaurant_id INTO v_restaurant_id FROM public.branches WHERE id = v_branch_id;
    IF v_restaurant_id IS NOT NULL THEN
      INSERT INTO public.customers (restaurant_id, branch_id, user_id, phone, full_name, preferred_language)
      VALUES (v_restaurant_id, v_branch_id, NEW.id, v_phone, v_full_name, 'en')
      -- ADDED: account-takeover guard. Only claim an unowned guest row, or one already
      -- ours. Without it, signing up with someone else's phone number stole their row.
      ON CONFLICT (restaurant_id, phone) WHERE phone IS NOT NULL DO UPDATE SET user_id = EXCLUDED.user_id
        WHERE public.customers.user_id IS NULL OR public.customers.user_id = EXCLUDED.user_id;
    END IF;
  ELSIF v_signup_type = 'driver' THEN
    INSERT INTO public.drivers (user_id, phone, full_name, vehicle_type, kyc_status)
    VALUES (NEW.id, v_phone, COALESCE(v_full_name, 'Driver'), 'motorcycle', 'pending')
    -- ADDED: same guard as the customer branch. driver-auth is live and unverified, so a
    -- phone number is an attacker-controlled string, not proof of identity.
    ON CONFLICT (phone) DO UPDATE SET user_id = EXCLUDED.user_id
      WHERE public.drivers.user_id IS NULL OR public.drivers.user_id = EXCLUDED.user_id;
  END IF;
  RETURN NEW;
END;
$function$;


-- ---------------------------------------------------------------------------
-- 4. Rate limiting — NO DDL NEEDED.
--
-- customer-auth reuses the generic public.check_rate_limit(p_bucket_key, p_max_count,
-- p_window_seconds) + public.rate_limits table added for place-order in v9.5, under new
-- bucket keys `custauth:ip:<ip>` and `custauth:phone:<digits>`. Nothing to create here;
-- this note exists so the reuse is on the record.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Verification (run after applying):
--   select public.provision_customer_for_branch('<a real branch uuid>');  -- as a signed-in user
--   select proname, pronargs from pg_proc
--    where proname in ('get_or_create_my_customer','provision_customer_for_branch','handle_new_user');
--
--   -- ALL THREE takeover guards are present (expect 3 rows). ilike, because section 1's
--   -- copy keeps the live function's lower-case style:
--   select proname from pg_proc
--    where proname in ('get_or_create_my_customer','provision_customer_for_branch','handle_new_user')
--      and prosrc ilike '%user_id IS NULL OR public.customers.user_id = EXCLUDED.user_id%';
--
--   -- and the guard is not silently absent from the one function whose OTHER change is
--   -- what makes the phone index match in the first place (expect 1 row — if this returns
--   -- 0 while the metadata read landed, section 1 shipped half-applied and is EXPLOITABLE):
--   select proname from pg_proc
--    where proname = 'get_or_create_my_customer'
--      and prosrc ilike '%raw_user_meta_data ->> ''phone''%'
--      and prosrc ilike '%user_id IS NULL OR public.customers.user_id = EXCLUDED.user_id%';
--
--   -- the DRIVER branch guard landed too (expect 1 row). Checked separately because the
--   -- query above only matches the public.customers spelling:
--   select proname from pg_proc
--    where proname = 'handle_new_user'
--      and prosrc ilike '%user_id IS NULL OR public.drivers.user_id = EXCLUDED.user_id%';
--
--   -- the trigger still points at the replaced function:
--   select tgname, tgrelid::regclass from pg_trigger where tgname = 'on_auth_user_created';
-- ---------------------------------------------------------------------------
