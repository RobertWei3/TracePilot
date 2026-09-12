import Anthropic from "@anthropic-ai/sdk";
import { RawAction, actTool, type ActionName } from "./actions.js";
import type { ModelPayload } from "./payload.js";
import { renderLedger, type LedgerEntry } from "./prompt.js";

/**
 * The only file in this repository that imports an LLM SDK.
 *
 * `tests/boundaries.test.ts` asserts that as an import-graph property, so the
 * separation replay depends on is enforced rather than remembered. Everything
 * above this line is a narrow interface, which is also what lets the loop's
 * stop conditions be tested with a scripted client against a real browser
 * instead of a mocked one.
 */
export type Proposal =
  | { ok: true; raw: RawAction }
  /** The model decided something unusable: no tool call, or args that fail the schema. */
  | { ok: false; kind: "protocol"; detail: string }
  /** The call never produced a decision: network, rate limit, server error. */
  | { ok: false; kind: "transport"; detail: string };

export type ModelRequest = {
  system: string;
  payload: ModelPayload;
  ledger: LedgerEntry[];
  /** Fed back after a refusal, so the correction is attached to the retry. */
  correction?: string;
};

export interface ModelClient {
  readonly name: string;
  propose(req: ModelRequest): Promise<Proposal>;
}

/**
 * Transport retries are bounded here rather than in `policy.recovery`, which
 * governs the browser. A 429 is not a fact about the application under test.
 */
const TRANSPORT_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1500, 4000];

/**
 * `TRACEPILOT_EFFORT` is a word; the API takes a thinking budget. Mapping the
 * two here keeps the documented knob honest -- accepting the setting and then
 * ignoring it would be worse than not offering it.
 */
const THINKING_BUDGET: Record<string, number> = {
  low: 0,
  medium: 2_000,
  high: 6_000,
  xhigh: 12_000,
  max: 24_000,
};

export type AnthropicOptions = {
  apiKey: string;
  model: string;
  effort: string;
  allowed: readonly ActionName[];
  maxTokens?: number;
  /** Injected in tests so a retry path can be exercised without waiting. */
  sleep?: (ms: number) => Promise<void>;
};

export class AnthropicModelClient implements ModelClient {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: AnthropicOptions) {
    this.name = o.model;
    this.client = new Anthropic({ apiKey: o.apiKey });
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async propose(req: ModelRequest): Promise<Proposal> {
    if (req.payload.blocked) {
      // Unreachable if the loop is behaving: a blocked payload must never get
      // this far. Refusing here too means a future caller cannot make the
      // mistake quietly.
      return { ok: false, kind: "protocol", detail: `payload blocked: ${req.payload.reason}` };
    }

    const content: Anthropic.ContentBlockParam[] = [];
    if (req.payload.image) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: req.payload.image.mediaType,
          data: req.payload.image.data.toString("base64"),
        },
      });
    }
    content.push({
      type: "text",
      text: [
        renderLedger(req.ledger),
        "",
        req.correction ? `YOUR LAST PROPOSAL WAS REFUSED: ${req.correction}\n` : "",
        req.payload.text,
      ].join("\n"),
    });

    const tool = actTool(this.o.allowed);
    const budget = THINKING_BUDGET[this.o.effort] ?? THINKING_BUDGET.medium!;
    const maxTokens = this.o.maxTokens ?? (budget > 0 ? budget + 2048 : 2048);
    // Forced tool choice and extended thinking are mutually exclusive, so the
    // guarantee shifts with the setting: without thinking the model cannot
    // reply with anything but an action, and with it a stray prose reply is
    // caught by `parse` and charged as a protocol failure instead.
    const toolChoice: Anthropic.ToolChoice =
      budget > 0 ? { type: "auto" } : { type: "tool", name: "act" };
    let lastDetail = "no attempt was made";

    for (let attempt = 0; attempt < TRANSPORT_ATTEMPTS; attempt += 1) {
      try {
        const message = await this.client.messages.create({
          model: this.o.model,
          max_tokens: maxTokens,
          system: req.system,
          tools: [tool as unknown as Anthropic.Tool],
          tool_choice: toolChoice,
          ...(budget > 0 ? { thinking: { type: "enabled" as const, budget_tokens: budget } } : {}),
          messages: [{ role: "user", content }],
        });
        return this.parse(message);
      } catch (e) {
        if (!isRetryable(e)) {
          return { ok: false, kind: "transport", detail: describeError(e) };
        }
        lastDetail = describeError(e);
        if (attempt < TRANSPORT_ATTEMPTS - 1) await this.sleep(BACKOFF_MS[attempt] ?? 4000);
      }
    }
    return { ok: false, kind: "transport", detail: `${lastDetail} (after ${TRANSPORT_ATTEMPTS} attempts)` };
  }

  /**
   * A reply that carries no usable action is a protocol failure, not a
   * transport one: the model did decide, it just decided something the loop
   * cannot execute. The distinction matters because only one of the two is
   * worth charging to the decision budget.
   */
  private parse(message: Anthropic.Message): Proposal {
    const block = message.content.find((c) => c.type === "tool_use" && c.name === "act");
    if (!block || block.type !== "tool_use") {
      const said = message.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join(" ")
        .slice(0, 200);
      return {
        ok: false,
        kind: "protocol",
        detail: said ? `replied with text instead of calling act: "${said}"` : "no act tool call",
      };
    }
    const parsed = RawAction.safeParse(block.input);
    if (!parsed.success) {
      return {
        ok: false,
        kind: "protocol",
        detail: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      };
    }
    return { ok: true, raw: parsed.data };
  }
}

function describeError(e: unknown): string {
  if (e instanceof Anthropic.APIError) return `${e.status ?? "?"} ${e.name}`;
  if (e instanceof Error) return e.name;
  return "unknown error";
}

/** Rate limits, server faults and connection errors; nothing about the request. */
function isRetryable(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    return status === 429 || status >= 500;
  }
  return false;
}

/**
 * Discovery reads its model configuration from the environment, as
 * `.env.example` documents. Replay never calls this and never needs a key.
 */
export function modelFromEnv(allowed: readonly ActionName[]): AnthropicModelClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set; discovery needs a model");
  return new AnthropicModelClient({
    apiKey,
    model: process.env.TRACEPILOT_MODEL ?? "claude-sonnet-5",
    effort: process.env.TRACEPILOT_EFFORT ?? "medium",
    allowed,
  });
}
