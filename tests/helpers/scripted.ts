import assert from "node:assert/strict";
import type { ModelClient, ModelRequest, Proposal } from "../../src/discovery/model.js";
import { RawAction } from "../../src/discovery/actions.js";

/**
 * A model whose decisions are written in advance.
 *
 * It is handed the same rendered payload the real client would send and has to
 * find its targets in it, so a script cannot address an element the model
 * could not have seen. That is deliberate: a stub that reached around the
 * payload boundary would quietly make these tests prove less than they claim.
 */
export type Row = {
  id: string;
  role: string;
  name: string;
  nearby: string;
  value: string;
  region: string;
};

export function rows(text: string): Row[] {
  return text
    .split("\n")
    .filter((l) => /^obs\d+:el-\d+ \| /.test(l))
    .map((l) => {
      const [id, role, name, nearby, value, region] = l.split(" | ");
      return {
        id: id!,
        role: role!,
        name: name!,
        nearby: nearby!,
        value: value!,
        region: region ?? "",
      };
    });
}

export function pick(text: string, pred: (r: Row) => boolean, what: string): string {
  const hit = rows(text).find(pred);
  assert.ok(hit, `no element matching ${what} in:\n${text.slice(0, 2000)}`);
  return hit.id;
}

/** One scripted decision, written against what the payload currently shows. */
export type Move = (text: string) => Partial<RawAction> & { action: RawAction["action"] };

export class ScriptedModel implements ModelClient {
  readonly name = "scripted";
  /** Every payload the loop asked about, for assertions on what was sent. */
  readonly seen: string[] = [];
  /** What the loop told the model about each earlier turn, as of each call. */
  readonly ledgers: ModelRequest["ledger"][] = [];
  private cursor = 0;

  constructor(
    private readonly moves: Move[],
    /** Returned once every move is used up, so a loop cannot spin forever. */
    private readonly exhausted: Move = () => ({ action: "give_up", reason: "script exhausted" }),
  ) {}

  async propose(req: ModelRequest): Promise<Proposal> {
    assert.equal(req.payload.blocked, false, "a blocked payload must never reach the model");
    const text = req.payload.blocked ? "" : req.payload.text;
    this.seen.push(text);
    this.ledgers.push(req.ledger.map((e) => ({ ...e })));
    const move = this.moves[this.cursor++] ?? this.exhausted;
    return { ok: true, raw: RawAction.parse({ reason: "scripted", ...move(text) }) };
  }

  get used(): number {
    return this.cursor;
  }
}

/** A client that fails the way a network does, to exercise the transport path. */
export class FailingModel implements ModelClient {
  readonly name = "failing";
  calls = 0;
  constructor(private readonly kind: "transport" | "protocol" = "transport") {}
  async propose(): Promise<Proposal> {
    this.calls += 1;
    return { ok: false, kind: this.kind, detail: "simulated" };
  }
}
