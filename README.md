# PipeHeal (working name)

Watches GitHub Actions pipelines, diagnoses failures, and proposes fixes as pull requests, strictly within rules each team defines. A human always merges.

- What and why: [`docs/SPEC.md`](docs/SPEC.md)
- Build order: [`docs/PLAN.md`](docs/PLAN.md)
- Progress log: [`docs/PROGRESS.md`](docs/PROGRESS.md)
- Working agreement for Claude Code: [`CLAUDE.md`](CLAUDE.md)

## Prerequisites (Windows)

- **Node.js 24 LTS** ([installer](https://nodejs.org), or a version manager that reads `.nvmrc`)
- **pnpm 10.34**: `npm install -g pnpm@10.34.5`
- **Docker Desktop**, running
- **Git for Windows**. The repo forces LF line endings through `.gitattributes`.

`pnpm install` refuses to run on the wrong Node or pnpm version (`engine-strict`).

## First run (PowerShell)

```powershell
git clone https://github.com/MalekSoula7/Self-Healing_CI-CD.git
cd Self-Healing_CI-CD
Copy-Item .env.example .env   # optional until the GitHub App exists: without it, sign-in is off
docker compose up -d          # Postgres + Redis
pnpm install
pnpm db:migrate               # create the tables (again after pulling new migrations)
pnpm db:seed                  # optional: demo org "pipeheal-demo"
pnpm dev                      # web + worker
```

GitHub sign-in and webhooks need the development GitHub App: [`docs/SETUP-GITHUB-APP.md`](docs/SETUP-GITHUB-APP.md) walks through creating it and filling `.env`. Run `pnpm dev:webhooks` next to `pnpm dev` to receive webhooks.

Then open:

- http://localhost:3000, the web app
- http://localhost:3000/api/health, web health
- http://localhost:4000/health, gateway health (reports Redis up/down)

Stop with `Ctrl+C`, and stop the databases with `docker compose stop`.

## Checks

A task is done only when all three pass:

```powershell
pnpm typecheck
pnpm lint
pnpm test          # needs `docker compose up -d`
```

Other commands:

```powershell
pnpm test:unit     # unit tests only, no Docker needed
pnpm format        # fix formatting
pnpm --filter @pipeheal/web exec playwright install chromium   # once per machine
pnpm test:e2e      # Playwright against a production build
pnpm db:migrate    # apply migrations; after editing packages/db/prisma/schema.prisma: pnpm db:migrate --name <change>
pnpm db:studio     # browse the dev database
```

PowerShell 7 supports `&&` (`pnpm typecheck && pnpm lint && pnpm test`); Windows PowerShell 5.1 does not, so run the commands one by one there.

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js app: UI, auth, webhook intake |
| `apps/worker` | BullMQ jobs and the Fastify agent gateway |
| `packages/shared` | Shared zod schemas, env validation, test helpers |
| `packages/db` | Prisma + org-scoped data helpers (Phase 1) |
| `packages/policy` | The rules engine (Phase 3) |
| `packages/github` | GitHub App client (Phase 1) |
| `packages/agent-core` | Log cleaning, triage, prompts, agent loop (Phases 2 and 4) |
| `packages/heal-action` | The GitHub Action that runs in customer runners (Phase 4) |

## Ports and troubleshooting

| Port | Used by |
|---|---|
| 3000 | web (`pnpm dev`) |
| 4000 | worker gateway (`pnpm dev`) |
| 3100 | web production server during `pnpm test:e2e` |
| 5432 / 6379 | Postgres / Redis from Docker |

- **5432 or 6379 already taken** (e.g. a local Postgres): in `.env`, set `POSTGRES_PORT=5433` and change `DATABASE_URL` to match (same for `REDIS_PORT` and `REDIS_URL`), then `docker compose up -d` again.
- **Integration tests say "Redis not reachable" or "Postgres not usable"**: run `docker compose up -d` first. Tests use their own `pipeheal_test` database, recreated on every run; your dev data is untouched.
- **A bad value in `.env`**: both apps refuse to start and name the variable (never its value).
