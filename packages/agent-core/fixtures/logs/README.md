# Real CI log samples (P2.3)

Unedited job logs, downloaded with the GitHub App from the demo repos on the sandbox org
(`examples/`, SPEC §14) after `pnpm break <scenario> --push` on 2026-09-28. They are the input the
triage pipeline gets from `downloadJobLog`: GitHub's timestamps, colour codes, group markers and
problem-matcher `##[error]` annotations included. Scanned for secrets before committing; the only
masked values (`***`) are GitHub's own masking of `actions/checkout`'s token input.

| File | Scenario / branch | Failed step | Tool output |
|---|---|---|---|
| `node-tsc-ts2305.log` | `node/type-error` | Typecheck | tsc TS2305 (renamed export) |
| `node-tsc-ts2304.log` | `node/missing-import` | Typecheck | tsc TS2304 |
| `node-tsc-ts2307.log` | `node/missing-dependency` | Typecheck | tsc TS2307 (`zod`) |
| `node-eslint.log` | `node/lint` | Lint | ESLint `no-unused-vars` |
| `node-vitest.log` | `node/logic-bug` | Test | Vitest, 5 failed tests |
| `node-npm-ci-lockfile.log` | `ci/add-dayjs` (package.json out of sync with the lockfile) | Install dependencies | `npm ci` EUSAGE |
| `python-ruff-i001.log` | `python/lint` | Lint | ruff I001 |
| `python-ruff-f821.log` | `python/missing-import` | Lint | ruff F821 |
| `python-mypy-attr-defined.log` | `python/type-error` | Typecheck | mypy `attr-defined` |
| `python-mypy-import-untyped.log` | `python/missing-dependency` | Typecheck | mypy `import-untyped` |
| `python-pytest.log` | `python/logic-bug` | Test | pytest, 1 failed test |
| `python-pip-no-matching-version.log` | `ci/bump-pytest` (`pytest==99.0.0`) | Install dependencies | pip, no matching distribution |
| `node-jest-local.txt` | none: no demo uses Jest | n/a | Jest 30's own output (`jest --ci`) on a failing `formatCents` test, run locally; no Actions framing |
