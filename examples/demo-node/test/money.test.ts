import { describe, expect, it } from "vitest";
import { formatCents } from "../src/money";

describe("formatCents", () => {
  it("formats dollars and cents", () => {
    expect(formatCents(1205)).toBe("$12.05");
    expect(formatCents(1250)).toBe("$12.50");
    expect(formatCents(99)).toBe("$0.99");
  });

  it("groups thousands", () => {
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });

  it("formats refunds as negative amounts", () => {
    expect(formatCents(-250)).toBe("-$2.50");
  });

  it("rejects fractions of a cent", () => {
    expect(() => formatCents(1.5)).toThrow(TypeError);
  });
});
