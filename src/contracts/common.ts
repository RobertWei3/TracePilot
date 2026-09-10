import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

/** A value in a step or check: a reference, an approved constant, or a transform. */
export const ValueRef = z.union([
  z.object({ input: z.string().min(1) }).strict(),
  z.object({ secret: z.string().min(1) }).strict(),
  z.object({ const: z.string() }).strict(),
  z
    .object({
      transform: z
        .object({
          // Closed set. Anything else fails validation, by design.
          op: z.enum(["trim", "upper", "lower", "template"]),
          // `template` composes input refs: "{address.city}, {address.state} {address.zip}"
          format: z.string().optional(),
          arg: z.lazy((): z.ZodTypeAny => ValueRef).optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type ValueRef = z.infer<typeof ValueRef>;

/** Closed assertion vocabulary. Used for preconditions, checks and outcome recognizers. */
export const Check = z
  .object({
    kind: z.enum([
      "url_matches",
      "element_exists",
      "element_absent",
      "text_equals",
      "text_contains",
    ]),
    /** Required for every kind except url_matches. */
    target: z.lazy((): z.ZodTypeAny => Descriptor).optional(),
    /** Regex source, for url_matches. */
    pattern: z.string().optional(),
    /** Expected value, for text_equals / text_contains. */
    value: ValueRef.optional(),
    /** Human-readable statement of what this check establishes. */
    describes: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const needsTarget = c.kind !== "url_matches";
    if (needsTarget && !c.target) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${c.kind} requires a target` });
    }
    if (c.kind === "url_matches" && !c.pattern) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "url_matches requires a pattern" });
    }
    if ((c.kind === "text_equals" || c.kind === "text_contains") && !c.value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${c.kind} requires a value` });
    }
  });
export type Check = z.infer<typeof Check>;

/** One concrete way to find a control, ranked. Rank 1 is the most semantic. */
export const LocatorCandidate = z
  .object({
    rank: z.number().int().min(1).max(9),
    strategy: z.enum(["role+name", "label", "placeholder", "text-scoped", "structural"]),
    expr: z.string().min(1),
  })
  .strict();
export type LocatorCandidate = z.infer<typeof LocatorCandidate>;

/**
 * How a control is described in an artifact: semantically, the way a person
 * identifies it -- never as a single frozen selector. `candidates` is the
 * ordered ladder replay walks, so degradation is graceful and observable.
 */
export const Descriptor = z
  .object({
    role: z.string().min(1),
    accessibleName: z.string().optional(),
    labelText: z.string().optional(),
    nearbyText: z.string().max(120).optional(),
    tagName: z.string().min(1),
    scope: z
      .object({ containerRole: z.string().optional(), containerName: z.string().optional() })
      .strict()
      .optional(),
    /** Disambiguator when the descriptor legitimately matches several controls. */
    nth: z.number().int().min(0).optional(),
    candidates: z.array(LocatorCandidate).min(1),
  })
  .strict();
export type Descriptor = z.infer<typeof Descriptor>;

/** Typed declaration of one input or output field. */
export const FieldSpec: z.ZodTypeAny = z.lazy(() =>
  z
    .object({
      type: z.enum(["string", "object"]),
      description: z.string().max(300).optional(),
      sensitive: z.boolean().default(false),
      optional: z.boolean().default(false),
      pattern: z.string().optional(),
      properties: z.record(FieldSpec).optional(),
    })
    .strict(),
);

export const ActorSchema = z.enum(["AGENT", "HUMAN", "NONE"]);
export type Actor = z.infer<typeof ActorSchema>;
