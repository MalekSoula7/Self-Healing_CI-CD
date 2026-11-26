// The `rules` queue (SPEC §8.7, P3.9): compiles a proposed custom rule with the model and stores
// the proposal on its draft. The model's layer is validated with packages/policy's schema here;
// nothing it proposes takes effect until an admin confirms it on the policy page.
import { forSystem, type Db } from "@pipeheal/db";
import { policyLayerSchema } from "@pipeheal/policy";
import { RULES_QUEUE, ruleJobDataSchema, type RuleJobData } from "@pipeheal/shared";
import type { Logger } from "@pipeheal/shared/logger";
import { UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { RuleModel } from "../rule-model";

export interface RulesDeps {
  db: Db;
  ruleModel: RuleModel | null;
  logger: Logger;
}

interface QueueJob {
  id?: string | undefined;
  name: string;
  data: unknown;
}

function short(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length <= 300 ? line : `${line.slice(0, 297)}...`;
}

export async function processRulesJob(job: QueueJob, deps: RulesDeps): Promise<void> {
  if (job.name !== "compile-rule") throw new UnrecoverableError(`unknown rules job "${job.name}"`);
  const data: RuleJobData = ruleJobDataSchema.parse(job.data);
  const log = deps.logger.child({ jobId: job.id, draftId: data.draftId });
  const system = await forSystem(deps.db, data.orgId, "rule-compiler");
  const draft = await system.customRules.getDraft(data.draftId);
  if (draft?.status !== "PENDING") return;
  if (deps.ruleModel === null) {
    await system.customRules.recordCompiled(draft.id, { error: "the rule model isn't configured" });
    return;
  }
  const answer = await deps.ruleModel.compile(draft.text);
  if (answer === null) {
    await system.customRules.recordCompiled(draft.id, { error: "the model gave no valid answer" });
    log.info("rule not compiled");
    return;
  }
  if (answer.layer === null) {
    await system.customRules.recordCompiled(draft.id, {
      compiled: null,
      explanation: answer.explanation,
    });
    log.info({ expressible: false }, "rule compiled");
    return;
  }
  const layer = policyLayerSchema.safeParse(answer.layer);
  if (!layer.success || layer.data.customRules !== undefined) {
    const issue = layer.success
      ? "it holds custom rules"
      : (layer.error.issues[0]?.message ?? "invalid");
    await system.customRules.recordCompiled(draft.id, {
      error: short(`the model's layer isn't valid: ${issue}`),
    });
    log.info("rule not compiled: invalid layer");
    return;
  }
  await system.customRules.recordCompiled(draft.id, {
    compiled: layer.data,
    explanation: answer.explanation,
  });
  log.info({ expressible: true }, "rule compiled");
}

// `prefix` isolates keys (tests use a unique one); production uses BullMQ's default.
export function createRulesWorker(connection: Redis, deps: RulesDeps, prefix?: string) {
  // One at a time: the model server runs one call at a time anyway (D11).
  const worker = new Worker(RULES_QUEUE, (job) => processRulesJob(job, deps), {
    connection,
    concurrency: 1,
    ...(prefix === undefined ? {} : { prefix }),
  });
  worker.on("failed", (job, error) => {
    deps.logger.error({ jobId: job?.id, err: error }, "rules job failed");
  });
  worker.on("error", (error) => {
    deps.logger.error({ error: error.message }, "rules worker error");
  });
  return worker;
}
