// Local mode's entry point (P4.6), bundled to dist/local.mjs and run by `pnpm heal:local` in a
// Linux container. The same run as in a GitHub job, except the session: there's no Actions job to
// mint an OIDC token, so the CLI opens a real session through the server's own helpers and passes
// it in (SPEC §12: no auth bypass, the gateway checks this token like any other). It comes on
// stdin, read before anything runs, so it never sits in the container's environment where code
// under test could read it from /proc (P4.6 review M2). Children get no stdin.
import { z } from "zod";
import { readLocalSession, run } from "./main";

const log = (line: string) => {
  process.stdout.write(`${line}\n`);
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8").trim();
}

const session = readLocalSession(await readStdin());
const gateway = z.url().safeParse(process.env.PIPEHEAL_LOCAL_GATEWAY);
if (session === null || !gateway.success) {
  log("::error::local mode needs the session on stdin and PIPEHEAL_LOCAL_GATEWAY");
  process.exitCode = 1;
} else {
  process.exitCode = await run({
    env: { ...process.env, "INPUT_JOB-ID": session.attemptId, "INPUT_GATEWAY-URL": gateway.data },
    cwd: process.cwd(),
    log,
    session: { token: session.token, details: session.details },
    // Plain http only to the developer's machine, never to another host (P4.6 review L6).
    plainHttpHosts: ["host.docker.internal"],
  });
}
