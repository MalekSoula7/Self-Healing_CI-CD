// What PipeHeal says on its pull request when CI fails on its commit (SPEC §9.1, P5.3a). Workflow,
// job and step names come from the repository, so they are shown literally.
import { describe, expect, it } from "vitest";
import { ciFailedComment } from "./comments";

const sha = "0123456789abcdef0123456789abcdef01234567";
const job = {
  workflowName: "CI",
  jobName: "check",
  failedStep: "Test",
  runUrl: "https://github.com/acme/app/actions/runs/7",
};

describe("ciFailedComment", () => {
  it("names the commit and what failed, links the run and leaves it to a person", () => {
    const body = ciFailedComment(sha, [job]);

    expect(body).toContain("didn't pass CI on `0123456789ab`");
    expect(body).toContain(`- \`CI\` / \`check\` / \`Test\` · [failed run](${job.runUrl})`);
    expect(body).toContain("PipeHeal never merges.");
  });

  it("says PipeHeal tries once more when a retry started", () => {
    const body = ciFailedComment(sha, [job], true);

    expect(body).toContain("PipeHeal is trying once more");
    expect(body).not.toContain("Someone needs to take it from here.");
  });

  it("shows repository names literally: no mentions, links, HTML or skip-CI markers", () => {
    const body = ciFailedComment(sha, [
      {
        workflowName: "@org/admins [skip ci]",
        jobName: "<img src=x>",
        failedStep: "fixes #1",
        runUrl: "javascript:alert(1)",
      },
    ]);

    expect(body).not.toContain("javascript:");
    expect(body).not.toMatch(/\[skip ci\]/);
    expect(body).not.toMatch(/fixes #1/);
    expect(body).toContain("`<img src=x>`");
  });

  it("says so when a run failed without a failed job, and caps a long list", () => {
    expect(
      ciFailedComment(sha, [{ ...job, jobName: null, failedStep: null, runUrl: null }]),
    ).toContain("- `CI` / `(no failed job)`");
    const body = ciFailedComment(
      sha,
      Array.from({ length: 15 }, () => job),
    );

    expect(body.match(/^- `CI`/gm)).toHaveLength(10);
    expect(body).toContain("and 5 more");
  });
});
