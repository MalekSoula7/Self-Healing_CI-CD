// Needs Postgres: `docker compose up -d` (runs against the `pipeheal_test` database). GitHub is
// msw, started here: integration tests have no shared msw server.
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { createTestDb } from "@pipeheal/db/testing";
import { createGitHubApp, GitHubApiError } from "@pipeheal/github";
import { forSystem, recordWebhookDelivery } from "@pipeheal/db";
import { createLogger } from "@pipeheal/shared/logger";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { processWebhookJob, type WebhookProcessorDeps } from "./webhooks";

const db = createTestDb();
const github = setupServer();

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

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP_ID = 1234;
const INSTALLATION_TOKEN = "ghs_testInstallationToken00000000000000";

function githubId(): bigint {
  return BigInt(randomInt(1, 2 ** 47));
}

function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`test setup: no ${what}`);
  return value;
}

function mockInstallationToken() {
  github.use(
    http.post("https://api.github.com/app/installations/:id/access_tokens", () =>
      HttpResponse.json(
        { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      ),
    ),
  );
}

interface RepoFixture {
  githubRepoId: bigint;
  fullName: string;
  defaultBranch: string;
  archived?: boolean;
}

function mockInstallationRepositories(repos: RepoFixture[]) {
  github.use(
    http.get("https://api.github.com/installation/repositories", () =>
      HttpResponse.json({
        total_count: repos.length,
        repositories: repos.map((repo) => ({
          id: Number(repo.githubRepoId),
          full_name: repo.fullName,
          default_branch: repo.defaultBranch,
          archived: repo.archived ?? false,
        })),
      }),
    ),
  );
}

const DEFAULT_WORKFLOW_YAML = "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n";
const HEAD_SHA = "f".repeat(40);

interface WorkflowFixture {
  githubWorkflowId: bigint;
  path: string;
  name: string;
  /** The file's content at the default branch; defaults to a plain push-triggered workflow. */
  content?: string;
}

function mockWorkflowsFor(fullName: string, workflows: WorkflowFixture[]) {
  const [owner, repo] = fullName.split("/");
  const base = `https://api.github.com/repos/${present(owner, "owner")}/${present(repo, "repo")}`;
  github.use(
    http.get(`${base}/actions/workflows`, () =>
      HttpResponse.json({
        total_count: workflows.length,
        workflows: workflows.map((w) => ({
          id: Number(w.githubWorkflowId),
          name: w.name,
          path: w.path,
          state: "active",
        })),
      }),
    ),
    http.get(`${base}/git/ref/*`, () =>
      HttpResponse.json({ ref: "refs/heads/main", object: { sha: HEAD_SHA, type: "commit" } }),
    ),
    http.get(`${base}/contents/*`, ({ request }) => {
      const path = decodeURIComponent(new URL(request.url).pathname).replace(
        `/repos/${present(owner, "owner")}/${present(repo, "repo")}/contents/`,
        "",
      );
      const workflow = workflows.find((w) => w.path === path);
      if (workflow === undefined)
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      const content = workflow.content ?? DEFAULT_WORKFLOW_YAML;
      return HttpResponse.json({
        type: "file",
        path,
        size: Buffer.byteLength(content),
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
      });
    }),
  );
}

function testDeps(): WebhookProcessorDeps {
  return {
    db,
    githubApp: createGitHubApp({
      appId: APP_ID,
      privateKey,
      retries: 0,
      log: createLogger({ level: "silent", service: "test" }),
    }),
    logger: createLogger({ level: "silent", service: "test" }),
    scheduleWindowClose: () => Promise.resolve(),
  };
}

/** Records the delivery (as the web route does) and runs the worker's processor on it. */
async function submit(
  deps: WebhookProcessorDeps,
  event: string,
  action: string | undefined,
  payload: unknown,
): Promise<{ deliveryId: string }> {
  const deliveryId = randomUUID();
  await recordWebhookDelivery(deps.db, { deliveryId, event, action });
  await processWebhookJob({ id: deliveryId, data: { deliveryId, event, action, payload } }, deps);
  return { deliveryId };
}

function installationPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "created",
    installation: {
      id: Number(githubId()),
      account: {
        id: Number(githubId()),
        login: `org-${randomUUID().slice(0, 8)}`,
        type: "Organization",
      },
    },
    sender: { id: Number(githubId()), login: "octo-dev" },
    ...overrides,
  };
}

describe("installation.created", () => {
  it("creates the organization with the installer as OWNER candidate", async () => {
    mockInstallationToken();
    mockInstallationRepositories([]);
    const deps = testDeps();
    const payload = installationPayload();

    await submit(deps, "installation", "created", payload);

    const org = await db.organization.findUniqueOrThrow({
      where: { installationId: BigInt(payload.installation.id) },
    });
    expect(org).toMatchObject({
      githubAccountId: BigInt(payload.installation.account.id),
      login: payload.installation.account.login,
      accountType: "ORG",
      status: "ACTIVE",
      installerGithubId: BigInt(payload.sender.id),
    });
  });

  it("maps a personal account installation to accountType USER", async () => {
    mockInstallationToken();
    mockInstallationRepositories([]);
    const deps = testDeps();
    const payload = installationPayload({
      installation: {
        id: Number(githubId()),
        account: { id: Number(githubId()), login: "octo-solo", type: "User" },
      },
    });

    await submit(deps, "installation", "created", payload);

    await expect(
      db.organization.findUniqueOrThrow({
        where: { installationId: BigInt(payload.installation.id) },
      }),
    ).resolves.toMatchObject({ accountType: "USER" });
  });

  it("syncs repositories (authoritative from GitHub, not the webhook's minimal list) and their workflows", async () => {
    mockInstallationToken();
    const login = `org-${randomUUID().slice(0, 8)}`;
    const appRepo: RepoFixture = {
      githubRepoId: githubId(),
      fullName: `${login}/app`,
      defaultBranch: "main",
    };
    const libRepo: RepoFixture = {
      githubRepoId: githubId(),
      fullName: `${login}/lib`,
      defaultBranch: "main",
      archived: true,
    };
    mockInstallationRepositories([appRepo, libRepo]);
    mockWorkflowsFor(appRepo.fullName, [
      { githubWorkflowId: githubId(), path: ".github/workflows/ci.yml", name: "CI" },
    ]);
    const deps = testDeps();
    const payload = installationPayload({
      installation: {
        id: Number(githubId()),
        account: { id: Number(githubId()), login, type: "Organization" },
      },
      // The webhook's own `repositories` field lacks default_branch; we must not trust it.
      repositories: [
        { id: Number(appRepo.githubRepoId), name: "app", full_name: appRepo.fullName },
      ],
    });

    await submit(deps, "installation", "created", payload);

    const org = await db.organization.findUniqueOrThrow({
      where: { installationId: BigInt(payload.installation.id) },
    });
    const stored = await db.repository.findMany({
      where: { orgId: org.id },
      orderBy: { fullName: "asc" },
    });
    // The archived repo is skipped entirely.
    expect(stored.map((r) => r.fullName)).toEqual([`${login}/app`]);
    const storedApp = present(stored[0], "stored app repo");
    expect(storedApp).toMatchObject({ defaultBranch: "main", enabled: false });

    const workflows = await db.repoWorkflow.findMany({ where: { repoId: storedApp.id } });
    // Push-triggered, no environment, not deploy/release/publish-named: CI-looking, so it's
    // pre-selected on discovery (SPEC §11).
    expect(workflows).toMatchObject([
      { path: ".github/workflows/ci.yml", name: "CI", selected: true },
    ]);
  });

  it("fetches each workflow's file to record its triggers and environment use", async () => {
    mockInstallationToken();
    const login = `org-${randomUUID().slice(0, 8)}`;
    const repo: RepoFixture = {
      githubRepoId: githubId(),
      fullName: `${login}/app`,
      defaultBranch: "main",
    };
    mockInstallationRepositories([repo]);
    mockWorkflowsFor(repo.fullName, [
      {
        githubWorkflowId: githubId(),
        path: ".github/workflows/ci.yml",
        name: "CI",
        content: "on: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
      },
      {
        githubWorkflowId: githubId(),
        path: ".github/workflows/deploy.yml",
        name: "Deploy",
        content:
          "on: workflow_dispatch\njobs:\n  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n",
      },
    ]);
    const deps = testDeps();
    const payload = installationPayload({
      installation: {
        id: Number(githubId()),
        account: { id: Number(githubId()), login, type: "Organization" },
      },
    });

    await submit(deps, "installation", "created", payload);

    const org = await db.organization.findUniqueOrThrow({
      where: { installationId: BigInt(payload.installation.id) },
    });
    const stored = await db.repoWorkflow.findMany({
      where: { orgId: org.id },
      orderBy: { path: "asc" },
    });
    expect(stored).toMatchObject([
      {
        path: ".github/workflows/ci.yml",
        triggers: ["push", "pull_request"],
        usesEnvironment: false,
      },
      {
        path: ".github/workflows/deploy.yml",
        triggers: ["workflow_dispatch"],
        usesEnvironment: true,
      },
    ]);
  });

  it("keeps previously known triggers when the default branch can't be found on a later sync", async () => {
    mockInstallationToken();
    const login = `org-${randomUUID().slice(0, 8)}`;
    const repo: RepoFixture = {
      githubRepoId: githubId(),
      fullName: `${login}/app`,
      defaultBranch: "main",
    };
    mockInstallationRepositories([repo]);
    const workflow = { githubWorkflowId: githubId(), path: ".github/workflows/ci.yml", name: "CI" };
    mockWorkflowsFor(repo.fullName, [workflow]);
    const deps = testDeps();
    const created = installationPayload({
      installation: {
        id: Number(githubId()),
        account: { id: Number(githubId()), login, type: "Organization" },
      },
    });
    await submit(deps, "installation", "created", created);
    const org = await db.organization.findUniqueOrThrow({
      where: { installationId: BigInt(created.installation.id) },
    });
    await expect(db.repoWorkflow.findFirst({ where: { orgId: org.id } })).resolves.toMatchObject({
      triggers: ["push"],
    });

    // Re-sync, but this time the default branch can't be resolved (e.g. GitHub briefly errors).
    github.use(
      http.get(`https://api.github.com/repos/${login}/app/git/ref/*`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    await submit(deps, "installation_repositories", "added", {
      action: "added",
      installation: {
        id: created.installation.id,
        account: { id: 1, login, type: "Organization" },
      },
      repositories_added: [{ id: Number(repo.githubRepoId), full_name: repo.fullName }],
      repositories_removed: [],
    });

    await expect(db.repoWorkflow.findFirst({ where: { orgId: org.id } })).resolves.toMatchObject({
      triggers: ["push"],
    });
  });

  // Seen on a real installation: GitHub answers 409 "Git Repository is empty." for any ref of a
  // repository without commits. That must not fail the delivery (and every other repo in it).
  it("syncs an empty repository (no commits, no workflows) without failing the delivery", async () => {
    mockInstallationToken();
    const login = `org-${randomUUID().slice(0, 8)}`;
    const empty: RepoFixture = {
      githubRepoId: githubId(),
      fullName: `${login}/empty`,
      defaultBranch: "main",
    };
    const app: RepoFixture = {
      githubRepoId: githubId(),
      fullName: `${login}/app`,
      defaultBranch: "main",
    };
    mockInstallationRepositories([empty, app]);
    mockWorkflowsFor(empty.fullName, []);
    mockWorkflowsFor(app.fullName, [
      { githubWorkflowId: githubId(), path: ".github/workflows/ci.yml", name: "CI" },
    ]);
    github.use(
      http.get(`https://api.github.com/repos/${login}/empty/git/ref/*`, () =>
        HttpResponse.json({ message: "Git Repository is empty." }, { status: 409 }),
      ),
    );
    const deps = testDeps();
    const payload = installationPayload({
      installation: {
        id: Number(githubId()),
        account: { id: Number(githubId()), login, type: "Organization" },
      },
    });

    const { deliveryId } = await submit(deps, "installation", "created", payload);

    await expect(
      db.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } }),
    ).resolves.toMatchObject({ error: null, processedAt: expect.any(Date) as Date });
    const org = await db.organization.findUniqueOrThrow({
      where: { installationId: BigInt(payload.installation.id) },
    });
    const repos = await db.repository.findMany({
      where: { orgId: org.id },
      include: { workflows: true },
      orderBy: { fullName: "asc" },
    });
    expect(repos.map((repo) => [repo.fullName, repo.workflows.length])).toEqual([
      [app.fullName, 1],
      [empty.fullName, 0],
    ]);
  });

  it("is idempotent: processing the same delivery twice creates nothing extra", async () => {
    mockInstallationToken();
    const login = `org-${randomUUID().slice(0, 8)}`;
    const appRepo: RepoFixture = {
      githubRepoId: githubId(),
      fullName: `${login}/app`,
      defaultBranch: "main",
    };
    mockInstallationRepositories([appRepo]);
    mockWorkflowsFor(appRepo.fullName, []);
    const deps = testDeps();
    const payload = installationPayload({
      installation: {
        id: Number(githubId()),
        account: { id: Number(githubId()), login, type: "Organization" },
      },
    });
    const deliveryId = randomUUID();
    const job = {
      id: deliveryId,
      data: { deliveryId, event: "installation", action: "created", payload },
    };
    await recordWebhookDelivery(deps.db, { deliveryId, event: "installation", action: "created" });

    await processWebhookJob(job, deps);
    await processWebhookJob(job, deps);

    const org = await db.organization.findUniqueOrThrow({
      where: { installationId: BigInt(payload.installation.id) },
    });
    await expect(db.repository.count({ where: { orgId: org.id } })).resolves.toBe(1);
  });
});

describe("installation lifecycle: deleted, suspend, unsuspend", () => {
  it("marks the org UNINSTALLED and removes every one of its repositories on delete", async () => {
    mockInstallationToken();
    const login = `org-${randomUUID().slice(0, 8)}`;
    const repos: RepoFixture[] = [
      { githubRepoId: githubId(), fullName: `${login}/a`, defaultBranch: "main" },
      { githubRepoId: githubId(), fullName: `${login}/b`, defaultBranch: "main" },
    ];
    mockInstallationRepositories(repos);
    for (const repo of repos) mockWorkflowsFor(repo.fullName, []);
    const deps = testDeps();
    const created = installationPayload({
      installation: {
        id: Number(githubId()),
        account: { id: Number(githubId()), login, type: "Organization" },
      },
    });
    await submit(deps, "installation", "created", created);

    await submit(deps, "installation", "deleted", { ...created, action: "deleted" });

    const org = await db.organization.findUniqueOrThrow({
      where: { installationId: BigInt(created.installation.id) },
    });
    expect(org.status).toBe("UNINSTALLED");
    const remaining = await db.repository.findMany({ where: { orgId: org.id } });
    expect(remaining.every((r) => r.removedFromInstallationAt !== null && !r.enabled)).toBe(true);
    expect(remaining).toHaveLength(2);
  });

  it("ignores deleted for an installation we never saw", async () => {
    const deps = testDeps();
    const payload = installationPayload({ action: "deleted" });

    await expect(submit(deps, "installation", "deleted", payload)).resolves.toBeDefined();
  });

  it("suspends and unsuspends without touching repositories", async () => {
    mockInstallationToken();
    mockInstallationRepositories([]);
    const deps = testDeps();
    const created = installationPayload();
    await submit(deps, "installation", "created", created);

    await submit(deps, "installation", "suspend", { ...created, action: "suspend" });
    await expect(
      db.organization.findUniqueOrThrow({
        where: { installationId: BigInt(created.installation.id) },
      }),
    ).resolves.toMatchObject({ status: "SUSPENDED" });

    await submit(deps, "installation", "unsuspend", { ...created, action: "unsuspend" });
    await expect(
      db.organization.findUniqueOrThrow({
        where: { installationId: BigInt(created.installation.id) },
      }),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("acknowledges an action with no processor yet, without error", async () => {
    const deps = testDeps();
    const payload = installationPayload({ action: "new_permissions_accepted" });

    await expect(
      submit(deps, "installation", "new_permissions_accepted", payload),
    ).resolves.toBeDefined();
  });
});

describe("installation_repositories", () => {
  async function createOrg(deps: WebhookProcessorDeps) {
    mockInstallationToken();
    mockInstallationRepositories([]);
    const login = `org-${randomUUID().slice(0, 8)}`;
    const created = installationPayload({
      installation: {
        id: Number(githubId()),
        account: { id: Number(githubId()), login, type: "Organization" },
      },
    });
    await submit(deps, "installation", "created", created);
    return { login, installationId: BigInt(created.installation.id) };
  }

  it("added: fetches and syncs the authoritative repository list", async () => {
    const deps = testDeps();
    const { login, installationId } = await createOrg(deps);
    const repo: RepoFixture = {
      githubRepoId: githubId(),
      fullName: `${login}/new`,
      defaultBranch: "main",
    };
    mockInstallationToken();
    mockInstallationRepositories([repo]);
    mockWorkflowsFor(repo.fullName, []);

    await submit(deps, "installation_repositories", "added", {
      action: "added",
      installation: { id: Number(installationId), account: { id: 1, login, type: "Organization" } },
      repositories_added: [{ id: Number(repo.githubRepoId), full_name: repo.fullName }],
      repositories_removed: [],
    });

    const org = await db.organization.findUniqueOrThrow({ where: { installationId } });
    await expect(
      db.repository.findFirst({ where: { orgId: org.id, githubRepoId: repo.githubRepoId } }),
    ).resolves.toMatchObject({ fullName: repo.fullName });
  });

  it("removed: marks repositories removed using the webhook payload alone (no GitHub call)", async () => {
    const deps = testDeps();
    const { login, installationId } = await createOrg(deps);
    mockInstallationToken();
    const repo: RepoFixture = {
      githubRepoId: githubId(),
      fullName: `${login}/gone`,
      defaultBranch: "main",
    };
    mockInstallationRepositories([repo]);
    mockWorkflowsFor(repo.fullName, []);
    await submit(deps, "installation_repositories", "added", {
      action: "added",
      installation: { id: Number(installationId), account: { id: 1, login, type: "Organization" } },
      repositories_added: [{ id: Number(repo.githubRepoId), full_name: repo.fullName }],
      repositories_removed: [],
    });

    // No handlers registered for GitHub calls: onUnhandledRequest "error" would fail this test
    // if the removal path tried to call GitHub.
    await submit(deps, "installation_repositories", "removed", {
      action: "removed",
      installation: { id: Number(installationId), account: { id: 1, login, type: "Organization" } },
      repositories_added: [],
      repositories_removed: [{ id: Number(repo.githubRepoId), full_name: repo.fullName }],
    });

    const org = await db.organization.findUniqueOrThrow({ where: { installationId } });
    const removed = await db.repository.findFirst({
      where: { orgId: org.id, githubRepoId: repo.githubRepoId },
    });
    expect(removed?.removedFromInstallationAt).toBeInstanceOf(Date);
    expect(removed?.enabled).toBe(false);
  });

  it("ignores an unknown installation", async () => {
    const deps = testDeps();
    const payload = {
      action: "removed",
      installation: {
        id: Number(githubId()),
        account: { id: 1, login: "x", type: "Organization" },
      },
      repositories_added: [],
      repositories_removed: [{ id: 1, full_name: "x/y" }],
    };

    await expect(
      submit(deps, "installation_repositories", "removed", payload),
    ).resolves.toBeDefined();
  });
});

describe("events with no processor yet", () => {
  it("acknowledges ping and pull_request without error", async () => {
    const deps = testDeps();
    for (const event of ["ping", "pull_request"]) {
      await expect(submit(deps, event, undefined, { zen: "..." })).resolves.toBeDefined();
    }
  });
});

describe("failures", () => {
  it("records a redacted error and rethrows when GitHub fails", async () => {
    github.use(
      http.post("https://api.github.com/app/installations/:id/access_tokens", () =>
        HttpResponse.json({ message: "Server Error" }, { status: 500 }),
      ),
    );
    const deps = testDeps();
    const payload = installationPayload();
    const deliveryId = randomUUID();
    await recordWebhookDelivery(deps.db, { deliveryId, event: "installation", action: "created" });

    await expect(
      processWebhookJob(
        { id: deliveryId, data: { deliveryId, event: "installation", action: "created", payload } },
        deps,
      ),
    ).rejects.toThrow(GitHubApiError);

    const delivery = await db.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } });
    expect(delivery.processedAt).toBeNull();
    expect(delivery.error).not.toBeNull();
    expect(delivery.error).not.toContain(INSTALLATION_TOKEN);
  });
});

describe("workflow_run (SPEC §2 step 4, §2.1)", () => {
  const CI_YAML = "on: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n";
  const DEPLOY_YAML =
    "on: push\njobs:\n  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n";

  interface Watched {
    installationId: bigint;
    orgId: string;
    repoId: string;
    fullName: string;
    githubRepoId: bigint;
    ci: bigint;
    lint: bigint;
    deploy: bigint;
  }

  function recordingDeps() {
    const scheduled: { orgId: string; failureId: string; at: Date }[] = [];
    const deps: WebhookProcessorDeps = {
      ...testDeps(),
      scheduleWindowClose: (orgId, failureId, at) => {
        scheduled.push({ orgId, failureId, at });
        return Promise.resolve();
      },
    };
    return { deps, scheduled };
  }

  /** An installed org with one enabled repo: CI and Lint watched (CI-looking), Deploy not. */
  async function watchedRepo(deps: WebhookProcessorDeps): Promise<Watched> {
    mockInstallationToken();
    const login = `org-${randomUUID().slice(0, 8)}`;
    const repo: RepoFixture = {
      githubRepoId: githubId(),
      fullName: `${login}/app`,
      defaultBranch: "main",
    };
    const [ci, lint, deploy] = [githubId(), githubId(), githubId()];
    mockInstallationRepositories([repo]);
    mockWorkflowsFor(repo.fullName, [
      { githubWorkflowId: ci, path: ".github/workflows/ci.yml", name: "CI", content: CI_YAML },
      {
        githubWorkflowId: lint,
        path: ".github/workflows/lint.yml",
        name: "Lint",
        content: CI_YAML,
      },
      {
        githubWorkflowId: deploy,
        path: ".github/workflows/deploy.yml",
        name: "Deploy",
        content: DEPLOY_YAML,
      },
    ]);
    const installationId = githubId();
    await submit(
      deps,
      "installation",
      "created",
      installationPayload({
        installation: {
          id: Number(installationId),
          account: { id: Number(githubId()), login, type: "Organization" },
        },
      }),
    );
    // From here on, only the GitHub calls a test mocks itself are allowed.
    github.resetHandlers();
    const org = await db.organization.findUniqueOrThrow({ where: { installationId } });
    const system = await forSystem(db, org.id, "test");
    const stored = present(
      await system.repositories.findByGithubId(repo.githubRepoId),
      "synced repository",
    );
    await system.repositories.setEnabled(stored.id, true);
    return {
      installationId,
      orgId: org.id,
      repoId: stored.id,
      fullName: repo.fullName,
      githubRepoId: repo.githubRepoId,
      ci,
      lint,
      deploy,
    };
  }

  function runPayload(w: Watched, run: Record<string, unknown> = {}) {
    const repository = { id: Number(w.githubRepoId), full_name: w.fullName };
    const id = Number(githubId());
    return {
      action: "completed",
      installation: { id: Number(w.installationId) },
      repository,
      workflow_run: {
        id,
        run_attempt: 1,
        workflow_id: Number(w.ci),
        name: "CI",
        path: ".github/workflows/ci.yml",
        head_sha: HEAD_SHA,
        head_branch: "feature/checkout",
        event: "push",
        status: "completed",
        conclusion: "failure",
        html_url: `https://github.com/${w.fullName}/actions/runs/${String(id)}`,
        repository,
        head_repository: repository,
        ...run,
      },
    };
  }

  function repoApi(w: Watched): string {
    return `https://api.github.com/repos/${w.fullName}`;
  }

  function mockJobs(w: Watched, jobs: { name: string; conclusion: string; failedStep?: string }[]) {
    github.use(
      http.get(`${repoApi(w)}/actions/runs/:runId/attempts/:attempt/jobs`, ({ params }) =>
        HttpResponse.json({
          total_count: jobs.length,
          jobs: jobs.map((job, index) => ({
            id: 7000 + index,
            run_id: Number(params.runId),
            run_attempt: Number(params.attempt),
            name: job.name,
            status: "completed",
            conclusion: job.conclusion,
            html_url: null,
            steps: [
              { name: "Set up job", number: 1, conclusion: "success" },
              { name: job.failedStep ?? "Run", number: 2, conclusion: job.conclusion },
            ],
          })),
        }),
      ),
    );
  }

  /** `GET /actions/runs?head_sha=`: the commit's runs, for the early window close. */
  function mockRunsForSha(w: Watched, runs: { workflowId: bigint; status: string }[]) {
    const repository = { id: Number(w.githubRepoId), full_name: w.fullName };
    github.use(
      http.get(`${repoApi(w)}/actions/runs`, () =>
        HttpResponse.json({
          total_count: runs.length,
          workflow_runs: runs.map((run, index) => ({
            id: 9000 + index,
            run_attempt: 1,
            workflow_id: Number(run.workflowId),
            name: "run",
            path: ".github/workflows/x.yml",
            head_sha: HEAD_SHA,
            head_branch: "feature/checkout",
            event: "push",
            status: run.status,
            conclusion: run.status === "completed" ? "failure" : null,
            html_url: "https://github.com/x",
            repository,
            head_repository: repository,
          })),
        }),
      ),
    );
  }

  async function failureOf(w: Watched, headSha = HEAD_SHA) {
    const system = await forSystem(db, w.orgId, "test");
    return system.failures.findBySha(w.repoId, headSha);
  }

  it("records a failed run of a watched workflow: its failed jobs, and the window's timer", async () => {
    const { deps, scheduled } = recordingDeps();
    const w = await watchedRepo(deps);
    mockJobs(w, [
      { name: "test", conclusion: "failure", failedStep: "Test" },
      { name: "build", conclusion: "success" },
    ]);
    // Lint hasn't finished for this commit: the window stays open.
    mockRunsForSha(w, [
      { workflowId: w.ci, status: "completed" },
      { workflowId: w.lint, status: "in_progress" },
    ]);
    const payload = runPayload(w);

    await submit(deps, "workflow_run", "completed", payload);

    const failure = present(await failureOf(w), "failure");
    expect(failure).toMatchObject({
      status: "DETECTED",
      headBranch: "feature/checkout",
      windowClosedAt: null,
    });
    expect(failure.runs).toMatchObject([
      {
        runId: BigInt(payload.workflow_run.id),
        workflowName: "CI",
        workflowPath: ".github/workflows/ci.yml",
        conclusion: "failure",
        jobs: [{ name: "test", failedStep: "Test" }],
      },
    ]);
    expect(scheduled).toEqual([
      { orgId: w.orgId, failureId: failure.id, at: failure.windowClosesAt },
    ]);
  });

  it("closes the window early once every watched run of the commit has completed", async () => {
    const { deps } = recordingDeps();
    const w = await watchedRepo(deps);
    mockJobs(w, [{ name: "test", conclusion: "failure" }]);
    mockRunsForSha(w, [
      { workflowId: w.ci, status: "completed" },
      { workflowId: w.lint, status: "in_progress" },
    ]);
    await submit(deps, "workflow_run", "completed", runPayload(w));
    expect((await failureOf(w))?.windowClosedAt).toBeNull();

    mockRunsForSha(w, [
      { workflowId: w.ci, status: "completed" },
      { workflowId: w.lint, status: "completed" },
      // An unwatched workflow still running doesn't hold the window open.
      { workflowId: w.deploy, status: "in_progress" },
    ]);
    await submit(
      deps,
      "workflow_run",
      "completed",
      runPayload(w, {
        workflow_id: Number(w.lint),
        path: ".github/workflows/lint.yml",
        conclusion: "success",
      }),
    );

    expect((await failureOf(w))?.windowClosedAt).toBeInstanceOf(Date);
  });

  it("makes the failure FLAKY when the failed run passes on a re-run", async () => {
    const { deps } = recordingDeps();
    const w = await watchedRepo(deps);
    mockJobs(w, [{ name: "test", conclusion: "failure" }]);
    mockRunsForSha(w, [{ workflowId: w.ci, status: "completed" }]);
    const failed = runPayload(w);
    await submit(deps, "workflow_run", "completed", failed);

    await submit(deps, "workflow_run", "completed", {
      ...failed,
      workflow_run: { ...failed.workflow_run, run_attempt: 2, conclusion: "success" },
    });

    const failure = present(await failureOf(w), "failure");
    expect(failure.status).toBe("FLAKY");
    expect(failure.runs).toMatchObject([{ runAttempt: 2, conclusion: "success" }]);
  });

  it("records a timed-out run as timed_out", async () => {
    const { deps } = recordingDeps();
    const w = await watchedRepo(deps);
    mockJobs(w, [{ name: "test", conclusion: "timed_out" }]);
    mockRunsForSha(w, [{ workflowId: w.ci, status: "completed" }]);

    await submit(deps, "workflow_run", "completed", runPayload(w, { conclusion: "timed_out" }));

    expect((await failureOf(w))?.runs).toMatchObject([
      { conclusion: "timed_out", jobs: [{ name: "test" }] },
    ]);
  });

  it("discovers a workflow added after the repository was synced, and watches it if it looks like CI", async () => {
    const { deps } = recordingDeps();
    const w = await watchedRepo(deps);
    const [tests, release] = [githubId(), githubId()];
    mockInstallationToken();
    mockWorkflowsFor(w.fullName, [
      { githubWorkflowId: w.ci, path: ".github/workflows/ci.yml", name: "CI", content: CI_YAML },
      {
        githubWorkflowId: tests,
        path: ".github/workflows/tests.yml",
        name: "Tests",
        content: CI_YAML,
      },
      {
        githubWorkflowId: release,
        path: ".github/workflows/release.yml",
        name: "Release",
        content: CI_YAML,
      },
    ]);
    mockJobs(w, [{ name: "unit", conclusion: "failure" }]);
    mockRunsForSha(w, [{ workflowId: tests, status: "completed" }]);

    await submit(
      deps,
      "workflow_run",
      "completed",
      runPayload(w, {
        workflow_id: Number(tests),
        name: "Tests",
        path: ".github/workflows/tests.yml",
      }),
    );
    await submit(
      deps,
      "workflow_run",
      "completed",
      runPayload(w, {
        workflow_id: Number(release),
        name: "Release",
        path: ".github/workflows/release.yml",
        head_sha: "e".repeat(40),
      }),
    );

    const workflows = await db.repoWorkflow.findMany({ where: { repoId: w.repoId } });
    expect(workflows.find((wf) => wf.githubWorkflowId === tests)?.selected).toBe(true);
    expect(workflows.find((wf) => wf.githubWorkflowId === release)?.selected).toBe(false);
    expect((await failureOf(w))?.runs).toMatchObject([
      { workflowPath: ".github/workflows/tests.yml" },
    ]);
    await expect(failureOf(w, "e".repeat(40))).resolves.toBeNull();
  });

  it("ignores a failure of a workflow that isn't watched", async () => {
    const { deps } = recordingDeps();
    const w = await watchedRepo(deps);
    mockInstallationToken();

    await submit(
      deps,
      "workflow_run",
      "completed",
      runPayload(w, { workflow_id: Number(w.deploy), path: ".github/workflows/deploy.yml" }),
    );

    await expect(failureOf(w)).resolves.toBeNull();
  });

  // No GitHub mocks are registered: any GitHub call would fail the delivery.
  it.each([
    ["a run from a fork", { head_repository: { id: 1, full_name: "someone/app" } }],
    ["a run without a head repository (fails closed)", { head_repository: null }],
    ["a run on a PipeHeal branch", { head_branch: "pipeheal/abc123-1" }],
    ["a run of the healer workflow", { path: ".github/workflows/pipeheal.yml" }],
  ])("ignores %s without calling GitHub", async (_case, run) => {
    const { deps, scheduled } = recordingDeps();
    const w = await watchedRepo(deps);

    await submit(deps, "workflow_run", "completed", runPayload(w, run));

    await expect(failureOf(w)).resolves.toBeNull();
    expect(scheduled).toEqual([]);
  });

  it("ignores unfinished runs, and passing runs of commits that never failed, without calling GitHub", async () => {
    const { deps } = recordingDeps();
    const w = await watchedRepo(deps);

    await submit(deps, "workflow_run", "requested", {
      ...runPayload(w, { status: "queued", conclusion: null }),
      action: "requested",
    });
    await submit(deps, "workflow_run", "completed", runPayload(w, { conclusion: "success" }));
    await submit(deps, "workflow_run", "completed", runPayload(w, { conclusion: "cancelled" }));

    await expect(failureOf(w)).resolves.toBeNull();
  });

  it("ignores a disabled repository, a suspended organization and an unknown installation", async () => {
    const { deps } = recordingDeps();
    const w = await watchedRepo(deps);
    const system = await forSystem(db, w.orgId, "test");

    await system.repositories.setEnabled(w.repoId, false);
    await submit(deps, "workflow_run", "completed", runPayload(w));
    await system.repositories.setEnabled(w.repoId, true);
    await db.organization.update({ where: { id: w.orgId }, data: { status: "SUSPENDED" } });
    await submit(deps, "workflow_run", "completed", runPayload(w));
    await submit(deps, "workflow_run", "completed", {
      ...runPayload(w),
      installation: { id: Number(githubId()) },
    });

    await expect(failureOf(w)).resolves.toBeNull();
  });
});
