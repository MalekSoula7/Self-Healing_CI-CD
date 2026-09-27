import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import { DEV_DATABASE_URL, databaseUrlSchema } from "./url";

describe("databaseUrlSchema", () => {
  it.each([DEV_DATABASE_URL, "postgres://user:pw@db.internal:5432/pipeheal?sslmode=require"])(
    "accepts %s",
    (url) => {
      expect(databaseUrlSchema.safeParse(url).success).toBe(true);
    },
  );

  it.each(["mysql://user:pw@localhost/pipeheal", "http://localhost:5432", "not a url", ""])(
    "rejects %j",
    (url) => {
      expect(databaseUrlSchema.safeParse(url).success).toBe(false);
    },
  );
});

describe("createDb", () => {
  it("refuses an invalid URL without echoing it (it may carry a password)", () => {
    const attempt = () => createDb("mysql://admin:hunter2@db.internal/pipeheal");
    expect(attempt).toThrow(/^Invalid database URL/);
    expect(attempt).not.toThrow(/hunter2/);
  });

  // Unit tests block every socket: this would fail if creating the client opened a connection.
  it("creates a client without connecting", async () => {
    const db = createDb(DEV_DATABASE_URL);
    await expect(db.$disconnect()).resolves.toBeUndefined();
  });
});
