# Deleting removed staff, and a trial for an existing account — 2026-11-12 (owner report)

"I removed it but it still doesn't work. Look at this email: delete its invite outright, and make it
possible to invite again." The address had been invited as Kitchen at the demo store, had accepted
and set a password, and was later removed. Starting a trial with it on /signup said "That email
already has an account" with nothing to press: removing someone from a restaurant takes their
access there, never their sign-in account, which belongs to them (the same project holds every
storefront diner, rider and staff member).

The owner's row was deleted on request on 2026-11-12 (no orders, payments, shifts or sittings
pointed at it; one `staff_invite_deleted` audit row). The account itself was kept.

## 1. /signup with an address that already has an account

- GoTrue answers such a signup with an identity-less user (`user_repeated_signup`). The page now
  tries `signInWithPassword` with what was typed (`existing-account.ts`):
  - the password is theirs: straight to /onboarding, which starts the trial;
  - `invalid_credentials` (another password, or none: Google-only or magic-link-era accounts): a
    panel names the address, points at Continue with Google, and offers "Email me a link to set a
    new password" (`resetPasswordForEmail`, as /forgot-password). The link and its wait belong to
    the address tried; the button always shows how long to wait;
  - not confirmed, rate limited, or any other failure: the shared auth messages, never "a
    different password".
- /onboarding now also recognises an owner known only through `restaurants.owner_user_id` (no staff
  row) and shows the existing-restaurant notice instead of a bare wizard; '/' lands such an owner on
  their first branch even when none is active (a suspension), instead of back on /onboarding.

## 2. Delete on a removed row (Staff page)

- `delete_removed_staff_member(p_staff_id)` (migration `20261112100000`): the same authority as
  `cancel_staff_invite`; status `removed` only (`staff_not_removed`); refused when work history
  points at the row (`staff_has_history`: orders.staff_id, payments.confirmed_by,
  staff_shifts.staff_member_id, table_sessions.opened_by_staff / closed_by_staff — every foreign key
  into staff_members, SET NULL or CASCADE, so a delete would wipe it). Audited as
  `staff_member_deleted`. The sign-in account is never touched; inviting the address again makes a
  new row.
- The Remove / Delete words are distinct in every language (es Quitar / Eliminar, vi Gỡ / Xóa hẳn,
  th นำออก / ลบ).

## 3. History survives the other two ways out

invite-staff revives a removed row as the new invitation (pending, user_id null), so an invitation
can carry the work its person did before:

- `cancel_staff_invite` puts such a row back to `removed` (`{cancelled, kept}`, audited as
  `staff_status_changed`, reason `invitation_cancelled_history_kept`) and deletes only one with no
  history. A second Cancel on it is `invite_already_cancelled`; the Staff page shows it as removed at
  once and says the invitation was already cancelled.
- `accept_staff_invite`: such a kept row is `invite_not_found` (its link says the invitation no
  longer exists; the accept page treats any removed row that way), and when the account already has
  a removed row at that branch, that row comes back as before while a spent invitation with history
  goes back to removed instead of being deleted.

Both functions were re-created from their live definitions with only these changes.

Rolled-back checks: `supabase/tests/delete_removed_staff_member.sql` (44, all passing on the live
schema on 2026-11-13). Deploy: the migration, then the admin.
