import { consolidateOrderLines } from '@favornoms/shared';
import type { CartLine } from '@/store/cart';

/**
 * The cart's lines as place-order is sent them: one line per selection, exactly the lines the
 * cart's subtotal() prices.
 *
 * The cart keeps two lines apart while a note is being edited to match another line's (folding
 * one away under the diner's cursor would lose what they were typing), but subtotal() already
 * prices the pair as one line, and place-order bills them as one (consolidateLines, v11.5). Sent
 * raw, the payload was not the thing quoted on screen; sent through consolidateOrderLines, the
 * same helper the till and place-order's mirror use, it is. Combo lines carry their combo id in
 * the menuItemId slot, so they go as combos and never merge with a dish that shares the id.
 */
export function orderLinesFromCart(lines: readonly CartLine[]) {
  return consolidateOrderLines(
    lines
      .filter((l) => !l.comboId)
      .map((l) => ({
        menu_item_id: l.menuItemId,
        quantity: l.quantity,
        notes: l.notes,
        modifier_option_ids: l.modifiers?.map((m) => m.option_id),
      })),
    lines
      .filter((l) => l.comboId)
      .map((l) => ({
        combo_id: l.comboId!,
        quantity: l.quantity,
        notes: l.notes,
      })),
  );
}
