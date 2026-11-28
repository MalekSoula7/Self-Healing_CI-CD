// What the repo page shows about `.pipeheal.yml` (P3.7), from the fields the worker stores. The
// stored JSON is re-validated: the database isn't trusted to hold the shape we wrote.
import { z } from "zod";

export type PolicyFileStatus =
  | { state: "unread" }
  | { state: "absent"; commitSha: string; readAt: Date | null }
  | { state: "loaded"; commitSha: string; readAt: Date | null; fields: string[] }
  | { state: "invalid"; commitSha: string; readAt: Date | null; errors: string[] };

interface PolicyFileFields {
  policyFile: unknown;
  policyFileErrors: unknown;
  policyFileCommitSha: string | null;
  policyFileReadAt: Date | null;
}

const errorsSchema = z.array(z.string()).min(1);
const layerSchema = z.record(z.string(), z.unknown());

export function policyFileStatus(repo: PolicyFileFields): PolicyFileStatus {
  const commitSha = repo.policyFileCommitSha;
  if (commitSha === null) return { state: "unread" };
  const readAt = repo.policyFileReadAt;
  const errors = errorsSchema.safeParse(repo.policyFileErrors);
  if (errors.success) return { state: "invalid", commitSha, readAt, errors: errors.data };
  const layer = layerSchema.safeParse(repo.policyFile);
  if (layer.success) {
    return { state: "loaded", commitSha, readAt, fields: Object.keys(layer.data).sort() };
  }
  return { state: "absent", commitSha, readAt };
}
