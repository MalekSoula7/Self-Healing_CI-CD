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
