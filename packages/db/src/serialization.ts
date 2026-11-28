import { Prisma } from "./generated/prisma/client";

/** Tries of a serializable transaction that Postgres refused with a serialization failure. */
const SERIALIZATION_TRIES = 4;

/** Prisma reports a refused statement as P2034, but a refused COMMIT as the adapter's own error. */
function isSerializationConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === "P2034";
  if (!(error instanceof Error) || error.name !== "DriverAdapterError") return false;
  const { cause } = error;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "kind" in cause &&
    cause.kind === "TransactionWriteConflict"
  );
}

/**
 * Runs a serializable transaction again when Postgres refuses it. Postgres's serializable mode can
 * refuse unrelated transactions that merely ran at the same time (P4.8 review L2): a retry sees
 * the winner's writes and decides again (e.g. "busy"). After the last try the error is thrown, and
 * the job's own retries take over.
 */
export async function retrySerialization<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!isSerializationConflict(error) || attempt >= SERIALIZATION_TRIES) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30));
      });
    }
  }
}
