import test from "node:test";
import assert from "node:assert/strict";
import { Surface, describe as describeEl, summarize } from "../src/browser/index.js";
import { SafetyViolation } from "../src/safety/index.js";
import { startApp, OPERATOR_SECRETS, type TestApp } from "./helpers/app.js";

let app: TestApp;
let surface: Surface;

test.before(async () => {
  app = await startApp();
  surface = await Surface.launch({
    policy: app.policy,
    headless: true,
    profileDir: app.profileDir,
    inputs: { member_id: "M-1002", "address.city": "Brookline" },
    secrets: OPERATOR_SECRETS,
  });
  const signedIn = await surface.ensureSession(`${app.baseUrl}/login`, "demobank.operator");
  assert.equal(signedIn, true);
});

test.after(async () => {
  await surface.close();
  await app.stop();
});

test("observation reports regions, priorities and truncation metadata", async () => {
  await surface.navigate(`${app.baseUrl}/search?q=Whitfield`);
  const obs = await surface.observe();
  assert.ok(obs.elements.length > 0);
  assert.equal(obs.returned, obs.elements.length);
  assert.equal(typeof obs.truncated, "boolean");
  assert.equal(obs.totalEligible >= obs.returned, true);
  assert.ok(obs.regions.some((r) => r.name === "Results"));
  // Form controls outrank incidental page text.
  const first = obs.elements[0]!;
  assert.ok(first.priority <= 3, `expected an interactive element first, got ${first.role}`);
});

test("element ids are scoped to their observation", async () => {
  await surface.navigate(`${app.baseUrl}/`);
  const a = await surface.observe();
  const b = await surface.observe();
  assert.notEqual(a.obsId, b.obsId);
  assert.ok(a.elements[0]!.id.startsWith(`${a.obsId}:`));
  assert.equal(
    b.elements.some((e) => e.id.startsWith(`${a.obsId}:`)),
    false,
    "a later observation must not reuse an earlier observation's ids",
  );
});

test("input values are tagged in-page and never appear in an observation", async () => {
  await surface.navigate(`${app.baseUrl}/search?q=Whitfield`);
  const obs = await surface.observe();
  const serialized = JSON.stringify(obs);
  assert.equal(serialized.includes("M-1002"), false, "a raw input value reached the observation");
  assert.ok(serialized.includes("<input:member_id>"), "the value should appear as a tag");
});

test("an ambiguous control resolves via a parameterized row anchor", async () => {
  await surface.navigate(`${app.baseUrl}/search?q=Dana`);
  // The ambiguity that matters is in the DOM, which is what resolution faces.
  assert.equal(
    await surface.page.getByRole("link", { name: "View", exact: true }).count(),
    2,
    "the fixture should present two identical links",
  );

  const obs = await surface.observe();
  // Only the row this run is working on is readable; the other member's row is
  // redacted but still listed, so it stays addressable without being legible.
  const views = obs.elements.filter((e) => e.role === "link" && e.name === "View");
  assert.equal(views.length, 1, "only the anchored row's control should be named");
  assert.equal(
    obs.elements.filter((e) => e.role === "link" && e.redacted).length,
    1,
    "the other member's control should be present but redacted",
  );

  const anchored = describeEl(views[0]!, { anchorInput: "member_id" });
  const res = await surface.locate(anchored);
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.rank, 1, "the anchor should win at rank 1, not fall through");
  assert.match(summarize(anchored), /row for \{input:member_id\}/);

  const clicked = await surface.act("click", anchored);
  assert.equal(clicked.ok, true);
  assert.equal(surface.currentUrl(), `${app.baseUrl}/members/M-1002`);
});

test("controls whose caption is a bare div still resolve", async () => {
  await surface.navigate(`${app.baseUrl}/members/M-1002/edit`);
  const obs = await surface.observe();
  const boxes = obs.elements.filter((e) => e.role === "textbox");
  assert.equal(boxes.length, 5);
  for (const box of boxes) {
    const d = describeEl(box);
    const r = await surface.locate(d);
    assert.equal(r.ok, true, `unresolved: ${summarize(d)}`);
  }
  // City/State/ZIP have no accessible name at all, so they must come through
  // the caption-anchored strategy rather than role+name.
  const unnamed = boxes.filter((b) => !b.name);
  assert.equal(unnamed.length, 3);
});

test("a descriptor captured for one member resolves for another", async () => {
  // The container heading was tagged as "<input:member_id>" in-page, so the
  // same descriptor follows whichever member the run is parameterized with.
  await surface.navigate(`${app.baseUrl}/members/M-1002/edit`);
  const captured = describeEl(
    (await surface.observe()).elements.find((e) => e.name === "Address line 1")!,
  );
  assert.match(JSON.stringify(captured), /<input:member_id>/);

  const other = await Surface.launch({
    policy: app.policy,
    headless: true,
    profileDir: `${app.profileDir}-other`,
    inputs: { member_id: "M-1007" },
    secrets: OPERATOR_SECRETS,
  });
  try {
    await other.ensureSession(`${app.baseUrl}/login`, "demobank.operator");
    await other.navigate(`${app.baseUrl}/members/M-1007/edit`);
    const res = await other.locate(captured);
    assert.equal(res.ok, true, "the descriptor should retarget to the new member");
    assert.equal(res.ok && res.rank, 1);
  } finally {
    await other.close();
  }
});

test("the safety chokepoint refuses the admin surface at the driver level", async () => {
  await assert.rejects(
    () => surface.navigate(`${app.baseUrl}/_admin/scenario`),
    (e: unknown) => e instanceof SafetyViolation && e.rule === "route_allowlist",
  );
});

test("the safety chokepoint refuses another origin", async () => {
  await assert.rejects(
    () => surface.navigate("https://example.com/"),
    (e: unknown) => e instanceof SafetyViolation && e.rule === "origin_allowlist",
  );
});

test("screenshots are masked, and omitted when a mask cannot cover a sensitive field", async () => {
  await surface.navigate(`${app.baseUrl}/members/M-1002`);
  const ok = await surface.screenshot();
  assert.ok(ok.buffer, "a masked capture should succeed where masks cover the sensitive field");

  // Same page, policy with no mask selectors: capture must be refused rather
  // than written with the sensitive region exposed.
  const unmasked = await Surface.launch({
    policy: { ...app.policy, maskSelectors: [] },
    headless: true,
    profileDir: `${app.profileDir}-unmasked`,
    secrets: OPERATOR_SECRETS,
  });
  try {
    await unmasked.ensureSession(`${app.baseUrl}/login`, "demobank.operator");
    await unmasked.navigate(`${app.baseUrl}/members/M-1002`);
    const refused = await unmasked.screenshot();
    assert.equal(refused.buffer, null);
    assert.equal("omittedReason" in refused && refused.omittedReason, "mask_targets_unresolved");
  } finally {
    await unmasked.close();
  }
});

test("an undeclared dialog is recorded and never accepted", async () => {
  await app.scenario("extra_dialog", "on");
  try {
    await surface.navigate(`${app.baseUrl}/members/M-1002/edit`);
    const obs = await surface.observe();
    const boxes = obs.elements.filter((e) => e.role === "textbox");
    await surface.act("fill", describeEl(boxes[0]!), "12 Test Row");
    await surface.act("click", describeEl(obs.elements.find((e) => e.name === "Review changes")!));
    await surface.act(
      "click",
      describeEl((await surface.observe()).elements.find((e) => e.name === "Submit change")!),
    );
    const undeclared = surface.drainUndeclaredDialogs();
    assert.equal(undeclared.length, 1, "the dialog should have been recorded");
    assert.match(undeclared[0]!.message, /pending service request/);
    // Dismissed, so the consequential submit did not go through.
    const member = await app.member("M-1002");
    assert.notEqual(member!.line1, "12 Test Row");
  } finally {
    await app.scenario("extra_dialog", "off");
  }
});
