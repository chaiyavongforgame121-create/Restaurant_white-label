-- invite-staff looks up an existing auth account without minting a sign-in token.
--
-- When inviteUserByEmail refuses an address that already has an account, invite-staff needs to
-- know whether that person can already sign in (an account they made themselves, a password set,
-- or a Google identity) or must be emailed a set-password link. It used generateLink('magiclink')
-- as the lookup. GoTrue's generateLink for a magic link stores a recovery token and stamps
-- recovery_sent_at, so the resetPasswordForEmail that followed for the same person hit the
-- per-user email interval (60 s) and no set-password email was ever sent. This reads the same
-- facts straight from auth, minting nothing. service_role only.
create or replace function public.invite_lookup_auth_user(p_email text)
returns table (id uuid, invited_at timestamptz, password_set boolean, has_other_sign_in boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id,
         u.invited_at,
         coalesce(u.raw_user_meta_data ->> 'password_set', '') = 'true',
         exists (select 1 from auth.identities i where i.user_id = u.id and i.provider <> 'email')
    from auth.users u
   where lower(u.email) = lower(btrim(p_email))
   limit 1
$$;

revoke all on function public.invite_lookup_auth_user(text) from public, anon, authenticated;
grant execute on function public.invite_lookup_auth_user(text) to service_role;

comment on function public.invite_lookup_auth_user(text) is
  'invite-staff only (service_role): whether an existing auth account can already sign in, read without minting a token.';
