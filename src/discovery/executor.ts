import { createHash } from "node:crypto";
import type {
  Check,
  DiscoveryTrace,
  ExecutionResult,
  Policy,
  ReasonCode,
  TaskContract,
  TraceStep,
  ValueRef,
} from "../contracts/index.js";
import {
  DiscoveryTrace as TraceSchema,
  TraceStep as TraceStepSchema,
  ExecutionResult as ResultSchema,
  Check as CheckSchema,
} from "../contracts/index.js";
import { SafetyViolation, checkAction, classifyEffect, redact } from "../safety/index.js";
import {
  describe as describeEl,
  fingerprint,
  MIN_TAGGED_VALUE_LENGTH,
  summarize,
  tagInputs,
  type ObservedElement,
  type Observation,
  type Surface,
} from "../browser/index.js";
import type { BudgetLedger, RunStore } from "../observability/index.js";
import { HumanRecorder, type ControlLedger, type OperatorConsole } from "../handoff/index.js";
import { evaluateCheck, type ApprovalMode, type ResolveContext } from "../workflow/index.js";
import { buildModelPayload, imageOmission, type ModelPayload } from "./payload.js";
import { renderObservation, systemPrompt, type LedgerEntry } from "./prompt.js";
import { RawAction, allowedActions, validateAction, type ActionName } from "./actions.js";
import type { ModelClient } from "./model.js";

export type DiscoveryOptions = {
  task: TaskContract;
  surface: Surface;
  store: RunStore;
  control: ControlLedger;
  operator: OperatorConsole;
  budgets: BudgetLedger;
  model: ModelClient;
  ctx: ResolveContext;
  policy: Policy;
  baseUrl: string;
  /**
   * Who authorises a durable write. Interactive asks at the moment of the
   * write; pre-approved records an authorisation given in advance, which is
   * what an unattended run needs. The diff and digest are built identically
   * either way -- only the asking differs.
   */
  approval: ApprovalMode;
  /** False in CI and tests: escalations use the same path but stay terminal. */
  interactive: boolean;
};

class Terminal extends Error {
  constructor(
    readonly outcome: NonNullable<ExecutionResult["outcome"]>,
    readonly reasonCode: ReasonCode,
    readonly detail: {
      seq?: number;
      expected?: string;
      observed?: string;
      evidence?: string[];
      safety?: { rule: string; attempted: string };
      business?: { code: string; matchedCheck: Check };
    } = {},
  ) {
    super(reasonCode);
  }
}

/**
 * Raised when the loop cannot honestly continue on its own. Unlike Terminal it
 * is an invitation, not a verdict: the operator may hand control back, finish
 * the step themselves, or stop the run.
 */
class Escalate extends Error {
  constructor(
    readonly reasonCode: ReasonCode,
    readonly expected: string,
    readonly observed: string,
    readonly reason: string,
  ) {
    super(reasonCode);
  }
}

/** What the loop does next, after one proposal has been dealt with. */
type Turn =
  | { kind: "continue" }
  /** The proposal was refused; the text goes back to the model with the next payload. */
  | { kind: "reject"; reason: string };

/**
 * The discovery loop.
 *
 * One model call decides one action. Everything between the decision and the
 * browser is mechanical: the action is validated against the contract and the
 * observation it was decided from, the policy is applied, a durable write is
 * gated on a recorded approval, and only then does anything execute. What
 * comes back is recorded as it actually happened -- not as it was intended --
 * and the page is observed again before the next decision.
 *
 * The model is never asked to reason about a safety condition. An undeclared
 * dialog, a permission refusal or a payload that failed redaction leaves the
 * loop entirely rather than becoming another turn.
 */
export class DiscoveryExecutor {
  private readonly startedAt = new Date().toISOString();
  private readonly ledger: LedgerEntry[] = [];
  private readonly steps: TraceStep[] = [];
  private readonly outputs: Record<string, string> = {};
  private readonly approvals: ExecutionResult["approvals"] = [];
  private readonly businessOutcomes: { code: string; when: Check }[] = [];
  private readonly belowRank1: string[] = [];
  private resolvedSteps = 0;

  /** Fills performed since the last approval, and what each field held before. */
  private pendingFills: { label: string; from: string; inputName: string }[] = [];
  /** Set by an approval, consumed by the one consequential action it authorises. */
  private approvedDigest: string | null = null;
  private sawConsequential = false;
  /**
   * What the last write changed: the inputs filled before it, less any that
   * appear in the URL it was made from -- those identify the record (the
   * member id in /members/M-1002/review), they are not what was written.
   */
  private writtenInputs: string[] = [];
  /** Where the last write left the page. The record is read back elsewhere. */
  private writeLanding: string | null = null;
  /** Set once the last write's values have been asserted on another page. */
  private readBack = false;

  private obs: Observation | null = null;
  private note: string | null = null;
  private consecutiveRejections = 0;
  private relogins = 0;
  private seq = 0;
  private lastRaw: RawAction | null = null;
  private humanAuthored = 0;

  constructor(private readonly o: DiscoveryOptions) {}

  private get allowed(): ActionName[] {
    return allowedActions(this.o.policy);
  }

  private get inputNames(): string[] {
    return Object.keys(this.o.ctx.inputs);
  }

  /** See ValidationContext.untaggedInputs. */
  private get untaggedInputs(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.o.ctx.inputs).filter(([, v]) => v && v.length < MIN_TAGGED_VALUE_LENGTH),
    );
  }

  private get outputPatterns(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.o.task.outputs).flatMap(([name, spec]) => {
        const pattern = (spec as { pattern?: string }).pattern;
        return pattern ? [[name, pattern]] : [];
      }),
    );
  }

  private get outputNames(): string[] {
    return Object.keys(this.o.task.outputs);
  }

  private stepId(seq: number): string {
    return `s${String(seq).padStart(2, "0")}`;
  }

  // --- the loop -----------------------------------------------------------

  async run(): Promise<ExecutionResult> {
    const { surface, store, control, task } = this.o;
    control.transfer("AGENT", "discovery started");
    store.event({
      type: "discovery_started",
      actor: "AGENT",
      reason: `${task.taskId} with ${this.o.model.name}`,
    });

    try {
      if (task.requires.session) {
        const ok = await surface.ensureSession(
          this.absolute("/login"),
          task.requires.session.credentialRef,
        );
        store.event({ type: "session_established", actor: "AGENT", outcome: ok ? "ok" : "failed" });
        if (!ok) {
          throw new Terminal("failure", "SESSION_EXPIRED_UNRECOVERED", {
            expected: "an authenticated session before the first decision",
            observed: "the login form was still present after signing in",
          });
        }
      }

      await surface.navigate(this.absolute(new URL(task.targetUrl).pathname));
      await this.reobserve();
    } catch (e) {
      return this.handleThrow(e);
    }
    return this.loop();
  }

  /**
   * Turns until something stops the run.
   *
   * An escalation is handled here rather than ending the invocation. Replay
   * pauses instead, because it has a fixed step list whose preconditions must
   * be re-verified by a fresh invocation before it may act again; discovery
   * has no such list -- it re-observes and asks the model, which is what it
   * would do on any other turn. The operator's response decides whether this
   * returns or the loop carries on.
   */
  private async loop(): Promise<ExecutionResult> {
    let correction: string | undefined;
    for (;;) {
      try {
        const exhausted = this.o.budgets.exhausted();
        if (exhausted) {
          throw new Terminal("aborted", exhausted, {
            expected: "to reach the goal within budget",
            observed: `budget exhausted after ${this.steps.length} recorded steps`,
          });
        }
        const turn = await this.turn(correction);
        correction = turn.kind === "reject" ? turn.reason : undefined;
      } catch (e) {
        if (!(e instanceof Escalate)) return this.handleThrow(e);
        const finished = await this.escalate(e).catch((inner: unknown) => this.handleThrow(inner));
        if (finished) return finished;
        correction = undefined;
      }
    }
  }

  /** One decision: observe -> propose -> validate -> enforce -> execute -> record. */
  private async turn(correction?: string): Promise<Turn> {
    const payload = await this.payload();
    const proposal = await this.o.model.propose({
      system: systemPrompt(this.o.task, this.inputNames, this.outputNames, this.allowed),
      payload,
      ledger: this.ledger,
      ...(correction ? { correction } : {}),
    });

    if (!proposal.ok && proposal.kind === "transport") {
      // No decision was made, so nothing is charged to the decision budget.
      this.o.store.event({
        type: "model_call_failed",
        actor: "SYSTEM",
        reason: `transport: ${proposal.detail}`,
      });
      throw new Escalate(
        "DEAD_END",
        "a reachable model",
        proposal.detail,
        "the model could not be reached after bounded retries",
      );
    }

    // Everything below is the model having decided something, well or badly.
    this.o.budgets.modelCalls += 1;

    if (!proposal.ok) {
      return this.refuse(`the act tool was not used correctly (${proposal.detail})`, "protocol");
    }

    const raw = proposal.raw;
    const rejection = validateAction(raw, {
      observation: this.obs,
      inputNames: this.inputNames,
      outputNames: this.outputNames,
      untaggedInputs: this.untaggedInputs,
      outputPatterns: this.outputPatterns,
      boundOutputs: this.outputs,
    });
    if (rejection) return this.refuse(rejection.reason, this.describeProposal(raw));

    // Defence in depth. The grammar already excludes what policy withholds, so
    // reaching here means something bypassed the tool schema -- which is a
    // policy event, not a typo, and ends the run.
    const verdict = checkAction(this.o.policy, raw.action);
    if (!verdict.ok) throw new SafetyViolation(verdict.rule, verdict.attempted);

    this.lastRaw = raw;
    return this.dispatch(raw);
  }

  /**
   * A refusal costs one model call and is fed back verbatim. A run that cannot
   * produce a usable action several times running is stuck, and saying so is
   * more honest than grinding the remaining budget into identical rejections
   * and reporting exhaustion.
   */
  private refuse(reason: string, proposed: string): Turn {
    this.consecutiveRejections += 1;
    this.ledger.push({
      seq: this.ledger.length + 1,
      proposed,
      result: `REJECTED: ${reason}`,
    });
    this.o.store.event({
      type: "action_rejected",
      actor: "SYSTEM",
      action: proposed,
      reason: redact(reason),
    });
    if (this.consecutiveRejections >= this.o.policy.budgets.consecutiveRejections) {
      throw new Escalate(
        "DEAD_END",
        "a valid next action",
        `${this.consecutiveRejections} consecutive refused proposals`,
        `the last refusal was: ${reason}`,
      );
    }
    return { kind: "reject", reason };
  }

  private accept(proposed: string, result: string): Turn {
    this.consecutiveRejections = 0;
    this.ledger.push({ seq: this.ledger.length + 1, proposed, result });
    this.note = result;
    return { kind: "continue" };
  }

  // --- payload ------------------------------------------------------------

  /**
   * The only bytes that reach a model. A payload that fails redaction is not
   * sent: one observation is retried, in case the page was mid-render, and a
   * second failure ends the run. Blocking costs a turn; shipping a leak cannot
   * be undone.
   */
  private async payload(): Promise<Extract<ModelPayload, { blocked: false }>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.obs) await this.reobserve();
      const shot = await this.o.surface.screenshot();
      const omitted = imageOmission(shot);
      if (omitted) {
        this.o.store.event({
          type: "evidence_omitted",
          actor: "SYSTEM",
          omittedReason: omitted,
          reason: "the payload carries no image; a safe masked capture could not be established",
        });
      }
      const built = buildModelPayload({
        observation: this.obs!,
        screenshot: shot,
        inputs: this.o.ctx.inputs,
        policy: this.o.policy,
        ...(this.note ? { note: this.note } : {}),
      });
      if (!built.blocked) return built;

      this.o.store.event({
        type: "payload_blocked",
        actor: "SYSTEM",
        reason: built.reason,
        url: this.obs?.url,
      });
      if (attempt === 0) {
        await this.o.surface.settle();
        await this.reobserve();
        continue;
      }
      throw new Terminal("safety_violation", "PAYLOAD_BLOCKED", {
        expected: "an observation that survives redaction",
        observed: built.reason,
        safety: { rule: "model_payload_redaction", attempted: built.reason },
      });
    }
    /* c8 ignore next */
    throw new Error("unreachable");
  }

  private async reobserve(opts: { regionId?: string; offset?: number } = {}): Promise<void> {
    this.o.budgets.observations += 1;
    this.obs = await this.o.surface.observe(opts);
    if (!this.obs.selfCheck.ok) {
      this.o.store.event({
        type: "observation_self_check_failed",
        actor: "SYSTEM",
        reason: this.obs.selfCheck.reason ?? "unknown",
      });
    }
  }

  // --- dispatch -----------------------------------------------------------

  private async dispatch(raw: RawAction): Promise<Turn> {
    const proposed = this.describeProposal(raw);
    switch (raw.action) {
      case "observe":
        return this.doObserve(raw, proposed);
      case "navigate":
        return this.doNavigate(raw, proposed);
      case "click":
      case "press":
        return this.doAct(raw, proposed);
      case "fill":
        return this.doFill(raw, proposed);
      case "assert":
        return this.doAssert(raw, proposed);
      case "extract":
        return this.doExtract(raw, proposed);
      case "request_approval":
        return this.doApproval(raw, proposed);
      case "business_outcome":
        return this.doBusinessOutcome(raw, proposed);
      case "done":
        return this.doDone(raw, proposed);
      case "give_up":
        throw new Escalate(
          "DEAD_END",
          "a route to the goal",
          "the agent reported it is stuck",
          raw.reason,
        );
      /* c8 ignore next 2 */
      default:
        return this.refuse(`unsupported action "${raw.action}"`, proposed);
    }
  }

  private async doObserve(raw: RawAction, proposed: string): Promise<Turn> {
    const offset = raw.nextBatch && this.obs ? this.obs.offset + this.obs.returned : undefined;
    await this.reobserve({
      ...(raw.regionId ? { regionId: raw.regionId } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
    const o = this.obs!;
    return this.accept(proposed, `ok, ${o.returned} of ${o.totalEligible} elements`);
  }

  private async doNavigate(raw: RawAction, proposed: string): Promise<Turn> {
    // A URL carrying something this run was issued (a confirmation id) can
    // only be typed by this run. Replay will never know it, so the step could
    // not compile -- and the usual reason for it is re-reading an output that
    // is already bound.
    const issued = Object.entries(this.outputs).filter(([, v]) => v && raw.url!.includes(v));
    if (issued.length) {
      return this.refuse(
        `that URL contains the value of output ${issued.map(([n]) => `"${n}"`).join(", ")}, which a replay cannot know. ` +
          "It is already bound; there is no need to go back for it. Navigate by clicking links instead.",
        proposed,
      );
    }
    this.o.budgets.actionSteps += 1;
    const url = this.absolute(raw.url!);
    const res = await this.o.surface.navigate(url);
    if (res.status === 403) {
      throw new Escalate(
        "PERMISSION_DENIED",
        "an authorised page load",
        `HTTP 403 at ${raw.url}`,
        "the operator role is not permitted to reach this page",
      );
    }
    if (res.status === 401 || (await this.o.surface.sessionExpired())) {
      const recovered = await this.recoverSession();
      if (!recovered) {
        throw new Escalate(
          "SESSION_EXPIRED_UNRECOVERED",
          "an authenticated session",
          "the application returned to the login form",
          "the session expired and could not be re-established within policy",
        );
      }
      return this.accept(proposed, "session had expired; signed in again, try that step again");
    }
    if (res.status !== null && res.status >= 400) {
      // A bad path is information the agent can act on, not a defect: it may
      // simply have guessed a route that does not exist.
      await this.reobserve();
      return this.accept(proposed, `failed: HTTP ${res.status}`);
    }
    this.record({ action: "navigate", reason: raw.reason, effect: "reversible" });
    await this.afterAction();
    return this.accept(proposed, `ok, now at ${this.pathOf(this.obs!.url)}`);
  }

  private async doAct(raw: RawAction, proposed: string): Promise<Turn> {
    const el = this.element(raw.targetId!);
    const effect = classifyEffect(this.o.policy, el.submitTarget);

    if (effect === "consequential") {
      // The gate is mechanical. It holds whether or not the model remembered
      // rule 5, which is the whole point of classifying from the page rather
      // than from the proposal.
      if (!this.approvedDigest) {
        return this.refuse(
          `that control submits to ${el.submitTarget?.pathname}, which writes a durable change. ` +
            "Call request_approval first so a person can authorise exactly what will be written.",
          proposed,
        );
      }
      this.o.store.event({
        type: "consequential_action_authorised",
        actor: "SYSTEM",
        stepId: this.stepId(this.seq + 1),
        targetSummary: el.submitTarget?.pathname,
        reason: `cleared by approval ${this.approvedDigest}`,
      });
    }

    const descriptor = describeEl(el, raw.anchorInput ? { anchorInput: raw.anchorInput } : {});
    const from = this.taggedUrl();
    this.o.budgets.actionSteps += 1;
    const res = await this.o.surface.act(raw.action === "press" ? "press" : "click", descriptor);
    if (!res.ok) {
      await this.afterAction();
      return this.accept(proposed, `failed: ${res.detail}`);
    }

    if (effect === "consequential") {
      this.approvedDigest = null;
      this.sawConsequential = true;
      this.writtenInputs = [...new Set(this.pendingFills.map((f) => f.inputName))].filter(
        (name) => !from.includes(`<input:${name}>`),
      );
      this.readBack = false;
      this.pendingFills = [];
    }
    this.record({
      action: raw.action === "press" ? "press" : "click",
      reason: raw.reason,
      target: descriptor,
      effect,
      resolved: res,
    });
    await this.afterAction();
    if (effect === "consequential") this.writeLanding = this.pathOf(this.obs!.url);
    return this.accept(proposed, `ok, now at ${this.pathOf(this.obs!.url)}`);
  }

  private async doFill(raw: RawAction, proposed: string): Promise<Turn> {
    const el = this.element(raw.targetId!);
    const descriptor = describeEl(el, raw.anchorInput ? { anchorInput: raw.anchorInput } : {});
    const value = this.o.ctx.inputs[raw.inputName!];
    if (value === undefined) {
      /* c8 ignore next 2 -- validateAction has already checked the name */
      return this.refuse(`no value supplied for input "${raw.inputName}"`, proposed);
    }

    // The prior contents are read now, before they are overwritten. By the
    // time an approval is requested the old value is gone from the page, and
    // an approval that cannot show what is being replaced is not a diff.
    let before = "";
    const located = await this.o.surface.locate(descriptor);
    if (located.ok) before = await located.locator.inputValue().catch(() => "");

    this.o.budgets.actionSteps += 1;
    const res = await this.o.surface.act("fill", descriptor, value);
    if (!res.ok) {
      await this.afterAction();
      return this.accept(proposed, `failed: ${res.detail}`);
    }

    this.pendingFills.push({ label: summarize(descriptor), from: before, inputName: raw.inputName! });
    this.record({
      action: "fill",
      reason: raw.reason,
      target: descriptor,
      value: { input: raw.inputName! },
      effect: "reversible",
      resolved: res,
    });
    await this.afterAction();
    return this.accept(proposed, "ok");
  }

  /**
   * An assertion is verified before it is recorded. A check that does not hold
   * on the page that authored it would compile into a capability that fails on
   * its first replay against an application that did nothing wrong.
   */
  private async doAssert(raw: RawAction, proposed: string): Promise<Turn> {
    const check = this.buildCheck(raw);
    const outcome = await evaluateCheck(this.o.surface, check, this.o.ctx).catch((e: unknown) => ({
      ok: false,
      expected: "a well-formed assertion",
      observed: e instanceof Error ? e.message : "unknown error",
    }));
    if (!outcome.ok) {
      return this.refuse(
        `that assertion does not hold here. Expected ${outcome.expected}; observed ${outcome.observed}` +
          (await this.textHint(check)),
        proposed,
      );
    }
    this.record({ action: "assert", reason: raw.reason, effect: "reversible", checks: [check] });
    if (this.sawConsequential && this.isReadBack(check)) this.readBack = true;
    return this.accept(proposed, `ok, verified: ${outcome.expected}`);
  }

  /**
   * Whether an assertion reads the last write back from the record: it is
   * made somewhere other than where the write landed, and it checks a value
   * that was written. A write that filled nothing (a delete, say) has no
   * value to read back, so any later check on another page has to do.
   */
  private isReadBack(check: Check): boolean {
    if (this.pathOf(this.o.surface.currentUrl()) === this.writeLanding) return false;
    if (this.writtenInputs.length === 0) return true;
    const v = check.value;
    const refs =
      v && "input" in v
        ? [v.input]
        : v && "transform" in v && v.transform.op === "template"
          ? [...(v.transform.format ?? "").matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!)
          : [];
    return refs.some((r) => this.writtenInputs.includes(r));
  }

  /**
   * A refused text check on a target says only that the target is wrong, which
   * a model tends to answer by proposing the same target again. Checking the
   * whole page as well turns the refusal into a direction: the text is
   * elsewhere, or it is not on this page at all.
   */
  private async textHint(check: Check): Promise<string> {
    if (check.kind !== "text_contains" && check.kind !== "text_equals") return "";
    const { target: _, ...rest } = check;
    const onPage = (value: Check["value"]) =>
      evaluateCheck(this.o.surface, { ...rest, kind: "text_contains", value }, this.o.ctx)
        .then((r) => r.ok)
        .catch(() => false);

    if (check.target && (await onPage(check.value))) {
      return ". The expected text IS on this page, just not inside that element: omit targetId to check the whole page, or target the element that actually holds it.";
    }
    // A composed value can be absent while every part of it is present: a
    // record page that shows the street and the city line in separate rows.
    // Said plainly, that is one correction; unsaid, the model retries the
    // same arrangement until the loop calls it a dead end.
    const v = check.value;
    if (v && "transform" in v && v.transform.op === "template") {
      const names = [...(v.transform.format ?? "").matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
      const each = await Promise.all(names.map((input) => onPage({ input })));
      if (names.length > 1 && each.every(Boolean)) {
        return `. Every value in that template IS on this page, just not arranged that way: assert them separately with assertInput, or compose only values the page shows together.`;
      }
    }
    return check.target ? ". The expected text is not anywhere on the visible page either." : "";
  }


  private async doExtract(raw: RawAction, proposed: string): Promise<Turn> {
    const name = raw.outputName!;
    if (this.outputs[name] !== undefined) {
      // Live runs spent many turns travelling back to re-read a value they
      // held. Bound is bound; say so before any of that happens.
      return this.refuse(`"${name}" is already bound. Do not extract it again; carry on with the goal.`, proposed);
    }
    const el = this.element(raw.targetId!);
    const descriptor = describeEl(el, raw.anchorInput ? { anchorInput: raw.anchorInput } : {});
    const text = await this.o.surface.textOf(descriptor);
    if (text === null) {
      return this.refuse(`${summarize(descriptor)} did not resolve, so nothing could be read`, proposed);
    }

    const spec = this.o.task.outputs[name] as { pattern?: string } | undefined;
    const pattern = spec?.pattern;
    let value = text;
    if (pattern) {
      const found = text.match(new RegExp(pattern));
      if (!found) {
        // A wrong element is a recoverable authoring mistake, and one refusal
        // is cheaper than ending a run that still has budget to correct itself.
        return this.refuse(
          `that element reads "${text.slice(0, 60)}", which is not a ${name} (expected /${pattern}/). ` +
            "Pick the element that carries the value itself.",
          proposed,
        );
      }
      value = found[0];
    }

    this.outputs[name] = value;
    this.record({
      action: "extract",
      reason: raw.reason,
      target: descriptor,
      effect: "reversible",
      extractAs: name,
      ...(pattern ? { extractRegex: pattern } : {}),
    });
    return this.accept(proposed, `ok, ${name} bound`);
  }

  /**
   * The approval gate. The diff is built from what the loop actually typed,
   * not from what the model says it typed -- an approval that restates the
   * agent's own claim checks nothing.
   */
  private async doApproval(raw: RawAction, proposed: string): Promise<Turn> {
    if (this.pendingFills.length === 0) {
      return this.refuse(
        "there is nothing to approve: no field has been changed since the last approval",
        proposed,
      );
    }
    const fields = this.pendingFills.map((f) => ({
      label: f.label,
      from: f.from || "(empty)",
      to: this.o.ctx.inputs[f.inputName] ?? "",
    }));
    const digest =
      "sha256:" + createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16);

    // A pre-approval authorises the one write the operator expected, not every
    // write the run attempts. A second goes to a person like any other -- and
    // with nobody at the console, it is declined.
    const standing = this.o.approval.mode === "pre_approved" && !this.approvals.some((a) => a.mode === "pre_approved");
    if (standing && this.o.approval.mode === "pre_approved") {
      this.approvedDigest = digest;
      this.approvals.push({
        stepId: this.stepId(this.seq + 1),
        mode: "pre_approved",
        approvedBy: this.o.approval.approvedBy,
        at: this.o.approval.at,
        diffDigest: digest,
      });
      this.o.store.event({
        type: "approval_recorded",
        actor: "SYSTEM",
        stepId: this.stepId(this.seq + 1),
        outcome: "pre_approved",
        reason: `authorised by ${this.o.approval.approvedBy} at ${this.o.approval.at}`,
      });
      this.recordGate(raw, digest);
      return this.accept(proposed, "pre-approved for this run");
    }

    const handled = await this.o.operator.handle({
      kind: "approval_required",
      subject: { taskId: this.o.task.taskId, goalSummary: this.o.task.goal.slice(0, 300) },
      step: {
        stepId: this.stepId(this.seq + 1),
        index: this.seq,
        action: "approval_gate",
        targetSummary: "consequential change pending",
      },
      expected: "operator approval before a consequential change",
      observed: "awaiting approval",
      reason: raw.reason,
      reasonCode: "OK",
      pendingChange: { fields, digest },
      allowedResponses: ["resume", "abort"],
    });

    if (handled.response !== "resume") {
      throw new Terminal("aborted", "APPROVAL_DECLINED", {
        expected: "operator approval",
        observed: `operator chose "${handled.response}"`,
      });
    }

    this.approvedDigest = digest;
    this.approvals.push({
      stepId: this.stepId(this.seq + 1),
      mode: "interactive",
      approvedBy: "operator",
      at: new Date().toISOString(),
      diffDigest: digest,
    });
    this.recordGate(raw, digest);
    await this.afterAction();
    return this.accept(proposed, "approved by the operator");
  }

  /** The gate as a step, so a compiled capability carries it too. */
  private recordGate(raw: RawAction, digest: string): void {
    this.record({
      action: "approval_gate",
      reason: raw.reason,
      effect: "reversible",
      diffFields: this.pendingFills.map((f) => ({
        label: f.label,
        value: { input: f.inputName } as ValueRef,
      })),
      diffDigest: digest,
    });
  }

  private async doBusinessOutcome(raw: RawAction, proposed: string): Promise<Turn> {
    const check = this.buildCheck(raw);
    const outcome = await evaluateCheck(this.o.surface, check, this.o.ctx).catch((e: unknown) => ({
      ok: false,
      expected: "a well-formed recognizer",
      observed: e instanceof Error ? e.message : "unknown error",
    }));
    if (!outcome.ok) {
      // The most attractive exit a stuck agent has is to relabel its own
      // failure as the application saying no. It must show its work.
      return this.refuse(
        `that recognizer does not hold, so this is not a business outcome. ` +
          `Expected ${outcome.expected}; observed ${outcome.observed}`,
        proposed,
      );
    }
    this.businessOutcomes.push({ code: raw.outcomeCode!, when: check });
    throw new Terminal("business_outcome", "BUSINESS_OUTCOME", {
      business: { code: raw.outcomeCode!, matchedCheck: check },
      expected: "the workflow to complete",
      observed: `the application returned ${raw.outcomeCode}`,
    });
  }

  private doDone(raw: RawAction, proposed: string): Turn {
    const missing = this.outputNames.filter((n) => this.outputs[n] === undefined);
    if (missing.length) {
      return this.refuse(
        `cannot finish: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not bound. ` +
          "Use extract on the element that carries the value.",
        proposed,
      );
    }
    if (this.sawConsequential && !this.readBack) {
      return this.refuse(
        "cannot finish: the change has not been read back. A confirmation says the application " +
          "accepted it, not that it was stored. Open the record that was changed and assert the new " +
          `values there, referencing ${this.writtenInputs.map((n) => `{${n}}`).join(", ") || "the inputs"}. ` +
          "Values the page shows in separate places need separate assertions.",
        proposed,
      );
    }
    throw new Terminal("success", "OK", { observed: raw.reason });
  }

  // --- after every browser action -----------------------------------------

  /**
   * An undeclared dialog and an expired session are conditions, not decisions:
   * neither is handed back to the model to reason about.
   */
  private async afterAction(): Promise<void> {
    const dialogs = this.o.surface.drainUndeclaredDialogs();
    if (dialogs.length) {
      throw new Escalate(
        "UNEXPECTED_DIALOG",
        "no dialog, or one the run had declared",
        `the page raised: "${dialogs.map((d) => d.message).join(" | ").slice(0, 200)}"`,
        "an undeclared dialog was dismissed; the pending operation may not have completed",
      );
    }
    if (await this.o.surface.sessionExpired()) {
      const recovered = await this.recoverSession();
      if (!recovered) {
        throw new Escalate(
          "SESSION_EXPIRED_UNRECOVERED",
          "an authenticated session",
          "the application returned to the login form",
          "the session expired and could not be re-established within policy",
        );
      }
    }
    await this.reobserve();
  }

  private async recoverSession(): Promise<boolean> {
    const session = this.o.task.requires.session;
    if (!session || this.relogins >= this.o.policy.recovery.relogins) return false;
    this.relogins += 1;
    const ok = await this.o.surface.ensureSession(this.absolute("/login"), session.credentialRef);
    this.o.store.event({
      type: "session_recovered",
      actor: "AGENT",
      outcome: ok ? "ok" : "failed",
      reason: `re-login ${this.relogins} of ${this.o.policy.recovery.relogins}`,
    });
    if (ok) await this.reobserve();
    return ok;
  }

  // --- recording ----------------------------------------------------------

  private record(step: {
    action: TraceStep["action"];
    reason: string;
    effect: TraceStep["effect"];
    target?: TraceStep["target"];
    value?: ValueRef;
    checks?: Check[];
    extractAs?: string;
    extractRegex?: string;
    diffFields?: { label: string; value: ValueRef }[];
    diffDigest?: string;
    resolved?: { rank: number; strategy: string };
    authoredBy?: "agent" | "human";
    unresolved?: boolean;
    /** Where the step left the page, when that is not where the page is now. */
    url?: string;
  }): void {
    this.seq += 1;
    const id = this.stepId(this.seq);
    if (step.resolved) {
      this.resolvedSteps += 1;
      // A descriptor that needed a lower rung on the very run that authored it
      // is fragile before it has ever been replayed, which is worth seeing at
      // review time rather than on its first failure.
      if (step.resolved.rank > 1) this.belowRank1.push(id);
    }
    this.steps.push(
      TraceStepShape({
        seq: this.seq,
        action: step.action,
        reason: redact(step.reason).slice(0, 200),
        url: step.url !== undefined ? tagInputs(step.url, this.o.ctx.inputs) : this.taggedUrl(),
        ...(step.target ? { target: step.target } : {}),
        ...(step.value ? { value: step.value } : {}),
        effect: step.effect,
        checks: step.checks ?? [],
        ...(step.extractAs ? { extractAs: step.extractAs } : {}),
        ...(step.extractRegex ? { extractRegex: step.extractRegex } : {}),
        ...(step.diffFields ? { diffFields: step.diffFields } : {}),
        ...(step.diffDigest ? { diffDigest: step.diffDigest } : {}),
        ...(step.resolved
          ? { resolvedRank: step.resolved.rank, resolvedStrategy: step.resolved.strategy }
          : {}),
        ...(step.target ? { surfaceFingerprint: fingerprint(step.target) } : {}),
        authoredBy: step.authoredBy ?? "agent",
        unresolved: step.unresolved ?? false,
        at: new Date().toISOString(),
      }),
    );
    if ((step.authoredBy ?? "agent") === "human") this.humanAuthored += 1;

    this.o.store.event({
      type: "step_recorded",
      actor: step.authoredBy === "human" ? "HUMAN" : "AGENT",
      stepId: id,
      stepIndex: this.seq - 1,
      action: step.action,
      targetSummary: step.target ? summarize(step.target) : undefined,
      valueRef: step.value ? describeValueRef(step.value) : undefined,
      reason: step.reason,
      url: this.taggedUrl(),
      resolvedRank: step.resolved?.rank,
      resolvedStrategy: step.resolved?.strategy,
    });
  }

  // --- helpers ------------------------------------------------------------

  private element(id: string): ObservedElement {
    /* c8 ignore next -- validateAction guarantees membership */
    const el = this.obs?.elements.find((e) => e.id === id);
    if (!el) throw new Error(`element ${id} vanished from observation ${this.obs?.obsId}`);
    return el;
  }

  private buildCheck(raw: RawAction): Check {
    const kind = raw.assertKind!;
    const describes = redact(raw.reason).slice(0, 200);
    if (kind === "url_matches") {
      return CheckSchema.parse({ kind, pattern: raw.assertPattern!, describes });
    }
    if (kind === "element_exists" || kind === "element_absent") {
      return CheckSchema.parse({
        kind,
        target: describeEl(this.element(raw.targetId!)),
        describes,
      });
    }
    const value: ValueRef = raw.assertInput
      ? { input: raw.assertInput }
      : raw.assertTemplate
        ? { transform: { op: "template", format: raw.assertTemplate } }
        : { const: raw.assertConst! };
    return CheckSchema.parse({
      kind,
      value,
      ...(raw.targetId ? { target: describeEl(this.element(raw.targetId)) } : {}),
      describes,
    });
  }

  /** How a proposal reads in the ledger: references only, never values. */
  private describeProposal(raw: RawAction): string {
    const bits: string[] = [raw.action];
    if (raw.url) bits.push(raw.url);
    if (raw.targetId) bits.push(raw.targetId);
    if (raw.inputName) bits.push(`{input:${raw.inputName}}`);
    if (raw.outputName) bits.push(`-> ${raw.outputName}`);
    if (raw.outcomeCode) bits.push(raw.outcomeCode);
    if (raw.assertKind) bits.push(raw.assertKind);
    if (raw.regionId) bits.push(raw.regionId);
    if (raw.nextBatch) bits.push("nextBatch");
    return bits.join(" ");
  }

  /** The current URL with the run's own values written back as references. */
  private taggedUrl(): string {
    return tagInputs(this.o.surface.currentUrl(), this.o.ctx.inputs);
  }

  private absolute(pathOrUrl: string): string {
    return pathOrUrl.startsWith("http") ? pathOrUrl : `${this.o.baseUrl}${pathOrUrl}`;
  }

  private pathOf(url: string): string {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  }

  // --- termination --------------------------------------------------------

  private async handleThrow(e: unknown): Promise<ExecutionResult> {
    if (e instanceof Terminal) return this.finish(e);
    if (e instanceof Escalate) {
      // Only reached where no loop is available to hand control over: during
      // setup, or while already servicing an escalation. Terminal, with the
      // original condition intact rather than dressed up as something else.
      return this.finish(
        new Terminal("failure", e.reasonCode, { expected: e.expected, observed: e.observed }),
      );
    }
    if (e instanceof SafetyViolation) {
      return this.finish(
        new Terminal("safety_violation", safetyReason(e.rule), {
          expected: "an action permitted by policy",
          observed: `${e.rule} refused "${e.attempted}"`,
          safety: { rule: e.rule, attempted: e.attempted },
        }),
      );
    }
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : "unknown error";
    this.o.store.event({ type: "discovery_crashed", actor: "SYSTEM", reason: redact(detail) });
    return this.finish(
      new Terminal("failure", "DEAD_END", {
        expected: "the loop to reach a stop condition",
        observed: detail,
      }),
    );
  }

  /**
   * Hands control to a person. The run is not finished by this: the operator
   * may return control, finish the step by hand, or stop -- and what they do
   * in the browser is recorded into the same trace, marked as theirs.
   */
  private async escalate(e: Escalate): Promise<ExecutionResult | null> {
    const handled = await this.o.operator.handle({
      kind: "discovery_blocked",
      subject: { taskId: this.o.task.taskId, goalSummary: this.o.task.goal.slice(0, 300) },
      step: {
        stepId: this.stepId(this.seq + 1),
        index: this.seq,
        action: this.lastRaw?.action ?? "observe",
        targetSummary: this.lastRaw ? this.describeProposal(this.lastRaw) : "(no action proposed)",
      },
      expected: e.expected,
      observed: e.observed,
      reason: e.reason,
      reasonCode: e.reasonCode,
    });

    if (handled.response === "abort") {
      // Non-interactive runs take this path for every escalation, so the
      // original condition is preserved rather than flattened into "the
      // operator aborted" -- nobody was there to abort.
      return this.finish(
        new Terminal("aborted", this.o.interactive ? "OPERATOR_ABORTED" : e.reasonCode, {
          expected: e.expected,
          observed: e.observed,
        }),
        handled.request.interventionId,
      );
    }

    this.absorbHumanSteps(handled.recorded);

    if (handled.response === "complete") {
      this.o.store.event({
        type: "human_completed_workflow",
        actor: "HUMAN",
        reason: "the operator completed the remaining steps manually",
      });
      return this.completeByHand(handled.request.interventionId);
    }

    this.ledger.push({
      seq: this.ledger.length + 1,
      proposed: "(handed to operator)",
      result: handled.recorded.length
        ? `control returned; ${handled.recorded.length} manual action${handled.recorded.length > 1 ? "s" : ""} recorded`
        : "control returned",
    });
    this.consecutiveRejections = 0;
    this.note = null;
    await this.reobserve();

    if (handled.response === "retry" && this.lastRaw) {
      // Ids are observation-scoped, so the action the operator asked to retry
      // may no longer be expressible. Saying so beats re-executing against
      // whatever now occupies that id.
      const again = validateAction(this.lastRaw, {
        observation: this.obs,
        inputNames: this.inputNames,
        outputNames: this.outputNames,
        untaggedInputs: this.untaggedInputs,
        outputPatterns: this.outputPatterns,
        boundOutputs: this.outputs,
      });
      if (again) {
        this.note = `the operator asked to retry, but that action is no longer valid: ${again.reason}`;
      } else {
        await this.dispatch(this.lastRaw);
      }
    }
    return null;
  }

  /**
   * The operator finished the workflow themselves. Success still has to be
   * earned: the declared outputs are bound from the final page or the run is
   * not a success, whoever performed the steps.
   */
  private async completeByHand(interventionId: string): Promise<ExecutionResult> {
    try {
      await this.reobserve();
      for (const name of this.outputNames) {
        if (this.outputs[name] !== undefined) continue;
        const spec = this.o.task.outputs[name] as { pattern?: string } | undefined;
        if (!spec?.pattern) {
          throw new Terminal("failure", "OUTPUT_VALIDATION_FAILED", {
            expected: `a value for "${name}" after manual completion`,
            observed: "the output declares no pattern, so it cannot be located on the page",
          });
        }
        const re = new RegExp(spec.pattern);
        const hit = this.obs!.elements.find((el) => re.test(el.name));
        if (!hit) {
          throw new Terminal("failure", "OUTPUT_VALIDATION_FAILED", {
            expected: `${name} matching /${spec.pattern}/ on the final page`,
            observed: "no element on the page carries such a value",
          });
        }
        const descriptor = describeEl(hit);
        this.outputs[name] = hit.name.match(re)![0];
        this.record({
          action: "extract",
          reason: "bound from the page the operator finished on",
          target: descriptor,
          effect: "reversible",
          extractAs: name,
          extractRegex: spec.pattern,
          authoredBy: "human",
        });
      }
      return this.finish(
        new Terminal("success", "OK", { observed: "the operator completed the workflow by hand" }),
        interventionId,
      );
    } catch (e) {
      return this.handleThrow(e);
    }
  }

  private absorbHumanSteps(
    recorded: { eventType: string; element: ObservedElement; matchedInput: string | null; url: string }[],
  ): void {
    const kept = recorded.filter((a) => a.eventType !== "submit");
    for (const [i, action] of kept.entries()) {
      const descriptor = HumanRecorder.toDescriptor(action as never);
      const resolvedAction: TraceStep["action"] =
        action.eventType === "fill" || action.eventType === "select" ? "fill" : "click";
      this.record({
        action: resolvedAction,
        reason: "performed by the operator during handoff",
        target: descriptor,
        // A value the operator typed that matches no declared input cannot be
        // expressed as a reference, so the step is marked unresolved rather
        // than inventing a constant for it.
        ...(action.matchedInput ? { value: { input: action.matchedInput } as ValueRef } : {}),
        effect: "reversible",
        authoredBy: "human",
        unresolved: resolvedAction === "fill" && !action.matchedInput,
        // A trace step records where it left the page. These are absorbed only
        // after the person hands back, when the page is wherever they ended,
        // so each one's is where the next action happened instead.
        ...(kept[i + 1] ? { url: kept[i + 1]!.url } : {}),
      });
    }
  }

  private finish(t: Terminal, interventionId?: string): ExecutionResult {
    const { store, budgets, task } = this.o;
    const endedAt = new Date().toISOString();

    const trace: DiscoveryTrace = TraceSchema.parse({
      schemaVersion: "1.0.0",
      runId: store.runId,
      taskId: task.taskId,
      origin: new URL(this.o.baseUrl).origin,
      model: this.o.model.name,
      startedAt: this.startedAt,
      endedAt,
      outcome: t.outcome,
      steps: this.steps,
      businessOutcomes: this.businessOutcomes,
      outputs: this.outputs,
      authoredBy: { agent: this.steps.length - this.humanAuthored, human: this.humanAuthored },
      appFingerprint: appFingerprint(this.o.baseUrl, this.steps),
    });
    store.document("trace.json", trace);

    const result = ResultSchema.parse({
      schemaVersion: "1.0.0",
      runId: store.runId,
      kind: "discovery",
      taskId: task.taskId,
      lifecycle: "completed",
      outcome: t.outcome,
      reasonCode: t.reasonCode,
      ...(t.outcome === "success" ? { outputs: this.outputs } : {}),
      ...(t.detail.business ? { businessOutcome: t.detail.business } : {}),
      ...(t.outcome === "failure"
        ? {
            failure: {
              stepId: this.stepId(t.detail.seq ?? this.seq),
              stepIndex: Math.max(0, this.seq - 1),
              expected: t.detail.expected ?? "",
              observed: t.detail.observed ?? "",
              evidence: t.detail.evidence ?? [],
            },
          }
        : {}),
      ...(t.detail.safety ? { safety: t.detail.safety } : {}),
      ...(interventionId ? { intervention: { interventionId, checkpoint: this.stepId(this.seq) } } : {}),
      recoveries: [],
      drift: {
        stepsResolvedBelowRank1: this.belowRank1,
        score: this.resolvedSteps === 0 ? 0 : this.belowRank1.length / this.resolvedSteps,
      },
      budgets: budgets.snapshot(),
      control: this.o.control.transitions,
      approvals: this.approvals,
      startedAt: this.startedAt,
      endedAt,
      evidenceDir: store.dir,
    });

    store.document("result.json", result);
    store.event({
      type: "discovery_finished",
      actor: "SYSTEM",
      outcome: result.outcome ?? "",
      reasonCode: result.reasonCode,
      reason: t.detail.observed ?? "",
      budgets: budgets.snapshot(),
    });
    return result;
  }
}

/**
 * `intervention` on a completed result is a reference to what happened, not a
 * pause; `lifecycle: "awaiting_human"` is reserved for a run the executor has
 * genuinely left open, which the CLI loop owns.
 */
function safetyReason(rule: string): ReasonCode {
  if (rule === "origin_allowlist" || rule === "malformed_url") return "ORIGIN_NOT_ALLOWLISTED";
  if (rule === "route_allowlist") return "ROUTE_NOT_ALLOWLISTED";
  return "ACTION_NOT_ALLOWLISTED";
}

function describeValueRef(ref: ValueRef): string {
  if ("input" in ref) return `{input:${ref.input}}`;
  if ("secret" in ref) return `{secret:${ref.secret}}`;
  if ("const" in ref) return `{const:${ref.const}}`;
  return "{transform}";
}

/**
 * Identifies the shape of the application the trace was taken against, so a
 * capability compiled from it can be told apart from one compiled against a
 * different build. Descriptor fingerprints carry no page values.
 */
function appFingerprint(baseUrl: string, steps: TraceStep[]): string {
  const material = [new URL(baseUrl).origin, ...steps.map((s) => s.surfaceFingerprint ?? "")].join("|");
  return "sha256:" + createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Parsed through the schema so a malformed step fails here, not in the compiler. */
function TraceStepShape(v: unknown): TraceStep {
  return TraceStepSchema.parse(v);
}
