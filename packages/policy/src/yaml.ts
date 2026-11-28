// A policy layer as YAML (SPEC §8.1): `.pipeheal.yml` (P3.7) and the dashboard's editors (P3.8)
// read and write the same format. Input is untrusted (anyone who can push edits the file), so it is
// read as plain data: core schema (no custom tags), at most 20 aliases (no alias bomb), unique
// keys, at most 64 KB. Problems come back as short `field: message` lines and are never thrown.
import { parseDocument, stringify } from "yaml";
import { policyLayerSchema, type PolicyLayer } from "./rules";

export const MAX_POLICY_YAML_BYTES = 64 * 1024;
export const MAX_POLICY_YAML_ERRORS = 20;
const MAX_ALIASES = 20;
const MAX_ERROR_CHARS = 300;

export type PolicyYamlRead =
  { layer: PolicyLayer; errors: null } | { layer: null; errors: string[] };

/** UTF-8 length without platform APIs (the package has none). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function cap(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length <= MAX_ERROR_CHARS ? line : `${line.slice(0, MAX_ERROR_CHARS - 3)}...`;
}

function failed(errors: readonly string[]): PolicyYamlRead {
  return { layer: null, errors: errors.slice(0, MAX_POLICY_YAML_ERRORS).map(cap) };
}

/** The layer the YAML describes, or why it can't be used. Never throws. */
export function parsePolicyYaml(text: string): PolicyYamlRead {
  if (utf8Length(text) > MAX_POLICY_YAML_BYTES) {
    return failed([`the policy is too large (at most ${String(MAX_POLICY_YAML_BYTES)} bytes)`]);
  }
  let value: unknown;
  try {
    const document = parseDocument(text, { schema: "core", uniqueKeys: true, prettyErrors: false });
    if (document.errors.length > 0) {
      return failed(document.errors.map((error) => `YAML: ${error.message}`));
    }
    value = document.toJS({ maxAliasCount: MAX_ALIASES });
  } catch (error) {
    return failed([`YAML: ${error instanceof Error ? error.message : "unreadable"}`]);
  }
  // An empty document (or only comments) is an empty layer.
  const parsed = policyLayerSchema.safeParse(value ?? {});
  if (!parsed.success) {
    return failed(
      parsed.error.issues.map((issue) => {
        const path = issue.path.map(String).join(".");
        return path === "" ? issue.message : `${path}: ${issue.message}`;
      }),
    );
  }
  return { layer: parsed.data, errors: null };
}

/** A layer as YAML for an editor; an empty layer is an empty document. */
export function formatPolicyYaml(layer: PolicyLayer): string {
  return Object.keys(layer).length === 0 ? "" : stringify(layer, { lineWidth: 100 });
}
