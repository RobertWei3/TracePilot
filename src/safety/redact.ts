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
  inputs.clear();
}

/**
 * Inputs shorter than this are never tagged: replacing a two-letter state
 * code by substring would corrupt every word containing it. The in-page
 * observation builder uses the same threshold (MIN_TAGGED_VALUE_LENGTH), so
 * what reaches a model and what reaches disk agree about the contract.
 */
export const INPUT_TAG_MIN_LENGTH = 3;

const inputs = new Map<string, string>();

/**
 * Register a run's input values, so every writer that redacts also tags them
 * as <input:name>. URLs, page text and refusals carry the subject's values in
 * places no field allowlist can predict -- /members/M-1002/edit -- and the
 * one place every persisted string passes through is here.
 */
export function registerInputs(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value && value.length >= INPUT_TAG_MIN_LENGTH) inputs.set(value, `<input:${name}>`);
  }
}

const PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED:ssn]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED:pan]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:api_key]"],
  // Other providers' keys (DeepSeek, OpenAI-style): sk- and a long token.
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:api_key]"],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED:token]"],
  // Session cookie shapes (uuid v4), which appear in Set-Cookie and URLs.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED:session]"],
];

export function redact(input: string): string {
  let out = input;
  for (const [value, replacement] of registered) out = out.split(value).join(replacement);
  // Longest first, so a value containing another is tagged whole.
  const byLength = [...inputs].sort((a, b) => b[0].length - a[0].length);
  for (const [value, tag] of byLength) out = out.split(value).join(tag);
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** True when a string still contains a registered secret. Used by leakage tests. */
export function containsSecret(input: string): boolean {
  for (const value of registered.keys()) if (input.includes(value)) return true;
  return false;
}
