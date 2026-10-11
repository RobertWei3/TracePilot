import { isEmpty, type CapabilityDiff, type FieldChange, type KeyedChanges } from "./diff.js";
import type { InspectSummary, StepSummary } from "./summary.js";

/**
 * Terminal renderings. They print the structured summaries and nothing else,
 * so the text shows no more than `--json` would.
 */

export function formatSummary(summary: InspectSummary): string {
  const prov = summary.provenance;
  const lines = [
    `${summary.capabilityId} v${summary.version}  [${summary.status}]`,
    `origin     : ${summary.origin}`,
    summary.session ? `session    : ${summary.session.credentialRef} via ${summary.session.loginUrl}` : "",
    `created    : ${summary.createdAt}`,
    `provenance : run ${prov.runId} | model ${prov.model} | ${prov.authoredBy.agent} agent, ${prov.authoredBy.human} human step(s)`,
    prov.outcomeRunIds.length ? `outcomes   : learned from ${prov.outcomeRunIds.join(", ")}` : "",
    "",
    "inputs",
    ...summary.inputs.map(
      (i) => `  ${i.name.padEnd(20)} ${i.type}${i.optional ? "  optional" : ""}${i.sensitive ? "  sensitive" : ""}`,
    ),
    "",
    "outputs",
    ...summary.outputs.map(
      (o) =>
        `  ${o.name.padEnd(20)} ${o.pattern ?? "(any)"}  from ${o.fromStep} (${o.extract})${o.required ? "" : "  optional"}`,
    ),
    "",
    `steps  (${summary.steps.length}; >> marks the write and its approval gate)`,
    `   ${"#".padStart(3)} id   ${"phase".padEnd(8)} ${"action".padEnd(13)} ${"effect".padEnd(13)} target`,
    ...summary.steps.flatMap(formatStep),
    "",
    "business outcomes",
    ...(summary.businessOutcomes.length
      ? summary.businessOutcomes.map((o) => `  ${o.code.padEnd(20)} ${o.when}`)
      : ["  (none)"]),
  ];
  return lines.filter((line, i) => line !== "" || lines[i - 1] !== "").join("\n");
}

function formatStep(step: StepSummary): string[] {
  const loud = step.effect === "consequential" || step.action === "approval_gate";
  const flags = [step.authoredBy === "human" ? "human" : "", step.unresolved ? "unresolved" : ""].filter(Boolean);
  const head = [
    `${loud ? ">>" : "  "} ${String(step.index).padStart(3)} ${step.stepId}`,
    step.phase.padEnd(8),
    step.action.padEnd(13),
    (step.effect === "consequential" ? "CONSEQUENTIAL" : step.effect).padEnd(13),
    step.target,
    flags.length ? `(${flags.join(", ")})` : "",
  ];
  const detail = [
    step.precondition.length ? `pre: ${step.precondition.join("; ")}` : "",
    step.values.length ? `values: ${step.values.join(" ")}` : "",
    `checks: ${step.checks}`,
    `fp: ${step.fingerprint}`,
  ];
  return [head.filter((x) => x !== "").join(" ").trimEnd(), `${" ".repeat(11)}${detail.filter(Boolean).join("  |  ")}`];
}

export function formatDiff(d: CapabilityDiff): string {
  const [versionA, versionB] = d.versions;
  const lines = [`${d.capabilityId}  v${versionA} -> v${versionB}`, ...d.header.map((c) => `  ${fieldLine(c)}`)];

  if (d.meta.length) lines.push("", "capability", ...d.meta.map((c) => `  ~ ${fieldLine(c)}`));

  const steps = d.steps;
  if (!isEmpty(steps)) {
    lines.push("", `steps  ${steps.countA} -> ${steps.countB}`);
    for (const r of steps.removed) lines.push(`  - ${r.stepId}  ${r.summary}`);
    for (const r of steps.added) lines.push(`  + ${r.stepId}  ${r.summary}`);
    for (const c of steps.changed) {
      lines.push(`  ~ ${c.a === c.b ? c.a : `${c.a} -> ${c.b}`}  ${c.summary}`);
      for (const f of c.changes) lines.push(`      ${fieldLine(f)}`);
    }
  }
  section(lines, "inputs", d.inputs);
  section(lines, "outputs", d.outputs);
  section(lines, "business outcomes", d.businessOutcomes);

  lines.push("", d.identical ? "no differences" : "capabilities differ");
  return lines.join("\n");
}

function section(lines: string[], title: string, k: KeyedChanges): void {
  if (isEmpty(k)) return;
  lines.push("", title);
  for (const n of k.removed) lines.push(`  - ${n}`);
  for (const n of k.added) lines.push(`  + ${n}`);
  for (const c of k.changed) {
    lines.push(`  ~ ${c.name}`);
    for (const f of c.changes) lines.push(`      ${fieldLine(f)}`);
  }
}

function fieldLine(c: FieldChange): string {
  return `${c.field}: ${c.from} -> ${c.to}`;
}
