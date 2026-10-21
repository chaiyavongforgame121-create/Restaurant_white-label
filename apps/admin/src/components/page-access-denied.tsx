// The card a back-office page shows to someone who cleared the branch layout's
// backoffice.access gate but not the page's own capability.
//
// Most of these pages used to have no guard at all: the sidebar hid them and RLS refused the
// writes, which was enough while only the owner, admin and manager could open the back office.
// A cashier holds backoffice.access now (owner decision D1, 2026-10-16), so a typed URL is no
// longer a manager's — and an editor whose every save fails reads as a broken product. One
// shared card, in shell, so a page whose own namespace has no "no access" copy still says in
// whole sentences what this screen is and who to ask.

import { getTranslations } from 'next-intl/server';
import { AccessDenied } from '@/components/access-denied';

/** The screen being refused. Each has its own whole sentence under shell.pageAccess.reasons. */
export type PageAccessArea =
  | 'menu'
  | 'qr'
  | 'promos'
  | 'orders'
  | 'activity'
  | 'ratings'
  | 'payouts'
  | 'hq'
  | 'franchise'
  | 'branch'
  | 'settings';

export async function PageAccessDenied({
  area,
  branchName,
}: {
  area: PageAccessArea;
  branchName: string;
}) {
  const t = await getTranslations('shell.pageAccess');
  return <AccessDenied title={t('title')} reason={t(`reasons.${area}`, { branch: branchName })} />;
}
