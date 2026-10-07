import type { Descriptor } from "../contracts/index.js";
import {
  MIN_TAGGED_VALUE_LENGTH,
  describe as describeEl,
  type ObservedElement,
  type Surface,
} from "../browser/index.js";

export type RecordedAction = {
  seq: number;
  eventType: "click" | "fill" | "select" | "submit";
  /** Identity of the touched control, in the same shape the observer emits. */
  element: ObservedElement;
  /** For fills: which declared input the typed value matched, if any. */
  matchedInput: string | null;
  /** True when the typed value matched no declared input. */
  unmatchedValue: boolean;
  url: string;
  at: string;
};

/**
 * In-page recorder for manual takeover. Capture-phase listeners see the
 * interaction before the page's own handlers, so a click that navigates is
 * still recorded.
 *
 * The identity extraction here is a compact restatement of the observation
 * builder's, because a listener cannot call back into Node synchronously and
 * the page may unload immediately afterwards. `tests/handoff.test.ts` compiles
 * a run containing a takeover and replays it for another member, so drift
 * between the two descriptions shows up as a test failure rather than a wrong
 * artifact.
 */
function installRecorder(cfg: {
  inputTags: { name: string; value: string }[];
  minTagLength: number;
}): void {
  type Rec = Record<string, unknown>;
  const w = window as unknown as { __tpRecord?: (r: Rec) => void; __tpInstalled?: boolean };
  if (w.__tpInstalled) return;
  w.__tpInstalled = true;
  let seq = 0;

  const tag = (s: string): string => {
    let out = s;
    for (const t of cfg.inputTags) {
      if (!t.value || t.value.length < cfg.minTagLength) continue;
      out = out.split(t.value).join("<input:" + t.name + ">");
    }
    return out;
  };
  const textOf = (el: Element | null): string =>
    el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";

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
      return "textbox";
    }
    if (/^h[1-6]$/.test(t)) return "heading";
    return "generic";
  };

  const nameOf = (el: Element): { name: string; labelText: string } => {
    const aria = el.getAttribute("aria-label");
    if (aria) return { name: aria.trim(), labelText: "" };
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lbl) return { name: textOf(lbl), labelText: textOf(lbl) };
    }
    const wrapping = el.closest("label");
    if (wrapping) return { name: textOf(wrapping), labelText: textOf(wrapping) };
    const ph = el.getAttribute("placeholder");
    if (ph) return { name: ph.trim(), labelText: "" };
    const own = textOf(el);
    if (own && own.length <= 80) return { name: own, labelText: "" };
    return { name: "", labelText: "" };
  };

  const nearbyOf = (el: Element): string => {
    let prev = el.previousElementSibling;
    while (prev) {
      const t = textOf(prev);
      if (t && t.length <= 60 && !prev.querySelector("input, select, textarea, button, a")) return t;
      prev = prev.previousElementSibling;
    }
    const row = el.closest(".fieldrow, td, th, li, p, div");
    const rowText = textOf(row);
    return rowText.length <= 80 ? rowText : rowText.slice(0, 80);
  };

  const regionOf = (el: Element): string => {
    let node: Element | null = el;
    while (node) {
      const h = node.querySelector(":scope > h1, :scope > h2, :scope > h3");
      if (h) return tag(textOf(h));
      node = node.parentElement;
    }
    return "page";
  };

  const record = (el: Element, eventType: string, typed: string | null): void => {
    const names = nameOf(el);
    const box = el.getBoundingClientRect();
    let matchedInput: string | null = null;
    if (typed) {
      for (const t of cfg.inputTags) if (t.value && t.value === typed) matchedInput = t.name;
    }
    // Sent out of the page the moment it happens. A buffer kept in the page
    // dies with the document, so a click that navigates would take every
    // earlier action on that page down with it.
    w.__tpRecord?.({
      seq: ++seq,
      eventType,
      matchedInput,
      unmatchedValue: typed !== null && matchedInput === null && typed.length > 0,
      url: location.href,
      at: new Date().toISOString(),
      element: {
        id: "human:el-" + seq,
        role: roleOf(el),
        tagName: el.tagName.toLowerCase(),
        name: tag(names.name),
        labelText: tag(names.labelText),
        nearbyText: tag(nearbyOf(el)),
        value: "",
        regionId: "human:rg",
        regionName: regionOf(el),
        enabled: true,
        priority: 2,
        box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      },
    });
  };

  document.addEventListener(
    "click",
    (ev) => {
      const el = ev.target as Element | null;
      if (el && el.nodeType === 1) record(el, "click", null);
    },
    true,
  );
  document.addEventListener(
    "change",
    (ev) => {
      const el = ev.target as Element | null;
      if (!el || el.nodeType !== 1) return;
      const typed = el instanceof HTMLInputElement && el.type !== "password" ? el.value : "";
      record(el, el instanceof HTMLSelectElement ? "select" : "fill", typed);
    },
    true,
  );
  document.addEventListener(
    "submit",
    (ev) => {
      const el = ev.target as Element | null;
      if (el && el.nodeType === 1) record(el, "submit", null);
    },
    true,
  );
}

/**
 * Where a browser context's recorded actions go. A binding can be exposed
 * only once per context, but a run can hand over control many times, so the
 * binding is permanent and this routes it to whichever recorder is armed --
 * or to nothing. The in-page listeners stay installed once a takeover has
 * happened; this is what keeps the agent's own clicks, after control returns,
 * from being attributed to the person.
 */
const sinks = new WeakMap<object, ((action: RecordedAction) => void) | null>();

export class HumanRecorder {
  private collected: RecordedAction[] = [];
  private seq = 0;

  constructor(
    private readonly surface: Surface,
    private readonly inputs: Record<string, string>,
  ) {}

  /** Arms the recorder on the current page and every page that follows. */
  async start(): Promise<void> {
    const context = this.surface.context;
    if (!sinks.has(context)) {
      await context.exposeBinding("__tpRecord", (_source, action: RecordedAction) => {
        sinks.get(context)?.(action);
      });
    }
    // Sequence numbers restart in every document, so they are reassigned here
    // in arrival order; dedupe compares them across pages.
    sinks.set(context, (action) => this.collected.push({ ...action, seq: ++this.seq }));

    const cfg = {
      inputTags: Object.entries(this.inputs).map(([name, value]) => ({ name, value })),
      minTagLength: MIN_TAGGED_VALUE_LENGTH,
    };
    await context.addInitScript(installRecorder, cfg);
    await this.surface.page.evaluate(installRecorder, cfg);
  }

  /**
   * Disarms the recorder and returns everything the person did. Anything
   * recorded after this -- the agent acting again -- goes nowhere.
   */
  async drain(): Promise<RecordedAction[]> {
    // A change event fired by the last blur may still be in flight.
    await this.surface.page.evaluate(() => new Promise((r) => setTimeout(r, 50))).catch(() => {});
    sinks.set(this.surface.context, null);
    return this.collected;
  }

  all(): RecordedAction[] {
    return this.collected;
  }

  /**
   * A recorded click on a submit button and the surrounding form submit are the
   * same intent; keeping both would double-count the human's actions.
   */
  static dedupe(actions: RecordedAction[]): RecordedAction[] {
    return actions.filter(
      (a, i, arr) =>
        !(
          a.eventType === "submit" &&
          arr.some((b) => b.eventType === "click" && b.element.role === "button" && Math.abs(b.seq - a.seq) <= 1)
        ),
    );
  }

  static toDescriptor(action: RecordedAction): Descriptor {
    return describeEl(action.element);
  }
}
