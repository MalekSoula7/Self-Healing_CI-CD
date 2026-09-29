// `pnpm break <scenario> --repo <clone of a demo repo> [--push]`: introduces one SPEC §14 eval
// scenario on a new branch of the demo repo, as an ordinary-looking commit. `pnpm break --list`
// shows the scenarios. See examples/README.md.
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { SCENARIOS, ScenarioError, findScenario } from "./lib/break-scenarios";
import { breakRepo } from "./lib/break-run";

const USAGE =
  "Usage: pnpm break <scenario> --repo <path to a clone of the demo repo> [--push]\n" +
  "       pnpm break --list";

function list(): string {
  return SCENARIOS.map(
    (s) =>
      `  ${s.id.padEnd(26)} ${s.summary}\n  ${"".padEnd(26)} expected: ${s.category}; ${s.expected}`,
  ).join("\n");
}

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      push: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
  });
  if (values.list) {
    process.stdout.write(`${list()}\n`);
    return 0;
  }
  const [id] = positionals;
  const scenario = id === undefined ? undefined : findScenario(id);
  if (scenario === undefined || values.repo === undefined || positionals.length !== 1) {
    process.stderr.write(`${USAGE}\n\nScenarios:\n${list()}\n`);
    return 1;
  }
  try {
    const result = breakRepo(scenario, {
      repo: values.repo,
      selfRepo: fileURLToPath(new URL(".", import.meta.url)),
      push: values.push,
    });
    process.stdout.write(
      `Created ${result.branch} (${result.changed.join(", ")}).\n` +
        (result.pushed
          ? "Pushed: CI runs on it now.\n"
          : `Not pushed: run \`git push -u origin ${result.branch}\` in the demo repo to run CI.\n`) +
        `Expected: ${scenario.category}; ${scenario.expected}.\n`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof ScenarioError)) throw error;
    process.stderr.write(`break: ${error.message}\n`);
    return 1;
  }
}

process.exitCode = main();
