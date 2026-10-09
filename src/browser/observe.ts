import { INPUT_TAG_MIN_LENGTH } from "../safety/index.js";
/**
 * The in-page observation builder. This function is serialized and evaluated
 * inside the page, so it must not close over anything outside its argument.
 *
 * Three properties matter for the rest of the system:
 *  - Element ids are scoped to a single observation, so a stale reference from
 *    an earlier turn cannot silently address a different control.
 *  - Any text matching a resolved input value is replaced with <input:name>
 *    *inside the page*, before the observation ever leaves the browser.
 *  - Record data the run is not entitled to -- another subject's row in a list,
 *    a field the surface marks sensitive, the stored value of a field being
 *    edited -- is redacted here too, for the same reason. Redaction placed
 *    after the round trip would mean the literals had already crossed into the
 *    Node process, where they can reach a run-store event or a crash dump.
 *
 * What survives redaction is deliberate: element ids, roles, labels, captions
 * and the application's own messages. An agent needs those to work and none of
 * them is the subject's data.
 */
/**
 * Values shorter than this are never tagged.
 *
 * Tagging a two-letter state code would replace those letters wherever they
 * occur -- inside ordinary words, in the application's own furniture -- and
 * corrupt the inventory the agent reasons from. `verdictFor` covers such a
 * field instead, by whole-value equality, so a correctly filled short field is
 * still verifiable without its contents travelling as a substitution.
 *
 * Everything that scans for leaked input values must use the same threshold.
 * A scan stricter than the tagger blocks payloads the tagger was never going
 * to redact, which is not a leak being caught -- it is the two halves of the
 * boundary disagreeing about what the contract is.
 */
export const MIN_TAGGED_VALUE_LENGTH = INPUT_TAG_MIN_LENGTH;

/**
 * The Node-side mirror of the in-page tagger.
 *
 * The observation builder tags inside the page because the literals must not
 * cross the boundary at all. Text this process assembles itself -- a URL read
 * back from the driver, say -- has no such problem, but it still must not be
 * *recorded* with the subject's identifiers in it: a trace is reviewed, shared
 * and compiled, and a member id frozen into a step's URL is both a disclosure
 * and a capability that only ever works for one member.
 *
 * The two implementations cannot be shared -- the in-page one is serialized
 * and may close over nothing -- so they share the threshold instead, and this
 * one is deliberately written to match it.
 */
export function tagInputs(text: string, inputs: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(inputs)) {
    if (!value || value.length < MIN_TAGGED_VALUE_LENGTH) continue;
    out = out.split(value).join(`<input:${name}>`);
  }
  return out;
}

export type ObserveConfig = {
  obsId: string;
  maxElements: number;
  maxTextChars: number;
  /** Values are tagged, never transmitted. See MIN_TAGGED_VALUE_LENGTH. */
  inputTags: { name: string; value: string }[];
  /** Passed in rather than hardcoded, because the payload guard shares it. */
  minTagLength: number;
  /**
   * Surface-specific selectors whose content is never rendered. An explicit
   * configured list for one application, not PII detection.
   */
  sensitiveSelectors: string[];
  /**
   * Inputs whose value identifies the record under work. A row carrying one is
   * the row this run is entitled to read; sibling rows are other subjects.
   */
  anchorInputs: string[];
  /** When set, only elements inside this region are returned (bounded follow-up). */
  regionId?: string;
  /** Skip this many eligible elements, for next-batch inspection. */
  offset?: number;
  /**
   * When set, only the element carrying this attribute is returned. Replay
   * uses it to describe an element it has already resolved, through exactly
   * the tagging, redaction and naming that discovery's descriptors came from.
   */
  focusAttr?: string;
};

/** What a field currently holds, stated without stating the value. */
export type ValueVerdict =
  | { kind: "empty" }
  | { kind: "matches"; input: string }
  | { kind: "unsupplied" }
  | { kind: "masked" };

export type ObservedElement = {
  id: string;
  role: string;
  tagName: string;
  name: string;
  labelText: string;
  nearbyText: string;
  /**
   * Never a literal. The agent learns whether a field is empty, holds a value
   * this run supplied (and which), holds something else, or is masked.
   */
  valueVerdict: ValueVerdict;
  /** True when this element's text was redacted rather than rendered. */
  redacted: boolean;
  /**
   * Structural CSS path, carrying position but no page text. A descriptor for a
   * redacted element has no semantic name to anchor on, so this is the only
   * thing that keeps such an element addressable.
   */
  locatorKey: string;
  /**
   * The enclosing form's submit target, when there is one. Structural, not
   * record data: a method and a path, which is exactly what
   * `classifyEffect` needs to decide whether acting on this control writes a
   * durable change. Without it nothing but the model's own compliance stands
   * between a click and a commit.
   */
  submitTarget: { method: string; pathname: string } | null;
  regionId: string;
  regionName: string;
  enabled: boolean;
  priority: number;
  box: { x: number; y: number; w: number; h: number };
};

export type Observation = {
  obsId: string;
  url: string;
  title: string;
  /** Visible page text, tagged, redacted and bounded. */
  text: string;
  textTruncated: boolean;
  elements: ObservedElement[];
  /** Present so the agent knows it is not seeing everything. */
  truncated: boolean;
  totalEligible: number;
  returned: number;
  offset: number;
  regions: { regionId: string; name: string; elementCount: number; omitted: boolean }[];
  dialogText: string | null;
  errorTexts: string[];
  /**
   * Computed in-page over the finished object, where both the sensitive
   * literals and the redacted output are visible. Only the verdict crosses the
   * boundary: a Node-side check could not do this without being handed the very
   * literals it is meant to keep out.
   */
  selfCheck: { ok: boolean; reason: string | null };
};

export function buildObservation(cfg: ObserveConfig): Observation {
  const tag = (s: string): string => {
    let out = s;
    for (const t of cfg.inputTags) {
      if (!t.value || t.value.length < cfg.minTagLength) continue;
      out = out.split(t.value).join(`<input:${t.name}>`);
    }
    return out;
  };

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };

  const textOf = (el: Element | null): string =>
    el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : "";

  // --- Sensitivity and entitlement -----------------------------------------

  const sensitiveEls: Element[] = [];
  for (const sel of cfg.sensitiveSelectors) {
    try {
      for (const el of Array.from(document.querySelectorAll(sel))) sensitiveEls.push(el);
    } catch {
      // A selector that does not parse protects nothing; selfCheck reports it.
    }
  }
  /**
   * An element is sensitive when it is marked, or sits inside something marked.
   * Ancestors are deliberately *not* sensitive: <body> contains every marked
   * node, so treating containers as sensitive would blank the entire page and
   * take the application's own messages with it. Ancestors are handled by
   * `safeText`, which substitutes the marked subtree in place and keeps the
   * surrounding text intact.
   */
  const isSensitive = (el: Element): boolean =>
    sensitiveEls.some((s) => s === el || s.contains(el));

  const anchorValues = cfg.inputTags
    .filter((t) => cfg.anchorInputs.includes(t.name) && t.value)
    .map((t) => t.value);

  /**
   * A repeated record block: a table row, a list item, a field row. These are
   * the units a listing repeats, and the unit at which entitlement is decided.
   */
  const rowOf = (el: Element): Element | null => el.closest("tr, li");

  /**
   * True when a row belongs to a subject this run is not working on. With no
   * anchor configured nothing is withheld -- entitlement has to be declared to
   * be enforced, and silently redacting everything would be worse than saying
   * so.
   */
  const foreignRow = (el: Element): boolean => {
    if (anchorValues.length === 0) return false;
    const row = rowOf(el);
    if (!row) return false;
    // A header row carries no subject data, so it stays readable.
    if (row.querySelector("th") && !row.querySelector("td")) return false;
    const text = textOf(row);
    return !anchorValues.some((v) => text.includes(v));
  };

  const REDACTED = "<other member>";
  const SENSITIVE = "<sensitive>";

  /**
   * Text as it may be rendered: built by walking, so a marked subtree is
   * replaced where it sits rather than poisoning its container. Reading
   * `textContent` on an ancestor and redacting afterwards would mean the
   * literal had already been assembled, which is the mistake this avoids.
   */
  const safeText = (el: Element): string => {
    if (isSensitive(el)) return SENSITIVE;
    if (foreignRow(el)) return REDACTED;
    const out: string[] = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = (child.textContent ?? "").replace(/\s+/g, " ");
        if (t.trim()) out.push(tag(t.trim()));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const t = safeText(child as Element);
        if (t) out.push(t);
      }
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  };

  /** An attribute string, which has no structure to walk. */
  const safeAttr = (el: Element, s: string): string => {
    if (isSensitive(el)) return SENSITIVE;
    if (foreignRow(el)) return REDACTED;
    return tag(s);
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const t = el.tagName.toLowerCase();
    if (t === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (t === "button") return "button";
    if (t === "select") return "combobox";
    if (t === "textarea") return "textbox";
    if (t === "input") {
      const type = (el as HTMLInputElement).type;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      if (type === "password") return "textbox";
      return "textbox";
    }
    if (/^h[1-6]$/.test(t)) return "heading";
    if (t === "table") return "table";
    if (t === "tr") return "row";
    return "generic";
  };

  /** Simplified accessible-name computation, in precedence order. */
  const nameOf = (el: Element): { name: string; labelText: string } => {
    const aria = el.getAttribute("aria-label");
    if (aria) return { name: safeAttr(el, aria.trim()), labelText: "" };
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return { name: safeText(ref), labelText: safeText(ref) };
    }
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl) return { name: safeText(lbl), labelText: safeText(lbl) };
    }
    const wrapping = el.closest("label");
    if (wrapping) return { name: safeText(wrapping), labelText: safeText(wrapping) };
    const ph = el.getAttribute("placeholder");
    if (ph) return { name: safeAttr(el, ph.trim()), labelText: "" };
    const title = el.getAttribute("title");
    if (title) return { name: safeAttr(el, title.trim()), labelText: "" };
    const own = safeText(el);
    if (own && own.length <= 80) return { name: own, labelText: "" };
    return { name: "", labelText: "" };
  };

  /**
   * The nearest label-like text preceding a control. DemoBank deliberately
   * uses bare <div> captions with no `for`, which is exactly the case a real
   * legacy application presents.
   */
  const nearbyOf = (el: Element): string => {
    const row = el.closest(".fieldrow, td, th, li, p, div");
    if (!row) return "";
    let prev = el.previousElementSibling;
    while (prev) {
      const t = safeText(prev);
      if (t && t.length <= 60 && !prev.querySelector("input, select, textarea, button, a")) return t;
      prev = prev.previousElementSibling;
    }
    const rowText = safeText(row);
    return rowText.length <= 80 ? rowText : rowText.slice(0, 80);
  };

  /**
   * A structural path built from tag names and sibling positions only. It
   * carries no page text, so a redacted element stays addressable without its
   * literal travelling.
   */
  const locatorKeyOf = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 8) {
      const parent: Element | null = node.parentElement;
      const tag = node.tagName.toLowerCase();
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      // Valid CSS, so the path can be handed straight to a locator.
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return parts.join(">");
  };

  /**
   * The form this control would submit, if acting on it would submit one.
   *
   * Form association, not containment. A link inside a form submits nothing --
   * "Submit a correction" on the review screen is an anchor back to the edit
   * page -- and treating it as consequential would demand an approval to
   * navigate. A gate that fires on ordinary navigation is one people learn to
   * click through, which costs more than the precision saves. Buttons that
   * declare they do not submit are excluded for the same reason, and
   * formaction/formmethod are honoured because they are what actually decides
   * where the submission goes.
   */
  const submitTargetOf = (el: Element): { method: string; pathname: string } | null => {
    const owner = (el as HTMLInputElement | HTMLButtonElement).form;
    if (!(owner instanceof HTMLFormElement)) return null;
    if (el instanceof HTMLButtonElement && (el.type === "button" || el.type === "reset")) return null;
    if (el instanceof HTMLInputElement && (el.type === "button" || el.type === "reset")) return null;
    try {
      const action =
        el.getAttribute("formaction") || owner.getAttribute("action") || location.href;
      const method =
        el.getAttribute("formmethod") || owner.getAttribute("method") || "GET";
      return { method: method.toUpperCase(), pathname: new URL(action, location.href).pathname };
    } catch {
      return null;
    }
  };

  /**
   * Whole-value equality, not substring tagging. The tag path skips values
   * under three characters, which would make a correctly filled two-letter
   * state field indistinguishable from one holding foreign data.
   */
  const verdictFor = (el: Element): ValueVerdict => {
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
      return { kind: "empty" };
    }
    if (el instanceof HTMLInputElement && el.type === "password") return { kind: "masked" };
    if (isSensitive(el)) return { kind: "masked" };
    const value = el.value;
    if (!value) return { kind: "empty" };
    for (const t of cfg.inputTags) {
      if (t.value && value === t.value) return { kind: "matches", input: t.name };
    }
    return { kind: "unsupplied" };
  };

  // --- Regions: a heading-bearing block is the unit of scope. ---
  const regionEls = Array.from(document.querySelectorAll("div,section,form,table,tr")).filter((el) => {
    const h = el.querySelector(":scope > h1, :scope > h2, :scope > h3");
    return Boolean(h) && visible(el);
  });
  const regionIdOf = new Map<Element, { regionId: string; name: string; omitted: boolean }>();
  regionEls.forEach((el, i) => {
    const h = el.querySelector(":scope > h1, :scope > h2, :scope > h3")!;
    // A region whose heading is itself sensitive cannot be named safely, so the
    // region is omitted rather than rendered under a redacted title.
    const omitted = isSensitive(h);
    regionIdOf.set(el, {
      regionId: `${cfg.obsId}:rg-${i}`,
      name: omitted ? "<omitted>" : safeText(h),
      omitted,
    });
  });
  const regionFor = (el: Element): { regionId: string; name: string; omitted: boolean } => {
    for (const [host, meta] of regionIdOf) if (host.contains(el)) return meta;
    return { regionId: `${cfg.obsId}:rg-page`, name: "page", omitted: false };
  };

  const dialogEl = document.querySelector('[role="dialog"], dialog[open]');
  const dialogText = dialogEl ? safeText(dialogEl) : null;
  const errorEls = Array.from(document.querySelectorAll(".err, [role=alert], .error")).filter(visible);
  const errorTexts = errorEls.map((e) => safeText(e)).filter(Boolean);
  const activeForm = document.activeElement?.closest("form") ?? document.querySelector("form");

  // --- Candidate elements, with the priority ordering the plan specifies. ---
  const selector =
    "a[href], button, input, select, textarea, [role=button], [role=link], [role=dialog]," +
    " [role=alert], .err, h1, h2, h3, td, th, span";
  const raw = Array.from(document.querySelectorAll(selector)).filter(visible);

  const scored: ObservedElement[] = [];
  const sourceOf = new Map<string, Element>();
  const redactedEls: Element[] = [];
  raw.forEach((el, i) => {
    const region = regionFor(el);
    // An omitted region contributes nothing, not even element ids: a target the
    // agent cannot see described is a target it cannot reason about.
    if (region.omitted) return;

    const { name, labelText } = nameOf(el);
    const role = roleOf(el);
    const interactive = ["link", "button", "textbox", "combobox", "checkbox", "radio"].includes(role);
    const isText = !interactive;
    // Text nodes only earn a slot when they carry a name worth referring to.
    if (isText && (!name || name.length < 2)) return;

    const redacted = isSensitive(el) || foreignRow(el);
    if (redacted) redactedEls.push(el);

    let priority = 5;
    if (dialogEl && dialogEl.contains(el)) priority = 0;
    else if (errorEls.some((e) => e === el || e.contains(el))) priority = 1;
    else if (activeForm && activeForm.contains(el) && interactive) priority = 2;
    else if (interactive) priority = 3;
    else if (role === "heading") priority = 4;
    const r = el.getBoundingClientRect();
    sourceOf.set(`${cfg.obsId}:el-${i}`, el);
    scored.push({
      id: `${cfg.obsId}:el-${i}`,
      role,
      tagName: el.tagName.toLowerCase(),
      name,
      labelText,
      nearbyText: nearbyOf(el),
      valueVerdict: verdictFor(el),
      redacted,
      locatorKey: locatorKeyOf(el),
      submitTarget: submitTargetOf(el),
      regionId: region.regionId,
      regionName: region.name,
      enabled: !(el as HTMLButtonElement).disabled,
      priority,
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  });

  // Screenshot masks are resolved from this marker, so the image channel hides
  // exactly what the text channel hid. The caller strips it after capture.
  for (const el of redactedEls) el.setAttribute("data-tp-redacted", "");

  const eligible = cfg.focusAttr
    ? scored.filter((e) => sourceOf.get(e.id)!.hasAttribute(cfg.focusAttr!))
    : cfg.regionId
      ? scored.filter((e) => e.regionId === cfg.regionId)
      : scored;
  eligible.sort((a, b) => a.priority - b.priority || a.box.y - b.box.y || a.box.x - b.box.x);
  const offset = cfg.offset ?? 0;
  const page = eligible.slice(offset, offset + cfg.maxElements);

  const bodyText = safeText(document.body);

  const regionCounts = new Map<string, { name: string; n: number; omitted: boolean }>();
  for (const [, meta] of regionIdOf) {
    if (meta.omitted) regionCounts.set(meta.regionId, { name: meta.name, n: 0, omitted: true });
  }
  for (const e of scored) {
    const cur = regionCounts.get(e.regionId) ?? { name: e.regionName, n: 0, omitted: false };
    cur.n += 1;
    regionCounts.set(e.regionId, cur);
  }

  // The URL is record data too: a path segment naming the subject is the same
  // disclosure as a heading naming them, and it was the one string this builder
  // used to pass through untouched.
  const url = tag(location.href);
  const title = tag(document.title);

  // --- Self-check, run where both sides are visible -------------------------
  const sensitiveLiterals: string[] = [];
  for (const el of sensitiveEls) {
    const t = textOf(el);
    if (t) sensitiveLiterals.push(t);
    if (el instanceof HTMLInputElement && el.value) sensitiveLiterals.push(el.value);
  }
  for (const el of redactedEls) {
    if (el instanceof HTMLInputElement && el.value) sensitiveLiterals.push(el.value);
  }
  const rendered = [
    url,
    title,
    bodyText.slice(0, cfg.maxTextChars),
    dialogText ?? "",
    errorTexts.join(" "),
    ...page.map((e) => `${e.name} ${e.labelText} ${e.nearbyText} ${e.regionName}`),
  ].join("\n");

  let selfCheck: { ok: boolean; reason: string | null } = { ok: true, reason: null };
  for (const sel of cfg.sensitiveSelectors) {
    try {
      document.querySelectorAll(sel);
    } catch {
      selfCheck = { ok: false, reason: `sensitive selector did not parse: ${sel}` };
    }
  }
  if (selfCheck.ok) {
    /**
     * A redacted element must not render its own literal in any field. Testing
     * for placeholders instead would be wrong: a caption drawn from a
     * non-sensitive neighbour, or a label outside the marked subtree, is
     * exactly the context worth preserving, and is not this element's data.
     * What must never appear is the element's own text -- which is what a field
     * built by reading textContent directly, rather than walking, would show.
     */
    for (const e of page) {
      if (!e.redacted) continue;
      const src = sourceOf.get(e.id);
      const own = src ? textOf(src) : "";
      if (own.length < 3) continue;
      if ([e.name, e.labelText, e.nearbyText].some((f) => f.includes(own))) {
        selfCheck = { ok: false, reason: "a redacted element rendered its own text" };
        break;
      }
    }
  }
  if (selfCheck.ok) {
    /**
     * Presence alone is the wrong test for the page text. A stored city can
     * legitimately also be part of the application's own branding, and blocking
     * because the brand name appears would fire while redaction was working.
     * So only literals that occur *exclusively* inside marked subtrees are
     * scanned: for those, any appearance in the output is unambiguously a leak.
     * Literals that also appear in unprotected page furniture are covered by
     * the element-level check above, which does not depend on the string.
     */
    const count = (haystack: string, needle: string): number =>
      needle ? haystack.split(needle).length - 1 : 0;
    const rawBody = textOf(document.body);
    for (const lit of sensitiveLiterals) {
      if (lit.length < 3) continue;
      let inProtected = 0;
      for (const el of sensitiveEls) inProtected += count(textOf(el), lit);
      const exclusive = inProtected > 0 && count(rawBody, lit) === inProtected;
      if (exclusive && rendered.includes(lit)) {
        selfCheck = { ok: false, reason: "a sensitive field survived redaction" };
        break;
      }
    }
  }
  if (selfCheck.ok) {
    for (const el of sensitiveEls) {
      const r = el.getBoundingClientRect();
      if (visible(el) && r.width === 0 && r.height === 0) {
        selfCheck = { ok: false, reason: "a sensitive element could not be boxed for masking" };
        break;
      }
    }
  }

  return {
    obsId: cfg.obsId,
    url,
    title,
    text: bodyText.slice(0, cfg.maxTextChars),
    textTruncated: bodyText.length > cfg.maxTextChars,
    elements: page,
    truncated: offset + page.length < eligible.length,
    totalEligible: eligible.length,
    returned: page.length,
    offset,
    regions: Array.from(regionCounts, ([regionId, v]) => ({
      regionId,
      name: v.name,
      elementCount: v.n,
      omitted: v.omitted,
    })),
    dialogText,
    errorTexts,
    selfCheck,
  };
}
