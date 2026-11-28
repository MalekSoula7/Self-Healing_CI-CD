// The BullMQ job `apps/web` enqueues when an admin proposes a custom rule, and `apps/worker`
// consumes to compile it with the model (SPEC §8.7, P3.9). Only IDs travel: the worker reads the
// draft from the database.
import { z } from "zod";

export const RULES_QUEUE = "rules";

export const ruleJobDataSchema = z.strictObject({
  orgId: z.uuid(),
  draftId: z.uuid(),
});
export type RuleJobData = z.infer<typeof ruleJobDataSchema>;
