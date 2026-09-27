// Workspace conventions from CLAUDE.md and SPEC §4.1, checked mechanically.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const PackageJson = z.object({
  name: z.string(),
  private: z.boolean().optional(),
  type: z.string().optional(),
  packageManager: z.string().optional(),
  engines: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});
type PackageJson = z.infer<typeof PackageJson>;

const TsConfig = z.object({
  extends: z.string().optional(),
  compilerOptions: z.record(z.string(), z.unknown()).optional(),
});

function readJson<T>(schema: z.ZodType<T>, ...segments: string[]): T {
  return schema.parse(JSON.parse(readFileSync(join(repoRoot, ...segments), "utf8")));
}

function workspacePackages(): { dir: string; group: string }[] {
  return ["apps", "packages"].flatMap((group) => {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) return [];
    return readdirSync(groupDir)
      .filter((dir) => statSync(join(groupDir, dir)).isDirectory())
      .map((dir) => ({ dir, group }));
  });
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
]);

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORED_DIRS.has(entry.name)) return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

// Shell syntax that breaks on Windows (cmd/PowerShell) inside package.json scripts.
const UNIX_ONLY_SCRIPT = [
  /\brm\s+-/,
  /(^|[;&|]\s*)(cp|mv|export)\s/,
  /(^|[;&|]\s*)[A-Z_][A-Z0-9_]*=\S*\s/, // inline env assignment: FOO=bar cmd
  /\.sh\b/,
];

function unixOnlyScripts(pkg: PackageJson): string[] {
  return Object.entries(pkg.scripts ?? {})
    .filter(([, command]) => UNIX_ONLY_SCRIPT.some((pattern) => pattern.test(command)))
    .map(([name, command]) => `${pkg.name} > ${name}: ${command}`);
}

describe("root workspace", () => {
  const root = readJson(PackageJson, "package.json");

  it("pins pnpm 10 and Node 24", () => {
    expect(root.packageManager).toMatch(/^pnpm@10\.\d+\.\d+$/);
    expect(root.engines?.node).toMatch(/>=24\./);
    expect(root.type).toBe("module");
  });

  it("uses a strict base tsconfig", () => {
    const base = readJson(TsConfig, "tsconfig.base.json");
    expect(base.compilerOptions).toMatchObject({ strict: true, noUncheckedIndexedAccess: true });
  });

  it("forces LF line endings", () => {
    const attributes = readFileSync(join(repoRoot, ".gitattributes"), "utf8");
    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
  });

  it("has no Unix-only syntax in root scripts", () => {
    expect(unixOnlyScripts(root)).toEqual([]);
  });

  it("contains no shell or batch scripts (use TypeScript run with tsx)", () => {
    const scripts = listFiles(repoRoot).filter((file) => /\.(sh|bash|ps1|bat|cmd)$/i.test(file));
    expect(scripts).toEqual([]);
  });
});

describe.each(workspacePackages())("$group/$dir", ({ dir, group }) => {
  const pkg = readJson(PackageJson, group, dir, "package.json");

  it("follows the package conventions", () => {
    expect(pkg.name).toBe(`@pipeheal/${dir}`);
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.scripts?.typecheck).toBeDefined();
  });

  it("extends the strict base tsconfig", () => {
    const tsconfig = readJson(TsConfig, group, dir, "tsconfig.json");
    expect(tsconfig.extends).toBe("../../tsconfig.base.json");
  });

  it("has no Unix-only syntax in its scripts", () => {
    expect(unixOnlyScripts(pkg)).toEqual([]);
  });
});
