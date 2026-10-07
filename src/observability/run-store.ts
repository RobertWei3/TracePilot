import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { project, redact, type FieldSpec } from "../safety/index.js";

/**
 * Every persisted record is rebuilt from an explicit field specification.
 * Anything not named here is dropped rather than inspected, so a field added
 * upstream cannot leak by default. Raw model request/response payloads have no
 * specification at all -- they are held in memory for the duration of a run and
 * never written.
 */
const EVENT_SPEC: FieldSpec = {
  seq: true,
  at: "string",
  runId: "string",
  type: "string",
  actor: "string",
  stepId: "string",
  stepIndex: true,
  action: "string",
  targetSummary: "string",
  /** Value *references*, never resolved values. */
  valueRef: "string",
  outcome: "string",
  reasonCode: "string",
  /** Short decision summary. Treated as potentially sensitive and redacted. */
  reason: "string",
  resolvedRank: true,
  resolvedStrategy: "string",
  url: "string",
  expected: "string",
  observed: "string",
  evidenceRef: "string",
  omittedReason: "string",
  durationMs: true,
  budgets: { actionSteps: true, observations: true, modelCalls: true, activeMs: true, humanWaitMs: true },
};

export type RunEvent = {
  type: string;
  actor?: "AGENT" | "HUMAN" | "SYSTEM";
  stepId?: string;
  stepIndex?: number;
  action?: string;
  targetSummary?: string;
  valueRef?: string;
  outcome?: string;
  reasonCode?: string;
  reason?: string;
  resolvedRank?: number;
  resolvedStrategy?: string;
  url?: string;
  expected?: string;
  observed?: string;
  evidenceRef?: string;
  omittedReason?: string;
  durationMs?: number;
  budgets?: Record<string, number>;
};

/**
 * One run directory holds the sanitized execution log, the sanitized result,
 * and any masked screenshots. It is the transcript-of-record: the artifact is
 * compiled from the structured run record, and the two are visibly different
 * documents.
 */
export class RunStore {
  private seq = 0;
  readonly dir: string;
  readonly logPath: string;
  /**
   * Called with each record after projection, so a live view can never show
   * more than the log on disk does.
   */
  onEvent?: (record: Record<string, unknown>) => void;

  constructor(
    readonly runId: string,
    root = "runs",
  ) {
    this.dir = path.join(root, runId);
    this.logPath = path.join(this.dir, "events.jsonl");
    mkdirSync(path.join(this.dir, "screenshots"), { recursive: true });
  }

  event(e: RunEvent): void {
    const record = project(
      { seq: ++this.seq, at: new Date().toISOString(), runId: this.runId, ...e },
      EVENT_SPEC,
    );
    appendFileSync(this.logPath, JSON.stringify(record) + "\n", "utf8");
    this.onEvent?.(record as Record<string, unknown>);
  }

  /** Writes a masked screenshot, or records why no image exists. */
  screenshot(
    label: string,
    shot: { buffer: Buffer } | { buffer: null; omittedReason: string },
  ): { ref: string | null; omittedReason?: string } {
    if (!shot.buffer) return { ref: null, omittedReason: shot.omittedReason };
    const file = path.join(this.dir, "screenshots", `${label}.jpg`);
    writeFileSync(file, shot.buffer);
    return { ref: file };
  }

  /** Writes any already-sanitized JSON document into the run directory. */
  document(name: string, value: unknown): string {
    const file = path.join(this.dir, name);
    writeFileSync(file, redact(JSON.stringify(value, null, 2)) + "\n", "utf8");
    return file;
  }
}

/** Wall-clock and step accounting, with human wait time kept separate. */
export class BudgetLedger {
  actionSteps = 0;
  observations = 0;
  modelCalls = 0;
  private humanWaitMs = 0;
  private readonly startedAt = Date.now();
  private humanSince: number | null = null;

  constructor(
    readonly limits: {
      actionSteps: number;
      observations: number;
      modelCalls: number;
      wallClockMs: number;
    },
  ) {}

  /** Time the automation was actually working, excluding human wait. */
  activeMs(): number {
    return Date.now() - this.startedAt - this.totalHumanWaitMs();
  }

  totalHumanWaitMs(): number {
    return this.humanWaitMs + (this.humanSince ? Date.now() - this.humanSince : 0);
  }

  /** Budgets are preserved across a handoff; only the clock is paused. */
  beginHumanWait(): void {
    this.humanSince ??= Date.now();
  }

  endHumanWait(): void {
    if (this.humanSince) {
      this.humanWaitMs += Date.now() - this.humanSince;
      this.humanSince = null;
    }
  }

  snapshot(): {
    actionSteps: number;
    observations: number;
    modelCalls: number;
    activeMs: number;
    humanWaitMs: number;
  } {
    return {
      actionSteps: this.actionSteps,
      observations: this.observations,
      modelCalls: this.modelCalls,
      activeMs: Math.max(0, this.activeMs()),
      humanWaitMs: this.totalHumanWaitMs(),
    };
  }

  remaining(): {
    actionSteps: number;
    observations: number;
    modelCalls: number;
    wallClockMs: number;
  } {
    return {
      actionSteps: this.limits.actionSteps - this.actionSteps,
      observations: this.limits.observations - this.observations,
      modelCalls: this.limits.modelCalls - this.modelCalls,
      wallClockMs: Math.max(0, this.limits.wallClockMs - this.activeMs()),
    };
  }

  /**
   * Which budget, if any, is exhausted. Observations and model calls are
   * counted separately from action steps precisely so that re-inspecting a page
   * cannot launder the step limit.
   */
  exhausted():
    | null
    | "STEP_BUDGET_EXHAUSTED"
    | "OBSERVATION_BUDGET_EXHAUSTED"
    | "MODEL_CALL_BUDGET_EXHAUSTED"
    | "WALL_CLOCK_EXHAUSTED" {
    if (this.actionSteps >= this.limits.actionSteps) return "STEP_BUDGET_EXHAUSTED";
    if (this.observations >= this.limits.observations) return "OBSERVATION_BUDGET_EXHAUSTED";
    if (this.modelCalls >= this.limits.modelCalls) return "MODEL_CALL_BUDGET_EXHAUSTED";
    if (this.activeMs() >= this.limits.wallClockMs) return "WALL_CLOCK_EXHAUSTED";
    return null;
  }
}
