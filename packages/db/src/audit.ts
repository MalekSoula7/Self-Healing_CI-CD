// Audit log writes (SPEC §10, P1.8). Only the data helpers call these, inside the transaction of
// the mutation they record, so a change and its audit row are committed together or not at all.
// Nothing outside packages/db writes tenant tables, and nothing updates or deletes an audit row
// (both enforced in eslint.config.mjs). Not audited, by design: Better Auth's own user, account,
// session and verification rows (sign-in, not a change to any organization) and WebhookDelivery
// (the ingest record itself; what a delivery changes is audited by the helpers it calls).
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

/** Non-secret column values an audit entry may record. */
export type AuditValue = string | number | boolean | bigint | null | readonly string[];

function toJson(value: AuditValue | undefined): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "object") return [...value];
  return value;
}

/**
 * `{ field: { from, to } }` for each field of `after` whose value differs from `before`: what an
 * update changed. Callers pick the fields, so nothing is recorded that wasn't chosen on purpose.
 */
export function auditChanges(
  before: Readonly<Record<string, AuditValue>>,
  after: Readonly<Record<string, AuditValue>>,
): Prisma.InputJsonObject {
  const changes: Record<string, Prisma.InputJsonObject> = {};
  for (const [field, value] of Object.entries(after)) {
    const from = toJson(before[field]);
    const to = toJson(value);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  return changes;
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
