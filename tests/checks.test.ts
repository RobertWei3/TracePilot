// The assertion vocabulary is what stops a run reporting unearned success, so
// the cases that matter here are the ones where a check could pass while the
// page says otherwise, or crash instead of reporting.
import test from "node:test";
import assert from "node:assert/strict";
import { Surface } from "../src/browser/index.js";
import { evaluateCheck, UnresolvableValue } from "../src/workflow/index.js";
import type { Check, Descriptor } from "../src/contracts/index.js";
import { startApp, OPERATOR_SECRETS, type TestApp } from "./helpers/app.js";

let app: TestApp;
let surface: Surface;
const inputs = { member_id: "M-1002" };

test.before(async () => {
  app = await startApp();
  surface = await Surface.launch({
    policy: app.policy,
    headless: true,
    profileDir: app.profileDir,
    inputs,
    secrets: OPERATOR_SECRETS,
  });
  assert.equal(await surface.ensureSession(`${app.baseUrl}/login`, "demobank.operator"), true);
});

test.after(async () => {
  await surface.close();
  await app.stop();
});

const ctx = () => ({ inputs, secrets: {}, policy: app.policy });

/** Every candidate matches both "View" links, so nothing resolves uniquely. */
const ambiguous: Descriptor = {
  role: "link",
  tagName: "a",
  scope: { containerRole: "region", containerName: "Results" },
  candidates: [{ rank: 1, strategy: "structural", expr: "a[role=link]" }],
} as Descriptor;

test("an ambiguous descriptor is present, not absent", async () => {
  await surface.navigate(`${app.baseUrl}/search?q=Dana`);
  // Two identical View links: the descriptor cannot pick one, but the control
  // is plainly on the page. Reporting absence here would be unearned success.
  assert.equal(await surface.page.locator("a").count() > 1, true);

  const outcome = await evaluateCheck(surface, { kind: "element_absent", target: ambiguous } as Check, ctx());
  assert.equal(outcome.ok, false);
  assert.match(outcome.observed, /present \(\d+ matches/);
});

test("element_absent holds when nothing matches at all", async () => {
  await surface.navigate(`${app.baseUrl}/search?q=Dana`);
  const nowhere: Descriptor = {
    role: "button",
    accessibleName: "Delete member permanently",
    tagName: "button",
    candidates: [{ rank: 1, strategy: "role+name", expr: "button|Delete member permanently" }],
  } as Descriptor;
  const outcome = await evaluateCheck(surface, { kind: "element_absent", target: nowhere } as Check, ctx());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.observed, "absent");
});

test("a url pattern that cannot compile fails the check instead of throwing", async () => {
  await surface.navigate(`${app.baseUrl}/`);
  // Reached only by an artifact that bypassed contract validation; it must
  // still produce a check outcome rather than an exception the executor
  // rethrows, which would end a run with no result at all.
  const outcome = await evaluateCheck(
    surface,
    { kind: "url_matches", pattern: "/members/(" } as Check,
    ctx(),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.observed, /not a valid regular expression/);
});

test("a url pattern naming an unknown input is a broken reference", async () => {
  await surface.navigate(`${app.baseUrl}/`);
  // Left as a literal it would compile to a pattern that can never match, and
  // the run would blame the application rather than the artifact.
  await assert.rejects(
    () => evaluateCheck(surface, { kind: "url_matches", pattern: "/members/{typo}" } as Check, ctx()),
    (e: unknown) => e instanceof UnresolvableValue && /unknown input "typo"/.test((e as Error).message),
  );
});

test("a url pattern naming a declared input follows the parameter", async () => {
  await surface.navigate(`${app.baseUrl}/members/M-1002`);
  const outcome = await evaluateCheck(
    surface,
    { kind: "url_matches", pattern: "/members/{member_id}$" } as Check,
    ctx(),
  );
  assert.equal(outcome.ok, true);
});
