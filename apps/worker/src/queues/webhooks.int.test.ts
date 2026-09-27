// Needs Postgres: `docker compose up -d` (runs against the `pipeheal_test` database). GitHub is
// msw, started here: integration tests have no shared msw server.
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { createTestDb } from "@pipeheal/db/testing";
import { createGitHubApp, GitHubApiError } from "@pipeheal/github";
import { recordWebhookDelivery } from "@pipeheal/db";
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

function mockWorkflowsFor(
  fullName: string,
  workflows: { githubWorkflowId: bigint; path: string; name: string }[],
) {
  const [owner, repo] = fullName.split("/");
  github.use(
    http.get(
      `https://api.github.com/repos/${present(owner, "owner")}/${present(repo, "repo")}/actions/workflows`,
      () =>
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
    expect(workflows).toMatchObject([
      { path: ".github/workflows/ci.yml", name: "CI", selected: false },
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
  it("acknowledges ping, workflow_run and pull_request without error", async () => {
    const deps = testDeps();
    for (const event of ["ping", "workflow_run", "pull_request"]) {
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
