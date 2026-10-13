import {
  FINGERPRINT_PATTERN,
  summarize,
  type Capability,
  type Check,
  type Descriptor,
  type FieldSpec,
  type Step,
  type ValueRef,
} from "../contracts/index.js";

/**
 * One-line renderings of the pieces of a capability, shared by inspect and
 * diff. They print what the artifact holds and nothing more: a capability
 * carries references such as <input:member_id>, never the values themselves,
 * so rendering it cannot disclose an input or a credential.
 */

type Extract = Capability["outputs"][string]["source"]["extract"];

/** Every identifying field of a descriptor, for when the summary alone hides a change. */
export function detailTarget(d: Omit<Descriptor, "candidates">): string {
  const bits = [`${d.role} <${d.tagName}>`];
  if (d.accessibleName) bits.push(`name "${d.accessibleName}"`);
  if (d.labelText) bits.push(`label "${d.labelText}"`);
  if (d.nearbyText) bits.push(`near "${d.nearbyText}"`);
  if (d.scope?.containerName) bits.push(`in ${d.scope.containerRole ?? "container"} "${d.scope.containerName}"`);
  if (d.scope?.anchorInput) bits.push(`row for <input:${d.scope.anchorInput}>`);
  if (d.nth !== undefined) bits.push(`#${d.nth}`);
  return bits.join(", ");
}

/** What a step acts on, in one line: its target, the URL it opens, or the fields a gate shows. */
export function stepTarget(s: Step): string {
  if (s.action === "approval_gate") return `shows: ${(s.diffFields ?? []).map((f) => f.label).join("; ")}`;
  if (s.action === "navigate" && s.value) return renderValue(s.value);
  return s.target ? summarize(s.target) : "";
}

export function renderValue(v: ValueRef): string {
  if ("input" in v) return `<input:${v.input}>`;
  if ("secret" in v) return `<secret:${v.secret}>`;
  if ("const" in v) return JSON.stringify(v.const);
  const transform = v.transform;
  if (transform.op === "template") return `template ${JSON.stringify(transform.format ?? "")}`;
  return `${transform.op}(${transform.arg ? renderValue(transform.arg) : ""})`;
}

export function renderCheck(c: Check): string {
  const bits: string[] = [c.kind];
  if (c.pattern !== undefined) bits.push(`"${c.pattern}"`);
  if (c.target) bits.push(summarize(c.target));
  if (c.value) bits.push(renderValue(c.value));
  return bits.join(" ");
}

export function renderWait(w: Step["waitFor"]): string {
  if (!w) return "(none)";
  const bits: string[] = [w.kind];
  if (w.pattern) bits.push(`"${w.pattern}"`);
  if (w.target) bits.push(summarize(w.target));
  bits.push(`${w.timeoutMs}ms`);
  return bits.join(" ");
}

export function renderExtract(e: Extract): string {
  return [e.kind, e.attr ? `@${e.attr}` : "", e.regex !== undefined ? `/${e.regex}/` : ""].filter(Boolean).join(" ");
}

/** A fingerprint as stored, flagged when it is not one browser/ could have produced. */
export function renderFingerprint(fp: string | undefined): string {
  if (fp === undefined) return "(none)";
  return FINGERPRINT_PATTERN.test(fp) ? fp : `${fp} (malformed)`;
}

/**
 * `{address.city}` in a template or a URL pattern names an input. Only
 * identifier-shaped braces count, so a regex quantifier such as {8} does not.
 */
const PLACEHOLDER = /\{([A-Za-z_][\w.]*)\}/g;

/** The input and secret names a step draws on, from its values, checks, wait and gate. */
export function referencesOf(s: Step): string[] {
  const refs = new Set<string>();
  const fromText = (text: string | undefined) => {
    for (const m of (text ?? "").matchAll(PLACEHOLDER)) refs.add(`<input:${m[1]}>`);
  };
  const fromValue = (v: ValueRef | undefined): void => {
    if (!v) return;
    if ("input" in v) refs.add(`<input:${v.input}>`);
    else if ("secret" in v) refs.add(`<secret:${v.secret}>`);
    else if ("transform" in v) {
      fromText(v.transform.format);
      fromValue(v.transform.arg);
    }
  };
  fromValue(s.value);
  if (s.target?.scope?.anchorInput) refs.add(`<input:${s.target.scope.anchorInput}>`);
  for (const c of [...s.precondition, ...s.checks]) {
    fromText(c.pattern);
    fromValue(c.value);
  }
  fromText(s.waitFor?.pattern);
  for (const f of s.diffFields ?? []) fromValue(f.value);
  return [...refs];
}

/** Leaf fields only: an object input is a namespace, its leaves are what a caller supplies. */
export function leafFields(fields: Record<string, FieldSpec>, prefix = ""): [string, FieldSpec][] {
  return Object.entries(fields).flatMap(([key, f]): [string, FieldSpec][] =>
    f.properties ? leafFields(f.properties, `${prefix}${key}.`) : [[`${prefix}${key}`, f]],
  );
}

/** JSON with sorted keys, so two equal values always serialise the same way. */
export function stableJson(v: unknown): string {
  return (
    JSON.stringify(v, (_k, x: unknown) =>
      x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
        : x,
    ) ?? "undefined"
  );
}
