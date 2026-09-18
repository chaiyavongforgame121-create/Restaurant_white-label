'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { DEFAULT_UI_LOCALE, isUiLocale, type MenuItem, type UiLocale } from '@favornoms/shared';
import { formatSoldOutUntil } from './sold-out-time';

/**
 * The branch's IANA time zone (branches.timezone) once the client knows it. Undefined renders the
 * plain "Sold out": a time in the diner's own zone would be a wrong promise for a branch elsewhere.
 */
export const BranchTimeZoneContext = React.createContext<string | undefined>(undefined);

/**
 * `stockOut` is the counted-stock half of `outOfStock` on its own. MenuItem does not carry it yet
 * (mapItem in packages/database folds both halves together); once it does, this reads it as is.
 */
type SoldOutFields = Pick<MenuItem, 'outOfStock' | 'soldOutUntil'> & { stockOut?: boolean };

/**
 * The words for a sold-out dish: "Sold out until 5:00 PM" while a hand-set 86 is running and the
 * branch's zone is known, else the plain "Sold out" (a dish out of counted stock has no time).
 * A dish that is both 86'd and out of counted stock gets the plain words too: the 86 lifting
 * at 5:00 PM does not put it back on sale, so the time would be a promise nobody keeps.
 */
export function useSoldOutText() {
  const t = useTranslations('menu');
  const timeZone = React.useContext(BranchTimeZoneContext);
  const raw = useLocale();
  const locale: UiLocale = isUiLocale(raw) ? raw : DEFAULT_UI_LOCALE;

  return React.useMemo(() => {
    const until = (item: SoldOutFields) =>
      item.soldOutUntil && timeZone && !item.stockOut
        ? formatSoldOutUntil(item.soldOutUntil, timeZone, locale)
        : null;
    return {
      label: (item: SoldOutFields) => {
        const time = until(item);
        return time ? t('soldOutUntil', { time }) : t('soldOut');
      },
      ariaLabel: (item: SoldOutFields & { name: string }) => {
        const time = until(item);
        return time ? t('itemSoldOutUntil', { name: item.name, time }) : t('itemSoldOut', { name: item.name });
      },
    };
  }, [t, timeZone, locale]);
}
