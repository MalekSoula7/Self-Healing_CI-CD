import { describe, expect, it } from "vitest";
import { cleanLog, MAX_LINE_LENGTH } from "./clean";

const ESC = "\u001b";

describe("cleanLog (SPEC §6.2 step 2)", () => {
  it("strips GitHub's timestamp from the start of every line", () => {
    expect(
      cleanLog(
        "2026-09-28T23:22:05.1102345Z first line\n2026-09-28T23:22:05.1103456Z   indented\n",
      ),
    ).toBe("first line\n  indented\n");
  });

  it("leaves timestamps that aren't a line's prefix", () => {
    expect(cleanLog("started at 2026-09-28T23:22:05.1102345Z by cron")).toBe(
      "started at 2026-09-28T23:22:05.1102345Z by cron",
    );
  });

  it("strips colors and other terminal escape sequences", () => {
    expect(
      cleanLog(
        `${ESC}[96msrc/receipt.ts${ESC}[0m:${ESC}[93m1${ESC}[0m - ${ESC}[91merror${ESC}[0m TS2305`,
      ),
    ).toBe("src/receipt.ts:1 - error TS2305");
    expect(cleanLog(`${ESC}[2K${ESC}[1Gdone${ESC}[?25h`)).toBe("done");
    expect(cleanLog(`see ${ESC}]8;;https://example.com${ESC}\\the docs${ESC}]8;;${ESC}\\`)).toBe(
      "see the docs",
    );
  });

  it("keeps group titles but drops the group markers", () => {
    expect(cleanLog("##[group]Run npm ci\nnpm ci\n##[endgroup]\nnext")).toBe(
      "Run npm ci\nnpm ci\nnext",
    );
  });

  it("keeps ##[error] and ##[warning] markers: the error window starts from them (step 4)", () => {
    const text = "##[error]Process completed with exit code 2.\n##[warning]Node 20 is deprecated";
    expect(cleanLog(text)).toBe(text);
  });

  it("normalizes line endings and keeps only the final state of a progress line", () => {
    expect(cleanLog("a\r\nDownloading 10%\rDownloading 50%\rDownloading 100%\r\nb")).toBe(
      "a\nDownloading 100%\nb",
    );
  });

  it("drops a byte order mark", () => {
    expect(cleanLog("﻿first")).toBe("first");
  });

  it("caps a very long line and says how much was cut", () => {
    const line = "x".repeat(MAX_LINE_LENGTH + 500);

    const cleaned = cleanLog(`${line}\nshort`);

    const [first, second] = cleaned.split("\n");
    expect(first?.startsWith("x".repeat(MAX_LINE_LENGTH))).toBe(true);
    expect(first).toContain("[500 more characters]");
    expect(second).toBe("short");
  });

  it("handles an empty log", () => {
    expect(cleanLog("")).toBe("");
  });
});
