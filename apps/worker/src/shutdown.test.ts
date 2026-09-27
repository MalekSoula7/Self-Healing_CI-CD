import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdown } from "./shutdown";

const logger = pino({ level: "silent" });

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdown", () => {
  it("closes every step in order, then exits 0", async () => {
    const closed: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      logger,
      exit,
      steps: ["gateway", "worker", "queue", "redis"].map((name) => ({
        name,
        close: () => {
          closed.push(name);
          return Promise.resolve();
        },
      })),
    });

    await shutdown("SIGINT");

    expect(closed).toEqual(["gateway", "worker", "queue", "redis"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("keeps closing after a failed step and exits 1", async () => {
    const closed: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      logger,
      exit,
      steps: [
        { name: "gateway", close: () => Promise.reject(new Error("boom")) },
        {
          name: "redis",
          close: () => {
            closed.push("redis");
            return Promise.resolve();
          },
        },
      ],
    });

    await shutdown("SIGTERM");

    expect(closed).toEqual(["redis"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("runs only once when signalled repeatedly", async () => {
    const close = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const shutdown = createShutdown({ logger, exit, steps: [{ name: "redis", close }] });

    await Promise.all([shutdown("SIGINT"), shutdown("SIGINT"), shutdown("SIGTERM")]);

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  // Seen for real with ioredis 6: a BullMQ worker's close() hung after a Redis restart.
  it("moves on from a step that hangs past its step timeout, then exits 1", async () => {
    vi.useFakeTimers();
    const closed: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      logger,
      exit,
      stepTimeoutMs: 1000,
      steps: [
        { name: "stuck", close: () => new Promise<never>(() => undefined) },
        {
          name: "redis",
          close: () => {
            closed.push("redis");
            return Promise.resolve();
          },
        },
      ],
    });

    const done = shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(999);
    expect(closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(closed).toEqual(["redis"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("forces exit 1 when the whole sequence exceeds the overall timeout", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createShutdown({
      logger,
      exit,
      stepTimeoutMs: 4000,
      timeoutMs: 5000,
      steps: ["first", "second"].map((name) => ({
        name,
        close: () => new Promise<never>(() => undefined),
      })),
    });

    void shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(4999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
