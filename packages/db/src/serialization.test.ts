// Retrying transactions Postgres refuses with a serialization failure.
import { describe, expect, it } from "vitest";
import { Prisma } from "./generated/prisma/client";
import { retrySerialization } from "./serialization";

/** The query engine's report, when a statement inside the transaction is refused. */
const fromQuery = () =>
  new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "7" });

/** The driver adapter's report, when the COMMIT itself is refused. */
function fromCommit(): Error {
  const error = new Error("TransactionWriteConflict", {
    cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
  });
  error.name = "DriverAdapterError";
  return error;
}

function failing(errors: Error[]) {
  let calls = 0;
  const work = () => {
    calls++;
    const error = errors.shift();
    return error === undefined ? Promise.resolve("done") : Promise.reject(error);
  };
  return { work, calls: () => calls };
}

describe("retrySerialization", () => {
  it.each([
    ["a statement", fromQuery],
    ["the commit", fromCommit],
  ])("runs again when %s is refused", async (_case, refusal) => {
    const { work, calls } = failing([refusal(), refusal()]);

    await expect(retrySerialization(work)).resolves.toBe("done");
    expect(calls()).toBe(3);
  });

  it("gives up after four tries", async () => {
    const { work, calls } = failing(Array.from({ length: 9 }, fromCommit));

    await expect(retrySerialization(work)).rejects.toThrow("TransactionWriteConflict");
    expect(calls()).toBe(4);
  });

  it("throws any other error at once", async () => {
    const other = new Error("boom", { cause: { kind: "UniqueConstraintViolation" } });
    other.name = "DriverAdapterError";
    const { work, calls } = failing([other]);

    await expect(retrySerialization(work)).rejects.toBe(other);
    expect(calls()).toBe(1);
  });
});
