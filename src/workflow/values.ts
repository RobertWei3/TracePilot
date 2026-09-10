import type { Policy, ValueRef } from "../contracts/index.js";

/**
 * Resolution of value references. This is the workflow layer, deliberately
 * separate from the surface layer: it knows what a reference *means* and
 * nothing about browsers.
 *
 * Inputs are supplied as a nested object and addressed by dotted path, so
 * `{input: "address.city"}` reaches into the structured address the edit form
 * requires field by field.
 */
export type InputValues = Record<string, unknown>;

export function flatten(values: InputValues, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value as InputValues, dotted));
    } else if (value !== undefined && value !== null) {
      out[dotted] = String(value);
    }
  }
  return out;
}

export class UnresolvableValue extends Error {
  constructor(readonly detail: string) {
    super(`unresolvable value reference: ${detail}`);
    this.name = "UnresolvableValue";
  }
}

export type ResolveContext = {
  /** Flattened input values, resolved in memory only. */
  inputs: Record<string, string>;
  /** Credentials, resolved at the last moment and never recorded. */
  secrets: Record<string, string>;
  policy: Policy;
};

export type ResolveOpts = {
  /**
   * Whether a literal must appear in policy.approvedConstants.
   *
   * The gate exists to stop a discovered run baking a value into something it
   * *writes to* the application when that value should have been a parameter.
   * A literal in an assertion is the opposite case: asserting on the
   * application's own message text ("No members matched that search.") is
   * correct and unavoidable, so checks resolve constants freely.
   */
  gateConstants?: boolean;
};

/**
 * Transforms are a closed set of four. Keeping the set tiny and total is what
 * makes replay deterministic; an expression language would be a review surface
 * and a determinism risk for no V1 benefit.
 */
export function resolveValue(ref: ValueRef, ctx: ResolveContext, opts: ResolveOpts = {}): string {
  const gateConstants = opts.gateConstants ?? true;
  if ("input" in ref) {
    const value = ctx.inputs[ref.input];
    if (value === undefined) throw new UnresolvableValue(`no input named "${ref.input}"`);
    return value;
  }
  if ("secret" in ref) {
    const value = ctx.secrets[ref.secret];
    if (value === undefined) throw new UnresolvableValue(`no secret named "${ref.secret}"`);
    return value;
  }
  if ("const" in ref) {
    if (gateConstants && !ctx.policy.approvedConstants.includes(ref.const)) {
      throw new UnresolvableValue(`constant "${ref.const}" is not in policy.approvedConstants`);
    }
    return ref.const;
  }

  const { op, format, arg } = ref.transform;
  if (op === "template") {
    if (!format) throw new UnresolvableValue("template transform requires a format");
    return format.replace(/\{([^}]+)\}/g, (whole, name: string) => {
      const value = ctx.inputs[name];
      if (value === undefined) throw new UnresolvableValue(`template references unknown input "${name}"`);
      return value;
    });
  }
  if (!arg) throw new UnresolvableValue(`${op} transform requires an arg`);
  const inner = resolveValue(arg as ValueRef, ctx, opts);
  switch (op) {
    case "trim":
      return inner.trim();
    case "upper":
      return inner.toUpperCase();
    case "lower":
      return inner.toLowerCase();
  }
}

/** How a reference is described in a log or an intervention, without its value. */
export function describeRef(ref: ValueRef): string {
  if ("input" in ref) return `{input:${ref.input}}`;
  if ("secret" in ref) return `{secret:${ref.secret}}`;
  if ("const" in ref) return `{const:${ref.const}}`;
  const { op, format } = ref.transform;
  return op === "template" ? `{template:${format ?? ""}}` : `{${op}:...}`;
}

/** True when a reference names a credential, which must never be persisted. */
export function isSecretRef(ref: ValueRef): boolean {
  return "secret" in ref;
}
