// Audit log writes (SPEC §10, P1.8). Only the data helpers call these, inside the transaction of
// the mutation they record, so a change and its audit row are committed together or not at all.
import type { Prisma } from "./generated/prisma/client";

/** Who performs an action: a signed-in user, or one of our own components (e.g. "webhook"). */
export type Actor = { type: "USER"; userId: string } | { type: "SYSTEM"; component: string };

export interface AuditEntry {
  /** Dotted verb, e.g. "repository.enabled". */
  action: string;
  /** What was acted on, e.g. "repository:<id>". */
  target: string;
  /** IDs and non-secret values only (never tokens, logs or customer file contents). */
  metadata?: Prisma.InputJsonObject;
}

export function auditTarget(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export async function writeAudit(
  tx: Prisma.TransactionClient,
  orgId: string,
  actor: Actor,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      orgId,
      actorType: actor.type,
      actorId: actor.type === "USER" ? actor.userId : actor.component,
      ...entry,
    },
  });
}
