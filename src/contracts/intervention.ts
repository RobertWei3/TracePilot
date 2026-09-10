import { z } from "zod";
import { ReasonCode } from "./result.js";
import { SCHEMA_VERSION } from "./common.js";

export const OperatorResponse = z.enum(["resume", "step_done", "retry", "complete", "abort"]);
export type OperatorResponse = z.infer<typeof OperatorResponse>;

/**
 * What the operator is shown when automation pauses. Deliberately carries the
 * subject, the step, the current state and the reason -- enough to act without
 * reading logs.
 */
export const InterventionRequest = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    interventionId: z.string(),
    runId: z.string(),
    kind: z.enum(["discovery_blocked", "replay_unrecoverable", "approval_required"]),
    subject: z
      .object({
        capabilityId: z.string().optional(),
        taskId: z.string().optional(),
        version: z.number().int().optional(),
        goalSummary: z.string().max(300),
      })
      .strict(),
    step: z
      .object({
        stepId: z.string(),
        index: z.number().int(),
        action: z.string(),
        targetSummary: z.string().max(200),
      })
      .strict(),
    currentState: z
      .object({
        url: z.string(),
        title: z.string(),
        visibleSummary: z.string().max(1200),
        /** null when a safe masked capture could not be established. */
        screenshotRef: z.string().nullable(),
        omittedReason: z.string().optional(),
      })
      .strict(),
    expected: z.string(),
    observed: z.string(),
    reason: z.string().max(400),
    reasonCode: ReasonCode,
    /** Approval requests only: exactly what is about to change. */
    pendingChange: z
      .object({
        fields: z.array(z.object({ label: z.string(), from: z.string(), to: z.string() }).strict()),
        digest: z.string(),
      })
      .strict()
      .optional(),
    budgetsRemaining: z
      .object({
        actionSteps: z.number().int(),
        observations: z.number().int(),
        modelCalls: z.number().int(),
        wallClockMs: z.number().int(),
      })
      .strict(),
    allowedResponses: z.array(OperatorResponse).min(1),
    createdAt: z.string(),
  })
  .strict()
  .superRefine((iv, ctx) => {
    if (iv.kind === "approval_required" && !iv.pendingChange) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an approval request must show the pending change, not just ask to proceed",
      });
    }
  });
export type InterventionRequest = z.infer<typeof InterventionRequest>;
