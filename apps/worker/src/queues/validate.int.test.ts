// Needs Postgres: `docker compose up -d`. Validating a submission (P5.1c) against the real
// database, with GitHub (installation tokens, file contents) on msw and a scripted judge.
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { forSystem, installations } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createGitHubApp } from "@pipeheal/github";
import { createLogger } from "@pipeheal/shared/logger";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JudgeModel } from "../judge-model";
import { processValidationJob, type SubmissionsDeps } from "./submissions";
import { recordUncheckable } from "./validate";

const db = createTestDb();
const github = setupServer();
const logger = createLogger({ level: "silent", service: "test" });
const githubId = () => BigInt(randomInt(1, 2 ** 47));
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

beforeAll(() => {
  github.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  github.resetHandlers();
});
afterAll(async () => {
  github.close();
  await db.$disconnect();
});

const BUGGY = "export const sum = (a: number, b: number) => a - b;\n";
const FIXED = "export const sum = (a: number, b: number) => a + b;\n";
const TEST = "it('adds', () => { expect(sum(1, 1)).toBe(2); });\n";

/** GitHub: repository-scoped tokens (echoing the scope asked for), and files at the target. */
function mockGitHub(fullName: string, files: Record<string, string>) {
  const read: string[] = [];
  github.use(
    http.post("https://api.github.com/app/installations/:id/access_tokens", async ({ request }) => {
      const scope = z
        .object({
          repository_ids: z.array(z.number()),
          permissions: z.record(z.string(), z.string()),
        })
        .parse(await request.json());
      return HttpResponse.json({
        token: "ghs_testInstallationToken00000000000000",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        repository_selection: "selected",
        permissions: { ...scope.permissions, metadata: "read" },
        repositories: scope.repository_ids.map((id) => ({ id })),
      });
    }),
    http.get(`https://api.github.com/repos/${fullName}/contents/*`, ({ params, request }) => {
      const path = String(params[0]);
      read.push(`${path}@${new URL(request.url).searchParams.get("ref") ?? ""}`);
      const content = files[path];
      if (content === undefined) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      return HttpResponse.json({
        type: "file",
        path,
        size: content.length,
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
      });
    }),
  );
  return read;
}

/** An attempt whose runner uploaded `files`; it is VALIDATING unless told otherwise. */
async function submitted(
  files: { path: string; content: string }[],
  status: "VALIDATING" | "RUNNING" = "VALIDATING",
) {
  const login = `V${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const org = await installations(db, "test").upsert({
    githubAccountId: githubId(),
    login,
    accountType: "ORG",
    installationId: githubId(),
  });
  const system = await forSystem(db, org.id, "test");
  const [repo] = await system.repositories.syncInstalled([
    { githubRepoId: githubId(), fullName: `${login}/app`, defaultBranch: "main" },
  ]);
  if (repo === undefined) throw new Error("test setup: no repository");
  await system.repositories.setEnabled(repo.id, true);
  const { failure } = await system.failures.recordFailedRun(repo.id, {
    headSha: "c".repeat(40),
    headBranch: "main",
    runId: githubId(),
    runAttempt: 1,
    workflowId: 11n,
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    conclusion: "failure",
    htmlUrl: null,
    jobs: [{ githubJobId: githubId(), name: "check", failedStep: "Test", htmlUrl: null }],
  });
  const attempt = await system.attempts.create({
    failureId: failure.id,
    targetSha: failure.headSha,
    failingCheck: "test",
  });
  await db.healAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "AWAITING_SUBMISSION",
      baselineTests: { available: true, tests: [["sum::adds", ["failed"]]] },
    },
  });
  await system.attempts.acceptSubmission(attempt.id, {
    requestHash: "e".repeat(64),
    files,
    checks: [{ name: "test", exitCode: 0, output: "1 passed" }],
    afterTests: { available: true, tests: [["sum::adds", ["passed"]]] },
  });
  if (status !== "VALIDATING") {
    await db.healAttempt.update({ where: { id: attempt.id }, data: { status } });
  }
  return {
    orgId: org.id,
    attemptId: attempt.id,
    failureId: failure.id,
    fullName: repo.fullName,
    repoId: repo.id,
    system,
  };
}

/** A judge that must not be called: these policies have no judge rules. */
const noJudge: JudgeModel = {
  judge: () => Promise.reject(new Error("the judge was called")),
};

const deps = (): SubmissionsDeps => ({
  db,
  githubApp: createGitHubApp({ appId: 1234, privateKey, retries: 0 }),
  judge: noJudge,
  logger,
});

const job = (target: { orgId: string; attemptId: string }) => ({
  name: "validate",
  data: { orgId: target.orgId, attemptId: target.attemptId },
});

describe("validate job (P5.1c)", () => {
  it("checks the fix against the target commit's files and marks it VALIDATED", async () => {
    const target = await submitted([{ path: "src/sum.ts", content: FIXED }]);
    const read = mockGitHub(target.fullName, { "src/sum.ts": BUGGY });

    await processValidationJob(job(target), deps());

    expect(read).toEqual([`src/sum.ts@${"c".repeat(40)}`]);
    const attempt = await db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } });
    expect(attempt).toMatchObject({
      status: "VALIDATED",
      validation: {
        passed: true,
        reasons: [],
        violations: [],
        behavior: { available: true, reason: null },
        changedFiles: 1,
      },
    });
  });

  it("rejects a fix that rewrites a test, judged on GitHub's copy, without the judge", async () => {
    const target = await submitted([
      { path: "src/sum.test.ts", content: "it('adds', () => {});\n" },
    ]);
    mockGitHub(target.fullName, { "src/sum.test.ts": TEST });

    await processValidationJob(job(target), deps());

    const attempt = await db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } });
    expect(attempt.status).toBe("REJECTED");
    expect(attempt.finishedAt).not.toBeNull();
    const violations = z
      .object({ violations: z.array(z.object({ ruleId: z.string() })) })
      .parse(attempt.validation).violations;
    expect(violations.map((violation) => violation.ruleId)).toContain("tests.mode");
    await expect(
      db.pipelineFailure.findUniqueOrThrow({ where: { id: target.failureId } }),
    ).resolves.toMatchObject({ status: "FAILED" });
  });

  it("does nothing for an attempt that isn't VALIDATING (no GitHub call)", async () => {
    const target = await submitted([{ path: "src/sum.ts", content: FIXED }], "RUNNING");

    await processValidationJob(job(target), deps());

    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }),
    ).resolves.toMatchObject({ status: "RUNNING", validation: null });
  });

  it("refuses without calling GitHub when the repository is no longer enabled", async () => {
    const target = await submitted([{ path: "src/sum.ts", content: FIXED }]);
    await target.system.repositories.setEnabled(target.repoId, false);

    await processValidationJob(job(target), deps());

    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }),
    ).resolves.toMatchObject({
      status: "REJECTED",
      endReason: "the organization or repository is no longer enabled",
    });
  });

  it("refuses more files than the policy allows before fetching any", async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      path: `src/f${String(index)}.ts`,
      content: "export {};",
    }));
    const target = await submitted(many);

    await processValidationJob(job(target), deps());

    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }),
    ).resolves.toMatchObject({
      status: "REJECTED",
      endReason: "the submission changes 6 files; the policy allows 5",
    });
  });

  it("retries without a GitHub App, then ends the attempt rather than leave it VALIDATING", async () => {
    const target = await submitted([{ path: "src/sum.ts", content: FIXED }]);

    await expect(processValidationJob(job(target), { ...deps(), githubApp: null })).rejects.toThrow(
      /GitHub App/,
    );
    await recordUncheckable(db, { orgId: target.orgId, attemptId: target.attemptId });

    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }),
    ).resolves.toMatchObject({
      status: "REJECTED",
      endReason: "the submission couldn't be checked",
    });
  });

  it("refuses jobs it doesn't know", async () => {
    await expect(processValidationJob({ name: "other", data: {} }, deps())).rejects.toThrow(
      /unknown submissions job/,
    );
  });
});
