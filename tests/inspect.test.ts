// inspect and diff read capabilities and nothing else: no browser, no model,
// no writes. The two inputs are the hand-written oracle and the capability
// discovery actually compiled (evidence 03), which differ in step count, in
// how the approval diff is itemised, and in carrying fingerprints at all -- one
// of them damaged. That is the realistic case diff has to survive.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Capability } from "../src/contracts/index.js";
import { DiffError, diff, inspect } from "../src/inspect/index.js";

const load = (file: string) => Capability.parse(JSON.parse(readFileSync(file, "utf8")));
const oracle = load("tests/fixtures/update_mailing_address.v1.json");
const compiled = load("evidence/03-capability/demobank.update_mailing_address.v1.json");

test("inspect summarises the oracle's steps, writes and outputs", () => {
  const s = inspect(oracle);
  assert.equal(s.capabilityId, "demobank.update_mailing_address");
  assert.equal(s.status, "needs_review");
  assert.equal(s.steps.length, 15);
  assert.deepEqual(s.writeSteps, ["s13"]);
  assert.deepEqual(s.approvalGates, ["s12"]);
  assert.deepEqual(s.outputs, [
    { name: "confirmation_id", pattern: "^CONF-[A-Z0-9]{8}$", required: true, fromStep: "s14", extract: "text /CONF-[A-Z0-9]{8}/" },
  ]);
  assert.deepEqual(
    s.inputs.map((i) => [i.name, i.optional]),
    [["member_id", false], ["address.line1", false], ["address.line2", true], ["address.city", false], ["address.state", false], ["address.zip", false]],
  );
  assert.deepEqual(s.businessOutcomes.map((o) => o.code), ["MEMBER_NOT_FOUND", "ADDRESS_REJECTED"]);
});

test("diff of the oracle and the compiled capability reports the step count", () => {
  const d = diff(oracle, compiled);
  assert.equal(d.identical, false);
  assert.deepEqual([d.steps.countA, d.steps.countB], [15, 18]);
  assert.ok(d.steps.added.length >= 3, "the compiled capability has steps the oracle lacks");
  // The output is still bound by the extract step, which moved from s14 to
  // s16; aligned steps make that a non-change.
  assert.deepEqual(d.outputs.changed, []);
  assert.deepEqual(d.businessOutcomes.removed, ["ADDRESS_REJECTED"]);
});

test("a damaged fingerprint is reported, not thrown on", () => {
  const d = diff(oracle, compiled);
  const s06 = d.steps.changed.find((c) => c.b === "s06");
  assert.ok(s06, "Address line 1 aligns across both capabilities");
  const fp = s06.changes.find((c) => c.field === "surfaceFingerprint");
  assert.ok(fp);
  assert.match(fp.to, /malformed/);
});

test("a capability diffed against itself has no differences", () => {
  const d = diff(compiled, compiled);
  assert.equal(d.identical, true);
});

test("one inserted step is one addition, not a cascade of renumbered steps", () => {
  // The compiler numbers steps by position, so inserting one renames every
  // step after it. Alignment must not be fooled by that.
  const steps = structuredClone(compiled.steps);
  steps.splice(3, 0, { ...structuredClone(steps[2]!), reason: "search again" });
  const renumbered = steps.map((s, i) => ({ ...s, index: i, stepId: `s${String(i + 1).padStart(2, "0")}` }));
  const d = diff(compiled, { ...compiled, version: 2, steps: renumbered });
  assert.equal(d.steps.added.length, 1);
  assert.deepEqual(d.steps.removed, []);
  assert.deepEqual(d.steps.changed, []);
  assert.equal(d.identical, false);
});

test("a renamed button is one changed step, not a removal and an addition", () => {
  // The case T4's fingerprint warnings lead to: rediscover, recompile, diff.
  // The accessible name is part of the alignment key, so only the second
  // pass, which pairs same-shaped leftovers, keeps this readable.
  const steps = structuredClone(compiled.steps);
  const submit = steps.find((s) => s.stepId === "s14")!;
  submit.target = { ...submit.target!, accessibleName: "Confirm change" };
  submit.surfaceFingerprint = "sha256:0000000000000000";
  const d = diff(compiled, { ...compiled, version: 2, steps });
  assert.deepEqual(d.steps.added, []);
  assert.deepEqual(d.steps.removed, []);
  assert.deepEqual(d.steps.changed.map((c) => [c.a, c.b]), [["s14", "s14"]]);
  assert.deepEqual(
    d.steps.changed[0]!.changes.map((c) => c.field),
    ["target", "surfaceFingerprint"],
  );
});

test("capabilities for different workflows cannot be diffed", () => {
  assert.throws(() => diff(oracle, { ...compiled, capabilityId: "demobank.other" }), DiffError);
});
