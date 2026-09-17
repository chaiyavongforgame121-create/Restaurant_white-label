'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@favornoms/ui';

export function PrintButton() {
  const t = useTranslations('payouts');
  return (
    <Button size="sm" variant="outline" onClick={() => window.print()}>
      {t('receipt.print')}
    </Button>
  );
}
