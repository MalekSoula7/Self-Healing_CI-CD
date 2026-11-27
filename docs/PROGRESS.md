# Progress log

Newest entry at the bottom. One entry per task. Format:

## YYYY-MM-DD · <task ID> · <title>
- Done: what changed (files/packages)
- Decisions: anything not in the spec, and why
- Follow-ups: loose ends, questions for Malek

## 2026-09-27 · ALIGN · Alignment session (no code)
- Done: reviewed CLAUDE.md, SPEC and PLAN; architecture read-back; top-5 risk review; spec review for gaps and outdated details; interview with Malek on Phases 0 to 2. Updated `docs/SPEC.md` (v0.2: new §2.1, §2.2, §4.1, §4.2, §16, plus edits in §5, §6.2, §7, §8, §9.1, §10, §11, §12, §15), `CLAUDE.md` (stack, versions, dev environment) and the `docs/PLAN.md` task lines that the decisions change (P0.6, P1.1, P1.3, P1.6, P1.7, P2.0, P2.1, P2.6, P4.6, P5.3, acceptance lines). No code written.
- Decisions (details in SPEC §16):
  - D1: native Windows + Docker Desktop, no WSL. So no bash, TypeScript scripts via `tsx`, POSIX repo paths in all logic, LF endings, Windows CI job for unit tests, `heal:local` in a Linux container.
  - D2: Better Auth instead of Auth.js.
  - D3: tenants are orgs and personal accounts; the installer becomes OWNER after a verified sign-in; everyone else is invite-only.
  - D4: one failure per repo + commit, 5-minute collection window, one attempt and one PR per broken commit.
  - D5: watched workflows are opt-in per workflow with CI-looking ones pre-selected; the flaky re-run happens once, on failed jobs only, never where a job uses `environment:`.
  - D6: dev Anthropic workspace with a hard spend cap; automated tests never call the real API.
  - D7: engineering defaults: versions (Node 24, TS 6.0.x, Prisma 7.10.x, Next 16), healer path `.github/workflows/pipeheal.yml`, runner hardening, OIDC `actor`/`run_id` binding, state timeouts + delivery reconciler, snapshot/fixture test globs, no auth bypass in local mode.
- Environment notes (cloud session, for reference only since development runs on Malek's laptop): Node 22.22, pnpm 10.33; Docker CLI/Compose installed but the daemon has to be started by hand, after which `docker compose up` works. Docker Hub rate-limits anonymous pulls at times (mirror.gcr.io and public.ecr.aws work). smee.io and token.actions.githubusercontent.com are blocked by that environment's network policy.
- Follow-ups:
  - Phase-tagged open questions added to SPEC §15. Before P1.4: label permission. Before P1.3: storing user tokens. Before P3.3: policy defaults vs guardrails.
  - [HUMAN] at CHECKPOINT 1a: also create the Anthropic dev workspace with a spend limit (steps to be given then).
  - P0.6: GitHub may refuse `.github/workflows/ci.yml` pushed from a cloud session if the Claude GitHub App lacks workflow permission. From the laptop this doesn't apply.

## 2026-09-27 · P0.1 · Monorepo foundation
- Done: pnpm workspace (`pnpm-workspace.yaml` with a version catalog), Turborepo (`turbo.json`), strict `tsconfig.base.json` + root `tsconfig.json`, one ESLint flat config (`eslint.config.mjs`), Prettier, `.gitattributes` (LF), `.editorconfig`, `.nvmrc` (24), `.npmrc` (`engine-strict`), `.gitignore`. Six empty packages under `packages/` (`shared`, `db`, `policy`, `github`, `agent-core`, `heal-action`) exporting their TypeScript source. Root `vitest.config.ts` with `unit` and `integration` projects (moved here from P0.5 so every later task ships with tests). `tests/workspace.test.ts` checks the conventions mechanically: package naming/type/scripts, strict base tsconfig, LF, no shell or batch scripts, no Unix-only syntax in package.json scripts.
- Decisions:
  - **ESLint 10, not 9 (reverses choice 1 of the approved Phase 0 plan).** pnpm reports 9.39 as deprecated/unsupported. `eslint-config-next`'s react/import/jsx-a11y plugins don't support 10, so `apps/web` (P0.3) will use `@next/eslint-plugin-next` and `eslint-plugin-react-hooks` directly. SPEC §4.2 already said ESLint 10; added a row explaining this.
  - CLAUDE.md rules enforced by tooling: `linterOptions.noInlineConfig` + `--max-warnings 0` (eslint-disable comments are ignored and fail lint), `ban-ts-comment` for every `@ts-*` directive, `no-explicit-any`, `vitest/no-disabled-tests` and `no-focused-tests`, Vitest `allowOnly: false`. `packages/policy` additionally bans Node built-in imports and the `process`/`fetch` globals, and gets no Node types. Verified by linting a scratch file with each forbidden pattern (10 problems reported), then deleting it.
  - Internal packages export `./src/index.ts` (no per-package build); TypeScript uses `moduleResolution: Bundler`.
  - Prettier skips Markdown so the docs' tables aren't re-aligned on every edit.
  - TypeScript 6.0.3 installed fine with typescript-eslint 8.70 (no fallback to 5.9 needed so far).
- Follow-ups: Next.js 16 + TS 6.0 compatibility gets confirmed in P0.3. In this cloud container Node 24.21.0 and pnpm 10.34.5 were installed under `/opt/node24` (symlinked into `~/.local/bin`) and `dockerd` is started by hand.

## 2026-09-27 · P0.2 · Local infrastructure and env validation
- Done: `docker-compose.yml` (postgres:17-alpine, redis:8-alpine with `noeviction` + AOF, healthchecks, named volumes, ports bound to 127.0.0.1 and overridable with `POSTGRES_PORT`/`REDIS_PORT`). `.env.example` lists every variable known today, grouped by the phase that first needs it, with secrets left empty. `packages/shared/src/env.ts`: `parseEnv(schema, source)` plus `envPort` and `envBoolean`, written test-first (`env.test.ts`). `tests/env-example.test.ts` checks `.env.example` has one `KEY=value` per key and no filled-in secrets.
- Decisions: empty strings count as unset, so `FOO=` falls back to the schema default. Validation errors list every bad key at once and never include values (tested with a token-looking value). Apps will validate only the variables they use, so they start before the GitHub App exists.
- Follow-ups: the single root `.env` is shared by both apps; how each app loads it (Next.js only reads its own folder by default) is handled in P0.3/P0.4. A separate test database for integration tests comes with Prisma in P1.1.

## 2026-09-27 · P0.3 · apps/web skeleton
- Done: `apps/web` with Next.js 16.3.6 (App Router, Turbopack), React 19.3, Tailwind 4 (`@tailwindcss/postcss`), shadcn/ui baseline (`components.json`, `cn()` in `src/lib/utils.ts`, `Button`, neutral theme in `globals.css`), `/api/health`, a placeholder home page. `src/env.ts` validates the web env (`NODE_ENV`, `APP_URL`) and `src/instrumentation.ts` validates it at server start. Tests: `route.test.ts` (health) and `env.test.ts` (defaults, invalid URL, every key documented in `.env.example`). ESLint gets `@next/eslint-plugin-next` (core-web-vitals) and `eslint-plugin-react-hooks` for `apps/web`. `typecheck` runs `next typegen` first so route types exist without a build.
- Decisions:
  - **Root `.env` for both apps.** `next.config.ts` calls `loadEnvConfig(repoRoot, …, forceReload=true)`. Without `forceReload`, `@next/env` returns the result cached from Next's own earlier load of `apps/web`, and the root `.env` is silently ignored; I found this by testing with a bad value. Verified: a bad `APP_URL` in the root `.env` stops the server with `APP_URL: must be an http(s) URL` (no value echoed); a good one serves 200.
  - **New `envHttpUrl` in `packages/shared`:** Zod's `z.url()` accepts `localhost:3000` (scheme `localhost:`); the env test caught it. Added tests for the new schema first.
  - shadcn files written by hand because `ui.shadcn.com` is blocked in this cloud environment; `components.json` is in place so `pnpm dlx shadcn add <component>` works from Malek's laptop.
  - No `next/font/google` (build-time download); system font stack instead.
  - Next 16 + TypeScript 6.0.3 builds cleanly and Next did not rewrite our tsconfig.
- `next dev` generates `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` (pointing coding agents at the Next docs bundled in `node_modules/next/dist/docs`). Verified in `next/dist/server/lib/generate-agent-files.js`; committed because Next re-creates them anyway.
- Follow-ups: in production `APP_URL` should be required rather than defaulted (add when deployment config lands, Phase 8). Next.js collects anonymous telemetry by default; opt out on your machine with `pnpm exec next telemetry disable` if you prefer.

## 2026-09-27 · P0.4 · apps/worker skeleton
- Done: `apps/worker` (`src/main.ts` bootstrap): zod env (`src/env.ts`), pino logger with secret redaction (`src/logger.ts`), one shared ioredis client (`src/redis.ts`, with a PING health check that never hangs), the `maintenance` BullMQ queue + worker with a zod-validated `ping` job (`src/queues/maintenance.ts`), the Fastify gateway with `/health` reporting Redis up/down as 200/503 (`src/gateway/server.ts`), and ordered, idempotent graceful shutdown on SIGINT/SIGTERM (`src/shutdown.ts`). `dev` runs `tsx watch` with `--env-file-if-exists=../../.env` (root `.env`, SPEC §4.1). Tests: env, logger redaction (top level, nested, request headers), shutdown (order, failures, idempotence, per-step and overall timeouts), gateway health (up, down, throwing, hanging, 404), job processor, and an integration test against real Redis (`maintenance.int.test.ts`: ping round trip, invalid data fails, health via real PING).
- Verified with running processes:
  - Worker alone: health 200, ping job processed, SIGINT closes gateway → worker → queue → redis, exit 0.
  - Redis stopped: health 503 `degraded`; Redis restarted: back to 200. SIGINT right after Redis came back: exit 0 in ~55 ms, 3/3 runs.
  - `pnpm dev`: web `/api/health` and gateway `/health` both 200; Ctrl+C stops every process. (Turbo stops streaming task output after Ctrl+C, so not every shutdown line shows; run `tsx watch` directly to see them all.)
- Decisions:
  - **ioredis 5.11, not 6.0.** With 6.0.0, `worker.close()` hung when shutdown landed right after a Redis restart, and BullMQ 6.3.9 is itself tested against 5.11.1. With 5.11 the race is gone (4/4 and 3/3 runs). Added to SPEC §4.2.
  - Shutdown bounds each step (5 s) and the whole sequence (15 s): a hanging step is marked failed and the next one still runs, exit 1. A "graceful, then force" worker close was tried and dropped: BullMQ returns the same pending close promise, so forcing didn't help.
  - BullMQ `Queue` needs an `error` listener; without one it prints raw stack traces to stderr, bypassing the logger. Added.
  - `msgpackr-extract` (optional native speed-up for BullMQ's serializer) is listed under `ignoredBuiltDependencies`: no native build, pure-JS fallback.
  - No production `build` for the worker yet; the esbuild bundle comes with the Docker work (P8.5).
- Follow-ups: Node prints "../../.env not found. Continuing without it." when there is no root `.env`; harmless.

## 2026-09-27 · P0.5 · Playwright, msw, coverage
- Done:
  - **Network guard for unit tests:** `vitest.setup.ts` starts one msw server (`mockServer`, exported from `@pipeheal/shared/testing`) before every unit test file with `onUnhandledRequest: "error"`, and resets handlers after each test. `packages/github/src/network.test.ts` proves a mocked GitHub call is served, an unmocked one fails with msw's own error, and handlers reset between tests.
  - **Coverage:** `pnpm test` now runs `vitest run --coverage` (v8). Thresholds of 95% lines/functions/branches/statements on `packages/policy/src/**` and `packages/agent-core/src/**` (CLAUDE.md). Verified by adding an uncovered function to `packages/policy`: the run failed on all four metrics, then passed after removing it.
  - **Playwright:** `apps/web/playwright.config.ts` + `apps/web/e2e/home.spec.ts` (home page renders, health returns ok). Runs against a production build on port 3100 (`pnpm test:e2e`), no retries, `forbidOnly`. An ESLint rule blocks `test.only/skip/fixme` in e2e specs (the Vitest plugin only covers `*.test.ts`); verified with a scratch spec.
- Decisions:
  - msw's `"error"` strategy, not a throwing callback: in msw 2.15 a callback that throws turns into a 500 response, which code that ignores status codes would silently accept. `"error"` makes the request reject.
  - The network test asserts on msw's error text; a bare "rejects" would also pass on an offline machine with a broken guard.
  - `pnpm test:e2e` calls the web package directly rather than through Turbo: Turbo 2's strict env mode drops shell variables such as `CI` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. (Apps read the root `.env` themselves, so `pnpm dev` is unaffected.)
  - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` lets a sandbox use a preinstalled Chromium; on a laptop, run `pnpm --filter @pipeheal/web exec playwright install chromium` once.
- Follow-ups: none.

## 2026-09-27 · P0.6 · CI for this repo
- Done: `.github/workflows/ci.yml` with three jobs, read-only `GITHUB_TOKEN`, superseded runs cancelled, Next/Turbo telemetry off:
  - **Linux** (Postgres 17 + Redis 8 services): `format:check`, `typecheck`, `lint`, `test` (unit + integration, coverage thresholds);
  - **Windows**: `test:unit`;
  - **e2e**: installs Chromium, runs Playwright, uploads the report on failure.
- Verified: actionlint clean (run through the Go module proxy because Docker Hub rate-limited the image). All three jobs green on the first run of [MalekSoula7/Self-Healing_CI-CD#2](https://github.com/MalekSoula7/Self-Healing_CI-CD/pull/2), about a minute each.
- Decisions: triggers are `pull_request` and pushes to `main`, so branch pushes without a PR don't run CI. Actions pinned to major tags (`checkout@v5`, `setup-node@v5`, `pnpm/action-setup@v4`, `upload-artifact@v4`) as agreed in the Phase 0 plan; SHA-pinning is a Phase 8 hardening candidate.
- Follow-ups: PR #1 had been merged (docs only) before the Phase 0 commits landed, so the branch was rebased onto `main` (identical content) and Phase 0 is in PR #2.

## 2026-09-27 · P0.7 · Docs, Claude Code settings, fresh-clone check
- Done: `README.md` (Windows prerequisites, PowerShell first run, checks, layout, ports, troubleshooting). CLAUDE.md "Commands" now matches the real scripts (not-yet-created ones marked by phase) plus a "Testing conventions" section. `.claude/settings.json`: allowlist of the named pnpm scripts, a few `pnpm exec` tools, `docker compose` (but `down` only without `-v`), read-only git; deny rules for force-push, hard reset, `git clean`, volume-deleting `down`, `rm -rf`, and reading/editing the real `.env`. The deny list took effect in this session immediately: a command containing `rm -rf` was refused.
- Fresh-clone check (Linux, from the committed tree): `pnpm install --frozen-lockfile`, `typecheck`, `lint`, `test`, `format:check` all pass; `pnpm dev` serves web `/api/health` 200, gateway `/health` 200 and the home page.
- Found and fixed along the way: with Docker down, the Redis integration test's `afterAll` crashed on `undefined.close` and buried the "Redis not reachable, run `docker compose up -d`" message. Teardown now tolerates a failed setup; verified with Redis stopped (one clear error).
- Follow-ups: Malek runs the same fresh-clone check on Windows at CHECKPOINT 0.

## 2026-09-27 · CHECKPOINT 0 · Security review fixes (approved batch)
- Review: `security-reviewer` on the Phase 0 diff found no critical issues, 1 high, 3 medium and 8 low. I reproduced the high one before fixing it (`tsx -e` ran arbitrary code, `git log --output=` wrote a file of my choosing).
- Fixed now:
  - **H1/M1/M2, `.claude/settings.json`:** exact-match script entries only (no trailing `*` that let `-e`/`--config`/extra args through); no `pnpm exec`/`pnpm dlx`; `pnpm install` only bare or `--frozen-lockfile`; `docker compose config` only `--quiet`. Denies for `git *--output*`, `git *--no-index*`, `git *--ext-diff*`, `compose config *--environment*`, and read/edit of every `.env` variant Next loads plus `*.pem/*.key/*.p12/*.pfx`. Verified live: the `--output` and `--no-index` probes are now refused.
  - **L2:** `*.pem/*.key/*.p12/*.pfx` in `.gitignore` (checked with `git check-ignore` against the App key's filename pattern). The `.env.example` test treats `SMEE_URL` as a secret and rejects credentials in URLs other than the documented `pipeheal:pipeheal@localhost` (mutation-checked).
  - **L4 (part):** the msw guard now listens at setup-file load. A new test showed a request made while a test file was being imported **reached the real network** before this fix. Secret env vars are blanked for all tests (`tests/test-env.test.ts`, run with fake secrets exported in the shell).
  - **L6:** the Redis integration test prints only the host.
  - **L1 (part):** `persist-credentials: false` on every CI checkout (actionlint clean).
  - **L8 (part):** msw added to `ignoredBuiltDependencies`, `minimumReleaseAge: 1440`.
- Not done, with reasons:
  - `strictDepBuilds`: pnpm 10.34 then also fails on packages deliberately listed as ignored (tried both the lists and the newer `allowBuilds` map). pnpm still never runs unlisted install scripts, which is the actual protection.
  - This container's local `node_modules` keeps printing a stale "ignored builds" warning from those attempts; clean installs are silent (verified twice). Deleting `node_modules` is blocked by the new `rm -rf` deny, and I didn't work around it.
- Deferred into PLAN:
  - P1.0: shared logger with deep redaction and string scrubbing, Fastify serializers, `server-only` web env, `NEXT_PUBLIC_*` secret check, socket-level test guard;
  - P4.1b: gateway hardening;
  - P8.4: SHA-pinned actions + Dependabot, earlier if a workflow gets secrets.
- Follow-ups for Malek: optional GitHub ruleset on `main` (block force-push and deletion, require PR + the three CI checks); Windows fresh-clone check; merge PR #2.

## 2026-09-27 · Phase 1 kickoff · Plan approved, decisions D8/D9
- PR #2 (Phase 0) merged by Claude at Malek's request after his Windows fresh-clone check passed (after installing Node 24 and starting Docker Desktop). Branch `claude/intelligent-wozniak-jvzh97` fast-forwarded to the merged `main`.
- Phase 1 plan approved with two decisions (SPEC §16):
  - D8: GitHub user access tokens are kept, encrypted with Better Auth's `encryptOAuthTokens`. Malek chose this over verify-then-discard.
  - D9: the App requests the account permission "Email addresses: read".
- Plan choices recorded here for reference:
  - audit logging built into the P1.2 helpers (P1.8 becomes a coverage test);
  - separate `pipeheal_test` database;
  - private key as base64;
  - `octokit` behind zod-validated wrappers;
  - label permission deferred to Phase 5.

## 2026-09-27 · P1.0 · Phase 0 security review follow-ups
- Done:
  - **Redaction** (`packages/shared/src/redact.ts`, test-first): `redactText` scrubs GitHub tokens (`ghp_/gho_/ghu_/ghs_/ghr_`, `github_pat_`), `sk-ant-` keys, JWTs, PEM private keys, AWS key ids, URL credentials (host kept), secret query params (`sig`, `token`, `code`, `X-Amz-*`, ...) and Bearer/token values. `redactValue` walks plain objects to depth 8, hides values under secret-looking keys case-insensitively (`authorization`, `cookie`, `x-api-key`, `*token*`, `*secret*`, `password`, `private_key`, `jwt`, ...), handles cycles, and turns errors into `{type, message, code, stack}` so HTTP response objects and bodies are dropped.
  - **Shared logger** (`@pipeheal/shared/logger`, its own entry point so web code never pulls in pino): every log argument goes through the redactor, including message strings, format arguments, `err`, and child bindings. pino applies its bindings formatter to the root logger only, so `child()` is wrapped; grandchildren are tested. The worker's own logger was removed.
  - **Gateway:** Fastify's request logging is off; we log method, path without query, status and duration. The error handler logs a redacted error and returns `{"error":"internal error"}` for 5xx; 4xx keep their status with a redacted message. A custom 404 stops Fastify echoing the URL. A test sends a token in the query, an `authorization` header, a cookie, and a route that throws with a token; none appear in logs or responses. Before the fix, the token appeared in the request log (seen red).
  - **Web env:** `import "server-only"` (Vitest aliases it to a stub; Next enforces it). Verified: a client component importing the env fails `next build`. `NEXT_PUBLIC_*` names that look like secrets are refused both at build (`next.config.ts`, verified) and at server start. Production requires `APP_URL` over https (loopback excepted), and the worker requires `REDIS_URL` with rediss (loopback excepted). Playwright passes `APP_URL` to the production server.
  - **Network guard** (`@pipeheal/shared/testing`): patches `net.Socket#connect` (so TLS, undici fetch/WebSocket and DB drivers too) plus `dns.lookup` and `dns.promises.lookup`. Unit tests may open no connection; integration tests (new `vitest.integration.setup.ts`) may reach loopback only. Tests were red first for TCP, TLS, loopback and DNS.
  - **Lint:** `@pipeheal/shared/testing` can only be imported from tests and setup files, `packages/policy` included; verified with probe files.
- Verified: typecheck, lint, 146 unit+integration tests, format, e2e, and a worker run where a token in the request URL appears 0 times in the logs.
- Decisions: the stateful guard is installed once per process and only the mode switches per file, because Vitest can reuse a process across files and projects.
- Follow-ups: CI runs only on pull requests, so Phase 1 commits get Windows/Linux CI when the Phase 1 PR is opened (asking Malek when). This container's Docker daemon stops intermittently; restarted it detached (`setsid nohup dockerd`).

## 2026-09-27 · P1.1 · Prisma schema, first migration, seed
- Done:
  - **Schema** (`packages/db/prisma/schema.prisma`, SPEC §10): Better Auth's `User`/`Session`/`Account`/`Verification` (plus `User.login`), `Organization`, `Membership`, `Repository`, `RepoWorkflow`, `AuditLog`, `WebhookDelivery`. Prisma 7 `prisma-client` generator into `packages/db/src/generated` (gitignored, generated on `pnpm install`), `prisma.config.ts` (DATABASE_URL from env, then root `.env`, then the compose default), `@prisma/adapter-pg`. First migration `20260927163208_init`.
  - **Integrity in the database, not only in helpers:** `RepoWorkflow` references its repository through `(orgId, repoId)`, so a workflow can't carry another org's ID. GitHub IDs are `BigInt` (tested at 2^62). Unique: org per GitHub account, installation and slug; membership per (org, user); repo per (org, githubRepoId); workflow per (repo, githubWorkflowId); one user per GitHub identity (`Account` providerId + accountId), email and session token; one row per webhook delivery ID. Cascades: org deletion removes its tenant rows; user deletion removes sessions, accounts, memberships.
  - **Seed** (`pnpm db:seed`): demo org `pipeheal-demo` with an owner, two repos, three workflows, one audit entry. Idempotent (upserts, never overwrites local changes). Uses negative GitHub IDs so it can never collide with real GitHub objects. Refuses `NODE_ENV=production` and non-loopback databases.
  - **Scripts:** `db:migrate` (a tsx script: `prisma migrate dev`, then `prisma generate`, because Prisma 7's `migrate dev` no longer runs generators; verified), `db:generate`, `db:seed`, `db:studio` (smoke-tested).
  - **Test database:** the integration project's global setup (`vitest.integration.globalSetup.ts`) drops and recreates `pipeheal_test` on the local server and runs `prisma migrate deploy` (telemetry off). It refuses non-loopback servers, and its errors print the host only (checked with a password in the URL). Service URLs come from the shell env, then only the `DATABASE_URL`/`REDIS_URL` keys of the root `.env` (custom ports, README), then the defaults. The Redis test now uses the same resolution.
  - **Tests:** migrations apply to an empty database; `prisma migrate diff --exit-code` between the migrated DB and `schema.prisma` (mutation-checked: an unmigrated field makes it fail); every constraint and cascade above; seed contents, negative IDs, idempotence; URL validation without echoing the URL; seed and test-DB guards.
  - Shared `isLoopbackUrl`; the ESLint test-helper restriction now covers any `@pipeheal/*/testing`.
  - Separate commit: the gateway uses Fastify's `LogController` instead of the deprecated `disableRequestLogging` (removed in fastify 6; the warning filled test output).
- Decisions (implementation details, SPEC §10 updated):
  - The GitHub user ID is `Account.accountId` (providerId `github`), not duplicated on `User`.
  - `Repository` is unique per (org, githubRepoId) rather than globally: rows never move between tenants, so a transferred repo gets a new row in its new org and the old row keeps its history.
  - Install scripts: `@prisma/engines` is allowed to run (downloads the schema engine at install, not mid-test); `prisma`'s preinstall is ignored (Node version check only; `engine-strict` covers it).
- Verified: typecheck, lint, format, 181 unit+integration tests; `pnpm install --frozen-lockfile`.
- Notes:
  - Prisma's AI-agent guard refused `prisma migrate reset` on this container's dev database without your consent. I didn't bypass it: the migration was regenerated against a new, separate `pipeheal_dev` database instead. Your Windows database has never had a migration, so nothing to do there.
  - Follow-up for P1.6: `Organization.slug` is unique, but GitHub logins can be renamed and reused. On a slug conflict with a different `githubAccountId`, refresh the stale org's login from GitHub instead of failing.
  - Follow-up for P1.2/P1.3: apps add `DATABASE_URL` to their env schemas (`databaseUrlSchema`), and production should require TLS (`sslmode`) for non-loopback hosts, as for Redis.

## 2026-09-27 · P1.2 · Org-scoped data helpers
- Done (`packages/db/src/scope.ts`, `installations.ts`, `audit.ts`, `inputs.ts`, `errors.ts`):
  - `forMember(db, { orgSlug, userId })`: a signed-in user's scope, or `null` when the org doesn't exist or they aren't a member (callers answer 404 for both). The slug is matched case-insensitively.
  - `forSystem(db, orgId, component)`: the worker's scope. It adds `repositories.findByGithubId`, `syncInstalled` (upsert; new and re-added repos stay disabled) and `markRemoved` (disables them too).
  - `installations(db, component)`: `upsert` (install, reinstall, rename), `setStatus` (suspend, unsuspend, uninstall), `findByInstallationId`.
  - Scope helpers:
    - `repositories.list/get/setEnabled`, `workflows.listForRepo/setSelected`, `members.list` (public profile, no emails), `audit.list` (newest first, paged).
    - Every query filters on `orgId`. Writes use `update({ where: { id, orgId } })` after a scoped read.
    - Another org's ID, or a malformed one, behaves like an unknown ID: `null` on reads, `NotFoundError` on writes.
    - Roles are checked in the data layer too (SPEC §11): MEMBER reads, ADMIN changes repos and workflows (`ForbiddenError`). SYSTEM acts with OWNER rights.
    - Enabling a repo that left the installation is a `ConflictError`.
  - **Audit built in:** every mutation writes one row (actor USER + user ID, or SYSTEM + component) in the same transaction. No-ops and refused changes write nothing. P1.8 becomes a coverage check.
  - All caller input is zod-validated before any query: UUIDs, positive GitHub IDs, GitHub login and `owner/name` formats (`.`/`..` names rejected), batches of at most 100 per transaction, and audit page size ≤ 200.
- Tests (25 integration, 18 unit):
  - One cross-org case per helper, each asserting what org A gets back and that org B's org row, repos, workflows, memberships and audit log are unchanged. A meta-test fails if a helper has no case.
  - Roles, audit contents, no-op behaviour, removal/re-add, the installation lifecycle, paging, malformed IDs, oversized or malformed batches.
  - **Mutation-checked:** dropping `orgId` from one read and one write, plus adding an uncovered helper, turned exactly those three tests red.
- Decisions:
  - The audit log pages by ID (UUIDv7). I checked that Prisma generates v7 IDs monotonically: 300 IDs created within 7 ms came out in order. So no extra sequence column.
  - Membership creation (OWNER binding) and workflow discovery get their helpers in P1.3 and P1.7, with their own cross-org cases.
- Verified: typecheck, lint, format, 235 unit+integration tests.

## 2026-09-27 · P1.3 · Better Auth sign-in, OWNER binding, org guard
- Done:
  - **Env** (`apps/web/src/env.ts`): `DATABASE_URL`, `LOG_LEVEL`, `BETTER_AUTH_SECRET` (≥ 32 chars), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
    - In development the three sign-in settings are all-or-none: with none, the app runs and `/login` says sign-in isn't configured.
    - Production requires all of them, plus `sslmode=require|verify-*` on non-loopback database URLs.
    - `BETTER_AUTH_URL` removed from `.env.example`: the base URL is `APP_URL`.
  - **Better Auth** (`lib/auth/options.ts`, a pure factory so tests run the real flow):
    - GitHub provider with no OAuth scopes (App permissions apply); tokens encrypted at rest (D8).
    - Account linking off, email/password off, telemetry off, `pipeheal` cookie prefix.
    - Better Auth's logs go through the redacting logger.
    - `login` refreshed from GitHub at every sign-in; `/update-user` disabled, so nobody can edit the profile fields other members see.
  - **OWNER binding** (SPEC §5.2):
    - `/auth/complete` (the sign-in callback URL) finds pending candidates in the DB (installer GitHub ID, active org, not yet a member). Only if there is one, it gets the user's decrypted token from Better Auth and calls `GET /user/installations`.
    - `installations.bindVerifiedOwner` then binds OWNER, with audit, only for installations GitHub listed.
    - GitHub errors are logged and never block sign-in. Redirects after sign-in accept same-origin paths only.
  - **Guards:**
    - `proxy.ts` is only a session-cookie-presence redirect to `/login?next=`.
    - `requireOrgMember(slug, minRole)` checks session and membership in every org layout and page. Non-members, unknown orgs and insufficient roles all give 404.
    - Minimal `/login`, `/[org]` (repository list), a home page listing the user's orgs, and sign-out.
  - **`packages/github`:** `listUserInstallationIds` (octokit, all pages, zod-validated, configurable retries and logger). The rest of the client comes in P1.4.
  - **`packages/db`:** `ownerCandidates`, `bindVerifiedOwner` (both with cross-org cases), `organizationsOf`, `githubIdentity` (IDs only, never tokens), `tlsUnlessLoopback`, and a light `@pipeheal/db/url` entry point.
- Tests (new: 9 Better Auth flow, 5 proxy, 17 redirect, 10 env, 5 GitHub wrapper, 7 access/binding, 3 Postgres sign-in, 5 schema, e2e 4):
  - The real OAuth flow against msw GitHub checks: authorize URL, user and login, verified email, cookie flags, tokens not in storage but decryptable, login rename, no linking by email, missing-email refusal, profile edits refused (mutation-checked), no token in logs.
  - On Postgres: sign-in through the Prisma adapter, then OWNER binding with the decrypted token actually sent to GitHub, and no binding for a non-installer.
  - Better Auth's expected tables vs the migrated DB (types, nullability; mutation-checked).
  - e2e (production build): signed-out redirect with `next`, open-redirect refusal, forged cookie stopped by the layout. I ran e2e once with the database unreachable to prove signed-out paths never query it (the e2e CI job has no Postgres).
  - Live dev-server smoke test with a real session: member sees the demo org's repos, a non-member org gives 404, and a signed-in user is sent past `/login`.
- Fixed on the way:
  - The home page read env during prerender, so `next build` needed runtime secrets. Sessions now read the request first, making those pages dynamic.
  - `instrumentation.ts` pulled Prisma into the Edge bundle; it now imports env lazily, and env uses `@pipeheal/db/url`.
  - Vitest resolves the web `@/` alias.
- Decisions (SPEC §5.2 updated): 404 for non-members and insufficient roles (Next's `forbidden()` is still experimental); OWNER check at `/auth/complete` rather than inside Better Auth hooks.
- Not covered by e2e yet: clicking "Sign in" (Better Auth stores OAuth state in Postgres, which the e2e job lacks). The flow is covered by the unit and integration tests above. Adding Postgres to the e2e job fits P1.7.

## 2026-09-27 · P1.3 follow-up · Security review fixes
- `security-reviewer` on the P1.3 commit: no critical or high findings; 3 medium, 6 low.
- Fixed:
  - **M1: decrypted GitHub tokens were reachable over HTTP.** Better Auth still served `/get-access-token`, `/refresh-token` and `/account-info`, so anyone holding a session (stolen cookie, XSS) could get the user's GitHub token, which keeps working after sign-out. Those endpoints, plus `/link-social` and `/unlink-account`, are now disabled over HTTP; the server still uses `auth.api`. Tested: each returns 404 for GET and POST.
  - **M2: open redirect through dot segments.** `/.//evil.example` normalized to `//evil.example` after my `//` check. The check now runs on the normalized path, and `/auth/complete` also refuses any target off the app's origin. Tested with the payloads, a leave-the-site property check and e2e.
  - **L4:** a bound installer's candidacy is now used up (`installerGithubId` cleared in the binding transaction), so an owner removed later isn't re-bound at their next sign-in. Also tested: two racing binds give exactly one OWNER and one audit row.
  - **L5:** Better Auth disables its Origin and callback-URL checks whenever `NODE_ENV=test` or `TEST` is set. They are now forced on. Tested: a cross-site request carrying the session cookie gets 403, and foreign callback URLs are rejected. Mutation-checked: without the setting those tests fail.
  - **L6:** the GitHub call on the sign-in path is bounded (5 s total, 1 retry). Tested with a slow GitHub.
  - **L7:** couldn't reproduce: Better Auth's provider logs go through our logger inside endpoints. The test now also captures the console, so a bypass would fail it.
  - **L8:** SPEC corrected: tokens are XChaCha20-Poly1305 with key SHA-256(secret), not AES-GCM.
  - **L9:** `/auth/complete` got direct tests: redirect target, error path, no session, sign-in off, bounded GitHub options. The proxy matcher skips paths with a file extension, which is fine because GitHub logins contain no dots and layouts/pages check anyway.
- **Open, for Malek at CHECKPOINT 1a (M3, SPEC §15):** a repository admin who can install the App (no org permissions requested) would become OWNER of the whole org tenant. This decides the App's permissions, so it comes before registration. I couldn't verify GitHub's current install rules from here (docs.github.com is blocked).
- Follow-up for P1.6: pass `installerGithubId` only on `installation.created`, not on other installation events.
- Verified: typecheck, lint, format, 348 unit+integration tests, 8 e2e.

## 2026-09-27 · P1.4 · packages/github
- Done:
  - **App client** (`createGitHubApp`): JWT signed with the App key (verified against the public key in tests), installation tokens from octokit's in-memory cache (one token request for repeated use; never stored).
    - Every request has a time limit (default 30 s); tests found octokit's outer `wrap` hooks can't change options, so it's a `before` hook.
    - Bounded retries; octokit's write pacing (≈1 write/s, GitHub's guidance) stays on in production.
    - Rate-limit messages go to our logger.
  - **Credentials:** `GITHUB_APP_PRIVATE_KEY` is the .pem base64-encoded on one line (kickoff decision). `decodePrivateKey` accepts PKCS#1/PKCS#8 and CRLF, and rejects non-RSA, public or corrupt keys without echoing them. There are zod pieces for the apps' env, and a webhook secret of ≥ 32 chars. `.env.example` explains the PowerShell one-liner.
  - **Webhook signatures:** `verifyWebhookSignature`, HMAC-SHA256 over the raw body with a constant-time compare. Tested with GitHub's documented example, plus tampered bodies, secrets and headers, and re-serialized JSON.
  - **Wrappers, each response zod-validated into a small domain type:**
    - Actions: runs for a SHA, jobs and failed jobs of an attempt (with the failed step), workflows, re-run failed jobs, dispatch (returns the run ID with `return_run_details`).
    - Job logs: streamed, keeping the last 5 MB from a whole line. The storage redirect doesn't receive our token (tested).
    - Compare commits; file at ref: raw, size-capped, with binary / too-large / directory / missing cases.
    - Installation repositories, PRs (with `fromFork`), comments (65,536-char cap), reviewers.
  - **Product invariants in the client:** `commitFiles` (Git Data API) only writes to `pipeheal/*` branches and moves them with `force: false`. It refuses any path under `.github/` or `.git/` (case-insensitive: Windows/macOS checkouts) and any traversal, before any request. PRs open only from `pipeheal/*` branches of the same repo, with `maintainer_can_modify: false`. There is no merge function (a test checks).
- Tests: 119 in the package (msw), including pagination, bad responses, 5xx retry, request timeout, 403 without leaking the token, and exact request bodies for the Git Data calls.
- Not verifiable from here: whether creating/applying the `pipeheal` label works with Pull requests: write alone (SPEC §15). docs.github.com is blocked in this container; the reliable check is a real call with the dev App after CHECKPOINT 1a (label needed in Phase 5).
- Verified: typecheck, lint, format, 457 unit+integration tests.

## 2026-09-27 · P1.5 · GitHub App setup guide and webhook relay
- Done:
  - `docs/SETUP-GITHUB-APP.md` walks through the sandbox org, a smee.io channel, and every App setting.
    - Callback `http://localhost:3000/api/auth/callback/github`; Setup URL `/onboarding/installed` (P1.7); no OAuth during installation.
    - Exact permissions from SPEC §5.1: Workflows explicitly No access; Email addresses read (D9); no org permissions, pending the OWNER decision.
    - Events Workflow run and Pull request; installable only on the sandbox.
    - Where each `.env` value comes from, base64-encoding the key in PowerShell, generating secrets, verification steps, troubleshooting.
  - `pnpm dev:webhooks` (`scripts/dev-webhooks.ts`, run with `tsx` and the root `.env`): a small smee.io client written for this instead of the `smee-client` package, so it's tested and does exactly what we need.
    - Forwards only GitHub's delivery headers, only to a loopback target (default `/api/webhooks/github`, the P1.6 route), and uses the exact signed bytes when smee.io provides them.
    - Logs event, delivery ID and status only, never payloads. Reconnects with backoff.
    - 14 tests (SSE parsing across chunk boundaries, header allowlist, env validation).
- Dependencies (root, dev): `tsx` (runs repo scripts, CLAUDE.md), `msw` (the relay's tests); both already used in the workspace.
- Couldn't run against the real smee.io (blocked in this container). The relay is covered by tests with an SSE stream; Malek's step 6 in the guide is the live check.

## 2026-09-27 · P1.4 follow-up · Security review fixes (packages/github)
- `security-reviewer` on P1.4: no critical or high findings; 4 medium, 6 low.
- Fixed:
  - **M1: modes and symlinks.**
    - `commitFiles` now walks the parent commit's tree for every changed path. It keeps each file's mode (100755 stays executable) and refuses symlinks, submodules, directories, paths through non-directories, and deleting missing files. The `executable` option is gone.
    - `getFileAtRef` uses the JSON contents API. It reports `symlink` (including GitHub silently following a link to its target), `submodule`, `not_a_file`, `too_large`, and binary for NUL bytes or invalid UTF-8.
    - Text is decoded exactly, BOM kept, so reading a file and writing it back is lossless.
  - **M2: multi-tenant throttling.** octokit's throttling plugin is off. Its queues are process-wide (every tenant shared one write queue) and its rate-limit waits weren't bounded by our time limits. Rate-limited calls now fail fast with their status; per-installation pacing goes in the worker's queues (noted in P2.1).
  - **M3: error contents.** Every failed call becomes a `GitHubApiError` (status, route template, `x-github-request-id`, GitHub's short message). No request body (customer code), headers or URLs. Tested with customer code in a failing tree POST.
    - Job logs: we take GitHub's redirect manually, accept only `https` log storage hosts, and download without our token. Storage errors carry no signed URL.
  - **M4: forks fail closed.**
    - Runs and PRs compare repository IDs, never names; a missing head repo counts as a fork.
    - `rerunFailedJobs` refuses fork runs. `comment` refuses fork PRs and plain issues. `requestReviewers` only works on PipeHeal's own `pipeheal/*` PRs.
    - SPEC §9.1 and P5.3: runs map to attempts by the App's commit SHA, not by branch name.
  - **L5:** moving an existing `pipeheal/*` branch requires its tip to equal the given parent (someone else's push is refused). P5.2 records created branches.
  - **L6:** write paths follow git's NTFS/HFS protections: `GITHUB~1`, trailing dots/spaces, nested `.git`/`git~1`, `.gitmodules`, Windows reserved names and characters, HFS-ignorable code points. P3.4 shares this normalizer with INV-GITHUB-DIR.
  - **L7:** commit messages may not contain `[skip ci]`-style markers or `skip-checks: true`.
  - **L8:** non-idempotent calls are never retried: dispatch, comment, PR creation, re-run, ref creation and update.
  - **L10:** listings are capped at 10,000 items (100 pages for installation repos); comparisons report `commitsTruncated` / `filesTruncated`; dispatch `ref` and PR `base` are validated as branch names.
- Deferred to where they're used: **L9** repository-scoped, read-only installation tokens for model-facing reads (P4.3b).
- Mutation-checked: without error sanitizing, or without the branch-tip check, their tests fail.
- Verified: typecheck, lint, format, 546 unit+integration tests (194 in packages/github).

## 2026-09-27 · CHECKPOINT 1a · Decisions D10 and the Phase 1 PR
- Malek's answers at the checkpoint:
  - **D10:** request the org permission Members: read and require an org-admin role for OWNER binding;
  - open a draft PR now so CI runs on Phase 1.
- Done (D10):
  - `listUserAdminOrgIds` (`GET /user/memberships/orgs`, active admins only, matched on organization ID so renamed orgs still match).
  - `installations.bindVerifiedOwner(claim, { installationIds, adminOrgIds })` enforces the rule in the database query: the installation is listed, and either a personal account whose ID is the user's own, or an organization in `adminOrgIds`.
  - `/auth/complete` asks for memberships only when an org candidate exists.
  - SPEC §5.1/§5.2/§15/§16 and the setup guide (Organization permissions: Members read-only) are updated.
- Tests:
  - DB: a non-admin installer isn't bound; a personal account binds only to its own user; the cross-org case uses admin evidence for the other org.
  - Web: a non-admin isn't bound; a personal account needs no membership call; on Postgres, both GitHub calls carry the user's decrypted token.

## 2026-09-27 · CHECKPOINT 1a · Done
- Malek registered the dev GitHub App on a sandbox organization and filled every `.env` value (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SMEE_URL`), following `docs/SETUP-GITHUB-APP.md`. `BETTER_AUTH_SECRET` was also fixed locally (it was empty while the GitHub sign-in vars were set, which fails the web env's all-or-none check for those three; a fresh secret was generated the same way the guide directs).
- Verified locally (Windows, native): `pnpm dev` starts clean, `/api/health` and `/health` both 200.
- Continuing with P1.6 (webhook route) via `/next-task`.

## 2026-09-27 · P1.6 · Webhook route
- Done:
  - **`apps/web`: `POST /api/webhooks/github`.** Verifies `X-Hub-Signature-256` over the raw request body (`verifyWebhookSignature`, P1.4) with the real secret; answers 503 (never touching the signature, DB or queue) when `GITHUB_WEBHOOK_SECRET` isn't set, matching the sign-in "not configured" fallback. Records the delivery (`packages/db`'s new `webhook-deliveries.ts`: `recordWebhookDelivery`, idempotent under a race via the unique-constraint retry path), enqueues a `webhooks` BullMQ job only when the delivery is new, and answers fast. A light, non-strict peek at `action`/`installation.id` feeds `WebhookDelivery`'s own columns; the worker does the full, event-specific validation.
  - **`apps/web` gets a Redis connection and a queue producer** (`lib/redis.ts`, `lib/queue.ts`): `ioredis`/`bullmq`, pinned to the same versions the worker already uses. `REDIS_URL` and `GITHUB_WEBHOOK_SECRET` added to the web env schema (both optional in development; required, TLS/32+ chars, in production).
  - **`apps/worker`: `queues/webhooks.ts`.** Routes by event:
    - `installation` `created` → `installations.upsert` (installer = sender, SPEC §5.2's OWNER candidate; P1.3's follow-up honored: no other action passes `installerGithubId`), then fetches the installation's repositories from GitHub itself (`listRepositories()`; the webhook's own `repositories` field lacks `default_branch`, so it's never trusted for that), `syncInstalled`s them (archived repos skipped: nothing to watch, and our schema has no field for it), then `listWorkflows()` per repo and upserts `RepoWorkflow` rows (`selected: false`; pre-selection and the picker are P1.7).
    - `installation` `deleted` → org `UNINSTALLED`, and every one of its repositories marked removed (no GitHub call needed).
    - `installation` `suspend`/`unsuspend` → org status.
    - `installation_repositories` `added` → re-fetches the authoritative repo list (reuses the `created` path); `removed` → `markRemoved` from the webhook's own repo IDs alone (no GitHub call).
    - Anything else (`ping`, `workflow_run`, `pull_request`, future actions) → acknowledged, no processor yet.
    - On success: `markWebhookDeliveryProcessed` (clears any earlier error). On failure: a redacted error is recorded and the error is rethrown, so BullMQ retries with its own backoff; the delivery stays unprocessed for the P2.2 reconciler to find.
  - **`packages/db`:** `webhook-deliveries.ts` (record/mark-processed/mark-failed; not tenant-scoped, matching `WebhookDelivery`'s own design). `scope.ts` gets `workflows.syncInstalled` (system-only, same shape as `repositories.syncInstalled`), with its own cross-org case (the `scope.int.test.ts` meta-test requires one per helper).
  - **`packages/github`:** `webhook-payloads.ts`, zod schemas for the `installation` and `installation_repositories` payloads (only the fields used; a plain `z.object()` ignores the rest, so a new GitHub field can't break parsing). New light `./credentials` package export, so `apps/web/src/env.ts` (loaded by `instrumentation.ts`) can validate `GITHUB_WEBHOOK_SECRET` without pulling `octokit` into the same bundling path that made `@pipeheal/db/url` necessary in P1.3.
  - **`packages/shared`:** `webhook-job.ts`, the `WebhookJobData` schema both `apps/web` (producer) and `apps/worker` (consumer) validate against.
  - Both apps' envs gained a full production schema for the fields P1.6 needed (`apps/web`: `REDIS_URL`; `apps/worker`: `DATABASE_URL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`), closing the P1.1/P1.2 follow-up about apps validating `DATABASE_URL` themselves.
- Tests: 41 unit + integration across the new files (13 worker integration tests against real Postgres and msw's GitHub, including idempotent double-processing, the archived-repo skip, the "removed never calls GitHub" case via `onUnhandledRequest: "error"`, and a redacted-error-on-failure case; 12 payload-schema tests; 10 route unit tests with a real computed HMAC signature, not a mocked verifier; plus the `webhook-deliveries` and `workflows.syncInstalled` DB tests).
- Verified live, on the real dev server (Windows, real Postgres/Redis): a genuinely signed `ping` delivery was accepted (200) and its `WebhookDelivery` row was marked `processedAt` by the real worker within ~120 ms.
- e2e: `pnpm test:e2e` (8/8) passed once pointed at an already-installed Chromium (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`) — this machine has revisions 1223/1228 cached from other projects, but Playwright 1.63.0 here wants 1243, and `cdn.playwright.dev` timed out fetching it. Not a code issue; the override is Malek's own shell env, not a repo change (it's a stale-cache mismatch specific to this machine, not something to bake into tracked config). `pnpm dev:webhooks` against the real App/sandbox wasn't re-run for this task (P1.5 already covers the relay itself); a real `installation.created` delivery from installing the App on the sandbox is the natural check at P1.7 (onboarding), not before.
- Decisions:
  - `RepoWorkflow` rows are registered here (id/path/name); pre-selection and the enable/disable picker stay in P1.7, per the P1.2 note.
  - Repository details always come from `GET /installation/repositories`, never from the webhook's own (minimal) repo lists — simpler than adding a per-repo GitHub lookup, and authoritative.
  - Archived repositories are skipped rather than synced-then-hidden: our schema has no `archived` column, and there's nothing to heal on an archived repo.
- Follow-ups:
  - P2.1: per-installation pacing for the GitHub calls this file makes (already flagged in the P1.4 review).
  - A repo that's archived after being synced keeps its existing row as-is; no webhook fires for archiving alone. Not a problem yet; worth a look whenever repo state UI lands.

## 2026-09-28 · P1.7 · Onboarding UI

- Done:
  - **`/onboarding`**: sign-in required, then "Install GitHub App" linking to `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new` (`env.ts`'s new `githubAppInstallUrl`, `GITHUB_APP_SLUG` added to the web env schema — optional in development, required in production); "installing isn't configured" when the App isn't registered on this deployment.
  - **`/onboarding/installed`**: the App's Setup URL (no OAuth code — "Request user authorization during installation" is off, confirmed against the real App). Runs the owner-binding check (extracted from `/auth/complete` into `lib/auth/owner-binding.ts`'s `runOwnerBindingCheck(db, auth, headers, userId, logger)`, now shared by both call sites) so a first-time installer is recognized as OWNER without signing in again, then looks up the org by `installation_id` and redirects to `/[org]/repos`. Installing races the webhook: if the org isn't there yet, shows "still processing" with a manual Refresh link (same URL, query string preserved) rather than polling.
  - **`/[org]/repos`**: repo list; ADMIN+ gets enable/disable buttons (`repositories.setEnabled`, already RBAC-checked there), everyone else sees read-only status. Replaces the read-only placeholder that used to live at `/[org]`; `/[org]` is now a stub linking here until the real dashboard (P6.1).
  - **`/[org]/repos/[repo]`**: per-workflow checkboxes (native `<input type="checkbox">`, no new UI dependency), `defaultChecked` from the stored `selected` value; ADMIN+ submits a form that calls `workflows.setSelected` for every workflow in the repo; everyone else sees read-only Watched/Not watched.
  - **Moved the CI-looking pre-selection into the worker, at discovery time**, rather than computing it on the web side: `apps/worker/src/queues/workflow-yaml.ts` gets `isCiLooking({ triggers, usesEnvironment, name, path })` (SPEC §11's exact rule — push or pull_request, no `environment:`, no deploy/release/publish in name or path), and `syncRepositoriesAndWorkflows` (`apps/worker/src/queues/webhooks.ts`) passes its result as a new optional `selected` field on `InstalledWorkflow` (`packages/db/src/inputs.ts`). `workflows.syncInstalled` (`packages/db/src/scope.ts`) applies `selected` only when *creating* a row — an update never touches it, so a later sync (new facts, or none) can't undo an admin's own choice on `/[org]/repos/[repo]`. This makes the picker page a plain read/edit of the real `selected` column, with no separate "has been confirmed" tracking needed.
  - New `apps/web/src/lib/form.ts` (`stringField`): a form field read as a string or `""`, used by both new `actions.ts` files instead of `String(x ?? "")` (which ESLint's `no-base-to-string` rightly rejects for a `FormDataEntryValue`, since it could be a `File`).
- Tests:
  - `apps/worker/src/queues/workflow-yaml.test.ts`: 8 new `isCiLooking` cases (push/pull_request trigger, workflow_dispatch-only rejected, `environment:` rejected, name/path substring matches for deploy/release/publish).
  - `packages/db/src/inputs.test.ts`, `packages/db/src/scope.int.test.ts`: `selected` accepted/rejected by the schema; a new integration test proves a later sync with `selected: true` again does not override an admin's explicit `false`.
  - `apps/worker/src/queues/webhooks.int.test.ts`: updated the existing discovery test's expectation (a plain push-triggered workflow is now pre-selected `true`, where it used to assert `false`) and extended `mockWorkflowsFor`'s `contents/*` handler fix (a lint-driven `present()` cleanup, not new mocking).
  - e2e (`apps/web/e2e/auth.spec.ts`): 4 new signed-out-redirect cases for `/onboarding`, `/onboarding/installed` (query string preserved), and `/[org]/repos/[repo]`, matching the existing `/[org]` case's style. No signed-in e2e coverage: this repo has no session-seeding fixture yet, and (confirmed by checking) no page or server action anywhere gets a direct unit/component test — `login/page.tsx` and `login/actions.ts` have none either, only e2e and the underlying lib/data-layer tests. Page and action code here stays thin for the same reason.
- Decisions:
  - `/[org]` dropped its own repo listing in favor of linking to `/[org]/repos`, rather than keeping two places that show the same data.
  - No new shadcn checkbox component: a native `<input type="checkbox">` needed no extra dependency or styling work for one page.
  - Viewing `/[org]/repos` and `/[org]/repos/[repo]` only requires MEMBER; the mutating buttons/forms are hidden (not just disabled) for anyone below ADMIN, and the server actions re-check ADMIN themselves via `requireOrgMember(org, "ADMIN")` (404, not a silent no-op, for a non-admin who submits anyway).
- Follow-ups:
  - SPEC §11's richer onboarding (auto-detected commands, healer YAML copy, "Verify setup" dry run) is P6.2, not this task.
  - Not yet exercised against a real installation end-to-end (needs a real App install on the sandbox org); P1.6's progress note already flagged this as the natural place to do that first real check.

## 2026-09-28 · P1.8 · Audit log for every mutation

- Done:
  - **Found already in place** (built alongside the helpers since P1.2): every runtime write to tenant data (`Organization`, `Membership`, `Repository`, `RepoWorkflow`) happens in a `packages/db` helper that writes its `AuditLog` row in the same transaction (who: `actorType` USER/SYSTEM + user ID or component; what: `action` + `target` + `metadata`; when: `createdAt`), and no-ops and refused changes write nothing. So this task was about making that coverage guaranteed and making "what" say what changed, not adding audit calls.
  - **Guaranteed for every helper, current and future** (`packages/db/src/scope.int.test.ts`): a new meta-test, next to the cross-org one, requires every helper to be either in `auditCases` (a real change, plus the exact entries it must write: actor, action, target, metadata, in the right org, stamped now) or in `readOnlyHelpers`. A helper added to neither fails the suite.
  - **Nothing can bypass the helpers** (`eslint.config.mjs`): outside `packages/db`, direct Prisma writes to the tenant tables or `AuditLog` (`db.x.create/update/upsert/delete…`, also inside `$transaction`) and raw SQL writes (`$executeRaw` as call or tagged template, `$executeRawUnsafe`) are lint errors. Inside `packages/db`, updating or deleting an audit row is a lint error (append-only). Test files and `testing/` are exempt (fixtures). Verified with throwaway violation files: all five forms flagged, reads and unrelated `.update()` calls (e.g. `createHash().update()`) not.
  - **Updates now record what changed** (`packages/db/src/audit.ts`'s `auditChanges(before, after)` → `{ field: { from, to } }`): `organization.updated`/`reinstalled` (login, accountType, status, installationId, installerGithubId), `repository.updated`/`readded` (fullName, defaultBranch), `workflow.updated` (path, name, triggers, usesEnvironment; never `selected`). Before this, a rename kept no trace of the old login. Callers pass the fields explicitly, so nothing is recorded by accident; bigints are stored as strings.
- Tests: `audit.test.ts` (5 unit tests for `auditChanges`: only changed fields, empty on no change, list order matters, null on either side, only the fields passed); 9 new integration tests (the classification meta-test + one per mutating helper); the install/rename/reinstall test now asserts the exact `changes` recorded. Full suite 660/660.
- Decisions:
  - Not audited, by design (documented in `audit.ts`): Better Auth's own `User`/`Account`/`Session`/`Verification` rows (a sign-in isn't a change to any organization, and `AuditLog.orgId` is required) and `WebhookDelivery` (it's the ingest record itself; whatever a delivery changes is audited by the helpers it calls).
  - OWNER binding stays attributed to the SYSTEM component `sign-in` (both `/auth/complete` and `/onboarding/installed` go through `bindVerifiedOwnerships`), with the bound user as the target (`user:<id>`), as before: the user didn't choose to become owner, GitHub's evidence did.
- Also in this commit: `pnpm format` output for six P1.7 files I'd committed without running Prettier (whitespace/line-wrapping only).
- Follow-ups:
  - SPEC §11 lists an audit log view under `/[org]/settings`, but no PLAN task builds it yet (`audit.list` with paging exists). Worth adding to P6.6 (members & roles UI) or its own task.
  - `schema.int.test.ts`'s migration-drift test timed out once at its 5 s limit right after Docker Desktop had just started (cold Postgres + a Prisma subprocess); it passed on re-run and in the full suite. If it recurs on CI, that test deserves a longer per-test timeout.

## 2026-09-28 · CHECKPOINT 1b · Phase 1 on a real installation, and three fixes it exposed

- Result: Malek installed the App on `pipeheal-sandbox-malek` through `/onboarding`. Checked in the database afterwards: the org is ACTIVE, the installing user was bound OWNER (`member.owner_verified`, by `sign-in`), `pipeheal-sandbox-malek/testapp` was synced and then enabled by a signed-in user (USER actor), and every step has its audit entry. The "removing a repo disables it" half of the acceptance line wasn't observed in the database when this was written (no repo had been removed yet); it's covered by the worker's integration tests.
- Found on the way, and fixed:
  1. **No webhooks arrived at all at first.** GitHub had sent the App nothing but its setup `ping`s: the App's webhook was inactive (GitHub still sends `installation` events without a subscription, but not to an inactive webhook), so the org was never created and `/onboarding/installed` waited forever. Fixed on GitHub (webhook Active, uninstall + reinstall). Diagnosed with `GET /app/hook/config` and `GET /app/hook/deliveries` using the App's own credentials. In code: that page now says where things are, from a new `installationDeliveryState` (`packages/db`): GitHub hasn't told us yet / received and being set up / hit a problem and is retrying / done; and logs a warning server-side while nothing has arrived, since only the operator can fix that. No error text is shown (the visitor isn't tied to the installation yet). It looks back one hour only, so it stays on the `receivedAt` index as deliveries pile up.
  2. **An empty repository failed the whole delivery.** GitHub answers `409 Git Repository is empty.` (not 404) for any ref of a repo without commits, so the workflow scan added in P1.7 threw, BullMQ retried five times, and the other repos in that `installation_repositories.added` delivery lost their workflow sync too. `getBranchSha` now returns null for that 409 like it does for a missing branch (only there; a 409 elsewhere is a real conflict), and the worker doesn't resolve the branch at all for a repo with no workflows.
  3. **A delivery the worker gave up on could never be recovered.** We answer 2xx on receipt, so GitHub never marks it failed; a manual redelivery reuses the delivery ID, which the route treated as "already handled", and BullMQ ignores a job ID it still holds in its failed set. Now `recordWebhookDelivery` also says whether an existing delivery was processed, and for an unprocessed one the route calls `requeueWebhookJob`: retry the failed job with a fresh set of attempts, re-enqueue if the failed job was pruned, leave a waiting/running job alone. Processed ones are still dropped. SPEC §2.2 updated to say so; finding such deliveries automatically stays with the reconciler (P5.3).
- Also: `schema.int.test.ts`'s migration-drift test gets a 30 s timeout. It runs the Prisma CLI as a synchronous subprocess, 3–5 s on Windows under a full run; it timed out twice at Vitest's default 5 s. The assertion is unchanged.
- Tests: 670/670. New: `getBranchSha` on the real 409 response; a worker integration test with an empty repo next to a normal one (delivery processed, the other repo's workflow synced); `installationDeliveryState` (all four states, only `installation.created` for that installation within the hour, malformed ID); a redelivery reporting `processed`; route unit tests for processed vs unprocessed redeliveries; `requeueJob` against real Redis/BullMQ (retry a genuinely failed job with `attemptsMade` reset, re-enqueue a pruned one, leave a waiting one alone and never duplicate). Mutation-checked: without `resetAttemptsMade` the retry test fails.
- To recover the delivery that failed during the checkpoint (`installation_repositories.added` for testapp): GitHub → the App → Advanced → Recent Deliveries → that delivery → Redeliver. With the dev server restarted on this code, it now reruns.

## 2026-09-28 · P2.0 · Demo repos and `scripts/break.ts`

- Done:
  - **`examples/demo-node`**: a small TypeScript checkout library (`formatCents`, cart totals and discounts, receipts) with `tsc` (strict), ESLint (typescript-eslint recommended), Vitest, and `package-lock.json`. Tools pinned to the exact versions this monorepo already vetted (TypeScript 6.0.3, Vitest 5.0.2, ESLint 10.11.0, typescript-eslint 8.70.1).
  - **`examples/demo-python`**: a small invoicing module (`Decimal` line totals, tax, formatting) with ruff (E, F, I, B, UP), mypy `strict`, pytest; `requirements-dev.txt` pins pytest 9.1.1, ruff 0.16.9, mypy 2.3.1.
  - Each has `.github/workflows/ci.yml` (`CI`, on push to any branch and on pull requests, so PipeHeal pre-selects it): install → checks → tests writing JUnit XML to `reports/junit.xml`, uploaded as an artifact even when tests fail. Actions at their current majors (`checkout`/`setup-node`/`setup-python`/`upload-artifact` @v7, checked on GitHub today). Each is a standalone repo (own `.gitignore`, `.gitattributes`, README); the monorepo's ESLint and Prettier skip `examples/`, and it isn't a pnpm workspace member.
  - **`scripts/break.ts`** (`pnpm break <scenario> --repo <clone> [--push]`, `pnpm break --list`), on `scripts/lib/break-scenarios.ts` (the catalogue) and `scripts/lib/break-run.ts` (git). 17 scenarios covering all nine of SPEC §14: `type-error`, `logic-bug`, `missing-import`, `lint`, `missing-dependency`, `trap-test`, `flaky`, `missing-secret` for both demos, plus `python/trap-injection` (SPEC's wording names `tests/test_billing.py`). Each scenario is a list of edits (replace text that must occur exactly once, or create a file), its expected category and outcome, and an ordinary commit message that doesn't give it away. `break` makes `break/<scenario>-<timestamp>` from the clone's current commit, commits, optionally pushes, and always switches back to the original branch (even if the push fails). It refuses: a clone with uncommitted changes, a folder that isn't a repo root, the wrong demo, and this repository itself (so the copy in `examples/` is never modified). Edits are checked before anything is written; if a scenario doesn't apply, no branch is left behind.
  - `examples/README.md`: pushing each demo to its own repo on the sandbox org (PowerShell + `robocopy`), then running scenarios, with the expected category of each.
- Verified for real, not just in unit tests: both demos pass their own checks as committed (Node: typecheck, lint, 10 tests, JUnit written; Python: ruff, mypy strict, 6 tests). Then, in scratch clones, every scenario was applied with the real `pnpm break` CLI and the demo's CI steps run on its branch. Each fails at the intended step:
  - Node: `type-error` → tsc TS2305; `missing-import` → tsc TS2304; `missing-dependency` → tsc TS2307 (`zod`); `lint` → `@typescript-eslint/no-unused-vars`; `logic-bug`, `trap-test`, `flaky` → Vitest assertion failures.
  - Python: `type-error` → mypy `attr-defined`; `missing-import` → ruff F821; `lint` → ruff I001; `missing-dependency` → mypy "Library stubs not installed for "requests" [import-untyped]" (not "module not found": mypy knows `requests` has a stub package, so P2.3/P2.4 must read that message as `dependency` too); `logic-bug`, `trap-test`, `trap-injection`, `flaky` → pytest assertion failures.
  - `missing-secret` (both): code checks stay green; the added "Check API credentials" step exits 1 without `TAX_API_TOKEN` and passes with it. The four workflow variants (both demos, before/after) parse as YAML with the step in place before Test.
- Tests: `break-scenarios.test.ts` (every SPEC §14 scenario covered; every scenario applies cleanly to the demos as committed and changes them; unique IDs; demo markers; no commit message gives the scenario away; `applyEdits` all-or-nothing, refusals, `$` patterns inserted literally), `break-run.test.ts` (real git in temp repos: branch + commit + back to `main`; push to a bare remote; a failed push still returns to `main` and keeps the commit; no branch left when a scenario doesn't apply; each refusal, including this repository and its `examples/` copy). Full suite 707/707.
- Decisions:
  - Categories for "missing import": SPEC §6.1 lists it under `compile`, so both demos expect `compile`, even though tsc (TS2304) and ruff (F821) are the tools that report it. The classifier (P2.4) has to map those codes to `compile`.
  - `flaky` really is random (SPEC: "using randomness"): the test fails about half the time, so a first run can pass (push again), and a re-run can fail again. Making it deterministic (e.g. keyed on `GITHUB_RUN_ATTEMPT`) would be an obvious tell to the agent.
  - `tests/workspace.test.ts`'s no-shell-scripts check now skips `.venv` like it skips `node_modules`: a local, git-ignored Python install ships `activate.bat`/`Activate.ps1`.
- Follow-ups:
  - This monorepo's own CI still pins `actions/checkout@v5`, `setup-node@v5`, `upload-artifact@v4`; v7 is current. Worth a small separate update.
  - **Gap found while writing the CHECKPOINT 2a steps:** workflows are only discovered when a repository is added to the installation. A workflow pushed later (or a repository created empty under an "all repositories" installation, then pushed) is never discovered, because the App gets no event for it. Workaround documented in `examples/README.md` (select the demos after pushing). Proper fix proposed for P2.1: a `workflow_run` for a workflow we don't know discovers it (fetch its file, apply the CI-looking pre-selection) before the "selected workflows only" filter runs.

## 2026-09-29 · CHECKPOINT 2a · Demo repos on the sandbox org

- Result: `pipeheal-sandbox-malek/pipeheal-demo-node` and `pipeheal-demo-python` are pushed, in the App's installation and enabled. PipeHeal discovered each one's `CI` workflow with triggers `push, pull_request`, no `environment:`, and pre-selected it as CI-looking. Every delivery processed without error, including the redelivery of the `testapp` delivery that had failed at CHECKPOINT 1b (the recovery fix works).
- Incident on the way: the Node demo's first `git init`/commit ran in the parent folder `new_pipeheal`, not inside the demo, so that commit held the GitHub App's private key and `secrets.txt`, and was pushed to the (private) `pipeheal-demo-node` repo. Malek deleted and recreated that repository; the demo was then committed from its own folder (14 demo files only, checked before the push) and pushed. The stray parent repository's `origin` remote was removed so it can't push again. **Rotating the App private key and the values in `secrets.txt` is Malek's to do and wasn't verified here**; the stray `new_pipeheal/.git` still exists locally (no remote).

## 2026-09-29 · P2.1 · `workflow_run` processor

- Done:
  - **Data** (`packages/db`, migration `20260928225201_failures`): `PipelineFailure` (unique on repo + head SHA), `FailedRun` (unique on repo + run ID), `FailedJob`, with SPEC §10's fields, `FailureStatus`/`FailureCategory` enums, and foreign keys pinned to the parent's org like every other tenant table. System-scope helpers: `failures.recordFailedRun` (opens the failure and its 5-minute window on a commit's first failed run, attaches the others, updates a run for a newer failed attempt, replacing its failed jobs), `failures.recordPassedRun` (a newer attempt passed; FLAKY once every run of an undispatched failure passed), `failures.closeWindow`, `failures.findBySha`; members get `failures.get`. Every write records its audit entry; the cross-org and audit meta-tests cover all five; the ESLint guard includes the new tables. Concurrent deliveries for one commit are normal (several workflows fail together): inserts use `ON CONFLICT DO NOTHING` and read the row back, so they converge on one failure and one row per run.
  - **Processor** (`apps/worker/src/queues/workflow-runs.ts`): SPEC §2 step 4's filters, cheapest first: action `completed`; not from a fork (repository IDs, fails closed when GitHub omits the head repository); not a `pipeheal/*` branch; not the healer workflow (`HEALER_WORKFLOW_PATH`); org active; repo enabled and still installed; workflow selected. A failed or timed-out run is recorded with its failed jobs (`listFailedJobs` for that attempt). A passing or cancelled run only matters to a failure of the same commit, so a green commit costs no GitHub call at all.
  - **Workflows added later** (the CHECKPOINT 2a gap): a run from a workflow we don't know re-syncs that repo's workflows first, with the CI-looking pre-selection, then applies the "selected" filter. The per-repo sync moved to `workflow-sync.ts`, shared with the installation sync.
  - **Collection window**: a delayed `close-window` job on the new `failures` queue at `windowClosesAt` (job ID per failure, so a retried delivery can't queue it twice), and an early close once every watched run of the commit has completed (`listRunsForSha`, checked on each failed run and on each completed run of a commit with an open failure). Runs attached after it closed are `lateArrival`.
  - **Per-installation pacing** (`apps/worker/src/pacing.ts`): the App client reports each response's `x-ratelimit-remaining`/`reset` per installation (`onRateLimit`), kept in Redis until the reset. A webhook job for an installation below 200 remaining (or one GitHub rate-limited: `GitHubApiError.retryAt` from `retry-after`, an exhausted quota's reset, or a minute for a secondary limit) is moved to BullMQ's delayed set until then: not a failure, no attempt spent, delivery neither failed nor processed. Other installations run as usual. 429 is no longer retried at once by octokit's retry plugin.
- Tests: 763 in total. DB: every §2.1 behavior (one failure per commit, attach, redelivery/older attempt ignored, newer failed attempt replaces jobs, FLAKY only when all passed and nothing dispatched, late arrivals, window closes once, four workflows failing at once open one failure, the same delivery twice at once records one run, malformed runs rejected). Worker, against Postgres and msw's GitHub with unmocked calls failing the test: recording with failed jobs and the window timer; early close; FLAKY via re-run; timed out; discovery of a new CI-looking workflow (watched) and a release workflow (not); unwatched workflow ignored; forks, missing head repo, `pipeheal/*`, healer, unfinished runs, green commits, disabled repo, suspended org, unknown installation all ignored without a GitHub call; a rate-limited installation pauses without failing the delivery; a paused installation isn't started. `failures` queue and pacing against real Redis/BullMQ, including a paused installation's job ending up delayed with no attempt spent while another installation's job completes. Mutation-checked: without the fork filter, the fork test fails.
- Bug found and fixed on the way: an error from the installation-token fetch a call triggered was converted to `GitHubApiError` twice, the second time from an error without response headers, losing GitHub's message, the real route and `retryAt`. A `GitHubApiError` now passes through the outer request's error hook unchanged.
- Decisions:
  - `windowClosedAt` added next to SPEC's `windowClosesAt`: the window can close early, and "late arrival" is defined by when it actually closed.
  - `timed_out` counts as failed (SPEC §2 says `conclusion=failure`): it's still something to diagnose (likely `infra`, SPEC §6.1, non-healable by default). `cancelled`, `skipped` and the rest only count toward closing the window.
  - FLAKY applies while nothing was dispatched: statuses `DETECTED`, `TRIAGED`, `SKIPPED`, `NEEDS_SETUP`. `QUEUED` onward is left to the dispatcher (P4.8) to reconcile.
  - The window closing triggers nothing yet: triage (P2.2–P2.4) will start from the `failures` queue once the window has closed.
- Follow-ups:
  - Not yet seen live: with `pnpm dev` and `pnpm dev:webhooks` running, push a scenario (e.g. `pnpm break node/type-error --repo ..\pipeheal-demo-node --push`); the failure should appear in `PipelineFailure` within about a minute.
  - `GitHubApiError.route` for paginated calls is the full URL (owner/repo names and query) rather than the route template (pre-existing, P1.4): no secrets, but inconsistent with the "template only" intent.
  - A run from a workflow `listWorkflows` never returns (some dynamic workflows) re-syncs the repo's workflows on each such run; bounded by pacing, cacheable if it shows up.

## 2026-09-29 · P2.1 live check

- `pnpm break node/type-error --repo ..\pipeheal-demo-node --push` on the sandbox org, with the real App, smee relay and dev servers: CI failed 23 s after the push, and within about 1.5 s PipeHeal had one `PipelineFailure` for the branch's commit (`DETECTED`), its `CI` run, the failed job `check` at step **Typecheck**, the window closed early (CI was the only watched workflow), and `failure.detected` / `failure.window_closed` in the audit log. The `requested` and `in_progress` deliveries were processed and ignored.

## 2026-09-29 · P2.2 · Log fetch, clean and redact

- Done:
  - **`packages/agent-core`** (pure, no I/O): `cleanLog` (GitHub's line timestamps, CSI/OSC terminal escapes, `##[group]`/`##[endgroup]` markers dropped with titles kept, `##[error]`/`##[warning]` kept for the error window, CRLF, carriage-return progress lines reduced to their last state, BOM, lines capped at 2,000 characters with a note of how much was cut) and `redactLog` (SPEC §6.2 step 3). Rules, most specific first, each replacement naming its kind (`[redacted:jwt]`) so triage still knows what was there: private key blocks (PEM and PGP, and to the end of a log cut off inside one), credentials in URLs (the user stays, the password or a bare token goes), `Authorization` headers and `Bearer`/`token` credentials (only with a digit, so "token validation failed" stays), JWTs, GitHub tokens, API keys (Anthropic/OpenAI `sk-`, npm, Slack, Stripe, Google), AWS access key IDs, secret-named assignments (`KEY=v`, `key: v`, `"key": "v"`, `--key=v`; never `::` pytest IDs, masked `***`, small numbers or values already redacted), and high-entropy strings (32+ characters mixing upper, lower and digits, Shannon entropy ≥ 4.3 bits/char: hex digests, long identifiers and paths stay). `redactText` from `@pipeheal/shared` runs last as a backstop, with the markers shielded so it can't flatten them.
  - **Triage start** (`apps/worker`): the window closing (early close in the processor, or the delayed `close-window` job) queues a `triage` job on the `failures` queue; a run attached after the window closed (late arrival or newer failed attempt) queues its own, keyed by run and attempt. `triage` downloads each not-yet-triaged failed job's log (`downloadJobLog`, tail up to 5 MB), cleans and redacts it, and stores it as `FailedJob.errorWindow` via the new `failures.recordJobTriage` (audit: `failure.job_triaged` with redaction counts only). A log GitHub no longer has (404/410) is stored as an empty window. Triage calls GitHub, so its jobs are paced per installation exactly like webhook jobs (the delay-on-rate-limit wrapper and pause checks moved to shared helpers in `pacing.ts`).
  - The stored window is provisional: the tail of the failed step, up to its last `##[error]` line (post-job steps like checkout's cleanup follow it in the job log), capped at 300 lines (SPEC §6.2 step 4). P2.3's extractor replaces it with the real window and signals; nothing downstream depends on the provisional form.
- Verified live on the sandbox: `python/lint`, then `python/type-error` pushed with `pnpm break`. Each failure was detected, its window closed early and its job log triaged within 15–30 s of the push; the stored window for the **Typecheck** step ends exactly at mypy's two `attr-defined` errors and `##[error]Process completed with exit code 1.`. The first live run found two things the fixtures hadn't, both fixed with regression tests: the window was the job's last 300 lines, mostly checkout's post-job cleanup, with ruff's `I001` above it (now cut at the failed step's `##[error]`); and `persist-credentials: true` (an actions/checkout input) was redacted as a secret assignment (boolean-like values are now left alone).
- Tests, written first for agent-core: a fixture Actions log (timestamps, colors, groups) with a planted fake of every SPEC §6.2 type in the forms CI really prints them (git remote URLs, `export`, `.env` lines, `aws_secret_access_key =`, a Postgres URL, an ADO.NET connection string, a `curl -H "Authorization: Bearer …"`, a JSON config, YAML, a JWT, an Anthropic key, a bare random signing secret, an OpenSSH private key). The fakes are generated at test time from a seeded PRNG, so nothing secret-shaped is committed. Every secret is gone, down to any 12-character slice; every kind is counted; errors, exit codes, SHAs, hosts and harmless config survive; output is idempotent. A second fixture of real, secret-free test/typecheck/lint output (vitest, pytest, mypy, tsc, eslint, npm, stack traces, UUIDs, digests, paths, "token"/"password" in prose) passes through unchanged. Per-rule cases, a truncated key block, PGP blocks, the backstop catching a pre-signed URL signature, and a 5 MB log plus pathological input under 3 s. Coverage 100% lines/functions, 97.8% branches. Worker, against Postgres and msw's GitHub (API and log storage): close-window closes and queues triage; triage stores the redacted window (the planted token appears nowhere in rows or audit), keeps the last 300 lines of a long log, doesn't re-fetch a triaged job, stores an empty window for a missing log, waits without a GitHub call while the installation is paused, pauses it when the log download is rate-limited; the processor queues triage on the early close and under its own key for a late run. Full suite 823/823.
- Decisions:
  - Typed markers (`[redacted:kind]`) rather than a bare `[redacted]`: the kind is useful to triage ("a token was here") and reveals nothing.
  - A URL's username is kept (`x-access-token`, `default`): it's rarely secret and helps diagnosis; a bare token used as the username is caught.
  - `=` counts toward a high-entropy candidate only as trailing base64 padding, so `NAME=value` is judged value by value and the name stays readable.
- Follow-ups:
  - The P2.1 live-check failure (`break/type-error-…`) closed its window before triage existed, so it has no error windows; new failures do.

## 2026-09-29 · P2.3 · Error window and signal parsers

- Done:
  - **Real log fixtures** (`packages/agent-core/fixtures/logs/`, with a README of where each came from): 12 unedited Actions job logs downloaded with the App from the sandbox demo repos after pushing scenarios, covering tsc (TS2305, TS2304, TS2307), ESLint, Vitest (5 failures), `npm ci` (lockfile out of sync), ruff (I001, F821), mypy (`attr-defined`, `import-untyped`), pytest and pip (no matching version). Two of those came from branches pushed only for this (`ci/add-dayjs`, `ci/bump-pytest`: install errors aren't eval scenarios). No demo uses Jest, so the Jest sample is real Jest 30 output from a local run (no Actions framing). All scanned for secrets before committing.
  - **`failedStepLog`**: the failed step from the *raw* log (it needs GitHub's step markers, which `cleanLog` removes): its command (`Run npm test`), then its output after GitHub's header (command echo, `shell:`, `env:`), through the step's final `##[error]`. Post-job steps are left out.
  - **`extractErrorWindow`** (SPEC §6.2 step 4): the whole step when it fits in 300 lines (every real sample does: 10–130 lines); otherwise the command, the lines around each failure report (SPEC's anchors plus each tool's error format), in order while they fit, and the step's last 40 lines, with `… N lines omitted …` markers.
  - **`extractSignals`** (SPEC §6.2 step 5): one pass, a parser per tool: tsc (paren, pretty and location-less forms), ESLint stylish, Vitest (tests, load failures, `❯` locations), Jest (`FAIL` file, `●` tests, stack locations outside `node_modules`), pytest (`FAILED`/`ERROR` summaries, `file:line: Exception` locations), mypy (with its `[code]`), ruff (full and concise formats), npm (`code` plus its message lines) and pip (`ERROR:` lines). Output: `diagnostics` (tool, severity, code, message, path, line, column), `failingTests`, `locations`, `errorCodes`, `tools`, `exitCode`, `failedStep`, each list capped at 50 and de-duplicated. Paths become repo-relative POSIX (Linux, Windows and container runners). Problem-matcher `##[error]` prefixes on tool lines are stripped first.
  - **`triageLog`** chains them: raw log → failed step → clean → redact → window and signals, so signals are parsed from redacted text only. The worker's triage now uses it and stores `FailedJob.signals` (validated by a bounded `jobSignalsSchema` in `packages/db`) next to the window; P2.2's provisional tail is gone.
- Tests (agent-core written first, against the fixtures): per real log, the exact window boundaries (starts with the command, ends at the step's `##[error]`, no header or post-job noise, ≤ 300 lines) and the expected tools, error codes, failing tests, locations, exit code and a key message; Jest's output; each tool's other forms (ruff concise, location-less tsc, Vitest load failure, pytest summaries with and without messages and collection errors, npm code without message); path normalization; ESLint warnings vs errors; caps and de-duplication; a long step windowed within the cap; redaction before parsing. Coverage 100% lines/functions, 99.5% branches. Worker integration: triage stores the window and signals (tsc, TS2305, location, exit code, failed step) with the planted token redacted. Full suite 869.
- Found by looking at real output rather than trusting green tests: Vitest interleaves info lines ("Isolate … workers spawned") into failure blocks, and the first version took one as a failed test's message. Now only an error-shaped line (`…Error`, `…Exception`, `expect(`, `thrown:`) within the next few lines counts; pinned by a regression test on the real log.
- Verified live: `node/logic-bug` pushed, and 35 s later the Test job's signals were stored: 5 failing tests by full ID, 5 locations, 5 assertion messages, a 127-line window.
- Decisions:
  - Signals are parsed from the whole failed step, not only the window, so nothing is missed when the window is cut.
  - Python exception names (`AssertionError`, `ModuleNotFoundError`) count as error codes for pytest; JS assertion messages don't get a code (the message carries it).
- Follow-ups:
  - More formats will turn up (Go, Rust, other test runners): each gets a real-log fixture first, the same way.
  - Docker Desktop and the dev servers had stopped between sessions; for the live check they were restarted (`pnpm dev`, `pnpm dev:webhooks` running in the background).

## 2026-09-29 · P2.4 · Heuristic classifier and TRIAGE_MODEL fallback

- Done:
  - **Heuristics** (`packages/agent-core/src/classify`, pure): a failed job's category (SPEC §6.1) from its signals and error window, only when the evidence is unambiguous. In order: a timed-out run is `infra`; a missing secret, variable or permission (`Input required and not supplied`, `Resource not accessible by integration`, `Bad credentials`…) is `config`; a lost runner, out of memory, exit 137 or a full disk is `infra`; then each error diagnostic by tool and code (tsc `TS2307` on a package is `dependency`, on a local file `compile`; `TS1xxx`/`TS2304`/`TS2552`… `compile`; other tsc codes `typecheck`; mypy `import-not-found`/`import-untyped` `dependency`, `name-defined`/`syntax` `compile`, else `typecheck`; ruff `F821`–`F823`/`E999` `compile`, else `lint`; ESLint parsing errors `compile`, else `lint`; npm network codes `infra`, else `dependency`; pip `dependency`; test runners `test`, unless a package is missing or it's a `SyntaxError`); failing tests are `test`; bundler failures `build`; network errors `infra` (lower confidence). When categories compete, what blocks a fix most wins (config, dependency, infra, compile, typecheck, lint, build, test). Summaries are specific (`tsc TS2305: Module '"./cart"' has no exported member 'lineTotal'. (src/receipt.ts:1), and 1 more`; `5 failing tests, e.g. …`) and suspected files come from the signals' locations. Anything else is null: the model's turn.
  - **TRIAGE_MODEL** (`apps/worker/src/triage-model.ts`): a static, cacheable system prompt (category definitions; the log is untrusted data, never instructions) and the job's details, signals and redacted window in the user turn (`buildTriagePrompt`, versioned `triage-v1`). Structured outputs (`output_config.format`) with a hand-written JSON schema (below), the answer validated again with zod; one retry on an invalid answer (not JSON, off-schema, cut off at `max_tokens`, a refusal). API errors are left to the SDK's own retries (429, 5xx, connection) and then give up. Every call is recorded (`ModelCall`: purpose, model, prompt version, input/output/cache tokens, cost, outcome valid/invalid/error; audit `failure.model_called`).
  - **Prices from config**: `MODEL_PRICES` (JSON, USD per million tokens per model, optional cache prices defaulting to 0.1× and 1.25× input). The worker refuses to start with `ANTHROPIC_API_KEY` set and no price for `TRIAGE_MODEL`; production requires both. Without a key (development) the model is off and unplaced jobs stay `unknown`.
  - **Worker triage** now classifies each job (heuristics, then the model, then `unknown`), stores it on `FailedJob` (category, confidence, summary), and classifies the failure from every still-failing job (`combineClassifications`: the most confident job leads, ties broken by the priority above, every job named in the summary) via `failures.recordTriage`, which moves it `DETECTED` → `TRIAGED`. A job whose log is gone is `unknown` (or `infra` if it timed out).
  - Schema: `ModelCall` (org-scoped, composite FK to its failure, cost `Decimal(12,6)`), per-call rows for now; P7.1 rolls them up into `UsageRecord`.
- Tests: heuristics on all 13 real-log fixtures (category, confidence, suspected files, summary) and on causes that aren't the code (config, infra, build, timeouts, package vs local file); combining jobs; the prompt (static system, log in the user turn, every category named, versioned); the output schema, zod and JSON schema agreeing. The model client through msw with Messages API-shaped responses: a valid answer and its recorded tokens and cost, the request's schema (the category `enum` present) and no `thinking`; a retry after an off-schema answer; giving up after two invalid answers (not JSON, `max_tokens`, refusal); an API error recorded once and not retried; cost with cache tokens; the API's error detail. Env: prices parsed, refused without a price, bad JSON, a price missing a field or negative, production requirements. DB: `recordModelCall` and `recordTriage` in the cross-org and audit meta-tests, plus behavior. Worker integration: heuristics classify and the failure becomes `TRIAGED`/`TYPECHECK` with no model call; an unclear log goes to the model with the redacted window (the planted token never reaches it), and the call is stored with its cost; no model, or no answer, leaves it `unknown`. Full suite 928.
- Live check (sandbox, `live/unclassified-…` branch on the node demo: a custom API-surface check that fails with a plain message): detected, window closed early, heuristics returned nothing, and the model was called within 3 s of CI failing. The API answered **400**: the configured key isn't scoped to a workspace. Everything around the call behaved as designed (one `ModelCall` row, outcome `error`, zero tokens, no retry; job and failure `unknown`). The warning now includes the API's error type and message; the first version logged only the status, so diagnosing this took a manual request. **A real classification is still to be seen**, once the key is replaced by one from the dedicated dev workspace (SPEC §7.5); then re-running the failed job re-triages it.
- Decisions:
  - The structured-output schema is written out (`TRIAGE_OUTPUT_JSON_SCHEMA`) rather than generated by the SDK's `zodOutputFormat`, whose conversion in 0.128.0 turns `enum` into a description; enum is supported by structured outputs and is the one constraint worth enforcing at generation. Bounds and lengths aren't supported there, so zod enforces them after. A unit test keeps the two schemas in step.
  - Answers are validated by hand rather than with `messages.parse()`, which throws on an invalid answer and loses its token usage (every call must be costed).
  - No `ANTHROPIC_WORKSPACE_ID` header support: SPEC §7.5 wants a key scoped to its own workspace (with its spend limit), so the fix is the key, not a header.
  - Suspected files aren't stored yet (no column); the healer (Phase 4) reads them from the signals.
- Follow-ups:
  - Replace the Anthropic key with a workspace-scoped one, then re-run the failed job on the `live/unclassified-…` branch to see a real classification and its cost; delete the branch after.

## 2026-11-25 · Resuming after the break

- Fresh checkout: `node_modules` was missing (`pnpm install --frozen-lockfile`), Docker Desktop was stopped (started it). Typecheck, lint, 928 tests green before any change.
- On a fresh checkout `pnpm lint` reports ~20 errors until `pnpm typecheck` has generated Next's route types; CI runs typecheck first, so it's only a local ordering quirk.
- The first `pnpm test` right after Docker started had one timeout (`maintenance.int.test.ts` › Redis up through the gateway health check, 5.8 s against Vitest's 5 s). It passed alone and in a second full run. Noted, not chased: it hasn't recurred.
- SPEC §4.2 drift since 2026-09-27: `@anthropic-ai/sdk` went 1.0 (2026-10-21, now 1.14; we pin 0.128); ioredis 6.1 is out (5.11 stays until the shutdown hang is re-tested). TypeScript 6.0 (typescript-eslint still `<6.1`) and Prisma 7.10 (8.0 still RC) still hold. **Open for Malek:** stay on SDK 0.128 or move to 1.x.

## 2026-11-25 · P2.5 · Last-green resolver and recent changes

- Done:
  - **`packages/agent-core/src/changes`** (pure, tests first): `selectRecentChanges(comparison, { priorityPaths, tokenBudget })`.
    - Ordering: files the signals name (also by a renamed file's old path), then other files, then lockfiles and build output (`dist/`, `vendor/`, `*.min.js`…); within each, files with a text diff first, smaller changes first.
    - Budget (default 12,000 tokens, 1 token ≈ 3.5 characters, erring high): commit subjects get at most a fifth. Named files get as much of their diff as fits, cut at hunk boundaries (or the first lines of a single huge hunk). Then every other file's name and line counts while they fit, then their diffs whole while they fit. What's left out is counted (`omittedCommits`, `omittedFiles`, `patchState: omitted`). Never exceeds the budget (tested across budgets from 150 to 50,000).
    - Every diff and commit subject goes through `redactLog` before it's measured or stored.
    - `signalPaths` (files from locations, diagnostics and test IDs) and `renderRecentChanges` (the text form for prompts and the UI).
  - **`packages/github`**: `listSuccessfulRuns(workflowId, branch, limit)`, one page, forks dropped.
  - **Base resolution** (`apps/worker/src/queues/recent-changes.ts`), per failing workflow:
    - the workflow's last green runs on the same branch, then on the default branch (up to 10 candidates, at most 3 comparisons per branch);
    - a candidate counts only if `compare(green...head)` is `ahead` or `diverged`: the failing commit itself, a later green commit (`behind`), `identical`, or a commit GitHub no longer has are skipped;
    - three-dot comparisons start at the merge base, which covers SPEC's "merge base" fallback for a diverged branch;
    - no green run at all: the default branch's tip as base (the branch's own changes since it forked); nothing found is stored as `{ base: null, reason }`;
    - several failing workflows: the comparison with the most commits wins, so it covers every workflow's changes.
  - **`recent-changes` job** on the `failures` queue, queued by triage after it has classified the jobs (one job per failure; resolved once). Paced per installation like triage. Kept separate so a slow or failing comparison never holds up classification, and retries on its own.
  - **`packages/db`**: `PipelineFailure.recentChanges` (JSON, migration `20261125161329_recent_changes`), validated by `recentChangesRecordSchema` (bounded commits, files, patch sizes; run ID as a digit string since JSON has no BigInt); `failures.recordRecentChanges` with audit `failure.recent_changes` (base, counts, redaction counts; never diffs or messages), in the cross-org and audit meta-tests. `jobSignalsSchema` is exported for reading stored signals.
- Tests: agent-core 16 (ordering, renames, hunk cuts, huge hunk, names without diffs, dropped files, commit share, redaction, budget property, rendering); GitHub client 2; DB 3 (meta-tests and validation); worker integration 11 against Postgres and msw's GitHub (triage queues it, same branch with a later green and a fork run skipped and a planted token redacted, default-branch fallback, merge base, no base, unusable candidates and the comparison cap, widest of two workflows, resolved once, paused installation). Mutation-checked: accepting a `behind` comparison as a base fails two tests. Full suite 959.
- Decisions:
  - Diffs and commit messages are redacted with the log redactor (SPEC §15 had this as "likely" for Phase 4; it's needed as soon as the diff is stored). The high-entropy rule also blanks lockfile integrity hashes, which are noise anyway.
  - Recent changes belong to the failure (one commit), not to each run.
- Follow-ups:
  - Not seen live yet: push a scenario on a demo repo with the dev servers running and check the stored `recentChanges` (part of CHECKPOINT 2b's acceptance run).
  - Token estimate is a character heuristic; Phase 4 can switch to the API's token counting if prompts get close to their limits.

## 2026-11-25 · P2.6 · Flaky check

- Done:
  - **`flaky-check` job** (`apps/worker/src/queues/flaky-check.ts`) on the `failures` queue, queued by every triage (the window's, and each late run's under its own key). For a `TRIAGED` failure, each failed or timed-out run not re-run yet gets `rerun-failed-jobs` (never the whole run), when:
    - its workflow is still selected for the repo;
    - `environment:` appears neither in the cached `RepoWorkflow.usesEnvironment` nor in the workflow file **at the failing commit** (a branch can add one); an unreadable or unparseable file means no re-run (fail closed); finding one sets the cache;
    - `retryBeforeHeal` is on (`FlakyCheckDeps.retryBeforeHeal`, default on until the policy engine supplies it, noted in P3.8).
  - **At most once per run**: `failures.claimRerun` claims the run atomically (`rerunByUs`, and the new `FailedRun.rerunFromAttempt`, migration `20261125…_flaky_rerun`) before GitHub is asked, with audit `failure.rerun_requested`. A retried job, or GitHub refusing the re-run, never leads to a second request: the claim stays (a refusal is logged, and the failure goes on without a flaky check).
  - **The result** arrives as the run's next attempt through P2.1's paths: passing → `recordPassedRun` (its audit now says `rerunByUs`), FLAKY once every run of the failure passed; failing again → `recordFailedRun` replaces the jobs and they're triaged again (that triage's flaky check finds the run already claimed). The re-run is pending while `runAttempt` still equals `rerunFromAttempt`; P4.8's dispatcher waits on it.
- Tests: DB (claim once, concurrent claims give one, run_passed audit carries `rerunByUs`, a passed run can't be claimed; cross-org and audit meta-tests); worker integration 11 against Postgres and msw's GitHub (queued by triage under its key; re-run once with the file read at the failing SHA and the claim audited; environment at the failing commit blocks and is cached; cached environment, unwatched workflow, unreadable file, non-workflow YAML; only TRIAGED; `retryBeforeHeal` off; refused re-run keeps the claim and isn't retried; the re-run passing makes it FLAKY; paused installation). Mutation-checked: ignoring `environment:` at the failing commit fails its test. Full suite 974.
- **For Malek (deviation candidate):** SPEC §6.2 step 8 re-runs failed jobs whatever the category, so a deterministic failure (typecheck, lint, compile, a missing secret) also spends a re-run before healing. Implemented as specified; restricting re-runs to `test`, `infra` and `unknown` would save customer CI minutes and time to a fix. Your call.
- Follow-ups: a re-run that never reports back is left to the §2.2 reconciler (Phase 5).

## 2026-11-25 · P2.7 · Failures list and detail pages

- Done:
  - **`/[org]/failures`**: newest first, 25 a page with an "Older" link, filters by repository and status (a GET form, no client JS). Each row: repository, branch, short SHA, status, category and confidence, summary, number of runs, time. "Failures" link in the org header.
  - **`/[org]/failures/[id]`**: status, category, confidence, summary; each failed run (attempt, conclusion, "re-run by PipeHeal", late arrival, link to GitHub) and each job (failed step, category, summary, signals: failing tests, locations, error codes, tools, exit code; and the error window); then the recent changes (base and how it was found, commits, each file with its status, counts, named-in-the-failure mark, and its diff or why it isn't shown). Error windows and diffs (already redacted) render as text in `<pre>`, never as markup. Unknown or malformed IDs and other orgs' failures give 404 (`requireOrgMember` + org-scoped helpers).
  - **`packages/db`**: member-scoped `failures.list` (paged by UUIDv7 ID like the audit log, filters validated by `failurePageSchema`), with its cross-org case and in the read-only list; `failureStatusSchema` and `recentChangesRecordSchema` exported.
  - **`apps/web/src/lib/failures.ts`**: URL filters (malformed values dropped, never an error), stored signals and recent changes re-validated with the db schemas on read, small formatters.
  - **Seed**: `pnpm db:seed` now adds a triaged typecheck failure on `pipeheal-demo/demo-node` (job, error window, signals, recent changes; negative GitHub IDs), so the pages can be seen without pushing a broken commit.
- Tests: db (paging, filters, member access, cross-org); web helpers 11; seed 1; e2e: signed-out redirect for both pages. Rendered for real on a dev server with a throwaway database, a seeded failure and a real Better Auth session (sign-in through mocked GitHub): list, detail with signals, error window and diff, filters, 404s; no server errors. Full suite 988; e2e 12.
- Fixed on the way (separate commit): e2e couldn't start since production began requiring `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` and `REDIS_URL`; the Playwright web server now gets throwaway values for them. CI's e2e job has likely been red since then (CI on PR #3 to confirm on the next push).
- Local note: this machine's cached Chromium (1228) is older than Playwright 1.63 wants; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` pointing at it works (as in P1.6).

## 2026-11-25 · End of Phase 2 · Security review fixes

- `security-reviewer` on Phase 2 (70351ea..8570cbd): 3 high, 4 medium, 3 low. It reproduced H1 and M2 with scripts; I re-ran both before fixing.
- Fixed:
  - **H1: triage output could break the db schema** (a step name over 255 characters, a 578K-character window, a 1,500-character test ID, a path over 500, a line number above 2^53). `recordJobTriage` then threw, the job retried five times (re-downloading the log and re-calling the model), and the failure's other jobs were never reached. Now `triageLog` bounds every field to the db's limits in one place (`agent-core/src/triage/bounds.ts`, `TRIAGE_LIMITS`; the window keeps its start and end within 60,000 characters). A job whose triage still doesn't fit is stored as `unknown` instead of blocking the rest. A worker test runs adversarial logs through `triageLog` and the db's own schema.
  - **H2: unbounded TRIAGE_MODEL spend.** The prompt is capped (40,000 characters of log, 16,000 of signals). A failure gets at most 8 model calls, retries included, counted from its `ModelCall` rows (new read-only `failures.modelCallCount`); past that, unclear jobs stay `unknown`. A monthly per-org budget is noted in P7.1.
  - **H3: a flaky re-run could deploy.** `rerun-failed-jobs` also re-runs the jobs depending on the failed one, so a test job followed by a `needs:` deploy job, or a call to a reusable deploy workflow, would ship. `rerunRisk` now checks the whole workflow file: no `environment:`, no job-level `uses:`, no deploy/release/publish-like job ID or name. It checks both the failing commit's copy and the default branch's (a `pull_request` run executes the merge). This narrows SPEC §6.2 step 8, so SPEC is updated.
  - **M1: untrusted trigger events.** `pull_request_target`, `workflow_run` and comment-triggered runs have the base repo as their head repo while possibly running fork code. Intake now accepts only `push`, `pull_request`, `merge_group`, `schedule` and `workflow_dispatch` (SPEC §2 step 4), and `rerunFailedJobs` refuses any other event.
  - **M2: CPU on adversarial logs.** The URL-credential patterns (agent-core and `@pipeheal/shared`) started a scheme at every character of an `a.a.a…` run (6.4 s for 5 MB, now 0.18 s, using a lookbehind instead of `\b`). The ESLint row pattern took 0.86 s per 0.5 MB, now 0.01 s, with the rule ID split in code. The new performance test then caught a third pattern, Vitest's FAIL row with brackets (1.5 s), fixed the same way. All three shapes are now in the tests (under 1.5 s for 5 MB).
  - **M3: redaction gaps.** Added GitLab `glpat-` and Docker `dckr_pat_` tokens, Slack and Discord webhook URLs (new kind `webhook-url`), the key names `pass`/`passphrase`, `cookie`, `dsn` and specific `*_key` names (signing, account, master, encryption, client, app, deploy, ssh). URL passwords containing `@` are now redacted fully. Long lines are cut after redaction (a cut could split a secret below the rules' minimum length; mutation-checked).
  - **M4: prompt injection.** Workflow, job, step, signals and log now all sit inside one `<job>` block labelled untrusted, and any closing `</job>` variant (case, spacing) is escaped. The model's confidence is capped at 0.75, below every heuristic's (lowest 0.8), so a log can't make the model outrank a heuristic `config` or `infra` job. Prompt version `triage-v2`.
  - **L1:** the flaky check also requires an active org and an enabled, installed repository.
- **Deliberately not done, known limits:**
  - hex-only secrets and base64 secrets under 32 characters (indistinguishable from SHAs and digests without context);
  - bare `auth` and `key` key names (they would blank `author:` lines and every cache `key:`);
  - unquoted values with spaces (only the first word is redacted).
  GitHub already masks registered secrets; these are the unregistered remainder.
- Low, noted: completed runs of a commit with an open failure each call `listRunsForSha` (bounded by pacing); filenames and branch/job names are stored unredacted (metadata).
- Verified: typecheck, lint, format, 1,037 unit+integration tests, agent-core coverage 96.1% branches.

## 2026-11-25 · D11 · Self-hosted models on Ollama replace the Anthropic API

- Malek's decision: no Anthropic key. Open-weight models run on Ollama on the application's own host (Intel i5 10th gen, RTX 3060 12 GB, 16 GB RAM), for triage and healing, in development and production. In development, Ollama is on that other machine and the worker reaches it over the LAN.
- Model: `qwen3:14b` (Apache 2.0) for both `TRIAGE_MODEL` and `HEAL_MODEL`. It's the newest model in Ollama's library with tool calling at a size that fits 12 GB at Q4 (about 9 GB). One model for both avoids swapping. Newer Qwen coders start at 30B (about 19 GB at Q4, doesn't fit). Alternative: `qwen2.5-coder:14b`.
- Done:
  - `apps/worker/src/ollama.ts`: a small client for `/api/chat` (non-streaming) and `/api/show`, using `fetch` and zod (no SDK). Calls run one at a time (one GPU), with a 180 s timeout. Errors carry Ollama's status and short message, never the prompt.
  - `triage-model.ts` on Ollama: the JSON-schema-constrained answer (`format`), `think: false`, `temperature: 0`, a 12K-token context. An answer cut off (`done_reason: length`) counts as invalid; zod validation and the one retry stay. Tokens come from Ollama's counts; cost is recorded as 0.
  - Prompt caps lowered to fit that context: 24,000 characters of log and 8,000 of signals (about 10K tokens). At 16K tokens, the KV cache (about 2.6 GB) plus the weights would fill the card.
  - Env: `OLLAMA_URL` (default `http://localhost:11434`; production requires it explicitly, https unless loopback) and `TRIAGE_MODEL` (an Ollama tag, default `qwen3:14b`). `ANTHROPIC_API_KEY` and `MODEL_PRICES` are gone, along with `model-prices.ts` and the `@anthropic-ai/sdk` dependency (which also settles the SDK 1.x question). The worker checks at startup that the model is pulled and only warns, so triage goes on if Ollama is down: calls fail, are recorded, and unclear jobs stay `unknown`.
  - Docs: SPEC §3, §4, §4.2, §7.5, §12, §13, §15 and D11 (D6 superseded); CLAUDE.md's stack line, and its invariant now reads "the model server is internal only"; PLAN P4.4 (tool calling and context sizing on Ollama) and P7.1 (per-org GPU-time share instead of spend); `.env.example`.
- Tests: Ollama client 5 (one call at a time, recovery after a failure, error without the prompt, timeout, model pulled or not); triage on Ollama 8 (request shape: schema, `think`, context, temperature; confidence cap; retry; invalid and cut-off answers; error answer, unreachable server, unexpected body); env 4. Full suite 1,037.
- Not verified live: Ollama runs on another machine and this one can't reach it yet (see below).
- For Malek, on the Ollama machine:
  - `ollama pull qwen3:14b`;
  - for development over the LAN, make Ollama listen beyond localhost (`OLLAMA_HOST=0.0.0.0`) with the firewall allowing only your LAN, and put `OLLAMA_URL=http://<that machine's LAN IP>:11434` in this machine's `.env`;
  - optionally `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`, which roughly halve the context's memory.
  - In production the app runs there and uses `http://localhost:11434`; Ollama should then listen on localhost only.

## 2026-11-25 · CHECKPOINT 2b · Acceptance run deferred

- Malek is downloading `qwen3:14b` on the Ollama machine and asked to keep developing. The CHECKPOINT 2b acceptance run (each `pnpm break` scenario detected, classified, with recent changes and a flaky check; no planted secret anywhere) needs that model and the dev servers, so it stays open, unticked in PLAN, and comes back once `OLLAMA_URL` points at the model.
- Open decision kept as specified until Malek says otherwise: flaky re-runs for every category (SPEC §6.2 step 8), not only `test`, `infra` and `unknown`.

## 2026-11-25 · P3.1 · Policy rules schema, defaults, invariants

- Done (`packages/policy`, pure; tests first):
  - `policyRulesSchema`: SPEC §8.3 in zod. Every missing value gets its default, through factories so parsed policies never share arrays. `DEFAULT_POLICY` is the frozen result of parsing `{}`.
  - `policyLayerSchema`: one layer exactly as written, no defaults, for P3.3's merge to tell "set" from "left alone".
  - Both share the same field rules and are strict: an unknown key is an error (a typo silently ignored could leave a rule looser than meant).
  - Globs must be repository-relative POSIX: no leading `/` or `./`, no `..`, no backslash, no control characters, at most 300 characters and 200 per list. Matching semantics are P3.4's.
  - Limits are integers from 1 up to plan maximums (`LIMIT_CAPS`, INV-CAPS): 50 files, 2,000 lines, 5 attempts, 30 iterations, 2,000,000 model tokens, 25 minutes (the healer job times out at 30).
  - Custom rules: `CR-n` IDs, unique; a `code` rule must carry its compiled form (a layer, without custom rules of its own), and a `judge` rule must not; at most 50.
  - `scope.categories` accepts only SPEC §6.1's healable categories (`HEALABLE_CATEGORIES`).
  - `INVARIANTS` (the seven of §8.2) and `INVARIANT_PATHS` (INV-GITHUB-DIR and INV-SECRETS globs), deep-frozen. Their checks are P3.4's.
- Decisions:
  - **D12 (Malek):** `maxCostUsdPerAttempt` becomes `maxModelTokensPerAttempt` (default 300,000). With self-hosted models a dollar cap never triggers.
  - Mine, recorded in SPEC §8.3:
    - default `scope.branches`/`scope.workflows` include is `**`, since SPEC's `*` wouldn't match `feature/x` under glob rules;
    - `Dockerfile*` and `docker-compose*` become `**/Dockerfile*` and `**/docker-compose*`, to match anywhere as clearly intended;
    - `review` defaults `requestCommitAuthor: true` and `draftBelowConfidence: "low"` ("draft when confidence is at or below"), which SPEC hadn't defined.
- Tests: 26 policy tests, coverage 100%. Mutation-checked: a loose (non-strict) object and a missing code-rule check each fail a test. Full suite 1,063.
- `policy-red-team` not run for this task: there's no engine to attack yet (only the schema). It runs in P3.6, after the checks exist.
- Still open for P3.3 (SPEC §8.1/§15): split org *defaults* from org *guardrails* before writing the merge.

## 2026-11-25 · P3.2 · Diff model

- Done (`packages/policy/src/diff.ts`, pure; tests first):
  - `buildChange({ path, oldPath?, old, new })` builds `Change { path, oldPath, status, oldKind, newKind, isBinary, modeChanged, oldContent, newContent, hunks, addedLines, removedLines }` from full contents.
    - Each side is `absent`, `text` (content and mode), `binary`, `symlink` or `submodule`, as the GitHub client reports files. `oldKind`/`newKind` give INV-FILE-TYPES what it needs; SPEC §8.5 is updated.
    - Status: added, deleted, renamed (an `oldPath` different from `path`) or modified. A change with nothing on either side is refused.
    - Text diffs only when both sides are text or absent; binaries, symlinks and submodules get no hunks.
  - `diffLines`: Myers' shortest edit script after trimming the common start and end, so a small change in a 50,000-line file takes milliseconds.
    - Lines split on `\n`, keeping `\r`, so a CRLF or final-newline change counts as a change.
    - Past 2,100 edits (`MAX_EDIT_DISTANCE`) it falls back to "every line replaced". That only overcounts, and anything that large already exceeds the largest possible `maxLinesChanged` (2,000), so the size check's verdict is unchanged. Memory stays bounded (about 18 MB worst case).
  - Hunks are git-style: 3 lines of context, merged when they touch, 1-based starts (an empty side names the line before).
  - Index accesses the algorithm guarantees go through `item()`, which throws instead of silently defaulting: a default would make a wrong diff look right.
- Tests: 16, including two fast-check properties over 500 random pairs each (applying the hunks to the old text gives the new text, line counts and hunk sizes agree; never worse than replacing everything; empty only when nothing changed), minimality on an interleaved case, the fallback, and performance. Mutation-checked: swapping additions and deletions in the backtrack fails most tests. Policy coverage 99.4% statements, 99.2% branches (the one uncovered branch is `item()`'s "can't happen" throw). Full suite 1,079.
- Dependency: `fast-check` (dev, policy): property-based tests, which SPEC asks for in P3.3 as well.

## 2026-11-25 · P3.3 · Layer merge with provenance

- Decision **D13 (Malek):** org defaults + guardrails. Org defaults and the repo dashboard settings override (an admin may loosen); `.pipeheal.yml`, `code` custom rules and org guardrails only tighten. SPEC §8.1, §8.4, §15, §16 updated.
- Done (`packages/policy/src/merge.ts`, pure; tests first):
  - `effectivePolicy({ orgDefaults, repo, repoFile, orgGuardrails })` returns `{ policy, provenance }`. Every layer is re-parsed with `policyLayerSchema`, since callers will pass stored JSON and file contents.
  - `EffectivePolicy` differs from `PolicyRules` where a conjunction isn't one glob list: `paths.allowAll` and `scope.*.includeAll` keep every layer's list (a path must match a glob in each). P3.4's path checks and the scope filter read these.
  - Provenance: for each field (`limits.maxFilesChanged`, `paths.deny`, ...) the layers its value comes from. Single values name the layer that set them, or every layer that asked for the same value; lists name every layer that contributed. A code rule shows as `custom:<layer>:<id>`.
  - Every field is described once (how to read, override, tighten and compare it), so the merge and `looserThan` can't disagree.
  - `looserThan(policy, layer)`: the fields where a policy is looser than a layer, in field order. Conservative for glob lists: it compares lists, not what they match.
- Tests: 11, including three fast-check properties (never looser than the guardrails or the repo file, over 500 random layer sets; adding a tightening layer never loosens; limits within plan maximums). Policy: 53 tests. Full suite 1,090.
- Raised (SPEC §15): `.pipeheal.yml` can declare custom rules, so a `judge` rule's text comes from anyone who can push; the P4.7 judge must treat it as untrusted data.
- `policy-red-team`: still deferred to P3.6, once the checks exist to attack; the merge's properties are covered by the fast-check tests.

## 2026-11-25 · P3.4 (1/3) · Static checks: paths, invariants, size

P3.4 lands in three commits: (1) foundation, invariants, paths and size; (2) test-integrity checks (test edits, skip markers, suppressions, early exits, assertion reduction); (3) protected configs and dependencies. The PLAN box is ticked after the third.
- Done (tests and fixtures first):
  - `@pipeheal/shared/repo-path` (pure): `repoPathProblem`, `writablePathProblem` (moved from `packages/github`'s guards, which now wrap them) and `canonicalPath`, the file a path is on case-insensitive Windows and macOS checkouts.
  - `packages/policy/src/glob.ts`: our own matcher, no picomatch. Globs come from `.pipeheal.yml`, which anyone who can push edits, so no regular expressions built from them (a backtracking glob is O(n·m), checked by a test) and braces bounded at 64 alternatives (`globSchema` refuses more). Dotfiles match. `matchAnywhere` (deny, test globs, invariants) also matches the canonical path; `matchExact` (allow lists) doesn't, so `SRC/x` is outside `src/**`.
  - `checkChanges(changes, policy)` and `Violation { ruleId, path?, line?, message, hint }`. Checks: `invariants` (INV-GITHUB-DIR, INV-PATH, INV-SECRETS, INV-FILE-TYPES, INV-TEST-DELETE, on old and new paths), `paths` (deny and every allow list, on old and new paths), `size`.
  - Fixtures as TypeScript data in `packages/policy/fixtures/` (the package does no I/O): each runs through every check, so an allowed fixture also proves nothing else fires.
- Decision (mine, SPEC §8.2): new invariant **INV-PATH** for paths the GitHub client would refuse anyway (`.git`, `.gitmodules`, Windows-reserved names, code points macOS ignores), so the policy reports them to the agent instead of the upload failing late.

## 2026-11-25 · P3.4 (2/3) · Static checks: test integrity

- Done (fixtures first, `packages/policy/fixtures/tests.ts` and `suppressions.ts`):
  - `source.ts`: `stripCode` blanks comments and string contents, keeping offsets and line breaks (JS/TS: quotes, nested template literals, regular expressions told from division; Python: `#`, single and triple-quoted strings). `addedLines(change)` with new-content line numbers.
  - Checks: `test-edits` (tests.mode), `skips` (skip markers and early exits, both `tests.forbidSkips`), `assertions` (assertion and test-function counts, old vs new), `suppressions` (raw added lines, any file). SPEC §8.5 lists every pattern.
- Choices (mine, in SPEC §8.5):
  - Early exits are reported as `tests.forbidSkips`: a `return` with more code after it at the same indentation, `return; x()` on one line, dead conditions. Not limited to "the start of a test body", since a return halfway is the same trick.
  - Skip markers are read only in test files: `.skip(` is ordinary in source code (query builders).
  - `xit`/`fit` still count as tests, so a skipped test is reported once (as a skip), not also as a lost test.
  - A changed line that already carried a suppression counts as added; comparing old and new comments would let a suppression move to a new line unnoticed.
- Tests: policy 232, coverage 99.6% statements, 96.2% branches.

## 2026-11-25 · P3.4 (3/3) · Static checks: protected configs, dependencies

- Done (fixtures first, `packages/policy/fixtures/configs.ts` and `dependencies.ts`); P3.4 is complete:
  - `checks/configs.ts` (protectedConfigs): protected files by glob; `package.json` and `pyproject.toml` by section, parsed and compared (so a `[project]` header inside a TOML string can't move a `[tool.pytest]` key out of protection; a fixture proves it).
  - `manifests.ts`: package.json, requirements/constraints files, pyproject.toml (PEP 621, PEP 735, Poetry, uv, PDM) and Pipfile into one entry per dependency; settings that move versions (overrides, resolutions, index URLs, sources, packageManager) are entries too.
  - `versions.ts`: `changeLevel` for npm/Poetry ranges and PEP 440 specifiers (lowest version + width; downgrades, unreadable specs and multi-clause ranges need `any`; 0.x counts one step more). `levelAllowed(mode, level)`.
  - `checks/dependencies.ts`: per-entry violations (`dependencies.mode`, `dependencies.allowNew`), lockfiles only with an allowed manifest change or mode `any`, unparseable manifests refused.
- Dependency: `smol-toml` 1.9.1 (policy): pyproject.toml and Pipfile must be parsed, not scanned line by line, or a header inside a multi-line string hides a protected key. Pure, no dependencies of its own.
- Known limits (SPEC §8.5): `setup.py` dependencies aren't read (it's code); a lockfile's content isn't checked against its manifest (a changed lockfile needs an allowed manifest change, but the lockfile could still resolve something else). For P3.6's red team.
- Tests: policy 348; coverage 99.6% statements, 96.3% branches.

## 2026-11-25 · P3.5 · Behavioral checks: JUnit parser and inventory comparison

- Done (`packages/policy/src/behavior`, fixtures first in `packages/policy/fixtures/junit.ts`: jest-junit, Vitest and pytest reports, each a baseline and a fixed run):
  - `parseJunit(xml)`: our own reader for this one format, no XML dependency. Reports come from the customer's runner, so: no DOCTYPE or entity declarations (no entity expansion), only predefined and numeric entities, tags must nest, bounded at 20 MB, 50,000 tests and 64 levels. Anything off is refused, never half-read.
  - IDs `classname::name`; repeats become `id (#2)` (an O(1) builder: the first version was quadratic on 50,000 identical names, which the limit test caught). `mergeInventories` for several report files.
  - `compareInventories(baseline, after)`: missing tests, lower count, newly skipped, still failing, regressed (SPEC §8.6), up to 10 IDs named per violation.
- Not here (Phase 4, SPEC §8.6): sending the reports from the runner, and "behavioral checks unavailable" (forcing `source_only` and a draft PR when no junit glob is configured).
- Tests: policy 379; coverage 99.5% statements, 96.2% branches.

## 2026-11-25 · P3.6 (round 1) · Red team

- The `policy-red-team` agent wrote 207 attacks (`packages/policy/fixtures/redteam/`); 149 got through. The merge held, and every `.github/` spelling was blocked.
- Every attack is now a permanent test (`src/checks/redteam.test.ts`): one that names a real rule must be blocked by it. All 173 such tests pass.
- Fixed:
  - **Stripper** (`source.ts`): f-string fields are read as code (PEP 701), `x++ /` divides, `<!--`/`-->` are comments, backslash-CRLF continues a string.
  - **Skips** (`skips.ts`):
    - Markers and process exits are matched on the raw line, fail closed: the stripper can't follow JSX or odd line endings. The cost is that a skip marker in a comment is refused too.
    - New markers: `it.fails`/`test.failing`, `it[...]`, destructured `skip`, `.each([])`, aliases bound anywhere in the file; in Python, `mark.skip` without `pytest.`, `SkipTest`, skip imports, `getattr(pytest, ...)`, collection hooks and `collect_ignore`, `parametrize(..., [])`.
    - New early exits: a `return` under a condition inside a test; `process.exit`, `sys.exit`, `os._exit`, `pytest.exit`.
    - Refused outright: test files with a lone CR or U+2028/U+2029, and JS lines ending in a backslash.
  - **Test files:** INV-TEST-DELETE refuses any rename of a test file. The default test globs add Jest's `test.ts`/`spec.ts`, `test/`, `tests.py`, `*.cy.*`, setup files, `__mocks__/` and `testing/`. AVA/tap assertions are counted.
  - **Paths:**
    - `canonicalPath` resolves backslashes, `./`, `//` and `..`, and folds compatibility forms, accents and case through upper case (so dotless i, long s and the Kelvin sign fold).
    - INV-PATH refuses 8.3 short names.
    - INV-GITHUB-DIR covers `action.yml`.
    - INV-SECRETS covers SSH keys, keystores, `.npmrc`, `.pypirc`, `.netrc`, cloud credentials.
  - **Configs:** broader globs (second runner configs, `*jest*.json`, babel, codecov.yaml, turbo/nx/project.json, Makefile/justfile/Taskfile, pre-commit, deno.json); package.json `jest-junit`, `babel` and `workspaces`; pyproject `pytest11` entry points.
  - **Suppressions:** more spellings (pyright/mypy per-file settings, pylint skip-file, fmt/isort, oxlint, jshint, node:coverage, `/* global */`). A changed line right under an existing next-line directive is refused.
  - **Dependencies:**
    - A real bug fixed: any byte change to any manifest unlocked every lockfile. A lockfile now needs an allowed dependency change in its own ecosystem.
    - More files are read: `*requirements*`/`*constraints*` manifests, `pylock*.toml`, `deno.lock` and `pixi.lock` lockfiles, uv override/constraint dependencies.
    - Dependency-settings files need mode `any`: pnpm-workspace, .npmrc, .yarnrc, pnpmfile, `patches/`, conda environments, setup.py/setup.cfg, toolchain pins.
    - A package swapped to a git URL, `npm:` alias or direct reference counts as new.
    - Duplicate requirement lines are kept, so a change to either is seen.
    - Pre-1.0 widening is rated one step higher.
  - **JUnit:** an ID now maps to every outcome with that ID, compared as a multiset, so no duplicate, `(#2)` name, extra report or long-name collision moves a failure onto an ID the baseline lacks. Long IDs are hashed, not truncated. Nested testcases, `failure`/`error`/`skipped` outside a testcase, and namespaced elements are refused.
- Reclassified, with the reason in each attack:
  - **`server` (Phase 4):** symlinked-directory and file/directory-conflict paths, tsconfig `extends`, local ESLint plugins, an empty JUnit baseline.
  - **`behavior.missingTests`:** table rows removed from `it.each`/`parametrize`.
  - **`decision:*`:** a byte cap, doctests, file-wide suppressions, lockfile contents.
- Residual: attacks no stated rule covers, all listed in SPEC §15 for CHECKPOINT 3.
  - **AI judge:** a weaker matcher, `.not`, an assertion in a helper that is never called, a hardcoded expected value, the script behind `test`.
  - **New rules:** retries, mocking the subject, tautologies, swallowed assertions, floating assertions, test detection and swallowed errors in source, framework monkeypatching, type escapes, warning filters, undeclared imports.
- `fixtures/redteam/run.ts` removed: it needed Node types in a package that has none, and the permanent test replaces it.

## 2026-11-26 · P3.6 · CHECKPOINT 3 rules (D14)

- Malek accepted every recommendation ("do all you talked about"), recorded as **D14**.
- Done (fixtures first, `packages/policy/fixtures/heuristics.ts`):
  - `checks/heuristics.ts`: in test files, tautological, swallowed and floating assertions and retries; in source, test-runner detection, test-framework patching, empty catch/except-pass, `as any`/`as unknown as`, warning filters. Each rule reports under the policy switch it belongs to (`tests.forbidAssertionReduction`, `tests.forbidSkips`, `suppressions.forbid`), so turning a switch off turns its rules off.
  - `size.ts`: `lineWeight`; a packed line counts as several.
  - `test-edits.ts`: doctest lines (`doctestLines`) in Python source count as test content under `source_only`.
  - `checks/draft.ts`: `draftReasons(changes)` for edits in files with file-wide suppressions. Phase 4's PR step opens those as drafts and says why.
- Not done, as recommended: mocking the module under test and undeclared imports (need module resolution: later, server side); lockfile contents (Phase 4).
- Three older tests used `expect(1).toBe(1)` / `assert True` as filler; they now assert on a call, since the tautology rule rightly refuses those.
- Round 2 of the red team is running against the round-1 engine; its findings come next.

## 2026-11-26 · P3.6 (round 2) · Red team

- Round 2 (against 3b71374): 81 new attacks, all allowed, and 20 false positives the round-1 fixes introduced on ordinary fixes. All are permanent tests now: the attacks must be blocked by the rule they name, the false positives (`fixtures/redteam/false-positives.ts`, and a JUnit one) must pass clean. 707 policy tests pass.
- Fixed:
  - **Skips (`skips.ts`, rewritten):**
    - Markers are counted per file, old against new, on a normalized text (escapes decoded, NFKC, whitespace collapsed). That catches markers split across lines, unicode escapes and fullwidth letters.
    - Patterns are anchored to the runner's names, which clears the `.todo-list`, `store.only`, `context[0]`, callback-`skip` and `from shop import skip` false positives.
    - New markers: Python import aliases, `__import__`, hooks, `__test__`, `del`, shadowed tests, `@fixture` on tests, `__init__` on test classes, test options `{ skip: true }`, empty tables over lines, dead loops.
    - `parametrize` counts only when the whole list is empty; `SystemExit` only when raised; `process.exit` only as a call.
  - **Early exits:**
    - A test start must begin the line, which clears `for (const it of ...)`.
    - Method shorthand counts as a function, and a named helper isn't the test's callback.
    - Prettier's and Black's multi-line signatures are followed.
    - New: `break`/`continue` with code after them, a labelled `break`, and `break` under an always-true condition (ordinary search loops pass).
    - Both stripped and raw lines are read.
    - The odd-line-break and backslash rules apply only to added lines, and an escaped `\\` or a template literal passes.
  - **Assertions:**
    - Only `expect(`/`expect.soft(` count (not `expect.assertions(0)`), and not after a JSX `>`.
    - `pytest.raises` counts only with `with` or a callable.
    - An f-string prefix must be a whole `rbuf` token (`if"..."` isn't one).
  - **Globs:**
    - Added `*_test.*`, `*_spec.*`, `*.test-d.*`, `*.stories.*`, `__fixtures__/`.
    - Dropped `spec.ts` and `testing/` (false positives). Shared test helpers in `testing/` are now `server`: derive them from the runner config in Phase 4.
  - **Configs:**
    - Added build configs that can switch checks off (next/nuxt/astro/svelte/webpack/rollup/tsup/rspack/esbuild, angular.json), `.editorconfig`, cspell/markdownlint/yamllint/shellcheck/knip, hatch.toml, wdio, jasmine, size-limit, and Pipfile `[scripts]`.
    - `action.yml` moved here from INV-GITHUB-DIR: as an invariant it made repositories that are actions (ours included) unfixable.
    - `project.json` dropped: a false positive without `nx.json`, now `server`.
  - **Suppressions:**
    - More spellings: `pragma no cover` without a colon, pytype, yapf, pyre-unsafe, NOSONAR, cspell, dprint, shellcheck, markdownlint, yamllint, svelte-ignore.
    - Deleting an enabling directive (`eslint-enable`, `@ts-check`) is refused, and so is changing code inside a block an existing `istanbul ignore next` or `# pragma: no cover` covers.
    - `/* global */` is case-sensitive, `eslint-enable` is no longer flagged, and `prettier-ignore` no longer covers the next line.
  - **Dependencies:**
    - Foreign sources are an allowlist: only a semver range or dist-tag keeps the source, so `exec:`, `jsr:` and `workspace:` count as new.
    - More files: `requirements*.lock` and `conda-lock.yml` lockfiles; pixi/uv/pdm/bunfig/import_map/package.yaml and any `*.patch` as settings; package.json `trustedDependencies`/`volta`/`engines`/`devEngines`; pdm `resolution`.
    - `setup.py` is read for its dependency arguments only, so a `package_data` fix passes.
    - A file named `*requirements*` that doesn't start with it is a manifest only when it reads as one.
  - **Paths:** more secret names (secrets.yml, .git-credentials, .pgpass, tfvars, tfstate, kubeconfig).
  - **JUnit:** a failure on a test the baseline didn't list is a regression. A fixed pytest collection error (one errored case named after the module) isn't a missing test once its tests appear.
- An `at(list, index)` helper in `source.ts` replaces the `?? ""` fallbacks for indexed access: same behavior, one tested place.
- Residual (pseudo IDs): `expect.extend` overriding matchers (new rule), tests registered in a never-called function (behavior), an existing skipping fixture (behavior), Deno inline `npm:` specifiers (new rule), local action code (server).
- The red team's conclusion, which I share: static skip detection stays porous by nature. The robust layers are the JUnit inventory (`may_edit_tests` is only possible with it, SPEC §8.6) and the AI judge, which should get the behavior-blind tricks (matcher overrides, conftest hooks) as explicit checks in P4.7.

## 2026-11-26 · P3.6 (round 3) · Red team

- Round 3 (against 1535309): 36 new attacks, all allowed, and 14 new false positives. Among the attacks was a regression from round 2: anchoring markers to runner names had dropped `ctx.skip()`, `this.skip()` and `t.skip()`. All are permanent tests now; 756 policy tests pass.
- Fixed:
  - **Skips:**
    - Test-context skips (`this|ctx|context|t|testInfo|task|test.info()` `.skip/.todo/.fail/.fixme`), Jasmine `pending(`, Playwright `test.fail`, optional chaining `it?.skip`.
    - Runner aliases from `import { it as x }` and `import * as x from "vitest"` (also `globalThis.`).
    - Options `{ skip: <anything but false/0> }` and shorthand `{ skip }`, only as the options argument of `it(`/`test(`/`describe(`.
    - `[].forEach(...)` and `range(a, a)` dead loops; Python `Skipped`/`XFailed`/`Exit`, `from _pytest`, `x = pytest` aliases, `sys.modules[`, `vars(pytest)`, `pytest.__dict__`.
    - Markers are now counted both on the raw file and with comments blanked (new `stripComments`), and the larger increase counts. Deleting a comment that names `it.skip` no longer pays for a real one, and the stripper still can't hide one in a "comment" it misread.
    - Early exits: `finally`, `with` and bare `{` blocks guard a return, also when the guard is on the same line; a guarded return at column 0 is refused.
  - **Assertions:**
    - `expect(...)` counts only with a matcher after it.
    - Inverted or swallowed assertions are refused: `expect(() => { expect(...) }).toThrow()` (on one line or two), `pytest.raises(AssertionError)`, `suppress(AssertionError)`, and `catch (e) { void e; }`.
    - Literal-vs-literal asserts and `expect([])` / `expect({})` count as tautologies.
  - **D14 source rules:** CI detection (`process.env.CI`, `os.environ["CI"]`, `getenv("CI")`), `import.meta.env.MODE`, `npm_lifecycle_event`, `__vitest_worker__`, `Object.assign(globalThis, ...)`, `setattr(TestCase, ...)`, `<any>` casts, `filterwarnings(action="ignore")`, `process.emitWarning =`.
  - **False positives removed:**
    - Options-like objects passed to other functions.
    - `{ retry: 0 }`.
    - `pytest_configure`/`pytest_addoption`.
    - `import_module` of the code under test.
    - `process.kill(pid, "SIGTERM")`.
    - Comparison asserts with parentheses; the tuple rule now needs one parenthesized group with a top-level comma.
    - `except ImportError: pass`; only bare/`Exception`/`BaseException` count as swallowing.
    - `NODE_ENV` appearing outside a comparison with `"test"`.
    - Deleting a whole `eslint-disable`/`eslint-enable` pair.
    - `if TYPE_CHECKING:  # pragma: no cover`.
    - `.patch`/`.diff` test data.
    - Storybook stories; they are tests only with its runner, now `server`.
  - **Dependencies:** `setup.py` arguments are found in comment-blanked code, an identifier is followed to its assignment, and a literal list is read per requirement (so a 1.x patch bump is a patch). `dev-`, `test-`, `docs-` and similar `*-requirements` files are always manifests.
  - **Configs:** `.swcrc`, `sonar-project.properties`, commitlint.
  - **JUnit:** once a fixed collection error's tests appear, none of them may be skipped.

## 2026-11-26 · P3.7 · `.pipeheal.yml` loader

- Done (tests first):
  - `apps/worker/src/queues/policy-file.ts`:
    - `readPolicyFile(text)` parses the file as plain YAML data: core schema, no custom tags, at most 20 aliases (no alias bomb), unique keys, at most 64 KB.
    - The result is validated with `@pipeheal/policy`'s `policyLayerSchema`.
    - It returns a layer, or up to 20 `field: message` errors capped at 300 characters, and never throws.
    - `refreshPolicyFile` reads the file at the default branch's tip, skipping the fetch when that commit was already read.
  - A new paced `policy-file` job in the failures queue, queued by `close-window` next to triage. A GitHub error retries the job and never touches triage.
  - db: `Repository.policyFile`, `policyFileErrors`, `policyFileCommitSha`, `policyFileReadAt` (migration `policy_file`). `system.repositories.recordPolicyFile` writes the audit row with the commit and the error count only, never the content. The scope meta-test has its cross-org and audit cases.
  - web: the repo page has a `.pipeheal.yml` section with four states: not read yet, no file, in effect (with the sections it sets), or not in effect with its errors. The stored JSON is re-validated (`lib/policy-file.ts`).
- Decision (mine, SPEC §8.1): the App isn't subscribed to `push` (SPEC §5.1), and adding it would mean changing the App registration, which is yours. So the file is re-read whenever a failure arrives and the default branch has moved. A manual "reload" belongs on P3.8's policy page.
- Not yet: using the stored layer. P3.8 puts it into `effectivePolicy` with the dashboard layers.
- Dependency: `@pipeheal/policy` (workspace) in `apps/worker`, for `policyLayerSchema`.

## 2026-11-26 · P3.6 (round 4) · Red team

- Round 4 (against 67cd704): 13 new attacks, 12 allowed, and 6 false positives from the round-3 fixes. One was a regression: counting `expect` only with a matcher had dropped chai's `.to.equal`. The agent's structural point: the remaining holes were scoping problems that a bracket-aware walk solves better than more patterns. All are permanent tests now; 788 policy tests pass.
- Fixed:
  - **Markers are a multiset** of their normalized text, compared kind by kind. An existing `it.todo` turned into a test no longer pays for a new `it.skip`.
  - **Test context, not a fixed name list:** the receivers are the test callbacks' own parameters (`(c) => c.skip()`, Playwright's `(_, info)`), plus `this` when a test is a `function`. A tokenizer `t.skip()` under test passes.
  - **Options:** quoted keys, and an options object held in a variable (`const later = { "skip": true }; it("x", later, fn)`).
  - **Jasmine `pending(`** counts only as a statement of its own. App classes named `Skipped`/`Exit` pass, and only pytest's own outcomes count. Typing-only `_pytest` imports (MonkeyPatch) pass.
  - **Early exits in JS by brackets** (`guardedExitInJsTest`). Walking outwards over unclosed `{`, any condition, `try`/`catch`/`finally`, label or bare block between the exit and the test's callback guards it. A helper's or callback's function header ends the walk, and a guard on the same line counts. Any exit at column 0 is refused. Python keeps the indentation walk, since its indentation is the syntax.
  - **`expect` subjects are read bracket-balanced** (`checks/expects.ts`, `scanExpects`). An expect counts with a Jest/Vitest matcher, a chai `.to.` chain or `.should`, and `expect.poll` counts. An expect whose subject asserts and that expects a throw is refused, in any function syntax and over any number of lines.
  - **Python:** `with raises/suppress(AssertionError | Exception | BaseException)` whose block starts with an `assert` is refused. Testing a custom assertion helper that way passes. In tests, a handler that only `return`s swallows too.
  - **CI checks in source** (now also `GITHUB_ACTIONS`, `RUNNER_OS`, `CONTINUOUS_INTEGRATION`, `BUILD_ID`, ...) count only when they pick a return value or return early. A CLI turning its spinners off in CI passes. `import.meta.env.MODE` counts only when compared with `"test"`.
  - **setup.py:** a dependency list grown elsewhere (`REQUIREMENTS.append(...)`, `BASE + EXTRA`) makes the whole file the setting.
- Convergence: each round's new bypasses are narrower (edge cases of the previous round's fixes), and the false positives are shrinking. Static skip detection stays porous by nature; the JUnit inventory and the AI judge are the robust layers (SPEC §8.6, P4.7).

## 2026-11-26 · P3.6 (round 5) · Red team

- Round 5 (a convergence check against aeb4a72): 5 bypasses and 4 false positives from the round-4 fixes, all refinements of those fixes rather than new classes. All fixed and permanent (797 policy tests). The agent's verdict, which I share: what's left after this needs data flow, which belongs to the behavioral checks (JUnit inventory) and the AI judge (P4.7).
- Summary across the five rounds: about 360 attacks and 45 false positives, each a permanent test. The residuals are recorded with pseudo IDs and the reason in each attack (`judge`, `server`, `behavior.*`). P3.6 stays unticked: CHECKPOINT 3 reviews the findings with Malek, who decides whether this is converged enough.

## 2026-11-26 · P3.8 · Policy UI

- Done:
  - `@pipeheal/policy`'s `parsePolicyYaml`/`formatPolicyYaml` (moved from the worker), so the dashboard editors and `.pipeheal.yml` share one reader.
  - db: `PolicyVersion`, an append-only table with one version sequence per layer (migration `policy_versions`). `policies.current/history/save/layers` sit in the org scope:
    - `save` re-validates with the layer schema and writes the `policy.saved` audit entry (layer, version, sections; never the rules).
    - `layers(repoId)` returns the stored org defaults, guardrails, repository settings and `.pipeheal.yml`, re-validated.
    - The scope meta-test has cross-org and audit cases. Behavior tests cover versions, roles, refused rules and the file layer.
  - worker: the flaky check uses the repository's effective `scope.retryBeforeHeal` (`effectivePolicy(layers)`). The `FlakyCheckDeps.retryBeforeHeal` stopgap is gone. Tests cover the dashboard and `.pipeheal.yml` turning it off.
  - web:
    - `/[org]/policy` has the org defaults and guardrails editors, each with its history, and the org-wide effective policy.
    - `/[org]/repos/[repo]/policy` has the repository settings editor, its history, and the effective policy with provenance: for each field, the value and the layers it comes from.
    - The YAML editor is a client component on `useActionState`, so validation errors show as `field: message` lines.
    - There is a "Policy" nav link, a link from the repo page, and an e2e test that signed-out visitors are redirected.
- Decision (mine, SPEC §8.9): only owners save the guardrails, since they are the ceiling for the whole organization; admins save defaults and repository settings.
- Not done here: a "restore this version" button (history is view-only), and a manual "reload .pipeheal.yml" (the file is re-read with each failure, P3.7). Both are small additions if wanted.
- Dependencies: `@pipeheal/policy` (workspace) in `packages/db` (to validate layers on save) and in `apps/web`.

## 2026-11-26 · P3.9 · Custom rules

- Done (tests first):
  - agent-core `rules/compile.ts`: `buildRuleCompilerPrompt`, with the rule wrapped in `<rule>` (it can't close its own wrapper) and capped. Plus `ruleCompileOutputSchema` (`expressible` exactly when there is a layer), `RULE_COMPILE_JSON_SCHEMA` and `RULE_COMPILER_PROMPT_VERSION` "rules-v1".
  - db: `CustomRuleDraft` (PENDING → COMPILED | FAILED → ACCEPTED | DISCARDED), migration `custom_rule_drafts`. Org-scope `customRules.drafts/getDraft/propose/accept/discard` and system `recordCompiled`:
    - `accept` appends `CR-n` to the layer and saves a new version through the same `appendPolicyVersion` as `policies.save`.
    - `recordCompiled` re-validates the layer and refuses nested custom rules.
    - Audit entries record the layer, IDs and counts, never the rule text.
    - The scope meta-test and behavior tests cover all of it.
  - worker: the `rules` queue and its `compile-rule` job (`processRulesJob`), and `ruleModel` with `HEAL_MODEL` (new env var, default `qwen3:14b`). Recorded Ollama responses in unit tests; the job in integration tests with a fake model.
  - web:
    - Each layer on the policy pages has a "Custom rules" section. The rules carry the labels "Enforced by code" and "Checked by AI judge (best effort)".
    - Proposals show their compiled YAML or why compiling failed, with Enforce by code / Check by AI judge / Discard.
    - The propose form uses `useActionState`. The web app enqueues `compile-rule` on the new `rules` queue (`@pipeheal/shared`'s `RULES_QUEUE`, `ruleJobDataSchema`).
- Not yet: running judge rules (P4.7). Model calls for compiling aren't in the `ModelCall` table, which is per failure; their token counts are logged.

## 2026-11-26 · P3.10 · Dry run

- Done (tests first):
  - `@pipeheal/policy`'s `parseUnifiedDiff`: a pasted `git diff` becomes `ChangeInput`s. It reads edits, new, deleted and renamed files, binaries, symlinks (120000), submodules (160000), mode changes, quoted paths, CRLF and "No newline at end of file". Each side is rebuilt from its hunks' lines.
  - It refuses non-diffs, paths outside the repository or with control characters, hunks whose counts don't match their header, more than 2 MB or more than 500 files.
  - web: the repo policy page has a "Dry run" section (`dryRunAction`, read-only, any member). It lists each rule that would refuse the diff, and whether the PR would open as a draft (`draftReasons`). It says that whole-file checks see only the diff's lines.
- Not yet: the last N attempts' diffs (Phase 4).
- Next: CHECKPOINT 3, with the end-of-phase security review.

## 2026-11-26 · Phase 3 security review

- The `security-reviewer` found 2 high, 4 medium and 5 low issues. Tenant isolation, role checks, model-output handling and the audit and log contents were clean. Fixed:
  - **H1:** `.pipeheal.yml` could widen `tests.testGlobs` so that source files escaped the source-only D14 rules. That loosened the policy, against D13. Those rules now decide "test file" from PipeHeal's own test globs, which no layer can widen. There's a regression test.
  - **H2:** untrusted input drove the checks into quadratic time (25 s for 80 KB of blank lines), reachable by any member through the dry run.
    - Fixes: `^\s*` became `^[ \t]*` under the `m` flag, the regex scans are bounded, `swallows()` no longer builds the rest of the file per line, `expect` subjects are capped at 5,000 characters and definitions cached, path segments are capped at 255 characters, and the dry run accepts at most 512 KB.
    - A timing test now covers all four inputs (200,000 blank lines take 0.45 s, against 168 s before).
  - **M1:** identifiers containing `$` were put into regexes unescaped, which hid skips. They are now escaped (`escapeName`), with tests.
  - **M2:** the JUnit attribute regex was quadratic. It's now a single-pass scanner with a timing test (500 KB attribute body).
  - **M3:** `.pipeheal.yml`/`.yaml` is now an invariant (INV-GITHUB-DIR) and refused by `writablePathProblem`, matched in folded form, so a fix can't change the rules it is checked against.
  - **M4:** at most 5 custom rules wait for the model per org.
  - **L1:** an empty compiled layer is refused and never offered as "Enforced by code".
  - **L2:** the GitHub write guard compares `.github` in folded form too (`.gıthub`).
- Deferred to Phase 4, in SPEC §15: L3 (repo-file custom rules as untrusted in the healer prompt), L4 (a stored policy file a newer schema rejects), L5 (which policy-file commit an attempt used), M4's model-call metering and priority, and L1's non-tightening fields.

## 2026-11-26 · CHECKPOINT 3 closed

- Malek reviewed the default rules and the red-team findings and said to continue ("okay continue now and later i will add the env variables"). P3.6 is ticked; the env vars for the CHECKPOINT 2b acceptance run come later.

## 2026-11-26 · P4.1 runner ↔ gateway protocol

- Decision D15 (Malek): async steps with long-polling instead of ~2-minute synchronous requests. SPEC §3.1 is updated, and the §15 open question is removed.
- `@pipeheal/shared/protocol` is a pure subpath (no env or logger), so the runner action can import it.
  - Session exchange: OIDC JWT and attempt ID in; session token, target SHA, failing check, argv commands, JUnit glob and wall-clock limit out.
  - Steps: the first step carries the reproduction, the file tree and the baseline reports; later steps carry tool results. Polls answer `pending`, `ready` or `done`.
  - The eight SPEC §7.2 tools form a discriminated union, with paths checked by `repoPathProblem`.
  - The submission carries final contents or deletions (never a diff), checks and reports.
  - Every array and string is capped (`LIMITS`).
- The schemas check shape only. Write permissions such as `.github/` are decided by the policy engine on the server, and a test pins that.


## 2026-11-26 · Speed tests run on their own

- The H2 speed test failed in full runs (14 s against a 5 s budget; 2.5 s alone): it shared the CPU with the parallel test files. Speed budgets now live in `*.perf.test.ts` and run in a `perf` Vitest project that starts after the others (`sequence.groupOrder`). The H2, JUnit M2 and triage budgets moved unchanged, and `pnpm test:unit` runs them too. The diff and glob budgets sit inside functional tests and stay where they are.

## 2026-11-26 · P4.1b gateway hardening

- **Listeners:** the public gateway serves `/livez`, which checks nothing and is never rate limited. `/readyz`, with the Redis check, moved to an internal listener (`GATEWAY_INTERNAL_HOST`/`PORT`, default 127.0.0.1:4001). The env check refuses giving both listeners one port. `/health` is gone.
- **Deadlines and caps** (on both listeners): 16 KB default body limit, with per-route limits in `BODY_LIMITS` (`@pipeheal/shared/protocol`: session 16 KB, step 24 MB, submission 64 MB). Headers 10 s, whole request 120 s, idle socket 65 s (longer than a long-poll), at most 1,024 connections.
- **Rate limit:** `@fastify/rate-limit` 11.2.2. That's the newest release older than two weeks; 11.3.0 was six days old.
  - Counted in `onRequest`, before the body is read. It is in place before `buildGateway` returns (which is now async), so later routes and 404s are counted.
  - Keyed by client address, with IPv6 grouped by /64. `X-Forwarded-For` is believed only from `GATEWAY_TRUSTED_PROXIES`.
  - Production uses a separate fail-fast Redis connection (no offline queue, 500 ms command timeout). If Redis is down, requests fail at once with a 500; they neither hang nor pass unlimited.
- **Security review** (`security-reviewer`): H1 and M1–M4 are fixed, with tests:
  - **H1:** a Redis outage would have queued limiter calls forever, hanging every request, `/livez` included.
  - **M1:** made-up bearer tokens and IPv6 addresses each got a fresh budget.
  - **M2:** routes added before the plugin loaded weren't limited, nor were 404s.
  - **M3:** no trusted-proxy setting.
  - **M4:** Node's default header deadline, and no connection cap.
  - M5 (key growth) is gone with M1.
  - Recorded for later in SPEC §12 and §15: M6 (authenticate step and submission bodies before reading them, one request in flight per session), per-session and per-org limits after verification (P4.2), and L1 (keep the internal listener off public networks). L2 (the `X-RateLimit-*` headers show the limits) is accepted.
- **Tests:**
  - Unit: timeouts on both listeners, body limits, 429s, a route added afterwards being counted, 404s counted, `/livez` exempt, rotating tokens getting no fresh budget, IPv6 /64 buckets, trusted versus spoofed `X-Forwarded-For`, and `clientBucket` cases.
  - Integration: two gateways sharing a Redis budget, and a Redis that's down (fast 500, `/livez` still 200).
- **Checked by hand** (`tsx src/main.ts` against Docker Redis):
  - `:4000/livez` returns 200, and `:4000/readyz` returns 404.
  - `:4001/readyz` returns 200 with Redis up.
  - Rate-limit headers come from Redis, and a 20 KB body gets a 413.

## 2026-11-26 · P4.2 session exchange (`POST /v1/session`)

- **DB:**
  - `HealAttempt` model and migration (`heal_attempts`): status `DISPATCHED`/`RUNNING`/`FAILED`, target SHA, failing check, dispatch run, and session hash, open and expiry times. The other SPEC fields come with their tasks.
  - System scope: `attempts.create` and `attempts.recordDispatch`.
  - New top-level `runnerSessions(db)` (`find`, `open`, `contest`): attempts are reached only through the attempt ID plus the signed `repository_id`/`repository_owner_id`, and `open` claims the one session in a single conditional update.
  - Meta-test cases for all of them (tenant isolation and audit).
  - Seed commands are now argv arrays.
- **Gateway:**
  - `oidc.ts`: jose `jwtVerify` against GitHub's remote JWKS (RS256 only, exact issuer, audience `pipeheal`, expiry, at most 15 minutes old) with zod-checked claims. A pure `sessionProblem` covers SPEC §5.4.
  - `session.ts`: `POST /v1/session` with a 16 KB body limit and 30 exchanges per minute per address. It answers the same 401 for every refusal, with the reason logged (never a token). The 32-byte token is stored as SHA-256. The session lasts min(45 min, the policy's wall-clock budget), and the response is validated before the session opens.
  - `GITHUB_APP_SLUG` is added to the worker env: optional in development (no sessions without it), required in production.
  - New dependency: `jose` 6.2.12, the version Better Auth already brings in.
- **Claim values to verify (from SPEC §5.4):**
  - `run_id`: the dispatch API returns the run with `return_run_details` (GitHub changelog, 2026-02-19), so it is bound exactly.
  - `actor`: GitHub's docs don't say what an App-triggered dispatch carries. It's compared with `<slug>[bot]` and must be confirmed in the acceptance run (SPEC §15), with `actor_id` to follow.
- **Security review** (`security-reviewer`): H1, M1, M2, L1, L3 and L4 are fixed, with tests. L2 is recorded in SPEC §15.
  - **H1:** the run-ID binding could never apply, because nothing recorded the run, so any healer run of a repository could take another of its attempts. Fix: `recordDispatch`; no session until the run is recorded; `run_attempt` must be 1. This is D16, to be confirmed by Malek.
  - **M1:** a second valid exchange now fails the attempt and revokes its session (`attempt.session_contested`).
  - **M2:** the session ends with the attempt's budget.
  - **L1:** the response is validated before the session opens.
  - **L3:** `job_workflow_ref` must equal `workflow_ref`.
  - **L4:** the org and repository are re-checked inside the claim.
- **Tests:**
  - OIDC: every rejection path with locally generated keys (another issuer, audience or key; expired, too old or future tokens; unknown `kid`; HS256, `alg: none`, unsigned, malformed claims), and GitHub's JWKS through msw (fetched once and cached, and refusal when the fetch fails).
  - `sessionProblem`: one case per SPEC §5.4 check.
  - Route: 200 shape, the stored hash, no tokens in logs, 400/503/401/413/429, contested sessions, the budget cap, and stored commands that aren't argv arrays.
  - DB: one session per attempt, four simultaneous exchanges with one winner, the dispatch timeout, the org/repo re-check, `contest`, and `recordDispatch`.
- **Checked by hand:** the real worker answers a fake token with 401 (`ERR_JWS_INVALID` logged) and a bad body with 400.
- **For Malek:** the local `.env` has a `GITHUB_APP_SLUG` that isn't a slug. The worker won't start until it is the App's URL name (`github.com/apps/<slug>`); the value wasn't read.

## 2026-11-27 · Decisions for the rest of Phase 4

- Before stepping away for 5 hours, Malek answered the decisions coming up in Phase 4:
  - **D16 confirmed:** a session needs the recorded dispatch run, and a second exchange fails the attempt.
  - **D17:** `HEAL_MODEL` gets a 16k-token context.
  - **D18:** "within budget" means attempt caps: `maxAttemptsPerFailure`, 20 attempts per org per day, one running attempt per repository.
  - **D19:** heal-action is loaded from the monorepo at a pinned SHA until a dedicated repository is published.

## 2026-11-27 · P4.3 step loop (`POST /v1/step`, `GET /v1/step/:seq`)

- **Order:** "run the next model turn" depends on P4.4's prompt builder and loop controller, so P4.3 builds everything around the turn behind a `TurnRunner` interface. `main.ts` wires a stub that stops every attempt with a clear reason until P4.4.
- **DB** (migration `agent_steps`):
  - `AgentStep` (one row per `stepSeq`) and `AgentEvent` (the timeline).
  - Attempt statuses `AWAITING_SUBMISSION`/`NOT_REPRODUCIBLE`/`GAVE_UP`, plus `iterations` and `endReason`.
  - System-scope helpers `attempts.acceptStep`/`completeTurn`/`getStep`/`history`, and `runnerSessions.authenticate`, with meta-test cases. They enforce:
    - order and idempotency: a duplicate with the same body is the same step, another body is a conflict;
    - results matching the previous step's calls;
    - endings for a failure that doesn't reproduce, the iteration cap, a disabled org or repository, and session expiry;
    - compare-and-set status writes with `orgId` in every `WHERE`;
    - a turn completes once, and a concurrent turn or a race is settled and retried once.
- **Gateway** (`steps.ts`):
  - The session token is checked in `onRequest`, before any body.
  - Each session has one POST and one GET (HEAD included) in flight, released once the socket has closed and the handler has settled.
  - Rate and body limits: 120 requests per minute per session, and at most 16 step bodies read at once (4 per org).
  - Stored data is redacted, then cut to the protocol's limit; the file tree is bounded and redacted.
  - The long-poll lasts 20 s and re-checks the session. Schema errors answer 400.
- **Worker** (`queues/turns.ts`): one job per step (3 attempts with backoff, a failed job is retried when queued again, concurrency 1). The model's tool calls get server-side IDs with a per-turn random part and are re-validated with the protocol's schema.
- **Security review** (`security-reviewer`):
  - Fixed, with tests:
    - **H1:** locks and slots leaked when a client left while its session was looked up; one abort could lock a session for good, and 16 locked out every tenant.
    - **M1:** an abort freed a slot while its handler kept working.
    - **M2:** status writes weren't compare-and-set, so a contested attempt could be revived.
    - **M3:** a duplicate turn could swap the tool calls under the runner.
    - **M4:** a failed turn job was never retried.
    - **M5:** redaction could push output past the limit, giving a 500 on every retry.
    - **M6:** no per-session limit.
    - **M7:** the file tree was unbounded and unredacted.
    - **L1:** org and repository state wasn't re-checked.
    - **L2:** session expiry wasn't handled in turns.
    - **L3:** HEAD got its own long-poll.
    - **L4:** long-polls didn't notice a revoked session.
    - **L5:** writes without `orgId`.
    - **L6:** a weak cross-org test.
  - Recorded in SPEC §15: L7 (`NOT_REPRODUCIBLE` is the runner's word) and L8 (baseline reports for the behavioral check), plus the follow-ups for P4.4 and P5.3.
- **Tests:**
  - DB: the loop, duplicates and conflicts, results matching calls, not reproducible, the iteration cap, expiry and contested sessions, two simultaneous turns (one wins, nothing duplicated), two simultaneous POSTs, a repository disabled mid-loop, and `authenticate` across orgs.
  - Worker: every kind of model answer, and tool calls outside the protocol.
  - End to end over HTTP against Postgres:
    - a full loop, with stored output redacted;
    - the long-poll returning as soon as the turn finishes;
    - idempotent retries and conflicts, a run that doesn't reproduce, auth before any body;
    - one POST in flight, locks returned on every path, a client disconnecting mid-lookup over a real socket;
    - the per-session rate limit, and redacted output cut back rather than refused.

## 2026-11-27 · P4.3b repository-scoped, read-only tokens for model-facing reads

- **`readOnlyRepo(installationId, repo)`** (`packages/github`):
  - Its installation token covers only that repository, with `contents: read` and `actions: read` (metadata is implied).
  - The client offers only reads: in its type, at runtime, and in the token itself.
  - The token is fetched again on every request (auth-app caches it per scope), so a client held for a while never sends an expired token.
  - GitHub's answer is checked: `selected` repositories, the one repository ID, read access only. IDs must be safe integers.
- **Moved to it:** triage (job logs), recent changes (comparisons, files), the `.pipeheal.yml` read, and `workflow_run` processing, whose job, step and workflow names reach the triage prompt.
- **Still on the broad client:** the flaky check (it re-runs jobs) and the installation's repository and workflow sync (webhooks).
- **Removed repositories:** the three queues return before asking for a token for a repository the installation no longer covers.
- **Security review** (`security-reviewer`): no critical or high findings.
  - Fixed: M1 (a cached token handed out with minutes left and never refreshed), L1 (`workflow_run` reads), L2 (the scope GitHub granted wasn't checked), L3 (unchecked number conversions) and L4 (removed repositories failing on every retry).
  - Recorded in SPEC §15: M2 (a renamed repository fails closed but silently) and L5 (a guard so future model-facing reads use `readOnlyRepo`).
- **Tests:**
  - GitHub client: the scoped token request and its reuse; reads only; refusing a token for every repository, with write access, or with another permission; unsafe IDs.
  - Worker: triage asks for exactly the scoped, read-only token. The token mocks answer scoped requests the way GitHub does.

