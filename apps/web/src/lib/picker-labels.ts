import type { useTranslations } from 'next-intl';
import type { LocationPickerLabels } from '@favornoms/maps';

// Builds the LocationPicker's i18n labels from the checkout.* message keys so the
// map picker reads the same strings everywhere it's used (checkout + address book).
export function pickerLabels(t: ReturnType<typeof useTranslations>): LocationPickerLabels {
  return {
    confirm: t('checkout.picker.confirm'),
    useCurrentLocation: t('checkout.picker.useCurrentLocation'),
    locating: t('checkout.picker.locating'),
    searching: t('checkout.picker.searching'),
    dragHint: t('checkout.picker.dragHint'),
    searchPlaceholder: t('checkout.picker.searchPlaceholder'),
    unavailable: t('checkout.picker.unavailable'),
    geoErrors: {
      unsupported: t('checkout.geo.unsupported'),
      insecure_context: t('checkout.geo.insecure'),
      denied: t('checkout.geo.denied'),
      unavailable: t('checkout.geo.unavailable'),
      timeout: t('checkout.geo.timeout'),
    },
  };
}
