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
  ])("falls back to / for %j", (input) => {
    expect(safeNextPath(input)).toBe("/");
  });
});
