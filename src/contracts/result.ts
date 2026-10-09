import { z } from "zod";
import { ActorSchema, Check, SCHEMA_VERSION } from "./common.js";

/**
 * Reason codes are typed so tests can assert on them. Business codes (the app
 * correctly said no) are carried in `businessOutcome.code`, not here.
 */
export const ReasonCode = z.enum([
  "OK",
  "BUSINESS_OUTCOME",
  "TARGET_UNRESOLVED",
  "TARGET_AMBIGUOUS",
  "CHECK_FAILED",
  "PRECONDITION_FAILED",
  "TIMEOUT",
  "LOAD_FAILED",
  "SESSION_EXPIRED_UNRECOVERED",
  "PERMISSION_DENIED",
  "UNEXPECTED_DIALOG",
  "OUTPUT_VALIDATION_FAILED",
  "ORIGIN_NOT_ALLOWLISTED",
  "ROUTE_NOT_ALLOWLISTED",
  "ACTION_NOT_ALLOWLISTED",
  "APPROVAL_DECLINED",
  /** A consequential step was reached with no approval recorded in the run. */
  "APPROVAL_MISSING",
  "AWAITING_HUMAN",
  "OPERATOR_ABORTED",
  "STEP_BUDGET_EXHAUSTED",
  "OBSERVATION_BUDGET_EXHAUSTED",
  "MODEL_CALL_BUDGET_EXHAUSTED",
  "WALL_CLOCK_EXHAUSTED",
  "DEAD_END",
  "SCHEMA_INVALID",
  /** A model-bound payload failed redaction and was never sent. */
  "PAYLOAD_BLOCKED",
  /** An unexpected error inside TracePilot; the run still ends with a result. */
  "INTERNAL_ERROR",
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const Budgets = z
  .object({
    actionSteps: z.number().int().min(0),
    observations: z.number().int().min(0),
    modelCalls: z.number().int().min(0),
    /** Time the automation was actually working. */
    activeMs: z.number().int().min(0),
    /** Time spent waiting on a person. Kept separate so it never eats a timeout. */
    humanWaitMs: z.number().int().min(0),
  })
  .strict();
export type Budgets = z.infer<typeof Budgets>;

/**
 * Shared by discovery and replay so result semantics are consistent.
 * `lifecycle` and `outcome` are independent: escalation ends the executor
 * invocation with lifecycle "awaiting_human" and outcome null, which does not
 * mark the run permanently finished.
 */
export const ExecutionResult = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runId: z.string(),
    kind: z.enum(["discovery", "replay"]),
    capabilityId: z.string().optional(),
    capabilityVersion: z.number().int().optional(),
    taskId: z.string().optional(),
    lifecycle: z.enum(["completed", "awaiting_human"]),
    outcome: z
      .enum(["success", "business_outcome", "failure", "safety_violation", "aborted"])
      .nullable(),
    reasonCode: ReasonCode,
    outputs: z.record(z.string()).optional(),
    businessOutcome: z
      .object({ code: z.string(), matchedCheck: Check })
      .strict()
      .optional(),
    failure: z
      .object({
        stepId: z.string(),
        stepIndex: z.number().int(),
        expected: z.string(),
        observed: z.string(),
        evidence: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),
    safety: z.object({ rule: z.string(), attempted: z.string() }).strict().optional(),
    intervention: z.object({ interventionId: z.string(), checkpoint: z.string() }).strict().optional(),
    recoveries: z
      .array(
        z
          .object({
            stepId: z.string(),
            kind: z.enum([
              "candidate_fallthrough",
              "transient_retry",
              "reload",
              "session_relogin",
              "expected_dialog",
            ]),
            attempts: z.number().int().min(1),
            succeeded: z.boolean(),
          })
          .strict(),
      )
      .default([]),
    /**
     * Replay-time drift: the app moved under a working artifact. `score` is the
     * share of steps that drifted either way -- resolved below rank 1, or
     * resolved to an element whose fingerprint differs from discovery's --
     * counting a step once if it did both: |union of the two lists| / steps.
     */
    drift: z
      .object({
        stepsResolvedBelowRank1: z.array(z.string()),
        fingerprintMismatches: z.array(z.string()).default([]),
        score: z.number().min(0).max(1),
      })
      .strict(),
    budgets: Budgets,
    control: z
      .array(
        z
          .object({ from: ActorSchema, to: ActorSchema, at: z.string(), reason: z.string().max(200) })
          .strict(),
      )
      .default([]),
    approvals: z
      .array(
        z
          .object({
            stepId: z.string(),
            mode: z.enum(["interactive", "pre_approved"]),
            approvedBy: z.string(),
            at: z.string(),
            diffDigest: z.string(),
          })
          .strict(),
      )
      .default([]),
    startedAt: z.string(),
    endedAt: z.string(),
    evidenceDir: z.string(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.lifecycle === "awaiting_human" && r.outcome !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "awaiting_human must not carry a terminal outcome",
      });
    }
    if (r.lifecycle === "completed" && r.outcome === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "completed requires an outcome" });
    }
    if (r.outcome === "success" && !r.outputs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "success must return declared outputs" });
    }
    if (r.outcome === "failure" && !r.failure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failure must identify step, expected and observed state",
      });
    }
    if (r.outcome === "business_outcome" && !r.businessOutcome) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "business_outcome requires a code" });
    }
    if (r.outcome === "safety_violation" && !r.safety) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "safety_violation requires a rule" });
    }
    if (r.lifecycle === "awaiting_human" && !r.intervention) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "awaiting_human requires an intervention" });
    }
  });
export type ExecutionResult = z.infer<typeof ExecutionResult>;
