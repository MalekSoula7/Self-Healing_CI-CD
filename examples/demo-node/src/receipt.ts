import { applyDiscount, lineTotal, subtotal, type LineItem } from "./cart";
import { formatCents } from "./money";

/** The printed receipt, one string per line. */
export function receiptLines(items: readonly LineItem[], discountPercent = 0): string[] {
  const lines = items.map(
    (item) => `${String(item.quantity)} x ${item.sku}  ${formatCents(lineTotal(item))}`,
  );
  if (discountPercent > 0) lines.push(`Discount ${String(discountPercent)}%`);
  lines.push(`Total  ${formatCents(applyDiscount(subtotal(items), discountPercent))}`);
  return lines;
}
