import type { Policy } from "../contracts/index.js";
import { MIN_TAGGED_VALUE_LENGTH, type Observation } from "../browser/index.js";
import { renderObservation } from "./prompt.js";

/**
 * The single place model-bound bytes are produced. Nothing else may render an
 * observation for a model, so there is exactly one thing to audit and exactly
 * one thing to test.
 *
 * Two guards run, each where it holds the knowledge it needs:
 *
 *  - The in-page `selfCheck` compares the redacted output against the sensitive
 *    literals while both are still inside the browser. A guard here could not
 *    do that: to scan for a sensitive value, this process would have to be
 *    handed the value, which is the disclosure the redaction exists to prevent.
 *  - The scan below covers the run's own input values, which this process
 *    legitimately holds because the caller supplied them.
 *
 * A payload that fails either guard is not sent. Blocking costs a turn;
 * shipping a leak cannot be undone.
 */
export type ModelPayload =
  | { blocked: false; text: string; image: { data: Buffer; mediaType: "image/jpeg" } | null }
  | { blocked: true; reason: string };

export type PayloadInput = {
  observation: Observation;
  /** Result of Surface.screenshot(), passed through unread. */
  screenshot: { buffer: Buffer } | { buffer: null; omittedReason: string };
  /** Flattened run parameters. Values are compared, never rendered. */
  inputs: Record<string, string>;
  policy: Policy;
  /** Prepended context line, e.g. the outcome of the previous action. */
  note?: string;
};

export function buildModelPayload(input: PayloadInput): ModelPayload {
  const { observation, screenshot, inputs } = input;

  if (!observation.selfCheck.ok) {
    return { blocked: true, reason: observation.selfCheck.reason ?? "observation self-check failed" };
  }

  const text = renderObservation(observation, input.note);

  // Two exclusions, both about scanning for something redaction never promised
  // to remove. An empty value is skipped because "".includes is always true,
  // so one optional field left blank would block every payload for the rest of
  // the run. A value below the tagging threshold is skipped because the tagger
  // deliberately leaves it alone: "MA" appears in ordinary page text, and
  // blocking on it would stop a run over redaction that was working exactly as
  // designed. Short values are covered by the field verdict instead.
  for (const [name, value] of Object.entries(inputs)) {
    if (!value || value.length < MIN_TAGGED_VALUE_LENGTH) continue;
    if (text.includes(value)) {
      return { blocked: true, reason: `input "${name}" reached the payload unredacted` };
    }
  }

  const image =
    screenshot.buffer === null
      ? null
      : { data: screenshot.buffer, mediaType: "image/jpeg" as const };

  return { blocked: false, text, image };
}

/**
 * Why an image is absent, for the record. The payload carries no image either
 * when capture was refused as unsafe or when it simply failed; a run record
 * that cannot tell those apart hides a safety signal behind a flake.
 */
export function imageOmission(
  screenshot: { buffer: Buffer } | { buffer: null; omittedReason: string },
): string | null {
  return screenshot.buffer === null ? screenshot.omittedReason : null;
}
