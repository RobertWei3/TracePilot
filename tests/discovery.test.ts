// Action validation is the only thing standing between a model's output and a
// browser, so the tests here are about what it must refuse. A rejection costs
// one retry; the same mistake reaching replay costs a run that may already
// have written.
import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_NAMES, RawAction, actTool, allowedActions, validateAction } from "../src/discovery/actions.js";
import { renderObservation } from "../src/discovery/prompt.js";
import type { Observation } from "../src/browser/index.js";

const el = (id: string, over: Partial<Observation["elements"][number]> = {}) => ({
  id,
  role: "textbox",
  tagName: "input",
  name: "",
  labelText: "",
  nearbyText: "",
  valueVerdict: { kind: "empty" } as const,
  redacted: false,
  locatorKey: "div>input",
  submitTarget: null,
  regionId: "obs1:rg-0",
  regionName: "Edit mailing address",
  enabled: true,
  priority: 2,
  box: { x: 0, y: 0, w: 10, h: 10 },
  ...over,
});

const obs = (over: Partial<Observation> = {}): Observation => ({
  obsId: "obs1",
  url: "http://127.0.0.1:4000/members/M-1002/edit",
  title: "Edit",
  text: "Edit mailing address",
  textTruncated: false,
  elements: [el("obs1:el-1"), el("obs1:el-2", { role: "button", name: "Review changes" })],
  truncated: false,
  totalEligible: 2,
  returned: 2,
  offset: 0,
  regions: [{ regionId: "obs1:rg-0", name: "Edit mailing address", elementCount: 2, omitted: false }],
  dialogText: null,
  errorTexts: [],
  selfCheck: { ok: true, reason: null },
  ...over,
});

const inputNames = ["member_id", "address.city", "address.state"];
const outputNames = ["confirmation_id"];

const check = (partial: Record<string, unknown>, observation: Observation | null = obs()) =>
  validateAction(RawAction.parse({ reason: "because", ...partial }), {
    observation,
    inputNames,
    outputNames,
  });

test("navigate is confined to a path on the application under test", () => {
  // An absolute URL reaches the surface's policy chokepoint, which throws and
  // ends the run. A hallucinated host should cost one rejected action instead.
  assert.match(check({ action: "navigate", url: "https://example.com/x" })!.reason, /must be a path/);
  assert.match(check({ action: "navigate", url: "//example.com/x" })!.reason, /must be a path/);
  assert.equal(check({ action: "navigate", url: "/members/M-1002" }), null);
});

test("an assert pattern that cannot compile is refused at authoring time", () => {
  const bad = check({ action: "assert", assertKind: "url_matches", assertPattern: "/members/(" });
  assert.match(bad!.reason, /not a valid regular expression/);
  assert.equal(
    check({ action: "assert", assertKind: "url_matches", assertPattern: "/members/{member_id}$" }),
    null,
  );
});

test("placeholders naming no declared input are refused, in patterns and templates", () => {
  // Unchecked, both expand to a literal or throw at replay -- long after the
  // run that authored them, and against an application that did nothing wrong.
  assert.match(
    check({ action: "assert", assertKind: "url_matches", assertPattern: "/c/{typo}" })!.reason,
    /unknown input "typo"/,
  );
  assert.match(
    check({
      action: "assert",
      assertKind: "text_equals",
      assertTemplate: "{address.city}, {typo}",
    })!.reason,
    /unknown input "typo"/,
  );
  assert.equal(
    check({ action: "assert", assertKind: "text_equals", assertTemplate: "{address.city}, {address.state}" }),
    null,
  );
});

test("a template composing no input at all is a constant in disguise", () => {
  assert.match(
    check({ action: "assert", assertKind: "text_equals", assertTemplate: "Mailing address updated." })!.reason,
    /assertConst/,
  );
});

test("an element assertion is scoped to the current observation like any other target", () => {
  assert.match(
    check({ action: "assert", assertKind: "element_exists", targetId: "obs9:el-1" })!.reason,
    /belongs to an earlier observation/,
  );
  assert.match(
    check({ action: "assert", assertKind: "element_exists", targetId: "obs1:el-1" }, null)!.reason,
    /no current observation/,
  );
  assert.equal(check({ action: "assert", assertKind: "element_exists", targetId: "obs1:el-1" }), null);
});

test("nextBatch is refused when there is nothing to continue", () => {
  assert.match(check({ action: "observe", nextBatch: true }, null)!.reason, /not one yet/);
  assert.match(check({ action: "observe", nextBatch: true })!.reason, /no next batch/);
  const more = obs({ truncated: true, returned: 2, totalEligible: 40 });
  assert.equal(check({ action: "observe", nextBatch: true }, more), null);
});

test("the inventory reports a field's state without its contents", () => {
  // On an edit form the page text carries nothing about field contents, so
  // without this column the agent cannot confirm a fill landed. What it gets is
  // a verdict: enough to verify, never the value itself.
  const rendered = renderObservation(
    obs({
      elements: [
        el("obs1:el-1", { nearbyText: "City", valueVerdict: { kind: "matches", input: "address.city" } }),
        el("obs1:el-2", { nearbyText: "State", valueVerdict: { kind: "unsupplied" } }),
        el("obs1:el-3", { nearbyText: "Date of birth", valueVerdict: { kind: "masked" } }),
      ],
    }),
  );
  assert.match(rendered, /matches address\.city/);
  assert.match(rendered, /set, not a supplied value/);
  assert.match(rendered, /sensitive, masked/);
});

test("an omitted region is named as omitted rather than passed over", () => {
  const rendered = renderObservation(
    obs({ regions: [{ regionId: "obs1:rg-9", name: "<omitted>", elementCount: 0, omitted: true }] }),
  );
  assert.match(rendered, /OMITTED \(sensitive, no safe representation\)/);
});

test("the grammar offered to the model is what policy permits, and nothing more", () => {
  // policy.allowedActions is the whole system's vocabulary, including step
  // kinds only replay emits. Offering those in the tool schema would advertise
  // actions the action parser rejects, costing a turn each time one is taken
  // up -- so the two lists are derived from one intersection.
  const full = allowedActions({
    allowedActions: ["navigate", "click", "fill", "waitFor", "select", "approval_gate", "read_back", "done"],
  });
  assert.deepEqual(full, ["navigate", "click", "fill", "done"]);
  for (const name of full) assert.ok(ACTION_NAMES.includes(name));

  // A withheld action is unrepresentable, not merely refused.
  const narrowed = allowedActions({ allowedActions: ["observe", "navigate", "give_up"] });
  const schema = actTool(narrowed).input_schema.properties.action.enum;
  assert.deepEqual([...schema], ["observe", "navigate", "give_up"]);
});

test("a business outcome must name a code and carry a recognizer", () => {
  assert.match(check({ action: "business_outcome", assertKind: "text_contains", assertConst: "x" })!.reason, /requires outcomeCode/);
  assert.match(
    check({ action: "business_outcome", outcomeCode: "not upper", assertKind: "text_contains", assertConst: "x" })!.reason,
    /upper-case letters/,
  );
  // The recognizer is held to exactly the rules an assertion is.
  assert.match(
    check({ action: "business_outcome", outcomeCode: "MEMBER_NOT_FOUND" })!.reason,
    /requires assertKind/,
  );
  assert.equal(
    check({
      action: "business_outcome",
      outcomeCode: "MEMBER_NOT_FOUND",
      assertKind: "text_contains",
      assertConst: "No members matched that search.",
    }),
    null,
  );
});
