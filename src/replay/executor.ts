import { createHash } from "node:crypto";
import type {
  Capability,
  ExecutionResult,
  Policy,
  ReasonCode,
  Step,
  ValueRef,
} from "../contracts/index.js";
import { ExecutionResult as ResultSchema, FINGERPRINT_PATTERN } from "../contracts/index.js";
import { SafetyViolation, redact } from "../safety/index.js";
import { LoadError, fingerprint, summarize, type Surface } from "../browser/index.js";
import type { BudgetLedger, RunStore } from "../observability/index.js";
import type { ControlLedger, OperatorConsole } from "../handoff/index.js";
import { chooseRewind } from "./rewind.js";
import type { ApprovalMode } from "../workflow/index.js";
import {
  describeRef,
  evaluateAll,
  recognizeBusinessOutcome,
  resolveValue,
  UnresolvableValue,
  type ResolveContext,
} from "../workflow/index.js";

export type { ApprovalMode } from "../workflow/index.js";

export type ReplayOptions = {
  capability: Capability;
  surface: Surface;
  store: RunStore;
  control: ControlLedger;
  operator: OperatorConsole;
  budgets: BudgetLedger;
  ctx: ResolveContext;
  approval: ApprovalMode;
  baseUrl: string;
  policy: Policy;
  /** False in CI and tests: escalations use the same path but stay terminal. */
  interactive: boolean;
};

type Recovery = ExecutionResult["recoveries"][number];

/** See ReplayExecutor.compareFingerprint. */
type Fingerprinted = "settled" | "unresolved";

/** Stands in for a step id where something happened before any step, or outside one. */
const RUN_LEVEL = "(run)";

class Terminal extends Error {
  constructor(
    readonly outcome: NonNullable<ExecutionResult["outcome"]>,
    readonly reasonCode: ReasonCode,
    readonly detail: {
      step?: Step;
      expected?: string;
      observed?: string;
      evidence?: string[];
      safety?: { rule: string; attempted: string };
      business?: { code: string; matchedCheck: Capability["businessOutcomes"][number]["when"] };
    } = {},
  ) {
    super(reasonCode);
  }
}

/**
 * Raised after a bounded recovery so the step loop resumes at a given index.
 * Recovery reloads the page, which discards unsaved form input, so resuming at
 * the failing step alone could submit stale values. Resuming at the earliest
 * executed step that started on the recovered page re-establishes everything
 * that page had accumulated.
 */
class RetryFrom extends Error {
  constructor(readonly index: number) {
    super("retry-from");
  }
}

class Escalate extends Error {
  constructor(
    readonly step: Step,
    readonly reasonCode: ReasonCode,
    readonly expected: string,
    readonly observed: string,
    readonly reason: string,
  ) {
    super(reasonCode);
  }
}

/**
 * Deterministic replay. No LLM is constructed here and none is reachable from
 * this module -- `tests/boundaries.test.ts` asserts that as an import-graph
 * property rather than a convention.
 */
export class ReplayExecutor {
  private readonly recoveries: Recovery[] = [];
  private readonly driftSteps: string[] = [];
  /** Steps whose target no longer looks the way discovery recorded it. */
  private readonly fingerprintMismatches = new Set<string>();
  /**
   * Steps whose fingerprint has had its one answer -- compared, or noted as
   * impossible to compare. A step run again after a rewind adds nothing.
   */
  private readonly fingerprintSettled = new Set<string>();
  private readonly approvals: ExecutionResult["approvals"] = [];
  private readonly usedRecovery = { transient: 0, reload: 0, relogin: 0 };
  private readonly outputs: Record<string, string> = {};
  private readonly startedAt = new Date().toISOString();
  /** URL each executed step started from, used to choose a rewind point. */
  private readonly stepStartUrl = new Map<string, string>();
  /** Set once a consequential step has run: recovery must never rewind past it. */
  private consequentialDone = false;
  private lastPath = "/";
  /** The most recent hand-off, for a run that pauses rather than resumes. */
  private lastInterventionId: string | null = null;

  constructor(private readonly o: ReplayOptions) {}

  async run(): Promise<ExecutionResult> {
    const { capability, surface, store, control, budgets } = this.o;
    control.transfer("AGENT", "replay started");
    surface.expectedDialogs = capability.expectedDialogs;

    store.event({
      type: "replay_started",
      actor: "AGENT",
      reason: `${capability.capabilityId} v${capability.version} (${capability.steps.length} steps)`,
    });

    try {
      const session = capability.requires.session;
      if (session) {
        // An unreachable application surfaces here first, before any step, and
        // gets the same bounded reload as a load inside a step.
        const ok = await this.withLoadRecovery(
          () => surface.ensureSession(this.absolute(session.loginUrl), session.credentialRef),
          { expected: "the login page to load" },
        );
        store.event({ type: "session_established", actor: "AGENT", outcome: ok ? "ok" : "failed" });
        if (!ok) {
          throw new Terminal("failure", "SESSION_EXPIRED_UNRECOVERED", {
            expected: "an authenticated session before the first step",
            observed: "the login form was still present after signing in",
          });
        }
      }

      for (let cursor = 0; cursor < capability.steps.length; cursor += 1) {
        const step = capability.steps[cursor]!;
        const exhausted = budgets.exhausted();
        if (exhausted) {
          throw new Terminal("aborted", exhausted, {
            step,
            expected: `to complete ${capability.steps.length} steps within budget`,
            observed: `budget exhausted at step ${step.stepId}`,
          });
        }
        try {
          await this.runStep(step);
        } catch (e) {
          if (e instanceof Escalate) {
            // A person takes over here and the run continues from wherever
            // they hand it back -- this executor invocation does not end.
            const next = await this.handOff(e);
            if (typeof next !== "number") return next;
            cursor = next - 1;
            continue;
          }
          if (!(e instanceof RetryFrom)) throw e;
          store.event({
            type: "resumed_after_recovery",
            actor: "AGENT",
            stepId: capability.steps[e.index]!.stepId,
            reason: `rewound to re-establish the page state lost by recovery`,
          });
          cursor = e.index - 1;
        }
      }

      await this.collectOutputs();
      return this.finish("success", "OK");
    } catch (e) {
      return this.handleThrow(e);
    }
  }

  // --- step execution -----------------------------------------------------

  private async runStep(step: Step): Promise<void> {
    const { store, budgets } = this.o;
    const started = Date.now();
    budgets.actionSteps += 1;
    this.stepStartUrl.set(step.stepId, this.o.surface.currentUrl());

    store.event({
      type: "step_started",
      actor: "AGENT",
      stepId: step.stepId,
      stepIndex: step.index,
      action: step.action,
      targetSummary: step.target ? summarize(step.target) : undefined,
      valueRef: step.value ? describeRef(step.value) : undefined,
      reason: step.reason,
    });

    await this.verifyPreconditions(step);

    if (step.action === "approval_gate") {
      await this.approve(step);
    } else {
      if (step.effect === "consequential" && this.approvals.length === 0) {
        // The artifact contract already requires a gate before every write;
        // this holds at run time too, whatever path led here -- a resume, a
        // rewind, a hand-back that skipped ahead.
        throw new Terminal("safety_violation", "APPROVAL_MISSING", {
          step,
          expected: "a recorded approval before this consequential step",
          observed: "no approval has been recorded in this run",
          safety: { rule: "approval_required", attempted: `${step.action} ${step.stepId}` },
        });
      }
      await this.perform(step);
    }

    const waitMiss = await this.tryWait(step);
    if (waitMiss) {
      throw await this.divergence(step, waitMiss.expected, waitMiss.observed, "TIMEOUT");
    }

    // Guards run even when the wait succeeded: a session can expire on a page
    // that otherwise looks right.
    await this.guardPostConditions(step);

    const business = await this.recognize();
    if (business) {
      throw new Terminal("business_outcome", "BUSINESS_OUTCOME", { step, business });
    }

    const checks = await evaluateAll(this.o.surface, step.checks, this.o.ctx);
    if (!checks.ok) {
      const failed = checks.failed!;
      const retried = await this.recoverAndRetryChecks(step);
      if (!retried) {
        throw await this.divergence(step, failed.expected, failed.observed, "CHECK_FAILED");
      }
    }

    if (step.effect === "consequential") this.consequentialDone = true;
    this.lastPath = new URL(this.o.surface.currentUrl()).pathname + new URL(this.o.surface.currentUrl()).search;
    store.event({
      type: "step_finished",
      actor: "AGENT",
      stepId: step.stepId,
      stepIndex: step.index,
      outcome: "ok",
      durationMs: Date.now() - started,
      url: this.o.surface.currentUrl(),
      budgets: budgets.snapshot(),
    });
  }

  private async perform(step: Step): Promise<void> {
    const { surface, store } = this.o;

    if (step.action === "navigate" || step.action === "read_back") {
      const url = this.absolute(this.resolveUrl(step.value));
      const res = await this.withLoadRecovery(() => surface.navigate(url), { step });
      this.lastPath = new URL(url).pathname + new URL(url).search;
      if (res.status !== null && res.status >= 400) {
        if (res.status === 403) {
          // A permission refusal is deliberate, not a retry candidate.
          throw new Escalate(
            step,
            "PERMISSION_DENIED",
            "an authorised page load",
            `HTTP ${res.status} at ${url}`,
            "the operator role is not permitted to perform this step",
          );
        }
        if (res.status === 401) {
          // An unauthenticated load is a symptom of an expired session, so it
          // goes through the same diagnosis -- and therefore the same bounded
          // re-login -- as an expiry detected from the page itself.
          throw await this.divergence(
            step,
            "an authenticated page load",
            `HTTP 401 at ${url}`,
            "SESSION_EXPIRED_UNRECOVERED",
          );
        }
        throw new Terminal("failure", "LOAD_FAILED", {
          step,
          expected: `a successful load of ${url}`,
          observed: `HTTP ${res.status}`,
          evidence: await this.captureEvidence(`load-${step.stepId}`),
        });
      }
      return;
    }

    if (step.action === "waitFor" || step.action === "assert") {
      return; // The wait and the checks below carry the whole meaning.
    }

    if (step.action === "extract") {
      // Taken before reading; an extract has no retry to fold it into.
      const fingerprinted = await this.compareFingerprint(step);
      const text = await surface.textOf(step.target!);
      if (text === null) {
        throw new Terminal("failure", "TARGET_UNRESOLVED", {
          step,
          expected: `${summarize(step.target!)} to be present so ${step.extractAs} can be read`,
          observed: "the target did not resolve",
          evidence: await this.captureEvidence(`extract-${step.stepId}`),
        });
      }
      const spec = this.o.capability.outputs[step.extractAs!];
      const raw = spec?.source.extract.regex
        ? (text.match(new RegExp(spec.source.extract.regex)) ?? [])[0]
        : text;
      if (raw === undefined) {
        throw new Terminal("failure", "OUTPUT_VALIDATION_FAILED", {
          step,
          expected: `text matching /${spec?.source.extract.regex}/ for ${step.extractAs}`,
          observed: text.slice(0, 200),
          evidence: await this.captureEvidence(`extract-${step.stepId}`),
        });
      }
      this.outputs[step.extractAs!] = raw;
      store.event({
        type: "output_extracted",
        actor: "AGENT",
        stepId: step.stepId,
        reason: `bound ${step.extractAs}`,
      });
      this.noteIfUncompared(step, fingerprinted);
      return;
    }

    // click / fill / select / press
    const literal = step.value ? this.resolve(step.value) : undefined;
    // The fingerprint is taken inside each attempt, before acting -- once a
    // click lands, the element may be gone -- so the attempt that succeeds is
    // the one compared, even when the target appeared only on a retry.
    let fingerprinted: Fingerprinted = "unresolved";
    const attempt = await this.withTransientRecovery(step, async () => {
      if (fingerprinted === "unresolved") fingerprinted = await this.compareFingerprint(step);
      return surface.act(step.action as "click" | "fill" | "select" | "press", step.target!, literal);
    });

    if (!attempt.ok) {
      throw await this.divergence(
        step,
        `${step.action} on ${summarize(step.target!)}`,
        attempt.detail,
        attempt.reason === "unresolved" ? "TARGET_UNRESOLVED" : "TIMEOUT",
      );
    }
    this.noteIfUncompared(step, fingerprinted);

    if (attempt.rank > 1) {
      // The artifact still works, but it worked through a weaker strategy --
      // which is the signal that the application has moved underneath it.
      this.driftSteps.push(step.stepId);
      this.recoveries.push({
        stepId: step.stepId,
        kind: "candidate_fallthrough",
        attempts: attempt.rank,
        succeeded: true,
      });
    }
    store.event({
      type: "action_performed",
      actor: "AGENT",
      stepId: step.stepId,
      action: step.action,
      resolvedRank: attempt.rank,
      resolvedStrategy: attempt.strategy,
      url: surface.currentUrl(),
    });
  }

  /**
   * A warning, not a failure. A locator can still resolve at rank 1 after the
   * element was renamed, or resolve structurally to the wrong element; a
   * fingerprint taken the same way discovery took it shows either. The step
   * carries on regardless -- whether the run worked is for the checks to say.
   *
   * The capability's appFingerprint is not compared: it is a hash of every
   * step's fingerprint, so it differs exactly when one of these does and says
   * nothing more.
   *
   * "unresolved" means the target could not be found yet, so the caller may
   * try again with its next attempt; "settled" means the step needs nothing
   * more -- it was compared, could never be, or has no fingerprint.
   */
  private async compareFingerprint(step: Step): Promise<Fingerprinted> {
    if (!step.target || !step.surfaceFingerprint || this.fingerprintSettled.has(step.stepId)) return "settled";
    if (!FINGERPRINT_PATTERN.test(step.surfaceFingerprint)) {
      // Damaged in storage: redaction tags an input value wherever it occurs
      // when a record is written, and a hash's hex can contain one. It can
      // never match, so it is not compared -- and not silently either.
      this.noteUnverifiable(step, "the recorded fingerprint is not a well-formed hash");
      return "settled";
    }
    const live = await this.o.surface.describeResolved(step.target);
    if (!live.resolved) return "unresolved";
    if (!live.descriptor) {
      this.noteUnverifiable(step, "the target resolved, but the observer does not report it");
      return "settled";
    }
    this.fingerprintSettled.add(step.stepId);
    const observed = fingerprint(live.descriptor);
    if (observed === step.surfaceFingerprint) return "settled";
    this.fingerprintMismatches.add(step.stepId);
    this.o.store.event({
      type: "fingerprint_mismatch",
      actor: "AGENT",
      stepId: step.stepId,
      expected: step.surfaceFingerprint,
      observed,
    });
    return "settled";
  }

  /**
   * After an action that succeeded: a target that never resolved for the
   * fingerprint, yet did for the action, appeared in between. Rare, and
   * recorded rather than passed over.
   */
  private noteIfUncompared(step: Step, fingerprinted: Fingerprinted): void {
    if (fingerprinted === "unresolved" && step.target && step.surfaceFingerprint) {
      this.noteUnverifiable(step, "the target had not resolved when its fingerprint was taken");
    }
  }

  private noteUnverifiable(step: Step, reason: string): void {
    if (this.fingerprintSettled.has(step.stepId)) return;
    this.fingerprintSettled.add(step.stepId);
    this.o.store.event({ type: "fingerprint_unverifiable", actor: "AGENT", stepId: step.stepId, reason });
  }

  // --- gates, waits and guards -------------------------------------------

  /**
   * Approval is required before any consequential action, and the operator is
   * shown the pending change rather than a bare "proceed?". A pre-approval is
   * recorded with who authorised it and when; there is no silent auto-approve.
   */
  private async approve(step: Step): Promise<void> {
    const fields: { label: string; from: string; to: string }[] = [];
    for (const f of step.diffFields ?? []) {
      const to = this.resolve(f.value);
      let from = "(not read)";
      if (f.currentFrom) from = (await this.o.surface.textOf(f.currentFrom)) ?? "(not read)";
      fields.push({ label: f.label, from, to });
    }
    const digest =
      "sha256:" +
      createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16);

    if (this.o.approval.mode === "pre_approved") {
      this.approvals.push({
        stepId: step.stepId,
        mode: "pre_approved",
        approvedBy: this.o.approval.approvedBy,
        at: this.o.approval.at,
        diffDigest: digest,
      });
      this.o.store.event({
        type: "approval_recorded",
        actor: "SYSTEM",
        stepId: step.stepId,
        outcome: "pre_approved",
        reason: `authorised by ${this.o.approval.approvedBy} at ${this.o.approval.at}`,
      });
      return;
    }

    const handled = await this.o.operator.handle({
      kind: "approval_required",
      subject: {
        capabilityId: this.o.capability.capabilityId,
        version: this.o.capability.version,
        goalSummary: `update mailing address for {input:member_id}`,
      },
      step: {
        stepId: step.stepId,
        index: step.index,
        action: step.action,
        targetSummary: "consequential change pending",
      },
      expected: "operator approval before a consequential change",
      observed: "awaiting approval",
      reason: "the next step writes a durable change to a member record",
      reasonCode: "OK",
      pendingChange: { fields, digest },
      allowedResponses: ["resume", "abort"],
    });

    if (handled.response !== "resume") {
      throw new Terminal("aborted", "APPROVAL_DECLINED", {
        step,
        expected: "operator approval",
        observed: `operator chose "${handled.response}"`,
      });
    }
    this.approvals.push({
      stepId: step.stepId,
      mode: "interactive",
      approvedBy: "operator",
      at: new Date().toISOString(),
      diffDigest: digest,
    });
  }

  /**
   * Explicit waits. Nothing in replay relies on an implicit sleep. A miss is
   * returned rather than thrown, because a wait that does not land is a
   * *symptom* -- the cause may be a dialog, a permission refusal, an expired
   * session or the application legitimately saying no, and each of those wants
   * a different answer.
   */
  private async tryWait(step: Step): Promise<{ expected: string; observed: string } | null> {
    const wait = step.waitFor;
    const { surface } = this.o;
    if (!wait) {
      await surface.settle();
      return null;
    }
    const deadline = Date.now() + wait.timeoutMs;
    if (wait.kind === "settled") {
      await surface.settle(wait.timeoutMs);
      return null;
    }
    if (wait.kind === "url") {
      const expanded = (wait.pattern ?? "").replace(
        /\{([^}]+)\}/g,
        (whole, name: string) => this.o.ctx.inputs[name] ?? whole,
      );
      const re = new RegExp(expanded);
      while (Date.now() < deadline) {
        if (re.test(surface.currentUrl())) return null;
        await new Promise((r) => setTimeout(r, 150));
      }
      return {
        expected: `url matching /${wait.pattern}/ within ${wait.timeoutMs}ms`,
        observed: surface.currentUrl(),
      };
    }
    // wait.kind === "element": the transient-loading case.
    const res = await surface.locate(wait.target!, wait.timeoutMs);
    if (!res.ok) {
      return {
        expected: `${summarize(wait.target!)} within ${wait.timeoutMs}ms`,
        observed: "the element never appeared",
      };
    }
    return null;
  }

  private async recognize(): Promise<{ code: string; matchedCheck: Capability["businessOutcomes"][number]["when"] } | null> {
    return recognizeBusinessOutcome(
      this.o.surface,
      this.o.capability.businessOutcomes,
      this.o.ctx,
    );
  }

  /**
   * Diagnose a divergence in a fixed order, most specific first, so a generic
   * timeout is the last resort rather than the first answer. A wait that does
   * not land, a check that does not hold and an action that does not resolve
   * all arrive here, because they are symptoms with several possible causes.
   */
  private async divergence(
    step: Step,
    expected: string,
    observed: string,
    fallback: ReasonCode,
  ): Promise<Terminal | Escalate | RetryFrom> {
    const condition = await this.deliberateCondition(step, { retryAfterRecovery: true });
    if (condition) return condition;

    const business = await this.recognize();
    if (business) {
      return new Terminal("business_outcome", "BUSINESS_OUTCOME", { step, business });
    }

    if (this.o.interactive) {
      // A person at the console can often do what the recording could not --
      // a relabelled button is obvious to someone looking at it. Offered only
      // interactively; unattended, a divergence stays a reportable failure.
      return new Escalate(
        step,
        fallback,
        expected,
        observed,
        "replay could not complete this step as recorded; perform it by hand and answer step_done, or take over entirely",
      );
    }

    return new Terminal("failure", fallback, {
      step,
      expected,
      observed,
      evidence: await this.captureEvidence(`diverged-${step.stepId}`),
    });
  }

  /**
   * Conditions that are handled deliberately rather than retried blindly:
   * an undeclared dialog, a permission refusal, and an expired session. Shared
   * by the success path (guardPostConditions) and the divergence path, so a
   * dialog means the same thing whether or not a wait also missed.
   */
  private async deliberateCondition(
    step: Step,
    opts: { retryAfterRecovery: boolean },
  ): Promise<Escalate | RetryFrom | null> {
    const { surface } = this.o;

    const dialogs = surface.drainUndeclaredDialogs();
    if (dialogs.length > 0) {
      return new Escalate(
        step,
        "UNEXPECTED_DIALOG",
        "no dialog, or a dialog declared in the artifact",
        `undeclared ${dialogs[0]!.type}: "${dialogs[0]!.message}"`,
        "an undeclared dialog was dismissed rather than accepted; accepting it could submit something twice",
      );
    }

    const text = await surface.visibleText();
    if (text.includes("do not have permission")) {
      return new Escalate(
        step,
        "PERMISSION_DENIED",
        "an authorised page",
        "the application refused the operator's role",
        "this account cannot complete the step; a permitted operator must take over",
      );
    }

    if (await surface.sessionExpired()) {
      // Where to come back to depends on why we are here. If the action did not
      // land, the run belongs back on the page the step started from. If the
      // action succeeded and only the session then died, the run belongs on the
      // page it had reached.
      const returnTo = opts.retryAfterRecovery
        ? (this.stepStartUrl.get(step.stepId) ?? surface.currentUrl())
        : surface.currentUrl();
      const escalation = await this.recoverSession(step, returnTo);
      if (escalation) return escalation;
      if (!opts.retryAfterRecovery) return null;
      const rewind = chooseRewind({
        steps: this.o.capability.steps,
        stepStartUrl: this.stepStartUrl,
        currentStepId: step.stepId,
        recoveredUrl: this.o.surface.currentUrl(),
        consequentialDone: this.consequentialDone,
      });
      if ("refused" in rewind) {
        return new Escalate(
          step,
          "SESSION_EXPIRED_UNRECOVERED",
          "a resumable position before any durable write",
          "recovery would require repeating work that follows a consequential step",
          "re-driving a workflow past a submission risks writing twice, so a person must take it from here",
        );
      }
      return new RetryFrom(rewind.index);
    }

    return null;
  }

  private async guardPostConditions(step: Step): Promise<void> {
    const condition = await this.deliberateCondition(step, { retryAfterRecovery: false });
    if (condition) throw condition;
  }

  // --- bounded recovery ---------------------------------------------------

  private async withTransientRecovery<T extends { ok: boolean }>(
    step: Step,
    action: () => Promise<T>,
  ): Promise<T> {
    let last = await action();
    let attempts = 1;
    while (!last.ok && this.usedRecovery.transient < this.o.policy.recovery.transientRetries) {
      this.usedRecovery.transient += 1;
      attempts += 1;
      await new Promise((r) => setTimeout(r, 400 * attempts));
      await this.o.surface.settle();
      last = await action();
    }
    if (attempts > 1) {
      this.recoveries.push({ stepId: step.stepId, kind: "transient_retry", attempts, succeeded: last.ok });
      this.o.store.event({
        type: "recovery",
        actor: "AGENT",
        stepId: step.stepId,
        reason: `transient_retry x${attempts - 1}`,
        outcome: last.ok ? "ok" : "failed",
      });
    }
    return last;
  }

  /**
   * Reloads are bounded by policy across the whole run. `step` is absent while
   * the session is being established, before the first step exists; the
   * recovery is then recorded against the run as a whole.
   */
  private async withLoadRecovery<T>(
    load: () => Promise<T>,
    { step, expected = "the page to load" }: { step?: Step; expected?: string } = {},
  ): Promise<T> {
    let recovery: Recovery | undefined;
    for (;;) {
      try {
        const res = await load();
        if (recovery) recovery.succeeded = true;
        return res;
      } catch (e) {
        if (!(e instanceof LoadError)) throw e;
        if (this.usedRecovery.reload >= this.o.policy.recovery.reloads) {
          throw new Terminal("failure", "LOAD_FAILED", { step, expected, observed: e.category });
        }
        this.usedRecovery.reload += 1;
        recovery = { stepId: step?.stepId ?? RUN_LEVEL, kind: "reload", attempts: 1, succeeded: false };
        this.recoveries.push(recovery);
        this.o.store.event({ type: "recovery", actor: "AGENT", stepId: step?.stepId, reason: "reload" });
      }
    }
  }

  /**
   * One re-authentication, then the checkpoint precondition is re-verified.
   * Resuming blind after a re-login is how a workflow silently continues in
   * the wrong place.
   */
  private async recoverSession(step: Step, returnTo: string): Promise<Escalate | null> {
    const session = this.o.capability.requires.session;
    if (!session || this.usedRecovery.relogin >= this.o.policy.recovery.relogins) {
      return new Escalate(
        step,
        "SESSION_EXPIRED_UNRECOVERED",
        "a live session",
        "the session expired and the re-login budget is spent",
        "re-authentication is bounded to one attempt per run",
      );
    }
    this.usedRecovery.relogin += 1;
    this.o.store.event({ type: "recovery", actor: "AGENT", stepId: step.stepId, reason: "session_relogin" });

    const ok = await this.o.surface.ensureSession(
      this.absolute(session.loginUrl),
      session.credentialRef,
    );
    this.recoveries.push({ stepId: step.stepId, kind: "session_relogin", attempts: 1, succeeded: ok });
    if (!ok) {
      return new Escalate(
        step,
        "SESSION_EXPIRED_UNRECOVERED",
        "a re-established session",
        "signing in again did not produce a session",
        "credentials may have changed",
      );
    }
    // Return to where the step expected to be, then re-verify before handing
    // control back to the agent. Resuming blind after a re-login is how a
    // workflow silently continues in the wrong place.
    const target = returnTo.includes("/login") ? this.absolute(this.lastPath) : returnTo;
    const back = await this.o.surface.navigate(target);

    // Not every page can be restored by navigation. The review screen is
    // rendered by a POST and has no addressable GET, so a session that dies
    // there cannot be resumed -- that is an unsupported condition, and saying
    // so is far better than reporting the missing button as the problem.
    if (back.status !== null && back.status >= 400) {
      return new Escalate(
        step,
        "SESSION_EXPIRED_UNRECOVERED",
        `the run to resume at ${target}`,
        `re-authentication succeeded, but that page cannot be restored by navigation (HTTP ${back.status})`,
        "this screen is produced by a form submission and has no addressable URL, so the workflow must be re-driven by a person from a known page",
      );
    }

    return null;
  }

  private async recoverAndRetryChecks(step: Step): Promise<boolean> {
    if (this.usedRecovery.transient >= this.o.policy.recovery.transientRetries) return false;
    this.usedRecovery.transient += 1;
    await this.o.surface.settle();
    await new Promise((r) => setTimeout(r, 500));
    const again = await evaluateAll(this.o.surface, step.checks, this.o.ctx);
    this.recoveries.push({
      stepId: step.stepId,
      kind: "transient_retry",
      attempts: 1,
      succeeded: again.ok,
    });
    return again.ok;
  }

  // --- preconditions, outputs, results ------------------------------------

  /**
   * Mechanical preconditions: the URL shape the step expects, and the target
   * being resolvable. Re-verified after any recovery and after a handback.
   */
  private async verifyPreconditions(step: Step, opts: { afterRecovery?: boolean } = {}): Promise<void> {
    if (step.precondition.length === 0) return;
    const result = await evaluateAll(this.o.surface, step.precondition, this.o.ctx);
    if (result.ok) return;
    const failed = result.failed!;
    if (opts.afterRecovery) {
      throw new Escalate(
        step,
        "PRECONDITION_FAILED",
        failed.expected,
        failed.observed,
        "recovery did not restore the state this step expects",
      );
    }
    if (this.o.interactive) {
      // Typically a hand-back that did not leave the page where the next step
      // starts -- "step_done" for a step that was not done. The answer goes
      // back to the person rather than ending the run they are part of.
      throw new Escalate(
        step,
        "PRECONDITION_FAILED",
        failed.expected,
        failed.observed,
        "the page is not in the state this step starts from; put it there and answer resume, or take over",
      );
    }
    throw new Terminal("failure", "PRECONDITION_FAILED", {
      step,
      expected: failed.expected,
      observed: failed.observed,
      evidence: await this.captureEvidence(`pre-${step.stepId}`),
    });
  }

  /** Declared outputs must validate before a run may call itself successful. */
  private async collectOutputs(): Promise<void> {
    for (const [name, spec] of Object.entries(this.o.capability.outputs)) {
      const value = this.outputs[name];
      if (value === undefined) {
        if (!spec.required) continue;
        throw new Terminal("failure", "OUTPUT_VALIDATION_FAILED", {
          expected: `a value for required output "${name}"`,
          observed: "no extract step produced one",
        });
      }
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
        throw new Terminal("failure", "OUTPUT_VALIDATION_FAILED", {
          expected: `${name} matching /${spec.pattern}/`,
          observed: value,
          evidence: await this.captureEvidence("output-validation"),
        });
      }
    }
  }

  private async captureEvidence(label: string): Promise<string[]> {
    const shot = await this.o.surface.screenshot();
    const saved = this.o.store.screenshot(label, shot);
    if (saved.ref) return [saved.ref];
    this.o.store.event({
      type: "evidence_omitted",
      actor: "SYSTEM",
      omittedReason: saved.omittedReason,
      reason: "no image written; a safe masked capture could not be established",
    });
    return [];
  }

  private resolve(ref: ValueRef): string {
    return resolveValue(ref, this.o.ctx);
  }

  /**
   * URL constants are governed by the origin and route allowlists, which is a
   * stronger check than the approved-constants list, so they do not need to be
   * enumerated there.
   */
  private resolveUrl(ref: ValueRef | undefined): string {
    if (!ref) return "/";
    if ("const" in ref) return ref.const;
    return this.resolve(ref);
  }

  private absolute(pathOrUrl: string): string {
    return pathOrUrl.startsWith("http") ? pathOrUrl : `${this.o.baseUrl}${pathOrUrl}`;
  }

  private async handleThrow(e: unknown): Promise<ExecutionResult> {
    if (e instanceof Terminal) {
      return this.finish(e.outcome, e.reasonCode, e.detail);
    }
    if (e instanceof Escalate) {
      // Raised outside the step loop, so there is no step sequence to resume
      // into: a hand-back pauses the run instead.
      const next = await this.handOff(e);
      return typeof next === "number" ? this.pause(e, "control returned outside the step sequence") : next;
    }
    if (e instanceof SafetyViolation) {
      this.o.store.event({
        type: "safety_violation",
        actor: "SYSTEM",
        reasonCode: e.rule === "origin_allowlist" ? "ORIGIN_NOT_ALLOWLISTED" : "ROUTE_NOT_ALLOWLISTED",
        reason: e.message,
      });
      return this.finish(
        "safety_violation",
        e.rule === "origin_allowlist"
          ? "ORIGIN_NOT_ALLOWLISTED"
          : e.rule === "action_allowlist"
            ? "ACTION_NOT_ALLOWLISTED"
            : "ROUTE_NOT_ALLOWLISTED",
        { safety: { rule: e.rule, attempted: e.attempted } },
      );
    }
    if (e instanceof UnresolvableValue) {
      return this.finish("failure", "SCHEMA_INVALID", {
        expected: "every value reference to resolve against the supplied parameters",
        observed: e.detail,
      });
    }
    if (e instanceof LoadError) {
      // A load outside the bounded-reload paths, such as returning to a page
      // after a re-login.
      return this.finish("failure", "LOAD_FAILED", {
        expected: "the page to load",
        observed: e.category,
      });
    }
    // Anything else is a defect in TracePilot rather than in the run. It still
    // ends in a result: a crash would lose the record of everything before it.
    // Only the error's name is kept; its message may carry URLs or values.
    const name = e instanceof Error ? e.name : "unknown";
    this.o.store.event({
      type: "replay_crashed",
      actor: "SYSTEM",
      observed: name,
    });
    return this.finish("failure", "INTERNAL_ERROR", {
      expected: "the run to reach a result",
      observed: name,
    });
  }

  /**
   * Hands control to a person, and takes it back on their answer. Returns the
   * run's result when they end it, or the position in `steps` to continue from
   * -- a position, not `step.index`, which an artifact may number from 1:
   *
   *   step_done      they performed this step; continue with the next
   *   resume, retry  run this step again from the state they left
   *   complete       they finished the workflow; verify and extract
   *   abort          stop
   *
   * Continuing goes through runStep, so the step's preconditions are
   * re-verified against whatever the person left -- control never returns on
   * the strength of their say-so alone.
   */
  private async handOff(e: Escalate): Promise<ExecutionResult | number> {
    const handled = await this.o.operator.handle({
      kind: "replay_unrecoverable",
      subject: {
        capabilityId: this.o.capability.capabilityId,
        version: this.o.capability.version,
        goalSummary: `replay ${this.o.capability.capabilityId}`,
      },
      step: {
        stepId: e.step.stepId,
        index: e.step.index,
        action: e.step.action,
        targetSummary: e.step.target ? summarize(e.step.target) : e.step.action,
      },
      expected: e.expected,
      observed: e.observed,
      reason: e.reason,
      reasonCode: e.reasonCode,
    });
    this.lastInterventionId = handled.request.interventionId;

    if (handled.response === "abort") {
      return this.finish(
        "aborted",
        this.o.interactive ? "OPERATOR_ABORTED" : e.reasonCode,
        {
          step: e.step,
          expected: e.expected,
          observed: e.observed,
        },
        handled.request.interventionId,
      );
    }

    if (handled.response === "complete") {
      // The human finished the workflow by hand: verify and extract, rather
      // than replaying steps whose effects have already happened.
      this.o.store.event({
        type: "human_completed_workflow",
        actor: "HUMAN",
        stepId: e.step.stepId,
        reason: "operator completed the remaining steps manually",
      });
      try {
        await this.extractAfterManualCompletion();
        await this.collectOutputs();
        return this.finish("success", "OK", {}, handled.request.interventionId);
      } catch (inner) {
        return this.handleThrow(inner);
      }
    }

    if (handled.response === "step_done") {
      // A write the person made by hand is still a write: recovery must not
      // rewind past it afterwards.
      if (e.step.effect === "consequential") this.consequentialDone = true;
      this.o.store.event({
        type: "resumed_after_handoff",
        actor: "AGENT",
        stepId: e.step.stepId,
        reason: "the operator performed this step; continuing with the next",
      });
      return this.positionOf(e.step) + 1;
    }

    this.o.store.event({
      type: "resumed_after_handoff",
      actor: "AGENT",
      stepId: e.step.stepId,
      reason: `operator chose ${handled.response}; re-running this step from the state they left`,
    });
    return this.positionOf(e.step);
  }

  private positionOf(step: Step): number {
    return this.o.capability.steps.findIndex((s) => s.stepId === step.stepId);
  }

  /** After a manual completion, re-read every declared output from the page. */
  private async extractAfterManualCompletion(): Promise<void> {
    for (const [name, spec] of Object.entries(this.o.capability.outputs)) {
      if (this.outputs[name] !== undefined) continue;
      const step = this.o.capability.steps.find((s) => s.extractAs === name);
      if (!step?.target) continue;
      const text = await this.o.surface.textOf(step.target);
      if (text === null) continue;
      const match = spec.source.extract.regex
        ? (text.match(new RegExp(spec.source.extract.regex)) ?? [])[0]
        : text;
      if (match !== undefined) this.outputs[name] = match;
    }
  }

  private pause(e: Escalate, why: string): ExecutionResult {
    const interventionId = this.lastInterventionId ?? "(none)";
    this.o.store.event({
      type: "run_paused",
      actor: "SYSTEM",
      stepId: e.step.stepId,
      reasonCode: "AWAITING_HUMAN",
      reason: why,
    });
    return this.assemble({
      lifecycle: "awaiting_human",
      outcome: null,
      reasonCode: "AWAITING_HUMAN",
      intervention: { interventionId, checkpoint: e.step.stepId },
    });
  }

  private finish(
    outcome: NonNullable<ExecutionResult["outcome"]>,
    reasonCode: ReasonCode,
    detail: Terminal["detail"] = {},
    interventionId?: string,
  ): ExecutionResult {
    return this.assemble({
      lifecycle: "completed",
      outcome,
      reasonCode,
      ...(outcome === "success" ? { outputs: this.outputs } : {}),
      ...(detail.business ? { businessOutcome: detail.business } : {}),
      ...(outcome === "failure" && detail.step
        ? {
            failure: {
              stepId: detail.step.stepId,
              stepIndex: detail.step.index,
              expected: redact(detail.expected ?? ""),
              observed: redact(detail.observed ?? ""),
              evidence: detail.evidence ?? [],
            },
          }
        : {}),
      ...(outcome === "failure" && !detail.step
        ? {
            failure: {
              stepId: RUN_LEVEL,
              stepIndex: -1,
              expected: redact(detail.expected ?? ""),
              observed: redact(detail.observed ?? ""),
              evidence: detail.evidence ?? [],
            },
          }
        : {}),
      ...(detail.safety ? { safety: detail.safety } : {}),
      ...(interventionId && detail.step
        ? { intervention: { interventionId, checkpoint: detail.step.stepId } }
        : {}),
    });
  }

  private assemble(head: Partial<ExecutionResult> & { lifecycle: ExecutionResult["lifecycle"] }): ExecutionResult {
    const total = Math.max(1, this.o.capability.steps.length);
    const result = ResultSchema.parse({
      schemaVersion: "1.0.0",
      runId: this.o.store.runId,
      kind: "replay",
      capabilityId: this.o.capability.capabilityId,
      capabilityVersion: this.o.capability.version,
      recoveries: this.recoveries,
      drift: {
        stepsResolvedBelowRank1: this.driftSteps,
        fingerprintMismatches: [...this.fingerprintMismatches],
        score: Number((new Set([...this.driftSteps, ...this.fingerprintMismatches]).size / total).toFixed(3)),
      },
      budgets: this.o.budgets.snapshot(),
      control: this.o.control.transitions,
      approvals: this.approvals,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      evidenceDir: this.o.store.dir,
      ...head,
    });
    this.o.store.document("result.json", result);
    this.o.store.event({
      type: "replay_finished",
      actor: "SYSTEM",
      outcome: result.outcome ?? result.lifecycle,
      reasonCode: result.reasonCode,
      budgets: result.budgets,
    });
    return result;
  }
}
