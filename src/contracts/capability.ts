import { z } from "zod";
import { Check, Descriptor, FieldSpec, SCHEMA_VERSION, ValueRef } from "./common.js";

export const StepAction = z.enum([
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "waitFor",
  "assert",
  "extract",
  "approval_gate",
  "read_back",
]);
export type StepAction = z.infer<typeof StepAction>;

export const WaitSpec = z
  .object({
    kind: z.enum(["url", "element", "settled"]),
    pattern: z.string().optional(),
    target: Descriptor.optional(),
    timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  })
  .strict();

export const Step = z
  .object({
    stepId: z.string().regex(/^s\d{2,}$/),
    index: z.number().int().min(0),
    phase: z.enum(["navigate", "search", "details", "edit", "review", "submit", "verify"]),
    action: StepAction,
    /**
     * Reversible actions can be retried freely. Consequential actions mutate
     * durable state and must be preceded by an approval gate.
     */
    effect: z.enum(["reversible", "consequential"]),
    target: Descriptor.optional(),
    value: ValueRef.optional(),
    /** Mechanical: URL shape plus target resolvability. Re-verified on handback. */
    precondition: z.array(Check).default([]),
    /** Model-authored semantic assertions from the closed vocabulary. */
    checks: z.array(Check).default([]),
    waitFor: WaitSpec.optional(),
    /** Which output name this step binds, for action === "extract". */
    extractAs: z.string().optional(),
    /** Fields to render in the pending-change diff, for action === "approval_gate". */
    diffFields: z
      .array(
        z
          .object({
            label: z.string(),
            /** The value about to be written, as a reference. */
            value: ValueRef,
            /** Where the current value can be read, so the diff shows both sides. */
            currentFrom: Descriptor.optional(),
          })
          .strict(),
      )
      .optional(),
    authoredBy: z.enum(["agent", "human"]).default("agent"),
    /** True when a recorded human step's descriptor could not be re-resolved. */
    unresolved: z.boolean().default(false),
    /** Stable hash of the target's descriptor neighbourhood, for drift detection. */
    surfaceFingerprint: z.string().optional(),
    /** Short, redacted decision reason carried over from the run record. */
    reason: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const needsTarget: StepAction[] = ["click", "fill", "select", "press", "extract"];
    if (needsTarget.includes(s.action) && !s.target) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${s.action} requires a target` });
    }
    if (s.action === "fill" && !s.value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fill requires a value reference" });
    }
    if (s.action === "extract" && !s.extractAs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "extract requires extractAs" });
    }
    if (s.action === "approval_gate" && (!s.diffFields || s.diffFields.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "approval_gate must declare diffFields so the operator sees what changes",
      });
    }
  });
export type Step = z.infer<typeof Step>;

export const OutputSpec = z
  .object({
    type: z.enum(["string"]),
    pattern: z.string().optional(),
    required: z.boolean().default(true),
    source: z
      .object({
        stepId: z.string(),
        extract: z
          .object({ kind: z.enum(["text", "attr"]), attr: z.string().optional(), regex: z.string().optional() })
          .strict(),
      })
      .strict(),
  })
  .strict();

/**
 * The capability artifact: a typed, versioned, reviewable description of a
 * workflow, compiled deterministically from a successful run.
 */
export const Capability = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    capabilityId: z.string().min(3),
    version: z.number().int().min(1),
    createdAt: z.string(),
    /** needs_review when any step is human-authored or unresolved. */
    status: z.enum(["ready", "needs_review"]),
    /** Reserved for extension beyond one browser target. Validated, unused in V1. */
    surfaceKind: z.literal("web"),
    tenantId: z.string().nullable().default(null),
    overrides: z.record(z.unknown()).nullable().default(null),
    origin: z.string().url(),
    requires: z
      .object({
        session: z
          .object({ credentialRef: z.string(), loginUrl: z.string() })
          .strict()
          .optional(),
      })
      .strict(),
    inputs: z.record(FieldSpec),
    outputs: z.record(OutputSpec),
    steps: z.array(Step).min(1),
    /** Deterministic recognizers: the app worked correctly and said no. */
    businessOutcomes: z
      .array(z.object({ code: z.string().regex(/^[A-Z_]+$/), when: Check }).strict())
      .default([]),
    /** Only dialogs declared here are handled; anything else escalates. */
    expectedDialogs: z
      .array(z.object({ textContains: z.string(), accept: z.boolean() }).strict())
      .default([]),
    provenance: z
      .object({
        runId: z.string(),
        model: z.string(),
        authoredBy: z.object({ agent: z.number().int(), human: z.number().int() }).strict(),
        appFingerprint: z.string(),
      })
      .strict(),
  })
  .strict()
  .superRefine((cap, ctx) => {
    // An artifact that submits without a gate is the worst possible bug here,
    // so it is a hard validation failure rather than a warning.
    const gateIndexes = cap.steps.filter((s) => s.action === "approval_gate").map((s) => s.index);
    for (const step of cap.steps) {
      if (step.effect !== "consequential") continue;
      if (!gateIndexes.some((g) => g < step.index)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `consequential step ${step.stepId} has no preceding approval_gate`,
        });
      }
    }
    // Every declared required output must be bound by an extract step.
    for (const [name, spec] of Object.entries(cap.outputs)) {
      if (!spec.required) continue;
      const bound = cap.steps.some((s) => s.action === "extract" && s.extractAs === name);
      if (!bound) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `required output "${name}" is not bound by any extract step`,
        });
      }
    }
    // Minimum verification: a check after the consequential step, and a check
    // that binds the declared output. Without these a "successful" capability
    // could verify nothing at all.
    const lastConsequential = Math.max(
      -1,
      ...cap.steps.filter((s) => s.effect === "consequential").map((s) => s.index),
    );
    if (lastConsequential >= 0) {
      const verified = cap.steps.some((s) => s.index > lastConsequential && s.checks.length > 0);
      if (!verified) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "no post-submit check: the capability would report unearned success",
        });
      }
    }
    if (cap.steps.some((s) => s.authoredBy === "human" || s.unresolved) && cap.status !== "needs_review") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "capabilities containing human-authored or unresolved steps must be needs_review",
      });
    }
  });
export type Capability = z.infer<typeof Capability>;
