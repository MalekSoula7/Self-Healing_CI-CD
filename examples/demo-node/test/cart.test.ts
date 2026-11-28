import { describe, expect, it } from "vitest";
import { applyDiscount, lineTotal, subtotal, type LineItem } from "../src/cart";

const items: LineItem[] = [
  { sku: "MUG", unitPriceCents: 1250, quantity: 2 },
  { sku: "TEA", unitPriceCents: 899, quantity: 1 },
];

describe("cart totals", () => {
  it("multiplies the unit price by the quantity", () => {
    expect(lineTotal({ sku: "MUG", unitPriceCents: 1250, quantity: 3 })).toBe(3750);
  });

  it("adds up every line", () => {
    expect(subtotal(items)).toBe(3399);
    expect(subtotal([])).toBe(0);
  });
});

describe("applyDiscount", () => {
  it("takes a percentage off, rounded to the nearest cent", () => {
    expect(applyDiscount(3399, 15)).toBe(2889);
    expect(applyDiscount(3399, 0)).toBe(3399);
    expect(applyDiscount(3399, 100)).toBe(0);
  });

  it("rejects a discount outside 0-100%", () => {
    expect(() => applyDiscount(1000, 150)).toThrow(RangeError);
    expect(() => applyDiscount(1000, -5)).toThrow(RangeError);
  });
});
