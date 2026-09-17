// The locale parameter every display helper in this folder grew. Two promises are pinned here:
// leaving the locale out is byte-for-byte the English these helpers always returned (every
// existing caller depends on that), and the values stored or compared never change language.

import { describe, expect, it } from 'vitest';
import { UI_LOCALES } from '../i18n';
import {
  CUSTOMER_SORT_KEYS,
  CUSTOMER_SORT_OPTIONS,
  customerSortLabel,
  customerSortOptions,
} from './customer-sort';
import {
  UNKNOWN_RESTAURANT_LABEL,
  displayRestaurantName,
  restaurantLabel,
  summariseDriverEarnings,
  unknownRestaurantLabel,
} from './driver-earnings';
import { FEATURE_KEYS, billingErrorMessage, featureLabel } from './entitlements';
import { validateSelections, type ModifierGroup } from './modifiers';
import { COUNTRY_DIALS, countryDialLabel, countryDialsFor, countryForIso, countryName } from './phone';
import { describeRanges } from './schedule-windows';
import {
  MENU_CARD_STYLE_LABELS,
  MENU_LAYOUT_LABELS,
  menuCardStyleLabel,
  menuLayoutLabel,
} from './storefront';
import { formatInZone } from './zoned-time';

describe('featureLabel', () => {
  it('is English without a locale, and passes unknown keys through', () => {
    expect(featureLabel('card_payment')).toBe('Card payment');
    expect(featureLabel('ai_voice')).toBe('AI Voice Assistant');
    expect(featureLabel('not_a_feature')).toBe('not_a_feature');
    expect(featureLabel('not_a_feature', 'th')).toBe('not_a_feature');
  });

  it('names every feature in every language', () => {
    for (const locale of UI_LOCALES) {
      for (const key of FEATURE_KEYS) {
        expect(featureLabel(key, locale), `${locale} ${key}`).not.toBe(key);
      }
    }
    expect(featureLabel('card_payment', 'es')).toBe('Pago con tarjeta');
    expect(featureLabel('ai_suite', 'th')).toBe('AI Suite');
  });

  it('stays English when handed to Array.map, which passes the index second', () => {
    expect(['delivery', 'ai_suite'].map(featureLabel)).toEqual(['Delivery', 'AI Suite']);
  });
});

describe('billingErrorMessage', () => {
  it('keeps the English copy by default', () => {
    expect(billingErrorMessage({ kind: 'inactive', scope: 'account' })).toBe(
      'Your subscription is not active. Choose a package to continue.',
    );
    expect(billingErrorMessage({ kind: 'feature', feature: 'delivery' })).toBe(
      'Delivery is not included in your current package.',
    );
    expect(billingErrorMessage({ kind: 'seats', current: 2, limit: 2 })).toBe(
      'You are using 2 of 2 branch seats. Add a seat to create another branch.',
    );
    expect(billingErrorMessage({ kind: 'dormant' })).toBe(
      'Online payment is not configured yet. Your request has been sent for manual activation.',
    );
  });

  it('translates the message and the feature name inside it together', () => {
    expect(billingErrorMessage({ kind: 'feature', feature: 'delivery' }, 'es')).toBe(
      'Entrega a domicilio no está incluido en tu paquete actual.',
    );
    const th = billingErrorMessage({ kind: 'seats', current: 3, limit: 3 }, 'th');
    expect(th).toContain('3 จาก 3');
  });
});

describe('customer sort labels', () => {
  it('keeps CUSTOMER_SORT_OPTIONS English and in key order', () => {
    expect(CUSTOMER_SORT_OPTIONS).toEqual([
      { value: 'spent', label: 'Spend' },
      { value: 'orders', label: 'Orders' },
      { value: 'last_seen', label: 'Last seen' },
      { value: 'name', label: 'Name' },
      { value: 'joined', label: 'Joined' },
    ]);
    expect(customerSortOptions()).toEqual(CUSTOMER_SORT_OPTIONS);
  });

  it('translates labels but never the values written to the URL', () => {
    for (const locale of UI_LOCALES) {
      expect(customerSortOptions(locale).map((o) => o.value)).toEqual([...CUSTOMER_SORT_KEYS]);
    }
    expect(customerSortLabel('orders', 'es')).toBe('Pedidos');
    expect(customerSortLabel('name', 'vi')).toBe('Tên');
  });
});

describe('storefront layout labels', () => {
  it('keeps the exported English tables', () => {
    expect(MENU_LAYOUT_LABELS.grid2).toBe('Grid · 2 columns');
    expect(MENU_CARD_STYLE_LABELS.compact).toBe('Compact (photo on left)');
    expect(menuLayoutLabel('list')).toBe('List · 1 column');
    expect(menuCardStyleLabel('standard')).toBe('Standard (photo on top)');
  });

  it('translates every layout and card style', () => {
    expect(menuLayoutLabel('grid3', 'es')).toBe('Cuadrícula · 3 columnas');
    expect(menuCardStyleLabel('compact', 'th')).toBe('กะทัดรัด (รูปอยู่ด้านซ้าย)');
  });
});

describe('validateSelections', () => {
  const size: ModifierGroup = {
    id: 'g-size',
    name: 'Tamaño',
    min_select: 1,
    max_select: 1,
    is_required: true,
    selection_type: 'single',
    display_order: 0,
    options: [
      { id: 'a', name: 'Chico', price_delta: 0, is_default: false, is_active: true },
      { id: 'b', name: 'Grande', price_delta: 1, is_default: false, is_active: true },
    ],
  };
  const extras: ModifierGroup = { ...size, id: 'g-extras', name: 'Extras', is_required: false, min_select: 0, max_select: 2 };

  it('keeps the merchant group name as typed in every language', () => {
    expect(validateSelections([size], { 'g-size': [] }, 'es')).toBe('Elige al menos 1 opción para Tamaño');
    expect(validateSelections([extras], { 'g-extras': ['a', 'b', 'c'] }, 'es')).toBe(
      'Elige como máximo 2 opciones para Extras',
    );
    expect(validateSelections([size], { 'g-size': [] }, 'vi')).toBe('Chọn ít nhất 1 tùy chọn cho Tamaño');
    expect(validateSelections([size], { 'g-size': [] }, 'th')).toBe('เลือกอย่างน้อย 1 ตัวเลือกสำหรับ Tamaño');
  });

  it('is still null for a valid selection', () => {
    expect(validateSelections([size], { 'g-size': ['a'] }, 'th')).toBeNull();
  });
});

describe('describeRanges', () => {
  it('writes each language’s own clock', () => {
    expect(describeRanges([[1020, 1320]], undefined, 'es')).toBe('5:00 p. m. – 10:00 p. m.');
    expect(describeRanges([[540, 1440]], undefined, 'vi')).toBe('09:00 – nửa đêm');
    expect(describeRanges([[600, 840], [1020, 1320]], undefined, 'th')).toBe(
      '10:00 น. – 14:00 น., 17:00 น. – 22:00 น.',
    );
  });

  it('uses the translated empty wording unless the caller supplied its own', () => {
    expect(describeRanges([])).toBe('Nothing bookable');
    expect(describeRanges([], undefined, 'es')).toBe('Sin horarios para reservar');
    expect(describeRanges([], 'Cerrado', 'es')).toBe('Cerrado');
  });
});

describe('unknown restaurant label', () => {
  it('keeps the compared constant English and translates only the display', () => {
    expect(restaurantLabel(null).restaurantName).toBe(UNKNOWN_RESTAURANT_LABEL);
    expect(unknownRestaurantLabel()).toBe(UNKNOWN_RESTAURANT_LABEL);
    expect(displayRestaurantName(UNKNOWN_RESTAURANT_LABEL, 'es')).toBe('Restaurante ya no disponible');
    expect(displayRestaurantName('Somtam Zab', 'th')).toBe('Somtam Zab');
  });

  it('still lets a later readable row name a pile that started unnamed', () => {
    const s = summariseDriverEarnings([
      { branch_id: 'x', base_pay: 1, distance_pay: 0, tip_net: 0, total: 1, status: 'accrued', withdrawal_id: null, branch: null },
      {
        branch_id: 'x',
        base_pay: 1,
        distance_pay: 0,
        tip_net: 0,
        total: 1,
        status: 'accrued',
        withdrawal_id: null,
        branch: { name: 'Main', restaurant: { name: 'Coastal Grill' } },
      },
    ]);
    expect(s.restaurants[0]?.restaurantName).toBe('Coastal Grill');
  });
});

describe('country names', () => {
  it('is exactly the English label without a locale', () => {
    for (const c of COUNTRY_DIALS) expect(countryDialLabel(c)).toBe(c.label);
    expect(countryDialsFor()).toBe(COUNTRY_DIALS);
    expect(countryName(countryForIso('GB'))).toBe('United Kingdom');
  });

  it('names countries in the interface language and keeps the dial code', () => {
    const th = countryForIso('TH');
    expect(countryDialLabel(th, 'es')).toBe('Tailandia (+66)');
    expect(countryDialLabel(countryForIso('JP'), 'th')).toMatch(/\(\+81\)$/);
    expect(countryName(countryForIso('HK'), 'es')).toBe('Hong Kong');
  });

  it('keeps every entry, its iso and its number rules, with US and TH leading', () => {
    for (const locale of UI_LOCALES) {
      const list = countryDialsFor(locale);
      expect(list).toHaveLength(COUNTRY_DIALS.length);
      expect(list.slice(0, 2).map((c) => c.iso)).toEqual(['US', 'TH']);
      expect(new Set(list.map((c) => c.iso))).toEqual(new Set(COUNTRY_DIALS.map((c) => c.iso)));
      for (const c of list) {
        const original = countryForIso(c.iso);
        expect(c.dial).toBe(original.dial);
        expect(c.trunk).toBe(original.trunk);
        expect(c.placeholder).toBe(original.placeholder);
      }
    }
  });
});

describe('formatInZone', () => {
  it('is unchanged in English and follows the interface language otherwise', () => {
    const iso = '2026-12-25T06:01:00.000Z';
    expect(formatInZone(iso, 'America/Chicago', {}, 'en')).toBe(formatInZone(iso, 'America/Chicago'));
    // Gregorian in Thai: the year on screen matches every receipt.
    expect(formatInZone(iso, 'Asia/Bangkok', { dateOnly: true }, 'th')).toContain('2026');
    expect(formatInZone(iso, 'Asia/Bangkok', { dateOnly: true }, 'vi')).toBe('25/12/2026');
  });
});
