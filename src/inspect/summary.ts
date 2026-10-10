import type { Capability, Step } from "../contracts/index.js";
import { referencesOf, renderCheck, renderFingerprint, renderValue, summarizeTarget } from "./render.js";

export interface InputSummary {
  /** Dotted path to a leaf field, e.g. address.line2. */
  name: string;
  type: string;
  optional: boolean;
  sensitive: boolean;
}

export interface OutputSummary {
  name: string;
  pattern?: string;
  required: boolean;
  fromStep: string;
  extract: string;
}

export interface StepSummary {
  stepId: string;
  index: number;
  phase: Step["phase"];
  action: Step["action"];
  effect: Step["effect"];
  /** The descriptor in one line; for an approval gate, the fields it shows. */
  target?: string;
  precondition: string[];
  /** Input and secret references the step draws on, never their values. */
  values: string[];
  checks: number;
  fingerprint: string;
  authoredBy: Step["authoredBy"];
  unresolved: boolean;
}

/** A structured view of one capability, for the terminal now and a dashboard later. */
export interface InspectSummary {
  capabilityId: string;
  version: number;
  status: Capability["status"];
  createdAt: string;
  origin: string;
  session?: { credentialRef: string; loginUrl: string };
  provenance: {
    runId: string;
    model: string;
    authoredBy: { agent: number; human: number };
    outcomeRunIds: string[];
  };
  inputs: InputSummary[];
  outputs: OutputSummary[];
  steps: StepSummary[];
  /** Consequential steps: the ones that change durable state. */
  writeSteps: string[];
  approvalGates: string[];
  businessOutcomes: { code: string; when: string }[];
}

export function inspect(cap: Capability): InspectSummary {
  return {
    capabilityId: cap.capabilityId,
    version: cap.version,
    status: cap.status,
    createdAt: cap.createdAt,
    origin: cap.origin,
    ...(cap.requires.session ? { session: cap.requires.session } : {}),
    provenance: {
      runId: cap.provenance.runId,
      model: cap.provenance.model,
      authoredBy: cap.provenance.authoredBy,
      outcomeRunIds: cap.provenance.outcomeRunIds ?? [],
    },
    inputs: flattenInputs(cap.inputs),
    outputs: Object.entries(cap.outputs).map(([name, o]) => ({
      name,
      ...(o.pattern !== undefined ? { pattern: o.pattern } : {}),
      required: o.required,
      fromStep: o.source.stepId,
      extract: renderExtract(o.source.extract),
    })),
    steps: cap.steps.map(summarizeStep),
    writeSteps: cap.steps.filter((s) => s.effect === "consequential").map((s) => s.stepId),
    approvalGates: cap.steps.filter((s) => s.action === "approval_gate").map((s) => s.stepId),
    businessOutcomes: cap.businessOutcomes.map((o) => ({ code: o.code, when: renderCheck(o.when) })),
  };
}

function summarizeStep(s: Step): StepSummary {
  const refs = referencesOf(s.value);
  if (s.target?.scope?.anchorInput) refs.add(`<input:${s.target.scope.anchorInput}>`);
  for (const c of [...s.precondition, ...s.checks]) referencesOf(c.value, refs);
  for (const f of s.diffFields ?? []) referencesOf(f.value, refs);

  let target = s.target ? summarizeTarget(s.target) : undefined;
  if (s.action === "approval_gate") target = `shows: ${(s.diffFields ?? []).map((f) => f.label).join("; ")}`;
  else if (s.action === "navigate" && s.value) target = renderValue(s.value);

  return {
    stepId: s.stepId,
    index: s.index,
    phase: s.phase,
    action: s.action,
    effect: s.effect,
    ...(target !== undefined ? { target } : {}),
    precondition: s.precondition.map(renderCheck),
    values: [...refs],
    checks: s.checks.length,
    fingerprint: renderFingerprint(s.surfaceFingerprint),
    authoredBy: s.authoredBy,
    unresolved: s.unresolved,
  };
}

export type FieldSpecShape = {
  type: string;
  description?: string;
  optional?: boolean;
  sensitive?: boolean;
  pattern?: string;
  properties?: Record<string, FieldSpecShape>;
};

/** Leaf fields only: an object input is a namespace, its leaves are what a caller supplies. */
export function leafFields(fields: Record<string, unknown>, prefix = ""): [string, FieldSpecShape][] {
  return Object.entries(fields as Record<string, FieldSpecShape>).flatMap(([key, f]) =>
    f.properties ? leafFields(f.properties, `${prefix}${key}.`) : [[`${prefix}${key}`, f] as [string, FieldSpecShape]],
  );
}

function flattenInputs(fields: Record<string, unknown>): InputSummary[] {
  return leafFields(fields).map(([name, f]) => ({
    name,
    type: f.type,
    optional: f.optional ?? false,
    sensitive: f.sensitive ?? false,
  }));
}

export function renderExtract(e: { kind: string; attr?: string; regex?: string }): string {
  return [e.kind, e.attr ? `@${e.attr}` : "", e.regex !== undefined ? `/${e.regex}/` : ""].filter(Boolean).join(" ");
}
