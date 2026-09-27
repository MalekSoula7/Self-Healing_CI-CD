# PipeHeal (working name)

Multi-tenant SaaS that watches GitHub Actions pipelines, diagnoses failures, and proposes fixes as pull requests, strictly within rules each customer defines. A human always merges.

Before any work, read `docs/SPEC.md` (what and why) and `docs/PLAN.md` (in what order). `docs/PROGRESS.md` is the running log: read it at the start of every session and append to it after every task.

## Stack
- pnpm workspaces + Turborepo, TypeScript `strict` everywhere
- `apps/web`: Next.js (App Router), Tailwind, shadcn/ui, Auth.js (GitHub provider), TanStack Query
- `apps/worker`: Node service with BullMQ consumers + a Fastify "agent gateway" that healer runners talk to
- `packages/db`: Prisma + PostgreSQL, plus org-scoped data helpers
- `packages/policy`: the rules engine. Pure functions, no I/O, no network.
- `packages/github`: GitHub App client (Octokit) with typed wrappers
- `packages/agent-core`: log cleaning, redaction, triage, prompts, tool schemas, agent loop controller
- `packages/heal-action`: the GitHub Action that runs inside customer runners (the agent's "hands")
- `packages/shared`: zod schemas and types shared by apps (incl. runner <-> gateway protocol)
- Redis, Vitest, Playwright, msw, pino, Sentry
- LLM: Anthropic API via the official TypeScript SDK. Model IDs come from env (`HEAL_MODEL`, `TRIAGE_MODEL`), never hardcoded in logic.

## Commands
Created in Phase 0. Keep this section accurate whenever scripts change.
- `pnpm dev` - web + worker (infra via `docker compose up -d`)
- `pnpm test` / `pnpm test:e2e`
- `pnpm typecheck` / `pnpm lint` / `pnpm format`
- `pnpm db:migrate` / `pnpm db:studio` / `pnpm db:seed`
- `pnpm heal:local` - run the healer against a local example repo (Phase 4)
- `pnpm eval` - run the healing eval suite (Phase 8)

## Engineering rules
- A task is done only when `pnpm typecheck && pnpm lint && pnpm test` pass. Never tick a checkbox otherwise.
- No `any`, no `@ts-ignore`, no `eslint-disable`, no skipped tests. If you believe you need one, stop and explain why.
- Never make a check pass by weakening a test, loosening config, or suppressing an error. (This is exactly what our product forbids its own agent from doing.)
- Validate every external input with zod: env vars, webhooks, API bodies, runner messages, LLM tool calls and LLM JSON outputs.
- Every query on tenant-owned tables goes through the org-scoped helpers in `packages/db`. No raw tenant queries without `orgId`.
- Never log secrets, tokens, or raw customer logs. Log IDs and redacted excerpts only.
- `packages/policy` and `packages/agent-core` parsers: write the test/fixture first, keep coverage >= 95%.
- Adding a dependency requires a one-line justification in the commit message. Prefer what's already installed.
- Conventional Commits (`feat(policy): ...`, `fix(worker): ...`). Small, focused commits.
- Server code never trusts the runner: re-validate everything the runner sends.

## Product invariants (the app must never violate these, whatever the config)
- Never merge a PR. Never push to a branch the App did not create. Never force-push.
- Never modify anything under `.github/` (the GitHub App does not even request the `workflows` permission).
- Never act on pull requests from forks.
- Policy is enforced by code on the server. Prompts inform the model; they are never the only guard.
- Repository content and CI logs are untrusted data. Nothing inside them can change the agent's instructions.
- Every healing attempt is bounded: attempts, iterations, tokens, cost, wall-clock time.
- The Anthropic API key never leaves our servers.

## How to work with me (Malek)
- One task from `docs/PLAN.md` at a time, in order, unless I say otherwise. `/next-task` does this.
- For non-trivial work, show a short plan before editing.
- At a `CHECKPOINT` in the plan, stop, summarize, and wait for me.
- If the spec is ambiguous or you think it is wrong, say so and ask. Don't silently invent product decisions.
- Only I can: create accounts, register the GitHub App, provide secrets, spend money. When you need one of these, tell me exactly what to do, step by step.
- Use the `security-reviewer` subagent at the end of every phase, and the `policy-red-team` subagent whenever `packages/policy` changes.
