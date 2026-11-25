// Glob semantics for policy paths (SPEC §8.5). Written before the implementation.
import { describe, expect, it } from "vitest";
import { MAX_GLOB_ALTERNATIVES, compileGlob, globList, globMatches } from "./glob";

function matches(glob: string, path: string): boolean {
  const compiled = compileGlob(glob);
  if (compiled === null) throw new Error(`can't compile ${glob}`);
  return globMatches(compiled, path);
}

describe("globMatches", () => {
  it.each([
    ["**/*.ts", "a.ts"],
    ["**/*.ts", "a/b/c.ts"],
    ["infra/**", "infra/main.tf"],
    ["infra/**", "infra/a/b/c"],
    ["infra/**", "infra"],
    ["src/*.ts", "src/a.ts"],
    ["**/.env*", ".env"],
    ["**/.env*", "apps/web/.env.local"],
    ["*", ".hidden"],
    ["**", ".git/config"],
    ["a/**/b", "a/b"],
    ["a/**/b", "a/x/y/b"],
    ["file?.ts", "file1.ts"],
    ["src/{a,b}/**", "src/b/x.ts"],
    ["src/{a,{b,c}}.ts", "src/c.ts"],
    ["**/*.{test,spec}.ts", "x/y.spec.ts"],
    ["[abc].ts", "b.ts"],
    ["[!abc].ts", "d.ts"],
    ["[^abc].ts", "d.ts"],
    ["v[0-9].txt", "v7.txt"],
    ["a[.ts", "a[.ts"],
    ["{a}.ts", "{a}.ts"],
    ["{a.ts", "{a.ts"],
    ["a**b", "axxb"],
    ["**/Dockerfile*", "services/api/Dockerfile.prod"],
    ["src/caf\u00e9.ts", "src/caf\u00e9.ts"],
    ["*.ts", "\u{1f600}.ts"],
    ["?.ts", "\u{1f600}.ts"],
  ])("%s matches %s", (glob, path) => {
    expect(matches(glob, path)).toBe(true);
  });

  it.each([
    ["infra/**", "infrastructure/a"],
    ["src/*.ts", "src/a/b.ts"],
    ["src/*.ts", "lib/a.ts"],
    ["*.ts", "a.tsx"],
    ["file?.ts", "file10.ts"],
    ["file?.ts", "file/.ts"],
    ["[abc].ts", "d.ts"],
    ["[!abc].ts", "a.ts"],
    ["v[0-9].txt", "va.txt"],
    ["a/**/b", "a/xb"],
    ["src/{a,b}/**", "src/c/x.ts"],
    ["a**b", "a/b"],
    ["SRC/**", "src/a.ts"],
  ])("%s doesn't match %s", (glob, path) => {
    expect(matches(glob, path)).toBe(false);
  });

  it("stays fast on globs written to backtrack", () => {
    const glob = `${"*a".repeat(40)}b`;
    const path = "a".repeat(4000);
    const started = Date.now();

    expect(matches(glob, path)).toBe(false);
    expect(matches(`${"**/".repeat(50)}x`, `${"a/".repeat(1000)}y`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it(`refuses globs that expand to more than ${String(MAX_GLOB_ALTERNATIVES)} alternatives`, () => {
    expect(compileGlob("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}")).not.toBeNull();
    expect(compileGlob("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}")).toBeNull();
    // A nested group fills the budget before the last alternative.
    const sixtyFour = Array.from({ length: 64 }, (_, i) => String(i)).join(",");
    expect(compileGlob(`{a{${sixtyFour}},b}`)).toBeNull();
    expect(compileGlob(`{a{${sixtyFour}}}`)).not.toBeNull();
    expect(
      compileGlob(`{${Array.from({ length: 65 }, (_, i) => String(i)).join(",")}}`),
    ).toBeNull();
  });
});

describe("globList", () => {
  const denied = globList([".github/**", "**/*.pem", "**/secrets/**", "infra/**"]);

  it("matches exactly as written for allow lists", () => {
    const allowed = globList(["src/**"]);

    expect(allowed.matchExact("src/a.ts")).toBe("src/**");
    expect(allowed.matchExact("SRC/a.ts")).toBeUndefined();
    expect(denied.matchExact(".github/x")).toBe(".github/**");
  });

  it.each([
    [".GitHub/workflows/ci.yml", ".github/**"],
    ["GITHUB~1/workflows/ci.yml", ".github/**"],
    [".github./workflows/ci.yml", ".github/**"],
    ["certs/Server.PEM", "**/*.pem"],
    ["app/Secrets/token.txt", "**/secrets/**"],
    ["app/secrets\u200c/token.txt", "**/secrets/**"],
    ["Infra/main.tf", "infra/**"],
  ])("matches %j anywhere it is the same file (as %s)", (path, glob) => {
    expect(denied.matchAnywhere(path)).toBe(glob);
  });

  it("returns undefined when nothing matches", () => {
    expect(denied.matchAnywhere("src/index.ts")).toBeUndefined();
    expect(globList([]).matchAnywhere("a")).toBeUndefined();
  });

  it("throws on a glob it can't compile, so a check fails closed", () => {
    expect(() => globList(["{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}"])).toThrow(/too many/);
  });
});
