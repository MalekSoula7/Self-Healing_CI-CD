import { describe, expect, it } from "vitest";
import { auditChanges } from "./audit";

describe("auditChanges", () => {
  it("records only the fields that changed, as from/to", () => {
    expect(
      auditChanges(
        { login: "old-name", accountType: "ORG", installationId: 1n },
        { login: "new-name", accountType: "ORG", installationId: 2n },
      ),
    ).toEqual({
      login: { from: "old-name", to: "new-name" },
      installationId: { from: "1", to: "2" },
    });
  });

  it("is empty when nothing changed", () => {
    expect(
      auditChanges({ name: "CI", usesEnvironment: false }, { name: "CI", usesEnvironment: false }),
    ).toEqual({});
  });

  it("compares lists by content and order", () => {
    expect(auditChanges({ triggers: ["push"] }, { triggers: ["push"] })).toEqual({});
    expect(
      auditChanges({ triggers: ["push", "pull_request"] }, { triggers: ["pull_request", "push"] }),
    ).toEqual({
      triggers: { from: ["push", "pull_request"], to: ["pull_request", "push"] },
    });
  });

  it("records a value becoming null, or appearing, with null on the other side", () => {
    expect(auditChanges({ installerGithubId: 42n }, { installerGithubId: null })).toEqual({
      installerGithubId: { from: "42", to: null },
    });
    expect(auditChanges({}, { installerGithubId: 43n })).toEqual({
      installerGithubId: { from: null, to: "43" },
    });
  });

  it("records only the fields the caller passes in `after`", () => {
    expect(auditChanges({ name: "a", secret: "x" }, { name: "b" })).toEqual({
      name: { from: "a", to: "b" },
    });
  });
});
