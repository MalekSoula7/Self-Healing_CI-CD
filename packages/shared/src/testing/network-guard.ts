// Socket-level network guard for tests. msw only sees HTTP (fetch, http, XMLHttpRequest); this
// guard sits below it, on every TCP/TLS connect and DNS lookup, so nothing reaches the network by
// another route (raw sockets, database drivers, WebSocket clients, DNS exfiltration).
//   block-all:     unit tests, no connection at all
//   loopback-only: integration tests, local docker compose services only
import dns from "node:dns";
import net from "node:net";

export type NetworkGuardMode = "block-all" | "loopback-only";

const MODE = Symbol.for("pipeheal.networkGuard.mode");
const INSTALLED = Symbol.for("pipeheal.networkGuard.installed");

interface GuardState {
  [MODE]?: NetworkGuardMode;
  [INSTALLED]?: boolean;
}

const state = globalThis as GuardState;

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

type Target = { kind: "tcp"; host: string; port: string } | { kind: "ipc" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Socket#connect is called as (options, cb), (port, host?, cb), (path, cb) or, from net.connect,
// with a single pre-normalized [options, cb] array.
function targetOf(args: readonly unknown[]): Target {
  const [first, second] = args;
  if (Array.isArray(first)) return targetOf(first);
  if (isRecord(first)) {
    if (typeof first.path === "string") return { kind: "ipc" };
    const host = typeof first.host === "string" ? first.host : "localhost";
    return { kind: "tcp", host, port: String(first.port) };
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return {
      kind: "tcp",
      host: typeof second === "string" ? second : "localhost",
      port: String(first),
    };
  }
  return { kind: "ipc" };
}

function blockedError(what: string): Error {
  const mode = state[MODE];
  return mode === "block-all"
    ? new Error(
        `Network access is blocked in unit tests (${what}). Mock HTTP with mockServer.use(...), or write an integration test (*.int.test.ts) for local services.`,
      )
    : new Error(
        `Network access is blocked in integration tests except loopback (${what}). Only local docker compose services are reachable.`,
      );
}

function tcpAllowed(host: string): boolean {
  return state[MODE] === "loopback-only" && isLoopback(host);
}

function lookupAllowed(hostname: unknown): boolean {
  return typeof hostname === "string" && isLoopback(hostname);
}

function patch(target: object, key: string, replacement: (original: never) => unknown): void {
  const original: unknown = Reflect.get(target, key);
  Object.defineProperty(target, key, {
    value: replacement(original as never),
    writable: true,
    configurable: true,
  });
}

function install(): void {
  type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;
  patch(
    net.Socket.prototype,
    "connect",
    (original: Connect) =>
      function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
        const target = targetOf(args);
        if (target.kind === "tcp" && !tcpAllowed(target.host)) {
          throw blockedError(`connect to ${target.host}:${target.port}`);
        }
        return Reflect.apply(original, this, args);
      },
  );

  type Lookup = (...args: unknown[]) => unknown;
  patch(
    dns,
    "lookup",
    (original: Lookup) =>
      function guardedLookup(...args: unknown[]): unknown {
        const [hostname] = args;
        if (!lookupAllowed(hostname)) {
          const callback = args.at(-1);
          const error = blockedError(`DNS lookup of ${String(hostname)}`);
          if (typeof callback === "function") {
            process.nextTick(() => {
              Reflect.apply(callback, undefined, [error]);
            });
            return undefined;
          }
          throw error;
        }
        return Reflect.apply(original, dns, args);
      },
  );

  type PromiseLookup = (...args: unknown[]) => Promise<unknown>;
  patch(
    dns.promises,
    "lookup",
    (original: PromiseLookup) =>
      function guardedPromiseLookup(...args: unknown[]): Promise<unknown> {
        const [hostname] = args;
        if (!lookupAllowed(hostname)) {
          return Promise.reject(blockedError(`DNS lookup of ${String(hostname)}`));
        }
        return Reflect.apply(original, dns.promises, args);
      },
  );
}

/** Installs the guard once per process; later calls only switch the mode. */
export function installNetworkGuard(mode: NetworkGuardMode): void {
  state[MODE] = mode;
  if (state[INSTALLED] === true) return;
  install();
  state[INSTALLED] = true;
}
