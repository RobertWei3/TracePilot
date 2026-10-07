import {
  Capability,
  SCHEMA_VERSION,
  type Check,
  type Descriptor,
  type DiscoveryTrace,
  type Step,
  type TaskContract,
  type TraceStep,
} from "../contracts/index.js";

/**
 * Trace -> capability.
 *
 * A trace records what one run did; a capability says what any run should do.
 * Everything that separates the two is mechanical, and it all happens here:
 *
 *  - URLs become patterns. `<input:member_id>` becomes `{member_id}`, which
 *    replay expands per run, and every literal is escaped.
 *  - Each step gains the precondition it actually started from (the URL the
 *    previous step left) and, when it moved the page, an explicit wait for
 *    where it went. Replay relies on no implicit sleep.
 *  - Anything this run's application *issued* is removed. An output such as a
 *    confirmation id appears in the URL the run ended on and in the descriptor
 *    of the element it was read from; left in place, the capability would
 *    address exactly one historical confirmation and fail on every replay.
 *
 * It is a pure function of its inputs -- no browser, no model, no clock -- so
 * the same trace always compiles to the same artifact. That is the property
 * `tests/boundaries.test.ts` protects by keeping the LLM SDK out of reach.
 */
export type CompileOptions = {
  version: number;
  createdAt: string;
  /** Where replay signs in. Discovery uses the same path. */
  loginUrl?: string;
};

export type Compiled = {
  capability: Capability;
  /** What the compiler changed or could not keep, for the person reviewing it. */
  notes: string[];
};

export class CompileError extends Error {}

export function compile(trace: DiscoveryTrace, task: TaskContract, o: CompileOptions): Compiled {
  if (trace.outcome !== "success") {
    throw new CompileError(
      `only a successful run compiles; this one ended in ${trace.outcome}. ` +
        "A capability built from a run that never finished would replay its failure.",
    );
  }
  if (trace.taskId !== task.taskId) {
    throw new CompileError(`trace is for ${trace.taskId}, but the task contract is ${task.taskId}`);
  }

  const notes: string[] = [];
  const optional = optionalInputs(task.inputs);
  const issued = Object.values(trace.outputs).filter((v) => v.length > 0);
  const scrub = (d: Descriptor, where: string) => scrubDescriptor(d, issued, `${where}`, notes);

  const startPath = new URL(task.targetUrl).pathname;
  const steps: Step[] = [];
  const outputSources: Record<string, { stepId: string; regex?: string }> = {};
  let unresolved = false;

  // Discovery opens the target before its first decision, so that load is not
  // in the trace. Replay has no such implicit step.
  steps.push(
    makeStep({
      index: 0,
      phase: "navigate",
      action: "navigate",
      effect: "reversible",
      value: { const: startPath },
      waitFor: { kind: "url", pattern: urlPattern(startPath, issued), timeoutMs: 10_000 },
      reason: "open the application",
    }),
  );

  const lastConsequential = trace.steps.map((s) => s.effect).lastIndexOf("consequential");
  let before = startPath;

  trace.steps.forEach((t, i) => {
    const after = t.url;
    const stepId = sid(steps.length);

    if (t.action === "extract" && t.extractAs && outputSources[t.extractAs]) {
      // A model often re-reads an output it already holds. Replay needs it
      // bound once; the first binding is the one the run's checks followed.
      notes.push(`step ${t.seq}: dropped a repeated extract of ${t.extractAs}`);
      before = after;
      return;
    }

    let target: Descriptor | undefined;
    if (t.target) {
      const scrubbed = scrub(t.target, `step ${t.seq} (${t.action})`);
      if (scrubbed) target = scrubbed;
      else unresolved = true;
    }
    const checks = t.checks.flatMap((c) => {
      // Discovery now refuses a check that spells out an output, but a trace
      // recorded before that rule can still carry one. It could never hold
      // again, so it is dropped; if that leaves the write unverified, the
      // artifact's own invariants refuse it below.
      if (c.value && mentions(JSON.stringify(c.value), issued)) {
        notes.push(`step ${t.seq}: dropped a check whose expected text is this run's issued value`);
        return [];
      }
      return splitOnOptional(scrubCheck(c, issued, `step ${t.seq}`, notes), optional, `step ${t.seq}`, notes);
    });

    if (t.action === "assert" && checks.length === 0) {
      // Every check it carried was dropped; an assert with nothing to assert
      // would only add a step that cannot fail.
      before = after;
      return;
    }

    const moved = pathOf(after) !== pathOf(before);
    const step = makeStep({
      index: steps.length,
      phase: phaseOf(t, i, lastConsequential),
      action: t.action,
      effect: t.effect,
      // A target whose every candidate named an issued value cannot be
      // addressed again. The step is kept, flagged, and the artifact goes to
      // review -- dropping it would silently change what the workflow does.
      target: target ?? (t.target ? { ...t.target, candidates: t.target.candidates.slice(-1) } : undefined),
      // The trace records where a navigate landed, not what it was given, so
      // the destination is rebuilt from the URL it reached.
      value: t.action === "navigate" ? navigateValue(after, issued, t.seq) : t.value,
      // A navigate starts from anywhere by definition.
      precondition:
        t.action === "navigate" ? [] : [{ kind: "url_matches", pattern: urlPattern(before, issued) }],
      checks,
      waitFor:
        t.action === "navigate" || (moved && (t.action === "click" || t.action === "press"))
          ? { kind: "url", pattern: urlPattern(after, issued), timeoutMs: 10_000 }
          : undefined,
      extractAs: t.extractAs,
      diffFields: t.diffFields,
      authoredBy: t.authoredBy,
      unresolved: t.unresolved || (t.target !== undefined && target === undefined),
      surfaceFingerprint: t.surfaceFingerprint,
      reason: t.reason,
    });
    steps.push(step);

    if (t.action === "extract" && t.extractAs) {
      outputSources[t.extractAs] = { stepId, regex: t.extractRegex && unanchor(t.extractRegex) };
    }
    before = after;
  });

  const outputs: Capability["outputs"] = {};
  for (const [name, spec] of Object.entries(task.outputs) as [string, { pattern?: string; optional?: boolean }][]) {
    const source = outputSources[name];
    if (!source) {
      if (spec.optional) continue;
      throw new CompileError(`required output "${name}" was never extracted in this run`);
    }
    outputs[name] = {
      type: "string",
      ...(spec.pattern ? { pattern: spec.pattern } : {}),
      required: !spec.optional,
      source: {
        stepId: source.stepId,
        extract: { kind: "text", ...(source.regex ? { regex: source.regex } : {}) },
      },
    };
  }

  const needsReview = unresolved || steps.some((s) => s.authoredBy === "human" || s.unresolved);
  if (unresolved) notes.push("status is needs_review: a target could not be made independent of this run");

  const session = task.requires.session;
  // Capability.parse runs the artifact's own invariants -- a gate before every
  // write, every required output bound, a check after the write -- so a trace
  // that cannot satisfy them fails here, not on its first replay.
  const capability = Capability.parse({
    schemaVersion: SCHEMA_VERSION,
    capabilityId: task.taskId,
    version: o.version,
    createdAt: o.createdAt,
    status: needsReview ? "needs_review" : "ready",
    surfaceKind: "web",
    tenantId: null,
    overrides: null,
    origin: trace.origin,
    requires: session ? { session: { credentialRef: session.credentialRef, loginUrl: o.loginUrl ?? "/login" } } : {},
    inputs: task.inputs,
    outputs,
    steps,
    businessOutcomes: trace.businessOutcomes.map((b) => ({
      code: b.code,
      when: scrubCheck(b.when, issued, `business outcome ${b.code}`, notes),
    })),
    expectedDialogs: [],
    provenance: {
      runId: trace.runId,
      model: trace.model,
      authoredBy: trace.authoredBy,
      appFingerprint: trace.appFingerprint,
    },
  });
  return { capability, notes };
}

/** Dotted names of every input the task declares optional, at any depth. */
function optionalInputs(fields: Record<string, unknown>, prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const [name, raw] of Object.entries(fields)) {
    const spec = raw as { optional?: boolean; properties?: Record<string, unknown> };
    const full = prefix + name;
    if (spec.optional) out.add(full);
    if (spec.properties) for (const n of optionalInputs(spec.properties, `${full}.`)) out.add(n);
  }
  return out;
}

/**
 * A template asserts that its values appear *joined* in one exact way, and an
 * optional input makes that join depend on the run. Both directions fail:
 *
 *  - Authored where the optional input was present, "{line1}, {line2}, {city}"
 *    becomes "88 Sablewood Terrace, , Petaluma" when it is empty, while the
 *    page shows "88 Sablewood Terrace, Petaluma".
 *  - Authored where it was empty, "{line1}, {city}" never mentions it, yet
 *    only holds while it stays empty: present, the page shows
 *    "1420 Windmere Crossing, Suite 210, Brookline".
 *
 * Where an optional input sits on the page is a fact about the application the
 * compiler does not have. So a template is split whenever it uses an optional
 * input or a sibling of one -- an input in the same object -- at each optional
 * input and at each comma, the separator lists of optional parts are joined
 * by. Each piece is checked on its own, and the optional input too, which
 * holds trivially when it is empty. Every value must still be on the page;
 * only the claim about their exact punctuation is given up.
 */
function splitOnOptional(c: Check, optional: Set<string>, where: string, notes: string[]): Check[] {
  const v = c.value;
  if (c.kind !== "text_contains" || !v || !("transform" in v) || v.transform.op !== "template") return [c];
  const format = v.transform.format ?? "";
  const names = [...format.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const parent = (n: string) => n.slice(0, n.lastIndexOf(".") + 1);
  const used = names.filter((n) => optional.has(n));
  const near = names.filter((n) => [...optional].some((o) => o !== n && parent(o) === parent(n)));
  if (used.length === 0 && near.length === 0) return [c];

  const cut = new RegExp(
    [",", ...used.map((n) => `[^A-Za-z0-9{}]*\\{${escapeRegex(n)}\\}[^A-Za-z0-9{}]*`)].join("|"),
  );
  const pieces = format
    .split(cut)
    .map((p) => p.trim())
    .filter((p) => /\{[^}]+\}/.test(p));
  if (pieces.length === 1 && used.length === 0) return [c];
  notes.push(
    `${where}: split a template around optional input${used.length ? ` ${used.join(", ")}` : "s it does not mention"}, ` +
      "so it holds whether or not they are empty",
  );
  return [
    ...pieces.map((format) => ({ ...c, value: { transform: { op: "template" as const, format } } })),
    ...used.map((input) => ({ ...c, value: { input } })),
  ];
}

/** Step ids are positional and two-digit at least, as the contract requires. */
function sid(index: number): string {
  return `s${String(index + 1).padStart(2, "0")}`;
}

function makeStep(s: Omit<Step, "stepId" | "precondition" | "checks" | "authoredBy" | "unresolved"> &
  Partial<Pick<Step, "precondition" | "checks" | "authoredBy" | "unresolved">>): Step {
  const out: Record<string, unknown> = { stepId: sid(s.index), precondition: [], checks: [], ...s };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as Step;
}

/**
 * Phases are descriptive -- replay does not branch on them -- so they are
 * derived from what the step is, never from what the application is.
 */
function phaseOf(t: TraceStep, i: number, lastConsequential: number): Step["phase"] {
  if (t.effect === "consequential") return "submit";
  if (lastConsequential >= 0 && i > lastConsequential) return "verify";
  if (t.action === "approval_gate") return "review";
  if (t.action === "navigate") return "navigate";
  if (t.action === "fill" || t.action === "press") return "edit";
  return "details";
}

/**
 * The destination of a navigate, as a value replay can resolve per run: a
 * constant path, or a template when the path carries an input.
 */
function navigateValue(url: string, issued: string[], seq: number): NonNullable<Step["value"]> {
  const rel = url.replace(/^[a-z]+:\/\/[^/]+/i, "") || "/";
  if (mentions(rel, issued)) {
    throw new CompileError(`step ${seq}: navigates to a URL naming a value this run was issued`);
  }
  if (!rel.includes("<input:")) return { const: rel };
  return { transform: { op: "template", format: rel.replace(/<input:([^>]+)>/g, "{$1}") } };
}

function pathOf(url: string): string {
  const q = url.indexOf("?");
  const noQuery = q >= 0 ? url.slice(0, q) : url;
  return noQuery.replace(/^[a-z]+:\/\/[^/]+/i, "") || "/";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unanchor(pattern: string): string {
  return pattern.replace(/^\^/, "").replace(/\$$/, "");
}

/**
 * A URL as a pattern replay can check against any run. Input tags become
 * `{name}` placeholders. A URL carrying an issued value is cut there and left
 * open-ended, so `/confirmation/CONF-9LY3M2HD` becomes `/confirmation/CONF-`
 * -- the oracle's own form.
 */
export function urlPattern(url: string, issued: string[]): string {
  let rest = url.replace(/^[a-z]+:\/\/[^/]+/i, "") || "/";
  let open = false;
  for (const value of issued) {
    const at = rest.indexOf(value);
    if (at < 0) continue;
    rest = rest.slice(0, at) + fixedPrefix(value);
    open = true;
  }
  const parts = rest.split(/<input:([^>]+)>/);
  const body = parts.map((p, i) => (i % 2 === 1 ? `{${p}}` : escapeRegex(p))).join("");
  return open ? body : `${body}$`;
}

/**
 * The part of an issued value that is the same on every run: its leading
 * run of letters and separators, such as "CONF-". Conservative by design --
 * a shorter prefix still matches; a longer one would not.
 */
function fixedPrefix(value: string): string {
  return /^[A-Za-z]+[-_/]?/.exec(value)?.[0] ?? "";
}

function mentions(text: string | undefined, issued: string[]): boolean {
  return text !== undefined && issued.some((v) => text.includes(v));
}

/**
 * Removes every part of a descriptor that names an issued value. Returns null
 * when nothing addressable is left, which the caller turns into a flagged,
 * reviewable step rather than a silent guess.
 */
function scrubDescriptor(d: Descriptor, issued: string[], where: string, notes: string[]): Descriptor | null {
  if (issued.length === 0) return d;
  const candidates = d.candidates.filter((c) => !mentions(c.expr, issued));
  const touched =
    candidates.length !== d.candidates.length ||
    mentions(d.accessibleName, issued) ||
    mentions(d.labelText, issued) ||
    mentions(d.nearbyText, issued) ||
    mentions(d.scope?.containerName, issued);
  if (!touched) return d;
  if (candidates.length === 0) {
    notes.push(`${where}: every locator named a value this run was issued; the step needs review`);
    return null;
  }
  const out: Descriptor = { ...d, candidates };
  if (mentions(d.accessibleName, issued)) delete out.accessibleName;
  if (mentions(d.labelText, issued)) delete out.labelText;
  if (mentions(d.nearbyText, issued)) delete out.nearbyText;
  if (d.scope && mentions(d.scope.containerName, issued)) {
    const { containerName: _, ...scope } = d.scope;
    out.scope = scope;
  }
  notes.push(
    `${where}: removed this run's issued value from the target; it now resolves by ${candidates
      .map((c) => c.strategy)
      .join(", ")}`,
  );
  return out;
}

function scrubCheck(c: Check, issued: string[], where: string, notes: string[]): Check {
  if (issued.length === 0) return c;
  let out: Check = c;
  if (c.target) {
    const t = scrubDescriptor(c.target as Descriptor, issued, `${where} check`, notes);
    if (t) out = { ...out, target: t };
    else {
      // A text check can fall back to the whole page; an element check cannot.
      if (c.kind === "element_exists" || c.kind === "element_absent") {
        throw new CompileError(`${where}: an element check targets only this run's issued value`);
      }
      const { target: _, ...rest } = out;
      out = rest as Check;
    }
  }
  if (c.kind === "url_matches" && c.pattern && mentions(c.pattern, issued)) {
    let p = c.pattern;
    for (const v of issued) {
      const at = p.indexOf(v);
      if (at >= 0) p = p.slice(0, at) + fixedPrefix(v);
    }
    out = { ...out, pattern: p };
    notes.push(`${where}: cut a URL check at this run's issued value`);
  }
  return out;
}
