import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";
import type { Descriptor, LocatorCandidate } from "../contracts/index.js";
import type { ObservedElement } from "./observe.js";

/**
 * Turn an observed element into a semantic descriptor plus an ordered ladder of
 * concrete strategies.
 *
 * Why a ladder rather than one selector: DemoBank has no test IDs, several
 * identical "View" links, and captions that are bare divs with no `for`
 * attribute -- which is what real legacy applications look like. Rank 1 is the
 * most semantic thing available (role + accessible name); each lower rank
 * trades semantics for specificity. Replay records which rank actually won, so
 * degradation is visible as drift instead of silently working until it doesn't.
 */
export function describe(
  el: ObservedElement,
  opts: { nth?: number; anchorInput?: string } = {},
): Descriptor {
  // A redacted element's name and caption are placeholders, not page text.
  // Building the usual ladder from them would freeze "<other member>" into the
  // artifact as a locator, which matches nothing and would survive review
  // looking plausible. Such an element is addressed structurally instead: the
  // path carries position and no text, so the control stays actionable while
  // staying unreadable.
  if (el.redacted) {
    return {
      role: el.role,
      tagName: el.tagName,
      ...(opts.nth !== undefined ? { nth: opts.nth } : {}),
      candidates: [{ rank: 1, strategy: "structural", expr: el.locatorKey }],
    };
  }

  const candidates: LocatorCandidate[] = [];
  let rank = 1;
  if (el.name) candidates.push({ rank: rank++, strategy: "role+name", expr: `${el.role}|${el.name}` });
  if (el.labelText) candidates.push({ rank: rank++, strategy: "label", expr: el.labelText });
  if (el.nearbyText && el.nearbyText !== el.labelText) {
    candidates.push({ rank: rank++, strategy: "text-scoped", expr: el.nearbyText });
  }
  candidates.push({ rank: rank++, strategy: "structural", expr: `${el.tagName}[role=${el.role}]` });

  return {
    role: el.role,
    ...(el.name ? { accessibleName: el.name } : {}),
    ...(el.labelText ? { labelText: el.labelText } : {}),
    ...(el.nearbyText ? { nearbyText: el.nearbyText.slice(0, 120) } : {}),
    tagName: el.tagName,
    ...(el.regionName && el.regionName !== "page"
      ? {
          scope: {
            containerRole: "region",
            containerName: el.regionName,
            ...(opts.anchorInput ? { anchorInput: opts.anchorInput } : {}),
          },
        }
      : opts.anchorInput
        ? { scope: { anchorInput: opts.anchorInput } }
        : {}),
    ...(opts.nth !== undefined ? { nth: opts.nth } : {}),
    candidates,
  };
}

/** Stable hash of the descriptor's identifying neighbourhood, for drift detection. */
export function fingerprint(d: Descriptor): string {
  const material = [
    d.role,
    d.tagName,
    d.accessibleName ?? "",
    d.labelText ?? "",
    d.scope?.containerName ?? "",
  ].join(" ");
  return "sha256:" + createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * Descriptor text carries <input:name> tags wherever a page string matched a
 * resolved input value, because the observation builder tags in-page before
 * anything leaves the browser. Substituting the current values back in at
 * resolve time is what makes a descriptor parameterized: the heading
 * "Edit mailing address - <input:member_id>" matches M-1002 on the discovery
 * run and M-1007 on a replay with different parameters, with no recompilation.
 */
function detag(text: string, inputs: Record<string, string>): string {
  return text.replace(/<input:([^>]+)>/g, (whole, name: string) => inputs[name] ?? whole);
}

/**
 * Scope a locator to the descriptor's container. Two independent narrowings:
 * the region heading (matching the observation builder's region unit), and an
 * anchor value -- the resolved value of a declared input that must appear
 * inside the container. The anchor is what makes a results table with N
 * identical "View" links addressable without freezing a row index.
 */
function scoped(page: Page, d: Descriptor, inputs: Record<string, string>): Locator {
  const anchorName = d.scope?.anchorInput;
  const anchorValue = anchorName ? inputs[anchorName] : undefined;
  if (anchorValue) {
    // The tightest container that carries the anchor text: a table row.
    return page.locator("tr, li, .fieldrow").filter({ hasText: anchorValue }).last();
  }
  const name = d.scope?.containerName;
  if (!name) return page.locator("body");
  // Several nested ancestors contain the heading; document order puts the
  // outermost first, so .last() is the innermost -- the actual panel. Without
  // this, chaining off a multi-element root double-counts and every descriptor
  // looks ambiguous.
  return page
    .locator("div,section,form,table,tr")
    .filter({ has: page.getByRole("heading", { name: detag(name, inputs), exact: false }) })
    .last();
}

function build(page: Page, d: Descriptor, c: LocatorCandidate, inputs: Record<string, string>): Locator {
  const root = scoped(page, d, inputs);
  switch (c.strategy) {
    case "role+name": {
      const [, ...nameParts] = c.expr.split("|");
      const name = detag(nameParts.join("|"), inputs);
      return root.getByRole(d.role as Parameters<Page["getByRole"]>[0], { name, exact: true });
    }
    case "label":
      return root.getByLabel(detag(c.expr, inputs), { exact: true });
    case "placeholder":
      return root.getByPlaceholder(detag(c.expr, inputs), { exact: true });
    case "text-scoped":
      // Anchor on the caption text, then take the control beside it -- the only
      // route to a control whose caption is a bare div with no `for` attribute.
      // The container must actually hold such a control, otherwise the caption
      // element itself wins and the strategy resolves to nothing.
      return root
        .locator(".fieldrow, td, th, li, p, div")
        .filter({ hasText: detag(c.expr, inputs) })
        .filter({ has: page.locator(d.tagName) })
        .last()
        .locator(d.tagName);
    case "structural":
      // A path is absolute from the document; a bare tag name is scoped as
      // before. Paths come from redacted elements, which have no container
      // heading to scope by anyway.
      return c.expr.includes(">") ? page.locator(c.expr) : root.locator(d.tagName);
  }
}

export type Attempt = { rank: number; strategy: string; matches: number | "error" };
export type Resolution =
  | { ok: true; locator: Locator; rank: number; strategy: string; tried: Attempt[] }
  | { ok: false; tried: Attempt[] };

/**
 * Walk the ladder. A candidate must resolve to exactly one element, or to the
 * declared `nth` when the descriptor legitimately matches several. Ambiguity is
 * a fall-through, not a coin flip.
 */
export async function resolve(
  page: Page,
  d: Descriptor,
  timeoutMs = 5000,
  inputs: Record<string, string> = {},
): Promise<Resolution> {
  const tried: Attempt[] = [];
  const deadline = Date.now() + timeoutMs;

  for (const c of [...d.candidates].sort((a, b) => a.rank - b.rank)) {
    try {
      const loc = build(page, d, c, inputs);
      // Give the first candidate the real wait budget; later ones only need to
      // report what is already on the page.
      if (c.rank === 1) {
        const remaining = Math.max(250, deadline - Date.now());
        await loc.first().waitFor({ state: "attached", timeout: remaining }).catch(() => {});
      }
      const n = await loc.count();
      tried.push({ rank: c.rank, strategy: c.strategy, matches: n });
      if (n === 1) return { ok: true, locator: loc.first(), rank: c.rank, strategy: c.strategy, tried };
      if (n > 1 && d.nth !== undefined && d.nth < n) {
        return { ok: true, locator: loc.nth(d.nth), rank: c.rank, strategy: c.strategy, tried };
      }
    } catch {
      tried.push({ rank: c.rank, strategy: c.strategy, matches: "error" });
    }
  }
  return { ok: false, tried };
}

export function summarize(d: Descriptor): string {
  const bits = [d.role];
  if (d.accessibleName) bits.push(`"${d.accessibleName}"`);
  else if (d.labelText) bits.push(`labelled "${d.labelText}"`);
  else if (d.nearbyText) bits.push(`near "${d.nearbyText}"`);
  if (d.scope?.anchorInput) bits.push(`in the row for {input:${d.scope.anchorInput}}`);
  else if (d.scope?.containerName) bits.push(`in "${d.scope.containerName}"`);
  if (d.nth !== undefined) bits.push(`#${d.nth}`);
  return bits.join(" ");
}
