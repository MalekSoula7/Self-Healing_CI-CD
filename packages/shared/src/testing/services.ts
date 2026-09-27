// URLs of the local docker compose services for integration tests, resolved once by
// vitest.integration.globalSetup.ts (shell env, then the root .env, then the defaults).
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    redisUrl: string;
  }
}

export function testRedisUrl(): string {
  return inject("redisUrl");
}
