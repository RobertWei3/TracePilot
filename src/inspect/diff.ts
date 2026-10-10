import type { Capability, Check, Step } from "../contracts/index.js";
import {
  detailTarget,
  renderCheck,
  renderFingerprint,
  renderLocators,
  renderValue,
  stableJson,
  summarizeTarget,
} from "./render.js";
import { leafFields, renderExtract } from "./summary.js";

export class DiffError extends Error {
  override name = "DiffError";
}

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
   * Where each capability came from: version, creation time, source run.
   * Shown, but never counted as a difference -- any two versions differ here,
   * so counting it would make diff report a change between identical workflows.
   */
  provenance: FieldChange[];
  /** Capability-level fields that change what replay does: status, origin, session, dialogs. */
  meta: FieldChange[];
  steps: { countA: number; countB: number; added: StepRef[]; removed: StepRef[]; changed: StepChange[] };
  inputs: KeyedChanges;
  outputs: KeyedChanges;
  businessOutcomes: KeyedChanges;
  /** True when nothing outside `provenance` differs. */
  identical: boolean;
}

/**
 * Compare two versions of one capability.
 *
 * Prose is not compared: a step's `reason`, a check's `describes` and an
 * input's `description` are written by the model and reworded on every
 * discovery, without changing what replay does.
 */
export function diff(a: Capability, b: Capability): CapabilityDiff {
  if (a.capabilityId !== b.capabilityId) {
    throw new DiffError(`different capabilities: ${a.capabilityId} and ${b.capabilityId}`);
  }

  const provenance = compact([
    change("version", a.version, b.version, String),
    change("createdAt", a.createdAt, b.createdAt, String),
    change("provenance.runId", a.provenance.runId, b.provenance.runId, String),
    change("provenance.model", a.provenance.model, b.provenance.model, String),
    change("provenance.authoredBy", a.provenance.authoredBy, b.provenance.authoredBy, (x) => `${x.agent} agent, ${x.human} human`),
    change("provenance.appFingerprint", a.provenance.appFingerprint, b.provenance.appFingerprint, String),
    change("provenance.outcomeRunIds", a.provenance.outcomeRunIds ?? [], b.provenance.outcomeRunIds ?? [], (x) => x.join(", ") || "(none)"),
  ]);
  const meta = compact([
    change("status", a.status, b.status, String),
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
      const changes = compareSteps(a.steps[i]!, b.steps[j]!);
      return changes.length
        ? [{ a: a.steps[i]!.stepId, b: b.steps[j]!.stepId, summary: stepRef(b.steps[j]!).summary, changes }]
        : [];
    }),
  };

  // Outputs name the step that binds them by id, and ids are positional, so
  // the source is compared through the alignment rather than by its literal id.
  const bIdOf = new Map(pairs.map(([i, j]) => [a.steps[i]!.stepId, b.steps[j]!.stepId]));
  const outputs = keyed(a.outputs, b.outputs, (x, y) =>
    compact([
      change("type", x.type, y.type, String),
      change("pattern", x.pattern, y.pattern, (p) => p ?? "(none)"),
      change("required", x.required, y.required, String),
      change("extract", x.source.extract, y.source.extract, renderExtract),
      bIdOf.get(x.source.stepId) === y.source.stepId
        ? null
        : { field: "source", from: x.source.stepId, to: y.source.stepId },
    ]),
  );

  const inputs = keyed(Object.fromEntries(leafFields(a.inputs)), Object.fromEntries(leafFields(b.inputs)), (x, y) =>
    compact(
      (["type", "optional", "sensitive", "pattern"] as const).map((k) =>
        change(k, x[k], y[k], (v) => (v === undefined ? "(none)" : String(v))),
      ),
    ),
  );

  const businessOutcomes = keyed(byCode(a), byCode(b), (x, y) =>
    compact([change("when", x, y, (w) => w.map(renderCheck).join(" | "))]),
  );

  const identical =
    meta.length === 0 &&
    steps.added.length + steps.removed.length + steps.changed.length === 0 &&
    [inputs, outputs, businessOutcomes].every((k) => k.added.length + k.removed.length + k.changed.length === 0);

  return { capabilityId: a.capabilityId, versions: [a.version, b.version], provenance, meta, steps, inputs, outputs, businessOutcomes, identical };
}

/**
 * Pair each step of `a` with its counterpart in `b`, as [indexInA, indexInB].
 *
 * Neither stepId nor position identifies a step across versions. The compiler
 * assigns ids by position (sid() in compiler/compile.ts), so one step inserted
 * by a new discovery renumbers every step after it, and position shifts the
 * same way; hand-written capabilities do not even agree on where numbering
 * starts. So steps are aligned by what they do: a longest common subsequence
 * over (phase, action, role, accessible name), which keeps order and survives
 * insertions and deletions.
 *
 * The accessible name is in that key, so a renamed control would fall out of
 * the subsequence as one removal and one addition -- yet a rename is exactly
 * the drift T4's fingerprint warnings point at. A second pass therefore pairs
 * what is left within each gap between matched steps, in order, when phase,
 * action and role agree, and the rename is reported as a change to the target.
 */
export function align(a: Step[], b: Step[]): [number, number][] {
  const key = (s: Step) => stableJson([s.phase, s.action, s.target?.role ?? null, s.target?.accessibleName ?? null]);
  const ka = a.map(key);
  const kb = b.map(key);

  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = ka[i] === kb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const anchors: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (ka[i] === kb[j]) anchors.push([i++, j++]);
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }

  const shape = (s: Step) => stableJson([s.phase, s.action, s.target?.role ?? null]);
  const pairs: [number, number][] = [];
  let prevA = -1;
  let prevB = -1;
  for (const [ai, bj] of [...anchors, [a.length, b.length] as [number, number]]) {
    let next = prevB + 1;
    for (let i = prevA + 1; i < ai; i++) {
      for (let j = next; j < bj; j++) {
        if (shape(a[i]!) === shape(b[j]!)) {
          pairs.push([i, j]);
          next = j + 1;
          break;
        }
      }
    }
    if (ai < a.length) pairs.push([ai, bj]);
    prevA = ai;
    prevB = bj;
  }
  return pairs.sort(([x], [y]) => x - y);
}

function compareSteps(x: Step, y: Step): FieldChange[] {
  const render = (cs: Check[]) => (cs.length ? cs.map(renderCheck).join("; ") : "(none)");
  return compact([
    change("target", x.target, y.target, (t) => (t ? detailTarget(t) : "(none)")),
    change("locators", x.target?.candidates, y.target?.candidates, (c) => (c ? renderLocators(c) : "(none)")),
    change("effect", x.effect, y.effect, String),
    change("value", x.value, y.value, (v) => (v ? renderValue(v) : "(none)")),
    change("precondition", withoutProse(x.precondition), withoutProse(y.precondition), render),
    change("checks", withoutProse(x.checks), withoutProse(y.checks), render),
    change("waitFor", x.waitFor, y.waitFor, (w) =>
      w ? [w.kind, w.pattern ? `"${w.pattern}"` : "", w.target ? summarizeTarget(w.target) : "", `${w.timeoutMs}ms`].filter(Boolean).join(" ") : "(none)",
    ),
    change("extractAs", x.extractAs, y.extractAs, (e) => e ?? "(none)"),
    change("diffFields", x.diffFields, y.diffFields, (fs) =>
      fs ? fs.map((f) => `"${f.label}" = ${renderValue(f.value)}`).join("; ") : "(none)",
    ),
    change("authoredBy", x.authoredBy, y.authoredBy, String),
    change("unresolved", x.unresolved, y.unresolved, String),
    change("surfaceFingerprint", x.surfaceFingerprint, y.surfaceFingerprint, renderFingerprint),
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
function byCode(cap: Capability): Record<string, Check[]> {
  const out: Record<string, Check[]> = {};
  for (const o of cap.businessOutcomes) (out[o.code] ??= []).push(...withoutProse([o.when]));
  for (const k of Object.keys(out)) out[k]!.sort((x, y) => stableJson(x).localeCompare(stableJson(y)));
  return out;
}

function withoutProse(cs: Check[]): Check[] {
  return cs.map(({ describes: _, ...c }) => c);
}

function stepRef(s: Step): StepRef {
  const target = s.action === "approval_gate" ? "" : s.target ? ` ${summarizeTarget(s.target)}` : "";
  return { stepId: s.stepId, summary: `${s.phase} ${s.action}${target}` };
}

function compact<T>(xs: (T | null)[]): T[] {
  return xs.filter((x): x is T => x !== null);
}
