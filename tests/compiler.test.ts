// The compiler is a pure function, so these tests need no browser. The trace is
// a real one: recorded by deepseek-flash against DemoBank for M-1002, kept
// verbatim so the compiler is held to what discovery actually emits rather
// than to a tidier hand-written imitation of it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CompileError, compile, urlPattern } from "../src/compiler/index.js";
import { DiscoveryTrace, TaskContract, type Capability, type Check } from "../src/contracts/index.js";
import { loadCapability } from "../src/replay/index.js";

const trace = DiscoveryTrace.parse(
  JSON.parse(readFileSync("tests/fixtures/update_mailing_address.trace.json", "utf8")),
);
const task = TaskContract.parse(JSON.parse(readFileSync("tasks/update-mailing-address.json", "utf8")));
const OPTS = { version: 1, createdAt: "2026-10-06T00:00:00.000Z" };
const ISSUED = trace.outputs.confirmation_id!;

test("a successful trace compiles to a ready capability, deterministically", () => {
  const a = compile(trace, task, OPTS);
  const b = compile(trace, task, OPTS);
  assert.deepEqual(a, b, "the same trace must always compile to the same artifact");
  assert.equal(a.capability.status, "ready");
  assert.equal(a.capability.provenance.runId, trace.runId);
  // Discovery's implicit opening load becomes an explicit first step.
  assert.equal(a.capability.steps[0]!.action, "navigate");
});

test("nothing this run was issued survives into the capability", () => {
  const { capability } = compile(trace, task, OPTS);
  assert.ok(JSON.stringify(trace).includes(ISSUED), "the fixture should carry the issued id");
  assert.equal(JSON.stringify(capability).includes(ISSUED), false, `${ISSUED} leaked into the artifact`);

  const extract = capability.steps.find((s) => s.action === "extract")!;
  assert.ok(extract.target!.candidates.length > 0);
  assert.equal(extract.target!.accessibleName, undefined);
});

test("URLs become parameterized patterns, cut open where an issued value was", () => {
  const { capability } = compile(trace, task, OPTS);
  const pre = capability.steps.flatMap((s) => s.precondition.map((c) => c.pattern));
  assert.ok(pre.includes("/members/{member_id}/edit$"));
  assert.ok(pre.includes("/search\\?q={member_id}$"), "query strings are escaped, not dropped");

  const submit = capability.steps.find((s) => s.effect === "consequential")!;
  assert.equal(submit.waitFor?.pattern, "/confirmation/CONF-");
  assert.equal(urlPattern("http://h/confirmation/CONF-9LY3M2HD", ["CONF-9LY3M2HD"]), "/confirmation/CONF-");
});

const templates = (format: string) => {
  const t = structuredClone(trace);
  t.steps.find((s) => s.action === "assert")!.checks = [
    { kind: "text_contains", value: { transform: { op: "template", format } } },
  ];
  return compile(t, task, OPTS)
    .capability.steps.flatMap((s) => s.checks)
    .map((c: Check) => c.value)
    .map((v) => (v && "transform" in v ? v.transform.format : v && "input" in v ? `input:${v.input}` : null));
};

test("a template naming an optional input is split so it holds when the input is empty", () => {
  const got = templates("{address.line1}, {address.line2}, {address.city}, {address.state} {address.zip}");
  assert.deepEqual(got.slice(0, 4), [
    "{address.line1}",
    "{address.city}",
    "{address.state} {address.zip}",
    "input:address.line2",
  ]);
  assert.equal(got.some((g) => g?.includes("{address.line2}")), false);
});

test("a template silent about an optional sibling is split too", () => {
  // Authored on a member with no second line; it holds only while there is none.
  const got = templates("{address.line1}, {address.city}, {address.state} {address.zip}");
  assert.deepEqual(got.slice(0, 3), ["{address.line1}", "{address.city}", "{address.state} {address.zip}"]);
});

test("a template with no optional input nearby is left whole", () => {
  assert.equal(templates("Member {member_id}")[0], "Member {member_id}");
});

test("only a successful run compiles", () => {
  assert.throws(() => compile({ ...trace, outcome: "aborted" }, task, OPTS), CompileError);
});

test("a target addressable only by its issued value sends the capability to review", () => {
  const pinned = structuredClone(trace);
  const extract = pinned.steps.find((s) => s.action === "extract")!;
  extract.target!.candidates = extract.target!.candidates.filter((c) => c.expr.includes(ISSUED));

  const { capability, notes } = compile(pinned, task, OPTS);
  assert.equal(capability.status, "needs_review");
  assert.equal(capability.steps.find((s) => s.action === "extract")!.unresolved, true);
  assert.ok(notes.some((n) => /needs review/.test(n)));
});

test("a check spelling out an issued value is dropped rather than compiled", () => {
  // Discovery refuses these now; a trace recorded before that rule may not.
  const stale = structuredClone(trace);
  const last = stale.steps.at(-1)!;
  last.checks = [{ kind: "text_contains", value: { const: `Confirmation ID ${ISSUED}` } }];

  const { capability, notes } = compile(stale, task, OPTS);
  assert.equal(JSON.stringify(capability).includes(ISSUED), false);
  assert.ok(notes.some((n) => /dropped a check/.test(n)));
});

// --- shape-equivalence with the oracle -------------------------------------
//
// P3's acceptance check from the V1 plan: a compiled artifact should be
// shape-equivalent to the hand-authored oracle -- same phases, same outputs
// bound, a comparable step count. Shape, not equality: the model takes its own
// route (an extra assertion here, a detour there), and that is fine as long as
// the workflow it describes is the same one.

type Shape = {
  phases: string[];
  outputs: string[];
  writes: number;
  gateBeforeWrite: boolean;
  written: string[];
  readsBack: boolean;
};

/** The input a value reference ultimately reads, through any transform. */
function inputOf(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  if ("input" in v) return (v as { input: string }).input;
  if ("transform" in v) return inputOf((v as { transform: { arg?: unknown } }).transform.arg);
  return null;
}

function referencedInputs(v: unknown): string[] {
  const direct = inputOf(v);
  if (direct) return [direct];
  const format = (v as { transform?: { format?: string } } | undefined)?.transform?.format ?? "";
  return [...format.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

function shapeOf(cap: Capability): Shape {
  const writeAt = cap.steps.findIndex((s) => s.effect === "consequential");
  const written = [
    ...new Set(cap.steps.filter((s) => s.action === "fill").map((s) => inputOf(s.value)).filter((n) => n?.startsWith("address."))),
  ].sort() as string[];
  return {
    phases: cap.steps.map((s) => s.phase).filter((p, i, all) => p !== all[i - 1]),
    outputs: Object.entries(cap.outputs).map(([name, o]) => `${name} ${o.pattern} ${o.source.extract.regex}`),
    writes: cap.steps.filter((s) => s.effect === "consequential").length,
    gateBeforeWrite: cap.steps.findIndex((s) => s.action === "approval_gate") < writeAt,
    written,
    // After the write, some check reads back a value that was written.
    readsBack: cap.steps
      .slice(writeAt + 1)
      .some((s) => s.checks.some((c) => referencedInputs(c.value).some((n) => written.includes(n)))),
  };
}

const oracle = loadCapability("tests/fixtures/update_mailing_address.v1.json");
const withReadBack = DiscoveryTrace.parse(
  JSON.parse(readFileSync("tests/fixtures/update_mailing_address.readback.trace.json", "utf8")),
);

test("a compiled run is shape-equivalent to the hand-authored oracle", () => {
  const { capability } = compile(withReadBack, task, OPTS);
  assert.deepEqual(shapeOf(capability), shapeOf(oracle));

  const ratio = capability.steps.length / oracle.steps.length;
  assert.ok(ratio >= 0.5 && ratio <= 2, `${capability.steps.length} steps against the oracle's ${oracle.steps.length}`);
});

test("a run recorded before read-back was required is not shape-equivalent, and says why", () => {
  // The first fixture's run stopped at the confirmation page. It is kept as
  // a record of the gap the read-back rule closed.
  const { capability } = compile(trace, task, OPTS);
  const shape = shapeOf(capability);
  assert.equal(shape.readsBack, false);
  assert.deepEqual({ ...shape, readsBack: true }, shapeOf(oracle));
});
