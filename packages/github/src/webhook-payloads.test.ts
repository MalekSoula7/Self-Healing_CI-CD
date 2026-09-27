import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  installationEventSchema,
  installationRepositoriesEventSchema,
  toAccountType,
} from "./webhook-payloads";

// Modeled on GitHub's documented `installation` and `installation_repositories` webhook
// payloads, trimmed to realistic shape with fields this package doesn't use omitted.
function installationPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "created",
    installation: {
      id: 30219350,
      account: { id: 1247608, login: "octo-org", type: "Organization" },
      repository_selection: "selected",
      app_id: 123456,
      target_type: "Organization",
      permissions: { actions: "write", contents: "write" },
      events: ["workflow_run"],
      created_at: "2026-09-27T00:00:00Z",
      updated_at: "2026-09-27T00:00:00Z",
    },
    repositories: [{ id: 558712345, name: "app", full_name: "octo-org/app", private: false }],
    sender: { id: 9998877, login: "octo-dev", type: "User" },
    ...overrides,
  };
}

function installationRepositoriesPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "added",
    installation: {
      id: 30219350,
      account: { id: 1247608, login: "octo-org", type: "Organization" },
      repository_selection: "selected",
    },
    repository_selection: "selected",
    repositories_added: [
      { id: 558712999, name: "another", full_name: "octo-org/another", private: true },
    ],
    repositories_removed: [],
    sender: { id: 9998877, login: "octo-dev", type: "User" },
    ...overrides,
  };
}

describe("installationEventSchema", () => {
  it("parses a real-shaped `created` payload, converting numeric ids to BigInt", () => {
    const event = installationEventSchema.parse(installationPayload());

    expect(event).toEqual({
      action: "created",
      installation: {
        id: 30219350n,
        account: { id: 1247608n, login: "octo-org", type: "Organization" },
      },
      sender: { id: 9998877n, login: "octo-dev" },
      repositories: [{ id: 558712345n, full_name: "octo-org/app" }],
    });
  });

  it("parses `deleted`/`suspend`/`unsuspend`, where `repositories` is absent", () => {
    for (const action of ["deleted", "suspend", "unsuspend", "new_permissions_accepted"]) {
      const payload = installationPayload({ action, repositories: undefined });
      const event = installationEventSchema.parse(payload);
      expect(event.action).toBe(action);
      expect(event.repositories).toBeUndefined();
    }
  });

  it("ignores fields it doesn't use, so a new GitHub field can't break parsing", () => {
    const event = installationEventSchema.parse(
      installationPayload({ some_future_field: { nested: true } }),
    );
    expect(event).not.toHaveProperty("some_future_field");
  });

  it("rejects a personal account installation's account type as User, mapped correctly", () => {
    const event = installationEventSchema.parse(
      installationPayload({
        installation: {
          id: 1,
          account: { id: 42, login: "octo-dev", type: "User" },
        },
      }),
    );
    expect(toAccountType(event.installation.account.type)).toBe("USER");
  });

  it.each([
    [
      "a missing installation id",
      { installation: { account: { id: 1, login: "x", type: "User" } } },
    ],
    [
      "a non-numeric account id",
      { installation: { id: 1, account: { id: "x", login: "x", type: "User" } } },
    ],
    [
      "an unknown account type",
      { installation: { id: 1, account: { id: 1, login: "x", type: "Bot" } } },
    ],
    ["no sender", { sender: undefined }],
  ])("rejects a payload with %s", (_label, override) => {
    expect(() => installationEventSchema.parse(installationPayload(override))).toThrow(ZodError);
  });
});

describe("installationRepositoriesEventSchema", () => {
  it("parses `added`", () => {
    const event = installationRepositoriesEventSchema.parse(installationRepositoriesPayload());

    expect(event).toEqual({
      action: "added",
      installation: {
        id: 30219350n,
        account: { id: 1247608n, login: "octo-org", type: "Organization" },
      },
      repositories_added: [{ id: 558712999n, full_name: "octo-org/another" }],
      repositories_removed: [],
    });
  });

  it("parses `removed`", () => {
    const event = installationRepositoriesEventSchema.parse(
      installationRepositoriesPayload({
        action: "removed",
        repositories_added: [],
        repositories_removed: [{ id: 1, name: "gone", full_name: "octo-org/gone", private: false }],
      }),
    );

    expect(event.action).toBe("removed");
    expect(event.repositories_removed).toEqual([{ id: 1n, full_name: "octo-org/gone" }]);
  });

  it("defaults each list to empty when GitHub omits it", () => {
    const payload = installationRepositoriesPayload({ repositories_added: undefined });

    const event = installationRepositoriesEventSchema.parse(payload);

    expect(event.repositories_added).toEqual([]);
  });

  it("rejects an action other than added/removed", () => {
    expect(() =>
      installationRepositoriesEventSchema.parse(
        installationRepositoriesPayload({ action: "renamed" }),
      ),
    ).toThrow(ZodError);
  });
});
