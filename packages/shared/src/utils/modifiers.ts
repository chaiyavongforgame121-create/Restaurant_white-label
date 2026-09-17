/**
 * Picking options on a menu item.
 *
 * The storefront's item sheet has always done this; the counter did not do it at all --
 * tapping a tile added the item at its base price and `place-order` was sent
 * `{ menu_item_id, quantity }` with no modifiers and no note. A cashier taking "no pickles,
 * extra cheese" over the counter had nowhere to put it, and the kitchen ticket came out
 * plain. These are the rules both surfaces now share, so a burger rung up at the till and
 * the same burger ordered from a phone cannot disagree about what is allowed or what it
 * costs.
 */

import { DEFAULT_UI_LOCALE, isUiLocale, type UiLocale } from '../i18n';

export interface ModifierOption {
  id: string;
  name: string;
  /** Added to the item's base price. Negative is allowed (a discount for leaving something out). */
  price_delta: number;
  is_default: boolean;
  is_active: boolean;
}

export interface ModifierGroup {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  is_required: boolean;
  selection_type: 'single' | 'multiple';
  display_order: number;
  options: ModifierOption[];
}

/** What the caller chose, per group. Accepts a Set or an array so either store shape fits. */
export type ModifierSelections = Record<string, ReadonlySet<string> | readonly string[]>;

/** One chosen option, flattened for the cart and for `place-order`. */
export interface SelectedModifier {
  group_id: string;
  group_name: string;
  option_id: string;
  option_name: string;
  price_delta: number;
}

const idsOf = (picked: ReadonlySet<string> | readonly string[] | undefined): string[] =>
  picked ? (Array.isArray(picked) ? [...picked] : [...(picked as ReadonlySet<string>)]) : [];

/**
 * The options a group starts with.
 *
 * Capped at max_select because a group misconfigured with three defaults and max_select 1
 * would otherwise open already invalid, with the diner unable to tell what to un-pick.
 */
export function defaultSelections(groups: readonly ModifierGroup[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of groups) {
    out[g.id] = g.options
      .filter((o) => o.is_default && o.is_active)
      .slice(0, Math.max(0, g.max_select))
      .map((o) => o.id);
  }
  return out;
}

/** What the chosen options add to the unit price. */
export function modifierDelta(
  groups: readonly ModifierGroup[],
  selections: ModifierSelections,
): number {
  let sum = 0;
  for (const g of groups) {
    for (const optionId of idsOf(selections[g.id])) {
      const opt = g.options.find((o) => o.id === optionId);
      if (opt) sum += opt.price_delta;
    }
  }
  // Cents, not float dust: three -0.33 deltas must not leave a fraction of a penny behind.
  return Math.round(sum * 100) / 100;
}

interface SelectionCopy {
  atLeast: (count: number, group: string) => string;
  atMost: (count: number, group: string) => string;
}

// The group name is the merchant's own words and goes in untranslated.
const SELECTION_COPY: Record<UiLocale, SelectionCopy> = {
  en: {
    atLeast: (n, group) => `Pick at least ${n} option${n === 1 ? '' : 's'} for ${group}`,
    atMost: (n, group) => `Pick at most ${n} option${n === 1 ? '' : 's'} for ${group}`,
  },
  es: {
    atLeast: (n, group) => `Elige al menos ${n} ${n === 1 ? 'opción' : 'opciones'} para ${group}`,
    atMost: (n, group) => `Elige como máximo ${n} ${n === 1 ? 'opción' : 'opciones'} para ${group}`,
  },
  vi: {
    atLeast: (n, group) => `Chọn ít nhất ${n} tùy chọn cho ${group}`,
    atMost: (n, group) => `Chọn tối đa ${n} tùy chọn cho ${group}`,
  },
  th: {
    atLeast: (n, group) => `เลือกอย่างน้อย ${n} ตัวเลือกสำหรับ ${group}`,
    atMost: (n, group) => `เลือกได้ไม่เกิน ${n} ตัวเลือกสำหรับ ${group}`,
  },
};

/**
 * The first rule the selection breaks, phrased for whoever is looking at the screen in
 * `locale` (English when omitted), or null when it is good to add.
 */
export function validateSelections(
  groups: readonly ModifierGroup[],
  selections: ModifierSelections,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): string | null {
  const copy = SELECTION_COPY[isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE];
  for (const g of groups) {
    const count = idsOf(selections[g.id]).length;
    if (g.is_required && count < g.min_select) {
      return copy.atLeast(g.min_select, g.name);
    }
    if (count > g.max_select) {
      return copy.atMost(g.max_select, g.name);
    }
  }
  return null;
}

/** The chosen options, in group order, ready for the cart or for `place-order`. */
export function flattenSelections(
  groups: readonly ModifierGroup[],
  selections: ModifierSelections,
): SelectedModifier[] {
  const out: SelectedModifier[] = [];
  for (const g of groups) {
    for (const optionId of idsOf(selections[g.id])) {
      const opt = g.options.find((o) => o.id === optionId);
      if (!opt) continue;
      out.push({
        group_id: g.id,
        group_name: g.name,
        option_id: opt.id,
        option_name: opt.name,
        price_delta: opt.price_delta,
      });
    }
  }
  return out;
}

/**
 * Tap one option and get that group's new selection back.
 *
 * A single-select group swaps; a multi-select group stops accepting at max_select rather
 * than silently dropping the oldest pick, because on a till the cashier needs to see that
 * the tap did nothing and why.
 */
export function toggleOption(
  group: ModifierGroup,
  selections: ModifierSelections,
  optionId: string,
): string[] {
  const current = idsOf(selections[group.id]);
  const has = current.includes(optionId);
  if (group.selection_type === 'single' || group.max_select === 1) {
    return has ? [] : [optionId];
  }
  if (has) return current.filter((id) => id !== optionId);
  if (current.length >= group.max_select) return current;
  return [...current, optionId];
}

/**
 * A stable key for "the same item configured the same way".
 *
 * The till merged cart lines on menu item id alone. Once options exist that is wrong: two
 * burgers ordered with different modifiers are two different things, and merging them
 * silently rewrites one customer's order into another's.
 */
export function lineSignature(
  menuItemId: string,
  modifiers: readonly SelectedModifier[],
  notes?: string | null,
): string {
  const opts = modifiers
    .map((m) => m.option_id)
    .slice()
    .sort()
    .join(',');
  return `${menuItemId}|${opts}|${(notes ?? '').trim()}`;
}
