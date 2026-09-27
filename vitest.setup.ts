// Runs before every unit test file is imported: all HTTP goes through msw, and unmocked requests fail.
import { mockServer } from "@pipeheal/shared/testing";
import { afterAll, afterEach } from "vitest";

// Listen at load time, not in beforeAll: requests made while a test file is being imported
// (top-level code, describe bodies) must be blocked too. "error" makes the request itself reject
// (a custom callback that throws only yields a 500).
mockServer.listen({ onUnhandledRequest: "error" });

afterEach(() => {
  mockServer.resetHandlers();
});

afterAll(() => {
  mockServer.close();
});
