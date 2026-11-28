// How big a dependency spec change is (SPEC §8.5, dependencies.mode). Written before the
// implementation.
import { describe, expect, it } from "vitest";
import { changeLevel, levelAllowed } from "./versions";

describe("changeLevel (npm and Poetry ranges)", () => {
  it.each([
    ["^1.2.3", "^1.2.3", "none"],
    ["^1.2.3", "^1.2.4", "patch"],
    ["~1.2.3", "~1.2.9", "patch"],
    ["1.2.3", "1.2.4", "patch"],
    ["^1.2.3", "^1.3.0", "minor"],
    ["^1.2.3", "^2.0.0", "any"],
    ["^1.2.3", "^1.2.2", "any"],
    ["1.2.3", "~1.2.3", "patch"],
    ["1.2.3", "^1.2.3", "minor"],
    ["~1.2.3", "^1.2.3", "minor"],
    ["^1.2.3", "~1.2.3", "patch"],
    ["^1.2.3", "*", "any"],
    ["^1.2.3", "latest", "any"],
    ["^1.2.3", ">=1.2.3", "any"],
    ["^1.2.3", "^1.2.3 || ^2.0.0", "any"],
    ["^0.2.3", "^0.2.4", "minor"],
    ["^0.2.3", "^0.3.0", "any"],
    ["^0.0.3", "^0.0.4", "any"],
    ["1.2.3-beta.1", "1.2.3", "patch"],
    ["v1.2.3", "=1.2.4", "patch"],
    ["1.2", "1.3", "minor"],
    ["1.x", "1.2.x", "minor"],
    ["^1.2", "^1.3", "minor"],
    ["~1", "~1.4", "minor"],
    ["^1.2.3", "github:owner/repo", "any"],
    ["workspace:*", "workspace:^", "any"],
    ["*", "^1.2.3", "any"],
    ["1.2", "1.2.1", "patch"],
    ["^0.0.0", "^0.0.0-rc.1", "patch"],
  ])("npm %s -> %s is %s", (from, to, level) => {
    expect(changeLevel({ syntax: "npm", spec: from }, { syntax: "npm", spec: to })).toBe(level);
  });
});

describe("changeLevel (PEP 440)", () => {
  it.each([
    ["==1.2.3", "==1.2.3", "none"],
    ["==1.2.3", "== 1.2.3", "none"],
    ["==1.2.3", "==1.2.4", "patch"],
    ["==1.2.3", "==1.3.0", "minor"],
    ["==1.2.3", "==2.0", "any"],
    ["==1.2.3", "==1.2.2", "any"],
    ["==1.2.3", "~=1.2.3", "patch"],
    ["==1.2", "~=1.2", "minor"],
    ["==1.2.3", ">=1.2.3", "any"],
    ["==1.2.3", "", "any"],
    ["==1.2.0", "==1.2.*", "patch"],
    // 1.2.* also accepts 1.2.0: a possible downgrade.
    ["==1.2.3", "==1.2.*", "any"],
    ["==1.2.3", ">=1.2.3,<2", "any"],
    ["==1.2.3", "==1.2.3.post1", "patch"],
    ["==2024.1.1", "==2024.1.2", "patch"],
    ["[extra]==1.2.3", "==1.2.3", "any"],
    ["==1.2.3 ; python_version < '3.12'", "==1.2.3", "any"],
  ])("pep440 %j -> %j is %s", (from, to, level) => {
    expect(changeLevel({ syntax: "pep440", spec: from }, { syntax: "pep440", spec: to })).toBe(
      level,
    );
  });

  it("calls any change between syntaxes, or to an opaque entry, any", () => {
    expect(
      changeLevel({ syntax: "npm", spec: "1.0.0" }, { syntax: "pep440", spec: "==1.0.0" }),
    ).toBe("any");
    expect(changeLevel({ syntax: "opaque", spec: "a" }, { syntax: "opaque", spec: "b" })).toBe(
      "any",
    );
    expect(changeLevel({ syntax: "opaque", spec: "a" }, { syntax: "opaque", spec: "a" })).toBe(
      "none",
    );
  });
});

describe("levelAllowed", () => {
  it.each([
    ["frozen", "none", true],
    ["frozen", "patch", false],
    ["patch", "patch", true],
    ["patch", "minor", false],
    ["minor", "minor", true],
    ["minor", "any", false],
    ["any", "any", true],
  ] as const)("mode %s allows %s: %s", (mode, level, allowed) => {
    expect(levelAllowed(mode, level)).toBe(allowed);
  });
});
