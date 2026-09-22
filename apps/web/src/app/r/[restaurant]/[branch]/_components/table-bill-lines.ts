import { formatCurrency } from '@favornoms/shared';
import type { TableSessionBillOption } from '@favornoms/database/queries';

/**
 * What the diners' table bill prints under a line: the options that were chosen.
 *
 * get_table_session_bill lists a round's lines in menu order, so the same dish ordered twice with
 * different options sits on two lines side by side. Printed as name and quantity alone, a SET A
 * with no egg and a SET A with a fried egg read as one dish listed twice, which looks like the
 * round was split by mistake. The options are what tell the two apart.
 */

/** "Runny-Yolk Fried Egg (+$2.00)", "No cheese (-$0.50)", or just "No Egg" when it is free. */
export function billOptionLabel(option: TableSessionBillOption): string {
  const delta = Number(option.price_delta);
  if (!Number.isFinite(delta) || delta === 0) return option.name;
  // Signed the way the cart prints an option, so the bill reads like the cart the diner filled.
  return `${option.name} (${delta > 0 ? '+' : ''}${formatCurrency(delta)})`;
}

/**
 * A bill line's options as the bill prints them, in the order they were chosen. [] for a line
 * with none, and for a bill from a server that does not send them yet.
 */
export function billLineOptions(item: {
  options?: ReadonlyArray<TableSessionBillOption | null> | null;
}): string[] {
  const out: string[] = [];
  for (const option of item.options ?? []) {
    if (!option || typeof option.name !== 'string' || !option.name.trim()) continue;
    out.push(billOptionLabel({ name: option.name.trim(), price_delta: option.price_delta }));
  }
  return out;
}
