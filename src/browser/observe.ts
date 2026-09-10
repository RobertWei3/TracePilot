/**
 * The in-page observation builder. This function is serialized and evaluated
 * inside the page, so it must not close over anything outside its argument.
 *
 * Two properties matter for the rest of the system:
 *  - Element ids are scoped to a single observation, so a stale reference from
 *    an earlier turn cannot silently address a different control.
 *  - Any text matching a resolved input value is replaced with <input:name>
 *    *inside the page*, before the observation ever leaves the browser. That is
 *    what keeps input values out of model prompts structurally rather than by
 *    filtering after the fact.
 */
export type ObserveConfig = {
  obsId: string;
  maxElements: number;
  maxTextChars: number;
  /** Values are tagged, never transmitted. Only length >= 3 is considered. */
  inputTags: { name: string; value: string }[];
  /** When set, only elements inside this region are returned (bounded follow-up). */
  regionId?: string;
  /** Skip this many eligible elements, for next-batch inspection. */
  offset?: number;
};

export type ObservedElement = {
  id: string;
  role: string;
  tagName: string;
  name: string;
  labelText: string;
  nearbyText: string;
  value: string;
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
  /** Visible page text, tagged and bounded. */
  text: string;
  textTruncated: boolean;
  elements: ObservedElement[];
  /** Present so the agent knows it is not seeing everything. */
  truncated: boolean;
  totalEligible: number;
  returned: number;
  offset: number;
  regions: { regionId: string; name: string; elementCount: number }[];
  dialogText: string | null;
  errorTexts: string[];
};

export function buildObservation(cfg: ObserveConfig): Observation {
  const tag = (s: string): string => {
    let out = s;
    for (const t of cfg.inputTags) {
      if (!t.value || t.value.length < 3) continue;
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
    if (aria) return { name: aria.trim(), labelText: "" };
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return { name: textOf(ref), labelText: textOf(ref) };
    }
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl) return { name: textOf(lbl), labelText: textOf(lbl) };
    }
    const wrapping = el.closest("label");
    if (wrapping) return { name: textOf(wrapping), labelText: textOf(wrapping) };
    const ph = el.getAttribute("placeholder");
    if (ph) return { name: ph.trim(), labelText: "" };
    const title = el.getAttribute("title");
    if (title) return { name: title.trim(), labelText: "" };
    const own = textOf(el);
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
      const t = textOf(prev);
      if (t && t.length <= 60 && !prev.querySelector("input, select, textarea, button, a")) return t;
      prev = prev.previousElementSibling;
    }
    const rowText = textOf(row);
    return rowText.length <= 80 ? rowText : rowText.slice(0, 80);
  };

  // --- Regions: a heading-bearing block is the unit of scope. ---
  const regionEls = Array.from(document.querySelectorAll("div,section,form,table,tr")).filter((el) => {
    const h = el.querySelector(":scope > h1, :scope > h2, :scope > h3");
    return Boolean(h) && visible(el);
  });
  const regionIdOf = new Map<Element, { regionId: string; name: string }>();
  regionEls.forEach((el, i) => {
    const h = el.querySelector(":scope > h1, :scope > h2, :scope > h3");
    regionIdOf.set(el, { regionId: `${cfg.obsId}:rg-${i}`, name: tag(textOf(h)) });
  });
  const regionFor = (el: Element): { regionId: string; name: string } => {
    for (const [host, meta] of regionIdOf) if (host.contains(el)) return meta;
    return { regionId: `${cfg.obsId}:rg-page`, name: "page" };
  };

  const dialogEl = document.querySelector('[role="dialog"], dialog[open]');
  const dialogText = dialogEl ? tag(textOf(dialogEl)) : null;
  const errorEls = Array.from(document.querySelectorAll(".err, [role=alert], .error")).filter(visible);
  const errorTexts = errorEls.map((e) => tag(textOf(e))).filter(Boolean);
  const activeForm = document.activeElement?.closest("form") ?? document.querySelector("form");

  // --- Candidate elements, with the priority ordering the plan specifies. ---
  const selector =
    "a[href], button, input, select, textarea, [role=button], [role=link], [role=dialog]," +
    " [role=alert], .err, h1, h2, h3, td, th, span";
  const raw = Array.from(document.querySelectorAll(selector)).filter(visible);

  const scored: ObservedElement[] = [];
  raw.forEach((el, i) => {
    const { name, labelText } = nameOf(el);
    const role = roleOf(el);
    const interactive = ["link", "button", "textbox", "combobox", "checkbox", "radio"].includes(role);
    const isText = !interactive;
    // Text nodes only earn a slot when they carry a name worth referring to.
    if (isText && (!name || name.length < 2)) return;
    const region = regionFor(el);
    let priority = 5;
    if (dialogEl && dialogEl.contains(el)) priority = 0;
    else if (errorEls.some((e) => e === el || e.contains(el))) priority = 1;
    else if (activeForm && activeForm.contains(el) && interactive) priority = 2;
    else if (interactive) priority = 3;
    else if (role === "heading") priority = 4;
    const r = el.getBoundingClientRect();
    scored.push({
      id: `${cfg.obsId}:el-${i}`,
      role,
      tagName: el.tagName.toLowerCase(),
      name: tag(name),
      labelText: tag(labelText),
      nearbyText: tag(nearbyOf(el)),
      value: el instanceof HTMLInputElement && el.type !== "password" ? tag(el.value) : "",
      regionId: region.regionId,
      regionName: region.name,
      enabled: !(el as HTMLButtonElement).disabled,
      priority,
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  });

  const eligible = cfg.regionId ? scored.filter((e) => e.regionId === cfg.regionId) : scored;
  eligible.sort((a, b) => a.priority - b.priority || a.box.y - b.box.y || a.box.x - b.box.x);
  const offset = cfg.offset ?? 0;
  const page = eligible.slice(offset, offset + cfg.maxElements);

  const bodyText = tag(textOf(document.body));
  const regionCounts = new Map<string, { name: string; n: number }>();
  for (const e of scored) {
    const cur = regionCounts.get(e.regionId) ?? { name: e.regionName, n: 0 };
    cur.n += 1;
    regionCounts.set(e.regionId, cur);
  }

  return {
    obsId: cfg.obsId,
    url: location.href,
    title: document.title,
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
    })),
    dialogText,
    errorTexts,
  };
}
