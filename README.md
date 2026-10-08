# TracePilot

**TracePilot uses an AI model to discover a browser workflow once, then replays it with no model at all.**

Most browser agents re-read the page and reason it out again on every run, so a
task can fail differently each time. TracePilot splits the job into two halves:

- **Discover.** A model explores an unfamiliar web app *once*, within a budget. A
  person approves any change it makes.
- **Replay.** The result is compiled into a reviewable JSON **capability**, which
  runs again for any inputs. Replay needs no model, no API key and no tokens, and
  it takes the same steps every time.

When a replay fails, it names the step, what it expected and what it found. It
can also hand the live browser to a person, who finishes the step and hands it
back.

```
discover (model, once) ─► trace ─► compile ─► capability.json ─► replay (no model, any inputs)
```

The repository includes **DemoBank**, a deliberately awkward member-service app
to run TracePilot against. The [`evidence/`](evidence/) folder holds real runs,
and [`REPORT.md`](REPORT.md) explains the design.

---

## Quickstart

TracePilot requires **Node 24+**.

```bash
npm install
npx playwright install chromium
cp .env.example .env        # then add DEEPSEEK_API_KEY (needed for discovery only)
```

**1. Start the demo app.** Keep this terminal open.

```bash
npm run demobank -- serve   # http://localhost:4000
```

**2. Discover the workflow.** A browser window opens, and the model works through
the task. Before the model submits, the terminal shows exactly what will change.
Type `resume` to approve it or `abort` to stop.

```bash
npm run demobank -- reset
npm run tp -- discover --task tasks/update-mailing-address.json --values values/member-1002.json
```

**3. Compile the run into a capability.** Use the run folder printed on the last
line of step 2.

```bash
npm run tp -- compile --run runs/discovery-<id> --task tasks/update-mailing-address.json
```

**4. Replay the capability for a different member.** No model is used.

```bash
npm run demobank -- reset
npm run tp -- replay --capability capabilities/demobank.update_mailing_address.v1.json \
  --values values/member-1007.json
```

Every run ends with a summary like this:

```
success [OK]  run replay-2026-10-08T04-23-14-098Z
outputs   : {"confirmation_id":"CONF-BTYV8GQT"}
budgets   : 18 steps | 0 observations | 0 model calls
evidence  : runs/replay-2026-10-08T04-23-14-098Z
```

> Run these commands in your own terminal, not through a tool that captures their
> output. The approval and hand-over prompts need you to type an answer.

## Watching a run, and taking over

The browser is visible by default. Add `--slow 1000` to pause before each browser
action, so you can follow along. The terminal prints one line per step as it
happens.

When a run needs a person, it pauses and prints an **intervention**:

- the step it was on;
- the current page;
- what it expected to find;
- what it actually found;
- a screenshot.

The browser stays live, so you can operate it yourself and then answer in the
terminal:

| Answer | Meaning |
| --- | --- |
| `resume` / `retry` | Run the step again from where you left the page. |
| `step_done` | You did this step yourself. Continue with the next one. |
| `complete` | You finished the whole workflow. Verify it and collect the outputs. |
| `abort` | Stop the run. |

Wait for the prompt before you touch the browser. Actions you take while the
automation is in control are not recorded as yours.

TracePilot does not take your word for it. After you hand back, it checks that
the page is where the next step expects. A run you `complete` must still show
its outputs on the page.

## Commands

| Command | What it does |
| --- | --- |
| `npm run tp -- discover --task <file> --values <file>` | Explores the app with the model and writes a run folder under `runs/`. |
| `npm run tp -- compile --run <dir> --task <file>` | Turns a successful run into `capabilities/<id>.v<N>.json`. It never overwrites an earlier version. |
| `npm run tp -- replay --capability <file> --values <file>` | Runs a capability with new inputs, using no model. |

Options for `discover` and `replay`:

| Option | Effect |
| --- | --- |
| `--slow <ms>` | Pause before each browser action. |
| `--headless` | Hide the browser window. |
| `--approved-by <name>` | Approve the run's one write in advance, for unattended runs. |
| `--no-handoff` | Never prompt. A run that needs a person stops instead. Use this for CI. |
| `--quiet` | Don't print each step. |
| `--base <url>` | Run against another origin. The default is `http://localhost:4000`. |
| `--policy <file>` | Use a different safety policy. The default is `policy.json`. |

Options for `compile`:

| Option | Effect |
| --- | --- |
| `--outcomes <run>,...` | Also learn from runs that ended in a business outcome (see below), so replay can recognize those outcomes. |
| `--out <dir>` | Write the capability somewhere other than `capabilities/`. |

## How a run can end

| Outcome | Meaning |
| --- | --- |
| `success` | The workflow completed, and its result was verified. |
| `business_outcome` | The app correctly said no, for example "No members matched that search." This is **not** a failure. |
| `failure` | The automation could not complete. The report names the step, the expected state and the observed state. |
| `safety_violation` | The safety policy stopped the run, for example because a route is not allowed. |
| `aborted` | A person stopped the run, or a budget ran out. |

Each run's full record is in `runs/<id>/`:

- `events.jsonl` holds every step and decision.
- `result.json` holds the outcome.
- `trace.json` records what discovery did, for the compiler.
- `screenshots/` holds masked screenshots.

## Safety at a glance

- **The browser is allowlisted.** It can reach only the origins, routes and
  actions listed in `policy.json`. One chokepoint enforces this for both
  discovery and replay.
- **Every write needs approval.** A person approves it, or `--approved-by`
  approves it in advance. In discovery, a pre-approval covers exactly one write.
  Replay refuses any write that has no recorded approval.
- **Your data never reaches the model.** Input values are replaced with
  `<input:name>` inside the page, before anything is sent.
- **Logs and screenshots hold references, not values.** Credentials and inputs
  are redacted from every saved file and masked in screenshots.

For details, see the Safety section of [`REPORT.md`](REPORT.md).

## Configuration

Settings live in `.env`, which you copy from `.env.example`:

| Variable | Purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` | Model key for discovery. Set `ANTHROPIC_API_KEY` instead to use Claude. If both are set, DeepSeek is used. |
| `TRACEPILOT_MODEL` | Model override. If empty, the default is `deepseek-flash` (DeepSeek) or `claude-sonnet-5-5` (Anthropic). |
| `TRACEPILOT_EFFORT` | Reasoning effort, from `low` to `max`. Use `low` with `deepseek-flash`. |
| `DEMOBANK_USER` / `DEMOBANK_PASS` | DemoBank login. These are never sent to the model or written to any record. |

Replay, compile and the demo app need **no API key** and run fully offline.

## DemoBank

DemoBank is a small member-service app with six synthetic members, built with
Fastify, EJS and SQLite. It is deliberately awkward to automate:

- there are no test IDs;
- the "View" links are duplicated;
- buttons look nearly identical;
- two members are both named Dana.

An agent that only works on tidy pages proves nothing.

```bash
npm run demobank -- reset                          # restore data and clear scenarios
npm run demobank -- scenario set force_403=true    # turn on a failure scenario
npm run demobank -- scenario get                   # show the current scenarios
```

| Scenario | Effect |
| --- | --- |
| `expire_at_request=<n>` | The session expires once, on the n-th request. |
| `session_ttl=<seconds>` | Sessions are short and expire repeatedly. |
| `slow_search=true` | Search results load slowly. |
| `force_403=true` | The edit page refuses the operator's role. |
| `extra_dialog=true` | An unexpected confirmation dialog appears on submit. |

The automation cannot change these scenarios itself, because the admin routes
are deliberately outside its allowlist.

## Project layout

```
src/
├── browser/        the only code that touches the browser
├── discovery/      the model loop, and the only code that calls a model
├── compiler/       run → capability
├── replay/         runs a capability, with no model
├── handoff/        intervention prompts, control hand-over, recording a person's actions
├── safety/         allowlists, approval rules, redaction
├── workflow/       checks and value resolution shared by discovery and replay
├── contracts/      the JSON schemas
├── observability/  run records and budgets
├── demobank/       the demo app
└── cli/            the tp command
tasks/              task definitions: goal, inputs, outputs
values/             example inputs for each member
```

## Testing

```bash
npm test             # 133 tests, against a real browser and the real demo app
npm run typecheck
```

The tests use a scripted model, so they are deterministic and need no API key.
One live-model test runs only when a key is set, and it never gates CI.

## Further reading

- [`REPORT.md`](REPORT.md) covers the architecture, the capability format, error
  handling, other surfaces and multiple tenants, hand-over, safety and known
  limitations.
- [`evidence/`](evidence/) holds real discovery and replay runs. They include a
  replay with different inputs, recovery from an expired session, a permission
  refusal handed to a person, and a takeover done by hand.

## License

MIT
