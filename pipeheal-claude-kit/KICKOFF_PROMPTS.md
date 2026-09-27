# PipeHeal: Claude Code prompts

## Setup (once)

1. Create an empty private GitHub repo, clone it.
2. Copy this kit into the repo root: `CLAUDE.md`, `docs/`, `.claude/`. Keep this file outside the repo or delete it later.
3. `git add . && git commit -m "chore: project spec and plan"`
4. Start Claude Code in the repo root: `claude`

Claude Code loads `CLAUDE.md` automatically. The spec and plan live in files, so never paste them into the chat. Point Claude at them.

---

## Prompt 1: Alignment (first session, no code)

```
You are the lead engineer on PipeHeal. Read CLAUDE.md, docs/SPEC.md and docs/PLAN.md in full.
Do not write any code in this session.

1. Explain the architecture back to me in at most 15 lines, including why the agent's
   "brain" runs on our server and its "hands" run in the customer's runner.
2. List the 5 biggest technical risks you see, and how the plan handles each one (or doesn't).
3. List anything in the spec that is ambiguous, contradictory, outdated (library versions,
   GitHub API details), or that you would do differently, with your reasoning.
4. Interview me: ask your most important open questions, one at a time, and wait for my answer
   before asking the next. Stop when you have what you need for Phases 0 to 2.
5. Update docs/SPEC.md with the decisions we agree on, and add a PROGRESS.md entry.
```

When it finishes: review the SPEC diff, commit, then `/clear`.

---

## Prompt 2: Start a phase (repeat for each phase)

Switch to plan mode first (Shift+Tab until the mode shows plan mode), then:

```
We are starting Phase <N> of docs/PLAN.md. Read docs/PROGRESS.md for where we are.

Make a plan for the whole phase:
- the order you will do the tasks in and why
- for each task: files you will create or change, tests you will write, and how you will
  prove the acceptance criteria are met
- anything you need from me ([HUMAN] steps, secrets, accounts), listed up front
- risks or spec questions for this phase

Don't start implementing until I approve the plan.
```

After you approve, leave plan mode and run `/next-task` repeatedly. Each run does one task, tests it, commits, ticks the box, and logs progress. It stops by itself at checkpoints.

---

## Prompt 3: End of phase review

```
Phase <N> is done. Before we close it:
1. Use the security-reviewer subagent on `git diff <phase-start-commit>...HEAD` and fix every
   critical and high finding.
2. (Phase 3 onward) Use the policy-red-team subagent and turn every bypass into a failing
   fixture, then fix the engine.
3. Prove it works: walk me through the acceptance criteria one by one with evidence
   (test names, commands I can run, screenshots or output).
4. List shortcuts or tech debt you took, and add them to PROGRESS.md as follow-ups.
```

Then commit, tag (`git tag phase-<N>`), `/clear`.

---

## Prompt 4: Resume after a break or a `/clear`

```
Read CLAUDE.md, docs/PROGRESS.md, and the current phase in docs/PLAN.md.
Tell me in 5 lines where we are and what the next task is. Then wait.
```

---

## Prompt 5: When quality slips

Use one of these instead of patching a bad result line by line:

```
Stop. This is getting complicated. Knowing everything you know now, throw away this approach
and propose the simplest design that meets the acceptance criteria. Plan first, no code.
```

```
Before you call this done, convince me it works: show the failing test you wrote first, the
passing run, and the edge cases you checked. If you can't, it isn't done.
```

```
You changed a test / config / added a suppression to make this pass. Revert that and fix the
actual cause.
```

---

## Prompt 6: Agent quality work (Phase 4 and later)

```
Run `pnpm heal:local` on every scenario in examples/ and show me a table: scenario, outcome,
iterations, tokens, cost, and any policy violations the agent attempted. For each failure,
read the transcript and tell me whether the problem is the prompt, the tools, the context,
or the policy. Propose one change at a time, re-run, and compare.
```

---

## Session habits that matter

- One phase per session. `/clear` between phases; `PROGRESS.md` carries the memory.
- Always plan mode at the start of a phase and for any task that touches more than a few files.
- Commit after every task so you can roll back cheaply.
- Read the diffs, especially in `packages/policy` and the gateway. This is a security product; you are the final reviewer, exactly like your customers will be.
- Don't run Claude Code with permission checks disabled on your main machine. Allowlist the commands you trust (pnpm, git, docker compose) in `.claude/settings.json` instead.
