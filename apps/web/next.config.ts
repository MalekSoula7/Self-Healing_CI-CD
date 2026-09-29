import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { publicSecretNames } from "@pipeheal/shared";
import type { NextConfig } from "next";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// One .env at the repo root serves every app (SPEC §4.1); by default Next only reads its own folder.
// forceReload is required: Next has already called loadEnvConfig for apps/web, and @next/env
// returns that cached result otherwise. Variables set in the real environment still win.
loadEnvConfig(repoRoot, process.env.NODE_ENV !== "production", undefined, true);

// NEXT_PUBLIC_ values are inlined into browser bundles at build time: refuse secret-looking names.
const leaked = publicSecretNames(process.env);
if (leaked.length > 0) {
  throw new Error(
    `Refusing to build: ${leaked.join(", ")} look like secrets, and NEXT_PUBLIC_ variables are sent to browsers.`,
  );
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@pipeheal/shared", "@pipeheal/db", "@pipeheal/github"],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
