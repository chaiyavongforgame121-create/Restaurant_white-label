'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
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

    return { t, age, label, detail, dispatchFailure, rpcError, vehicle };
  }, [t]);
}
