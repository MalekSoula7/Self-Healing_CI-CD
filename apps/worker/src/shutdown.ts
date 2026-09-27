import type { Logger } from "pino";

export interface ShutdownStep {
  name: string;
  close: () => Promise<unknown>;
}

export interface ShutdownOptions {
  logger: Logger;
  /** Closed in order: stop accepting work first, close connections last. */
  steps: ShutdownStep[];
  /** A step that takes longer is marked failed and the next step starts. */
  stepTimeoutMs?: number;
  /** Backstop for the whole sequence. */
  timeoutMs?: number;
  exit?: (code: number) => void;
}

async function withTimeout(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`did not close within ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns an idempotent shutdown function. Every step is attempted even if an earlier one fails
 * or hangs; the process exits 1 if any step failed or the whole sequence exceeds `timeoutMs`.
 */
export function createShutdown({
  logger,
  steps,
  stepTimeoutMs = 5_000,
  timeoutMs = 15_000,
  exit = (code) => process.exit(code),
}: ShutdownOptions): (reason: string) => Promise<void> {
  let running: Promise<void> | undefined;

  async function run(reason: string): Promise<void> {
    logger.info({ reason }, "shutting down");
    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, "shutdown timed out, forcing exit");
      exit(1);
    }, timeoutMs);
    timer.unref();

    let failed = false;
    for (const step of steps) {
      try {
        await withTimeout(step.close(), stepTimeoutMs);
        logger.info({ step: step.name }, "closed");
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ step: step.name, error: message }, "failed to close");
      }
    }
    clearTimeout(timer);
    logger.info({ failed }, "shutdown complete");
    exit(failed ? 1 : 0);
  }

  return (reason) => {
    running ??= run(reason);
    return running;
  };
}
