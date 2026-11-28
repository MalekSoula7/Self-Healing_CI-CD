// The App webhook's deliveries (SPEC §2.2): GitHub never redelivers on its own, so the
// reconciler lists what it sent and asks again for what failed. Called with the App's own JWT,
// which no installation token can do. Payloads are never fetched.
import type { Octokit } from "octokit";
import { z } from "zod";
import { NO_RETRY } from "./client";

const deliverySchema = z.object({
  /** A 64-bit integer, read as text: it may not fit a JavaScript number. */
  id: z.string().regex(/^\d{1,20}$/),
  guid: z.string().regex(/^[0-9a-fA-F-]{1,100}$/),
  delivered_at: z.iso.datetime({ offset: true }),
  status_code: z.number().int(),
  event: z.string().max(100),
  redelivery: z.boolean(),
});

export interface WebhookDeliveryAttempt {
  /** This attempt's ID, for redelivering it. */
  id: string;
  /** The event's ID, shared by its redeliveries: our `X-GitHub-Delivery`. */
  guid: string;
  event: string;
  /** False for GitHub's first attempt at the event. */
  redelivery: boolean;
  deliveredAt: Date;
  /** GitHub counts only a 2xx answer as delivered. */
  ok: boolean;
}

/** Quotes every `"id"` number so JSON.parse can't round it. Text inside strings is escaped. */
function idsAsText(json: string): string {
  return json.replace(/"id"\s*:\s*(\d+)/g, '"id":"$1"');
}

function nextCursor(link: string | undefined): string | null {
  const next = link?.split(",").find((part) => part.includes('rel="next"'));
  const url = next === undefined ? undefined : /<([^>]+)>/.exec(next)?.[1];
  return url === undefined ? null : new URL(url).searchParams.get("cursor");
}

export function webhookDeliveries(octokit: Octokit) {
  return {
    /**
     * The delivery attempts since `since`, newest first, from at most `maxPages` pages of 100.
     * `complete` is false when there were more.
     */
    async list(
      since: Date,
      maxPages = 30,
    ): Promise<{ attempts: WebhookDeliveryAttempt[]; complete: boolean }> {
      const attempts: WebhookDeliveryAttempt[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < maxPages; page++) {
        const response: { data: unknown; headers: { link?: string } } = await octokit.request(
          "GET /app/hook/deliveries",
          {
            per_page: 100,
            ...(cursor === null ? {} : { cursor }),
            request: { parseSuccessResponseBody: false },
          },
        );
        const body = await new Response(response.data as ReadableStream).text();
        for (const delivery of z.array(deliverySchema).parse(JSON.parse(idsAsText(body)))) {
          const deliveredAt = new Date(delivery.delivered_at);
          if (deliveredAt < since) return { attempts, complete: true };
          attempts.push({
            id: delivery.id,
            guid: delivery.guid,
            event: delivery.event,
            redelivery: delivery.redelivery,
            deliveredAt,
            ok: delivery.status_code >= 200 && delivery.status_code < 300,
          });
        }
        cursor = nextCursor(response.headers.link);
        if (cursor === null) return { attempts, complete: true };
      }
      return { attempts, complete: false };
    },

    /** Asks GitHub to send a delivery again. Never retried: the next sweep decides. */
    async redeliver(id: string): Promise<void> {
      const delivery = deliverySchema.shape.id.parse(id);
      // The ID stays text (see above), though the endpoint's type says number.
      await octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
        delivery_id: delivery as unknown as number,
        ...NO_RETRY,
      });
    },
  };
}
