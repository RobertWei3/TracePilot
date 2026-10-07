// The loop is the only place where a model's output becomes a browser action,
// so these tests are about the seams: what it refuses, what it verifies before
// believing, and how each way of stopping is reported. The application and the
// browser are real -- mocking the surface would only test the mock -- and the
// model is scripted, so the stop conditions are deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startApp, OPERATOR_SECRETS, type TestApp } from "./helpers/app.js";
import { ScriptedModel, FailingModel, pick, type Move } from "./helpers/scripted.js";
import { TaskContract, type ExecutionResult, type Policy } from "../src/contracts/index.js";
import { Surface } from "../src/browser/index.js";
import { BudgetLedger, RunStore } from "../src/observability/index.js";
import { ControlLedger, OperatorConsole } from "../src/handoff/index.js";
import { flatten, type ApprovalMode } from "../src/workflow/index.js";

/**
 * These runs are unattended, so the write is authorised in advance -- the
 * same mode a scheduled discovery run would use. The gate still builds the
 * diff and records the digest; only the prompt is skipped.
 */
const PRE_APPROVED: ApprovalMode = {
  mode: "pre_approved",
  approvedBy: "tests",
  at: "2026-01-01T00:00:00.000Z",
};
import { DiscoveryExecutor } from "../src/discovery/index.js";
import { compile } from "../src/compiler/index.js";
import { DiscoveryTrace } from "../src/contracts/index.js";
import { replay } from "../src/replay/index.js";
import type { ModelClient } from "../src/discovery/model.js";

const task = TaskContract.parse(
  JSON.parse(readFileSync("tasks/update-mailing-address.json", "utf8")),
);

type RunOpts = {
  app: TestApp;
  model: ModelClient;
  valuesFile?: string;
  policy?: Partial<Policy>;
  approval?: ApprovalMode;
};

async function runDiscovery(o: RunOpts): Promise<{ result: ExecutionResult; store: RunStore }> {
  const values = JSON.parse(
    readFileSync(o.valuesFile ?? "values/member-1002.json", "utf8"),
  ) as Record<string, unknown>;
  const inputs = flatten(values);
  const policy: Policy = { ...o.app.policy, ...(o.policy ?? {}) };
  const secrets = {
    "demobank.operator.user": OPERATOR_SECRETS["demobank.operator.user"],
    "demobank.operator.password": OPERATOR_SECRETS["demobank.operator.password"],
  };

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
  // Non-interactive: escalation takes the same path but never blocks on stdin.
  const operator = new OperatorConsole(surface, store, control, budgets, inputs, false);

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
      interactive: false,
    }).run();
    return { result, store };
  } finally {
    await surface.close();
  }
}

/** The moves that carry a run from the front page to the review screen. */
const toReview: Move[] = [
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
const throughSubmit: Move[] = [
  () => ({ action: "request_approval", reason: "about to write the new address" }),
  (t) => ({ action: "click", targetId: pick(t, (r) => r.name === "Submit change", "Submit change") }),
  () => ({ action: "assert", assertKind: "text_contains", assertConst: "Mailing address updated." }),
  (t) => ({
    action: "extract",
    targetId: pick(t, (r) => /^CONF-/.test(r.name), "the confirmation id"),
    outputName: "confirmation_id",
  }),
];

test("a verified completion binds the declared output and records what happened", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([
    ...toReview,
    ...throughSubmit,
    // Verification is not optional: re-read the record and assert the new
    // value is actually stored before claiming success.
    (tx) => ({ action: "click", targetId: pick(tx, (r) => r.name === "Back to member", "back link") }),
    () => ({
      action: "assert",
      assertKind: "text_contains",
      assertTemplate: "{address.city}, {address.state} {address.zip}",
    }),
    () => ({ action: "done", reason: "the address was updated and confirmed" }),
  ]);

  const { result, store } = await runDiscovery({ app, model });

  assert.equal(result.outcome, "success", JSON.stringify(result.failure ?? result.reasonCode));
  assert.equal(result.reasonCode, "OK");
  assert.match(result.outputs!.confirmation_id!, /^CONF-[A-Z0-9]{8}$/);

  // The application actually changed, not just the screen.
  const member = (await app.member("M-1002"))!;
  assert.equal(member.city, "Brookline");
  assert.equal(member.zip, "02445");

  const trace = JSON.parse(readFileSync(path.join(store.dir, "trace.json"), "utf8"));
  assert.equal(trace.taskId, "demobank.update_mailing_address");
  assert.ok(
    trace.steps.some((s: { action: string; effect: string }) => s.effect === "consequential"),
    "the submit must be recorded as a consequential step",
  );
  const gate = trace.steps.findIndex((s: { action: string }) => s.action === "approval_gate");
  const write = trace.steps.findIndex((s: { effect: string }) => s.effect === "consequential");
  assert.ok(gate >= 0 && gate < write, "the approval gate must precede the write in the trace");
  assert.equal(trace.authoredBy.human, 0);
});

test("a fill records a value reference, never the value", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([...toReview, () => ({ action: "give_up", reason: "stopping here" })]);
  const { store } = await runDiscovery({ app, model });

  // Digests are stripped before scanning. A hash is not a rendering of the
  // value, and hex happily contains short numeric strings by coincidence --
  // "02445" turns up inside a sha256 often enough to make an unfiltered scan
  // fail on runs where nothing leaked at all.
  const withoutDigests = (text: string): string => text.replace(/sha256:[0-9a-f]+/g, "sha256:*");
  const raw = withoutDigests(readFileSync(path.join(store.dir, "trace.json"), "utf8"));
  const events = withoutDigests(readFileSync(store.logPath, "utf8"));
  for (const secret of Object.values(
    flatten(JSON.parse(readFileSync("values/member-1002.json", "utf8")) as Record<string, unknown>),
  )) {
    if (!secret) continue;
    assert.ok(!raw.includes(secret), `trace.json leaked ${secret}`);
    assert.ok(!events.includes(secret), `events.jsonl leaked ${secret}`);
  }
  assert.match(raw, /"input":\s*"address\.city"/);
});

test("the application correctly saying no is a business outcome, not a failure", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([
    () => ({ action: "navigate", url: "/search" }),
    (t2) => ({ action: "fill", targetId: pick(t2, (r) => r.role === "textbox", "search box"), inputName: "member_id" }),
    (t2) => ({ action: "click", targetId: pick(t2, (r) => r.name === "Search", "Search") }),
    () => ({
      action: "business_outcome",
      outcomeCode: "MEMBER_NOT_FOUND",
      assertKind: "text_contains",
      assertConst: "No members matched that search.",
      reason: "the application reports no such member",
    }),
  ]);

  const { result } = await runDiscovery({ app, model, valuesFile: "values/member-missing.json" });

  assert.equal(result.outcome, "business_outcome");
  assert.equal(result.reasonCode, "BUSINESS_OUTCOME");
  assert.equal(result.businessOutcome!.code, "MEMBER_NOT_FOUND");
  assert.equal((await app.confirmations()).count, 0);
});

test("a recognizer that does not hold is refused rather than believed", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // M-1002 exists, so "no members matched" is false -- and claiming a business
  // outcome is the most attractive exit a stuck agent has.
  const model = new ScriptedModel([
    () => ({ action: "navigate", url: "/search" }),
    (t2) => ({ action: "fill", targetId: pick(t2, (r) => r.role === "textbox", "search box"), inputName: "member_id" }),
    (t2) => ({ action: "click", targetId: pick(t2, (r) => r.name === "Search", "Search") }),
    () => ({
      action: "business_outcome",
      outcomeCode: "MEMBER_NOT_FOUND",
      assertKind: "text_contains",
      assertConst: "No members matched that search.",
      reason: "pretending the member is missing",
    }),
    () => ({ action: "give_up", reason: "gave up after the refusal" }),
  ]);

  const { result, store } = await runDiscovery({ app, model });

  assert.notEqual(result.outcome, "business_outcome");
  const events = readFileSync(store.logPath, "utf8");
  assert.match(events, /that recognizer does not hold/);
});

test("a text check on the wrong element says where the text actually is", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // The heading is the nearest named thing to the new address, so it is the
  // target a model reaches for -- and a refusal that only says "does not hold"
  // invited the same proposal again until the run hit DEAD_END.
  const model = new ScriptedModel([
    ...toReview,
    (tx) => ({
      action: "assert",
      assertKind: "text_contains",
      assertInput: "address.line1",
      targetId: pick(tx, (r) => r.role === "heading", "the review heading"),
    }),
    () => ({ action: "assert", assertKind: "text_contains", assertInput: "address.line1" }),
    () => ({ action: "give_up", reason: "done checking" }),
  ]);

  const { store } = await runDiscovery({ app, model });

  const events = readFileSync(store.logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; action?: string; reason?: string });
  const refused = events.find((e) => e.type === "action_rejected");
  assert.match(refused?.reason ?? "", /IS on this page.*omit targetId/);
  assert.ok(
    events.some((e) => e.type === "step_recorded" && e.action === "assert"),
    "the page-wide check should have been accepted",
  );
});

test("a consequential control cannot be clicked without a recorded approval", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([
    ...toReview,
    // Straight to the write, with no approval requested.
    (tx) => ({ action: "click", targetId: pick(tx, (r) => r.name === "Submit change", "Submit change") }),
    () => ({ action: "give_up", reason: "refused, as expected" }),
  ]);

  const { result, store } = await runDiscovery({ app, model });

  assert.notEqual(result.outcome, "success");
  assert.equal((await app.confirmations()).count, 0, "nothing may have been written");
  const member = (await app.member("M-1002"))!;
  assert.equal(member.city, "Ashford", "the stored address must be untouched");
  assert.match(readFileSync(store.logPath, "utf8"), /writes a durable change/);
});

test("an element id from an earlier observation is refused", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  let stale = "";
  const model = new ScriptedModel([
    () => ({ action: "navigate", url: "/search" }),
    (t2) => {
      stale = pick(t2, (r) => r.role === "textbox", "search box");
      return { action: "navigate", url: "/" };
    },
    // The page has moved on; the id now names a control in a dead observation.
    () => ({ action: "fill", targetId: stale, inputName: "member_id" }),
    () => ({ action: "give_up", reason: "refused, as expected" }),
  ]);

  const { store } = await runDiscovery({ app, model });
  assert.match(readFileSync(store.logPath, "utf8"), /belongs to an earlier observation/);
});

test("an off-policy navigation costs one refusal, not the run", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([
    () => ({ action: "navigate", url: "https://example.com/" }),
    () => ({ action: "navigate", url: "/search" }),
    () => ({ action: "give_up", reason: "done exploring" }),
  ]);

  const { result, store } = await runDiscovery({ app, model });
  assert.notEqual(result.outcome, "safety_violation", "a bad guess is not a safety incident");
  assert.match(readFileSync(store.logPath, "utf8"), /must be a path/);
  assert.ok(model.used >= 3, "the run continued after the refusal");
});

test("an extraction that does not match the declared output is refused", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([
    ...toReview,
    ...throughSubmit.slice(0, 3),
    // The panel heading is right next to the value and is not the value.
    (tx) => ({
      action: "extract",
      targetId: pick(tx, (r) => r.name === "Confirmation" && r.role === "heading", "the heading"),
      outputName: "confirmation_id",
    }),
    () => ({ action: "give_up", reason: "refused, as expected" }),
  ]);

  const { store } = await runDiscovery({ app, model });
  assert.match(readFileSync(store.logPath, "utf8"), /is not a confirmation_id/);
});

test("done is refused while a declared output is unbound", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([
    ...toReview,
    ...throughSubmit.slice(0, 3),
    () => ({ action: "done", reason: "claiming success early" }),
    () => ({ action: "give_up", reason: "refused, as expected" }),
  ]);

  const { result, store } = await runDiscovery({ app, model });
  assert.notEqual(result.outcome, "success");
  assert.match(readFileSync(store.logPath, "utf8"), /confirmation_id is not bound/);
});

test("repeated refusals report being stuck rather than budget exhaustion", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // The same invalid action, forever. Left unchecked it would consume every
  // model call and be reported as a budget problem.
  const model = new ScriptedModel(
    [],
    () => ({ action: "fill", targetId: "obs99:el-1", inputName: "member_id" }),
  );

  const { result } = await runDiscovery({ app, model });
  assert.equal(result.reasonCode, "DEAD_END");
  assert.ok(model.used <= 6, `stopped after ${model.used} calls, not the whole budget`);
});

test("a budget limit stops the run and is named as the reason", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([], () => ({ action: "navigate", url: "/search" }));
  const { result } = await runDiscovery({
    app,
    model,
    policy: { budgets: { ...app.policy.budgets, actionSteps: 3 } },
  });

  assert.equal(result.outcome, "aborted");
  assert.equal(result.reasonCode, "STEP_BUDGET_EXHAUSTED");
});

test("an undeclared dialog ends the run rather than becoming another turn", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await app.scenario("extra_dialog", "on");

  const model = new ScriptedModel([
    ...toReview,
    () => ({ action: "request_approval", reason: "about to write" }),
    (tx) => ({ action: "click", targetId: pick(tx, (r) => r.name === "Submit change", "Submit change") }),
    () => ({ action: "done", reason: "should never be reached" }),
  ]);

  const { result } = await runDiscovery({ app, model });
  assert.equal(result.reasonCode, "UNEXPECTED_DIALOG");
  assert.equal((await app.confirmations()).count, 0, "a dismissed dialog cancels the write");
});

test("an unreachable model is not charged to the decision budget", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new FailingModel("transport");
  const { result } = await runDiscovery({ app, model });

  assert.equal(result.reasonCode, "DEAD_END");
  assert.equal(result.budgets.modelCalls, 0, "no decision was made, so nothing is charged");
  assert.equal(model.calls, 1);
});

test("a discovered run compiles into a capability that replays for another member, with no model", async (t) => {
  // The loop P4 closes: discover once on M-1002, compile, then replay on
  // M-1007 -- whose address has no second line, so a template authored on
  // M-1002 holds only because the compiler split it at the optional input.
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([
    ...toReview,
    () => ({
      action: "assert",
      assertKind: "text_contains",
      assertTemplate: "{address.line1}, {address.line2}, {address.city}, {address.state} {address.zip}",
    }),
    ...throughSubmit,
    () => ({ action: "done", reason: "address updated and confirmation bound" }),
  ]);
  const { result: discovered, store } = await runDiscovery({ app, model });
  assert.equal(discovered.outcome, "success", JSON.stringify(discovered.failure));

  const trace = DiscoveryTrace.parse(JSON.parse(readFileSync(path.join(store.dir, "trace.json"), "utf8")));
  const { capability } = compile(trace, task, { version: 1, createdAt: "2026-10-06T00:00:00.000Z" });
  assert.equal(capability.status, "ready");

  await app.reset();
  const replayed = await replay({
    capability,
    values: JSON.parse(readFileSync("values/member-1007.json", "utf8")),
    policy: app.policy,
    baseUrl: app.baseUrl,
    headless: true,
    profileDir: path.join(app.profileDir, "replay"),
    approval: PRE_APPROVED,
    interactive: false,
    runRoot: path.join(app.profileDir, "runs"),
    secrets: OPERATOR_SECRETS,
  });

  assert.equal(replayed.outcome, "success", JSON.stringify(replayed.failure));
  assert.equal(replayed.budgets.modelCalls, 0);
  assert.match(replayed.outputs!.confirmation_id!, /^CONF-[A-Z0-9]{8}$/);
  assert.notEqual(replayed.outputs!.confirmation_id, discovered.outputs!.confirmation_id);

  const member = (await app.member("M-1007"))!;
  assert.equal(member.line1, "88 Sablewood Terrace");
  assert.equal(member.city, "Petaluma");
  const untouched = (await app.member("M-1002"))!;
  assert.equal(untouched.updated_at, null, "the reset member the run was discovered on must stay untouched");
});
