# TracePilot — V1 Report

TracePilot separates **discovery**, a model-driven exploration that runs once, from **replay**, which executes the result with no model. A successful discovery compiles into a **capability**: a typed, versioned JSON artifact that replays for any parameters. In [`evidence/`](evidence/), `deepseek-flash` discovered DemoBank's address change from its goal alone in 20 model calls. That run compiled to an 18-step capability, which then replayed for a different member with 0 model calls.

## Architecture

```
discover:  observe → sanitized payload → propose → validate → enforce → execute → record
compile:   trace.json ─────────────────────────────────────────────► capability vN.json
replay:    capability + values → precondition → act → explicit wait → checks → record
```

`browser/` is the only module that touches Playwright (observation, locator ladders, masked capture, the policy chokepoint). `discovery/model.ts` is the only LLM SDK import. `compiler/` is a pure function over `contracts/`, and `replay/` is deterministic execution. `workflow/`, `handoff/`, `safety/` and `observability/` are shared by both halves, which differ only in who chooses the next action. Tests enforce three boundaries: replay cannot reach discovery or an LLM SDK, the compiler imports only contracts, and no automation module imports DemoBank.

Each turn the model sees one observation and a one-line ledger of earlier turns. Element ids are scoped to their observation, so a stale reference is refused rather than mis-targeted. The model client is Anthropic-compatible and set in `.env` (DeepSeek by default).

## Artifact schema

A capability declares typed **inputs** and **outputs** (each output with a pattern and an extraction source) and ordered **steps**. A step has a phase, an action and an effect (reversible or consequential). It also has a **descriptor**, a semantic description of the control (role, accessible name, label, nearby text, container) with a ranked locator ladder: role+name, label, placeholder, text-scoped, structural. Its **value** is a reference (`{input}`, an approved `{const}` or a template), never a literal. Each step carries a URL **precondition** such as `/members/{member_id}/edit$`, an explicit **wait**, and **checks** from a closed five-kind vocabulary. **Business-outcome recognizers** identify the application correctly saying no, for example `MEMBER_NOT_FOUND` from "No members matched that search." **Provenance** records the source run, the model and the authorship.

Validation rejects a bad artifact at load time. Every write needs a preceding approval gate, every required output must be bound, and something must be checked after the write. Human-authored steps force `needs_review`.

The **compiler** turns what one run did into what any run should do. URLs become patterns, and every step gains a precondition and a wait. Anything the application *issued*, such as a confirmation id in a URL or locator, is removed. Templates near an optional input are split so they hold whether or not it is empty; cross-member replay failed in both directions without this. `--outcomes` merges in recognizers from runs that ended in a business outcome. A test holds compiled output to the hand-authored oracle's shape: same phases, outputs, single gated write and read-back, at a comparable step count.

## Determinism & error handling

Replay makes no model calls. Its result reports `modelCalls: 0`, and a boundary test makes a model call impossible. Every step runs the same sequence: verify the precondition, act through the ladder, wait explicitly (never sleep), check for deliberate conditions, then evaluate checks. If a lower rung resolves the target, the step still succeeds but is recorded as **drift**, which feeds a fragility score.

Recovery is bounded by `policy.json`: two transient retries, one reload, one re-login (detected from the page or HTTP 401), candidate fall-through and declared dialogs. After a reload, replay rewinds to the earliest step on that page, since a reload discards form input, but never past a write.

Outcomes are typed: `success`, `business_outcome` (the application said no, which is not a failure), `failure`, `safety_violation` and `aborted`. A failure names the step, the expected state, the observed state and the masked evidence. Some conditions are handled deliberately rather than retried. A 403 escalates. An undeclared dialog is dismissed, never accepted. An expiry during the write is never re-driven. Evidence 06 recovers a mid-run expiry with one re-login, and evidence 05 reports a missing member as `business_outcome`.

Discovery is bounded by steps, observations, model calls and wall clock, and four consecutive refusals end it as `DEAD_END`. The loop refuses an assertion or recognizer that does not hold on the live page, and an assertion only this run could satisfy (a copied input, the issued id). It refuses `done` until the write is **read back from the record**: a written input asserted on a page other than where the write landed.

## Heterogeneity & multi-tenant

DemoBank is deliberately hostile to automation. It has no test ids, duplicated "View" links, near-identical buttons, inputs captioned by bare `div`s, and similarly named members. Descriptors cope by describing controls as a person would. They disambiguate rows by **anchoring to an input's value** ("the View link in the row containing `{member_id}`"). They also carry `<input:name>` tags, so a descriptor captured for M-1002 retargets to M-1007 without recompiling. The structural rung is ranked last, and using it counts as drift.

**Other surfaces.** Everything above `browser/` consumes four abstractions: observation, descriptor, action and masked capture. A legacy-web surface (frames) or a desktop surface (UI Automation or AT-SPI accessibility trees) would implement those same four. The accessibility tree supplies the role, name and label semantics the ladder already ranks, so contracts, compiler, replay and handoff stay unchanged. `surfaceKind` is `"web"` in V1.

**Institutions on the same vendor application.** A capability is keyed to the workflow, not the data. Its values are references and its URLs are patterns, so it runs at any origin given with `--base`. `tenantId` and `overrides` are reserved for per-tenant differences, such as a relabelled button or an extra field. Those differences would be applied as a validated overlay at load time, not by forking the capability.

**Versions and drift.** Each run records ladder rank per step, a `surfaceFingerprint` per step and the source `appFingerprint`. In interactive replay, a step that cannot resolve is handed to a person; evidence 08 shows this with a relabelled button. A capability re-discovered after drift compiles to the next version and never overwrites the previous one.

## Escalation & handoff

One `InterventionRequest` covers **blocked discovery** (DEAD_END, a dialog, a 403, an unrecoverable session; an exhausted budget ends as `aborted`), **unrecoverable replay** (an unresolvable target, a failed check or precondition, a 403, a dialog, an expiry during the write) and **approval** before every write. It carries the goal, step, URL, a masked screenshot, expected versus observed state, a reason code and remaining budgets. For approvals, it also carries the exact pending change and its digest.

During a takeover, automation pauses and ownership moves to `HUMAN`; the control ledger records every transfer. The person operates **the same live browser session**. An in-page recorder sends each action out through a binding as it happens, so a navigating click is not lost. A typed value is stored as a reference if it matches a declared input; otherwise the step is marked `unresolved`.

They answer `resume` or `retry` (re-run the step from where they left it), `step_done` (they did it; continue with the next), `complete` (they finished the workflow) or `abort`. Control never returns on the person's word alone. The next precondition is re-verified, so a false `step_done` goes back to them. After `complete`, the declared outputs must still be on the page. Steps the person performed make a compiled capability `needs_review`. Time spent waiting on the person is recorded as `humanWaitMs` and never consumes a timeout.

Approval is separate from takeover. A pre-approval (`--approved-by`) covers **one** write. A second write goes to a person, or is declined when nobody is present. This rule followed a live run that tried to verify by submitting again.

In evidence 08 the repository owner did this by hand: replay handed over at a relabelled button, the recorder captured the owner's one click, and after `step_done` and approval replay finished with 0 model calls.

## Safety

**One chokepoint.** Every navigation, request and action passes the policy in `browser/`, for discovery and replay alike. The policy allowlists origins, routes (globs that cannot span path segments) and actions. DemoBank's `/_admin` scenario controls are not allowlisted, so automation cannot change its own test conditions.

**Writes are classified from the page.** Whether an action writes is decided mechanically: a control's form submit target is matched against `consequentialRoutes`. An unapproved write is refused, whatever the model proposed. Replay also refuses at run time any write with no recorded approval (`APPROVAL_MISSING`). The action grammar offered to the model is narrowed to what policy permits.

**Values never reach the model.** Inputs become `<input:name>` *inside the page*, before an observation leaves the browser. A `fill` names an input, and the executor resolves it in memory. Other members' records are redacted while staying addressable. A payload that still carries a value is refused.

**Persisted records hold references, not values.** Every event is rebuilt from a field allowlist, and raw model payloads are never written. One redaction chokepoint covers every persisted string: credentials, the run's input values (tagged), and PII and API-key shapes. Persisted intervention requests drop current values and page text, while the console still shows the approver the real values.

**Screenshots are masked in-process** over sensitive regions and any element showing a credential or input; if the mask cannot cover a field, none is taken. Credentials exist only in the browser layer, and unsanitized Playwright tracing is off by default. A scan of the 31 run files in `evidence/` found no credential, key, input value or existing address; an earlier generation failed it, and the fixes are in `162efc3`.

## Cuts

- **Fingerprints warn; they do not stop a run.** Replay compares each step's surface fingerprint with the live element and lists mismatches in `drift.fingerprintMismatches`, but the step carries on: the checks decide whether the run worked. The capability's `appFingerprint` is not compared, since it changes exactly when a step's does.
- **Multi-tenant and desktop are designed, not built.** `tenantId`, `overrides` and `surfaceKind` are validated but unused. There is one browser target.
- **Business outcomes are learned from source runs only.** A capability knows only the outcomes its source runs met. An unseen "no" replays as a failure, then a hand-over.
- **Template splitting is a heuristic.** It splits at commas, which suits list-shaped text.
- **Values under three characters are not tagged or masked.** An example is the state code `MA`; substring-tagging values that short would corrupt ordinary text.
- **Interference while the agent holds control is not detected.** The next precondition is the only guard.
- **`deepseek-flash` varies between runs.** The same scenario took 17 to 56 model calls. Prompt caching is not implemented, and the live smoke test does not gate CI.
- **There is no `inspect` command, version diffing, dashboard or deployment.**
