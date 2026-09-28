# pipeheal-demo-node

A small TypeScript checkout library (money formatting, cart totals, receipts) with the usual
checks, used to try PipeHeal on real CI failures.

```sh
npm ci
npm run typecheck
npm run lint
npm test
```

CI (`.github/workflows/ci.yml`) runs the same checks on every push and pull request, and uploads
the Vitest results as JUnit XML (`reports/junit.xml`).
