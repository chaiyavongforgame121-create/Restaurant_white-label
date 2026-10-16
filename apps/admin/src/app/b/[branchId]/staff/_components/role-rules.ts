/**
 * Who may give which role, as the Staff page offers it. set_staff_role is the boundary; this
 * only keeps the page from offering a choice that would end in an error, so each rule here is
 * one of the function's, in the same order.
 */

/** What set_staff_role can give, in descending order of access. Never `owner` (created by
 *  restaurant onboarding) and never `driver` (riders sign up through the driver app). */
export const CHANGEABLE_ROLES = [
  'admin',
  'manager',
  'cashier',
  'server',
  'kitchen',
  'staff',
] as const;
export type ChangeableRole = (typeof CHANGEABLE_ROLES)[number];

/**
 * What the Staff page offers, in descending order of access: the owner's seven-role spec minus
 * the owner (never handed out) and the rider (riders live in the driver app, never as staff).
 * `staff` is a legacy role outside that spec (owner decision D11, 2026-10-16), so it is no longer
 * offered for an invitation or a change; set_staff_role still accepts it, and a member who holds
 * it keeps showing it until someone picks a role from this list.
 */
export const OFFERED_ROLES = [
  'admin',
  'manager',
  'cashier',
  'server',
  'kitchen',
] as const satisfies readonly ChangeableRole[];
export type OfferedRole = (typeof OFFERED_ROLES)[number];

/**
 * The roles this viewer may put on an invitation. invite-staff lets only the owner invite an admin
 * (anyone else gets a 403), so an admin is never offered Admin. A platform admin working as support
 * is not the owner to invite-staff, so `isOwner` here is the page's viewerIsOwner, not
 * roleChangeViewer's.
 */
export function invitableRoles(isOwner: boolean): OfferedRole[] {
  return isOwner ? [...OFFERED_ROLES] : OFFERED_ROLES.filter((r) => r !== 'admin');
}

export interface RoleChangeViewer {
  /** The restaurant's owner of record, an owner row, or a platform admin (user_owns_restaurant). */
  isOwner: boolean;
  /** Owner, or an admin of every branch: the only people who may change a row with no branch. */
  restaurantWide: boolean;
  userId: string;
}

/**
 * The viewer as set_staff_role sees them. It decides "owner" with user_owns_restaurant, which a
 * platform admin working as support passes as well as the owner, and such a platform admin
 * then also counts as restaurant-wide. The page's own viewerIsOwner leaves the platform admin
 * out because invite-staff does, so it cannot be used here as it stands.
 */
export function roleChangeViewer(viewer: {
  isOwner: boolean;
  restaurantWide: boolean;
  platformAdmin: boolean;
  userId: string;
}): RoleChangeViewer {
  const owns = viewer.isOwner || viewer.platformAdmin;
  return { isOwner: owns, restaurantWide: viewer.restaurantWide || owns, userId: viewer.userId };
}

export interface RoleChangeTarget {
  role: string;
  status: string;
  branch_id: string | null;
  user_id: string | null;
}

/**
 * The roles this viewer may give this member, or null when the row is not theirs to change
 * (the page then shows the role as plain text). The row is one this viewer already holds
 * staff.manage for at its branch: the page only offers controls on this branch's team and on the
 * people who work at every branch.
 */
export function assignableRoles(
  member: RoleChangeTarget,
  viewer: RoleChangeViewer,
): OfferedRole[] | null {
  // Removed is history; bringing someone back is a new invitation.
  if (member.status === 'removed') return null;
  // An owner stays an owner, whoever is looking.
  if (member.role === 'owner') return null;
  // Nobody changes their own row, the owner included.
  if (member.user_id !== null && member.user_id === viewer.userId) return null;
  // A row with no branch works everywhere, so it needs authority everywhere.
  if (member.branch_id === null && !viewer.restaurantWide) return null;
  // Only the owner adds an admin, so only the owner changes one...
  if (member.role === 'admin' && !viewer.isOwner) return null;
  // ...or makes one: an admin never raises anyone to their own level. The page keeps showing a
  // role that is no longer offered (staff, driver) as the member's current one.
  return viewer.isOwner ? [...OFFERED_ROLES] : OFFERED_ROLES.filter((r) => r !== 'admin');
}

export type RoleChangeError =
  | 'notAuthorized'
  | 'self'
  | 'ownerLocked'
  | 'notAssignable'
  | 'adminRequiresOwner'
  | 'removed'
  | 'notFound'
  | 'signedOut'
  | 'generic';

/**
 * The message key for a failed setStaffRole. set_staff_role raises plain codes; the escalation
 * trigger underneath it has codes of its own that only surface if the two ever disagree.
 * Anything else is raw database text, which belongs in the console rather than on screen.
 */
export function roleChangeErrorKey(message: string): RoleChangeError {
  if (
    message.includes('cannot_change_own_role') ||
    message.includes('staff_self_role_change_forbidden')
  ) {
    return 'self';
  }
  if (message.includes('owner_role_locked')) return 'ownerLocked';
  if (message.includes('role_not_assignable')) return 'notAssignable';
  if (message.includes('admin_requires_owner') || message.includes('staff_grant_owner_forbidden')) {
    return 'adminRequiresOwner';
  }
  if (message.includes('staff_removed')) return 'removed';
  if (message.includes('staff_not_found')) return 'notFound';
  if (message.includes('not_authorized')) return 'notAuthorized';
  // No session reaches the function as anon, which may not execute it at all.
  if (
    message.includes('sign_in_required') ||
    message.includes('JWT expired') ||
    message.includes('permission denied for function')
  ) {
    return 'signedOut';
  }
  return 'generic';
}
