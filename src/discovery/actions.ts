import { z } from "zod";
import type { Observation } from "../browser/index.js";

/**
 * The agent's action grammar.
 *
 * Two deliberate properties:
 *
 *  - Values are never literals. A fill names a declared input, and the executor
 *    resolves it in memory, so an input value cannot appear in a model prompt
 *    or a model response at all.
 *  - Targets are element ids from the *current* observation. Ids are scoped to
 *    their observation, so a reference carried over from an earlier turn is
 *    rejected rather than silently addressing a different control.
 *
 * The JSON Schema below is flat, with one `action` enum and every other field
 * nullable, because strict tool use supports only a narrow schema subset and a
 * rejected schema would be a silent loss of the guarantee. Cross-field rules
 * live in the zod refinement instead.
 */
export const ACTION_NAMES = [
  "observe",
  "navigate",
  "click",
  "fill",
  "press",
  "assert",
  "extract",
  "request_approval",
  "business_outcome",
  "done",
  "give_up",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

const nullableString = { type: ["string", "null"] } as const;

/**
 * The grammar this run may use: what the model can express, intersected with
 * what policy permits.
 *
 * Both directions matter. `policy.allowedActions` is the whole vocabulary of
 * the system, including step kinds only replay emits (`waitFor`, `select`,
 * `approval_gate`, `read_back`), so handing it to the tool schema unfiltered
 * would offer the model actions its own parser rejects -- every one of which
 * costs a turn. Deriving it in one place is what keeps the tool enum, the
 * system prompt and the pre-execution check describing the same set.
 */
export function allowedActions(policy: { allowedActions: string[] }): ActionName[] {
  return ACTION_NAMES.filter((a) => policy.allowedActions.includes(a));
}

/**
 * The tool the model is given.
 *
 * The action enum is narrowed to what policy allows rather than being fixed,
 * so an action the operator has withheld is unrepresentable instead of merely
 * refused. The loop re-checks before executing anyway -- the same defence in
 * depth the surface uses -- but a grammar that cannot express a forbidden
 * action never spends a turn proposing one.
 */
export function actTool(allowed: readonly ActionName[]) {
  return {
  name: "act",
  description:
    "Perform exactly one step towards the goal, or report that the goal is reached or unreachable.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...allowed] },
      reason: {
        type: "string",
        description: "One short sentence on why this step, at most 200 characters.",
      },
      targetId: {
        ...nullableString,
        description: "Element id from the CURRENT observation, e.g. obs3:el-12. Ids from earlier observations are invalid.",
      },
      url: { ...nullableString, description: "Path to navigate to, e.g. /members. navigate only." },
      inputName: {
        ...nullableString,
        description:
          "Name of a declared input whose value should be typed, e.g. address.city. You never see the value; it is resolved for you. fill only.",
      },
      anchorInput: {
        ...nullableString,
        description:
          "Name of a declared input whose value must appear in the same row or block as the target. Use this to pick one row out of a list of identical controls.",
      },
      regionId: { ...nullableString, description: "Region to inspect. observe only." },
      nextBatch: {
        type: ["boolean", "null"],
        description: "Request the next batch of elements when an observation was truncated. observe only.",
      },
      assertKind: {
        type: ["string", "null"],
        enum: ["url_matches", "element_exists", "element_absent", "text_equals", "text_contains", null],
        description: "Kind of check to record. assert only.",
      },
      assertPattern: { ...nullableString, description: "Regex for url_matches. May contain {input_name}." },
      assertInput: { ...nullableString, description: "Declared input whose value the text should match." },
      assertTemplate: {
        ...nullableString,
        description: "Composed expected value, e.g. '{address.city}, {address.state} {address.zip}'.",
      },
      assertConst: {
        ...nullableString,
        description: "Literal text the application itself displays, e.g. 'Mailing address updated.'",
      },
      outputName: { ...nullableString, description: "Declared output this extraction binds. extract only." },
      outcomeCode: {
        ...nullableString,
        description:
          "Stable upper-case code naming what the application decided, e.g. MEMBER_NOT_FOUND. business_outcome only.",
      },
    },
    required: [
      "action",
      "reason",
      "targetId",
      "url",
      "inputName",
      "anchorInput",
      "regionId",
      "nextBatch",
      "assertKind",
      "assertPattern",
      "assertInput",
      "assertTemplate",
      "assertConst",
      "outputName",
      "outcomeCode",
    ],
    additionalProperties: false,
  },
  } as const;
}

export const RawAction = z
  .object({
    action: z.enum(ACTION_NAMES),
    reason: z.string().min(1).max(400),
    targetId: z.string().nullable().default(null),
    url: z.string().nullable().default(null),
    inputName: z.string().nullable().default(null),
    anchorInput: z.string().nullable().default(null),
    regionId: z.string().nullable().default(null),
    nextBatch: z.boolean().nullable().default(null),
    assertKind: z
      .enum(["url_matches", "element_exists", "element_absent", "text_equals", "text_contains"])
      .nullable()
      .default(null),
    assertPattern: z.string().nullable().default(null),
    assertInput: z.string().nullable().default(null),
    assertTemplate: z.string().nullable().default(null),
    assertConst: z.string().nullable().default(null),
    outputName: z.string().nullable().default(null),
    outcomeCode: z.string().nullable().default(null),
  })
  .strip();
export type RawAction = z.infer<typeof RawAction>;

export type Rejection = { reason: string };

/**
 * `{name}` placeholders in a pattern or template that name no declared input.
 * Both are expanded against the run's parameters at replay time, where an
 * unknown name is a broken reference -- caught here it costs one retry, caught
 * there it fails a run that has already written.
 */
function unknownPlaceholders(text: string, inputNames: string[]): string[] {
  const names = Array.from(text.matchAll(/\{([^}]+)\}/g), (m) => m[1]!);
  return Array.from(new Set(names.filter((n) => !inputNames.includes(n))));
}

/**
 * An element id is only meaningful inside the observation that minted it. One
 * carried over from an earlier turn is refused by name rather than silently
 * addressing whatever now occupies that slot.
 */
function checkTargetId(targetId: string, observation: Observation | null): Rejection | null {
  if (!observation) return { reason: "no current observation; observe first" };
  if (!targetId.startsWith(`${observation.obsId}:`)) {
    return {
      reason: `targetId "${targetId}" belongs to an earlier observation. The current observation is ${observation.obsId}; observe again and use an id from it.`,
    };
  }
  if (!observation.elements.some((e) => e.id === targetId)) {
    const hint = observation.truncated
      ? ` The observation was truncated (${observation.returned} of ${observation.totalEligible}); use observe with nextBatch or a regionId to see the rest.`
      : "";
    return { reason: `no element "${targetId}" in the current observation.${hint}` };
  }
  return null;
}

/**
 * The shape rules for an assertion. `assert` and `business_outcome` both carry
 * one -- a recognizer is an assertion that happens to name an outcome -- so the
 * rules live here rather than being restated, where the two could drift and a
 * recognizer could end up held to a weaker standard than a check.
 */
function validateRecognizer(
  raw: RawAction,
  ctx: { observation: Observation | null; inputNames: string[]; outputNames: string[] },
  what: string,
): Rejection | null {
  const { observation } = ctx;
  if (!raw.assertKind) return { reason: `${what} requires assertKind` };
  if (raw.assertKind === "url_matches" && !raw.assertPattern) {
    return { reason: "url_matches requires assertPattern" };
  }
  if (raw.assertKind === "element_exists" || raw.assertKind === "element_absent") {
    if (!raw.targetId) return { reason: `${raw.assertKind} requires targetId` };
    const bad = checkTargetId(raw.targetId, observation);
    if (bad) return bad;
  }
  if (raw.assertKind === "url_matches") {
    const bad = unknownPlaceholders(raw.assertPattern!, ctx.inputNames);
    if (bad.length) {
      return {
        reason: `assertPattern references unknown input${bad.length > 1 ? "s" : ""} ${bad
          .map((b) => `"${b}"`)
          .join(", ")}. Declared inputs: ${ctx.inputNames.join(", ")}`,
      };
    }
    // A pattern that does not compile would fail at replay, one step at a
    // time, long after the run that authored it.
    try {
      new RegExp(raw.assertPattern!);
    } catch (e) {
      return {
        reason: `assertPattern is not a valid regular expression: ${
          e instanceof Error ? e.message : "unknown"
        }`,
      };
    }
  }
  if (raw.assertKind === "text_equals" || raw.assertKind === "text_contains") {
    const refs = [raw.assertInput, raw.assertTemplate, raw.assertConst].filter(Boolean);
    if (refs.length !== 1) {
      return {
        reason: `${raw.assertKind} needs exactly one of assertInput, assertTemplate or assertConst`,
      };
    }
    if (raw.assertInput && !ctx.inputNames.includes(raw.assertInput)) {
      return { reason: `unknown input "${raw.assertInput}"` };
    }
    if (raw.assertTemplate) {
      const bad = unknownPlaceholders(raw.assertTemplate, ctx.inputNames);
      if (bad.length) {
        return {
          reason: `assertTemplate references unknown input${bad.length > 1 ? "s" : ""} ${bad
            .map((b) => `"${b}"`)
            .join(", ")}. Declared inputs: ${ctx.inputNames.join(", ")}`,
        };
      }
      if (!/\{[^}]+\}/.test(raw.assertTemplate)) {
        return {
          reason:
            "assertTemplate must compose at least one input, e.g. '{address.city}, {address.state}'. Use assertConst for text the application itself displays.",
        };
      }
    }
  }

  return null;
}

/**
 * Validate an action against the run's declared contract and the observation it
 * was decided from. A rejection is returned rather than thrown: the loop feeds
 * it back to the model and charges the retry to the model-call budget.
 */
export function validateAction(
  raw: RawAction,
  ctx: {
    observation: Observation | null;
    inputNames: string[];
    outputNames: string[];
  },
): Rejection | null {
  const needsTarget: ActionName[] = ["click", "fill", "press", "extract"];
  const { observation } = ctx;

  // Any target id at all is checked, not only the ones an action requires. A
  // text assertion scoped to a stale id would otherwise be evaluated against
  // whatever control now sits at that position -- which is the precise failure
  // observation-scoped ids exist to make impossible.
  if (raw.targetId) {
    const bad = checkTargetId(raw.targetId, observation);
    if (bad) return bad;
  }
  if (needsTarget.includes(raw.action) && !raw.targetId) {
    return { reason: `${raw.action} requires targetId` };
  }

  if (raw.action === "fill") {
    if (!raw.inputName) return { reason: "fill requires inputName; literal values are not accepted" };
    if (!ctx.inputNames.includes(raw.inputName)) {
      return { reason: `unknown input "${raw.inputName}". Declared inputs: ${ctx.inputNames.join(", ")}` };
    }
  }

  if (raw.action === "navigate") {
    if (!raw.url) return { reason: "navigate requires url" };
    // An absolute URL reaches the surface's policy chokepoint, which throws a
    // SafetyViolation and ends the run. A hallucinated host should cost one
    // rejected action, not the whole run, so the shape is checked here.
    if (!raw.url.startsWith("/") || raw.url.startsWith("//")) {
      return {
        reason: `navigate url must be a path on the application under test, like "/members". Got "${raw.url}".`,
      };
    }
  }

  if (raw.action === "extract") {
    if (!raw.outputName) return { reason: "extract requires outputName" };
    if (!ctx.outputNames.includes(raw.outputName)) {
      return { reason: `unknown output "${raw.outputName}". Declared outputs: ${ctx.outputNames.join(", ")}` };
    }
  }

  if (raw.action === "assert") {
    const bad = validateRecognizer(raw, ctx, "assert");
    if (bad) return bad;
  }

  if (raw.action === "business_outcome") {
    // A business outcome is a claim that the application worked correctly and
    // said no. Left unconstrained it is the most attractive exit a stuck model
    // has, so it must carry a recognizer the loop can verify against the live
    // page -- and that recognizer is held to exactly the assert rules.
    if (!raw.outcomeCode) {
      return { reason: "business_outcome requires outcomeCode, e.g. MEMBER_NOT_FOUND" };
    }
    if (!/^[A-Z_]+$/.test(raw.outcomeCode)) {
      return {
        reason: `outcomeCode "${raw.outcomeCode}" must be upper-case letters and underscores only`,
      };
    }
    const bad = validateRecognizer(raw, ctx, "business_outcome");
    if (bad) return bad;
  }

  if (raw.anchorInput && !ctx.inputNames.includes(raw.anchorInput)) {
    return { reason: `unknown anchorInput "${raw.anchorInput}"` };
  }

  if (raw.action === "observe") {
    if (raw.nextBatch && !observation) {
      return { reason: "nextBatch continues the current observation, and there is not one yet" };
    }
    if (raw.nextBatch && observation && !observation.truncated) {
      return {
        reason: `observation ${observation.obsId} was not truncated (${observation.returned} of ${observation.totalEligible}); there is no next batch`,
      };
    }
    if (raw.regionId && observation && !observation.regions.some((r) => r.regionId === raw.regionId)) {
      return { reason: `no region "${raw.regionId}" in the current observation` };
    }
  }

  return null;
}
