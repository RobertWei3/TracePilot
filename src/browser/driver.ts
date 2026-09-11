import { chromium, type BrowserContext, type Dialog, type Page } from "playwright";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Descriptor, Policy } from "../contracts/index.js";
import { SafetyViolation, checkAction, checkUrl, registerSecret } from "../safety/index.js";
import {
  MIN_TAGGED_VALUE_LENGTH,
  buildObservation,
  type Observation,
  type ObserveConfig,
} from "./observe.js";
import { resolve, summarize, type Attempt } from "./descriptor.js";

export type SurfaceOptions = {
  policy: Policy;
  headless?: boolean;
  profileDir?: string;
  /** Values resolved in memory only. Never sent to a model, never persisted. */
  inputs?: Record<string, string>;
  secrets?: Record<string, string>;
};

/** Mask fill. Exported so a test can assert on pixels rather than on intent. */
export const MASK_COLOR = "#222222";

export type DialogRecord = { message: string; type: string; declared: boolean; at: string };

export type ActResult =
  | { ok: true; rank: number; strategy: string; tried: Attempt[] }
  | { ok: false; reason: "unresolved" | "error"; tried: Attempt[]; detail: string };

/**
 * The single surface abstraction: everything discovery and replay do to a
 * browser goes through here, which is what makes one policy chokepoint
 * sufficient. Nothing in this module knows about capabilities or LLMs -- that
 * separation is what an extension to another surface would replace.
 */
export class Surface {
  private obsCounter = 0;
  readonly dialogs: DialogRecord[] = [];
  /** Dialog texts the caller has declared as expected, from the artifact. */
  expectedDialogs: { textContains: string; accept: boolean }[] = [];

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly policy: Policy,
    private readonly inputs: Record<string, string>,
    private readonly secrets: Record<string, string>,
  ) {}

  static async launch(opts: SurfaceOptions): Promise<Surface> {
    const policy = opts.policy;
    const profileDir = opts.profileDir ?? path.resolve(".pw-profile");
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: opts.headless ?? false,
      viewport: { width: policy.observation.screenshotWidth, height: policy.observation.screenshotHeight },
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const page = context.pages()[0] ?? (await context.newPage());

    for (const [label, value] of Object.entries(opts.secrets ?? {})) registerSecret(label, value);

    const surface = new Surface(context, page, policy, opts.inputs ?? {}, opts.secrets ?? {});

    // The TypeScript transform emits keepNames wrappers, which reference a
    // helper that does not exist inside the page when a function is serialized
    // for evaluate(). Providing an identity shim keeps the in-page observation
    // builder type-checked in this repo rather than stringly-typed.
    await context.addInitScript({
      content: "globalThis.__name = globalThis.__name || function (f) { return f; };",
    });

    // Defence in depth: the chokepoint below refuses off-policy actions, and
    // this refuses off-policy *requests* the page starts on its own.
    await context.route("**/*", async (route) => {
      const verdict = checkUrl(policy, route.request().url());
      if (verdict.ok) return route.continue();
      // Same-origin sub-resources on non-allowlisted paths are still page
      // furniture; only cross-origin traffic is aborted outright.
      const origin = new URL(route.request().url()).origin;
      if (policy.allowedOrigins.includes(origin)) return route.continue();
      return route.abort("blockedbyclient");
    });

    // Undeclared dialogs are never accepted. Dismissing is the safe response --
    // it cancels the pending operation -- and the record drives escalation.
    page.on("dialog", async (dialog: Dialog) => {
      const declared = surface.expectedDialogs.find((d) => dialog.message().includes(d.textContains));
      surface.dialogs.push({
        message: dialog.message(),
        type: dialog.type(),
        declared: Boolean(declared),
        at: new Date().toISOString(),
      });
      if (declared?.accept) await dialog.accept();
      else await dialog.dismiss();
    });

    return surface;
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  /** Undeclared dialogs seen since the last drain. */
  drainUndeclaredDialogs(): DialogRecord[] {
    const undeclared = this.dialogs.filter((d) => !d.declared);
    this.dialogs.length = 0;
    return undeclared;
  }

  private gateUrl(url: string): void {
    const verdict = checkUrl(this.policy, url);
    if (!verdict.ok) throw new SafetyViolation(verdict.rule, verdict.attempted);
  }

  private gateAction(action: string): void {
    const verdict = checkAction(this.policy, action);
    if (!verdict.ok) throw new SafetyViolation(verdict.rule, verdict.attempted);
  }

  async navigate(url: string): Promise<{ status: number | null }> {
    this.gateAction("navigate");
    this.gateUrl(url);
    const res = await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.policy.budgets.stepTimeoutMs,
    });
    // A redirect off-policy is refused after the fact rather than followed.
    this.gateUrl(this.page.url());
    return { status: res?.status() ?? null };
  }

  /** Current URL, gated so an off-policy redirect cannot be silently observed. */
  currentUrl(): string {
    const url = this.page.url();
    this.gateUrl(url);
    return url;
  }

  async observe(opts: { regionId?: string; offset?: number } = {}): Promise<Observation> {
    this.gateAction("observe");
    const cfg: ObserveConfig = {
      obsId: `obs${++this.obsCounter}`,
      maxElements: this.policy.observation.maxElements,
      maxTextChars: this.policy.observation.maxTextChars,
      // Tagging and redaction both happen inside the page, so neither an input
      // value nor a subject's record data leaves the browser.
      inputTags: Object.entries(this.inputs).map(([name, value]) => ({ name, value })),
      minTagLength: MIN_TAGGED_VALUE_LENGTH,
      sensitiveSelectors: this.policy.observation.sensitiveSelectors,
      anchorInputs: this.policy.observation.anchorInputs,
      ...(opts.regionId ? { regionId: opts.regionId } : {}),
      ...(opts.offset ? { offset: opts.offset } : {}),
    };
    return this.page.evaluate(buildObservation, cfg);
  }

  /**
   * Clears the redaction markers the observation builder stamped. Capture reads
   * them, so they are stripped once the image exists rather than left on the
   * page for the rest of the run.
   */
  private async clearRedactionMarks(): Promise<void> {
    await this.page
      .evaluate(() => {
        for (const el of Array.from(document.querySelectorAll("[data-tp-redacted]"))) {
          el.removeAttribute("data-tp-redacted");
        }
      })
      .catch(() => {});
  }

  /** Resolve a descriptor to a live element, reporting which rank won. */
  async locate(d: Descriptor, timeoutMs?: number) {
    return resolve(this.page, d, timeoutMs ?? this.policy.budgets.stepTimeoutMs, this.inputs);
  }

  async act(
    action: "click" | "fill" | "select" | "press",
    d: Descriptor,
    literal?: string,
  ): Promise<ActResult> {
    this.gateAction(action);
    const res = await this.locate(d);
    if (!res.ok) {
      return { ok: false, reason: "unresolved", tried: res.tried, detail: `no unique match for ${summarize(d)}` };
    }
    try {
      switch (action) {
        case "click":
          await res.locator.click({ timeout: this.policy.budgets.stepTimeoutMs });
          break;
        case "fill":
          await res.locator.fill(literal ?? "", { timeout: this.policy.budgets.stepTimeoutMs });
          break;
        case "select":
          await res.locator.selectOption(literal ?? "", { timeout: this.policy.budgets.stepTimeoutMs });
          break;
        case "press":
          await res.locator.press(literal ?? "Enter", { timeout: this.policy.budgets.stepTimeoutMs });
          break;
      }
      await this.settle();
      this.gateUrl(this.page.url());
      return { ok: true, rank: res.rank, strategy: res.strategy, tried: res.tried };
    } catch (e) {
      if (e instanceof SafetyViolation) throw e;
      return {
        ok: false,
        reason: "error",
        tried: res.tried,
        detail: e instanceof Error ? e.name : "unknown error",
      };
    }
  }

  /** Explicit wait: the DOM is quiet and any in-flight navigation has landed. */
  async settle(timeoutMs?: number): Promise<void> {
    const budget = timeoutMs ?? this.policy.budgets.stepTimeoutMs;
    await this.page.waitForLoadState("domcontentloaded", { timeout: budget }).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: Math.min(budget, 3000) }).catch(() => {});
  }

  async textOf(d: Descriptor): Promise<string | null> {
    const res = await this.locate(d);
    if (!res.ok) return null;
    return ((await res.locator.textContent()) ?? "").replace(/\s+/g, " ").trim();
  }

  async visibleText(): Promise<string> {
    return this.page.evaluate(() => (document.body.textContent ?? "").replace(/\s+/g, " ").trim());
  }

  /**
   * Masked capture. Masks are composited in-process, so unmasked pixels never
   * reach disk. If safe capture cannot be established the image is omitted and
   * the caller records a sanitized explanation instead.
   */
  async screenshot(): Promise<{ buffer: Buffer } | { buffer: null; omittedReason: string }> {
    try {
      // Redacting the text channel while leaving the same data visible in the
      // image would be worse than not redacting at all, because the claim is
      // what a reader relies on. The observation builder marks what it hid; the
      // mask list picks those up alongside the statically configured selectors.
      const selectors = [...this.policy.maskSelectors, "[data-tp-redacted]"];
      const masks = selectors.map((s) => this.page.locator(s));
      // A sensitive control that no mask covers means capture is not safe.
      const sensitive = await this.page.locator("input[type=password], [data-sensitive]").count();
      if (sensitive > 0) {
        let covered = 0;
        for (const m of masks) covered += await m.count();
        if (covered < sensitive) {
          await this.clearRedactionMarks();
          return { buffer: null, omittedReason: "mask_targets_unresolved" };
        }
      }
      const buffer = await this.page.screenshot({
        type: "jpeg",
        quality: this.policy.observation.screenshotQuality,
        mask: masks,
        maskColor: MASK_COLOR,
        timeout: 5000,
      });
      return { buffer };
    } catch {
      return { buffer: null, omittedReason: "capture_failed" };
    } finally {
      await this.clearRedactionMarks();
    }
  }

  /**
   * Authentication is a precondition, not a discovered step: it runs before the
   * decision loop starts and is re-run by the session-expiry recovery path.
   * Credentials are resolved here and nowhere else, so they never enter a model
   * prompt or an artifact.
   */
  async ensureSession(loginUrl: string, credentialRef: string): Promise<boolean> {
    const user = this.secrets[`${credentialRef}.user`];
    const pass = this.secrets[`${credentialRef}.password`];
    if (!user || !pass) throw new Error(`no credentials registered for ${credentialRef}`);

    await this.navigate(loginUrl);
    // Already signed in: the app redirects away from the login form.
    if (!this.page.url().includes("/login")) return true;

    await this.page.getByLabel("Username", { exact: true }).fill(user);
    await this.page.getByLabel("Password", { exact: true }).fill(pass);
    await this.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await this.settle();
    this.gateUrl(this.page.url());
    return !this.page.url().includes("/login");
  }

  /** True when the app has bounced us to the login form or answered 401. */
  async sessionExpired(): Promise<boolean> {
    const text = await this.visibleText();
    return this.page.url().includes("/login") || text.includes("Your session has expired");
  }

  newRunId(prefix: string): string {
    return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
  }
}
