// Redelivering webhooks (SPEC §2.2, P5.3c). Two kinds are asked for again:
// - one GitHub never got a 2xx for (we were down, or refused it);
// - one we accepted whose processing the worker gave up on: GitHub shows it delivered, but our
//   row has an error and was never processed.
// Only `workflow_run` is sent again automatically: processing it re-reads GitHub, so a late copy is
// harmless. Installation events change state in order, and a replayed `suspend` or `created` would
// undo what came after it (P5.3 review H1). A redelivery is safe for the web route: it drops what
// was processed and reruns what failed. Each event is sent at most MAX_ATTEMPTS times in all, with
// longer gaps each time, while its first attempt is within the lookback (so the count is whole): an
// outage of hours is recovered and a poisonous event is left alone.
import { failedWebhookDeliveries, type Db } from "@pipeheal/db";
import type { GitHubApp } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";

const minutes = (count: number) => count * 60_000;

/** How old the latest attempt must be before the next one, by attempts so far. */
export const REDELIVERY_GAPS_MS = [minutes(10), minutes(30), minutes(120), minutes(360)];
export const MAX_ATTEMPTS = REDELIVERY_GAPS_MS.length + 1;
/** How far back deliveries are looked at (GitHub keeps 3 days). */
export const LOOKBACK_MS = minutes(24 * 60);
/** The most redeliveries one sweep asks for. */
export const MAX_PER_SWEEP = 50;
/** The events whose processing doesn't depend on their order. */
const REPLAYABLE: ReadonlySet<string> = new Set(["workflow_run"]);

export interface RedeliverDeps {
  db: Db;
  githubApp: GitHubApp | null;
  logger: Logger;
  now?: () => Date;
}

/** Returns how many redeliveries were asked for. */
export async function redeliverFailed(deps: RedeliverDeps): Promise<number> {
  const app = deps.githubApp;
  if (app === null) return 0;
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const { attempts, complete } = await app.webhookDeliveries.list(since);
  if (!complete) deps.logger.warn("too many webhook deliveries: the oldest weren't looked at");

  // One entry per event, its latest attempt first (GitHub lists newest first).
  const events = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const known = events.get(attempt.guid);
    if (known === undefined) events.set(attempt.guid, [attempt]);
    else known.push(attempt);
  }
  const gaveUp = await failedWebhookDeliveries(
    deps.db,
    [...events.entries()]
      .filter(([, sent]) => sent.some((attempt) => attempt.ok))
      .map(([guid]) => guid),
  );

  const due = [...events.entries()].flatMap(([guid, sent]) => {
    const latest = sent[0];
    const gap = REDELIVERY_GAPS_MS[sent.length - 1];
    if (latest === undefined || gap === undefined) return [];
    if (!REPLAYABLE.has(latest.event) || sent.every((attempt) => attempt.redelivery)) return [];
    if (now.getTime() - latest.deliveredAt.getTime() < gap) return [];
    const delivered = sent.some((attempt) => attempt.ok);
    return delivered && !gaveUp.has(guid) ? [] : [latest];
  });
  // Oldest first, so events are processed roughly in the order they happened.
  due.sort((a, b) => a.deliveredAt.getTime() - b.deliveredAt.getTime());

  let asked = 0;
  for (const delivery of due.slice(0, MAX_PER_SWEEP)) {
    try {
      await app.webhookDeliveries.redeliver(delivery.id);
      asked++;
    } catch (error) {
      deps.logger.warn(
        { deliveryId: delivery.guid, error: error instanceof Error ? error.name : "unknown" },
        "couldn't redeliver a webhook",
      );
    }
  }
  if (asked > 0) deps.logger.info({ count: asked }, "webhooks redelivered");
  return asked;
}
