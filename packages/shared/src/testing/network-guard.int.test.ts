// Integration tests may reach local services (docker compose) but nothing else.
import { once } from "node:events";
import net from "node:net";
import { describe, expect, it } from "vitest";

describe("integration test network guard", () => {
  it("blocks external hosts", () => {
    expect(() => net.connect(443, "example.com")).toThrow(/blocked in integration tests/);
  });

  it("allows loopback, where docker compose publishes Postgres and Redis", async () => {
    const socket = net.connect(6379, "127.0.0.1");
    await once(socket, "connect");
    expect(socket.remoteAddress).toBe("127.0.0.1");
    socket.destroy();
  });
});
