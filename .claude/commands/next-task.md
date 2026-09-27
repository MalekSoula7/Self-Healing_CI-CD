---
description: Do the next unchecked task from docs/PLAN.md (optionally pass a task ID)
---
Read docs/PROGRESS.md, then docs/PLAN.md. Requested task (may be empty): $ARGUMENTS

1. Pick the requested task, or else the first unchecked task in the current phase. If it is a CHECKPOINT or [HUMAN] item, stop and tell me exactly what I need to do.
2. Restate the task and its acceptance criteria. Read the SPEC sections it depends on.
3. If anything is ambiguous or you disagree with the spec, ask me before coding.
4. Show a short plan: files to create or change, tests to write.
5. Implement. For policy code and log parsers, write fixtures and tests first.
6. Run `pnpm typecheck && pnpm lint && pnpm test` and fix until green. Never weaken a test, skip a test, or add a suppression to get green.
7. Commit (Conventional Commits), tick the checkbox in docs/PLAN.md, append an entry to docs/PROGRESS.md.
8. If the next item is a CHECKPOINT, stop and give me a summary: what was built, how to try it, deviations from the spec, what I must do next.
