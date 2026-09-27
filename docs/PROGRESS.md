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
