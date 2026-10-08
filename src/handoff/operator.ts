import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type {
  InterventionRequest,
  OperatorResponse,
  ReasonCode,
} from "../contracts/index.js";
import { InterventionRequest as InterventionSchema } from "../contracts/index.js";
import { redact } from "../safety/index.js";
import type { Surface } from "../browser/index.js";
import type { BudgetLedger, RunStore } from "../observability/index.js";
import { HumanRecorder, type RecordedAction } from "./recorder.js";
import type { ControlLedger } from "./control.js";

export type InterventionInput = {
  kind: InterventionRequest["kind"];
  subject: InterventionRequest["subject"];
  step: InterventionRequest["step"];
  expected: string;
  observed: string;
  reason: string;
  reasonCode: ReasonCode;
  pendingChange?: InterventionRequest["pendingChange"];
  allowedResponses?: OperatorResponse[];
};

/**
 * What a person does with an intervention: operate the live browser, then
 * answer. The console's own implementation reads the answer from stdin; a
 * test supplies one that drives the same page with real browser input, which
 * is what lets the takeover path be exercised end to end.
 */
export type Operator = (request: InterventionRequest, surface: Surface) => Promise<OperatorResponse>;

export type Handled = {
  request: InterventionRequest;
  response: OperatorResponse;
  recorded: RecordedAction[];
};

/**
 * The copy of a request that goes to disk. The console shows a person the
 * real values -- an approval is meaningless without them -- but the record
 * keeps references: redaction tags the inputs, and what it cannot know about
 * is left out. A field's current value is the subject's existing data, and
 * the visible text is the whole page; the masked screenshot covers that.
 */
function persisted(request: InterventionRequest): InterventionRequest {
  return {
    ...request,
    currentState: { ...request.currentState, visibleSummary: "(not persisted; see screenshotRef)" },
    ...(request.pendingChange
      ? {
          pendingChange: {
            ...request.pendingChange,
            fields: request.pendingChange.fields.map((f) => ({
              ...f,
              from: f.from === "(empty)" || f.from === "" ? f.from : "(current value)",
            })),
          },
        }
      : {}),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The CLI operator interface. Two things it deliberately does *not* do:
 * auto-approve anything, and resume without re-verifying state. Approval and
 * manual takeover are separate responses, because an approval is not a
 * substitute for a person actually operating the browser.
 */
export class OperatorConsole {
  constructor(
    private readonly surface: Surface,
    private readonly store: RunStore,
    private readonly control: ControlLedger,
    private readonly budgets: BudgetLedger,
    private readonly inputs: Record<string, string>,
    /** Non-interactive mode for CI and tests: escalations become terminal. */
    private readonly interactive: boolean,
    /** Who answers. Defaults to a person at this terminal. */
    private readonly operator?: Operator,
  ) {}

  async build(input: InterventionInput): Promise<InterventionRequest> {
    const shot = await this.surface.screenshot();
    // Base 36: a 13-digit millisecond stamp is shaped like a card number, and
    // redaction rewrote the persisted reference to a file that did not exist.
    const saved = this.store.screenshot(`iv-${input.step.stepId}-${Date.now().toString(36)}`, shot);
    const visible = await this.surface.visibleText();
    const remaining = this.budgets.remaining();

    return InterventionSchema.parse({
      schemaVersion: "1.0.0",
      interventionId: `iv-${randomUUID().slice(0, 8)}`,
      runId: this.store.runId,
      kind: input.kind,
      subject: input.subject,
      step: { ...input.step, targetSummary: clip(input.step.targetSummary, 200) },
      currentState: {
        url: this.surface.currentUrl(),
        title: await this.surface.page.title(),
        visibleSummary: redact(visible).slice(0, 1200),
        screenshotRef: saved.ref,
        ...(saved.omittedReason ? { omittedReason: saved.omittedReason } : {}),
      },
      expected: redact(input.expected),
      observed: redact(input.observed),
      // Reasons are composed from refusals and page text, whose length nobody
      // bounds; an overlong one must shorten the request, not crash the run
      // at the moment it is handing over to a person.
      reason: clip(redact(input.reason), 400),
      reasonCode: input.reasonCode,
      ...(input.pendingChange ? { pendingChange: input.pendingChange } : {}),
      budgetsRemaining: remaining,
      allowedResponses:
        input.allowedResponses ??
        (input.kind === "approval_required"
          ? ["resume", "abort"]
          : ["resume", "step_done", "retry", "complete", "abort"]),
      createdAt: new Date().toISOString(),
    });
  }

  private print(request: InterventionRequest): void {
    const line = "-".repeat(72);
    const out: string[] = [
      "",
      line,
      `INTERVENTION REQUIRED  [${request.kind}]  ${request.interventionId}`,
      line,
      `Subject   : ${request.subject.capabilityId ?? request.subject.taskId ?? "(none)"}` +
        (request.subject.version ? ` v${request.subject.version}` : ""),
      `Goal      : ${request.subject.goalSummary}`,
      `Step      : ${request.step.stepId} (#${request.step.index}) ${request.step.action} -> ${request.step.targetSummary}`,
      `URL       : ${request.currentState.url}`,
      `Expected  : ${request.expected}`,
      `Observed  : ${request.observed}`,
      `Reason    : ${request.reason} [${request.reasonCode}]`,
      `Screenshot: ${request.currentState.screenshotRef ?? `(omitted: ${request.currentState.omittedReason})`}`,
      `Budgets   : steps ${request.budgetsRemaining.actionSteps} | observations ${request.budgetsRemaining.observations} | model calls ${request.budgetsRemaining.modelCalls} | ${Math.round(request.budgetsRemaining.wallClockMs / 1000)}s`,
    ];
    if (request.pendingChange) {
      out.push(line, "PENDING CHANGE -- this is what will be written:");
      for (const f of request.pendingChange.fields) {
        out.push(`  ${f.label.padEnd(16)} ${f.from || "(empty)"}  ->  ${f.to}`);
      }
      out.push(`  digest: ${request.pendingChange.digest}`);
    }
    out.push(line);
    out.push("The browser window is live. You may operate it directly now.");
    out.push(`Responses: ${request.allowedResponses.join(" | ")}`);
    out.push(line, "");
    console.log(out.join("\n"));
  }

  /**
   * Presents the request, hands control to the human, records what they do in
   * the same live session, and returns their choice. The run is not finished by
   * this -- only the executor invocation is paused.
   */
  async handle(input: InterventionInput): Promise<Handled> {
    const request = await this.build(input);
    this.store.document(`intervention-${request.interventionId}.json`, persisted(request));
    this.store.event({
      type: "intervention_raised",
      actor: "SYSTEM",
      stepId: request.step.stepId,
      stepIndex: request.step.index,
      reasonCode: request.reasonCode,
      reason: request.reason,
      expected: request.expected,
      observed: request.observed,
      evidenceRef: request.currentState.screenshotRef ?? undefined,
      omittedReason: request.currentState.omittedReason,
    });

    if (!this.interactive) {
      // --no-handoff: the same code path, but terminal, so CI is deterministic.
      this.store.event({ type: "intervention_declined", actor: "SYSTEM", reason: "non-interactive mode" });
      return { request, response: "abort", recorded: [] };
    }

    this.control.transfer("HUMAN", `${request.reasonCode} at ${request.step.stepId}`);
    this.budgets.beginHumanWait();
    const recorder = new HumanRecorder(this.surface, this.inputs);
    await recorder.start();
    this.print(request);

    let response: OperatorResponse = "abort";
    try {
      response = this.operator
        ? await this.operator(request, this.surface)
        : await this.ask(request.allowedResponses);
      if (!request.allowedResponses.includes(response)) {
        throw new Error(`operator answered "${response}", which this intervention does not allow`);
      }
    } finally {
      const drained = HumanRecorder.dedupe(await recorder.drain().catch(() => []));
      this.budgets.endHumanWait();
      for (const action of drained) {
        this.store.event({
          type: "human_action",
          actor: "HUMAN",
          action: action.eventType,
          targetSummary: `${action.element.role} "${action.element.name || action.element.nearbyText}"`,
          valueRef: action.matchedInput ? `{input:${action.matchedInput}}` : undefined,
          url: action.url,
          reason: action.unmatchedValue ? "typed a value matching no declared input" : undefined,
        });
      }
      this.store.event({ type: "operator_response", actor: "HUMAN", outcome: response });
      this.control.transfer("AGENT", `operator chose ${response}`);
      return { request, response, recorded: drained };
    }
  }

  private ask(allowed: OperatorResponse[]): Promise<OperatorResponse> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const prompt = `control: HUMAN — type one of [${allowed.join(", ")}]: `;
    return new Promise((resolve) => {
      const askOnce = (): void => {
        rl.question(prompt, (answer) => {
          const choice = answer.trim().toLowerCase().replace(/-/g, "_") as OperatorResponse;
          if (allowed.includes(choice)) {
            rl.close();
            resolve(choice);
            return;
          }
          console.log(`"${answer.trim()}" is not one of ${allowed.join(", ")}.`);
          askOnce();
        });
      };
      askOnce();
    });
  }
}
