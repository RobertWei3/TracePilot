import type { Actor } from "../contracts/index.js";
import type { RunStore } from "../observability/index.js";

/**
 * Explicit control ownership. Every transition is a logged event with an
 * attributed actor and a reason, so "the human took over" is a tracked state
 * change rather than an untracked mutation the agent later acts on blindly.
 */
export class ControlLedger {
  private current: Actor = "NONE";
  readonly transitions: { from: Actor; to: Actor; at: string; reason: string }[] = [];

  constructor(private readonly store: RunStore) {}

  owner(): Actor {
    return this.current;
  }

  transfer(to: Actor, reason: string): void {
    if (to === this.current) return;
    const from = this.current;
    this.current = to;
    const at = new Date().toISOString();
    this.transitions.push({ from, to, at, reason: reason.slice(0, 200) });
    this.store.event({
      type: "control_transfer",
      actor: to === "HUMAN" ? "HUMAN" : to === "AGENT" ? "AGENT" : "SYSTEM",
      reason: `${from} -> ${to}: ${reason}`,
    });
  }

  assertOwner(expected: Actor, what: string): void {
    if (this.current !== expected) {
      throw new Error(`${what} requires control to be ${expected}, but it is ${this.current}`);
    }
  }
}
