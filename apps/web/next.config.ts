import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// One .env at the repo root serves every app (SPEC §4.1); by default Next only reads its own folder.
// forceReload is required: Next has already called loadEnvConfig for apps/web, and @next/env
// returns that cached result otherwise. Variables set in the real environment still win.
loadEnvConfig(repoRoot, process.env.NODE_ENV !== "production", undefined, true);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@pipeheal/shared"],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
