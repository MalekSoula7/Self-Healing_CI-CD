import { describe, expect, it } from "vitest";
import { policyFileStatus } from "./policy-file";

const sha = "a".repeat(40);
const readAt = new Date("2026-11-26T10:00:00Z");

describe("policyFileStatus", () => {
  it("is unread before the worker has looked", () => {
    expect(
      policyFileStatus({
        policyFile: null,
        policyFileErrors: null,
        policyFileCommitSha: null,
        policyFileReadAt: null,
      }),
    ).toEqual({ state: "unread" });
  });

  it("names the sections a loaded file sets", () => {
    expect(
      policyFileStatus({
        policyFile: { tests: {}, limits: {} },
        policyFileErrors: null,
        policyFileCommitSha: sha,
        policyFileReadAt: readAt,
      }),
    ).toEqual({ state: "loaded", commitSha: sha, readAt, fields: ["limits", "tests"] });
  });

  it("lists the errors of an invalid file", () => {
    expect(
      policyFileStatus({
        policyFile: null,
        policyFileErrors: ["limits.maxFilesChanged: Too big"],
        policyFileCommitSha: sha,
        policyFileReadAt: readAt,
      }),
    ).toEqual({
      state: "invalid",
      commitSha: sha,
      readAt,
      errors: ["limits.maxFilesChanged: Too big"],
    });
  });

  it("reports no file, also for stored JSON of an unexpected shape", () => {
    for (const policyFile of [null, ["not", "a", "layer"]]) {
      expect(
        policyFileStatus({
          policyFile,
          policyFileErrors: "not a list",
          policyFileCommitSha: sha,
          policyFileReadAt: null,
        }),
      ).toEqual({ state: "absent", commitSha: sha, readAt: null });
    }
  });
});
