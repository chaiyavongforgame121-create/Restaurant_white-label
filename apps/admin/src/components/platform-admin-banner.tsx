import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';

/**
 * Shown when a platform superadmin is inside a back office they are not staff of.
 *
 * The merchant admin has no other tell: the sidebar says the branch name, the
 * dashboard shows that branch's real revenue, and nothing distinguishes it from
 * the operator's own restaurant. Without this, "fix the menu for Coastal Grill"
 * and "fix the menu" look identical on screen — and the RLS arm that makes this
 * page work at all is FOR ALL, so a stray edit lands on a live paying tenant.
 *
 * It names the audit trail on purpose. An operator who knows the write is
 * recorded behaves differently from one who assumes it is not, and that is the
 * point of having recorded it.
 */
export function PlatformAdminBanner({ branchName }: { branchName: string }) {
  return (
    <div
      role="status"
      className="sticky top-0 z-30 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/30 bg-warning/15 py-2.5 pl-16 pr-4 text-sm text-warning backdrop-blur lg:pl-5"
    >
      <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
      <span className="font-semibold">Platform admin view</span>
      <span className="text-warning/90">
        You are not staff of {branchName}. Every change you make here is recorded against your
        account.
      </span>
      <Link
        href="/platform"
        className="ml-auto shrink-0 font-medium underline underline-offset-2 hover:no-underline"
      >
        Back to platform
      </Link>
    </div>
  );
}
