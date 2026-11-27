// The action's entry point, bundled to dist/index.mjs (D19). GitHub runs it in the healer job.
import { run } from "./main";

process.exitCode = await run({
  env: process.env,
  cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(),
  log: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
