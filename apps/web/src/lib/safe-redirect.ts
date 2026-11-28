const PLACEHOLDER_ORIGIN = "http://pipeheal.invalid";

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A same-origin path to send the user to after sign-in, or "/" when `value` is anything else:
 * no open redirects (`//evil.example`, `/\evil.example`, absolute URLs), and no loops back into
 * the sign-in flow.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || hasControlCharacter(value)) return "/";
  const url = new URL(value, PLACEHOLDER_ORIGIN);
  // Dot segments normalize "/.//evil.example" to "//evil.example": check the result, not the input.
  if (url.origin !== PLACEHOLDER_ORIGIN || url.pathname.startsWith("//")) return "/";
  if (/^\/(login|auth|api)(\/|$)/.test(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
