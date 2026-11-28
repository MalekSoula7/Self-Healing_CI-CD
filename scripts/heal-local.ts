// `pnpm heal:local --repo examples/demo-node --scenario <name> [--keep]` (P4.6, SPEC §12): heals
// a broken copy of a demo repository end to end on this machine. It copies the demo into a fresh
// git repository, breaks it with a SPEC §14 scenario, opens a real attempt and session in the
// local database, and runs heal-action's executor in a hardened Linux container against the local
// gateway (`pnpm dev` must be running, with OLLAMA_URL set). Then it prints the attempt's timeline.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLocalAttempt } from "../apps/worker/src/local-attempt";
import { DEV_DATABASE_URL, createDb, forSystem } from "../packages/db/src/index";
import { isLoopbackUrl } from "../packages/shared/src/index";
import { breakRepo, git } from "./lib/break-run";
import { findScenario } from "./lib/break-scenarios";
import { DEMO_SETUPS, containerArgs, failingCheckFor, timelineLine } from "./lib/heal-local";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = join(ROOT, "examples");
const USAGE =
  "Usage: pnpm heal:local --repo examples/demo-node --scenario node/<name> [--gateway <url>] [--keep]";
/** Above the session's 25-minute wall clock: the container is killed if it runs longer. */
const CONTAINER_TIMEOUT_MS = 30 * 60_000;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Only the local development database: a loopback host and the dev database's name (L1). */
function isDevDatabase(url: string): boolean {
  return isLoopbackUrl(url) && new URL(url).pathname === new URL(DEV_DATABASE_URL).pathname;
}

/** What the docker CLI needs, not the .env this script was started with (P4.6 review L8). */
function dockerEnv(gateway: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"];
  return {
    ...Object.fromEntries(
      keep.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    ),
    PIPEHEAL_LOCAL_GATEWAY: gateway,
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      scenario: { type: "string" },
      // The gateway as the container sees the host (`pnpm dev` serves it on :4000).
      gateway: { type: "string", default: "http://host.docker.internal:4000" },
      keep: { type: "boolean", default: false },
    },
  });
  const scenario = values.scenario === undefined ? undefined : findScenario(values.scenario);
  const repo = values.repo === undefined ? undefined : resolve(values.repo);
  // One of the demos: never this repository or any other directory (P4.6 review L5).
  if (repo === undefined || scenario === undefined || dirname(repo) !== EXAMPLES) {
    process.stderr.write(`${USAGE}\n(--repo must be one of ${relative(ROOT, EXAMPLES)}/)\n`);
    return 1;
  }
  const setup = DEMO_SETUPS[scenario.demo];
  if (setup === undefined) {
    process.stderr.write(`local mode runs the node demo only for now (${scenario.id})\n`);
    return 1;
  }
  const databaseUrl = process.env.DATABASE_URL ?? DEV_DATABASE_URL;
  if (process.env.NODE_ENV === "production" || !isDevDatabase(databaseUrl)) {
    process.stderr.write("Refusing: local mode only uses the local development database.\n");
    return 1;
  }

  // A fresh repository with the demo as its first commit, then the scenario's commit on a branch.
  const parent = await mkdtemp(join(tmpdir(), "pipeheal-local-"));
  const db = createDb(databaseUrl);
  try {
    const work = join(parent, basename(repo));
    await cp(repo, work, {
      recursive: true,
      filter: (source) => !/[\\/](node_modules|\.git|\.env[^\\/]*)([\\/]|$)/.test(source),
    });
    git(["init", "--quiet", "--initial-branch=main"], work);
    git(["config", "user.email", "local@pipeheal.invalid"], work);
    git(["config", "user.name", "PipeHeal local"], work);
    git(["config", "core.autocrlf", "false"], work);
    git(["add", "--all"], work);
    git(["commit", "--quiet", "--message", "demo"], work);
    const broken = breakRepo(scenario, { repo: work, selfRepo: ROOT, push: false });
    git(["switch", "--quiet", broken.branch], work);
    const targetSha = git(["rev-parse", "HEAD"], work);
    out(`broke ${basename(work)} with ${scenario.id}: ${targetSha.slice(0, 12)}`);

    const failingCheck = failingCheckFor(scenario);
    const local = await createLocalAttempt(db, {
      repoName: basename(work),
      targetSha,
      failingCheck,
      commands: setup.commands,
      junitGlob: setup.junitGlob,
    });
    out(`attempt ${local.attemptId}: healing the failing ${failingCheck} check`);

    const name = `pipeheal-local-${randomBytes(4).toString("hex")}`;
    const container = spawnSync(
      "docker",
      containerArgs({
        name,
        workDir: work,
        actionDir: join(ROOT, "packages", "heal-action", "dist"),
        image: setup.image,
      }),
      {
        // The session on stdin only: never on the command line or in an environment.
        input: Buffer.from(
          JSON.stringify({
            attemptId: local.attemptId,
            token: local.sessionToken,
            details: local.session,
          }),
        ).toString("base64"),
        stdio: ["pipe", "inherit", "inherit"],
        env: dockerEnv(values.gateway),
        timeout: CONTAINER_TIMEOUT_MS,
      },
    );
    if (container.error !== undefined) {
      spawnSync("docker", ["kill", name], { stdio: "ignore" });
      out(`the container didn't finish: ${container.error.message}`);
    }

    out("");
    out("timeline:");
    const system = await forSystem(db, local.orgId, "local-mode");
    for (const event of await system.attempts.history(local.attemptId)) out(timelineLine(event));
    const attempt = await system.attempts.brief(local.attemptId);
    out(`attempt ${local.attemptId} ended ${attempt?.status ?? "?"}`);
    if (values.keep) out(`kept the checkout at ${work}`);
    return container.status ?? 1;
  } finally {
    await db.$disconnect();
    if (!values.keep) await rm(parent, { recursive: true, force: true, maxRetries: 5 });
  }
}

process.exitCode = await main();
