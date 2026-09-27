import { mockServer } from "@pipeheal/shared/testing";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { listUserInstallationIds } from "./user";

const API = "https://api.github.com";
const TOKEN = "ghu_testUserToken0000000000000000000000";

function installation(id: number) {
  return { id, account: { id: id * 10, login: `org-${String(id)}` }, app_id: 1 };
}

describe("listUserInstallationIds", () => {
  it("returns every installation on every page, sending the user's token", async () => {
    const seen: { authorization: string | null; page: string | null }[] = [];
    mockServer.use(
      http.get(`${API}/user/installations`, ({ request }) => {
        const url = new URL(request.url);
        const page = url.searchParams.get("page");
        seen.push({ authorization: request.headers.get("authorization"), page });
        if (page === "2") {
          return HttpResponse.json({ total_count: 3, installations: [installation(3)] });
        }
        return HttpResponse.json(
          { total_count: 3, installations: [installation(1), installation(2)] },
          { headers: { link: `<${API}/user/installations?per_page=100&page=2>; rel="next"` } },
        );
      }),
    );

    await expect(listUserInstallationIds(TOKEN)).resolves.toEqual([1n, 2n, 3n]);
    expect(seen).toEqual([
      { authorization: `token ${TOKEN}`, page: null },
      { authorization: `token ${TOKEN}`, page: "2" },
    ]);
  });

  it("returns nothing for a user without installations", async () => {
    mockServer.use(
      http.get(`${API}/user/installations`, () =>
        HttpResponse.json({ total_count: 0, installations: [] }),
      ),
    );

    await expect(listUserInstallationIds(TOKEN)).resolves.toEqual([]);
  });

  it("rejects a response that doesn't look like GitHub's", async () => {
    mockServer.use(
      http.get(`${API}/user/installations`, () =>
        HttpResponse.json({ total_count: 1, installations: [{ id: "1; DROP" }] }),
      ),
    );

    await expect(listUserInstallationIds(TOKEN)).rejects.toThrow(ZodError);
  });

  it("fails on an error response without leaking the token", async () => {
    mockServer.use(
      http.get(`${API}/user/installations`, () =>
        HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );

    const error = await listUserInstallationIds(TOKEN, { retries: 0 }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ status: 401 });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("retries a 5xx, then succeeds", async () => {
    let calls = 0;
    mockServer.use(
      http.get(`${API}/user/installations`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ message: "Server Error" }, { status: 502 })
          : HttpResponse.json({ total_count: 1, installations: [installation(7)] });
      }),
    );

    await expect(listUserInstallationIds(TOKEN, { retries: 1 })).resolves.toEqual([7n]);
    expect(calls).toBe(2);
  });
});
