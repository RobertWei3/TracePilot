import { FINGERPRINT_PATTERN, type Check, type Descriptor, type LocatorCandidate, type ValueRef } from "../contracts/index.js";

/**
 * One-line renderings of the pieces of a capability, shared by inspect and
 * diff. They print what the artifact holds and nothing more: a capability
 * carries references such as <input:member_id>, never the values themselves,
 * so rendering it cannot disclose an input or a credential.
 */

/**
 * The same shape as summarize() in browser/descriptor.ts, which this module
 * cannot import: inspect depends on contracts/ alone, so that reading a
 * capability never loads the code that drives a browser.
 */
export function summarizeTarget(d: Descriptor): string {
  const bits = [d.role];
  if (d.accessibleName) bits.push(`"${d.accessibleName}"`);
  else if (d.labelText) bits.push(`labelled "${d.labelText}"`);
  else if (d.nearbyText) bits.push(`near "${d.nearbyText}"`);
  if (d.scope?.anchorInput) bits.push(`in the row for {input:${d.scope.anchorInput}}`);
  else if (d.scope?.containerName) bits.push(`in "${d.scope.containerName}"`);
  if (d.nth !== undefined) bits.push(`#${d.nth}`);
  return bits.join(" ");
}

/** Every identifying field of a descriptor, for when the summary alone hides a change. */
export function detailTarget(d: Descriptor): string {
  const bits = [`${d.role} <${d.tagName}>`];
  if (d.accessibleName) bits.push(`name "${d.accessibleName}"`);
  if (d.labelText) bits.push(`label "${d.labelText}"`);
  if (d.nearbyText) bits.push(`near "${d.nearbyText}"`);
  if (d.scope?.containerName) bits.push(`in ${d.scope.containerRole ?? "container"} "${d.scope.containerName}"`);
  if (d.scope?.anchorInput) bits.push(`row for <input:${d.scope.anchorInput}>`);
  if (d.nth !== undefined) bits.push(`#${d.nth}`);
  return bits.join(", ");
}

export function renderLocators(candidates: LocatorCandidate[]): string {
  return candidates.map((c) => `${c.rank}:${c.strategy} ${c.expr}`).join(" | ");
}

export function renderValue(v: ValueRef): string {
  if ("input" in v) return `<input:${v.input}>`;
  if ("secret" in v) return `<secret:${v.secret}>`;
  if ("const" in v) return JSON.stringify(v.const);
  const t = v.transform;
  if (t.op === "template") return `template ${JSON.stringify(t.format ?? "")}`;
  return `${t.op}(${t.arg ? renderValue(t.arg as ValueRef) : ""})`;
}

export function renderCheck(c: Check): string {
  const bits: string[] = [c.kind];
  if (c.pattern !== undefined) bits.push(`"${c.pattern}"`);
  if (c.target) bits.push(summarizeTarget(c.target as Descriptor));
  if (c.value) bits.push(renderValue(c.value));
  return bits.join(" ");
}

/** A fingerprint as stored, flagged when it is not one browser/ could have produced. */
export function renderFingerprint(fp: string | undefined): string {
  if (fp === undefined) return "(none)";
  return FINGERPRINT_PATTERN.test(fp) ? fp : `${fp} (malformed)`;
}

/** The input and secret names a value draws on, including those inside a template. */
export function referencesOf(v: ValueRef | undefined, into = new Set<string>()): Set<string> {
  if (!v) return into;
  if ("input" in v) into.add(`<input:${v.input}>`);
  else if ("secret" in v) into.add(`<secret:${v.secret}>`);
  else if ("transform" in v) {
    for (const m of (v.transform.format ?? "").matchAll(/\{([^}]+)\}/g)) into.add(`<input:${m[1]}>`);
    referencesOf(v.transform.arg as ValueRef | undefined, into);
  }
  return into;
}

/** JSON with sorted keys, so two equal values always serialise the same way. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  ) ?? "undefined";
}
