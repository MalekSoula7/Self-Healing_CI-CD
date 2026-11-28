import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  authConfigured: true,
  runOwnerBindingCheck: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/env", () => ({ webEnv: () => ({ APP_URL: "https://pipeheal.example" }) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ fake: "db" }) }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ child: () => ({ warn: mocks.warn, info: mocks.info }) }),
}));
vi.mock("@/lib/auth/server", () => ({
  getAuth: () => (mocks.authConfigured ? { api: { getSession: mocks.getSession } } : null),
}));
vi.mock("@/lib/auth/owner-binding", () => ({ runOwnerBindingCheck: mocks.runOwnerBindingCheck }));

const { GET } = await import("./route");

function visit(next?: string) {
  const query = next === undefined ? "" : `?next=${encodeURIComponent(next)}`;
  return GET(new NextRequest(`http://internal:3000/auth/complete${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authConfigured = true;
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.runOwnerBindingCheck.mockResolvedValue([]);
});

describe("GET /auth/complete", () => {
  it("runs the owner-binding check for the signed-in user, then continues on the app's own URL", async () => {
    const response = await visit("/acme/repos");

    expect(mocks.runOwnerBindingCheck).toHaveBeenCalledWith(
      { fake: "db" },
      expect.anything(),
      expect.any(Headers),
      "user-1",
      expect.anything(),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://pipeheal.example/acme/repos");
  });

  it.each([
    "//evil.example",
    "/.//evil.example",
    "https://evil.example/x",
    "/%2e%2e//evil.example",
  ])("never leaves the site for next=%s", async (next) => {
    const response = await visit(next);

    expect(response.headers.get("location")).toBe("https://pipeheal.example/");
  });

  it("sends a visitor without a session to sign-in, keeping where they were going", async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await visit("/acme");

    expect(response.headers.get("location")).toBe("https://pipeheal.example/login?next=%2Facme");
    expect(mocks.runOwnerBindingCheck).not.toHaveBeenCalled();
  });

  it("sends everyone to sign-in when sign-in isn't configured", async () => {
    mocks.authConfigured = false;

    const response = await visit("/acme");

    expect(response.headers.get("location")).toBe("https://pipeheal.example/login?next=%2Facme");
    expect(mocks.runOwnerBindingCheck).not.toHaveBeenCalled();
  });
});
