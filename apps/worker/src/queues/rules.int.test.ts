// The `compile-rule` job (SPEC §8.7, P3.9) against a real database, with a fake rule model.
import { randomInt, randomUUID } from "node:crypto";
import type { RuleCompileOutput } from "@pipeheal/agent-core";
import { forSystem, installations } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createLogger } from "@pipeheal/shared/logger";
import { afterAll, describe, expect, it } from "vitest";
import type { RuleModel } from "../rule-model";
import { processRulesJob } from "./rules";

const db = createTestDb();
const logger = createLogger({ level: "silent", service: "test" });

afterAll(async () => {
  await db.$disconnect();
});

async function proposed(text: string) {
  const org = await installations(db, "test").upsert({
    githubAccountId: BigInt(randomInt(1, 2 ** 47)),
    login: `org-${randomUUID().slice(0, 8)}`,
    accountType: "ORG",
    installationId: BigInt(randomInt(1, 2 ** 47)),
  });
  const system = await forSystem(db, org.id, "test");
  const draft = await system.customRules.propose("ORG_DEFAULT", null, text);
  return { system, job: { name: "compile-rule", data: { orgId: org.id, draftId: draft.id } } };
}

function answering(answer: RuleCompileOutput | null): RuleModel & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    compile(text) {
      texts.push(text);
      return Promise.resolve(answer);
    },
  };
}

describe("compile-rule job", () => {
  it("stores a valid compiled layer for the admin to confirm, once", async () => {
    const { system, job } = await proposed("Never touch payments.");
    const model = answering({
      expressible: true,
      layer: { paths: { deny: ["src/payments/**"] } },
      explanation: "Denies the payments module.",
    });

    await processRulesJob(job, { db, logger, ruleModel: model });
    await processRulesJob(job, { db, logger, ruleModel: model });

    expect(await system.customRules.getDraft(job.data.draftId)).toMatchObject({
      status: "COMPILED",
      compiled: { paths: { deny: ["src/payments/**"] } },
      explanation: "Denies the payments module.",
    });
    expect(model.texts).toEqual(["Never touch payments."]);
  });

  it("keeps a rule the model can't express for the judge", async () => {
    const { system, job } = await proposed("Keep public APIs stable.");

    await processRulesJob(job, {
      db,
      logger,
      ruleModel: answering({ expressible: false, layer: null, explanation: "Needs meaning." }),
    });

    expect(await system.customRules.getDraft(job.data.draftId)).toMatchObject({
      status: "COMPILED",
      compiled: null,
    });
  });

  it.each([
    ["no answer", null, "the model gave no valid answer"],
    [
      "a layer the policy schema refuses",
      { expressible: true, layer: { limits: { maxFilesChanged: 999 } }, explanation: "x" },
      "the model's layer isn't valid",
    ],
    [
      "a layer holding custom rules",
      {
        expressible: true,
        layer: { customRules: [{ id: "CR-1", text: "y", enforcement: "judge" }] },
        explanation: "x",
      },
      "it holds custom rules",
    ],
  ] as const)("records a failure for %s", async (_, answer, error) => {
    const { system, job } = await proposed("x");

    await processRulesJob(job, { db, logger, ruleModel: answering(answer) });

    const draft = await system.customRules.getDraft(job.data.draftId);
    expect(draft?.status).toBe("FAILED");
    expect(draft?.error).toContain(error);
  });

  it("records a failure when no model is configured, and refuses unknown jobs", async () => {
    const { system, job } = await proposed("x");

    await processRulesJob(job, { db, logger, ruleModel: null });

    expect((await system.customRules.getDraft(job.data.draftId))?.status).toBe("FAILED");
    await expect(
      processRulesJob({ ...job, name: "other" }, { db, logger, ruleModel: null }),
    ).rejects.toThrow(/unknown rules job/);
  });
});
