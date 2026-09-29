# Setting up the development GitHub App

This is CHECKPOINT 1a in `docs/PLAN.md`. Only Malek can do these steps: they create accounts and secrets. The result is a filled-in `.env` and a sandbox where PipeHeal can be tried end to end.

Everything here is for **development**. Production gets its own App later, with its own keys.

GitHub's settings pages change wording from time to time. If a label below doesn't match exactly, look for the closest one. The permissions and events are what matter; they come from `docs/SPEC.md` §5.1.

## 1. Create a sandbox organization

1. On github.com: your avatar → **Your organizations** → **New organization** → the **Free** plan.
2. Name it something like `pipeheal-sandbox-malek`. It will only hold test repos.

A sandbox keeps PipeHeal away from your real repositories while it is being built. The demo repos from Phase 2 go here.

## 2. Create a smee.io channel (webhook forwarding)

GitHub can't reach `localhost`. smee.io receives the webhooks and `pnpm dev:webhooks` relays them to your machine.

1. Open https://smee.io/new. You land on a page with a URL like `https://smee.io/aBcDeF123`.
2. Keep that URL for the App's webhook URL (step 3) and for `SMEE_URL` (step 5).

Treat this URL like a password: anyone who has it can read the webhooks sent to it.

## 3. Register the GitHub App

Open **the sandbox organization** → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**, and fill it in:

| Setting | Value |
|---|---|
| GitHub App name | `pipeheal-dev-malek` (must be unique on GitHub) |
| Homepage URL | `http://localhost:3000` |
| Callback URL | `http://localhost:3000/api/auth/callback/github` |
| Expire user authorization tokens | **checked** (the default; PipeHeal refreshes them) |
| Request user authorization (OAuth) during installation | **unchecked** (sign-in has its own flow, and this option disables the Setup URL) |
| Enable Device Flow | unchecked |
| Setup URL | `http://localhost:3000/onboarding/installed` |
| Redirect on update | **checked** |
| Webhook: Active | **checked** |
| Webhook URL | your smee.io URL from step 2 |
| Webhook secret | a new random secret (see "Generating secrets" below). Keep it for `GITHUB_WEBHOOK_SECRET`. |
| SSL verification | **Enabled** |

### Permissions

**Repository permissions.** Set exactly these; everything else stays **No access**:

| Permission | Access | Why |
|---|---|---|
| Actions | Read and write | read logs, dispatch the healer workflow, re-run failed jobs |
| Contents | Read and write | create `pipeheal/*` branches and commits |
| Pull requests | Read and write | open PRs, comment, request reviewers |
| Checks | Read-only | read check results |
| Metadata | Read-only | mandatory for every App |
| **Workflows** | **No access** | on purpose: GitHub then refuses any App commit to `.github/workflows/` |

**Organization permissions.** Set exactly this; everything else stays **No access**:

| Permission | Access | Why |
|---|---|---|
| Members | Read-only | at sign-in, confirm the person who installed the App is an admin of the organization before making them OWNER (D10). PipeHeal doesn't sync members. |

**Account permissions:** Email addresses: **Read-only**. Sign-in needs your email (decision D9).

### Events

Subscribe to:
- **Workflow run**
- **Pull request**

`installation` and `installation_repositories` events reach every App automatically; they have no checkbox.

### Where can this GitHub App be installed?

**Only on this account**, so the development App can only ever be installed on the sandbox.

Click **Create GitHub App**.

## 4. Collect the App's credentials

The App's **General** page now shows:

1. **App ID**: a number. This is `GITHUB_APP_ID`.
2. **Client ID**: starts with `Iv`. This is `GITHUB_CLIENT_ID`.
3. **Client secrets** → **Generate a new client secret**. GitHub shows it once. This is `GITHUB_CLIENT_SECRET`.
4. **Private keys** (at the bottom) → **Generate a private key**. A `.pem` file downloads. Encode it on one line for `GITHUB_APP_PRIVATE_KEY` (PowerShell, in the folder with the file):

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("pipeheal-dev-malek.2026-09-27.private-key.pem"))
   ```

   Then move the `.pem` file into your password manager and delete it from Downloads. Never put it in the repo folder (`*.pem` is git-ignored as a safety net).
5. The App's public page is `https://github.com/apps/<slug>`. The `<slug>` is `GITHUB_APP_SLUG`.

## 5. Fill in `.env`

In the repo root:

```powershell
Copy-Item .env.example .env   # skip if you already have one
```

Then set:

| Variable | Value |
|---|---|
| `BETTER_AUTH_SECRET` | a new random secret (below). It signs sessions and encrypts stored GitHub tokens. |
| `GITHUB_APP_ID` | step 4.1 |
| `GITHUB_APP_SLUG` | step 4.5 |
| `GITHUB_APP_PRIVATE_KEY` | step 4.4 (the long base64 line) |
| `GITHUB_WEBHOOK_SECRET` | the webhook secret from step 3 |
| `GITHUB_CLIENT_ID` | step 4.2 |
| `GITHUB_CLIENT_SECRET` | step 4.3 |
| `SMEE_URL` | step 2 |

Leave `APP_URL=http://localhost:3000` and the database and Redis defaults as they are.

### Generating secrets

Run this once per secret (it works in PowerShell):

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Never paste secrets into chats, issues or commits. If one leaks, regenerate it on the App's page (client secret, private key, webhook secret), or generate a new `BETTER_AUTH_SECRET`, which signs everyone out.

## 6. Check that it works

```powershell
docker compose up -d
pnpm db:migrate
pnpm dev
```

1. Open http://localhost:3000/login. The button reads **Sign in with GitHub**. If the page says sign-in isn't configured instead, a value is missing from `.env`; restart `pnpm dev` after fixing it.
2. Sign in. GitHub asks you to authorize the App and lists **Email addresses (read)** (and organization **Members (read)** once the App is installed). You come back to the PipeHeal home page, which says you don't belong to an organization yet. That is expected: the App isn't installed anywhere.
3. In a second terminal:

   ```powershell
   pnpm dev:webhooks
   ```

   It prints `relaying webhooks`. On the App's page → **Advanced** → **Recent Deliveries**, redeliver the `ping` delivery. The relay prints `delivery forwarded` with `status: 404`. The webhook route comes in P1.6, so 404 is expected for now.

Don't install the App on the sandbox yet. P1.6 builds the webhook processing that turns an installation into a PipeHeal organization. (Installing earlier does no harm: those deliveries can be redelivered from the same Advanced tab.)

## Troubleshooting

- **"The redirect_uri is not associated with this application"**: the Callback URL in step 3 must be exactly `http://localhost:3000/api/auth/callback/github`.
- **Back on /login with "GitHub didn't share an email address"**: the App lacks **Email addresses: Read-only**, or you authorized the App before it was added. Add the permission, then on github.com go to **Settings** → **Applications** → **Authorized GitHub Apps**, revoke the App, and sign in again.
- **`pnpm dev:webhooks` says `SMEE_URL` is invalid**: it must be the `https://smee.io/...` URL from step 2.
- **Webhook deliveries fail signature checks (from P1.6 on)**: `GITHUB_WEBHOOK_SECRET` must equal the App's webhook secret. smee.io re-encodes the JSON body, so a rare delivery with unusual characters may still fail in development only. Production doesn't use smee.
