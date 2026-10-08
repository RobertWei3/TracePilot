// The exposure boundary. Every assertion here runs against the finished model
// payload, never against an intermediate object, because the payload is what
// would actually be transmitted.
//
// Canary values are planted through DemoBank's admin route rather than taken
// from the seed: "Ashford" is both a stored city and part of the bank's own
// name, so a scan for it would pass or fail for the wrong reason. A distinctive
// token makes "does this literal appear anywhere" a total, unambiguous check.
//
// No assertion message embeds payload text.
import test from "node:test";
import assert from "node:assert/strict";
import { MASK_COLOR, Surface, describe as describeEl, summarize } from "../src/browser/index.js";
import { buildModelPayload } from "../src/discovery/payload.js";
import { startApp, OPERATOR_SECRETS, type TestApp } from "./helpers/app.js";

let app: TestApp;
let surface: Surface;

/** The address this run is asking for, and is therefore entitled to see tagged. */
const INPUTS = {
  member_id: "M-1002",
  "address.line1": "1420 Windmere Crossing",
  "address.line2": "Suite 210",
  "address.city": "Brookline",
  "address.state": "MA",
  "address.zip": "02445",
};

/** Planted, unmistakable, and nothing like any legitimate page string. */
const STORED = {
  line1: "ZZCANARYSTREETQX",
  line2: "ZZCANARYUNITQX",
  city: "ZZCANARYCITYQX",
  state: "ZQ",
  zip: "90909",
};
const OTHER_MEMBER = { line1: "ZZOTHERSTREETQX", city: "ZZOTHERCITYQX", state: "ZR", zip: "80808" };

test.before(async () => {
  app = await startApp();
  surface = await Surface.launch({
    policy: app.policy,
    headless: true,
    profileDir: app.profileDir,
    inputs: INPUTS,
    secrets: OPERATOR_SECRETS,
  });
  assert.equal(await surface.ensureSession(`${app.baseUrl}/login`, "demobank.operator"), true);
});

test.after(async () => {
  await surface.close();
  await app.stop();
});

/**
 * /_admin/reset clears server-side sessions, so the shared Surface has to sign
 * in again afterwards or every later navigation lands on the expiry page.
 */
async function reset() {
  await app.reset();
  assert.equal(await surface.ensureSession(`${app.baseUrl}/login`, "demobank.operator"), true);
}

async function payload(note?: string) {
  const observation = await surface.observe();
  const screenshot = await surface.screenshot();
  return {
    result: buildModelPayload({
      observation,
      screenshot,
      inputs: INPUTS,
      policy: app.policy,
      ...(note ? { note } : {}),
    }),
    observation,
  };
}

/** Every planted literal, so a scan can be total rather than selective. */
const ALL_CANARIES = [...Object.values(STORED), ...Object.values(OTHER_MEMBER)];

function assertNoCanaries(text: string, label: string) {
  for (const c of ALL_CANARIES) {
    // The canary itself is safe to name; the payload is never printed.
    assert.equal(text.includes(c), false, `${label}: a planted value survived redaction`);
  }
}

test("canary 1: a stored address differing from the requested one is not disclosed", async () => {
  await reset();
  await app.setMember("M-1002", STORED);
  await surface.navigate(`${app.baseUrl}/members/M-1002/edit`);

  const { result } = await payload();
  assert.equal(result.blocked, false);
  if (result.blocked) return;

  // The stored address is exactly the case input tagging cannot reach: it is
  // not a supplied value, so nothing would have matched it.
  assertNoCanaries(result.text, "edit form");
  // The form is still describable: the agent must be able to work the page.
  assert.match(result.text, /Address line 1/);
  assert.match(result.text, /set, not a supplied value/);
});

test("canary 2: another member's record is redacted but their row stays addressable", async () => {
  await reset();
  await app.setMember("M-1002", STORED);
  await app.setMember("M-1021", OTHER_MEMBER);
  // Both Danas match, so the results table holds a row this run owns and a row
  // belonging to someone else.
  await surface.navigate(`${app.baseUrl}/search?q=Dana`);

  const { result } = await payload();
  assert.equal(result.blocked, false);
  if (result.blocked) return;

  assertNoCanaries(result.text, "search results");
  assert.match(result.text, /<other member>/);
  // Redacted does not mean unusable: the row must still be clickable by id.
  assert.match(result.text, /obs\d+:el-\d+ \| link \| View/);
});

test("canary 3: a sensitive value outside any input is masked, and its label survives", async () => {
  await reset();
  await surface.navigate(`${app.baseUrl}/members/M-1002`);

  const { result, observation } = await payload();
  assert.equal(result.blocked, false);
  if (result.blocked) return;

  // Date of birth sits in a data-sensitive <div>, never an input. Nothing about
  // input tagging or field values would have caught it.
  const member = (await app.member("M-1002")) as Record<string, string>;
  assert.equal(result.text.includes(member.dob!), false, "DOB reached the payload");
  assert.equal(result.text.includes(member.last_name!), false, "surname reached the payload");
  // The label stays, so the agent knows the field exists.
  assert.match(result.text, /Date of birth/);
  assert.equal(observation.selfCheck.ok, true);
});

test("canary 4: a supplied value stays verifiable without being shown", async () => {
  await reset();
  await app.setMember("M-1002", STORED);
  await surface.navigate(`${app.baseUrl}/members/M-1002/edit`);

  await surface.page.locator("#l1").fill(INPUTS["address.line1"]);
  await surface.page.locator("input[name=city]").fill(INPUTS["address.city"]);
  // Two characters: below the tagging threshold, so only whole-value comparison
  // can distinguish a correct fill from foreign data.
  await surface.page.locator("input[name=state]").fill(INPUTS["address.state"]);

  const { result } = await payload();
  assert.equal(result.blocked, false);
  if (result.blocked) return;

  assert.match(result.text, /matches address\.line1/);
  assert.match(result.text, /matches address\.city/);
  assert.match(result.text, /matches address\.state/);
  assert.equal(result.text.includes(INPUTS["address.line1"]), false);
  assert.equal(result.text.includes(INPUTS["address.city"]), false);
});

test("no supplied input value appears anywhere in a payload, at any length", async () => {
  await reset();
  await app.setMember("M-1002", STORED);
  for (const path of ["/", "/search?q=Dana", "/members/M-1002", "/members/M-1002/edit"]) {
    await surface.navigate(`${app.baseUrl}${path}`);
    const { result } = await payload();
    assert.equal(result.blocked, false, `${path} was blocked`);
    if (result.blocked) continue;
    for (const [name, value] of Object.entries(INPUTS)) {
      if (!value) continue;
      assert.equal(result.text.includes(value), false, `${path}: input ${name} was rendered`);
    }
    assertNoCanaries(result.text, path);
  }
});

test("the URL is redacted too, not just the page body", async () => {
  await reset();
  // The one string the builder used to pass through untouched. A path segment
  // naming the subject is the same disclosure as a heading naming them.
  await surface.navigate(`${app.baseUrl}/members/M-1002/edit`);
  const { result } = await payload();
  assert.equal(result.blocked, false);
  if (result.blocked) return;
  assert.match(result.text, /url: .*<input:member_id>/);
  assert.equal(result.text.includes("M-1002"), false);
});

test("the payload refuses to carry a value that escaped redaction", async () => {
  await reset();
  await surface.navigate(`${app.baseUrl}/members/M-1002`);
  const observation = await surface.observe();
  const screenshot = await surface.screenshot();

  // Simulate a redaction gap by declaring an input whose value is plainly on
  // the page and was never tagged. The guard must refuse rather than send.
  const result = buildModelPayload({
    observation,
    screenshot,
    inputs: { ...INPUTS, plan: "Premier Checking" },
    policy: app.policy,
  });
  assert.equal(result.blocked, true);
  if (!result.blocked) return;
  assert.match(result.reason, /reached the payload unredacted/);
  assert.equal(result.reason.includes("Premier Checking"), false, "the reason leaked the value");
});

test("an empty optional input does not block every observation", async () => {
  await reset();
  await surface.navigate(`${app.baseUrl}/members/M-1002/edit`);
  const observation = await surface.observe();
  const screenshot = await surface.screenshot();
  // "".includes is always true, so an unguarded scan would block here forever.
  const result = buildModelPayload({
    observation,
    screenshot,
    inputs: { ...INPUTS, "address.line2": "" },
    policy: app.policy,
  });
  assert.equal(result.blocked, false);
});

test("the sensitive region is masked in the image, not merely in the text", async () => {
  await reset();
  await surface.navigate(`${app.baseUrl}/members/M-1002`);

  const observation = await surface.observe();
  const box = await surface.page.locator("[data-sensitive]").first().boundingBox();
  assert.ok(box, "no sensitive element to check");
  const screenshot = await surface.screenshot();
  const result = buildModelPayload({ observation, screenshot, inputs: INPUTS, policy: app.policy });
  assert.equal(result.blocked, false);
  if (result.blocked) return;
  assert.ok(result.image, "no image was produced");

  assertMasked(await meanColour(result.image.data, box), "sensitive region");
});

test("the redaction marker does not outlive the capture that needs it", async () => {
  await reset();
  await surface.navigate(`${app.baseUrl}/search?q=Dana`);
  await surface.observe();
  await surface.screenshot();
  // The marker mutates the page under test, so it must not persist into the
  // rest of the run where descriptor resolution could start matching on it.
  const left = await surface.page.locator("[data-tp-redacted]").count();
  assert.equal(left, 0);
});

test("a descriptor for a redacted element carries no text and still resolves", async () => {
  await reset();
  await app.setMember("M-1021", OTHER_MEMBER);
  await surface.navigate(`${app.baseUrl}/search?q=Dana`);
  const obs = await surface.observe();

  const redacted = obs.elements.find((e) => e.role === "link" && e.redacted);
  assert.ok(redacted, "expected a redacted control to exist");
  const d = describeEl(redacted);

  // The placeholder must not become locator text. An artifact that froze
  // "<other member>" in as an accessible name would match nothing on replay,
  // and would read as a plausible descriptor in review.
  assert.equal(d.accessibleName, undefined);
  assert.equal(d.labelText, undefined);
  assert.equal(d.nearbyText, undefined);
  const serialized = JSON.stringify(d);
  assert.equal(serialized.includes("<other member>"), false);
  assert.equal(serialized.includes("<sensitive>"), false);
  for (const c of ALL_CANARIES) assert.equal(serialized.includes(c), false);

  // Unreadable must still mean actionable.
  const res = await surface.locate(d, 3000);
  assert.equal(res.ok, true, `redacted control did not resolve: ${summarize(d)}`);
});

/**
 * Mean colour of a region of a JPEG. Scanning text cannot verify an image, so
 * the bytes are decoded in the browser that is already running, which avoids
 * adding an image dependency.
 */
async function meanColour(jpeg: Buffer, rect: { x: number; y: number; width: number; height: number }) {
  return surface.page.evaluate(
    async ({ b64, rect }) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = `data:image/jpeg;base64,${b64}`;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      // Inset, so antialiasing at the mask edge cannot dominate the sample.
      const d = ctx.getImageData(
        Math.round(rect.x) + 2,
        Math.round(rect.y) + 2,
        Math.max(1, Math.round(rect.width) - 4),
        Math.max(1, Math.round(rect.height) - 4),
      ).data;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]!;
        g += d[i + 1]!;
        b += d[i + 2]!;
      }
      const n = d.length / 4;
      return { r: r / n, g: g / n, b: b / n };
    },
    { b64: jpeg.toString("base64"), rect },
  );
}

/** JPEG is lossy, so this is mean colour within tolerance, not exact pixels. */
function isMaskColour(mean: { r: number; g: number; b: number }): boolean {
  const target = Number.parseInt(MASK_COLOR.slice(1, 3), 16);
  return [mean.r, mean.g, mean.b].every((c) => Math.abs(c - target) < 24);
}

function assertMasked(mean: { r: number; g: number; b: number }, what: string): void {
  assert.ok(isMaskColour(mean), `${what} is not masked in the image (mean ${JSON.stringify(mean)})`);
}

test("a screenshot masks what the text records tag: credentials and input values", async () => {
  await reset();
  // The operator's username is in the header of every page, and the edit form
  // holds the new address once it is typed. Both were legible in evidence
  // screenshots while every text record had them redacted or tagged.
  await surface.navigate(`${app.baseUrl}/members/M-1002/edit`);
  await surface.page.locator("#l1").fill(INPUTS["address.line1"]);

  const user = (await surface.page.locator(".topbar span").nth(1).boundingBox())!;
  const typed = (await surface.page.locator("#l1").boundingBox())!;
  // Not the heading: "Edit mailing address — M-1002" shows the member id.
  const button = (await surface.page.getByRole("button", { name: "Review changes" }).boundingBox())!;
  const shot = await surface.screenshot();
  assert.ok(shot.buffer, "no image was produced");

  assertMasked(await meanColour(shot.buffer!, user), "the operator's username");
  assertMasked(await meanColour(shot.buffer!, typed), "a typed input value");
  // And not everything: the page's own furniture stays legible.
  assert.equal(isMaskColour(await meanColour(shot.buffer!, button)), false, "the Review button was masked too");
});
