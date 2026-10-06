import { readFileSync } from "node:fs";
import path from "node:path";
import { TaskContract } from "../contracts/index.js";
import { loadPolicy, registerSecret } from "../safety/index.js";
import { Surface } from "../browser/index.js";
import { BudgetLedger, RunStore } from "../observability/index.js";
import { ControlLedger, OperatorConsole } from "../handoff/index.js";
import { flatten, type ApprovalMode, type ResolveContext } from "../workflow/index.js";
import { DiscoveryExecutor, allowedActions, modelFromEnv } from "../discovery/index.js";

/**
 * The discovery entry point.
 *
 * Its only job is wiring: it resolves the run's values and credentials, opens
 * one browser, and hands the loop the components it does not own. Nothing here
 * decides anything about the workflow -- which is why the same executor runs
 * unchanged under test with a scripted model.
 */
function usage(): never {
  console.error(
    [
      "usage: npm run tp -- discover --task <file> --values <file> [options]",
      "",
      "  --task    <file>   task contract, e.g. tasks/update-mailing-address.json",
      "  --values  <file>   input values, e.g. values/member-1002.json",
      "  --policy  <file>   default policy.json",
      "  --base    <url>    application origin, default http://localhost:4000",
      "  --headed           show the browser (default; --headless to hide it)",
      "  --slow    <ms>     pause before each browser operation, to watch it work",
      "  --quiet            do not print each step as it happens",
      "  --no-handoff       never prompt: escalations end the run, for CI",
      "  --approved-by <who>  authorise the write in advance, for unattended runs",
    ].join("\n"),
  );
  process.exit(2);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function discover(argv: string[]): Promise<number> {
  const taskFile = flag(argv, "--task");
  const valuesFile = flag(argv, "--values");
  if (!taskFile || !valuesFile) usage();

  const policy = loadPolicy(flag(argv, "--policy") ?? "policy.json");
  const task = TaskContract.parse(JSON.parse(readFileSync(taskFile, "utf8")));
  const values = JSON.parse(readFileSync(valuesFile, "utf8")) as Record<string, unknown>;
  const inputs = flatten(values);
  const baseUrl = (flag(argv, "--base") ?? new URL(task.targetUrl).origin).replace(/\/$/, "");
  const interactive = !argv.includes("--no-handoff");
  const approvedBy = flag(argv, "--approved-by");
  const approval: ApprovalMode = approvedBy
    ? { mode: "pre_approved", approvedBy, at: new Date().toISOString() }
    : { mode: "interactive" };

  // Credentials are resolved here and handed to the browser layer, which is the
  // only thing that ever sees them. They are registered for redaction first, so
  // that a leak into any writer is masked rather than merely unlikely.
  const secrets: Record<string, string> = {};
  const ref = task.requires.session?.credentialRef;
  if (ref) {
    const user = process.env.DEMOBANK_USER;
    const pass = process.env.DEMOBANK_PASS;
    if (!user || !pass) {
      console.error(`${ref} needs DEMOBANK_USER and DEMOBANK_PASS in the environment`);
      return 2;
    }
    secrets[`${ref}.user`] = user;
    secrets[`${ref}.password`] = pass;
    registerSecret(`${ref}.password`, pass);
  }

  const allowed = allowedActions(policy);
  const model = modelFromEnv(allowed);

  const surface = await Surface.launch({
    policy: { ...policy, allowedOrigins: [new URL(baseUrl).origin] },
    headless: argv.includes("--headless"),
    slowMo: Number(flag(argv, "--slow") ?? 0) || undefined,
    inputs,
    secrets,
  });

  const store = new RunStore(surface.newRunId("discovery"));
  if (!argv.includes("--quiet")) store.onEvent = printEvent;
  const budgets = new BudgetLedger(policy.budgets);
  const control = new ControlLedger(store);
  const operator = new OperatorConsole(surface, store, control, budgets, inputs, interactive);
  const ctx: ResolveContext = { inputs, secrets, policy };

  try {
    const result = await new DiscoveryExecutor({
      task,
      surface,
      store,
      control,
      operator,
      budgets,
      model,
      ctx,
      policy: { ...policy, allowedOrigins: [new URL(baseUrl).origin] },
      baseUrl,
      approval,
      interactive,
    }).run();

    const line = "-".repeat(72);
    console.log(
      [
        "",
        line,
        `${result.outcome} [${result.reasonCode}]  run ${result.runId}`,
        line,
        `outputs   : ${JSON.stringify(result.outputs ?? {})}`,
        result.businessOutcome ? `business  : ${result.businessOutcome.code}` : "",
        `budgets   : ${result.budgets.actionSteps} steps | ${result.budgets.observations} observations | ${result.budgets.modelCalls} model calls`,
        `fragility : ${result.drift.stepsResolvedBelowRank1.length} step(s) below rank 1 (${result.drift.score.toFixed(2)})`,
        `evidence  : ${result.evidenceDir}`,
        line,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return result.outcome === "success" ? 0 : 1;
  } finally {
    await surface.close();
  }
}

/**
 * One line per event, as it happens. It prints the sanitized record the store
 * just wrote, so watching a run shows nothing the evidence directory does not.
 */
function printEvent(e: Record<string, unknown>): void {
  const time = String(e.at ?? "").slice(11, 19);
  const type = String(e.type ?? "");
  const mark = type === "action_rejected" ? "✗" : type === "step_recorded" ? "✓" : "·";
  const what = [e.action, e.reason].filter(Boolean).join(" -- ");
  const where = typeof e.url === "string" ? `  @ ${decodeURIComponent(new URL(e.url).pathname)}` : "";
  console.log(`${time} ${mark} ${type.padEnd(22)} ${what}${where}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "discover") usage();
  process.exit(await discover(argv.slice(1)));
}

await main();
