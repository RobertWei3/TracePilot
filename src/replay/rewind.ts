import type { Step } from "../contracts/index.js";

/**
 * Where a run should resume after a bounded recovery.
 *
 * Recovery reloads a page, which discards unsaved form input, so resuming at
 * the failing step alone can submit stale values. Resuming at the earliest
 * already-executed step that started on the recovered page rebuilds whatever
 * that page had accumulated.
 *
 * The refusal is the important half: if resuming there would re-run a step at
 * or before a consequential action that has already executed, there is no safe
 * automatic recovery -- repeating a durable write is never acceptable -- and a
 * person has to take it from here.
 *
 * Kept as a pure function so the refusal is directly testable; the surface
 * conditions that would trigger it in DemoBank are unreachable by construction.
 */
export function chooseRewind(args: {
  steps: Step[];
  /** URL each executed step started from, keyed by step id. */
  stepStartUrl: Map<string, string>;
  currentStepId: string;
  /** Where the run actually is after the recovery navigation. */
  recoveredUrl: string;
  consequentialDone: boolean;
}): { index: number } | { refused: "would_repeat_durable_write" } {
  const { steps, stepStartUrl, currentStepId, recoveredUrl, consequentialDone } = args;
  const currentIndex = steps.findIndex((s) => s.stepId === currentStepId);
  if (currentIndex < 0) return { refused: "would_repeat_durable_write" };

  const path = safePath(recoveredUrl);
  let candidate = currentIndex;
  for (let i = 0; i <= currentIndex; i += 1) {
    const recorded = stepStartUrl.get(steps[i]!.stepId);
    if (!recorded) continue;
    if (safePath(recorded) === path) {
      candidate = i;
      break;
    }
  }

  if (consequentialDone) {
    const consequentialIndex = steps.findIndex((s) => s.effect === "consequential");
    if (consequentialIndex >= 0 && candidate <= consequentialIndex) {
      return { refused: "would_repeat_durable_write" };
    }
  }
  return { index: candidate };
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
