// Reading dependency manifests (SPEC §8.5). Written before the implementation.
import { describe, expect, it } from "vitest";
import { isLockfile, readManifest, stableJson } from "./manifests";

function entries(path: string, content: string) {
  const read = readManifest(path, content);
  if (!read?.ok) throw new Error(`not readable: ${path}`);
  return Object.fromEntries(read.dependencies);
}

describe("readManifest", () => {
  it("isn't a manifest for other files", () => {
    expect(readManifest("src/package.ts", "x")).toBeNull();
    expect(readManifest("docs/requirements.md", "x")).toBeNull();
  });

  it("reads package.json sections, and settings that move versions", () => {
    const read = entries(
      "apps/web/package.json",
      JSON.stringify({
        name: "web",
        dependencies: { react: "^19.0.0", local: { weird: true } },
        devDependencies: { vitest: "5.1.0" },
        overrides: { b: "1.0.0" },
        packageManager: "pnpm@10.0.0",
      }),
    );

    expect(read).toEqual({
      "dependencies:react": { syntax: "npm", spec: "^19.0.0", kind: "package" },
      "dependencies:local": { syntax: "opaque", spec: '{"weird":true}', kind: "package" },
      "devDependencies:vitest": { syntax: "npm", spec: "5.1.0", kind: "package" },
      overrides: { syntax: "opaque", spec: '{"b":"1.0.0"}', kind: "setting" },
      packageManager: { syntax: "opaque", spec: '"pnpm@10.0.0"', kind: "setting" },
    });
  });

  it("reads requirements files: names normalized, options and URLs as settings", () => {
    const read = entries(
      "requirements-dev.txt",
      "# tools\nDjango_Rest.Framework[extra] == 3.15.1  # pinned\n--index-url https://x/simple\n" +
        "requests>=2,\\\n  <3 ; python_version >= '3.9'\nlib @ https://example.com/lib.whl\n\n",
    );

    expect(read).toEqual({
      "django-rest-framework": { syntax: "pep440", spec: "[extra] == 3.15.1", kind: "package" },
      "option:--index-url https://x/simple": {
        syntax: "opaque",
        spec: "--index-url https://x/simple",
        kind: "setting",
      },
      requests: { syntax: "pep440", spec: ">=2,  <3 ; python_version >= '3.9'", kind: "package" },
      lib: { syntax: "opaque", spec: "@ https://example.com/lib.whl", kind: "package" },
    });
    expect(readManifest("requirements/base.txt", "a==1\n")).not.toBeNull();
    expect(readManifest("constraints.txt", "a==1\n")).not.toBeNull();
  });

  it("reads pyproject.toml's PEP 621, PEP 735 and Poetry dependencies", () => {
    const read = entries(
      "pyproject.toml",
      `[build-system]
requires = ["hatchling>=1.20"]

[project]
name = "shop"
dependencies = ["httpx==0.27.0"]

[project.optional-dependencies]
docs = ["mkdocs~=1.6"]

[dependency-groups]
test = ["pytest==8.3.0", { include-group = "docs" }]

[tool.poetry.dependencies]
python = "^3.12"
fastapi = "^0.115.0"
pydantic = { version = "==2.9.0" }
local = { path = "../local" }

[tool.poetry.group.dev.dependencies]
ruff = ">=0.6"
`,
    );

    expect(read).toMatchObject({
      "build-system:hatchling": { syntax: "pep440", spec: ">=1.20" },
      "project:httpx": { syntax: "pep440", spec: "==0.27.0" },
      "project.optional-dependencies.docs:mkdocs": { syntax: "pep440", spec: "~=1.6" },
      "dependency-groups.test:pytest": { syntax: "pep440", spec: "==8.3.0" },
      'dependency-groups.test:{"include-group":"docs"}': { kind: "setting" },
      "tool.poetry.dependencies:python": { kind: "setting" },
      "tool.poetry.dependencies:fastapi": { syntax: "npm", spec: "^0.115.0" },
      "tool.poetry.dependencies:pydantic": { syntax: "pep440", spec: "==2.9.0" },
      "tool.poetry.dependencies:local": { syntax: "opaque", kind: "package" },
      "tool.poetry.group.dev.dependencies:ruff": { syntax: "pep440", spec: ">=0.6" },
    });
  });

  it("reads a Pipfile", () => {
    const read = entries(
      "Pipfile",
      `[[source]]
url = "https://pypi.org/simple"

[packages]
flask = "==3.0.0"
any = "*"

[dev-packages]
pytest = { version = "==8.3.0" }
`,
    );

    expect(read).toMatchObject({
      "packages:flask": { syntax: "pep440", spec: "==3.0.0" },
      "packages:any": { syntax: "pep440", spec: "" },
      "dev-packages:pytest": { syntax: "pep440", spec: "==8.3.0" },
      source: { kind: "setting" },
    });
  });

  it("reports a manifest it can't parse", () => {
    for (const [path, content] of [
      ["package.json", "{"],
      ["package.json", "[]"],
      ["pyproject.toml", "[project\n"],
    ] as const) {
      const read = readManifest(path, content);

      expect(read).toMatchObject({ ok: false });
      expect(read?.ok === false && read.error.length > 0).toBe(true);
    }
  });
});

describe("readManifest on unusual shapes", () => {
  it("keeps a section that isn't a table as one setting", () => {
    expect(entries("package.json", '{"dependencies": "react"}')).toEqual({
      dependencies: { syntax: "opaque", spec: '"react"', kind: "setting" },
    });
    expect(
      entries(
        "pyproject.toml",
        '[project]\ndependencies = "httpx"\n[tool.poetry]\ndependencies = 1\n',
      ),
    ).toEqual({
      project: { syntax: "opaque", spec: '"httpx"', kind: "setting" },
      "tool.poetry.dependencies": { syntax: "opaque", spec: "1", kind: "setting" },
    });
  });

  it("reads uv and PDM development dependencies, and where packages come from", () => {
    expect(
      entries(
        "pyproject.toml",
        '[tool.uv]\ndev-dependencies = ["pytest==8.3.0"]\n[[tool.uv.index]]\nurl = "https://x"\n' +
          '[tool.pdm.dev-dependencies]\nlint = ["ruff==0.6.0"]\n',
      ),
    ).toMatchObject({
      "tool.uv.dev-dependencies:pytest": { syntax: "pep440", spec: "==8.3.0" },
      "tool.uv.index": { kind: "setting" },
      "tool.pdm.dev-dependencies.lint:ruff": { syntax: "pep440", spec: "==0.6.0" },
    });
  });

  it("keeps a requirement it can't name as a setting", () => {
    expect(entries("requirements.txt", "./local/pkg\n")).toEqual({
      "./local/pkg": { syntax: "opaque", spec: '"./local/pkg"', kind: "setting" },
    });
  });
});

describe("isLockfile", () => {
  it.each([
    ["package-lock.json", true],
    ["apps/web/yarn.lock", true],
    ["pnpm-lock.yaml", true],
    ["poetry.lock", true],
    ["uv.lock", true],
    ["Pipfile.lock", true],
    ["src/lock.ts", false],
  ])("%s: %s", (path, expected) => {
    expect(isLockfile(path)).toBe(expected);
  });
});

describe("stableJson", () => {
  it("sorts keys at every depth", () => {
    expect(stableJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}',
    );
  });
});
