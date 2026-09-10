import { readFileSync } from "node:fs";
import { Policy } from "../contracts/index.js";

export function loadPolicy(file = "policy.json"): Policy {
  return Policy.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Glob match supporting a single `*` per segment, which is all the routes need. */
export function routeMatches(pattern: string, pathname: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*") +
      "$",
  );
  return re.test(pathname);
}

export type Verdict = { ok: true } | { ok: false; rule: string; attempted: string };

export function checkUrl(policy: Policy, rawUrl: string): Verdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, rule: "malformed_url", attempted: rawUrl };
  }
  if (!policy.allowedOrigins.includes(url.origin)) {
    return { ok: false, rule: "origin_allowlist", attempted: url.origin };
  }
  if (!policy.allowedRoutes.some((p) => routeMatches(p, url.pathname))) {
    return { ok: false, rule: "route_allowlist", attempted: url.pathname };
  }
  return { ok: true };
}

export function checkAction(policy: Policy, action: string): Verdict {
  return policy.allowedActions.includes(action)
    ? { ok: true }
    : { ok: false, rule: "action_allowlist", attempted: action };
}

/**
 * A page action is consequential when it submits to a route declared as
 * mutating. Classification is mechanical -- never delegated to a model.
 */
export function classifyEffect(
  policy: Policy,
  submitTarget: { method: string; pathname: string } | null,
): "reversible" | "consequential" {
  if (!submitTarget) return "reversible";
  const mutating = submitTarget.method.toUpperCase() !== "GET";
  const declared = policy.consequentialRoutes.some((p) => routeMatches(p, submitTarget.pathname));
  return mutating && declared ? "consequential" : "reversible";
}

export class SafetyViolation extends Error {
  constructor(
    readonly rule: string,
    readonly attempted: string,
  ) {
    super(`safety: ${rule} refused "${attempted}"`);
    this.name = "SafetyViolation";
  }
}
