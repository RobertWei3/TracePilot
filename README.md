# TracePilot

A browser agent that is allowed to discover a workflow once, and never again.

Most web agents re-decide everything on every run: the same page is re-read, the
same reasoning is re-done, and the same task can fail differently each time.
TracePilot separates the two things that were conflated. **Discovery** is a
model-driven exploration of an unfamiliar application, run once, under a budget,
with a human at the approval gate. What it produces is a **capability** — a
declarative artifact describing the workflow it found. **Replay** executes that
artifact deterministically, with no model in the loop at all: no API key, no
tokens, no non-determinism, and a failure that names the step, the expected
state and the observed state rather than a transcript to read.

The design premise is that everything between a decision and the page should be
mechanical. The model chooses one action at a time; the system decides whether
that action is allowed, resolves what it targets, substitutes the values, checks
the result, and writes the record.

## Status

Built in stages, each proven before the next depends on it:

| Stage | What it establishes |
| --- | --- |
| **P0** | Node 24 + TypeScript layout, Playwright, and import-boundary tests that make two spec rules executable |
| **P1a** | Contracts (zod + JSON Schema), the safety layer, and DemoBank — the deliberately unhelpful demo application |
| **P1b** | The browser surface: observation, the locator ladder, and a single policy chokepoint |
| **P2** | Deterministic replay, proven against a hand-authored capability used as an oracle |
| **P3** | The discovery loop: one model call, one validated action |

Replay was built before discovery on purpose. A hand-written artifact under
`tests/fixtures/` is the oracle, so the executor, contracts, safety gate and
checks were all proven before a single token was spent on a model.

Still ahead: compiling a discovery trace into a capability artifact, which is
what closes the loop between the two halves. The trace P3 records is typed for
exactly that.

## How it works

```
observe → sanitized payload → propose → validate → enforce → execute → record → observe
```

Each turn the loop takes one observation of the page, renders it into the single
model-bound payload format, asks for exactly one action, and then stops trusting
the model entirely:

- **Targets are observation-scoped.** An element id refers to the observation
  that produced it. A reference carried over from an earlier turn is rejected
  rather than silently addressing a different control.
- **Values are never literals.** A `fill` names a declared input; the executor
  resolves it in memory. An input value cannot appear in a prompt or a response
  at all.
- **The grammar is narrowed by policy.** The action enum handed to the model is
  the intersection of what the system can express and what policy permits, so a
  withheld action is unrepresentable rather than merely refused — and the loop
  re-checks before executing anyway.
- **Writes are gated from the page, not the proposal.** An observed element
  carries its enclosing form's submit target, so effect classification reads the
  page. An unapproved consequential click is refused whether or not the model
  remembered to ask for approval.
- **Claims are verified before they are believed.** An assertion that does not
  hold on the page that authored it is refused. So is a business-outcome
  recognizer that does not match — relabelling its own failure as "the
  application said no" is the most attractive exit a stuck agent has.
- **Being stuck is reported, not ground out.** A rejected proposal costs one
  model call and is fed back. N rejections in a row report `DEAD_END` rather
  than burning the budget into refusals and calling it exhaustion.

Context is rolling: each turn carries a one-line ledger and only the current
observation, so "targets come from the current observation" is a property of the
context rather than a rule the model has to remember.

## Safety

Safety is structural rather than advisory — the guarantees hold because the code
cannot express the alternative.

- **One chokepoint.** The surface layer is the only thing that touches a
  browser, so a single policy check covers discovery and replay both. Origins,
  routes and actions are allowlisted in `policy.json`.
- **Input values never reach a prompt.** The in-page observation builder
  replaces any text matching a resolved input with `<input:name>` before the
  observation leaves the browser. This turned out to be more than redaction:
  descriptors carry the tags, so substituting current values back at resolve
  time makes a descriptor *parameterized* — one captured for `M-1002` retargets
  to `M-1007` without recompilation.
- **Records are built from an allowlist.** Every persisted event is rebuilt from
  an explicit field specification, so a field added upstream is dropped rather
  than inspected. Raw model payloads have no specification at all: they live in
  memory for the run and are never written.
- **Screenshots are masked in-process**, and refused outright when a mask cannot
  cover a sensitive field.
- **Undeclared dialogs are recorded and dismissed, never accepted.**
- **Credentials are resolved in the browser layer only**, registered for
  redaction before use, and never sent to the model.

## DemoBank

The target application ships with the repo, because an agent that only works
against a cooperative page proves nothing. DemoBank is a Fastify + EJS +
`node:sqlite` member-service app with six synthetic members and a deliberately
unhelpful DOM: no test IDs, duplicated "View" links, near-identical buttons, and
two similarly-named Danas.

Failure scenarios are toggled through `/_admin`, which the policy deliberately
does not allowlist — so the automation is structurally incapable of changing its
own test conditions. Available scenarios: session expiry (by TTL or on a chosen
request), slow search, forced 403, and an undeclared native dialog on submit.

## Quickstart

Requires Node 24+.

```bash
npm install
npx playwright install chromium
cp .env.example .env      # add ANTHROPIC_API_KEY for discovery only
```

Run the application:

```bash
npm run demobank -- serve            # http://localhost:4000
npm run demobank -- reset            # restore the database
npm run demobank -- scenario set force_403=true
```

Run discovery against it:

```bash
npm run tp -- discover \
  --task tasks/update-mailing-address.json \
  --values values/member-1002.json
```

Options: `--policy <file>`, `--base <url>`, `--headless`, `--no-handoff` (never
prompt; escalations end the run, for CI), and `--approved-by <who>` (authorize
the write in advance, for unattended runs).

A run prints its outcome, reason code, declared outputs, budget consumption, a
fragility score, and the evidence directory — illustrative shape:

```
success [OK]  run discovery-...
outputs   : {"confirmation_id":"CONF-8KD24QW1"}
budgets   : 11 steps | 14 observations | 12 model calls
fragility : 0 step(s) below rank 1 (0.00)
evidence  : runs/discovery-...
```

## Outcomes

A run ends in exactly one of five outcomes, with a typed reason code. The
distinction that matters most: **`business_outcome` is not failure.** If the
application correctly refuses — a validation rejection, a locked record — that
is a successful automation of a "no", and it is reported with the check that
recognized it. `failure` means the automation broke; `safety_violation` means it
was stopped by policy; `aborted` means a person stopped it.

Lifecycle is independent of outcome: an escalation ends the executor with
`awaiting_human` and no terminal outcome, which does not mark the run finished.

## Layout

```
src/contracts/      TaskContract, Capability, ExecutionResult, Policy (zod → JSON Schema)
src/safety/         allowlists, effect classification, redaction, allowlist serializer
src/browser/        the only module that touches Playwright: observe, descriptors, driver
src/discovery/      the model loop: prompt, payload, action grammar, executor
src/replay/         deterministic execution, rewind, session recovery
src/workflow/       checks, value resolution, approval modes
src/handoff/        operator console, control ledger, human recorder
src/observability/  run store and budget ledger
src/demobank/       the demo application and its operator CLI
src/cli/            the discovery entry point
```

Two boundaries are enforced by test rather than convention: replay may not reach
the LLM module, and no automation module may import DemoBank.

## Testing

```bash
npm test          # 94 tests
npm run typecheck
```

The suite runs against a real browser and the real application — scripted-model
tests cover one case per stop condition and one per refusal. A live-model smoke
test covers the prompt itself and skips without an API key, so a model's
judgement never gates CI.

## License

MIT
