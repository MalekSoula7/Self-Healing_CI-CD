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
import { recordUnpublishable } from "./publish";
import { recordUncheckable } from "./validate";
import { submissionDigest } from "../submission-check";

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
      const text = await request.text();
      const token = {
        token: "ghs_testInstallationToken00000000000000",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      };
      // The write client (the PR) asks for an unscoped token: no body.
      if (text === "") return HttpResponse.json(token);
      const scope = z
        .object({
          repository_ids: z.array(z.number()),
          permissions: z.record(z.string(), z.string()),
        })
        .parse(JSON.parse(text));
      return HttpResponse.json({
        ...token,
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

/** Publish jobs the validation queued. */
const published: { orgId: string; attemptId: string }[] = [];

const deps = (): SubmissionsDeps => ({
  db,
  githubApp: createGitHubApp({ appId: 1234, privateKey, retries: 0 }),
  judge: noJudge,
  enqueuePublish: (target) => {
    published.push(target);
    return Promise.resolve();
  },
  model: "qwen3:14b",
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
    expect(published).toContainEqual({ orgId: target.orgId, attemptId: target.attemptId });
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
    expect(published.map((job) => job.attemptId)).not.toContain(target.attemptId);
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

/**
 * A retry after red CI: the first attempt (`submitted`) is CI_FAILED on PipeHeal's commit, and
 * the second uploaded `files`.
 */
async function retried(
  first: { path: string; content: string }[],
  files: ({ path: string; content: string } | { path: string; deleted: true })[],
  afterTests: [string, ("passed" | "failed")[]][] = [["sum::adds", ["passed"]]],
) {
  const target = await submitted(first);
  const commitSha = "d".repeat(40);
  await db.healAttempt.update({
    where: { id: target.attemptId },
    data: { status: "CI_FAILED", branch: "pipeheal/abc-1", commitSha, prNumber: 42 },
  });
  await db.pipelineFailure.update({
    where: { id: target.failureId },
    data: { status: "NEEDS_HUMAN" },
  });
  const claim = await target.system.attempts.claimRetry({
    previousAttemptId: target.attemptId,
    failingCheck: "test",
    feedback: [],
    maxAttemptsPerFailure: 2,
    maxAttemptsPerDay: 20,
  });
  if (claim.outcome !== "created") throw new Error(`test setup: ${claim.outcome}`);
  const attemptId = claim.attempt.id;
  await db.healAttempt.update({
    where: { id: attemptId },
    data: {
      status: "AWAITING_SUBMISSION",
      // What the second runner saw: not the baseline the fix is judged against.
      baselineTests: { available: true, tests: [] },
    },
  });
  await target.system.attempts.acceptSubmission(attemptId, {
    requestHash: "f".repeat(64),
    files,
    checks: [{ name: "test", exitCode: 0, output: "1 passed" }],
    afterTests: { available: true, tests: afterTests },
  });
  return { ...target, attemptId, commitSha };
}

describe("validate job: a retry (P5.3d)", () => {
  const stored = (attemptId: string) =>
    db.healAttempt.findUniqueOrThrow({ where: { id: attemptId } });

  it("checks both attempts' changes against the original commit", async () => {
    const target = await retried(
      [{ path: "src/sum.ts", content: FIXED }],
      [{ path: "src/other.ts", content: "export const two = 2;\n" }],
    );
    const read = mockGitHub(target.fullName, { "src/sum.ts": BUGGY });

    await processValidationJob(job(target), deps());

    expect(read.sort()).toEqual([`src/other.ts@${"c".repeat(40)}`, `src/sum.ts@${"c".repeat(40)}`]);
    expect(await stored(target.attemptId)).toMatchObject({
      status: "VALIDATED",
      validation: {
        passed: true,
        changedFiles: 2,
        digest: submissionDigest(target.commitSha, [
          { path: "src/other.ts", content: "export const two = 2;\n" },
        ]),
      },
    });
  });

  it("holds the two together to the file limit", async () => {
    const files = (prefix: string) =>
      Array.from({ length: 3 }, (_, index) => ({
        path: `src/${prefix}${String(index)}.ts`,
        content: "export {};\n",
      }));
    const target = await retried(files("a"), files("b"));
    mockGitHub(target.fullName, {});

    await processValidationJob(job(target), deps());

    expect(await stored(target.attemptId)).toMatchObject({ status: "REJECTED" });
    await expect(
      db.pipelineFailure.findUniqueOrThrow({ where: { id: target.failureId } }),
    ).resolves.toMatchObject({ status: "NEEDS_HUMAN" });
  });

  it("compares the tests with the first attempt's baseline", async () => {
    const target = await retried(
      [{ path: "src/sum.ts", content: FIXED }],
      [{ path: "src/other.ts", content: "export {};\n" }],
      [["sum::renamed", ["passed"]]],
    );
    mockGitHub(target.fullName, { "src/sum.ts": BUGGY });

    await processValidationJob(job(target), deps());

    expect(await stored(target.attemptId)).toMatchObject({ status: "REJECTED" });
  });

  it("accepts a retry that removes a file the first attempt added", async () => {
    const target = await retried(
      [
        { path: "src/sum.ts", content: FIXED },
        { path: "src/extra.ts", content: "export {};\n" },
      ],
      [{ path: "src/extra.ts", deleted: true }],
    );
    mockGitHub(target.fullName, { "src/sum.ts": BUGGY });

    await processValidationJob(job(target), deps());

    expect(await stored(target.attemptId)).toMatchObject({
      status: "VALIDATED",
      validation: { changedFiles: 1 },
    });
  });

  it("refuses a retry whose earlier changes can't be read", async () => {
    const target = await retried(
      [{ path: "src/sum.ts", content: FIXED }],
      [{ path: "src/other.ts", content: "export {};\n" }],
    );
    const { retryOfId } = await stored(target.attemptId);
    await db.attemptSubmission.delete({ where: { attemptId: retryOfId ?? "" } });

    await processValidationJob(job(target), deps());

    expect(await stored(target.attemptId)).toMatchObject({
      status: "REJECTED",
      endReason: "the earlier attempts' changes couldn't be read",
    });
  });
});

/** GitHub's Git Data and pull request APIs for one repository, recording every write. */
function mockPublish(
  fullName: string,
  options: {
    refusePullRequest?: boolean;
    /** The failing branch's tip: its commit, null when the branch is gone. */
    baseTip?: string | null;
    /** How the healed commit compares with the tip. */
    comparison?: "ahead" | "behind" | "diverged";
    branchExists?: boolean;
  } = {},
) {
  const api = `https://api.github.com/repos/${fullName}`;
  const repoRef = { id: 777, full_name: fullName };
  const commit = "9".repeat(40);
  const writes: { what: string; body: unknown }[] = [];
  const pull = (ref: string) => ({
    number: 42,
    html_url: `https://github.com/${fullName}/pull/42`,
    state: "open",
    draft: true,
    merged: false,
    head: { ref, sha: commit, repo: repoRef },
    base: { ref: "main", repo: repoRef },
  });
  let headRef = "";
  const baseTip = options.baseTip === undefined ? "c".repeat(40) : options.baseTip;
  github.use(
    http.get(`${api}/git/ref/*`, ({ params }) => {
      const ref = String(params[0]);
      const sha =
        ref === "heads/main" ? baseTip : options.branchExists === true ? "8".repeat(40) : null;
      return sha === null
        ? HttpResponse.json({ message: "Not Found" }, { status: 404 })
        : HttpResponse.json({ ref: `refs/${ref}`, object: { sha } });
    }),
    http.get(`${api}/compare/:basehead`, () =>
      HttpResponse.json({
        status: options.comparison ?? "ahead",
        ahead_by: 1,
        behind_by: options.comparison === "ahead" || options.comparison === undefined ? 0 : 1,
        total_commits: 1,
        commits: [],
        files: [],
      }),
    ),
    http.get(`${api}/git/commits/:sha`, () =>
      HttpResponse.json({ sha: "c".repeat(40), tree: { sha: "1".repeat(40) } }),
    ),
    http.get(`${api}/git/trees/:sha`, ({ params }) =>
      HttpResponse.json(
        params.sha === "1".repeat(40)
          ? {
              sha: "1".repeat(40),
              tree: [{ path: "src", mode: "040000", type: "tree", sha: "2".repeat(40) }],
            }
          : {
              sha: "2".repeat(40),
              tree: [{ path: "sum.ts", mode: "100644", type: "blob", sha: "3".repeat(40) }],
            },
      ),
    ),
    http.post(`${api}/git/trees`, async ({ request }) => {
      writes.push({ what: "tree", body: await request.json() });
      return HttpResponse.json({ sha: "4".repeat(40) }, { status: 201 });
    }),
    http.post(`${api}/git/commits`, async ({ request }) => {
      writes.push({ what: "commit", body: await request.json() });
      return HttpResponse.json({ sha: commit }, { status: 201 });
    }),
    http.post(`${api}/git/refs`, async ({ request }) => {
      const body = z.object({ ref: z.string() }).parse(await request.json());
      headRef = body.ref.replace("refs/heads/", "");
      writes.push({ what: "ref", body });
      return HttpResponse.json({ ref: body.ref, object: { sha: commit } }, { status: 201 });
    }),
    http.post(`${api}/pulls`, async ({ request }) => {
      writes.push({ what: "pull", body: await request.json() });
      return options.refusePullRequest === true
        ? HttpResponse.json({ message: "Validation Failed" }, { status: 422 })
        : HttpResponse.json(pull(headRef), { status: 201 });
    }),
    http.get(`${api}/pulls/42`, () => HttpResponse.json(pull(headRef))),
    http.get(`${api}/pulls`, () => HttpResponse.json([])),
    http.post(`${api}/issues/42/labels`, async ({ request }) => {
      writes.push({ what: "labels", body: await request.json() });
      return HttpResponse.json([]);
    }),
    http.get(`${api}/commits/:ref`, () =>
      HttpResponse.json({ author: { login: "octo-dev", type: "User" } }),
    ),
    http.post(`${api}/pulls/42/requested_reviewers`, async ({ request }) => {
      writes.push({ what: "reviewers", body: await request.json() });
      return HttpResponse.json(pull(headRef), { status: 201 });
    }),
  );
  return { writes, commit };
}

const publishJob = (target: { orgId: string; attemptId: string }) => ({
  name: "publish",
  data: { orgId: target.orgId, attemptId: target.attemptId },
});

describe("publish job (P5.2c)", () => {
  /** A fix validated end to end: VALIDATED, its digest stored. */
  async function validatedFix() {
    const target = await submitted([{ path: "src/sum.ts", content: FIXED }]);
    mockGitHub(target.fullName, { "src/sum.ts": BUGGY });
    await processValidationJob(job(target), deps());
    return target;
  }

  it("commits the checked files on a pipeheal/* branch and opens the PR", async () => {
    const target = await validatedFix();
    const { writes, commit } = mockPublish(target.fullName);

    await processValidationJob(publishJob(target), deps());

    const attempt = await db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } });
    expect(attempt).toMatchObject({
      status: "PR_OPENED",
      prNumber: 42,
      commitSha: commit,
      draft: true,
    });
    expect(attempt.branch).toMatch(/^pipeheal\/[0-9a-f]{10}-1$/);
    await expect(
      db.healBranch.findFirstOrThrow({ where: { name: attempt.branch ?? "" } }),
    ).resolves.toMatchObject({ lastCommitSha: commit, attemptId: target.attemptId });
    await expect(
      db.pipelineFailure.findUniqueOrThrow({ where: { id: target.failureId } }),
    ).resolves.toMatchObject({ status: "PR_OPENED" });

    expect(writes.map((write) => write.what)).toEqual([
      "tree",
      "commit",
      "ref",
      "pull",
      "labels",
      "reviewers",
    ]);
    expect(writes[0]?.body).toMatchObject({
      tree: [{ path: "src/sum.ts", mode: "100644", type: "blob", content: FIXED }],
    });
    expect(writes[1]?.body).toMatchObject({ parents: ["c".repeat(40)] });
    expect(writes[2]?.body).toMatchObject({ ref: `refs/heads/${attempt.branch ?? ""}` });
    expect(writes[3]?.body).toMatchObject({ base: "main", head: attempt.branch, draft: true });
    expect(writes[4]?.body).toEqual({ labels: ["pipeheal"] });
    expect(writes[5]?.body).toEqual({ reviewers: ["octo-dev"] });
  });

  it("never opens a second PR when the job runs again", async () => {
    const target = await validatedFix();
    const { writes } = mockPublish(target.fullName);

    await processValidationJob(publishJob(target), deps());
    await processValidationJob(publishJob(target), deps());

    expect(writes.filter((write) => write.what === "pull")).toHaveLength(1);
  });

  it("refuses a submission that changed after it was checked, before writing anything", async () => {
    const target = await validatedFix();
    const { writes } = mockPublish(target.fullName);
    await db.attemptSubmission.update({
      where: { attemptId: target.attemptId },
      data: { files: [{ path: "src/sum.ts", content: "export const sum = () => 0;\n" }] },
    });

    await processValidationJob(publishJob(target), deps());

    expect(writes).toEqual([]);
    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      endReason: "the submission isn't the one that was checked",
    });
  });

  it("fails the attempt when GitHub refuses the PR, and never retries the writes", async () => {
    const target = await validatedFix();
    const { writes, commit } = mockPublish(target.fullName, { refusePullRequest: true });

    await processValidationJob(publishJob(target), deps());
    await processValidationJob(publishJob(target), deps());

    const attempt = await db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } });
    expect(attempt).toMatchObject({
      status: "FAILED",
      endReason: "GitHub refused the commit or the pull request",
      commitSha: commit,
    });
    expect(writes.filter((write) => write.what === "pull")).toHaveLength(1);
    expect(writes.filter((write) => write.what === "commit")).toHaveLength(1);
  });

  it.each([
    ["the failing branch no longer exists", { baseTip: null }],
    [
      "the failing branch moved away from the healed commit",
      { baseTip: "7".repeat(40), comparison: "diverged" as const },
    ],
    ["the pull request's branch already exists", { branchExists: true }],
  ])("stops before writing when %s", async (reason, options) => {
    const target = await validatedFix();
    const { writes } = mockPublish(target.fullName, options);

    await processValidationJob(publishJob(target), deps());

    expect(writes).toEqual([]);
    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }),
    ).resolves.toMatchObject({ status: "FAILED", endReason: reason });
  });

  it("opens the PR when the branch moved forward from the healed commit", async () => {
    const target = await validatedFix();
    mockPublish(target.fullName, { baseTip: "7".repeat(40), comparison: "ahead" });

    await processValidationJob(publishJob(target), deps());

    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }),
    ).resolves.toMatchObject({ status: "PR_OPENED" });
  });

  it("never targets a merge queue's branch", async () => {
    const target = await validatedFix();
    await db.pipelineFailure.update({
      where: { id: target.failureId },
      data: { headBranch: "gh-readonly-queue/main/pr-1-abc" },
    });
    const { writes } = mockPublish(target.fullName);

    await processValidationJob(publishJob(target), deps());

    expect(writes).toEqual([]);
    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      endReason: "the failure ran in a merge queue, not on a branch",
    });
  });

  it("ends a validated attempt whose publish job ran out of retries", async () => {
    const target = await validatedFix();

    await recordUnpublishable(db, { orgId: target.orgId, attemptId: target.attemptId });

    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      endReason: "the pull request couldn't be opened",
    });
  });
});

/** GitHub for a retry's publish: the existing branch and PR, recording every write. */
function mockRetryPublish(
  fullName: string,
  options: { tip?: string; head?: string; state?: "open" | "closed" } = {},
) {
  const api = `https://api.github.com/repos/${fullName}`;
  const repoRef = { id: 777, full_name: fullName };
  const previous = "d".repeat(40);
  const commit = "9".repeat(40);
  const writes: { what: string; body: unknown }[] = [];
  const record = async (what: string, request: Request) => {
    writes.push({ what, body: await request.json() });
  };
  github.use(
    http.get(`${api}/git/ref/*`, ({ params }) =>
      HttpResponse.json({
        ref: `refs/${String(params[0])}`,
        object: { sha: options.tip ?? previous },
      }),
    ),
    http.get(`${api}/git/commits/:sha`, () =>
      HttpResponse.json({ sha: previous, tree: { sha: "1".repeat(40) } }),
    ),
    http.get(`${api}/git/trees/:sha`, ({ params }) =>
      HttpResponse.json({
        sha: String(params.sha),
        tree:
          params.sha === "1".repeat(40)
            ? [{ path: "src", mode: "040000", type: "tree", sha: "2".repeat(40) }]
            : [],
      }),
    ),
    http.post(`${api}/git/trees`, async ({ request }) => {
      await record("tree", request);
      return HttpResponse.json({ sha: "4".repeat(40) }, { status: 201 });
    }),
    http.post(`${api}/git/commits`, async ({ request }) => {
      await record("commit", request);
      return HttpResponse.json({ sha: commit }, { status: 201 });
    }),
    http.patch(`${api}/git/refs/*`, async ({ request }) => {
      await record("move", request);
      return HttpResponse.json({ object: { sha: commit } });
    }),
    http.get(`${api}/pulls/42`, () =>
      HttpResponse.json({
        number: 42,
        html_url: `https://github.com/${fullName}/pull/42`,
        state: options.state ?? "open",
        draft: false,
        merged: false,
        head: { ref: "pipeheal/abc-1", sha: options.head ?? previous, repo: repoRef },
        base: { ref: "main", repo: repoRef },
      }),
    ),
    http.post(`${api}/issues/42/comments`, async ({ request }) => {
      await record("comment", request);
      return HttpResponse.json({ id: 1, html_url: "https://github.com/x" }, { status: 201 });
    }),
  );
  return { writes, commit, previous };
}

describe("publish job: a retry (P5.3d)", () => {
  /** A retry validated end to end. */
  async function validatedRetry() {
    const target = await retried(
      [{ path: "src/sum.ts", content: FIXED }],
      [{ path: "src/other.ts", content: "export const two = 2;\n" }],
    );
    mockGitHub(target.fullName, { "src/sum.ts": BUGGY });
    await processValidationJob(job(target), deps());
    github.resetHandlers();
    mockGitHub(target.fullName, {});
    return target;
  }
  const state = async (target: { attemptId: string; failureId: string }) => ({
    attempt: await db.healAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }),
    failure: await db.pipelineFailure.findUniqueOrThrow({ where: { id: target.failureId } }),
  });

  it("adds a commit to the same branch and pull request, and says so on it", async () => {
    const target = await validatedRetry();
    const { writes, commit, previous } = mockRetryPublish(target.fullName);

    await processValidationJob(publishJob(target), deps());

    expect(writes.map((write) => write.what)).toEqual(["tree", "commit", "move", "comment"]);
    expect(writes[1]?.body).toMatchObject({ parents: [previous] });
    expect(writes[2]?.body).toMatchObject({ sha: commit, force: false });
    const { attempt, failure } = await state(target);
    expect(attempt).toMatchObject({
      status: "PR_OPENED",
      branch: "pipeheal/abc-1",
      commitSha: commit,
      prNumber: 42,
    });
    expect(failure.status).toBe("PR_OPENED");
    expect(JSON.stringify(writes[3]?.body)).toContain("src/other.ts");
  });

  it.each([
    ["the pull request's branch moved", { tip: "7".repeat(40) }],
    ["the pull request is no longer open on PipeHeal's commit", { state: "closed" as const }],
    ["the pull request is no longer open on PipeHeal's commit", { head: "7".repeat(40) }],
  ])("writes nothing when %s", async (reason, options) => {
    const target = await validatedRetry();
    const { writes } = mockRetryPublish(target.fullName, options);

    await processValidationJob(publishJob(target), deps());

    expect(writes).toEqual([]);
    const { attempt, failure } = await state(target);
    expect(attempt).toMatchObject({ status: "FAILED", endReason: reason });
    expect(failure.status).toBe("NEEDS_HUMAN");
  });

  it("writes nothing when the earlier fix passed CI after all", async () => {
    const target = await validatedRetry();
    const { writes } = mockRetryPublish(target.fullName);
    const { retryOfId } = await db.healAttempt.findUniqueOrThrow({
      where: { id: target.attemptId },
    });
    await db.healAttempt.update({
      where: { id: retryOfId ?? "" },
      data: { status: "VERIFIED" },
    });

    await processValidationJob(publishJob(target), deps());

    expect(writes).toEqual([]);
    expect((await state(target)).attempt).toMatchObject({
      endReason: "the earlier fix is no longer failing CI",
    });
  });
});
