import { describe, expect, it } from "vitest";
import { receiptLines } from "../src/receipt";

describe("receiptLines", () => {
  const items = [
    { sku: "MUG", unitPriceCents: 1250, quantity: 2 },
    { sku: "TEA", unitPriceCents: 899, quantity: 1 },
  ];

  it("prints each line and the total", () => {
    expect(receiptLines(items)).toEqual(["2 x MUG  $25.00", "1 x TEA  $8.99", "Total  $33.99"]);
  });

  it("shows the discount and the discounted total", () => {
    expect(receiptLines(items, 10)).toEqual([
      "2 x MUG  $25.00",
      "1 x TEA  $8.99",
      "Discount 10%",
      "Total  $30.59",
    ]);
  });
});
