import type { Capability, Step } from "../contracts/index.js";
import { leafFields, referencesOf, renderCheck, renderExtract, renderFingerprint, stepTarget } from "./render.js";

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
  /** The descriptor in one line; the URL for a navigate; the fields a gate shows. */
  target: string;
  precondition: string[];
  /** Input and secret references the step draws on, never their values. */
  values: string[];
  checks: number;
  fingerprint: string;
  authoredBy: Step["authoredBy"];
  unresolved: boolean;
}

/** A structured view of one capability: printed by `tp inspect`, or emitted whole by `--json`. */
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
    inputs: leafFields(cap.inputs).map(([name, f]) => ({
      name,
      type: f.type,
      optional: f.optional,
      sensitive: f.sensitive,
    })),
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
  return {
    stepId: s.stepId,
    index: s.index,
    phase: s.phase,
    action: s.action,
    effect: s.effect,
    target: stepTarget(s),
    precondition: s.precondition.map(renderCheck),
    values: referencesOf(s),
    checks: s.checks.length,
    fingerprint: renderFingerprint(s.surfaceFingerprint),
    authoredBy: s.authoredBy,
    unresolved: s.unresolved,
  };
}
