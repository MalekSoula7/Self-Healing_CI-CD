// Proves the unit-test network guard (vitest.setup.ts): GitHub API calls are served by msw
// handlers, and anything unmocked fails instead of reaching the internet.
import { mockServer } from "@pipeheal/shared/testing";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

describe("network access in unit tests", () => {
  it("serves GitHub API calls from msw handlers", async () => {
    mockServer.use(
      http.get("https://api.github.com/repos/:owner/:repo", ({ params }) =>
        HttpResponse.json({ full_name: `${String(params.owner)}/${String(params.repo)}` }),
      ),
    );

    const response = await fetch("https://api.github.com/repos/acme/api");

    expect(await response.json()).toEqual({ full_name: "acme/api" });
  });

  // Assert on msw's own error: a plain "it rejects" would also pass offline with a broken guard.
  it("fails any request without a handler", async () => {
    await expect(fetch("https://api.github.com/zen")).rejects.toThrow(
      /\[MSW\] Cannot bypass a request/,
    );
  });

  it("resets handlers between tests", async () => {
    // The handler from the first test must be gone.
    await expect(fetch("https://api.github.com/repos/acme/api")).rejects.toThrow(/\[MSW\]/);
  });
});
