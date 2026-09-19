import { describe, expect, it } from 'vitest';
import { Constants } from '@favornoms/database';
import {
  CHANGEABLE_ROLES,
  assignableRoles,
  roleChangeErrorKey,
  roleChangeViewer,
  type RoleChangeTarget,
  type RoleChangeViewer,
} from './role-rules';

const HAM = '44444444-4444-4444-4444-444444444444';

const owner: RoleChangeViewer = { isOwner: true, restaurantWide: true, userId: 'owner' };
const branchAdmin: RoleChangeViewer = { isOwner: false, restaurantWide: false, userId: 'bb' };
const everyBranchAdmin: RoleChangeViewer = { isOwner: false, restaurantWide: true, userId: 'rw' };

const row = (over: Partial<RoleChangeTarget> = {}): RoleChangeTarget => ({
  role: 'cashier',
  status: 'active',
  branch_id: HAM,
  user_id: 'cashier',
  ...over,
});

describe('assignableRoles', () => {
  it('lets the owner give every changeable role, admin included', () => {
    expect(assignableRoles(row(), owner)).toEqual([
      'admin',
      'manager',
      'cashier',
      'server',
      'kitchen',
      'staff',
    ]);
  });

  it('never offers owner or driver', () => {
    for (const viewer of [owner, branchAdmin, everyBranchAdmin]) {
      const roles = assignableRoles(row(), viewer) ?? [];
      expect(roles).not.toContain('owner');
      expect(roles).not.toContain('driver');
    }
  });

  it('lets a branch admin change a cashier at their branch, but never to admin', () => {
    const roles = assignableRoles(row(), branchAdmin);
    expect(roles).toEqual(['manager', 'cashier', 'server', 'kitchen', 'staff']);
  });

  it('keeps admin rows owner-only', () => {
    expect(assignableRoles(row({ role: 'admin', user_id: 'khun' }), branchAdmin)).toBeNull();
    expect(assignableRoles(row({ role: 'admin', user_id: 'khun' }), everyBranchAdmin)).toBeNull();
    expect(assignableRoles(row({ role: 'admin', user_id: 'khun' }), owner)).toContain('manager');
  });

  it('locks owner rows for everyone, the owner too', () => {
    for (const viewer of [owner, branchAdmin, everyBranchAdmin]) {
      expect(assignableRoles(row({ role: 'owner', user_id: 'other-owner' }), viewer)).toBeNull();
    }
  });

  it('never offers a change to your own row', () => {
    expect(assignableRoles(row({ role: 'admin', user_id: 'owner' }), owner)).toBeNull();
    expect(assignableRoles(row({ role: 'admin', user_id: 'bb' }), branchAdmin)).toBeNull();
    expect(
      assignableRoles(row({ role: 'cashier', user_id: 'rw', branch_id: null }), everyBranchAdmin),
    ).toBeNull();
  });

  it('needs restaurant-wide authority for someone who works at every branch', () => {
    const everywhere = row({ role: 'staff', branch_id: null, user_id: 'allbranches' });
    expect(assignableRoles(everywhere, branchAdmin)).toBeNull();
    expect(assignableRoles(everywhere, everyBranchAdmin)).toEqual([
      'manager',
      'cashier',
      'server',
      'kitchen',
      'staff',
    ]);
    expect(assignableRoles(everywhere, owner)).toContain('admin');
  });

  it('leaves removed rows alone but lets a pending invitation be changed before it is accepted', () => {
    expect(assignableRoles(row({ status: 'removed' }), owner)).toBeNull();
    expect(assignableRoles(row({ status: 'pending', user_id: null }), branchAdmin)).toContain(
      'kitchen',
    );
    expect(assignableRoles(row({ status: 'suspended' }), branchAdmin)).toContain('kitchen');
  });

  it('lets a driver row be moved onto a counter or kitchen role', () => {
    expect(assignableRoles(row({ role: 'driver', user_id: 'rider' }), branchAdmin)).toContain(
      'cashier',
    );
  });

  it('only names roles the database has', () => {
    const enumRoles = new Set<string>(Constants.public.Enums.staff_role);
    for (const r of CHANGEABLE_ROLES) expect(enumRoles.has(r)).toBe(true);
  });
});

describe('roleChangeViewer', () => {
  it('treats a platform admin with no staff row as the owner, as user_owns_restaurant does', () => {
    const support = roleChangeViewer({
      isOwner: false,
      restaurantWide: false,
      platformAdmin: true,
      userId: 'support',
    });
    expect(support).toEqual({ isOwner: true, restaurantWide: true, userId: 'support' });
    // Admin rows, rows with no branch and the admin option: what set_staff_role accepts from them.
    expect(assignableRoles(row({ role: 'admin', user_id: 'khun' }), support)).toContain('manager');
    expect(assignableRoles(row({ role: 'staff', branch_id: null }), support)).not.toBeNull();
    expect(assignableRoles(row(), support)).toContain('admin');
    // Still never an owner row.
    expect(assignableRoles(row({ role: 'owner', user_id: 'chai' }), support)).toBeNull();
  });

  it('passes everyone else through unchanged', () => {
    const notSupport = { platformAdmin: false };
    expect(
      roleChangeViewer({ ...notSupport, isOwner: false, restaurantWide: false, userId: 'bb' }),
    ).toEqual(branchAdmin);
    expect(
      roleChangeViewer({ ...notSupport, isOwner: false, restaurantWide: true, userId: 'rw' }),
    ).toEqual(everyBranchAdmin);
    expect(
      roleChangeViewer({ ...notSupport, isOwner: true, restaurantWide: true, userId: 'owner' }),
    ).toEqual(owner);
  });
});

describe('roleChangeErrorKey', () => {
  const cases: Array<[string, ReturnType<typeof roleChangeErrorKey>]> = [
    ['set_staff_role_failed:not_authorized', 'notAuthorized'],
    ['set_staff_role_failed:cannot_change_own_role', 'self'],
    ['set_staff_role_failed:owner_role_locked', 'ownerLocked'],
    ['set_staff_role_failed:role_not_assignable', 'notAssignable'],
    ['set_staff_role_failed:admin_requires_owner', 'adminRequiresOwner'],
    ['set_staff_role_failed:staff_removed', 'removed'],
    ['set_staff_role_failed:staff_not_found', 'notFound'],
    ['set_staff_role_failed:sign_in_required', 'signedOut'],
    ['set_staff_role_failed:permission denied for function set_staff_role', 'signedOut'],
    ['set_staff_role_failed:JWT expired', 'signedOut'],
    ['set_staff_role_failed:staff_grant_owner_forbidden', 'adminRequiresOwner'],
    ['set_staff_role_failed:staff_self_role_change_forbidden', 'self'],
    ['set_staff_role_failed:Failed to fetch', 'generic'],
  ];
  it.each(cases)('%s -> %s', (message, key) => {
    expect(roleChangeErrorKey(message)).toBe(key);
  });
});
