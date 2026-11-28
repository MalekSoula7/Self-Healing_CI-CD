// The App webhook's delivery API (SPEC §2.2), mocked with msw.
import { generateKeyPairSync } from "node:crypto";
import { mockServer } from "@pipeheal/shared/testing";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { createGitHubApp } from "./app";

const ENDPOINT = "https://api.github.com/app/hook/deliveries";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const app = () => createGitHubApp({ appId: 1234, privateKey, retries: 0 });
const since = new Date("2026-11-27T00:00:00Z");
/** Past Number.MAX_SAFE_INTEGER: a number would lose its last digits. */
const BIG = "9007199254740993001";

const body = (id: string, guid: string, at: string, status: number) =>
  `{"id":${id},"guid":"${guid}","delivered_at":"${at}","status_code":${String(status)},` +
  `"status":"said \\"id\\": 7","event":"workflow_run","repository_id":123}`;
const json = (rows: string[], link?: string) =>
  new HttpResponse(`[${rows.join(",")}]`, {
    headers: {
      "content-type": "application/json",
      ...(link === undefined ? {} : { link }),
    },
  });

describe("webhook deliveries", () => {
  it("lists attempts since a time across pages, with the App's JWT and exact IDs", async () => {
    const asked: (string | null)[] = [];
    const authorizations: string[] = [];
    mockServer.use(
      http.get(ENDPOINT, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        asked.push(cursor);
        authorizations.push(request.headers.get("authorization") ?? "");
        return cursor === null
          ? json(
              [body(BIG, "aaaa-1", "2026-11-28T10:00:00Z", 502)],
              `<${ENDPOINT}?per_page=100&cursor=v1_2>; rel="next"`,
            )
          : json([
              body("12", "bbbb-2", "2026-11-27T10:00:00Z", 202),
              body("11", "cccc-3", "2026-11-20T10:00:00Z", 502),
            ]);
      }),
    );

    const listed = await app().webhookDeliveries.list(since);

    expect(listed).toEqual({
      complete: true,
      attempts: [
        { id: BIG, guid: "aaaa-1", deliveredAt: new Date("2026-11-28T10:00:00Z"), ok: false },
        { id: "12", guid: "bbbb-2", deliveredAt: new Date("2026-11-27T10:00:00Z"), ok: true },
      ],
    });
    expect(asked).toEqual([null, "v1_2"]);
    expect(authorizations[0]).toMatch(/^bearer ey/i);
  });

  it("says when it stopped at the page cap", async () => {
    mockServer.use(
      http.get(ENDPOINT, () =>
        json(
          [body("1", "aaaa-1", "2026-11-28T10:00:00Z", 200)],
          `<${ENDPOINT}?cursor=again>; rel="next"`,
        ),
      ),
    );

    await expect(app().webhookDeliveries.list(since, 2)).resolves.toMatchObject({
      complete: false,
    });
  });

  it("redelivers an attempt by its exact ID", async () => {
    const paths: string[] = [];
    mockServer.use(
      http.post(`${ENDPOINT}/:id/attempts`, ({ params }) => {
        paths.push(String(params.id));
        return HttpResponse.json({}, { status: 202 });
      }),
    );

    await app().webhookDeliveries.redeliver(BIG);

    expect(paths).toEqual([BIG]);
    await expect(app().webhookDeliveries.redeliver("1/../2")).rejects.toThrow();
  });
});
