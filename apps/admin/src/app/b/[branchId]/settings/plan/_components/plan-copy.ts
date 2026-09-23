// The plan page's "what does the merchant actually believe" decisions, with no React in them
// so they can be pinned in a test.
//
// Everything here is about the gap between what the page says and what the ledger did. The
// arithmetic lives in plan-model.ts; this file only decides which sentence is honest.

import {
  billingErrorMessage,
  describeBillingError,
  discountReasonMessage,
  type PackageSelection,
  type UiLocale,
} from '@favornoms/shared';
import { sameSelection, selectionFromRequest, type PlanBranch } from './plan-model';

// --- the request the merchant already sent -----------------------------------

/**
 * A package request that has been sent and is waiting for the Favornoms team, with the money
 * exactly as request_package_change priced it.
 *
 * The server's figures are the ones to repeat. `oneTimeTotal` is stored net of the discount
 * and was priced against what the restaurant has PAID (a pending charge is on order, not
 * bought), so it is the amount the merchant will be asked for; working it out again from the
 * catalog could only ever disagree with it.
 */
export interface FiledRequest {
  /**
   * Null when the row carried none. The page treats that as "nothing was filed": it is how
   * request_package_change's {ok:false} refusal looks once read as a request row.
   */
  id: string | null;
  selection: PackageSelection;
  /** What is payable once if the request is approved, already net of the discount. */
  oneTimeTotal: number;
  discountCode: string | null;
  discountAmount: number;
  monthlyTotal: number;
  createdAt: string | null;
}

/** The fields of a billing_requests row this page reads. */
export interface RequestRow {
  id?: string | null;
  plan_code: string;
  branch_seats: number;
  delivery_branch_ids: string[];
  one_time_total?: number | null;
  discount_code?: string | null;
  discount_amount?: number | null;
  monthly_total?: number | null;
  created_at?: string | null;
}

/** A money figure from the database: a number of 0 or more, whatever arrived. */
const amount = (raw: unknown): number => {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * A stored or freshly returned request, as the page's own shape. Null when the row does not
 * name a plan: a row without one is not something the page can describe, and inventing a
 * selection for it would put words in the merchant's mouth.
 */
export function filedRequest(row: RequestRow | null | undefined): FiledRequest | null {
  if (!row || typeof row.plan_code !== 'string' || row.plan_code === '') return null;
  const code = typeof row.discount_code === 'string' ? row.discount_code.trim() : '';
  return {
    id: typeof row.id === 'string' && row.id !== '' ? row.id : null,
    selection: selectionFromRequest(row),
    oneTimeTotal: amount(row.one_time_total),
    discountCode: code === '' ? null : code.toUpperCase(),
    discountAmount: amount(row.discount_amount),
    monthlyTotal: amount(row.monthly_total),
    createdAt: typeof row.created_at === 'string' && row.created_at !== '' ? row.created_at : null,
  };
}

/**
 * Is what is on screen the request that was sent?
 *
 * The same selection with the same code (or with no new code applied) IS that request, so the
 * page shows the request's own money and cannot send it again. Applying a code the request does
 * not carry makes it a different request — the one-time total changes — so the page quotes it
 * afresh and offers to replace the one waiting. Without this a merchant who forgot their code
 * could type it, see it applied, and find the only button still reading "Request pending".
 */
export function showsFiledRequest(
  sel: PackageSelection,
  filed: FiledRequest | null,
  activeCode: string | null,
): boolean {
  if (!filed || !sameSelection(sel, filed.selection)) return false;
  return activeCode === null || activeCode.toUpperCase() === filed.discountCode;
}

/** The facts for the one-sentence summary of a filed request, in the server's figures. */
export function filedFacts(
  filed: FiledRequest,
  branches: PlanBranch[],
): { branches: number; deliveryNames: string[]; monthlyTotal: number } {
  const wanted = new Set(filed.selection.deliveryBranchIds);
  return {
    branches: filed.selection.branchSeats,
    // In the order the page lists the branches, so the sentence reads the way the page does.
    deliveryNames: branches.filter((b) => wanted.has(b.id)).map((b) => b.name),
    monthlyTotal: filed.monthlyTotal,
  };
}

// --- the Pay-once box --------------------------------------------------------

/** What the "Pay once today" box shows. */
export type PayOnceView =
  /** The request that was sent: its list price, its discount and what is left to pay. */
  | { kind: 'filed'; list: number; discount: number; code: string | null; total: number }
  /** Nothing one-time is owed for this selection — every fee in it has been paid. */
  | { kind: 'nothing' }
  /** The page's own quote for the selection on screen. */
  | { kind: 'quote' };

/**
 * Which story the Pay-once box tells.
 *
 * Once a request is sent its one-time charges are PENDING — on order, not bought — and the box
 * shows that request's own total with "nothing has been charged yet". It used to say "Nothing.
 * Everything in this package is already paid for." the moment a request was filed, while the
 * banner directly above it read "Plus $287 once": two statements about the same money, and the
 * reassuring one was false, because nobody had paid anything.
 *
 * "Nothing" is kept for the one case it is true: the selection has no one-time line against
 * what was actually paid. A request of $0 with no discount is that case as well — the server
 * priced it against the same paid-only ledger.
 */
export function payOnceView(args: {
  filed: FiledRequest | null;
  showingFiled: boolean;
  quoteLines: number;
}): PayOnceView {
  const { filed, showingFiled, quoteLines } = args;
  if (filed && showingFiled) {
    if (filed.oneTimeTotal <= 0 && filed.discountAmount <= 0 && quoteLines === 0) {
      return { kind: 'nothing' };
    }
    return {
      kind: 'filed',
      list: filed.oneTimeTotal + filed.discountAmount,
      discount: filed.discountAmount,
      // A code that took nothing off is not worth a line of its own.
      code: filed.discountAmount > 0 ? filed.discountCode : null,
      total: filed.oneTimeTotal,
    };
  }
  return quoteLines > 0 ? { kind: 'quote' } : { kind: 'nothing' };
}

// --- the discount code -------------------------------------------------------

/**
 * Was a code typed into the box and never priced?
 *
 * `submittableCode()` returns only a code the server accepted for THIS selection, so it is
 * null both for a code that was never applied and for one applied against another selection.
 * Submitting either way files the request at list price with no record that a code was ever
 * typed — the merchant's only clue would be a total that never moved. The page blocks and
 * says so instead.
 */
export function codeNeedsApplying(typed: string, submittable: string | null): boolean {
  return typed.trim().length > 0 && submittable === null;
}

/**
 * The applied quote after the merchant edits the code box.
 *
 * Typing over an applied code used to leave the quote in place: the field read SAVE99 while
 * WELCOME50 was still discounting the total, still labelling the green line and still the code
 * sent with the request. A quote belongs to the code that earned it, so editing away from that
 * code drops it and the box falls back to Apply and the list total.
 *
 * Compared upper-case and trimmed because that is how `applyCode()` stores what it sent.
 */
export function discountAfterTyping<T extends { code: string }>(
  applied: T | null,
  typed: string,
): T | null {
  if (!applied) return null;
  return applied.code === typed.trim().toUpperCase() ? applied : null;
}

// --- a request the server refused --------------------------------------------

/** The plan page's translator, narrowed to what this file needs from it. */
export type PlanTranslator = (key: string, values?: Record<string, string | number>) => string;

/**
 * What the merchant reads when a request could not be sent. The RPC and the edge function
 * answer with codes and raw database text; neither is shown as it is.
 *
 * Every discount refusal goes through the shared discountReasonMessage(), so the plan page and
 * every other screen say the same sentence for the same reason in every language. That includes
 * the guessing limit: request_package_change counts a refused code against the same budget as
 * validate_billing_discount, and a limit reached there is about the code, not about the package.
 */
export function requestErrorMessage(
  raw: string | undefined,
  t: PlanTranslator,
  locale: UiLocale,
): string {
  if (!raw) return t('errors.sendFailed');
  const billing = describeBillingError(raw);
  if (billing) return billingErrorMessage(billing, locale);
  if (raw.includes('rate_limited')) return discountReasonMessage('rate_limited', locale);
  if (raw.includes('auth_required') || raw.includes('not_signed_in')) return t('errors.signedOut');
  if (raw.includes('forbidden') || raw.includes('not_authorized') || raw.includes('42501')) {
    return t('errors.forbidden');
  }
  if (raw.includes('unknown_plan') || raw.includes('plan_not_purchasable')) {
    return t('errors.planUnavailable');
  }
  return t('errors.sendFailed');
}
