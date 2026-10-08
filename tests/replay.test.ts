import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chooseRewind, loadCapability, replay } from "../src/replay/index.js";
import { compile } from "../src/compiler/index.js";
import { DiscoveryTrace, TaskContract } from "../src/contracts/index.js";
import { startApp, OPERATOR_SECRETS, type TestApp } from "./helpers/app.js";

const FIXTURE = "tests/fixtures/update_mailing_address.v1.json";

let app: TestApp;
let runRoot: string;

test.before(async () => {
  app = await startApp();
  runRoot = mkdtempSync(path.join(tmpdir(), "tracepilot-runs-"));
});

test.after(async () => {
  await app.stop();
});

const PRE_APPROVED = {
  mode: "pre_approved" as const,
  approvedBy: "test-operator",
  at: "2026-09-10T00:00:00.000Z",
};

function run(valuesFile: string, overrides: Record<string, unknown> = {}) {
  return replay({
    capability: loadCapability(FIXTURE),
    values: JSON.parse(readFileSync(valuesFile, "utf8")),
    policy: app.policy,
    baseUrl: app.baseUrl,
    headless: true,
    profileDir: path.join(runRoot, `profile-${Math.random().toString(36).slice(2)}`),
    approval: PRE_APPROVED,
    interactive: false,
    runRoot,
    secrets: OPERATOR_SECRETS,
    ...overrides,
  });
}

test("replay of the hand-authored artifact succeeds and verifies the write", async () => {
  await app.reset();
  const result = await run("values/member-1002.json");

  assert.equal(result.lifecycle, "completed");
  assert.equal(result.outcome, "success", JSON.stringify(result.failure ?? result.safety));
  assert.equal(result.reasonCode, "OK");
  assert.match(result.outputs!.confirmation_id!, /^CONF-[A-Z0-9]{8}$/);
  // No model was involved in a replay.
  assert.equal(result.budgets.modelCalls, 0);

  // The read-back step asserted this from the UI; assert it independently too.
  const member = await app.member("M-1002");
  assert.equal(member!.line1, "1420 Windmere Crossing");
  assert.equal(member!.city, "Brookline");
  assert.equal(member!.state, "MA");
  assert.equal(member!.zip, "02445");
  assert.ok(member!.updated_at, "the record should carry an update timestamp");
});

test("the same artifact replays with different parameters", async () => {
  await app.reset();
  const result = await run("values/member-1007.json");

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  const member = await app.member("M-1007");
  assert.equal(member!.line1, "88 Sablewood Terrace");
  assert.equal(member!.city, "Petaluma");
  assert.equal(member!.zip, "94952");
  // The other member must be untouched: the parameter, not the artifact, chose.
  const untouched = await app.member("M-1002");
  assert.equal(untouched!.city, "Ashford");
  assert.equal(untouched!.updated_at, null);
});

test("a pre-approval is recorded with who authorised it and when", async () => {
  await app.reset();
  const result = await run("values/member-1002.json");
  assert.equal(result.approvals.length, 1);
  assert.equal(result.approvals[0]!.mode, "pre_approved");
  assert.equal(result.approvals[0]!.approvedBy, "test-operator");
  assert.match(result.approvals[0]!.diffDigest, /^sha256:/);
  // The gate sits before the consequential step, not after it.
  const cap = loadCapability(FIXTURE);
  const gate = cap.steps.find((s) => s.action === "approval_gate")!;
  const consequential = cap.steps.find((s) => s.effect === "consequential")!;
  assert.ok(gate.index < consequential.index);
});

test("an unknown member is a business outcome, not a failure", async () => {
  await app.reset();
  const result = await run("values/member-missing.json");

  assert.equal(result.lifecycle, "completed");
  assert.equal(result.outcome, "business_outcome");
  assert.equal(result.businessOutcome!.code, "MEMBER_NOT_FOUND");
  assert.equal(result.failure, undefined, "a correct application answer is not a defect");
  // Nothing was written.
  const member = await app.member("M-1002");
  assert.equal(member!.updated_at, null);
});

test("a rejected address is a business outcome carrying its own code", async () => {
  await app.reset();
  const result = await run("values/member-1002.json", {
    values: {
      member_id: "M-1002",
      address: { line1: "5 Reject Road", line2: "", city: "Nowhere", state: "Oregon", zip: "1" },
    },
  });
  assert.equal(result.outcome, "business_outcome");
  assert.equal(result.businessOutcome!.code, "ADDRESS_REJECTED");
  const member = await app.member("M-1002");
  assert.equal(member!.updated_at, null);
});

test("a transient slow load is absorbed by an explicit wait", async () => {
  await app.reset();
  await app.scenario("slow_search", "on");
  try {
    const result = await run("values/member-1002.json");
    assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  } finally {
    await app.scenario("slow_search", "off");
  }
});

test("a session that expires mid-flow is recovered once and the run completes", async () => {
  await app.reset();
  // Expire on the request that loads the member record: a page reachable by URL.
  await app.scenario("expire_at_request", "4");
  const result = await run("values/member-1002.json");

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  const relogin = result.recoveries.filter((r) => r.kind === "session_relogin");
  assert.equal(relogin.length, 1, "re-authentication is bounded to one attempt");
  assert.equal(relogin[0]!.succeeded, true);
  const member = await app.member("M-1002");
  assert.equal(member!.city, "Brookline");
});

test("recovery rebuilds page state rather than submitting stale form values", async () => {
  await app.reset();
  // Expire on the review submission. That screen is rendered by a POST and has
  // no addressable URL, and reloading the editor discards the typed address --
  // so resuming at the failing step alone would submit the *original* address.
  await app.scenario("expire_at_request", "6");
  const result = await run("values/member-1002.json");

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  assert.equal(result.recoveries.filter((r) => r.kind === "session_relogin").length, 1);
  // The requested address was written, not the value the reload restored.
  const member = await app.member("M-1002");
  assert.equal(member!.line1, "1420 Windmere Crossing");
  assert.equal(member!.city, "Brookline");
  assert.equal(member!.zip, "02445");
  const confirmations = await app.confirmations();
  assert.equal(confirmations.count, 1, "the change must be written exactly once");
});

test("an expiry during the durable write itself leaves nothing half-applied", async () => {
  await app.reset();
  // Request 7 is the submitting POST. The application rejects it, so no write
  // happens -- and the submission must not be quietly retried.
  await app.scenario("expire_at_request", "7");
  const result = await run("values/member-1002.json");

  assert.equal(result.lifecycle, "completed");
  assert.equal(result.outcome, "aborted");
  assert.equal(result.reasonCode, "SESSION_EXPIRED_UNRECOVERED");
  const confirmations = await app.confirmations();
  assert.equal(confirmations.count, 0, "a rejected submission must not be applied");
  const member = await app.member("M-1002");
  assert.equal(member!.updated_at, null);
});

test("an expiry after the write completes without writing twice", async () => {
  await app.reset();
  // Request 9 is the read-back load, by which point the change is committed.
  await app.scenario("expire_at_request", "9");
  const result = await run("values/member-1002.json");

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  assert.equal(result.recoveries.filter((r) => r.kind === "session_relogin").length, 1);
  const confirmations = await app.confirmations();
  assert.equal(confirmations.count, 1, "recovery must not repeat the submission");
});

test("recovery refuses to rewind across a step that already wrote", () => {
  // The refusal is a pure decision, so it is asserted directly. DemoBank cannot
  // reach it: recovery always returns to the failing step's own start page, and
  // no pre-write step shares a start URL with a post-write one.
  const steps = [
    { stepId: "s01", index: 1, effect: "reversible" },
    { stepId: "s02", index: 2, effect: "reversible" },
    { stepId: "s03", index: 3, effect: "consequential" },
    { stepId: "s04", index: 4, effect: "reversible" },
  ] as unknown as Parameters<typeof chooseRewind>[0]["steps"];
  const stepStartUrl = new Map([
    ["s01", "http://x/edit"],
    ["s02", "http://x/review"],
    ["s03", "http://x/review"],
    ["s04", "http://x/edit"],
  ]);

  // Landing back on /edit would rewind to s01, which precedes the write.
  const refused = chooseRewind({
    steps, stepStartUrl, currentStepId: "s04",
    recoveredUrl: "http://x/edit", consequentialDone: true,
  });
  assert.deepEqual(refused, { refused: "would_repeat_durable_write" });

  // Before the write, the same rewind is fine.
  const allowed = chooseRewind({
    steps, stepStartUrl, currentStepId: "s02",
    recoveredUrl: "http://x/review", consequentialDone: false,
  });
  assert.deepEqual(allowed, { index: 1 });

  // A page that only exists after the write rewinds only to itself.
  const after = chooseRewind({
    steps, stepStartUrl, currentStepId: "s04",
    recoveredUrl: "http://x/confirmation", consequentialDone: true,
  });
  assert.deepEqual(after, { index: 3 });
});

test("a permission refusal escalates rather than retrying", async () => {
  await app.reset();
  await app.scenario("force_403", "on");
  try {
    const result = await run("values/member-1002.json");
    // Non-interactive: the escalation path is taken but stays terminal.
    assert.equal(result.outcome, "aborted");
    assert.equal(result.reasonCode, "PERMISSION_DENIED");
    assert.equal(result.recoveries.filter((r) => r.kind === "transient_retry").length, 0);
    const member = await app.member("M-1002");
    assert.equal(member!.updated_at, null);
  } finally {
    await app.scenario("force_403", "off");
  }
});

test("an undeclared dialog escalates and nothing is written", async () => {
  await app.reset();
  await app.scenario("extra_dialog", "on");
  try {
    const result = await run("values/member-1002.json");
    assert.equal(result.reasonCode, "UNEXPECTED_DIALOG");
    assert.notEqual(result.outcome, "success");
    const member = await app.member("M-1002");
    assert.equal(member!.updated_at, null, "the dialog was dismissed, so no write happened");
  } finally {
    await app.scenario("extra_dialog", "off");
  }
});

test("a failure names the step, the expected state and the observed state", async () => {
  await app.reset();
  const cap = loadCapability(FIXTURE);
  // Point one step at a control that does not exist.
  const broken = structuredClone(cap);
  const step = broken.steps.find((s) => s.stepId === "s05")!;
  step.target = {
    role: "link",
    accessibleName: "Edit postal preferences",
    tagName: "a",
    candidates: [{ rank: 1, strategy: "role+name", expr: "link|Edit postal preferences" }],
  };
  const result = await replay({
    capability: broken,
    values: JSON.parse(readFileSync("values/member-1002.json", "utf8")),
    policy: app.policy,
    baseUrl: app.baseUrl,
    headless: true,
    profileDir: path.join(runRoot, "profile-broken"),
    approval: PRE_APPROVED,
    interactive: false,
    runRoot,
    secrets: OPERATOR_SECRETS,
  });

  assert.equal(result.outcome, "failure");
  assert.equal(result.reasonCode, "TARGET_UNRESOLVED");
  assert.equal(result.failure!.stepId, "s05");
  assert.equal(result.failure!.stepIndex, 5);
  assert.match(result.failure!.expected, /Edit postal preferences/);
  assert.ok(result.failure!.observed.length > 0);
  const member = await app.member("M-1002");
  assert.equal(member!.updated_at, null);
});

test("drift is reported when a step resolves through a weaker strategy", async () => {
  await app.reset();
  const broken = structuredClone(loadCapability(FIXTURE));
  const step = broken.steps.find((s) => s.stepId === "s03")!;
  // Rank 1 no longer matches, so the ladder must fall through to rank 2.
  step.target!.candidates = [
    { rank: 1, strategy: "role+name", expr: "button|Find member" },
    { rank: 2, strategy: "role+name", expr: "button|Search" },
  ];
  const result = await replay({
    capability: broken,
    values: JSON.parse(readFileSync("values/member-1002.json", "utf8")),
    policy: app.policy,
    baseUrl: app.baseUrl,
    headless: true,
    profileDir: path.join(runRoot, "profile-drift"),
    approval: PRE_APPROVED,
    interactive: false,
    runRoot,
    secrets: OPERATOR_SECRETS,
  });

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  assert.ok(result.drift.stepsResolvedBelowRank1.includes("s03"));
  assert.ok(result.drift.score > 0);
  assert.ok(result.recoveries.some((r) => r.kind === "candidate_fallthrough"));
});

test("a run refused by the safety policy is a safety violation, not a failure", async () => {
  await app.reset();
  const broken = structuredClone(loadCapability(FIXTURE));
  broken.steps.find((s) => s.stepId === "s01")!.value = { const: "/_admin/scenario" };
  const result = await replay({
    capability: broken,
    values: JSON.parse(readFileSync("values/member-1002.json", "utf8")),
    policy: app.policy,
    baseUrl: app.baseUrl,
    headless: true,
    profileDir: path.join(runRoot, "profile-safety"),
    approval: PRE_APPROVED,
    interactive: false,
    runRoot,
    secrets: OPERATOR_SECRETS,
  });

  assert.equal(result.outcome, "safety_violation");
  assert.equal(result.reasonCode, "ROUTE_NOT_ALLOWLISTED");
  assert.equal(result.safety!.rule, "route_allowlist");
  assert.equal(result.safety!.attempted, "/_admin/scenario");
});

test("a capability compiled from discovery tells a missing member from a failure", async () => {
  // Both runs are real: a successful one for M-1007, and one for M-9999 that
  // ended in MEMBER_NOT_FOUND. Without the second, the compiled artifact has
  // no recognizer and a missing member is just a step that could not run.
  const traceOf = (f: string) => DiscoveryTrace.parse(JSON.parse(readFileSync(f, "utf8")));
  const { capability } = compile(
    traceOf("tests/fixtures/update_mailing_address.readback.trace.json"),
    TaskContract.parse(JSON.parse(readFileSync("tasks/update-mailing-address.json", "utf8"))),
    {
      version: 1,
      createdAt: "2026-10-08T00:00:00.000Z",
      outcomes: [traceOf("tests/fixtures/member_not_found.trace.json")],
    },
  );

  await app.reset();
  const result = await run("values/member-missing.json", { capability });

  assert.equal(result.outcome, "business_outcome", JSON.stringify(result.failure));
  assert.equal(result.businessOutcome!.code, "MEMBER_NOT_FOUND");
  assert.equal(result.budgets.modelCalls, 0);
  assert.equal((await app.confirmations()).count, 0);
});
