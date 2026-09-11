import test from "node:test";
import assert from "node:assert/strict";
import { Capability, ExecutionResult, InterventionRequest, Policy, jsonSchemas } from "../src/contracts/index.js";
import { readFileSync } from "node:fs";

const baseCap = () => ({
  schemaVersion: "1.0.0" as const,
  capabilityId: "demobank.update_mailing_address",
  version: 1,
  createdAt: new Date().toISOString(),
  status: "ready" as const,
  surfaceKind: "web" as const,
  tenantId: null,
  overrides: null,
  origin: "http://localhost:4000",
  requires: { session: { credentialRef: "demobank.operator", loginUrl: "/login" } },
  inputs: { member_id: { type: "string" as const } },
  outputs: {
    confirmation_id: {
      type: "string" as const,
      pattern: "^CONF-[A-Z0-9]{8}$",
      required: true,
      source: { stepId: "s03", extract: { kind: "text" as const, regex: "CONF-[A-Z0-9]{8}" } },
    },
  },
  steps: [
    {
      stepId: "s01",
      index: 1,
      phase: "review" as const,
      action: "approval_gate" as const,
      effect: "reversible" as const,
      diffFields: [{ label: "City", value: { input: "address.city" } }],
    },
    {
      stepId: "s02",
      index: 2,
      phase: "submit" as const,
      action: "click" as const,
      effect: "consequential" as const,
      target: {
        role: "button",
        accessibleName: "Submit",
        tagName: "button",
        candidates: [{ rank: 1, strategy: "role+name" as const, expr: "button|Submit" }],
      },
    },
    {
      stepId: "s03",
      index: 3,
      phase: "verify" as const,
      action: "extract" as const,
      effect: "reversible" as const,
      extractAs: "confirmation_id",
      target: {
        role: "generic",
        accessibleName: "Confirmation",
        tagName: "span",
        candidates: [{ rank: 1, strategy: "text-scoped" as const, expr: "CONF-" }],
      },
      checks: [{ kind: "text_contains" as const, target: {
        role: "generic", tagName: "span",
        candidates: [{ rank: 1, strategy: "text-scoped" as const, expr: "CONF-" }],
      }, value: { const: "CONF-" } }],
    },
  ],
  provenance: {
    runId: "r1",
    model: "claude-sonnet-5",
    authoredBy: { agent: 3, human: 0 },
    appFingerprint: "sha256:abc",
  },
});

test("a well-formed capability validates", () => {
  const parsed = Capability.parse(baseCap());
  assert.equal(parsed.steps.length, 3);
});

test("a consequential step with no preceding approval gate fails compilation", () => {
  const cap = baseCap();
  cap.steps = cap.steps.filter((s) => s.action !== "approval_gate");
  const res = Capability.safeParse(cap);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error), /no preceding approval_gate/);
});

test("an unbound required output fails compilation", () => {
  const cap = baseCap();
  cap.steps = cap.steps.map((s) => (s.action === "extract" ? { ...s, extractAs: "something_else" } : s));
  const res = Capability.safeParse(cap);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error), /is not bound by any extract step/);
});

test("a capability with no post-submit check fails compilation", () => {
  const cap = baseCap();
  cap.steps = cap.steps.map((s) => (s.action === "extract" ? { ...s, checks: [] } : s));
  const res = Capability.safeParse(cap);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error), /unearned success/);
});

test("a url pattern that cannot compile is rejected at validation", () => {
  // Caught here, a malformed artifact never launches a browser. Caught at the
  // step that runs it, the regex throws out of the executor, which returns no
  // result and writes no result.json.
  const cap = baseCap();
  const verify = cap.steps.find((s) => s.action === "extract")!;
  (verify as { checks: unknown[] }).checks = [{ kind: "url_matches", pattern: "/confirmation/(" }];
  const res = Capability.safeParse(cap);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error), /not a valid regular expression/);
});

test("a url pattern carrying input placeholders still validates", () => {
  const cap = baseCap();
  const verify = cap.steps.find((s) => s.action === "extract")!;
  (verify as { checks: unknown[] }).checks = [{ kind: "url_matches", pattern: "/members/{member_id}$" }];
  assert.equal(Capability.safeParse(cap).success, true);
});

test("human-authored steps force needs_review", () => {
  const cap = baseCap();
  cap.steps = cap.steps.map((s) => (s.stepId === "s02" ? { ...s, authoredBy: "human" as const } : s));
  const res = Capability.safeParse(cap);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error), /needs_review/);
});

test("an unsupported transform is rejected", () => {
  const cap = baseCap();
  cap.steps[0]!.diffFields = [{ label: "City", value: { transform: { op: "geocode" } } as never }];
  assert.equal(Capability.safeParse(cap).success, false);
});

test("awaiting_human must not carry a terminal outcome", () => {
  const base = {
    schemaVersion: "1.0.0" as const,
    runId: "r1",
    kind: "replay" as const,
    lifecycle: "awaiting_human" as const,
    outcome: "failure" as const,
    reasonCode: "AWAITING_HUMAN" as const,
    drift: { stepsResolvedBelowRank1: [], score: 0 },
    budgets: { actionSteps: 1, observations: 1, modelCalls: 0, activeMs: 1, humanWaitMs: 0 },
    startedAt: "t", endedAt: "t", evidenceDir: "e",
  };
  const res = ExecutionResult.safeParse(base);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error), /must not carry a terminal outcome/);
});

test("success without declared outputs is rejected", () => {
  const res = ExecutionResult.safeParse({
    schemaVersion: "1.0.0", runId: "r1", kind: "replay",
    lifecycle: "completed", outcome: "success", reasonCode: "OK",
    drift: { stepsResolvedBelowRank1: [], score: 0 },
    budgets: { actionSteps: 1, observations: 1, modelCalls: 0, activeMs: 1, humanWaitMs: 0 },
    startedAt: "t", endedAt: "t", evidenceDir: "e",
  });
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error), /must return declared outputs/);
});

test("failure must name step, expected and observed", () => {
  const res = ExecutionResult.safeParse({
    schemaVersion: "1.0.0", runId: "r1", kind: "replay",
    lifecycle: "completed", outcome: "failure", reasonCode: "CHECK_FAILED",
    drift: { stepsResolvedBelowRank1: [], score: 0 },
    budgets: { actionSteps: 1, observations: 1, modelCalls: 0, activeMs: 1, humanWaitMs: 0 },
    startedAt: "t", endedAt: "t", evidenceDir: "e",
  });
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error), /expected and observed/);
});

test("an approval request must show the pending change", () => {
  const res = InterventionRequest.safeParse({
    schemaVersion: "1.0.0", interventionId: "iv1", runId: "r1", kind: "approval_required",
    subject: { goalSummary: "g" },
    step: { stepId: "s02", index: 2, action: "click", targetSummary: "Submit" },
    currentState: { url: "u", title: "t", visibleSummary: "v", screenshotRef: null },
    expected: "e", observed: "o", reason: "r", reasonCode: "OK",
    budgetsRemaining: { actionSteps: 1, observations: 1, modelCalls: 1, wallClockMs: 1 },
    allowedResponses: ["resume"], createdAt: "t",
  });
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error), /must show the pending change/);
});

test("policy.json validates against the Policy contract", () => {
  const parsed = Policy.parse(JSON.parse(readFileSync("policy.json", "utf8")));
  // /_admin is deliberately absent so agents cannot reach scenario controls.
  assert.ok(!parsed.allowedRoutes.some((r) => r.startsWith("/_admin")));
});

test("every contract emits a JSON Schema", () => {
  for (const [name, emit] of Object.entries(jsonSchemas)) {
    const schema = emit() as Record<string, unknown>;
    assert.ok(schema["$ref"] || schema["definitions"], `${name} emitted nothing usable`);
  }
});
