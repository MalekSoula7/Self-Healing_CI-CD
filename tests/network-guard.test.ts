// Unit tests must not open any network connection (vitest.setup.ts). HTTP is caught by msw; this
// covers everything below it: raw sockets, TLS, DNS, WebSocket.
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";

describe("unit test network guard", () => {
  it("blocks TCP connections to external hosts", () => {
    expect(() => net.connect({ host: "example.com", port: 443 })).toThrow(/blocked in unit tests/);
  });

  it("blocks TLS connections", () => {
    expect(() => tls.connect({ host: "example.com", port: 443 })).toThrow(/blocked in unit tests/);
  });

  it("blocks loopback connections too (use an integration test for local services)", () => {
    expect(() => net.connect(6379, "127.0.0.1")).toThrow(/blocked in unit tests/);
  });

  it("blocks DNS lookups of external names", async () => {
    await expect(dns.promises.lookup("example.com")).rejects.toThrow(/blocked in unit tests/);
    const callbackError = await new Promise<unknown>((resolve) => {
      dns.lookup("example.com", (error) => {
        resolve(error);
      });
    });
    expect(String(callbackError)).toMatch(/blocked in unit tests/);
  });

  it("never lets a WebSocket open", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket("wss://example.com/socket");
      socket.addEventListener("open", () => {
        socket.close();
        resolve("opened");
      });
      socket.addEventListener("error", () => {
        resolve("error");
      });
      socket.addEventListener("close", () => {
        resolve("closed");
      });
    });
    expect(outcome).not.toBe("opened");
  });
});
