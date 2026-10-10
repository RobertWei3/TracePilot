import type { CapabilityDiff, FieldChange, KeyedChanges } from "./diff.js";
import type { InspectSummary, StepSummary } from "./summary.js";

/**
 * Terminal renderings. They print the structured summaries and nothing else,
 * so the text shows no more than `--json` would.
 */

export function formatSummary(s: InspectSummary): string {
  const p = s.provenance;
  const lines = [
    `${s.capabilityId} v${s.version}  [${s.status}]`,
    `origin     : ${s.origin}`,
    s.session ? `session    : ${s.session.credentialRef} via ${s.session.loginUrl}` : "",
    `created    : ${s.createdAt}`,
    `provenance : run ${p.runId} | model ${p.model} | ${p.authoredBy.agent} agent, ${p.authoredBy.human} human step(s)`,
    p.outcomeRunIds.length ? `outcomes   : learned from ${p.outcomeRunIds.join(", ")}` : "",
    "",
    "inputs",
    ...s.inputs.map(
      (i) => `  ${i.name.padEnd(20)} ${i.type}${i.optional ? "  optional" : ""}${i.sensitive ? "  sensitive" : ""}`,
    ),
    "",
    "outputs",
    ...s.outputs.map(
      (o) =>
        `  ${o.name.padEnd(20)} ${o.pattern ?? "(any)"}  from ${o.fromStep} (${o.extract})${o.required ? "" : "  optional"}`,
    ),
    "",
    `steps  (${s.steps.length}; WRITE = consequential, GATE = approval gate)`,
    ...s.steps.flatMap(formatStep),
    "",
    "business outcomes",
    ...(s.businessOutcomes.length ? s.businessOutcomes.map((o) => `  ${o.code.padEnd(20)} ${o.when}`) : ["  (none)"]),
  ];
  return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n");
}

function formatStep(st: StepSummary): string[] {
  const mark = st.effect === "consequential" ? "WRITE" : st.action === "approval_gate" ? "GATE" : "";
  const flags = [st.authoredBy === "human" ? "human" : "", st.unresolved ? "unresolved" : ""].filter(Boolean);
  const head = [
    `${mark ? ">>" : "  "} ${st.stepId}`,
    st.phase.padEnd(8),
    st.action.padEnd(13),
    mark.padEnd(5),
    st.target ?? "",
    flags.length ? `(${flags.join(", ")})` : "",
  ];
  const detail = [
    st.precondition.length ? `pre: ${st.precondition.join("; ")}` : "",
    st.values.length ? `values: ${st.values.join(" ")}` : "",
    `checks: ${st.checks}`,
    `fp: ${st.fingerprint}`,
  ];
  return [head.filter((x) => x !== "").join(" ").trimEnd(), `         ${detail.filter(Boolean).join("  |  ")}`];
}

export function formatDiff(d: CapabilityDiff): string {
  const [va, vb] = d.versions;
  const lines = [`${d.capabilityId}  v${va} -> v${vb}`, ...d.provenance.map((c) => `  ${fieldLine(c)}`)];

  if (d.meta.length) lines.push("", "capability", ...d.meta.map((c) => `  ~ ${fieldLine(c)}`));

  const st = d.steps;
  if (st.added.length || st.removed.length || st.changed.length) {
    lines.push("", `steps  ${st.countA} -> ${st.countB}`);
    for (const r of st.removed) lines.push(`  - ${r.stepId}  ${r.summary}`);
    for (const r of st.added) lines.push(`  + ${r.stepId}  ${r.summary}`);
    for (const c of st.changed) {
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
  if (!k.added.length && !k.removed.length && !k.changed.length) return;
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
