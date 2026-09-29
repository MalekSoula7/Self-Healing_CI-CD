import { describe, expect, it } from "vitest";
import { TEST_DATABASE, testDatabaseUrl } from "./database";

describe("testDatabaseUrl", () => {
  it("points at the test database on the same local server", () => {
    const url = new URL(testDatabaseUrl("postgresql://pipeheal:pipeheal@localhost:5433/pipeheal"));
    expect(url.pathname).toBe(`/${TEST_DATABASE}`);
    expect(url.host).toBe("localhost:5433");
    expect(url.username).toBe("pipeheal");
  });

  // The test setup drops this database: never on a shared or production server.
  it.each([
    "postgresql://u:p@db.internal:5432/pipeheal",
    "postgresql://u:p@localhost.evil.example/x",
  ])("refuses the non-local server %s", (url) => {
    expect(() => testDatabaseUrl(url)).toThrow(/^Refusing to run database tests/);
  });
});
