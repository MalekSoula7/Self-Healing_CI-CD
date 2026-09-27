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

// SMEE_URL is a capability URL: anyone holding it can read the forwarded webhooks.
const SECRET_KEY = /(SECRET|PRIVATE_KEY|API_KEY|TOKEN|PASSWORD|DSN|SMEE_URL)/;
// The only credentials allowed in a URL are the documented local docker compose defaults.
const LOCAL_DEV_CREDENTIALS = "pipeheal:pipeheal@localhost";

describe(".env.example", () => {
  it("only contains KEY=value lines and comments", () => {
    for (const { key } of entries) expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("declares each key once", () => {
    const keys = entries.map((entry) => entry.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("embeds no credentials in URLs except the local docker compose default", () => {
    const withCredentials = entries.filter(
      ({ value }) => /:\/\/[^/\s]*@/.test(value) && !value.includes(LOCAL_DEV_CREDENTIALS),
    );
    expect(withCredentials).toEqual([]);
  });

  it("leaves every secret empty", () => {
    const filled = entries.filter(({ key, value }) => SECRET_KEY.test(key) && value !== "");
    expect(filled).toEqual([]);
  });
});
