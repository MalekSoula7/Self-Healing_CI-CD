// Needs Postgres: `docker compose up -d` (runs against the `pipeheal_test` database).
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "./testing";
import { githubIdentity } from "./users";

const db = createTestDb();

afterAll(async () => {
  await db.$disconnect();
});

async function userWithAccount(providerId: string, accountId: string) {
  const id = randomUUID();
  await db.user.create({ data: { id, name: "Test User", email: `${id}@example.test` } });
  const account = await db.account.create({
    data: { id: randomUUID(), userId: id, providerId, accountId, accessToken: "encrypted" },
  });
  return { userId: id, accountRowId: account.id };
}

describe("githubIdentity", () => {
  it("returns the GitHub account link without tokens", async () => {
    const githubUserId = BigInt(randomInt(1, 2 ** 47));
    const { userId, accountRowId } = await userWithAccount("github", String(githubUserId));

    const identity = await githubIdentity(db, userId);

    expect(identity).toEqual({ accountRowId, githubUserId });
  });

  it("returns null without a GitHub account, or with a malformed GitHub ID", async () => {
    const other = await userWithAccount("gitlab", "123");
    const malformed = await userWithAccount("github", "12abc");
    const zero = await userWithAccount("github", "0");

    await expect(githubIdentity(db, other.userId)).resolves.toBeNull();
    await expect(githubIdentity(db, malformed.userId)).resolves.toBeNull();
    await expect(githubIdentity(db, zero.userId)).resolves.toBeNull();
    await expect(githubIdentity(db, randomUUID())).resolves.toBeNull();
  });
});
