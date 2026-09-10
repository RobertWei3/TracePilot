import { readFileSync } from "node:fs";
import { Capability, type ExecutionResult, type Policy } from "../contracts/index.js";
import { Surface } from "../browser/index.js";
import { BudgetLedger, RunStore } from "../observability/index.js";
import { ControlLedger, OperatorConsole } from "../handoff/index.js";
import { flatten, type InputValues } from "../workflow/index.js";
import { registerSecret } from "../safety/index.js";
import { ReplayExecutor, type ApprovalMode } from "./executor.js";

export type ReplayRequest = {
  capability: Capability;
  values: InputValues;
  policy: Policy;
  /** Origin to run against; overrides the artifact's own for a local demo. */
  baseUrl?: string;
  headless?: boolean;
  profileDir?: string;
  approval: ApprovalMode;
  interactive: boolean;
  runRoot?: string;
  secrets?: Record<string, string>;
};

export function loadCapability(file: string): Capability {
  return Capability.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function loadValues(file: string): InputValues {
  return JSON.parse(readFileSync(file, "utf8")) as InputValues;
}

/** Credentials come from the environment and are registered for redaction. */
export function operatorSecrets(): Record<string, string> {
  const user = process.env.DEMOBANK_USER ?? "operator";
  const pass = process.env.DEMOBANK_PASS ?? "";
  const secrets = {
    "demobank.operator.user": user,
    "demobank.operator.password": pass,
  };
  registerSecret("demobank_password", pass);
  return secrets;
}

/**
 * One replay invocation. Owns the browser lifetime so the handoff console can
 * hand the same live window to a person without the process going away.
 */
export async function replay(req: ReplayRequest): Promise<ExecutionResult> {
  const baseUrl = req.baseUrl ?? req.capability.origin;
  const policy: Policy = { ...req.policy, allowedOrigins: [baseUrl] };
  const inputs = flatten(req.values);

  const store = new RunStore(
    `replay-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    req.runRoot ?? "runs",
  );
  const budgets = new BudgetLedger(policy.budgets);
  const surface = await Surface.launch({
    policy,
    headless: req.headless ?? false,
    profileDir: req.profileDir,
    inputs,
    secrets: req.secrets ?? operatorSecrets(),
  });
  const control = new ControlLedger(store);
  const operator = new OperatorConsole(
    surface,
    store,
    control,
    budgets,
    inputs,
    req.interactive,
  );

  try {
    return await new ReplayExecutor({
      capability: req.capability,
      surface,
      store,
      control,
      operator,
      budgets,
      ctx: { inputs, secrets: req.secrets ?? operatorSecrets(), policy },
      approval: req.approval,
      baseUrl,
      policy,
      interactive: req.interactive,
    }).run();
  } finally {
    await surface.close();
  }
}
