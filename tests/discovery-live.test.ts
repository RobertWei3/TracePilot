// The scripted tests prove the loop's seams hold. They cannot tell you whether
// the prompt actually works, because the script never reads it. This one does:
// a real model, the real contract, the real application, nothing rehearsed.
//
// It is skipped without an API key, and it never gates CI -- a model's judgement
// is not a regression surface, and a flaky exit here would train people to
// ignore the suite.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startApp, OPERATOR_SECRETS } from "./helpers/app.js";
import { TaskContract, type Policy } from "../src/contracts/index.js";
import { Surface } from "../src/browser/index.js";
import { BudgetLedger, RunStore } from "../src/observability/index.js";
import { ControlLedger, OperatorConsole } from "../src/handoff/index.js";
import { flatten, type ApprovalMode } from "../src/workflow/index.js";
import { DiscoveryExecutor, allowedActions, modelFromEnv } from "../src/discovery/index.js";

const live = Boolean(process.env.ANTHROPIC_API_KEY);

test(
  "a real model completes the workflow from the goal alone",
  { skip: live ? false : "ANTHROPIC_API_KEY is not set", timeout: 300_000 },
  async (t) => {
    const app = await startApp();
    t.after(() => app.stop());

    const task = TaskContract.parse(
      JSON.parse(readFileSync("tasks/update-mailing-address.json", "utf8")),
    );
    const inputs = flatten(
      JSON.parse(readFileSync("values/member-1007.json", "utf8")) as Record<string, unknown>,
    );
    const secrets = { ...OPERATOR_SECRETS };
    const policy: Policy = app.policy;

    const surface = await Surface.launch({
      policy,
      headless: true,
      profileDir: path.join(app.profileDir, "live"),
      inputs,
      secrets,
    });
    const store = new RunStore(surface.newRunId("live"), path.join(app.profileDir, "runs"));
    const budgets = new BudgetLedger(policy.budgets);
    const control = new ControlLedger(store);
    const operator = new OperatorConsole(surface, store, control, budgets, inputs, false);
    const approval: ApprovalMode = {
      mode: "pre_approved",
      approvedBy: "live-smoke",
      at: new Date().toISOString(),
    };

    try {
      const result = await new DiscoveryExecutor({
        task: { ...task, targetUrl: `${app.baseUrl}/` },
        surface,
        store,
        control,
        operator,
        budgets,
        model: modelFromEnv(allowedActions(policy)),
        ctx: { inputs, secrets, policy },
        policy,
        baseUrl: app.baseUrl,
        approval,
        interactive: false,
      }).run();

      console.log(
        `live run: ${result.outcome} [${result.reasonCode}] in ${result.budgets.modelCalls} model calls`,
      );
      assert.equal(result.outcome, "success", JSON.stringify(result.failure ?? {}, null, 2));
      assert.match(result.outputs!.confirmation_id!, /^CONF-[A-Z0-9]{8}$/);

      // The point of the run is the application's state, not the transcript.
      const member = (await app.member("M-1007"))!;
      assert.equal(member.city, "Petaluma");
      assert.equal(member.state, "CA");
      assert.equal(member.zip, "94952");
    } finally {
      await surface.close();
    }
  },
);
