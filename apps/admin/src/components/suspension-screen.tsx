import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';

/** What is locked. Each has its own whole sentence, because the surface is the subject. */
export type SuspensionSurface = 'counter' | 'screen';

/**
 * Shown on back-office surfaces that create new business (the till) when the
 * subscription has lapsed. Deliberately NOT used on the kitchen display or the
 * recent-orders list: the billing gates are BEFORE INSERT, so orders already in
 * the pipe must still be cookable and printable. Locking those would strand a
 * restaurant mid-service over an invoice.
 */
export function SuspensionScreen({
  branchId,
  branchName,
  surface = 'screen',
}: {
  branchId: string;
  branchName?: string;
  /**
   * What is locked, as a code: pass 'counter' for the till. The surface is the subject of the
   * sentence, so a translated noun cannot be slotted in; any other string (including the old
   * English 'The counter', still read as the counter) falls back to "This screen".
   */
  surface?: SuspensionSurface | (string & {});
}) {
  const t = useTranslations('shell.suspension');
  const subject: SuspensionSurface = surface === 'counter' || surface === 'The counter' ? 'counter' : 'screen';
  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4">
      <Card className="w-full max-w-md p-6 text-center">
        <Lock className="mx-auto h-12 w-12 text-warning" />
        <h1 className="mt-3 font-display text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {branchName ? t(`locked.${subject}`, { branch: branchName }) : t(`lockedHere.${subject}`)}{' '}
          {t('nothingDeleted')}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">{t('kitchenStillWorks')}</p>
        <Link href={`/b/${branchId}/settings/plan`} className="mt-5 block">
          <Button variant="gradient" fullWidth>
            {t('goToBilling')}
          </Button>
        </Link>
      </Card>
    </div>
  );
}
