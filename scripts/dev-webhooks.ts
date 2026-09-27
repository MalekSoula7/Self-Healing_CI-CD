// `pnpm dev:webhooks`: forwards GitHub webhooks from SMEE_URL to the local web app, reconnecting
// when the stream drops. Development only. Stop with Ctrl+C.
import { parseEnv } from "@pipeheal/shared";
import { createLogger } from "@pipeheal/shared/logger";
import { relay, relayEnvSchema } from "./lib/smee-relay";

const logger = createLogger({ level: "info", service: "dev-webhooks" });
const env = parseEnv(relayEnvSchema);
const controller = new AbortController();
process.on("SIGINT", () => {
  controller.abort();
});
// A function, so TypeScript doesn't assume the flag can't change between checks.
const stopped = () => controller.signal.aborted;

// Host only: the channel URL is a capability (anyone holding it can read the deliveries).
logger.info({ from: new URL(env.SMEE_URL).host, to: env.WEBHOOK_TARGET }, "relaying webhooks");
let backoffMs = 1_000;
while (!stopped()) {
  try {
    await relay({
      smeeUrl: env.SMEE_URL,
      target: env.WEBHOOK_TARGET,
      signal: controller.signal,
      onDelivery: (delivery) => {
        backoffMs = 1_000;
        logger.info(delivery, "delivery forwarded");
      },
    });
  } catch (error) {
    if (stopped()) break;
    logger.warn({ err: error, retryInMs: backoffMs }, "relay interrupted");
  }
  if (stopped()) break;
  await new Promise((resolve) => setTimeout(resolve, backoffMs));
  backoffMs = Math.min(backoffMs * 2, 30_000);
}
