// The rules a discount code has to obey, away from the form that collects it.
//
// Codes come off ONE-TIME charges only — the first-time setup and the additional
// branch setup (docs/PACKAGING-2026-10-24.md §1). Nothing here touches the
// monthly bill, and nothing here prices anything: the server quotes every code
// (private.billing_discount_quote), and this module only decides whether a draft
// is worth sending and how an existing code reads on the list.
//
// Nothing in this file is worded. It returns error codes and states; the screen
// turns those into the reader's language.

import type {
  DiscountCode,
  DiscountCodeInput,
  DiscountRedemption,
} from '@favornoms/database/queries';
import { PRODUCT_EXTRA_BRANCH, type BillingProduct } from '@favornoms/shared';

/**
 * What a code may be made of. Upper-case letters, digits and dashes: it is typed
 * by hand off a flyer or an email, so anything that survives a bad keyboard or a
 * copy-paste with a trailing space is worth refusing here rather than at the
 * database's unique index.
 */
export const DISCOUNT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$|^[A-Z0-9]$/;

/**
 * The longest a code may be: it is typed by hand, and the Stripe line of a discounted charge names
 * it (displayCode in supabase/functions/_shared/stripe-billing.ts takes the same cap).
 * platform_create_discount_code refuses a longer one with code_too_long.
 */
export const DISCOUNT_CODE_MAX_LENGTH = 40;

/** Stored and compared upper-case, exactly as the SQL does (`upper(btrim(...))`). */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export type DraftError =
  | 'codeRequired'
  | 'codeCharset'
  | 'codeTooLong'
  | 'codeDuplicate'
  | 'valueRequired'
  | 'percentRange'
  | 'maxRedemptions'
  | 'perRestaurantLimit'
  | 'datesBackwards';

/** The form's own state: raw strings, because that is what inputs hold. */
export interface DraftCode {
  code: string;
  description: string;
  kind: 'percent' | 'fixed';
  /** Percent 1–100, or dollars off. */
  value: string;
  /** Empty means every one-time charge. */
  productCodes: string[];
  /** Empty means unlimited. */
  maxRedemptions: string;
  perRestaurantLimit: string;
  /** yyyy-mm-dd, read as UTC. Empty start means "from now". */
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

export const EMPTY_DRAFT: DraftCode = {
  code: '',
  description: '',
  kind: 'percent',
  value: '',
  productCodes: [],
  maxRedemptions: '',
  perRestaurantLimit: '1',
  startsAt: '',
  endsAt: '',
  isActive: true,
};

/** An existing code, as the form that edits it starts out. */
export function draftFrom(code: DiscountCode): DraftCode {
  return {
    code: code.code,
    description: code.description ?? '',
    kind: code.kind === 'percent' ? 'percent' : 'fixed',
    value: String(code.value),
    productCodes: [...code.product_codes],
    maxRedemptions: code.max_redemptions === null ? '' : String(code.max_redemptions),
    perRestaurantLimit: String(code.per_restaurant_limit),
    startsAt: dateInputValue(code.starts_at),
    endsAt: dateInputValue(code.ends_at),
    isActive: code.is_active,
  };
}

/**
 * Everything wrong with a draft, in the order the form shows the fields.
 *
 * `taken` is the set of codes that already exist (upper-case). A duplicate is
 * caught here so the operator reads "that code already exists" instead of a
 * unique-constraint string, but the index is still the thing that makes it true.
 */
export function validateDraft(
  draft: DraftCode,
  taken: Iterable<string>,
  /** Editing an existing code: its own code is not a duplicate of itself. */
  currentCode?: string,
): DraftError[] {
  const errors: DraftError[] = [];
  const code = normalizeCode(draft.code);
  const value = Number(draft.value);

  const mine = currentCode ? normalizeCode(currentCode) : null;
  if (!code) errors.push('codeRequired');
  else if (!DISCOUNT_CODE_PATTERN.test(code)) errors.push('codeCharset');
  // A code is never changed once made, so an older one is not refused on every edit.
  else if (code.length > DISCOUNT_CODE_MAX_LENGTH && code !== mine) errors.push('codeTooLong');
  else {
    for (const other of taken) {
      if (normalizeCode(other) === code && code !== mine) {
        errors.push('codeDuplicate');
        break;
      }
    }
  }

  if (!draft.value.trim() || !Number.isFinite(value) || value <= 0) errors.push('valueRequired');
  else if (draft.kind === 'percent' && value > 100) errors.push('percentRange');

  if (draft.maxRedemptions.trim()) {
    const max = Number(draft.maxRedemptions);
    if (!Number.isInteger(max) || max < 1) errors.push('maxRedemptions');
  }

  const per = Number(draft.perRestaurantLimit);
  if (!Number.isInteger(per) || per < 1) errors.push('perRestaurantLimit');

  // An end before the start is a code that can never be used. The database would
  // take it happily, and nobody would find out until a merchant typed it in.
  const start = startsAtIso(draft.startsAt);
  const end = endsAtIso(draft.endsAt);
  if (start && end && Date.parse(end) <= Date.parse(start)) errors.push('datesBackwards');

  return errors;
}

/**
 * A picked day, as the instant the window opens. Read as UTC, which is the zone
 * every date on this console is formatted in, so the day the operator picked is
 * the day they see back.
 */
export function startsAtIso(date: string): string | null {
  if (!date.trim()) return null;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The END of the picked day, not its beginning.
 *
 * `billing_discount_quote` refuses a code once `now() > ends_at`, so midnight
 * would kill a code on the morning of the day the operator chose as its last.
 */
export function endsAtIso(date: string): string | null {
  if (!date.trim()) return null;
  const ms = Date.parse(`${date}T23:59:59.999Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** An ISO instant as a <input type="date"> value, in UTC. */
export function dateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The draft as the RPC takes it.
 *
 * Every key is sent explicitly, nulls included: platform_update_discount_code
 * treats an ABSENT key as "leave this alone", so a cleared end date has to arrive
 * as an explicit null or the code keeps the date the operator just deleted.
 */
export function draftToInput(draft: DraftCode): DiscountCodeInput {
  return {
    code: normalizeCode(draft.code),
    description: draft.description.trim() || null,
    kind: draft.kind,
    value: Number(draft.value),
    product_codes: [...draft.productCodes],
    max_redemptions: draft.maxRedemptions.trim() ? Number(draft.maxRedemptions) : null,
    per_restaurant_limit: Math.max(1, Number(draft.perRestaurantLimit) || 1),
    starts_at: startsAtIso(draft.startsAt) ?? new Date().toISOString(),
    ends_at: endsAtIso(draft.endsAt),
    is_active: draft.isActive,
  };
}

/**
 * The payload for an EDIT: only what the operator changed in the form, never the code itself.
 *
 * platform_update_discount_code leaves an ABSENT key alone, and that is what makes an edit safe
 * to send. The form used to send every field, which did two kinds of damage. The date inputs
 * hold a day, not an instant, so any save moved the start of the window to midnight UTC of that
 * day. And the form's copy of the switch went back with it: an operator who had the form open
 * while a colleague switched the code off switched it on again by saving a new description.
 *
 * `kind` and `value` travel together: a value means nothing without its kind, and the server
 * checks the percent range against the pair. A cleared end date still arrives as an explicit
 * null, because absent would keep the date the operator just deleted. A cleared start date means
 * "from now", as the hint under it says. The code is never sent: a code that has been given away
 * has to keep the string it was given away as.
 */
export function draftToPatch(draft: DraftCode, original: DraftCode): Partial<DiscountCodeInput> {
  const next = draftToInput(draft);
  const before = draftToInput(original);
  const patch: Partial<DiscountCodeInput> = {};
  if (next.description !== before.description) patch.description = next.description;
  if (next.kind !== before.kind || next.value !== before.value) {
    patch.kind = next.kind;
    patch.value = next.value;
  }
  if (!sameCodes(next.product_codes ?? [], before.product_codes ?? [])) {
    patch.product_codes = next.product_codes;
  }
  if (next.max_redemptions !== before.max_redemptions) patch.max_redemptions = next.max_redemptions;
  if (next.per_restaurant_limit !== before.per_restaurant_limit) {
    patch.per_restaurant_limit = next.per_restaurant_limit;
  }
  if (draft.startsAt.trim() !== original.startsAt.trim()) patch.starts_at = next.starts_at;
  if (draft.endsAt.trim() !== original.endsAt.trim()) patch.ends_at = next.ends_at;
  if (draft.isActive !== original.isActive) patch.is_active = draft.isActive;
  return patch;
}

/** The same product codes, in any order. */
function sameCodes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((c) => set.has(c));
}

/**
 * The product codes on a code that it can never come off: products that are withdrawn, have no
 * one-time price, or are missing from the catalog altogether. The form offers only the products
 * that are sold one-time today, so without this a code naming the old delivery unlock kept it
 * invisibly — "All one-time charges" was not lit and there was nothing to untick.
 *
 * An empty catalog is unknown, not "nothing is sold": the real one always holds the plan, and
 * listBillingProducts answers a failed read with []. Calling every product unsold then put a false
 * "no longer sold … remove it" on every restricted code, and removing the last one widens a code
 * to every one-time charge.
 */
export function unsoldProducts(productCodes: readonly string[], catalog: BillingProduct[]): string[] {
  if (catalog.length === 0) return [];
  return productCodes.filter(
    (c) => !catalog.some((p) => p.code === c && p.is_active && Number(p.one_time_price) > 0),
  );
}

/**
 * Which one-time charge a product is, as the merchant's plan page names it: the plan's
 * first-time setup, or an additional branch's setup. Null for anything else, which keeps the
 * catalog's own name. A code comes off the CHARGE, not the product, so "FavorNoms Plan" on a
 * chip read as a discount on the monthly plan.
 */
export function oneTimeChargeKey(
  product: Pick<BillingProduct, 'code' | 'kind' | 'one_time_price'>,
): 'firstSetup' | 'extraBranch' | null {
  if (product.code === PRODUCT_EXTRA_BRANCH) return 'extraBranch';
  if (product.kind === 'plan' && Number(product.one_time_price) > 0) return 'firstSetup';
  return null;
}

/**
 * Whether a code can be used RIGHT NOW, and if not, why.
 *
 * Mirrors the order private.billing_discount_quote refuses in, so the badge on the
 * list says the same thing the merchant would be told.
 */
export type CodeState = 'inactive' | 'scheduled' | 'expired' | 'exhausted' | 'live';

export function codeState(code: DiscountCode, nowMs: number): CodeState {
  if (!code.is_active) return 'inactive';
  const starts = Date.parse(code.starts_at);
  if (Number.isFinite(starts) && nowMs < starts) return 'scheduled';
  const ends = code.ends_at ? Date.parse(code.ends_at) : NaN;
  if (Number.isFinite(ends) && nowMs > ends) return 'expired';
  if (code.max_redemptions !== null && code.redemption_count >= code.max_redemptions) {
    return 'exhausted';
  }
  return 'live';
}

/**
 * The message key for a failed write. The raw PostgREST text is logged, never
 * shown: the unique index on `code` is the real duplicate check (two operators can
 * create the same code in the same second), so its violation has to read as a
 * sentence rather than as a constraint name.
 */
export function writeErrorKey(raw: string | undefined): string {
  if (!raw) return 'errors.saveFailed';
  console.error('[platform/discounts] write failed:', raw);
  if (/duplicate key|already exists|unique constraint|billing_discount_codes_code_key/i.test(raw)) {
    return 'discounts.errors.codeDuplicate';
  }
  if (/kind_invalid/i.test(raw)) return 'discounts.errors.kindInvalid';
  if (/code_required/i.test(raw)) return 'discounts.errors.codeRequired';
  // The server's own checks (platform_create_discount_code / platform_update_discount_code)
  // and the table's, for whatever reached it without passing validateDraft().
  if (/code_invalid_chars/i.test(raw)) return 'discounts.errors.codeCharset';
  if (/code_too_long/i.test(raw)) return 'discounts.errors.codeTooLong';
  if (/product_not_one_time/i.test(raw)) return 'discounts.errors.productNotOneTime';
  if (/ends_before_start/i.test(raw)) return 'discounts.errors.datesBackwards';
  if (/per_restaurant_limit_(invalid|check)/i.test(raw)) return 'discounts.errors.perRestaurantLimit';
  if (/billing_discount_codes_percent_range/i.test(raw)) return 'discounts.errors.percentRange';
  if (/billing_discount_codes_value_check/i.test(raw)) return 'discounts.errors.valueRequired';
  if (/max_redemptions_check/i.test(raw)) return 'discounts.errors.maxRedemptions';
  if (/code_not_found/i.test(raw)) return 'discounts.errors.notFound';
  if (/forbidden|not[ _]authori[sz]ed|permission denied|platform[ _]admin/i.test(raw)) {
    return 'errors.permission';
  }
  if (/failed to fetch|fetch failed|networkerror|network request failed/i.test(raw)) {
    return 'errors.network';
  }
  return 'errors.saveFailed';
}

/** Uses left, or null when the code has no cap. */
export function remainingRedemptions(code: DiscountCode): number | null {
  if (code.max_redemptions === null) return null;
  return Math.max(0, code.max_redemptions - code.redemption_count);
}

/** A redemption row as far as "reserved or given?" needs it. */
export type RedemptionLike = Pick<DiscountRedemption, 'request_id' | 'amount_off'> & {
  /** 'reserved' or 'redeemed' when the server says; absent from an older read. */
  status?: string | null;
};

/**
 * Is this use only held for a request that has not been decided yet?
 *
 * request_package_change takes a code's use the moment the merchant sends a request with it —
 * so the caps hold when the merchant submits, and a code switched off later cannot strand a
 * request the merchant was already quoted. Approving keeps that use; rejecting or replacing
 * the request gives it back and removes the row. The server marks each row 'reserved' or
 * 'redeemed' and that answer wins; a read that does not carry it falls back to asking whether
 * the row's request is still in the pending queue.
 */
export function isReservedUse(row: RedemptionLike, pendingRequestIds: ReadonlySet<string>): boolean {
  if (row.status === 'reserved') return true;
  if (row.status === 'redeemed') return false;
  return row.request_id !== null && pendingRequestIds.has(row.request_id);
}

/**
 * What a reserved use is waiting for, as the list of uses words it.
 *
 * A request the merchant is paying by card (rail 'stripe') settles by itself when the payment
 * lands — nobody approves it — so "waiting for approval" sent the operator looking for an
 * Approve button that is not there. 'open' when the request is not in the pending list the page
 * read (that read can fail, or the request moved on since): the use is held, and the page does
 * not guess what for.
 */
export function reservationWait(
  row: Pick<RedemptionLike, 'request_id'>,
  pendingRequestIds: ReadonlySet<string>,
  cardRequestIds: ReadonlySet<string>,
): 'payment' | 'approval' | 'open' {
  const id = row.request_id;
  if (id !== null && cardRequestIds.has(id)) return 'payment';
  if (id !== null && pendingRequestIds.has(id)) return 'approval';
  return 'open';
}

/**
 * A code's redemptions, split into money given away and money only promised. Adding a
 * reservation to "given away" would report a discount on a sale that may never happen; every
 * other row — an approved request, or one with no request at all — came off a charge.
 */
export function splitRedemptions(
  rows: RedemptionLike[],
  pendingRequestIds: ReadonlySet<string>,
): { given: number; reserved: number } {
  let given = 0;
  let reserved = 0;
  for (const r of rows) {
    const amount = Number.isFinite(r.amount_off) ? Math.max(0, r.amount_off) : 0;
    if (isReservedUse(r, pendingRequestIds)) reserved += amount;
    else given += amount;
  }
  return { given, reserved };
}
