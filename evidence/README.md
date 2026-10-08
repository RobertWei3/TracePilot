# Evidence

Everything here was produced by real runs of this repository against DemoBank on
2026-10-08. The code was at commit `162efc3`, and discovery used `deepseek-flash`.
Nothing was written by hand, with the exceptions listed under
[What was altered after the run](#what-was-altered-after-the-run).

Each numbered directory holds one run:

- `console.txt` is what the CLI printed.
- `run/` is TracePilot's own record of the run, copied verbatim:
  - `events.jsonl`: every action, decision reason, refusal and control transfer.
  - `result.json`: the structured outcome.
  - `trace.json`: present for discovery runs.
  - `intervention-*.json`: every hand-over.
  - masked screenshots.

| # | Run | Outcome | Model calls |
| --- | --- | --- | --- |
| [01](01-discovery/) | Discovery for M-1002 from the goal alone | `success`, `CONF-NB6GUD75` | 20 |
| [02](02-discovery-member-not-found/) | Discovery for M-9999, who does not exist | `business_outcome` `MEMBER_NOT_FOUND` | 10 |
| [03](03-capability/) | Compile 01, with 02's recognizer, into a capability | `ready`, 18 steps | – |
| [04](04-replay-other-member/) | Replay 03 for a different member, M-1007 | `success`, `CONF-BTYV8GQT` | **0** |
| [05](05-replay-member-not-found/) | Replay 03 for M-9999 | `business_outcome` `MEMBER_NOT_FOUND` | 0 |
| [06](06-session-expiry-recovered/) | Replay 03 with the session expiring mid-run | `success` after one re-login | 0 |
| [07](07-permission-denied-handoff/) | Replay 03 with the operator's role refused (HTTP 403) | hand-over, then `aborted`; nothing written | 0 |
| [08](08-drift-handoff-step-done/) | Replay a drifted copy of 03; a person performs the step it cannot | hand-over, `step_done`, then `success` | 0 |

## What each run shows

**01: discovery.** The run received the goal and the target URL, and nothing
else: no route, no selectors, no step list. The model observed the page and
proposed one action per turn. Each action was validated before it ran.

- Before the write, the run stopped for approval. The prompt showed the
  pending change (see `console.txt`) and was answered `resume`.
- It then read the change back from the member record before `done` was
  accepted.

**02: a business outcome is not a failure.** The application correctly said
"No members matched that search." The model reported `MEMBER_NOT_FOUND` with a
recognizer, and the loop checked that recognizer against the live page before
accepting it. The recognizer it wrote is the hand-authored oracle's check, word
for word.

**03: the capability.** It is a typed, versioned JSON artifact, separate from
the run record. It contains:

- ordered steps with semantic locator ladders;
- `{member_id}` and `{address.*}` parameters in place of values;
- URL preconditions and explicit waits;
- an approval gate before the single write;
- the confirmation id extracted by pattern;
- a read-back on the member record, where s18 asserts `{address.line1}`;
- 02's recognizer.

`console.txt` lists what the compiler changed. For example, it removed this
run's confirmation id from the extract's locator, and it split a template at the
optional `address.line2`.

**04: replay with different parameters, and no model.** The capability
discovered for M-1002 updated M-1007. The approval was answered at the prompt.

**05: business outcome on replay.** The capability tells a missing member apart
from a broken run, using 02's recognizer.

**06: bounded recovery.** The session expired at DemoBank's 8th authenticated
request (`expire_at_request=8`). Replay detected the expiry, signed in once
(`recovery session_relogin`), re-verified where it was, and finished.

**07: an unrecoverable condition hands over.** With `force_403=true`, the edit
page refused the operator's role. Replay did not retry a deliberate refusal: it
raised an intervention. The intervention named the goal, step, URL, expected
state, observed state and reason, and control passed to `HUMAN`. The answer was
`abort`, so nothing was written.

**08: manual takeover, and replay carries on.** The capability was copied to
`drifted-capability.json` with one change: the Review button's label was set to
"Preview changes", as if the application had been relabelled.

1. Replay could not find the button, retried twice, and handed over at s11.
2. A person clicked the real button in the same live browser session.
3. The recorder captured that click (`human_action click`), and only that
   click.
4. The answer was `step_done`.
5. Replay re-verified the next step's precondition, ran the approval gate,
   wrote, extracted and read back.

## What was altered after the run

- **`console.txt`.** The console is a live operator display. Its approval
  prompt shows real values by design, because an approval is meaningless
  without them. When it was saved here:
  - every input value was replaced with `<input:name>`;
  - each field's current value in the approval prompt was replaced with
    `<current value>`;
  - Node's `ExperimentalWarning` lines were dropped.

  Nothing in `run/` was altered.
- **`08-drift-handoff-step-done/person.txt`.** This is the output of the
  process that played the person. The member id it printed was replaced with
  `<input:member_id>`.

## Who answered, and who was "the person"

Nobody was at the console during these runs.

- **The prompts** (approvals, `abort` in 07, `step_done` in 08) were typed
  into the real CLI prompt by the Claude Code session that produced this
  evidence, acting for the repository owner. The CLI read them from stdin
  exactly as it would read a person's.
- **"The person" in 08** was a separate process. It connected to the same live
  browser over the Chrome DevTools Protocol and clicked the real button with
  real input events, while the CLI waited at its prompt.

That exercises the actual takeover path: the same session, the in-page recorder,
the stdin prompt, and re-verification on hand-back. It is still not a human
operator, and a recording of one doing 07 or 08 by hand would be the stronger
demonstration.

## Leak scan

Every text file here (33) was scanned for:

- the DemoBank credentials and the model API key from `.env`;
- every value in `values/*.json` of three or more characters;
- every seeded member's existing street, city and state, and ZIP.

There were no hits.

The six screenshots were inspected by eye. The username, member row, current
and new address and every filled field are masked.

One exception is by design: two-letter state codes are shorter than the
three-character threshold the text channel also uses, so `MA` remains legible
in a filled State field.

An earlier generation of this directory failed that scan. That failure is what
led to the fixes in `162efc3`: input-tagging at the redaction chokepoint,
persisted interventions without current values, and screenshot masking of
credentials and inputs. The directory was then regenerated from scratch.

## Reproducing

DemoBank runs on `localhost:4000` (`npm run demobank -- serve`). Reset it before
each run.

```bash
npm run tp -- discover --task tasks/update-mailing-address.json --values values/member-1002.json
npm run tp -- discover --task tasks/update-mailing-address.json --values values/member-missing.json
npm run tp -- compile --run runs/<01> --task tasks/update-mailing-address.json --outcomes runs/<02>
npm run tp -- replay --capability capabilities/demobank.update_mailing_address.v1.json --values values/member-1007.json
npm run tp -- replay --capability capabilities/demobank.update_mailing_address.v1.json --values values/member-missing.json
npm run demobank -- scenario set expire_at_request=8   # then the 04 command
npm run demobank -- scenario set force_403=true        # then the 04 command
npm run tp -- replay --capability <a copy with the Review label changed> --values values/member-1002.json
```

These runs used `--headless`. Without it, the browser window is visible, and
`--slow 500` makes it easy to follow.
