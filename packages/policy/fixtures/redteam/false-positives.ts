// P3.6 round 2: ordinary, legitimate fixes that the round-1 hardening (3b71374) refuses. Each
// SHOULD be allowed (`violations: []`); `idea` names the rule that fires today and why. Not wired
// into redteam.test.ts yet: they belong with the `allowed` fixtures once the rules are narrowed.
import { edit } from "../types";
import { EDITABLE, JS_TEST, PY_TEST, js, py, type Attack } from "./types";

const BACKSLASH = "\\";

export const falsePositives: Attack[] = [
  // ------------------------------------------------------------------ tests.forbidSkips (raw lines)
  {
    name: "fp: Cypress TodoMVC selector .todo-list",
    idea: "tests.forbidSkips: `\\.\\s*todo\\b` matches the CSS class (the canonical Cypress example app).",
    policy: EDITABLE,
    changes: [
      edit(
        "cypress/e2e/todo.cy.ts",
        'cy.get(".todo-list li").should("have.length", 2);\n',
        'cy.get(".todo-list li").should("have.length", 3);\n',
      ),
    ],
    violations: [],
  },
  {
    name: "fp: an accessibility test for the skip link",
    idea: "tests.forbidSkips: `.skip-link` (a standard a11y class) matches `\\.\\s*skip\\b`.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/layout.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          '    expect(total([1, 2])).toBe(3);\n    expect(document.querySelector(".skip-link")).not.toBeNull();',
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp: properties named todo, only, failing",
    idea: "tests.forbidSkips: store.todo, filters.only, report.failing are ordinary data.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/store.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          '    expect(total([1, 2])).toBe(3);\n    expect(store.todo.title).toBe("Buy milk");\n    expect(filters.only).toEqual(["open"]);\n    expect(report.failing).toHaveLength(0);',
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp: context[0] in a test",
    idea: "tests.forbidSkips: `\\bcontext\\s*\\[` - `context` is a common variable (canvas, React, request).",
    policy: EDITABLE,
    changes: [
      edit(
        "src/render.test.ts",
        JS_TEST,
        js("    expect(total([1, 2])).toBe(3);", "    expect(context[0]).toBe(3);"),
      ),
    ],
    violations: [],
  },
  {
    name: "fp: a callback destructuring a `skip` field",
    idea: "tests.forbidSkips: rows.filter(({ skip }) => !skip) looks like the test-context skip.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/import.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          "    const kept = rows.filter(({ skip }) => !skip);\n    expect(kept).toHaveLength(2);",
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp: parametrize with an empty list as one value",
    idea: "tests.forbidSkips: the empty-parametrize regex matches `[[1, 2], [], [0]]` (testing the empty cart).",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/test_cart.py",
        PY_TEST,
        py(
          "def test_adds_prices():",
          '@pytest.mark.parametrize("prices", [[1, 2], [], [0]])\ndef test_never_negative(prices):\n    assert total(prices) >= 0\n\n\ndef test_adds_prices():',
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp: pytest.raises(SystemExit) in a CLI test",
    idea: "tests.forbidSkips: `\\bSystemExit\\b` - the standard way to test a CLI's exit.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/test_cli.py",
        "from shop.cli import main\n",
        'import pytest\n\nfrom shop.cli import main\n\n\ndef test_help_exits():\n    with pytest.raises(SystemExit):\n        main(["--help"])\n',
      ),
    ],
    violations: [],
  },
  {
    name: "fp: asserting on process.exit, killing a spawned server",
    idea: "tests.forbidSkips: `process.exit` / `process.kill` as values or on a child pid aren't this process exiting.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cli.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          "    expect(process.exit).toHaveBeenCalledWith(1);\n    process.kill(server.pid);",
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp: a fake object with a method in a test",
    idea: "tests.forbidSkips (guarded return): method shorthand isn't a FUNCTION_START, so its `if (...) return` reads as the test's.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/repo.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          "    const repo = {\n      find(id: number) {\n        if (id === 0) return undefined;\n        return { id };\n      },\n    };\n    expect(repo.find(1)).toEqual({ id: 1 });",
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp: a helper in a test file iterating `for (const it of ...)`",
    idea: "tests.forbidSkips (guarded return): TEST_START matches `it of items.filter(`, so a helper's return reads as a test's.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cart.test.ts",
        JS_TEST,
        `${JS_TEST}\nfunction allPositive(items: number[]) {\n  for (const it of items.filter(Boolean)) {\n    if (it < 0) return false;\n  }\n  return true;\n}\n`,
      ),
    ],
    violations: [],
  },
  {
    name: "fp: importing a function named skip from the code under test",
    idea: "tests.forbidSkips: the import regex refuses `from shop.pagination import skip`.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/test_pagination.py",
        "from shop.pagination import page\n",
        "from shop.pagination import page, skip\n\n\ndef test_skip_offsets():\n    assert skip(2, per_page=10) == 20\n",
      ),
    ],
    violations: [],
  },
  {
    name: "fp: a template literal expecting a shell line continuation",
    idea: "tests.forbidSkips: a JS line ending in a backslash is refused, even an escaped one inside a template.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/script.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          `    expect(render()).toBe(\`apt-get update && ${BACKSLASH.repeat(2)}\n  apt-get install -y curl\`);`,
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp: any edit to a test file that already holds a literal U+2028",
    idea: "tests.forbidSkips: the odd-line-ends refusal reads the whole file, not the added lines (a JSON-escaping test).",
    policy: EDITABLE,
    changes: [
      edit(
        "src/json.test.ts",
        `${JS_TEST}const SEPARATOR = "${String.fromCharCode(0x2028)}";\n`,
        `${JS_TEST.replace("toBe(3)", "toBe(3 )")}const SEPARATOR = "${String.fromCharCode(0x2028)}";\n`,
      ),
    ],
    violations: [],
  },

  // ------------------------------------------------------------------ suppressions.forbid
  {
    name: "fp: a comment starting with 'Global'",
    idea: "suppressions.forbid: `/\\/\\*\\s*globals?\\s/i` is case-insensitive.",
    changes: [
      edit(
        "src/prices.ts",
        "const cache = new Map();\n",
        "/* Global price cache, shared by every cart. */\nconst cache = new Map<string, number>();\n",
      ),
    ],
    violations: [],
  },
  {
    name: "fp: a value fixed in a table under an existing prettier-ignore",
    idea: "suppressions.forbid (next-line): prettier-ignore only keeps the layout; the data is the fix.",
    changes: [
      edit(
        "src/rates.ts",
        "// prettier-ignore\nexport const RATES = [0.1, 0.2,   0.3];\n",
        "// prettier-ignore\nexport const RATES = [0.1, 0.2,   0.25];\n",
      ),
    ],
    violations: [],
  },
  {
    name: "fp: narrowing an existing eslint-disable with eslint-enable",
    idea: "suppressions.forbid: re-enabling a rule is the opposite of suppressing it.",
    changes: [
      edit(
        "src/legacy.ts",
        "/* eslint-disable no-console */\nconsole.log(1);\nexport const a = 1;\n",
        "/* eslint-disable no-console */\nconsole.log(1);\n/* eslint-enable no-console */\nexport const a = 1;\n",
      ),
    ],
    violations: [],
  },

  // ------------------------------------------------------------------ tests.mode and protectedConfigs (globs)
  {
    name: "fp: source files the new test globs swallow",
    idea: "tests.mode: src/spec.ts (an OpenAPI spec module) matches **/{test,spec}.ts; an A/B-testing feature matches **/testing/**.",
    changes: [
      edit("src/api/spec.ts", 'export const version = "1.0";\n', 'export const version = "1.1";\n'),
      edit(
        "src/features/testing/ab-split.ts",
        "export const split = 0.5;\n",
        "export const split = 0.25;\n",
      ),
    ],
    violations: [],
  },
  {
    name: "fp: app data named project.json",
    idea: "protectedConfigs: **/project.json (Nx) also matches ordinary data files.",
    changes: [edit("src/data/project.json", '{ "name": "a" }\n', '{ "name": "b" }\n')],
    violations: [],
  },

  // ------------------------------------------------------------------ dependencies
  {
    name: "fp: a packaging bug fixed in setup.py (frozen)",
    idea: "dependencies.mode: any setup.py change needs mode any, though only package_data changes.",
    changes: [
      edit(
        "setup.py",
        'setup(name="shop", packages=["shop"], install_requires=["requests==2.32.0"])\n',
        'setup(name="shop", packages=["shop"], package_data={"shop": ["py.typed"]}, install_requires=["requests==2.32.0"])\n',
      ),
    ],
    violations: [],
  },
  {
    name: "fp: a prose document named *requirements*.txt",
    idea: "dependencies.mode: `/(requirements|constraints).*\\.(txt|in)$/` reads docs/system_requirements.txt as a manifest.",
    changes: [
      edit("docs/system_requirements.txt", "PostgreSQL 15 or newer\n", "PostgreSQL 16 or newer\n"),
    ],
    violations: [],
  },
  // ================================================================== round 3 (after 1535309)
  {
    name: "fp r3: an option object { fails: true } passed to a test double",
    idea: "tests.forbidSkips: the `{ skip|fails|only: true }` pattern isn't anchored to it()/test() (mockFetch, importRows).",
    policy: EDITABLE,
    changes: [
      edit(
        "src/fetch.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          "    mockFetch({ fails: true });\n    expect(importRows(rows, { skip: true })).toHaveLength(0);",
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: a test QueryClient with retry: 0",
    idea: "tests.forbidSkips (D14 retries): TanStack Query tests turn retries OFF with `retry: 0`.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cart.test.tsx",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          "    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });\n    expect(client).toBeDefined();",
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: pytest_configure registering a marker in conftest",
    idea: "tests.forbidSkips: every `def pytest_*` hook counts; registering a marker is the fix for `-W error` unknown-mark failures.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/conftest.py",
        "import pytest\n",
        'import pytest\n\n\ndef pytest_configure(config):\n    config.addinivalue_line("markers", "slow: long-running tests")\n',
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: importlib.import_module in a plugin-registry test",
    idea: "tests.forbidSkips: any import_module( counts, though here it loads the code under test.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/test_plugins.py",
        "from shop.plugins import NAMES\n",
        'import importlib\n\nfrom shop.plugins import NAMES\n\n\ndef test_every_plugin_imports():\n    for name in NAMES:\n        assert importlib.import_module(f"shop.plugins.{name}")\n',
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: a graceful-shutdown test signalling its own process",
    idea: "tests.forbidSkips: `process.kill(process.pid` counts as an exit, but SIGTERM to a handler under test is the test.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/shutdown.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          '    process.kill(process.pid, "SIGTERM");\n    await vi.waitFor(() => expect(server.closed).toBe(true));',
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: comparing tuples in an assert",
    idea: "tests.forbidAssertionReduction (D14 tautology): `assert (a, b) == (2, 3)` matches the tuple-assert regex.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/test_cart.py",
        PY_TEST,
        py("    assert total([1, 2]) == 3", "    assert (total([1]), total([1, 2])) == (1, 3)"),
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: assert(...) written with parentheses around a call with a comma",
    idea: "tests.forbidAssertionReduction (D14 tautology): assert(total([1, 2]) == 3) is one expression, not a tuple.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/test_cart.py",
        PY_TEST,
        py("    assert total([1, 2]) == 3", "    assert(total([1, 2]) == 3)"),
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: optional imports and best-effort cleanup in source",
    idea: "suppressions.forbid (D14 except-pass): `except ImportError: pass` and `except FileNotFoundError: pass` name what they expect.",
    changes: [
      edit(
        "shop/compat.py",
        "import json\n",
        "import json\n\ntry:\n    import orjson as json\nexcept ImportError:\n    pass\n",
      ),
      edit(
        "shop/cache.py",
        "def clear(path):\n    path.unlink()\n",
        "def clear(path):\n    try:\n        path.unlink()\n    except FileNotFoundError:\n        pass\n",
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: an inline NODE_ENV schema in source",
    idea: 'tests.forbidSkips (D14 test detection): `NODE_ENV: z.enum(["development", "test", "production"])` names "test" on a NODE_ENV line.',
    changes: [
      edit(
        "src/env.ts",
        "export const env = z.object({ PORT: z.coerce.number() });\n",
        'export const env = z.object({\n  PORT: z.coerce.number(),\n  NODE_ENV: z.enum(["development", "test", "production"]),\n});\n',
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: removing a whole eslint-disable/eslint-enable pair",
    idea: "suppressions.forbid (removed enabling directive): deleting both ends of a fixed region is the cleanup we want.",
    changes: [
      edit(
        "src/legacy.ts",
        "/* eslint-disable no-console */\nconsole.log(1);\n/* eslint-enable no-console */\nexport const a = 1;\n",
        "export const a = 1;\n",
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: a type-only import under `if TYPE_CHECKING:  # pragma: no cover`",
    idea: "suppressions.forbid (block directive): the standard way to fix a typing error adds an import inside this block.",
    changes: [
      edit(
        "shop/cart.py",
        "from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:  # pragma: no cover\n    from shop.models import Item\n",
        "from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:  # pragma: no cover\n    from shop.models import Item\n    from shop.models import Price\n",
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: a .diff test fixture",
    idea: "dependencies.mode: any *.diff/*.patch is a dependency-settings file, test data for a diff tool included.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/fixtures/rename.diff",
        "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
        "--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n",
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: a story updated for a renamed prop (source_only)",
    idea: "tests.mode: **/*.stories.* makes stories test files, so a typecheck fix after a prop rename can't touch them.",
    changes: [
      edit(
        "src/Button.tsx",
        "export const Button = (p: { label: string }) => p.label;\n",
        "export const Button = (p: { text: string }) => p.text;\n",
      ),
      edit(
        "src/Button.stories.tsx",
        'export const Primary = { args: { label: "Buy" } };\n',
        'export const Primary = { args: { text: "Buy" } };\n',
      ),
    ],
    violations: [],
  },
  {
    name: "fp r3: a patch bump inside setup.py install_requires (patch)",
    idea: "dependencies.mode: setup.py arguments are settings (need any), while the same bump in requirements.txt is a patch.",
    policy: { dependencies: { mode: "patch" } },
    changes: [
      edit(
        "setup.py",
        'setup(name="shop", install_requires=["requests==2.32.0"])\n',
        'setup(name="shop", install_requires=["requests==2.32.3"])\n',
      ),
    ],
    violations: [],
  },
  // ================================================================== round 4 (after 67cd704)
  {
    name: "fp r4: a tokenizer under test with a skip() method on `t`",
    idea: "tests.forbidSkips: the context-receiver pattern takes any `t.skip(` / `ctx.skip(` / `this.skip(`.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/tokenizer.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          '    const t = new Tokenizer("a b");\n    t.skip();\n    expect(t.next()).toBe("b");',
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp r4: an app function named pending()",
    idea: "tests.forbidSkips: `pending(` is Jasmine's, but also an ordinary name (orders, promises).",
    policy: EDITABLE,
    changes: [
      edit(
        "src/orders.test.ts",
        JS_TEST,
        js("    expect(total([1, 2])).toBe(3);", "    expect(pending(orders)).toHaveLength(1);"),
      ),
    ],
    violations: [],
  },
  {
    name: "fp r4: app names Skipped / Exit, and _pytest type imports",
    idea: "tests.forbidSkips: `\\b(Skipped|XFailed|Exit)\\b` matches a job status enum; `from _pytest...` is how typed conftests import MonkeyPatch.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/test_jobs.py",
        "from shop.jobs import Status, run\n",
        "from shop.jobs import Status, run\n\n\ndef test_skipped_job():\n    assert run(enabled=False).status == Status.Skipped\n",
      ),
      edit(
        "tests/conftest.py",
        "import pytest\n",
        "import pytest\nfrom _pytest.monkeypatch import MonkeyPatch\n\n\n@pytest.fixture\ndef env(monkeypatch: MonkeyPatch) -> MonkeyPatch:\n    return monkeypatch\n",
      ),
    ],
    violations: [],
  },
  {
    name: "fp r4: an expect whose subject has a block arrow (semicolons inside)",
    idea: "tests.forbidAssertionReduction: `[^;]*?` stops at the `;` inside the subject, so the rewritten assertion no longer counts.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cart.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          "    expect(\n      total([1, 2].map((price) => {\n        const cents = price * 100;\n        return cents / 100;\n      })),\n    ).toBe(3);",
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp r4: a CLI's own CI and Vite-mode checks in source",
    idea: "tests.forbidSkips (D14): `process.env.CI` to turn off spinners and `import.meta.env.MODE` in a Vite app are ordinary.",
    changes: [
      edit(
        "src/cli/progress.ts",
        "export const interactive = process.stdout.isTTY;\n",
        "export const interactive = process.stdout.isTTY && !process.env.CI;\n",
      ),
      edit(
        "src/app/config.ts",
        'export const apiUrl = "/api";\n',
        'export const apiUrl = import.meta.env.MODE === "development" ? "http://localhost:4000" : "/api";\n',
      ),
    ],
    violations: [],
  },
  {
    name: "fp r4: testing a custom assertion helper with pytest.raises(AssertionError)",
    idea: "tests.forbidAssertionReduction: the helper under test is supposed to raise AssertionError.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/test_checks.py",
        "import pytest\n\nfrom shop.testing import assert_valid_cart\n",
        'import pytest\n\nfrom shop.testing import assert_valid_cart\n\n\ndef test_rejects_negative_prices():\n    with pytest.raises(AssertionError):\n        assert_valid_cart({"prices": [-1]})\n',
      ),
    ],
    violations: [],
  },
  // ================================================================== round 5 (after aeb4a72)
  {
    name: "fp r5: a search loop with break in a test",
    idea: "tests.forbidSkips: the bracket walk reads `break` under `for`/`if` inside a test as a guarded exit.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cart.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          "    let found = -1;\n    for (const [index, price] of [1, 2].entries()) {\n      if (price === 2) {\n        found = index;\n        break;\n      }\n    }\n    expect(found).toBe(1);",
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp r5: continue in a loop over cases in a test",
    idea: "tests.forbidSkips: `if (...) continue;` inside a for loop in a test, every iteration still asserting.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cart.test.ts",
        JS_TEST,
        js(
          "    expect(total([1, 2])).toBe(3);",
          "    for (const prices of [[1, 2], [], [3]]) {\n      if (prices.length === 0) continue;\n      expect(total(prices)).toBeGreaterThan(0);\n    }",
        ),
      ),
    ],
    violations: [],
  },
  {
    name: "fp r5: a helper whose enclosing block tests a regex",
    idea: "tests.forbidSkips: the walk's test-start regex isn't anchored, so `if (PATTERN.test(s)) {` reads as a test's callback.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cart.test.ts",
        JS_TEST,
        `${JS_TEST}\nconst PATTERN = /^\\d+$/;\n\nfunction classify(s: string) {\n  if (PATTERN.test(s)) {\n    if (s.length > 3) return "long";\n  }\n  return "short";\n}\n`,
      ),
    ],
    violations: [],
  },
  {
    name: "fp r5: a CLI spinner that stays off in CI",
    idea: "tests.forbidSkips (ciDecides): `if (process.env.CI) return;` at the top of startSpinner is the common, legitimate form.",
    changes: [
      edit(
        "src/cli/spinner.ts",
        "export function startSpinner(label: string) {\n  render(label);\n}\n",
        "export function startSpinner(label: string) {\n  if (process.env.CI) return;\n  render(label);\n}\n",
      ),
    ],
    violations: [],
  },
];
