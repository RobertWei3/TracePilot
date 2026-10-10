import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Capability, DiscoveryTrace, TaskContract, type ExecutionResult } from "../contracts/index.js";
import { loadPolicy, registerSecret } from "../safety/index.js";
import { Surface } from "../browser/index.js";
import { BudgetLedger, RunStore } from "../observability/index.js";
import { ControlLedger, OperatorConsole } from "../handoff/index.js";
import { flatten, type ApprovalMode, type ResolveContext } from "../workflow/index.js";
import { DiscoveryExecutor, allowedActions, modelFromEnv } from "../discovery/index.js";
import { CompileError, compile } from "../compiler/index.js";
import { loadCapability, loadValues, operatorSecrets, replay } from "../replay/index.js";
import { DiffError, diff, formatDiff, formatSummary, inspect } from "../inspect/index.js";

/**
 * The entry point for the three halves of the loop: discover a workflow with a
 * model, compile the run into a capability, and replay that capability with no
 * model at all. Two read-only commands sit beside them: inspect a capability,
 * and diff two versions of one.
 *
 * Its only job is wiring: it resolves the run's values and credentials, opens
 * one browser, and hands the executors the components they do not own.
 * Nothing here decides anything about the workflow -- which is why the same
 * executors run unchanged under test.
 */
function usage(): never {
  console.error(
    [
      "usage: npm run tp -- discover --task <file> --values <file> [options]",
      "       npm run tp -- compile  --run <dir> --task <file> [--outcomes <dir>,...] [--out <dir>]",
      "       npm run tp -- replay   --capability <file> --values <file> [options]",
      "       npm run tp -- inspect  --capability <file> [--json]",
      "       npm run tp -- diff     <a.json> <b.json>",
      "",
      "  --task    <file>   task contract, e.g. tasks/update-mailing-address.json",
      "  --values  <file>   input values, e.g. values/member-1002.json",
      "  --run     <dir>    a successful discovery run, e.g. runs/discovery-...",
      "  --outcomes <dirs>  comma-separated runs that ended in a business outcome; their",
      "                     verified recognizers are added so replay can tell them apart",
      "  --out     <dir>    where compiled capabilities go, default capabilities/",
      "  --capability <file>  a compiled capability, e.g. capabilities/<id>.v1.json",
      "  --json             inspect: print the summary as JSON",
      "",
      "diff exits 0 when the capabilities match, 1 when they differ, 2 on error.",
      "",
      "discover and replay:",
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

    printResult(result);
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

function printResult(result: ExecutionResult): void {
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
      result.drift.fingerprintMismatches.length
        ? `drift     : ${result.drift.fingerprintMismatches.length} step(s) no longer match their fingerprint: ${result.drift.fingerprintMismatches.join(", ")}`
        : "",
      `evidence  : ${result.evidenceDir}`,
      line,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/**
 * Trace -> capability. Deterministic and offline: no browser, no model. The
 * version is one past the highest already in the output directory, so an
 * earlier capability is never overwritten.
 */
function compileCmd(argv: string[]): number {
  const runDir = flag(argv, "--run");
  const taskFile = flag(argv, "--task");
  if (!runDir || !taskFile) usage();
  const outDir = flag(argv, "--out") ?? "capabilities";

  const readTrace = (dir: string) =>
    DiscoveryTrace.parse(JSON.parse(readFileSync(path.join(dir, "trace.json"), "utf8")));
  const trace = readTrace(runDir);
  const outcomes = (flag(argv, "--outcomes") ?? "").split(",").filter(Boolean).map(readTrace);
  const task = TaskContract.parse(JSON.parse(readFileSync(taskFile, "utf8")));

  mkdirSync(outDir, { recursive: true });
  const prefix = `${task.taskId}.v`;
  const versions = readdirSync(outDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => Number(f.slice(prefix.length, -".json".length)))
    .filter(Number.isInteger);
  const version = Math.max(0, ...versions) + 1;

  let compiled;
  try {
    compiled = compile(trace, task, { version, createdAt: new Date().toISOString(), outcomes });
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    console.error(`cannot compile ${runDir}: ${e.message}`);
    return 1;
  }
  const { capability, notes } = compiled;
  const file = path.join(outDir, `${prefix}${version}.json`);
  writeFileSync(file, JSON.stringify(capability, null, 2) + "\n", "utf8");

  console.log(`${capability.status}  ${file}  (${capability.steps.length} steps, from ${trace.runId})`);
  for (const n of notes) console.log(`  note: ${n}`);
  return 0;
}

async function replayCmd(argv: string[]): Promise<number> {
  const capFile = flag(argv, "--capability");
  const valuesFile = flag(argv, "--values");
  if (!capFile || !valuesFile) usage();

  const capability = loadCapability(capFile);
  const baseUrl = (flag(argv, "--base") ?? capability.origin).replace(/\/$/, "");
  const approvedBy = flag(argv, "--approved-by");
  const result = await replay({
    capability,
    values: loadValues(valuesFile),
    policy: loadPolicy(flag(argv, "--policy") ?? "policy.json"),
    baseUrl,
    headless: argv.includes("--headless"),
    slowMo: Number(flag(argv, "--slow") ?? 0) || undefined,
    onEvent: argv.includes("--quiet") ? undefined : printEvent,
    approval: approvedBy
      ? { mode: "pre_approved", approvedBy, at: new Date().toISOString() }
      : { mode: "interactive" },
    interactive: !argv.includes("--no-handoff"),
    secrets: operatorSecrets(),
  });
  printResult(result);
  return result.outcome === "success" ? 0 : 1;
}

/**
 * Read and validate a capability without the replay module, so the read-only
 * commands load nothing that runs a workflow. Errors name the file and the
 * schema paths that failed, never the values found there.
 */
function readCapability(file: string): Capability {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    const reason = e instanceof Error ? ((e as NodeJS.ErrnoException).code ?? e.name) : "error";
    console.error(`cannot read ${file}: ${reason}`);
    process.exit(2);
  }
  const parsed = Capability.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    console.error(`${file} is not a valid capability:\n  ${issues.join("\n  ")}`);
    process.exit(2);
  }
  return parsed.data;
}

function inspectCmd(argv: string[]): number {
  const capFile = flag(argv, "--capability");
  if (!capFile) usage();
  const summary = inspect(readCapability(capFile));
  console.log(argv.includes("--json") ? JSON.stringify(summary, null, 2) : formatSummary(summary));
  return 0;
}

/** Exit codes follow diff(1): 0 the same, 1 different, 2 trouble. */
function diffCmd(argv: string[]): number {
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length !== 2) usage();
  try {
    const d = diff(readCapability(files[0]!), readCapability(files[1]!));
    console.log(formatDiff(d));
    return d.identical ? 0 : 1;
  } catch (e) {
    if (!(e instanceof DiffError)) throw e;
    console.error(e.message);
    return 2;
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "discover") process.exit(await discover(rest));
  if (cmd === "compile") process.exit(compileCmd(rest));
  if (cmd === "replay") process.exit(await replayCmd(rest));
  if (cmd === "inspect") process.exit(inspectCmd(rest));
  if (cmd === "diff") process.exit(diffCmd(rest));
  usage();
}

await main();
