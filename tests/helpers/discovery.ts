import { readFileSync } from "node:fs";
import path from "node:path";
import { OPERATOR_SECRETS, type TestApp } from "./app.js";
import { pick, type Move } from "./scripted.js";
import { TaskContract, type ExecutionResult, type Policy } from "../../src/contracts/index.js";
import { Surface } from "../../src/browser/index.js";
import { BudgetLedger, RunStore } from "../../src/observability/index.js";
import { ControlLedger, OperatorConsole, type Operator } from "../../src/handoff/index.js";
import { flatten, type ApprovalMode } from "../../src/workflow/index.js";
import { DiscoveryExecutor } from "../../src/discovery/index.js";
import type { ModelClient } from "../../src/discovery/model.js";

/**
 * These runs are unattended, so the write is authorised in advance -- the
 * same mode a scheduled discovery run would use. The gate still builds the
 * diff and records the digest; only the prompt is skipped.
 */
export const PRE_APPROVED: ApprovalMode = {
  mode: "pre_approved",
  approvedBy: "tests",
  at: "2026-01-01T00:00:00.000Z",
};

export const task = TaskContract.parse(
  JSON.parse(readFileSync("tasks/update-mailing-address.json", "utf8")),
);

export type RunOpts = {
  app: TestApp;
  model: ModelClient;
  valuesFile?: string;
  policy?: Partial<Policy>;
  approval?: ApprovalMode;
  /**
   * A stand-in for the person at the console. Supplying one makes the run
   * interactive; without one, escalations take the non-interactive path.
   */
  operator?: Operator;
};

export async function runDiscovery(
  o: RunOpts,
): Promise<{ result: ExecutionResult; store: RunStore; control: ControlLedger }> {
  const values = JSON.parse(
    readFileSync(o.valuesFile ?? "values/member-1002.json", "utf8"),
  ) as Record<string, unknown>;
  const inputs = flatten(values);
  const policy: Policy = { ...o.app.policy, ...(o.policy ?? {}) };
  const secrets = {
    "demobank.operator.user": OPERATOR_SECRETS["demobank.operator.user"],
    "demobank.operator.password": OPERATOR_SECRETS["demobank.operator.password"],
  };
  const interactive = o.operator !== undefined;

  const surface = await Surface.launch({
    policy,
    headless: true,
    profileDir: path.join(o.app.profileDir, Math.random().toString(36).slice(2)),
    inputs,
    secrets,
  });
  const store = new RunStore(surface.newRunId("test"), path.join(o.app.profileDir, "runs"));
  const budgets = new BudgetLedger(policy.budgets);
  const control = new ControlLedger(store);
  const operator = new OperatorConsole(surface, store, control, budgets, inputs, interactive, o.operator);

  try {
    const result = await new DiscoveryExecutor({
      task: { ...task, targetUrl: `${o.app.baseUrl}/` },
      surface,
      store,
      control,
      operator,
      budgets,
      model: o.model,
      ctx: { inputs, secrets, policy },
      policy,
      baseUrl: o.app.baseUrl,
      approval: o.approval ?? PRE_APPROVED,
      interactive,
    }).run();
    return { result, store, control };
  } finally {
    await surface.close();
  }
}

/** The moves that carry a run from the front page to the review screen. */
export const toReview: Move[] = [
  () => ({ action: "navigate", url: "/search" }),
  (t) => ({ action: "fill", targetId: pick(t, (r) => r.role === "textbox", "the search box"), inputName: "member_id" }),
  (t) => ({ action: "click", targetId: pick(t, (r) => r.name === "Search", "the Search button") }),
  (t) => ({ action: "click", targetId: pick(t, (r) => r.name === "View", "the View link"), anchorInput: "member_id" }),
  (t) => ({ action: "click", targetId: pick(t, (r) => r.name === "Edit mailing address", "the Edit link") }),
  // Some fields are labelled and some carry a bare caption, which is why the
  // inventory reports both and why a script has to look at both.
  (t) => ({ action: "fill", targetId: pick(t, (r) => r.name === "Address line 1", "line1"), inputName: "address.line1" }),
  (t) => ({ action: "fill", targetId: pick(t, (r) => r.name === "Address line 2", "line2"), inputName: "address.line2" }),
  (t) => ({ action: "fill", targetId: pick(t, (r) => r.nearby === "City", "city"), inputName: "address.city" }),
  (t) => ({ action: "fill", targetId: pick(t, (r) => r.nearby === "State", "state"), inputName: "address.state" }),
  (t) => ({ action: "fill", targetId: pick(t, (r) => r.nearby === "ZIP code", "zip"), inputName: "address.zip" }),
  (t) => ({ action: "click", targetId: pick(t, (r) => r.name === "Review changes", "Review changes") }),
];

/** From the review screen through approval, submission and verification. */
export const throughSubmit: Move[] = [
  () => ({ action: "request_approval", reason: "about to write the new address" }),
  (t) => ({ action: "click", targetId: pick(t, (r) => r.name === "Submit change", "Submit change") }),
  () => ({ action: "assert", assertKind: "text_contains", assertConst: "Mailing address updated." }),
  (t) => ({
    action: "extract",
    targetId: pick(t, (r) => /^CONF-/.test(r.name), "the confirmation id"),
    outputName: "confirmation_id",
  }),
];
