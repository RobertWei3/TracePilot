// Manual takeover, end to end. The "person" here is a function that drives the
// same live browser through Playwright -- real clicks and typing, so the
// in-page recorder sees what it would see from a human -- and then answers the
// intervention. Nothing about the takeover path is stubbed.
//
// Approval is covered elsewhere and is deliberately not what these test: the
// spec is explicit that approving a write does not count as taking over.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { startApp, OPERATOR_SECRETS, type TestApp } from "./helpers/app.js";
import { ScriptedModel, pick, type Move } from "./helpers/scripted.js";
import { PRE_APPROVED, readBack, runDiscovery, task, throughSubmit, toReview } from "./helpers/discovery.js";
import { compile } from "../src/compiler/index.js";
import { DiscoveryTrace, type Capability, type TraceStep } from "../src/contracts/index.js";
import { loadCapability, replay } from "../src/replay/index.js";
import type { Operator } from "../src/handoff/index.js";

const M1002 = JSON.parse(readFileSync("values/member-1002.json", "utf8")) as {
  member_id: string;
  address: Record<string, string>;
};

type Event = { type: string; actor?: string; action?: string; valueRef?: string; reason?: string; outcome?: string };
const events = (logPath: string): Event[] =>
  readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Event);
const traceOf = (dir: string) =>
  DiscoveryTrace.parse(JSON.parse(readFileSync(path.join(dir, "trace.json"), "utf8")));

/** Four refusals in a row is policy's DEAD_END, which hands the run to a person. */
const stuck: Move[] = Array.from({ length: 4 }, () => () => ({
  action: "fill" as const,
  targetId: "obs1:el-1",
  inputName: "no.such.input",
  reason: "a proposal the loop refuses",
}));

/** What a person does on the edit form: type each field, then move on. */
async function fillAddressAndReview(page: Page): Promise<void> {
  const a = M1002.address;
  await page.locator("#l1").fill(a.line1!);
  await page.locator("#l2").fill(a.line2!);
  await page.locator("input[name=city]").fill(a.city!);
  await page.locator("input[name=state]").fill(a.state!);
  await page.locator("input[name=zip]").fill(a.zip!);
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.waitForURL(/\/review$/);
}

/** Answers each intervention in turn, after doing whatever the script says. */
function person(...turns: [(page: Page) => Promise<void>, Awaited<ReturnType<Operator>>][]): Operator {
  let i = 0;
  return async (_request, surface) => {
    const [act, answer] = turns[i++] ?? [async () => {}, "abort"];
    await act(surface.page);
    return answer;
  };
}

/** Moves up to the edit form, stopping before any field is filled. */
const toEdit = toReview.slice(0, 5);

test("fields a person typed during a takeover are in the approval diff", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // The person does everything from the search page on: the search box as
  // well as the address. The approval must show what the write will submit,
  // whoever typed it -- and the search box is not part of that, whoever typed
  // it either.
  let fields: { label: string; from: string }[] = [];
  const model = new ScriptedModel([
    toReview[0]!, // to the search page
    ...stuck,
    () => ({ action: "request_approval", reason: "about to write the new address" }),
    () => ({ action: "give_up", reason: "the diff is all this test needs" }),
  ]);
  let approvalId = "";
  const { store } = await runDiscovery({
    app,
    model,
    approval: { mode: "interactive" },
    operator: async (request, surface) => {
      if (request.kind === "approval_required") {
        fields = request.pendingChange!.fields;
        approvalId = request.interventionId;
        return "resume";
      }
      if (fields.length === 0 && request.kind === "discovery_blocked" && surface.page.url().endsWith("/search")) {
        const page = surface.page;
        await page.locator("input[name=q]").fill(M1002.member_id);
        await page.getByRole("button", { name: "Search" }).click();
        await page.getByRole("link", { name: "View" }).click();
        await page.getByRole("link", { name: "Edit mailing address" }).click();
        await page.waitForURL(/\/edit$/);
        await fillAddressAndReview(page);
        return "resume";
      }
      return "abort";
    },
  });

  const labels = fields.map((f) => f.label);
  assert.equal(labels.length, 5, JSON.stringify(labels));
  assert.ok(labels.every((l) => l.includes("Edit mailing address")), JSON.stringify(labels));
  // The recorder never saw the old contents, and the diff does not pretend it did.
  assert.ok(fields.every((f) => f.from === "(not read)"), JSON.stringify(fields.map((f) => f.from)));
  // Nor does the record on disk, which otherwise writes "(current value)".
  const persisted = JSON.parse(readFileSync(path.join(store.dir, `intervention-${approvalId}.json`), "utf8"));
  assert.ok(
    persisted.pendingChange.fields.every((f: { from: string }) => f.from === "(not read)"),
    JSON.stringify(persisted.pendingChange.fields),
  );
});

test("a takeover that spans pages records every action, as references", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([
    ...toEdit,
    ...stuck,
    // Control comes back on the review page the person navigated to.
    ...throughSubmit,
    ...readBack,
    () => ({ action: "done", reason: "address updated, read back and confirmation bound" }),
  ]);
  const { result, store } = await runDiscovery({
    app,
    model,
    operator: person([fillAddressAndReview, "resume"]),
  });

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));

  // The fills happened on the edit page and the click navigated away from it.
  // All six must survive the navigation, not just what the last page held.
  const human = traceOf(store.dir).steps.filter((s: TraceStep) => s.authoredBy === "human");
  assert.deepEqual(
    human.map((s) => (s.action === "fill" ? `fill ${JSON.stringify(s.value)}` : s.action)),
    [
      'fill {"input":"address.line1"}',
      'fill {"input":"address.line2"}',
      'fill {"input":"address.city"}',
      'fill {"input":"address.state"}',
      'fill {"input":"address.zip"}',
      "click",
    ],
  );

  // What the person did has to be replayable, not just recorded: compile the
  // run and replay it for another member. The recorder describes elements in
  // its own compact way, so this is where a drift between its descriptors and
  // the observer's would surface.
  const { capability } = compile(traceOf(store.dir), task, {
    version: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
  });
  assert.equal(capability.status, "needs_review", "human-authored steps must go to review");
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
  assert.equal((await app.member("M-1007"))!.city, "Petaluma");

  // Control ownership is on the record, in both directions.
  const transfers = events(store.logPath)
    .filter((e) => e.type === "control_transfer")
    .map((e) => e.reason ?? "");
  assert.ok(transfers.some((r) => r.startsWith("AGENT -> HUMAN")), transfers.join("\n"));
  assert.ok(transfers.some((r) => r.startsWith("HUMAN -> AGENT")), transfers.join("\n"));

  // Redaction must not eat the record's own vocabulary. A secret that is an
  // ordinary word ("operator" was the username) turned operator_response into
  // "[REDACTED:...]_response" and every "operator chose ..." with it.
  const all = events(store.logPath);
  assert.deepEqual(all.filter((e) => !/^[a-z_]+$/.test(e.type)).map((e) => e.type), []);
  assert.equal(transfers.some((r) => r.includes("REDACTED")), false, transfers.join("\n"));

  // The person typed real values; only references may reach the record.
  // Digests are masked first: hex contains short digit runs like "02445" by
  // coincidence, as the leakage test in discovery-loop.test.ts explains.
  const log = (readFileSync(store.logPath, "utf8") + readFileSync(path.join(store.dir, "trace.json"), "utf8"))
    .replace(/sha256:[0-9a-f]+/g, "sha256:*");
  for (const value of [M1002.address.line1!, M1002.address.city!, M1002.address.zip!]) {
    assert.equal(log.includes(value), false, `the record leaked "${value}"`);
  }
});

test("after control returns, the agent's own actions are not recorded as the person's", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // The person hands straight back; the agent then fills the form and gets
  // stuck again on the same page. The recorder's listeners are still in that
  // document, so the agent's typing is exactly what a recorder that kept its
  // buffer in the page would hand the second intervention as the person's.
  const model = new ScriptedModel([
    ...toEdit,
    ...stuck,
    ...toReview.slice(5, 10),
    ...stuck,
  ]);
  const { store } = await runDiscovery({
    app,
    model,
    operator: person([async () => {}, "resume"], [async () => {}, "abort"]),
  });
  assert.equal(
    events(store.logPath).filter((e) => e.type === "intervention_raised").length,
    2,
    "the scenario needs two takeovers",
  );

  const humanActions = events(store.logPath).filter((e) => e.type === "human_action");
  assert.deepEqual(humanActions, [], "the agent's actions were attributed to the person");
});

test("the agent's last typing is not attributed to the person who clicks after it", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // A field's change event fires when it loses focus. If the agent's last fill
  // left focus in the field, the person's first click is what blurs it -- and
  // the agent's typing would surface as the person's.
  const model = new ScriptedModel([
    ...toEdit,
    ...toReview.slice(5, 10),
    ...stuck,
    ...throughSubmit,
    ...readBack,
    () => ({ action: "done", reason: "address updated, read back and confirmation bound" }),
  ]);
  const { result, store } = await runDiscovery({
    app,
    model,
    operator: person([
      async (page) => {
        await page.getByRole("button", { name: "Review changes" }).click();
        await page.waitForURL(/\/review$/);
      },
      "resume",
    ]),
  });

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  const human = traceOf(store.dir).steps.filter((s: TraceStep) => s.authoredBy === "human");
  assert.deepEqual(human.map((s) => s.action), ["click"]);
});

test("a person can finish the workflow by hand, and success is still earned", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([...toEdit, ...stuck]);
  const { result, store } = await runDiscovery({
    app,
    model,
    operator: person([
      async (page) => {
        await fillAddressAndReview(page);
        await page.getByRole("button", { name: "Submit change" }).click();
        await page.waitForURL(/\/confirmation\//);
      },
      "complete",
    ]),
  });

  assert.equal(result.outcome, "success", JSON.stringify(result.failure));
  assert.match(result.outputs!.confirmation_id!, /^CONF-[A-Z0-9]{8}$/);
  assert.equal((await app.member("M-1002"))!.city, "Brookline");

  // A run a person finished cannot claim to be the agent's alone.
  const { capability } = compile(traceOf(store.dir), task, {
    version: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
  });
  assert.equal(capability.status, "needs_review");
});

test("an operator abort ends the run and writes nothing", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const model = new ScriptedModel([...toEdit, ...stuck]);
  const { result } = await runDiscovery({ app, model, operator: person([async () => {}, "abort"]) });

  assert.equal(result.outcome, "aborted");
  assert.equal(result.reasonCode, "OPERATOR_ABORTED");
  assert.equal((await app.confirmations()).count, 0);
});

// --- replay --------------------------------------------------------------

/**
 * The oracle with the Review button renamed, as if the application had
 * relabelled it. Replay cannot find it; a person can.
 */
function withBrokenReview(): Capability {
  const cap = loadCapability("tests/fixtures/update_mailing_address.v1.json");
  const step = cap.steps.find((s) => s.target?.accessibleName === "Review changes")!;
  step.target = {
    ...step.target!,
    accessibleName: "Preview changes",
    candidates: [{ rank: 1, strategy: "role+name", expr: "button|Preview changes" }],
  };
  return cap;
}

function runReplay(app: TestApp, capability: Capability, operator: Operator) {
  return replay({
    capability,
    values: JSON.parse(readFileSync("values/member-1002.json", "utf8")),
    policy: app.policy,
    baseUrl: app.baseUrl,
    headless: true,
    profileDir: path.join(app.profileDir, `replay-${Math.random().toString(36).slice(2)}`),
    approval: PRE_APPROVED,
    interactive: true,
    runRoot: path.join(app.profileDir, "runs"),
    secrets: OPERATOR_SECRETS,
    operator,
  });
}

test("replay hands an unresolvable step to a person, who does it, and replay carries on", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const result = await runReplay(
    app,
    withBrokenReview(),
    person([
      async (page) => {
        await page.getByRole("button", { name: "Review changes" }).click();
        await page.waitForURL(/\/review$/);
      },
      "step_done",
    ]),
  );

  assert.equal(result.lifecycle, "completed");
  assert.equal(result.outcome, "success", JSON.stringify(result.failure ?? result));
  assert.equal(result.budgets.modelCalls, 0);
  // step_done continues with the *next* step, which here is the approval gate.
  // Skipping it would have submitted without one.
  assert.equal(result.approvals.length, 1, "the approval gate after the hand-back must still run");
  assert.equal((await app.member("M-1002"))!.city, "Brookline");
});

test("replay accepts a workflow a person completed by hand, once its outputs are on the page", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const result = await runReplay(
    app,
    withBrokenReview(),
    person([
      async (page) => {
        await page.getByRole("button", { name: "Review changes" }).click();
        await page.getByRole("button", { name: "Submit change" }).click();
        await page.waitForURL(/\/confirmation\//);
      },
      "complete",
    ]),
  );

  assert.equal(result.outcome, "success", JSON.stringify(result.failure ?? result));
  assert.match(result.outputs!.confirmation_id!, /^CONF-[A-Z0-9]{8}$/);
  assert.equal((await app.confirmations()).count, 1, "written exactly once");
});

test("a hand-back that did not do the step goes back to the person, and writes nothing", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // "step_done" without doing it: the next step's precondition catches it,
  // and the run returns to the person instead of ending under them.
  const result = await runReplay(
    app,
    withBrokenReview(),
    person(
      [async () => {}, "step_done"],
      [
        async (page) => {
          await page.getByRole("button", { name: "Review changes" }).click();
          await page.waitForURL(/\/review$/);
        },
        "resume",
      ],
    ),
  );

  assert.equal(result.outcome, "success", JSON.stringify(result.failure ?? result));
  assert.equal(result.approvals.length, 1);
  assert.equal((await app.confirmations()).count, 1, "written exactly once, after the real hand-back");
});

test("replay refuses a write that no approval preceded, however it got there", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // An artifact whose gate has been stripped. The contract refuses to load
  // one, so this goes around it -- which is the point: the run-time guard is
  // what holds when some other path skips the gate.
  const cap = loadCapability("tests/fixtures/update_mailing_address.v1.json");
  cap.steps = cap.steps.filter((s) => s.action !== "approval_gate");
  const result = await runReplay(app, cap, person());

  assert.equal(result.outcome, "safety_violation");
  assert.equal(result.reasonCode, "APPROVAL_MISSING");
  assert.equal((await app.confirmations()).count, 0, "nothing may be written");
});

test("an overlong refusal shortens the intervention instead of crashing the hand-over", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // The refusal quotes the unknown input name, so this one runs far past the
  // request's 400-character reason. Found by a live run that crashed here.
  const long = `no.such.input.${"x".repeat(500)}`;
  const model = new ScriptedModel([
    ...toEdit,
    // A current, valid target, so the refusal is about the input name.
    ...Array.from({ length: 4 }, () => (tx: string) => ({
      action: "fill" as const,
      targetId: pick(tx, (r) => r.name === "Address line 1", "line1"),
      inputName: long,
      reason: "a proposal the loop refuses",
    })),
  ]);
  const { result } = await runDiscovery({ app, model });

  assert.equal(result.outcome, "aborted", JSON.stringify(result.failure));
  assert.equal(result.reasonCode, "DEAD_END");
});

/** Every text file a run wrote, as one string, with digests masked. */
function runText(dir: string): string {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = path.join(d, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".jpg") ? [] : [p];
    });
  return walk(dir)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n")
    .replace(/sha256:[0-9a-f]+/g, "sha256:*");
}

test("nothing a run writes to disk carries the subject's values, through approval and hand-over", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // An evidence scan found member ids in replay events' URLs, and the raw
  // approval diff and page text in persisted intervention requests. The
  // console may show a person real values; the record may not.
  let approvals = 0;
  const result = await runReplay(app, withBrokenReview(), async (request, surface) => {
    if (request.kind === "approval_required") {
      approvals += 1;
      return "resume";
    }
    await surface.page.getByRole("button", { name: "Review changes" }).click();
    await surface.page.waitForURL(/\/review$/);
    return "step_done";
  });
  assert.equal(result.outcome, "success", JSON.stringify(result.failure ?? result));

  const written = runText(result.evidenceDir);
  const values = ["M-1002", ...Object.values(M1002.address).filter((v) => v.length >= 3)];
  // The member's address before the change, from the seed data. ("Ashford"
  // alone would match the bank's own name, Ashford Mutual, in every title.)
  const before = ["418 Larkspur Way", "Ashford, OR", "97213"];
  for (const v of [...values, ...before]) {
    assert.equal(written.includes(v), false, `the run's record contains "${v}"`);
  }
  assert.match(written, /<input:member_id>/, "values should appear as references");
});
