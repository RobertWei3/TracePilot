// The loop is the only place where a model's output becomes a browser action,
// so these tests are about the seams: what it refuses, what it verifies before
// believing, and how each way of stopping is reported. The application and the
// browser are real -- mocking the surface would only test the mock -- and the
// model is scripted, so the stop conditions are deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startApp, OPERATOR_SECRETS } from "./helpers/app.js";
import { ScriptedModel, FailingModel, pick } from "./helpers/scripted.js";
import { PRE_APPROVED, readBack, runDiscovery, task, throughSubmit, toReview } from "./helpers/discovery.js";
import { compile } from "../src/compiler/index.js";
import { DiscoveryTrace } from "../src/contracts/index.js";
import { replay } from "../src/replay/index.js";
import { flatten } from "../src/workflow/index.js";

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

test("a write is not finished until it is read back from the record", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // throughSubmit asserts the confirmation banner -- the application saying it
  // worked -- which is not the same as the record showing it.
  const model = new ScriptedModel([
    ...toReview,
    ...throughSubmit,
    () => ({ action: "done", reason: "the banner says it worked" }),
    ...readBack,
    () => ({ action: "done", reason: "the stored address was read back" }),
  ]);
  const { result, store } = await runDiscovery({ app, model });

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  const refusals = readFileSync(store.logPath, "utf8");
  assert.match(refusals, /not been read back/);
});

test("the model is told when the read-back is complete, not left to guess", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // The record page marks the address sensitive, so the model cannot see the
  // values it is asserting. A live run asserted them a dozen times over and
  // spent its whole model-call budget without ever calling done.
  const model = new ScriptedModel([
    ...toReview,
    ...throughSubmit,
    ...readBack,
    () => ({ action: "done", reason: "the stored address was read back" }),
  ]);
  const { result } = await runDiscovery({ app, model });

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  const told = model.ledgers.at(-1)!.map((e) => e.result);
  const firstReadBack = told.findIndex((r) => /read back/.test(r));
  assert.ok(firstReadBack >= 0, told.join("\n"));
  assert.match(told[firstReadBack]!, /call done/);
});

test("echoing an input on the page the write landed on is not a read-back", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // The confirmation page shows the member id, so this assertion holds and is
  // derived from an input -- but the member id identifies the record; it is
  // not what was written, and this is not the record.
  const model = new ScriptedModel([
    ...toReview,
    ...throughSubmit,
    () => ({ action: "assert", assertKind: "text_contains", assertInput: "member_id" }),
    () => ({ action: "done", reason: "the member id is on the page" }),
    () => ({ action: "give_up", reason: "refused, as expected" }),
  ]);
  const { result, store } = await runDiscovery({ app, model });

  assert.notEqual(result.outcome, "success");
  assert.match(readFileSync(store.logPath, "utf8"), /not been read back/);
});

test("a template whose parts are all on the page, but apart, is refused with how to fix it", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // The record page shows the street and the city line in separate rows, so
  // the review page's one-line form does not hold there. A live run retried
  // it until DEAD_END.
  const model = new ScriptedModel([
    ...toReview,
    ...throughSubmit,
    readBack[0]!,
    () => ({
      action: "assert",
      assertKind: "text_contains",
      assertTemplate: "{address.line1}, {address.city}, {address.state} {address.zip}",
    }),
    () => ({ action: "give_up", reason: "stopping after the refusal" }),
  ]);
  const { store } = await runDiscovery({ app, model });

  assert.match(readFileSync(store.logPath, "utf8"), /not arranged that way: assert them separately/);
});

test("a pre-approval authorises one write; a second one needs a person", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // A live run did exactly this: went to "verify" on the edit form, re-typed a
  // field and submitted again, and the standing pre-approval let it through.
  const model = new ScriptedModel([
    ...toReview,
    ...throughSubmit,
    readBack[0]!,
    (tx) => ({ action: "click", targetId: pick(tx, (r) => r.name === "Edit mailing address", "Edit link") }),
    (tx) => ({ action: "fill", targetId: pick(tx, (r) => r.name === "Address line 1", "line1"), inputName: "address.line1" }),
    (tx) => ({ action: "click", targetId: pick(tx, (r) => r.name === "Review changes", "Review changes") }),
    () => ({ action: "request_approval", reason: "submitting again" }),
    (tx) => ({ action: "click", targetId: pick(tx, (r) => r.name === "Submit change", "Submit change") }),
    () => ({ action: "give_up", reason: "stopping" }),
  ]);
  const { result } = await runDiscovery({ app, model });

  assert.equal((await app.confirmations()).count, 1, "the second write must not happen");
  assert.equal(result.outcome, "aborted");
  assert.equal(result.reasonCode, "APPROVAL_DECLINED");
});

test("an output is read once, and its URL is not a place to go back to", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // A live run read the confirmation id, went to the member record, then
  // navigated straight back to /confirmation/<that id> to read it again --
  // a step no replay could reproduce, so the run could not compile.
  let confirmationUrl = "";
  const model = new ScriptedModel([
    ...toReview,
    ...throughSubmit,
    (tx) => {
      confirmationUrl = /url: (\S+)/.exec(tx)?.[1] ?? "";
      return { action: "extract", targetId: pick(tx, (r) => /^CONF-/.test(r.name), "the id"), outputName: "confirmation_id" };
    },
    ...readBack,
    () => ({ action: "navigate", url: new URL(confirmationUrl).pathname }),
    ...readBack.slice(1),
    () => ({ action: "done", reason: "read back and bound" }),
  ]);
  const { result, store } = await runDiscovery({ app, model });

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  const log = readFileSync(store.logPath, "utf8");
  assert.match(log, /is already bound. Do not extract it again/);
  assert.match(log, /that URL contains the value of output \\"confirmation_id\\"/);
  // And the run compiles, because nothing in it names the issued value.
  compile(DiscoveryTrace.parse(JSON.parse(readFileSync(path.join(store.dir, "trace.json"), "utf8"))), task, {
    version: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
  });
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
    ...readBack,
    () => ({ action: "done", reason: "address updated, read back and confirmation bound" }),
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
