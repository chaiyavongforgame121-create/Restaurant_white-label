'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { MenuCategory } from '@favornoms/shared';
import { CsvImportCard } from './csv-import-card';

/**
 * Importing a whole menu at once.
 *
 * This screen used to lead with an upload-and-analyse card that sent a photo of a printed menu to
 * the import-menu edge function and offered back a list of dishes to tick. That half went with the
 * AI add-ons (docs/PACKAGING-2026-09-23.md); the spreadsheet importer that shared the page was
 * never part of that offer and is now the whole screen.
 */
export function MenuImportView({
  branchId,
  categories,
}: {
  branchId: string;
  categories: MenuCategory[];
}) {
  const t = useTranslations('menuExtras');
  const router = useRouter();
  const [savedCount, setSavedCount] = React.useState<number | null>(null);

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('import.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('import.subtitle')}</p>
      </header>

      {/* Above the card, because the card empties itself on success and would otherwise be the
          only thing that changed. */}
      {savedCount !== null && (
        <p role="status" className="mb-4 rounded-xl bg-success/10 px-4 py-3 text-sm text-success">
          {t('import.imported', { count: savedCount })}
        </p>
      )}

      <CsvImportCard
        branchId={branchId}
        categories={categories}
        onImported={(n) => {
          setSavedCount(n);
          // Re-reads the branch's categories, so a second paste matches the ones just created
          // instead of adding them again.
          router.refresh();
        }}
      />
    </div>
  );
}
