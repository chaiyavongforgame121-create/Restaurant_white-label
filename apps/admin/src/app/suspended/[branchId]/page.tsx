import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { getMyStaffAccessRows } from '@favornoms/database/queries';
import { Card } from '@favornoms/ui';
import { getBranchAccess } from '@/lib/capabilities';
import { branchHasOrdersInProgress, planPath } from '@/lib/subscription-gate';
import { AccessDenied } from '@/components/access-denied';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { SignOutButton } from '@/components/sign-out';
import { StaffAccessWatcher } from '@/components/staff-access-watcher';
import { CheckAgainButton, LockedAutoRefresh, StillOpenLinks } from '@/components/suspension-screen';
import { ThemeToggle } from '@/components/theme-toggle';

interface Props {
  params: Promise<{ branchId: string }>;
}

export async function generateMetadata() {
  const t = await getTranslations('shell.subscriptionLocked');
  return { title: t('title') };
}

/**
 * Where someone who works at a restaurant whose subscription has ended, but has no back office
 * there (a server, a member of staff, a cook), is sent from the till, the kitchen board and the
 * back office alike. It says the subscription is the cause and that only the owner can renew it.
 *
 * It sits outside /b on purpose: it has no menu to offer, and the branch layout would send it
 * here again. Before this, "Go to billing" on the locked till led to "No admin access", whose
 * "Back to my screen" led to the locked till: a loop that never named the cause (D5).
 */
export default async function SuspendedPage({ params }: Props) {
  const { branchId } = await params;
  const { supabase, user, branch, capabilities, can, subscription } = await getBranchAccess(
    branchId,
    `/suspended/${branchId}`,
    { whileLocked: 'allow' },
  );

  // Someone who does not work here learns nothing about the restaurant's billing.
  if (capabilities.size === 0) {
    const t = await getTranslations('shell.branchAccess');
    return <AccessDenied title={t('title')} reason={t('notStaff', { branch: branch.name })} />;
  }
  // Renewed (or never locked for this person, or it could not be read): back to the screen their
  // role starts on at this branch, as '/' would choose it. Named here rather than sent through '/',
  // a route handler a "Check again" refresh would otherwise reach as a client navigation.
  if (!subscription.locked) {
    redirect(
      can('backoffice.access')
        ? `/b/${branchId}/dashboard`
        : can('counter.access')
          ? `/counter/${branchId}`
          : can('kitchen.access')
            ? `/kitchen/${branchId}`
            : '/',
    );
  }
  // The back office has the real page for this, with the owner's way to renew on it.
  if (can('backoffice.access')) redirect(planPath(branchId));

  // The kitchen board and Recent stay open while orders placed before the end are finished; this
  // is where the till and sign-in send a server or a cook, so the way there is offered here.
  const kitchen = can('kitchen.access');
  const recent = can('counter.access');
  const [t, myRows, ordersOpen] = await Promise.all([
    getTranslations('shell.subscriptionLocked'),
    getMyStaffAccessRows(supabase, user.id, branch.restaurant_id),
    kitchen || recent ? branchHasOrdersInProgress(branchId) : Promise.resolve(false),
  ]);

  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4 py-8">
      <Card className="w-full max-w-md p-6 text-center">
        <Lock className="mx-auto h-12 w-12 text-warning" />
        <h1 className="mt-3 font-display text-2xl font-bold">{t('title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('askOwner', { branch: branch.name })}
        </p>
        {ordersOpen && (
          <StillOpenLinks branchId={branchId} kitchen={kitchen} recent={recent} className="mt-4" />
        )}
        <CheckAgainButton fullWidth className="mt-5" />
        <div className="mt-5 space-y-2 border-t border-border/60 pt-4 text-left">
          <LocaleSwitcher className="w-full" />
          <ThemeToggle />
          <SignOutButton className="pt-1" />
        </div>
      </Card>
      {/* Asks again every minute: a renewal sends this screen back to work, and a booking
          released onto the board brings up the links to it. */}
      <LockedAutoRefresh />
      {/* A role change reloads this page: someone made a manager goes on to Plan & billing. */}
      <StaffAccessWatcher
        userId={user.id}
        restaurantId={branch.restaurant_id}
        branchId={branchId}
        initialRows={myRows}
      />
    </div>
  );
}
