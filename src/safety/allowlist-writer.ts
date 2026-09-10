import { redact } from "./redact.js";

/**
 * Field-allowlist serializer. A record is rebuilt from an explicit field
 * specification: anything not named is dropped rather than inspected, so a new
 * field added upstream cannot leak by default. Approved string fields are then
 * redacted.
 */
export type FieldSpec = { [key: string]: true | "string" | FieldSpec | [FieldSpec] | ["string"] };

export function project(value: unknown, spec: FieldSpec): Record<string, unknown> {
  if (value === null || typeof value !== "object") return {};
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(spec)) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === undefined) continue;
    if (rule === true) {
      out[key] = scrubDeep(v);
    } else if (rule === "string") {
      out[key] = v === null ? null : redact(String(v));
    } else if (Array.isArray(rule)) {
      const inner = rule[0]!;
      const items = Array.isArray(v) ? v : [];
      out[key] =
        inner === "string"
          ? items.map((i) => redact(String(i)))
          : items.map((i) => project(i, inner as FieldSpec));
    } else {
      out[key] = project(v, rule);
    }
  }
  return out;
}

/** For `true` fields: keep the shape, but redact every string inside it. */
function scrubDeep(v: unknown): unknown {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[k] = scrubDeep(inner);
    return out;
  }
  return v;
}
