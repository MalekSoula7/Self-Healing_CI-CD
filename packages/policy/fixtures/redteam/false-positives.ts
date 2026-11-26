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
        'setup(name="shop", packages=["shop"], install_requires=["httpx==0.27.0"])\n',
        'setup(name="shop", packages=["shop"], package_data={"shop": ["py.typed"]}, install_requires=["httpx==0.27.0"])\n',
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
];
