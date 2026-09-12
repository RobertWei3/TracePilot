import { z } from "zod";
import { Check, Descriptor, SCHEMA_VERSION, ValueRef } from "./common.js";

/**
 * The discovery run's structured record of what it actually did, and the only
 * thing a compiler reads.
 *
 * It is deliberately a separate document from `events.jsonl`. The event log is
 * an audit trail, field-allowlisted and redacted for a human reader; it drops
 * descriptors entirely, so a capability could not be reconstructed from it
 * without widening the allowlist and flattening exactly the structure the
 * compiler needs. Keeping the two apart is what lets the audit log stay narrow
 * while compilation stays deterministic and lossless.
 *
 * Nothing here holds a resolved value. Fills carry a `ValueRef`, descriptors
 * carry text already tagged as `<input:name>` inside the page, and checks carry
 * references -- so the trace is safe to persist and safe to review.
 */
export const TraceStep = z
  .object({
    seq: z.number().int().min(1),
    /** Grammar action, as accepted. The compiler maps these onto StepAction. */
    action: z.enum([
      "navigate",
      "click",
      "fill",
      "press",
      "assert",
      "extract",
      "approval_gate",
    ]),
    /** Short, redacted statement of why the step was taken. */
    reason: z.string().max(200),
    url: z.string(),
    target: Descriptor.optional(),
    value: ValueRef.optional(),
    /** Classified mechanically from the target's form, never by the model. */
    effect: z.enum(["reversible", "consequential"]),
    /** Assertions authored at this point in the run, already verified to hold. */
    checks: z.array(Check).default([]),
    /** Which declared output an extract bound. */
    extractAs: z.string().optional(),
    /** The declared pattern the extracted text was matched against, if any. */
    extractRegex: z.string().optional(),
    /** Approval gates: what the operator was shown, and the digest they cleared. */
    diffFields: z
      .array(z.object({ label: z.string(), value: ValueRef }).strict())
      .optional(),
    diffDigest: z.string().optional(),
    /** Which rung of the locator ladder actually resolved the target. */
    resolvedRank: z.number().int().optional(),
    resolvedStrategy: z.string().optional(),
    surfaceFingerprint: z.string().optional(),
    /** "human" for steps recorded during a manual takeover. */
    authoredBy: z.enum(["agent", "human"]).default("agent"),
    /** True when a human-recorded descriptor could not be re-resolved. */
    unresolved: z.boolean().default(false),
    at: z.string(),
  })
  .strict();
export type TraceStep = z.infer<typeof TraceStep>;

export const DiscoveryTrace = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runId: z.string(),
    taskId: z.string(),
    origin: z.string().url(),
    model: z.string(),
    startedAt: z.string(),
    endedAt: z.string(),
    /** Mirrors the run's terminal outcome, so a trace is self-describing. */
    outcome: z.string(),
    steps: z.array(TraceStep).default([]),
    /** Recognizers the model declared and the loop verified against the page. */
    businessOutcomes: z
      .array(z.object({ code: z.string().regex(/^[A-Z_]+$/), when: Check }).strict())
      .default([]),
    outputs: z.record(z.string()).default({}),
    /** Counts the compiler needs to decide a capability's review status. */
    authoredBy: z.object({ agent: z.number().int(), human: z.number().int() }).strict(),
    appFingerprint: z.string(),
  })
  .strict();
export type DiscoveryTrace = z.infer<typeof DiscoveryTrace>;
