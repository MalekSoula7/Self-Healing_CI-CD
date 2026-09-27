// Runs before every unit test file: all HTTP goes through msw, and unmocked requests fail.
import { mockServer } from "@pipeheal/shared/testing";
import { afterAll, afterEach, beforeAll } from "vitest";

beforeAll(() => {
  // "error" makes the request itself reject. (A custom callback that throws only yields a 500.)
  mockServer.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  mockServer.resetHandlers();
});

afterAll(() => {
  mockServer.close();
});
