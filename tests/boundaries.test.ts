// Turns two prose requirements from the spec into executable assertions:
//   1. replay must not depend on the LLM module
//   2. automation must not import DemoBank's business logic
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve("src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every module specifier this file imports or re-exports. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (let m = re.exec(src); m; m = re.exec(src)) specs.push(m[1]!);
  return specs;
}

/** Resolve a relative specifier to a path under src/, or null if external. */
function resolveLocal(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return path.resolve(path.dirname(file), spec);
}

function moduleArea(file: string): string {
  const rel = path.relative(SRC, file);
  return rel.split(path.sep)[0]!;
}

test("replay does not reach discovery or any LLM client", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    if (moduleArea(file) !== "replay") continue;
    for (const spec of importsOf(file)) {
      if (spec.includes("@anthropic-ai") || spec.includes("openai")) {
        offenders.push(`${path.relative(".", file)} -> ${spec} (LLM SDK)`);
      }
      const local = resolveLocal(file, spec);
      if (local && moduleArea(local) === "discovery") {
        offenders.push(`${path.relative(".", file)} -> ${spec} (discovery)`);
      }
    }
  }
  assert.deepEqual(offenders, [], `replay must stay LLM-free:\n${offenders.join("\n")}`);
});

test("automation modules do not import DemoBank business logic", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    const area = moduleArea(file);
    if (area === "demobank") continue;
    // The CLI is allowed to launch the app process, but not to import its internals.
    for (const spec of importsOf(file)) {
      const local = resolveLocal(file, spec);
      if (local && moduleArea(local) === "demobank") {
        offenders.push(`${path.relative(".", file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `no automation module may import src/demobank:\n${offenders.join("\n")}`);
});

test("compiler does not reach the LLM client", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    if (moduleArea(file) !== "compiler") continue;
    for (const spec of importsOf(file)) {
      if (spec.includes("@anthropic-ai")) offenders.push(`${path.relative(".", file)} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `compilation must be deterministic:\n${offenders.join("\n")}`);
});
