import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-redirect";

describe("safeNextPath", () => {
  it.each([
    ["/acme", "/acme"],
    ["/acme/repos?tab=all#top", "/acme/repos?tab=all#top"],
    ["/", "/"],
  ])("keeps the same-origin path %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    42,
    "",
    "acme",
    "https://evil.example/acme",
    "//evil.example",
    "/\\evil.example",
    "/\u0000acme",
    "/login",
    "/login?next=/login",
    "/auth/complete",
    "/api/auth/sign-out",
    "/.//evil.example",
    "/%2e%2e//evil.example",
    "/%2E//evil.example",
    "/a/..//evil.example",
    "/a/../..//evil.example",
  ])("falls back to / for %j", (input) => {
    expect(safeNextPath(input)).toBe("/");
  });

  it.each([
    "/.//evil.example",
    "/%2e%2e//evil.example",
    "/a/b/../..//evil.example/x",
    "//evil.example",
    "/%2F%2Fevil.example",
    "/\t/evil.example",
    "/acme/.//repos",
  ])("never produces a path that leaves the site: %j", (input) => {
    const target = new URL(safeNextPath(input), "https://pipeheal.example");
    expect(target.origin).toBe("https://pipeheal.example");
  });
});
