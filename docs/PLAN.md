# PipeHeal: Build Plan

How to use this file:
- Work top to bottom, one task at a time (`/next-task`).
- Tick a checkbox only when `pnpm typecheck && pnpm lint && pnpm test` pass and the task's acceptance criteria are met.
- After each task, append an entry to `docs/PROGRESS.md`.
- `CHECKPOINT` = stop, summarize what was built, list anything Malek must do, wait.
- `[HUMAN]` = something only Malek can do. Give him exact steps.

Phases 0–5 are the MVP (private beta). Phases 6–8 turn it into a product.

---

## Phase 0: Foundation

- [x] **P0.1** Monorepo: pnpm workspaces, Turborepo, shared `tsconfig` (strict), ESLint flat config, Prettier, folder layout from `CLAUDE.md` with empty packages that build.
- [x] **P0.2** `docker-compose.yml` for Postgres + Redis. `.env.example` listing every variable with a comment. Env validation with zod in each app (fail fast on startup).
- [x] **P0.3** `apps/web`: Next.js App Router skeleton, Tailwind, shadcn/ui, `/api/health`.
- [x] **P0.4** `apps/worker`: BullMQ connection, one sample queue + processor, Fastify gateway with `/health`, pino logger, graceful shutdown.
- [ ] **P0.5** Vitest across packages, Playwright skeleton in `apps/web`, msw for HTTP mocking.
- [ ] **P0.6** CI for this repo (`.github/workflows/ci.yml`): install, typecheck, lint, test on push and PR, with caching. Full suite on `ubuntu-latest`, unit tests also on `windows-latest` (SPEC §4.1).
- [ ] **P0.7** Fill the Commands section of `CLAUDE.md`, create `docs/PROGRESS.md` first entry.

Acceptance: fresh clone → `docker compose up -d && pnpm i && pnpm dev` works; all checks green locally and in CI.

**CHECKPOINT 0**: show the tree, how to run it, and any deviations from the spec.

---

## Phase 1: Tenancy, auth, GitHub App

- [ ] **P1.1** Prisma schema for `User` (plus Better Auth's tables), `Organization`, `Membership`, `Repository`, `RepoWorkflow`, `AuditLog`, `WebhookDelivery` (SPEC §10). Migration + seed script.
- [ ] **P1.2** Org-scoped data helpers in `packages/db`. Tests proving a user of org A cannot read or write org B's rows through any helper.
- [ ] **P1.3** Better Auth with GitHub provider; session carries `userId`; `proxy.ts` redirects signed-out users on `/[org]/**`; org membership check in every org layout, route handler and data helper (never the proxy alone). Verified-installer OWNER binding on sign-in (SPEC §5.2).
- [ ] **P1.4** `packages/github`: App JWT, installation token cache, typed wrappers for the endpoints we use (list failed jobs, download job logs, compare commits, get file contents at ref, re-run failed jobs, dispatch workflow, Git Data API, create PR, comment, request reviewers). msw-based tests.
- [ ] **P1.5** `docs/SETUP-GITHUB-APP.md`: exact permissions and events from SPEC §5.1, callback/webhook URLs, smee forwarding for local dev, which `.env` values come from where.
- [ ] **CHECKPOINT 1a [HUMAN]**: Malek creates a GitHub sandbox organization, registers the dev GitHub App, fills `.env`.
- [ ] **P1.6** Webhook route: HMAC verification, delivery-ID idempotency, enqueue, fast 2xx. Processors for `installation` and `installation_repositories` → upsert `Organization` (org or personal account), `Repository`, `RepoWorkflow`; the installing user becomes the OWNER candidate, confirmed on sign-in (SPEC §5.2).
- [ ] **P1.7** Onboarding UI: "Install GitHub App" → post-install callback → repo list with enable toggles → per-repo workflow selection with CI-looking workflows pre-selected (SPEC §11).
- [ ] **P1.8** Audit log entries for every mutation (who, what, when).

Acceptance: installing the App on the sandbox org shows the org and repos in the dashboard; removing a repo from the installation disables it; tenant isolation tests pass.

**CHECKPOINT 1b**

---

## Phase 2: Detection & triage (no fixing yet)

- [ ] **P2.0** `examples/demo-node` (TypeScript + Vitest + ESLint) and `examples/demo-python` (pytest + ruff + mypy), each with a CI workflow emitting JUnit XML, plus `scripts/break.ts <scenario>` (TypeScript via `tsx`, no bash) that introduces each eval scenario from SPEC §14 on a new branch.
- [ ] **CHECKPOINT 2a [HUMAN]**: Malek pushes the demo repos to the sandbox org and installs the App on them.
- [ ] **P2.1** `workflow_run` processor: filters from SPEC §2 step 4, one `PipelineFailure` per repo + head SHA with `FailedRun`/`FailedJob`, collection window, late arrivals and re-runs (SPEC §2.1).
- [ ] **P2.2** Log fetch + clean + redact (`packages/agent-core/redact`). Fixture tests with planted fake secrets of every type in SPEC §6.2.
- [ ] **P2.3** Error-window extractor and signal parsers for tsc, eslint, jest/vitest, pytest, mypy, ruff, pip/npm install errors. Real log samples in `packages/agent-core/fixtures/logs/`, test-first.
- [ ] **P2.4** Heuristic classifier + `TRIAGE_MODEL` fallback with zod-validated JSON and one retry. Cost recorded.
- [ ] **P2.5** Last-green resolver + recent-changes fetcher with token-budget truncation.
- [ ] **P2.6** Flaky check: re-run failed jobs once when `retryBeforeHeal` is on, with the guards in SPEC §6.2 step 8 (selected workflows only, never with `environment:`); link the re-run's result to the failure.
- [ ] **P2.7** UI: failures list and detail page (category, summary, error window, signals, recent changes).

Acceptance: each `break.ts` scenario shows up within ~1 minute and has the right category once its collection window closes; no planted secret appears in the DB or logs.

**CHECKPOINT 2b**

---

## Phase 3: Policy engine (the core of the product)

- [ ] **P3.1** `PolicyRules` zod schema, defaults, invariants as code (SPEC §8.2–8.3). Export types.
- [ ] **P3.2** Diff model: build `Change { path, oldPath, status, isBinary, modeChanged, oldContent, newContent, hunks }` from old/new file contents. Tests.
- [ ] **P3.3** Layer merge with provenance (SPEC §8.4). Property-based tests (fast-check): the merged policy is never less restrictive than any layer.
- [ ] **P3.4** Static checks, one module per family (SPEC §8.5), each with allowed and forbidden fixtures in `packages/policy/fixtures/`. Test-first.
- [ ] **P3.5** Behavioral checks: JUnit parser + inventory comparison (SPEC §8.6). Fixtures from Jest, Vitest and pytest reports.
- [ ] **P3.6** Run the `policy-red-team` subagent. Turn every bypass it finds into a failing fixture, then fix the engine. Repeat until it finds nothing new.
- [ ] **P3.7** `.pipeheal.yml` loader from the default branch, validated; errors shown in the UI, never crash the pipeline.
- [ ] **P3.8** Policy UI: org defaults, repo overrides, effective policy with provenance, version history.
- [ ] **P3.9** Custom rules: plain-language → structured compiler, confirmation UI, `code` vs `judge` labels (judge runs in P4.7).
- [ ] **P3.10** Dry run: evaluate a policy against a pasted diff.

Acceptance: coverage ≥ 95% on `packages/policy`; all red-team fixtures rejected; admin can edit policy and see the effective result.

**CHECKPOINT 3**: review the default rules and red-team findings with Malek.

---

## Phase 4: Healing agent

- [ ] **P4.1** `packages/shared`: runner ↔ gateway protocol schemas (session exchange, step request/response with `stepSeq`, tool calls/results, submission payload).
- [ ] **P4.2** Gateway `POST /v1/session`: OIDC verification per SPEC §5.4. Tests with locally generated keys and JWTs, including every rejection path.
- [ ] **P4.3** Gateway `POST /v1/step`: accept tool results, run the next model turn, return tool calls; persist `AgentEvent`s; enforce caps; idempotent on `stepSeq`.
- [ ] **P4.4** `packages/agent-core`: prompt builder (SPEC §7.4, versioned), tool definitions, context assembler, loop controller with all stop conditions, cost accounting, prompt caching on the static prefix.
- [ ] **P4.5** `packages/heal-action`: JavaScript action bundled to `dist/`. OIDC exchange, install, reproduce, baseline JUnit, tool executor (path-traversal protection, output truncation, commands only from config, args as arrays), final checks, submission upload.
- [ ] **P4.6** Local mode: `pnpm heal:local --repo examples/demo-node --scenario <name>` runs the same executor inside a Linux Docker container against a local copy of the repo and a local gateway. A dev CLI creates a real attempt and session token; there is no auth bypass (SPEC §12). This is the main dev loop for agent work.
- [ ] **P4.7** Soft-rule judge (SPEC §8.7 step 3).
- [ ] **P4.8** Dispatcher: healable + in scope + within budget → create `HealAttempt` → `workflow_dispatch` on the default branch. Missing workflow → `NEEDS_SETUP`.

Acceptance: local mode fixes at least 4 of the 6 fixable demo scenarios; both trap scenarios end in a code fix or `give_up`, never a test change or deletion; every iteration is visible in the DB.

**CHECKPOINT 4**: demo local mode to Malek; review the system prompt and a few full transcripts together.

---

## Phase 5: PRs & verification loop (MVP complete)

- [ ] **P5.1** Submission validation: fetch originals at `target_sha` from GitHub, recompute the diff, run static + behavioral + judge. Never use the runner's diff as truth.
- [ ] **P5.2** Branch, commit and PR via Git Data API; PR body template (SPEC §9); label; reviewer request; draft rule; link comment on the originating PR.
- [ ] **P5.3** Verification: map `workflow_run` on `pipeheal/*` to its attempt; `VERIFIED`, retry-with-feedback, or `NEEDS_HUMAN` + comment; `UNVERIFIED` timeouts and the delivery reconciler (SPEC §2.2).
- [ ] **P5.4** Outcome tracking from `pull_request` closed events.
- [ ] **P5.5** Concurrency and loop protection (SPEC §9.1), with tests for each case.
- [ ] **P5.6** Failure detail timeline UI: attempts, iterations, tool calls, diff viewer, policy results, PR link, cost.
- [ ] **P5.7** `docs/E2E.md`: a manual end-to-end checklist on the sandbox org, then run it.
- [ ] **P5.8** Run the `security-reviewer` subagent on everything built so far; fix findings.

Acceptance: on real GitHub, `break.ts` → PR opened → PR CI green → human merges. No branch other than `pipeheal/*` is ever written. Nothing under `.github/` is ever changed.

**CHECKPOINT 5**: MVP ready for private beta.

---

## Phase 6: Product polish

- [ ] **P6.1** Dashboard metrics: failures, heals, merge rate, cost, categories over time.
- [ ] **P6.2** Onboarding auto-detection of commands and healer YAML setup steps; "Verify setup" dry run.
- [ ] **P6.3** Manual actions: "Heal this failure", "Diagnose only", "Cancel attempt" (ADMIN+).
- [ ] **P6.4** Feedback on PRs (useful / not useful + reason) stored per attempt.
- [ ] **P6.5** Notifications: email and Slack webhook for `PR_OPENED` and `NEEDS_HUMAN`.
- [ ] **P6.6** Members & roles UI, invitations.
- [ ] **P6.7** Landing page with waitlist.

---

## Phase 7: Metering & billing

- [ ] **P7.1** `UsageRecord` roll-ups, budget UI, hard stops when budgets are hit (with a clear dashboard message).
- [ ] **P7.2** **[HUMAN]** Stripe account. Then Checkout, Customer Portal, webhook handling, plan limits wired into policy caps.
- [ ] **P7.3** Free tier limits.

---

## Phase 8: Evals, hardening, launch

- [ ] **P8.1** `pnpm eval` harness (SPEC §14) with a report and comparison to the previous run; gate prompt/model changes on it in CI.
- [ ] **P8.2** Rate limits (webhooks, gateway, API), retention purge job, DB backups.
- [ ] **P8.3** Observability: Sentry, structured logs, OpenTelemetry traces across webhook → triage → attempt → PR.
- [ ] **P8.4** Full `security-reviewer` pass + manual checklist from SPEC §12.
- [ ] **P8.5** Production deploy: Docker images, migrations on deploy, health checks, zero-downtime rollout, runbook in `docs/RUNBOOK.md`.
- [ ] **P8.6** Publish `heal-action` in its own public repo with version tags.
- [ ] **P8.7** **[HUMAN]** Privacy policy and ToS drafts, reviewed by a lawyer before public launch.
- [ ] **P8.8** Dogfood: install PipeHeal on this repository.
