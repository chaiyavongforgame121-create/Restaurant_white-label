'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { cooldownEndLabel } from '../../drivers/_lib/cooldown';
import {
  rpcErrorKey,
  type AgeSpan,
  type DeliveryDetail,
  type DispatchFailureText,
  type StatusLabel,
} from './live-ops-model';

// Puts what live-ops-model decides into the reader's language. The model only hands back keys,
// codes and numbers; every word the Live deliveries board prints goes through here or through
// the component's own `t`.

/** vehicle_type values the rider app writes. Anything else is shown as stored. */
const VEHICLE_TYPES = ['motorcycle', 'car', 'bicycle', 'scooter'] as const;

export function useLiveOpsText() {
  const t = useTranslations('deliveries');
  const rawLocale = useLocale();
  const intlLocale = intlLocaleFor(isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE);

  return React.useMemo(() => {
    const age = (span: AgeSpan): string => {
      switch (span.unit) {
        case 'unknown':
          return t('age.unknown');
        case 'underMinute':
          return t('age.underMinute');
        case 'minutes':
          return t('age.minutes', { minutes: span.minutes });
        case 'hours':
          return span.minutes
            ? t('age.hoursMinutes', { hours: span.hours, minutes: span.minutes })
            : t('age.hours', { hours: span.hours });
        case 'days':
          return t('age.days', { days: span.days });
      }
    };

    const label = (l: StatusLabel): string =>
      l.key === 'unknown' ? t('status.unknown', { status: l.status ?? '' }) : t(`status.${l.key}`);

    const detail = (d: DeliveryDetail): string => {
      switch (d.key) {
        case 'none':
          return '';
        case 'kitchenStatus':
          return t('detail.kitchenStatus', { status: d.status });
        case 'riderCancelled':
          return t('detail.riderCancelled', { reason: d.reason });
        case 'askedRiders':
          return t('detail.askedRiders', { count: d.count });
        case 'waiting': {
          // The reason a round is waiting is the part the merchant can act on (a cooldown to lift,
          // a rider to call online); the count says the round did not just stall.
          const why = t('detail.waiting', { reason: d.reason });
          return d.count > 0 ? `${t('detail.askedRiders', { count: d.count })} · ${why}` : why;
        }
        case 'noRiderFound':
          return t('detail.noRiderFound', { reason: d.reason });
        case 'acceptedAgo':
          return t('detail.acceptedAgo', { age: age(d.age) });
        case 'pickedUpAgo':
          return t('detail.pickedUpAgo', { age: age(d.age) });
        case 'expiresIn':
          return t('detail.expiresIn', { countdown: d.countdown });
        case 'eta':
          return t('detail.eta', { minutes: d.minutes });
        case 'reason':
          // Somebody typed this; it is shown as written.
          return d.reason;
        default:
          return t(`detail.${d.key}`);
      }
    };

    const dispatchFailure = (f: DispatchFailureText): string => t(`dispatch.${f.key}`, f.values);

    /** An RPC error as the rule it stands for; anything unrecognised is logged, never shown. */
    const rpcError = (message: string): string => {
      const key = rpcErrorKey(message);
      if (key) return t(`rpcErrors.${key}`);
      console.error('Live deliveries RPC failed:', message);
      return t('rpcErrors.generic');
    };

    const vehicle = (value: string): string =>
      (VEHICLE_TYPES as readonly string[]).includes(value) ? t(`vehicle.${value}`) : value;

    /** When a rider's cooldown ends, on this device's clock; null when it is not running. */
    const cooldownEnd = (iso: string | null | undefined, nowMs: number): string | null =>
      cooldownEndLabel(iso, nowMs, intlLocale);

    return { t, age, label, detail, dispatchFailure, rpcError, vehicle, cooldownEnd };
  }, [t, intlLocale]);
}
