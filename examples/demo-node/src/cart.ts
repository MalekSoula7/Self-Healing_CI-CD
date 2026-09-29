export interface LineItem {
  sku: string;
  unitPriceCents: number;
  quantity: number;
}

export function lineTotal(item: LineItem): number {
  return item.unitPriceCents * item.quantity;
}

export function subtotal(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

/** Takes a percentage off an amount, rounded to the nearest cent. */
export function applyDiscount(amountCents: number, percent: number): number {
  if (percent < 0 || percent > 100) {
    throw new RangeError(`discount must be between 0 and 100, got ${String(percent)}`);
  }
  return Math.round((amountCents * (100 - percent)) / 100);
}
