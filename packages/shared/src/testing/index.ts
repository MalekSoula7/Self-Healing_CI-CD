// Test-only helpers, imported as "@pipeheal/shared/testing". Never import this from runtime code.
import { setupServer } from "msw/node";

/**
 * The one msw server for unit tests. `vitest.setup.ts` starts it before every unit test file with
 * `onUnhandledRequest: "error"`, so an unmocked request rejects instead of reaching the real network
 * (GitHub, Anthropic, anything). Tests add mocks with `mockServer.use(...)`; they reset after each test.
 */
export const mockServer = setupServer();
