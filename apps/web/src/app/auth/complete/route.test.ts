import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getAccessToken: vi.fn(),
  authConfigured: true,
  bind: vi.fn(),
  listInstallations: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/env", () => ({ webEnv: () => ({ APP_URL: "https://pipeheal.example" }) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ fake: "db" }) }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ child: () => ({ warn: mocks.warn, info: mocks.info }) }),
}));
vi.mock("@/lib/auth/server", () => ({
  getAuth: () =>
    mocks.authConfigured
      ? { api: { getSession: mocks.getSession, getAccessToken: mocks.getAccessToken } }
      : null,
}));
vi.mock("@/lib/auth/owner-binding", () => ({ bindVerifiedOwnerships: mocks.bind }));
vi.mock("@pipeheal/github", () => ({ listUserInstallationIds: mocks.listInstallations }));

const { GET } = await import("./route");

function visit(next?: string) {
  const query = next === undefined ? "" : `?next=${encodeURIComponent(next)}`;
  return GET(new NextRequest(`http://internal:3000/auth/complete${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authConfigured = true;
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.bind.mockResolvedValue([]);
});

describe("GET /auth/complete", () => {
  it("binds verified ownerships for the signed-in user, then continues on the app's own URL", async () => {
    const response = await visit("/acme/repos");

    expect(mocks.bind).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://pipeheal.example/acme/repos");
  });

  it("wires the user's own decrypted token and a bounded GitHub call", async () => {
    await visit("/");
    const [deps] = mocks.bind.mock.calls[0] as [
      {
        getAccessToken: (accountId: string) => Promise<string>;
        listInstallationIds: (token: string) => Promise<bigint[]>;
      },
    ];
    mocks.getAccessToken.mockResolvedValue({ accessToken: "ghu_decrypted" });
    mocks.listInstallations.mockResolvedValue([1n]);

    await expect(deps.getAccessToken("account-row")).resolves.toBe("ghu_decrypted");
    await deps.listInstallationIds("ghu_decrypted");

    expect(mocks.getAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ body: { accountId: "account-row" } }),
    );
    expect(mocks.listInstallations).toHaveBeenCalledWith(
      "ghu_decrypted",
      expect.objectContaining({ retries: 1, timeoutMs: 5_000 }),
    );
  });

  it("still signs the user in when the check fails, and logs no token", async () => {
    mocks.bind.mockRejectedValue(new Error("GitHub is down"));

    const response = await visit("/acme");

    expect(response.headers.get("location")).toBe("https://pipeheal.example/acme");
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("ghu_");
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
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("sends everyone to sign-in when sign-in isn't configured", async () => {
    mocks.authConfigured = false;

    const response = await visit("/acme");

    expect(response.headers.get("location")).toBe("https://pipeheal.example/login?next=%2Facme");
    expect(mocks.bind).not.toHaveBeenCalled();
  });
});
