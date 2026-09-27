// .env.example documents every variable and must never carry a real secret.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const text = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");

const entries = text
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => {
    const eq = line.indexOf("=");
    return { key: line.slice(0, eq), value: line.slice(eq + 1) };
  });

const SECRET_KEY = /(SECRET|PRIVATE_KEY|API_KEY|TOKEN|PASSWORD|DSN)/;

describe(".env.example", () => {
  it("only contains KEY=value lines and comments", () => {
    for (const { key } of entries) expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("declares each key once", () => {
    const keys = entries.map((entry) => entry.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("leaves every secret empty", () => {
    const filled = entries.filter(({ key, value }) => SECRET_KEY.test(key) && value !== "");
    expect(filled).toEqual([]);
  });
});
