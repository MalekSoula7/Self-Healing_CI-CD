// SPEC §8.2: rules no policy can change. They're not part of PolicyRules: no layer can set,
// loosen or remove them. The checks that enforce them are P3.4's; the server and the GitHub client
// enforce INV-BRANCH and INV-FORKS too (packages/github, apps/worker).

export type InvariantId =
  | "INV-GITHUB-DIR"
  | "INV-PATH"
  | "INV-SECRETS"
  | "INV-FILE-TYPES"
  | "INV-TEST-DELETE"
  | "INV-BRANCH"
  | "INV-FORKS"
  | "INV-CAPS";

export interface Invariant {
  id: InvariantId;
  description: string;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const INVARIANTS: readonly Invariant[] = deepFreeze([
  {
    id: "INV-GITHUB-DIR",
    description: "No changes under .github/, or to local action definitions (action.yml).",
  },
  {
    id: "INV-PATH",
    description:
      "Every path is safe to check out everywhere: no .git or .gitmodules, no name Windows or macOS would read differently.",
  },
  {
    id: "INV-SECRETS",
    description: "No changes to .env files, keys, certificates or secrets directories.",
  },
  {
    id: "INV-FILE-TYPES",
    description: "No binary files, symlinks, submodule changes or file-mode changes.",
  },
  { id: "INV-TEST-DELETE", description: "No deleting a test file, or renaming one away." },
  {
    id: "INV-BRANCH",
    description:
      "Writes only to pipeheal/* branches the App created; never merge, never force-push.",
  },
  { id: "INV-FORKS", description: "Never act on pull requests from forks." },
  {
    id: "INV-CAPS",
    description:
      "Attempts, iterations, model tokens and wall-clock time are always capped (plan maximums).",
  },
]);

/** Repo-relative globs no change may touch (INV-GITHUB-DIR, INV-SECRETS). */
export const INVARIANT_PATHS: Readonly<
  Record<"INV-GITHUB-DIR" | "INV-SECRETS", readonly string[]>
> = deepFreeze({
  // Local composite actions (`uses: ./path`) are CI code too, wherever they live.
  "INV-GITHUB-DIR": [".github/**", "**/action.yml", "**/action.yaml"],
  "INV-SECRETS": [
    "**/.env",
    "**/.env*",
    "**/*.pem",
    "**/*.key",
    "**/secrets/**",
    "**/*.p12",
    "**/*.pfx",
    "**/*.jks",
    "**/*.keystore",
    "**/id_{rsa,dsa,ecdsa,ed25519}*",
    "**/.npmrc",
    "**/.pypirc",
    "**/.netrc",
    "**/.aws/**",
    "**/.docker/config.json",
    "**/credentials*.json",
    "**/service-account*.json",
  ],
});
