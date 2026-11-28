import { describe, expect, it } from "vitest";
import { assertSeedable } from "./seed";
import { DEV_DATABASE_URL } from "./url";

describe("assertSeedable", () => {
  it("accepts a local development database", () => {
    expect(() => {
      assertSeedable(DEV_DATABASE_URL, "development");
    }).not.toThrow();
    expect(() => {
      assertSeedable(DEV_DATABASE_URL, undefined);
    }).not.toThrow();
  });

  it.each([
    ["a remote database", "postgresql://u:p@db.internal:5432/pipeheal", "development"],
    ["production", DEV_DATABASE_URL, "production"],
  ])("refuses %s", (_label, url, nodeEnv) => {
    expect(() => {
      assertSeedable(url, nodeEnv);
    }).toThrow(/^Refusing to seed/);
  });
});
