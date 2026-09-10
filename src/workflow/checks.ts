import type { Check } from "../contracts/index.js";
import { summarize, type Surface } from "../browser/index.js";
import { describeRef, resolveValue, type ResolveContext } from "./values.js";

export type CheckOutcome = {
  ok: boolean;
  /** What the check asserts, in reference form -- no resolved values. */
  expected: string;
  /** What was actually on the page. */
  observed: string;
};

/**
 * Evaluate one assertion from the closed vocabulary. Both replay and discovery
 * use this, so a check means the same thing when it is authored and when it is
 * replayed.
 */
export async function evaluateCheck(
  surface: Surface,
  check: Check,
  ctx: ResolveContext,
): Promise<CheckOutcome> {
  switch (check.kind) {
    case "url_matches": {
      const pattern = check.pattern!;
      const url = surface.currentUrl();
      // Patterns may reference inputs, so a URL check follows the parameter.
      const expanded = pattern.replace(/\{([^}]+)\}/g, (whole, name: string) => ctx.inputs[name] ?? whole);
      return {
        ok: new RegExp(expanded).test(url),
        expected: `url matches /${pattern}/`,
        observed: url,
      };
    }
    case "element_exists": {
      const res = await surface.locate(check.target!);
      return {
        ok: res.ok,
        expected: `${summarize(check.target!)} is present`,
        observed: res.ok ? "present" : `not found (tried ${res.tried.length} strategies)`,
      };
    }
    case "element_absent": {
      const res = await surface.locate(check.target!, 1500);
      return {
        ok: !res.ok,
        expected: `${summarize(check.target!)} is absent`,
        observed: res.ok ? "present" : "absent",
      };
    }
    case "text_equals":
    case "text_contains": {
      const where = check.target ? summarize(check.target) : "the visible page";
      const verb = check.kind === "text_equals" ? "equals" : "contains";
      const actual = check.target ? await surface.textOf(check.target) : await surface.visibleText();
      if (actual === null) {
        return {
          ok: false,
          expected: `${where} text ${verb} ${describeRef(check.value!)}`,
          observed: "target not found",
        };
      }
      // Assertions may reference the application's own literal text.
      const wanted = resolveValue(check.value!, ctx, { gateConstants: false });
      const ok = check.kind === "text_equals" ? actual === wanted : actual.includes(wanted);
      return {
        ok,
        expected: `${where} text ${verb} ${describeRef(check.value!)}`,
        // The observed text is page content, not a secret, but it is still
        // routed through the sanitizing writer before it reaches disk.
        observed: actual.length > 200 ? `${actual.slice(0, 200)}...` : actual,
      };
    }
  }
}

export async function evaluateAll(
  surface: Surface,
  checks: Check[],
  ctx: ResolveContext,
): Promise<{ ok: boolean; failed?: CheckOutcome; outcomes: CheckOutcome[] }> {
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) {
    const outcome = await evaluateCheck(surface, check, ctx);
    outcomes.push(outcome);
    if (!outcome.ok) return { ok: false, failed: outcome, outcomes };
  }
  return { ok: true, outcomes };
}

/**
 * Business-outcome recognizers must be explicit: an app that correctly says
 * "no members matched" is a business outcome, while a missing element or a
 * timeout is a defect and must never be reported as one.
 */
export async function recognizeBusinessOutcome(
  surface: Surface,
  recognizers: { code: string; when: Check }[],
  ctx: ResolveContext,
): Promise<{ code: string; matchedCheck: Check } | null> {
  for (const r of recognizers) {
    const outcome = await evaluateCheck(surface, r.when, ctx);
    if (outcome.ok) return { code: r.code, matchedCheck: r.when };
  }
  return null;
}
