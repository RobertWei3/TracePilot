/**
 * Central redaction. Registered secret values are replaced wherever they
 * appear; PII-shaped values are replaced by pattern. This is a second line of
 * defence -- the first is the field allowlist, which drops anything not
 * explicitly approved for persistence.
 */
const registered = new Map<string, string>();

/** Register a secret so it is masked if it ever reaches a writer. */
export function registerSecret(label: string, value: string): void {
  if (value && value.length >= 4) registered.set(value, `[REDACTED:${label}]`);
}

export function clearSecrets(): void {
  registered.clear();
}

const PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED:ssn]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED:pan]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:api_key]"],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED:token]"],
  // Session cookie shapes (uuid v4), which appear in Set-Cookie and URLs.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED:session]"],
];

export function redact(input: string): string {
  let out = input;
  for (const [value, replacement] of registered) out = out.split(value).join(replacement);
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** True when a string still contains a registered secret. Used by leakage tests. */
export function containsSecret(input: string): boolean {
  for (const value of registered.keys()) if (input.includes(value)) return true;
  return false;
}
