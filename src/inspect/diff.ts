import type { Capability, Check, Descriptor, Step } from "../contracts/index.js";
import {
  detailTarget,
  leafFields,
  renderCheck,
  renderExtract,
  renderFingerprint,
  renderValue,
  renderWait,
  stableJson,
  stepTarget,
} from "./render.js";

export class DiffError extends Error {}

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface StepRef {
  stepId: string;
  /** phase, action and target in one line, to say which step without the file open. */
  summary: string;
}

export interface StepChange {
  /** The step's id in the first capability. */
  a: string;
  /** The aligned step's id in the second; ids are positional, so it may differ. */
  b: string;
  summary: string;
  changes: FieldChange[];
}

export interface KeyedChanges {
  added: string[];
  removed: string[];
  changed: { name: string; changes: FieldChange[] }[];
}

export interface CapabilityDiff {
  capabilityId: string;
  versions: [number, number];
  /**
   * Version, creation time, review status and source run. Shown, but never
   * counted as a difference: any two versions differ here, and status records
   * whether a person has reviewed the artifact, not what it does.
   */
  header: FieldChange[];
  /** Capability-level fields that change what replay does: origin, session, dialogs. */
  meta: FieldChange[];
  steps: { countA: number; countB: number; added: StepRef[]; removed: StepRef[]; changed: StepChange[] };
  inputs: KeyedChanges;
  outputs: KeyedChanges;
  businessOutcomes: KeyedChanges;
  /** True when nothing outside `header` differs. */
  identical: boolean;
}

export function isEmpty(changes: { added: unknown[]; removed: unknown[]; changed: unknown[] }): boolean {
  return changes.added.length + changes.removed.length + changes.changed.length === 0;
}

/**
 * Compare two versions of one capability.
 *
 * Prose is not compared: a step's `reason`, a check's `describes` and an
 * input's `description` are written by the model and reworded on every
 * discovery, without changing what replay does. Nor are locator ladders: they
 * are rebuilt from the page on every discovery, and a control that really
 * changed shows up in its descriptor and its surface fingerprint instead.
 */
export function diff(a: Capability, b: Capability): CapabilityDiff {
  if (a.capabilityId !== b.capabilityId) {
    throw new DiffError(`different capabilities: ${a.capabilityId} and ${b.capabilityId}`);
  }

  const provA = a.provenance;
  const provB = b.provenance;
  const header = compact([
    change("version", a.version, b.version, String),
    change("createdAt", a.createdAt, b.createdAt, String),
    change("status", a.status, b.status, String),
    change("provenance.runId", provA.runId, provB.runId, String),
    change("provenance.model", provA.model, provB.model, String),
    change("provenance.authoredBy", provA.authoredBy, provB.authoredBy, (x) => `${x.agent} agent, ${x.human} human`),
    change("provenance.appFingerprint", provA.appFingerprint, provB.appFingerprint, String),
    change("provenance.outcomeRunIds", provA.outcomeRunIds ?? [], provB.outcomeRunIds ?? [], (x) => x.join(", ") || "(none)"),
  ]);
  const meta = compact([
    change("origin", a.origin, b.origin, String),
    change("surfaceKind", a.surfaceKind, b.surfaceKind, String),
    change("tenantId", a.tenantId, b.tenantId, String),
    change("overrides", a.overrides, b.overrides, stableJson),
    change("requires", a.requires, b.requires, stableJson),
    change("expectedDialogs", a.expectedDialogs, b.expectedDialogs, stableJson),
  ]);

  const pairs = align(a.steps, b.steps);
  const pairedA = new Set(pairs.map(([i]) => i));
  const pairedB = new Set(pairs.map(([, j]) => j));
  const steps = {
    countA: a.steps.length,
    countB: b.steps.length,
    removed: a.steps.filter((_, i) => !pairedA.has(i)).map(stepRef),
    added: b.steps.filter((_, j) => !pairedB.has(j)).map(stepRef),
    changed: pairs.flatMap(([i, j]) => {
      const [stepA, stepB] = [a.steps[i]!, b.steps[j]!];
      const changes = compareSteps(stepA, stepB);
      return changes.length ? [{ a: stepA.stepId, b: stepB.stepId, summary: stepRef(stepB).summary, changes }] : [];
    }),
  };

  // Outputs name the step that binds them by id, and ids are positional, so
  // the source is compared through the alignment rather than by its literal id.
  const alignedId = new Map(pairs.map(([i, j]) => [a.steps[i]!.stepId, b.steps[j]!.stepId]));
  const outputs = keyed(a.outputs, b.outputs, (before, after) =>
    compact([
      change("type", before.type, after.type, String),
      change("pattern", before.pattern, after.pattern, (p) => p ?? "(none)"),
      change("required", before.required, after.required, String),
      change("extract", before.source.extract, after.source.extract, renderExtract),
      alignedId.get(before.source.stepId) === after.source.stepId
        ? null
        : {
            field: "source",
            from: `${before.source.stepId} (aligned with ${alignedId.get(before.source.stepId) ?? "no step"})`,
            to: after.source.stepId,
          },
    ]),
  );

  const inputs = keyed(Object.fromEntries(leafFields(a.inputs)), Object.fromEntries(leafFields(b.inputs)), (before, after) =>
    compact(
      (["type", "optional", "sensitive", "pattern"] as const).map((k) =>
        change(k, before[k], after[k], (v) => (v === undefined ? "(none)" : String(v))),
      ),
    ),
  );

  const businessOutcomes = keyed(recognizersByCode(a), recognizersByCode(b), (before, after) =>
    compact([change("when", before, after, (w) => w.map(renderCheck).join(" | "))]),
  );

  const identical = meta.length === 0 && [steps, inputs, outputs, businessOutcomes].every(isEmpty);

  return { capabilityId: a.capabilityId, versions: [a.version, b.version], header, meta, steps, inputs, outputs, businessOutcomes, identical };
}

/**
 * Pair each step of `a` with its counterpart in `b`, as [indexInA, indexInB].
 *
 * Neither stepId nor position identifies a step across versions. The compiler
 * assigns ids by position (sid() in compiler/compile.ts), so one step inserted
 * by a new discovery renumbers every step after it, and position shifts the
 * same way; hand-written capabilities do not even agree on where numbering
 * starts. So steps are aligned by what they do: a longest common subsequence
 * over (phase, action, role, name), which keeps order and survives insertions
 * and deletions.
 *
 * The name is the accessible name when the control has one. Unnamed controls
 * fall back to their label, then to the text beside them: DemoBank's City,
 * State and ZIP boxes have no accessible name, and keyed on role alone they
 * would be indistinguishable, so removing City would be read as removing ZIP.
 *
 * The name is in the key, so a renamed control would fall out of the
 * subsequence as one removal and one addition -- yet a rename is exactly the
 * drift T4's fingerprint warnings point at. A second pass therefore pairs what
 * is left within each gap between matched steps, in order, when phase, action
 * and role agree, and the rename is reported as a change to the target.
 */
function align(a: Step[], b: Step[]): [number, number][] {
  const key = (s: Step) => stableJson([s.phase, s.action, s.target?.role ?? null, nameOf(s.target)]);
  const keysA = a.map(key);
  const keysB = b.map(key);

  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = keysA[i] === keysB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const anchors: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (keysA[i] === keysB[j]) anchors.push([i++, j++]);
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }

  const shape = (s: Step) => stableJson([s.phase, s.action, s.target?.role ?? null]);
  const pairs: [number, number][] = [];
  let prevA = -1;
  let prevB = -1;
  for (const [anchorA, anchorB] of [...anchors, [a.length, b.length] as [number, number]]) {
    let nextB = prevB + 1;
    for (let i = prevA + 1; i < anchorA; i++) {
      for (let j = nextB; j < anchorB; j++) {
        if (shape(a[i]!) === shape(b[j]!)) {
          pairs.push([i, j]);
          nextB = j + 1;
          break;
        }
      }
    }
    if (anchorA < a.length) pairs.push([anchorA, anchorB]);
    prevA = anchorA;
    prevB = anchorB;
  }
  return pairs.sort(([x], [y]) => x - y);
}

function nameOf(d: Descriptor | undefined): string | null {
  return d?.accessibleName ?? d?.labelText ?? d?.nearbyText ?? null;
}

function compareSteps(before: Step, after: Step): FieldChange[] {
  const checks = (cs: Check[]) => (cs.length ? cs.map(renderCheck).join("; ") : "(none)");
  const descriptor = (t: Descriptor | undefined) => (t ? (({ candidates: _, ...rest }) => rest)(t) : undefined);
  return compact([
    change("target", descriptor(before.target), descriptor(after.target), (t) => (t ? detailTarget(t) : "(none)")),
    change("effect", before.effect, after.effect, String),
    change("value", before.value, after.value, (v) => (v ? renderValue(v) : "(none)")),
    change("precondition", withoutProse(before.precondition), withoutProse(after.precondition), checks),
    change("checks", withoutProse(before.checks), withoutProse(after.checks), checks),
    change("waitFor", before.waitFor, after.waitFor, renderWait),
    change("extractAs", before.extractAs, after.extractAs, (e) => e ?? "(none)"),
    change("diffFields", before.diffFields, after.diffFields, (fs) =>
      fs ? fs.map((f) => `"${f.label}" = ${renderValue(f.value)}`).join("; ") : "(none)",
    ),
    change("authoredBy", before.authoredBy, after.authoredBy, String),
    change("unresolved", before.unresolved, after.unresolved, String),
    change("surfaceFingerprint", before.surfaceFingerprint, after.surfaceFingerprint, renderFingerprint),
  ]);
}

/**
 * A change when the two values are not structurally equal. Equality is decided
 * on the data; the rendering is only for reading, and falls back to JSON when
 * it would show the same text on both sides.
 */
function change<T>(field: string, x: T, y: T, render: (v: T) => string): FieldChange | null {
  if (stableJson(x) === stableJson(y)) return null;
  let from = render(x);
  let to = render(y);
  if (from === to) {
    from = stableJson(x);
    to = stableJson(y);
  }
  return { field, from, to };
}

function keyed<T>(
  a: Record<string, T>,
  b: Record<string, T>,
  compare: (x: T, y: T) => FieldChange[],
): KeyedChanges {
  return {
    added: Object.keys(b).filter((k) => !(k in a)),
    removed: Object.keys(a).filter((k) => !(k in b)),
    changed: Object.keys(a)
      .filter((k) => k in b)
      .map((name) => ({ name, changes: compare(a[name]!, b[name]!) }))
      .filter((c) => c.changes.length > 0),
  };
}

/** Recognizers by code; one code may be recognised by several conditions. */
function recognizersByCode(cap: Capability): Record<string, Check[]> {
  const out: Record<string, Check[]> = {};
  for (const o of cap.businessOutcomes) (out[o.code] ??= []).push(...withoutProse([o.when]));
  for (const k of Object.keys(out)) out[k]!.sort((x, y) => stableJson(x).localeCompare(stableJson(y)));
  return out;
}

function withoutProse(cs: Check[]): Check[] {
  return cs.map(({ describes: _, ...c }) => c);
}

function stepRef(s: Step): StepRef {
  return { stepId: s.stepId, summary: [s.phase, s.action, stepTarget(s)].filter(Boolean).join(" ") };
}

function compact<T>(xs: (T | null)[]): T[] {
  return xs.filter((x): x is T => x !== null);
}
