import test from "node:test";
import assert from "node:assert/strict";
import {
  checkAction, checkUrl, classifyEffect, loadPolicy, project, redact,
  registerSecret, clearSecrets, routeMatches, containsSecret,
} from "../src/safety/index.js";

const policy = loadPolicy();

test("the origin allowlist refuses other hosts", () => {
  const v = checkUrl(policy, "https://evil.example.com/members/M-1002");
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.rule, "origin_allowlist");
});

test("the route allowlist refuses the admin control surface", () => {
  const v = checkUrl(policy, "http://localhost:4000/_admin/scenario");
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.rule, "route_allowlist");
  assert.equal(v.ok === false && v.attempted, "/_admin/scenario");
});

test("allowlisted business routes pass", () => {
  for (const p of ["/", "/login", "/search", "/members/M-1002", "/members/M-1002/edit", "/confirmation/CONF-ABCD1234"]) {
    assert.equal(checkUrl(policy, `http://localhost:4000${p}`).ok, true, p);
  }
});

test("route globs do not span path segments", () => {
  assert.equal(routeMatches("/members/*", "/members/M-1002"), true);
  assert.equal(routeMatches("/members/*", "/members/M-1002/edit"), false);
  assert.equal(routeMatches("/members/*/edit", "/members/M-1002/edit"), true);
});

test("the action allowlist refuses undeclared actions", () => {
  assert.equal(checkAction(policy, "click").ok, true);
  assert.equal(checkAction(policy, "download").ok, false);
  assert.equal(checkAction(policy, "evaluate").ok, false);
});

test("effect classification is mechanical", () => {
  assert.equal(classifyEffect(policy, null), "reversible");
  assert.equal(classifyEffect(policy, { method: "GET", pathname: "/members/M-1002/submit" }), "reversible");
  assert.equal(classifyEffect(policy, { method: "POST", pathname: "/members/M-1002/review" }), "reversible");
  assert.equal(classifyEffect(policy, { method: "POST", pathname: "/members/M-1002/submit" }), "consequential");
});

test("registered secrets and PII shapes are redacted", (t) => {
  t.after(clearSecrets);
  registerSecret("demobank_password", "demo-pass-4417");
  assert.equal(redact("logging in with demo-pass-4417 now"), "logging in with [REDACTED:demobank_password] now");
  assert.match(redact("dob 123-45-6789"), /\[REDACTED:ssn\]/);
  assert.match(redact("key sk-ant-abc123456789"), /\[REDACTED:api_key\]/);
  assert.match(redact("cookie 5f2c9a10-3b4d-4e5f-8a9b-0c1d2e3f4a5b"), /\[REDACTED:session\]/);
});

test("the field allowlist drops anything not explicitly approved", (t) => {
  t.after(clearSecrets);
  registerSecret("pw", "demo-pass-4417");
  const record = {
    stepId: "s04",
    action: "fill",
    reason: "typing the password demo-pass-4417 into the field",
    rawModelResponse: { system: "secret prompt", messages: ["demo-pass-4417"] },
    headers: { cookie: "dbsid=abc" },
    nested: { keep: "yes", drop: "no" },
  };
  const out = project(record, { stepId: "string", action: "string", reason: "string", nested: { keep: "string" } });
  assert.deepEqual(Object.keys(out).sort(), ["action", "nested", "reason", "stepId"]);
  assert.equal("rawModelResponse" in out, false);
  assert.equal("headers" in out, false);
  assert.deepEqual(out.nested, { keep: "yes" });
  // Approved fields are still redacted.
  assert.equal(containsSecret(JSON.stringify(out)), false);
  assert.match(String(out.reason), /\[REDACTED:pw\]/);
});

test("a new upstream field cannot leak by default", () => {
  const out = project({ approved: "a", brandNewFieldSomeoneAdded: "secret-ish" }, { approved: "string" });
  assert.deepEqual(out, { approved: "a" });
});
