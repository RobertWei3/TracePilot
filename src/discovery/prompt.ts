import type { TaskContract } from "../contracts/index.js";
import type { Observation, ValueVerdict } from "../browser/index.js";
import type { ActionName } from "./actions.js";

/**
 * The agent is told what the goal is, which inputs and outputs are declared,
 * and what the screen currently contains -- and nothing about how to get
 * there. No route, no control name, no ordering. Declaring the input contract
 * is not a task sequence: it says what the workflow consumes and produces, not
 * how the application is laid out.
 */
export function systemPrompt(
  task: TaskContract,
  inputNames: string[],
  outputNames: string[],
  allowed: readonly ActionName[],
): string {
  const can = (a: ActionName): boolean => allowed.includes(a);
  return [
    "You operate a web application through a browser to accomplish a goal, one step at a time.",
    "",
    "You see a structured inventory of the current screen plus a screenshot. Decide the single",
    "next step and call the `act` tool. You will then see the result and decide again.",
    "",
    "## Goal",
    task.goal,
    "",
    "## Declared inputs",
    "You never see input values. Refer to an input by name and the value is typed for you:",
    ...inputNames.map((n) => `  - ${n}`),
    "",
    "Wherever a value you were given appears on screen, the inventory shows it as a tag such as",
    "<input:member_id> instead of the literal text. Treat that tag as proof that the element",
    "carries that input's value -- it is how you confirm you are on the right record.",
    "",
    "You are never shown what a field contains. The `value` column reports a verdict instead:",
    "`matches <name>` means the field holds that input's value, `set` means it holds something",
    "else, `empty` means it is blank, and `masked` means the surface treats it as sensitive.",
    "That is how you confirm a fill landed: fill, observe again, and check the verdict.",
    "",
    "Record data belonging to anyone other than the subject of this task is redacted, and shows",
    "as <other member>. Those rows stay addressable by element id -- you can act on a row you",
    "cannot read. A region shown as OMITTED could not be represented safely at all.",
    "",
    "## Declared outputs",
    "Before finishing you must bind every declared output with an `extract` action:",
    ...outputNames.map((n) => `  - ${n}`),
    "",
    "## Available actions",
    // Derived from policy, so the grammar and the prose agree. An action the
    // operator has withheld is not described as available and is not in the
    // tool's enum either.
    allowed.join(", "),
    "",
    "## Rules",
    "1. Targets are element ids from the CURRENT observation only. Ids look like obs4:el-12.",
    "   An id from an earlier observation is invalid; observe again to get fresh ids.",
    "2. If an observation says it was truncated, or the screenshot shows a control the inventory",
    "   does not list, use `observe` with regionId or nextBatch. Never invent an element id.",
    "3. When several identical controls exist (a table of rows, say), set anchorInput to the name",
    "   of an input whose value identifies the right row. Do not guess by position.",
    "4. Record what success looks like as you go, with `assert` actions. At minimum, assert",
    "   something immediately after any change is submitted, and assert the declared output is",
    "   present. Use assertConst for text the application itself displays, assertInput or",
    "   assertTemplate for values derived from the inputs. For text checks targetId is optional:",
    "   omit it to check the whole visible page. A target's text is only what is inside it, so",
    "   a heading does not contain the rows beneath it. Never copy an input's value into an",
    "   assertion as literal text, even a short one you can read on the page; reference it by name.",
    "   Likewise never spell out an output's value (it changes every run); assert its fixed part,",
    "   such as the prefix the application always shows.",
    "5. Before any action that writes a durable change -- submitting a form that commits data --",
    "   call `request_approval` first. A person authorises it. Never submit without that.",
    "6. Verify rather than assume. A confirmation page says the change was accepted, not that it",
    "   was stored: after the change is submitted, open the record that was changed and assert the",
    "   new values there, referencing the inputs you wrote. A record page often shows values in",
    "   separate rows -- assert each where it appears rather than as one composed string.",
    "   Reading back changes nothing: use the record's view, not its edit form, and never submit",
    "   again. A second write is not covered by the approval you already have.",
    "7. Call `done` only when the goal is achieved, every declared output is bound, and you have",
    "   read the change back from the record (rule 6); `done` is refused until then. Call",
    "   `give_up` if you are stuck, with the reason.",
    ...(can("business_outcome")
      ? [
          "8. If the application itself correctly refuses -- no such record, a rule that forbids the",
          "   change -- that is a business outcome, not a failure. Call `business_outcome` with an",
          "   outcomeCode such as MEMBER_NOT_FOUND and an assertion that recognises it on this page.",
          "   The assertion is checked against the live page before it is accepted, so it must",
          "   already hold. Do not use this to report your own difficulty; use `give_up` for that.",
        ]
      : []),
    "",
    "You see only the current screen. Everything you did before it is summarised under",
    "WHAT HAS HAPPENED SO FAR, including anything that was refused and why.",
    "",
    "Keep `reason` to one short sentence. It is recorded and shown to a person.",
  ].join("\n");
}

/**
 * One line of history. The loop appends an entry per turn -- accepted or
 * refused -- and nothing else of the past is carried forward.
 */
export type LedgerEntry = {
  seq: number;
  /** What was proposed, in reference form: "fill obs4:el-2 {address.city}". */
  proposed: string;
  /** What actually happened: "ok", "REJECTED: ...", "failed: ...". */
  result: string;
};

/**
 * The rolling window's memory.
 *
 * Only the current observation is sent, because element ids are scoped to the
 * observation that produced them: carrying old inventories forward would fill
 * the context with ids that are already invalid and page text that is already
 * stale. What the model needs from the past is not the screens but the
 * decisions -- and the results it does not otherwise get to see -- so that is
 * what this carries, one line each.
 */
export function renderLedger(entries: LedgerEntry[]): string {
  if (entries.length === 0) return "WHAT HAS HAPPENED SO FAR\n(nothing yet -- this is the first step)";
  const width = String(entries[entries.length - 1]!.seq).length;
  const lines = entries.map(
    (e) => ` ${String(e.seq).padStart(width)} ${e.proposed.padEnd(34)} -> ${e.result}`,
  );
  return ["WHAT HAS HAPPENED SO FAR", ...lines].join("\n");
}

/** Compact rendering of an observation. Kept terse to leave budget for reasoning. */
export function renderObservation(obs: Observation, note?: string): string {
  const lines: string[] = [];
  if (note) lines.push(`RESULT: ${note}`, "");
  lines.push(`OBSERVATION ${obs.obsId}`);
  lines.push(`url: ${obs.url}`);
  lines.push(`title: ${obs.title}`);
  if (obs.dialogText) lines.push(`DIALOG PRESENT: ${obs.dialogText}`);
  if (obs.errorTexts.length) lines.push(`ERRORS: ${obs.errorTexts.join(" | ")}`);
  lines.push(
    `elements: ${obs.returned} of ${obs.totalEligible}${obs.truncated ? " (TRUNCATED -- more not shown)" : ""}`,
  );
  lines.push(
    `regions: ${obs.regions
      .map((r) =>
        r.omitted
          ? `${r.regionId}=OMITTED (sensitive, no safe representation)`
          : `${r.regionId}="${r.name}" (${r.elementCount})`,
      )
      .join(", ")}`,
  );
  lines.push("");
  lines.push("id | role | name | nearby caption | value | region");
  for (const e of obs.elements) {
    // Whether a field is filled is the only evidence that a fill landed, and on
    // an edit form the page text carries nothing about field contents at all.
    // What is rendered is a verdict, never the contents: the comparison happens
    // in the browser and only its result travels.
    const bits = [
      e.id,
      e.role + (e.enabled ? "" : " (disabled)"),
      e.name || "-",
      e.nearbyText && e.nearbyText !== e.name ? e.nearbyText : "-",
      describeVerdict(e.valueVerdict),
      e.regionName,
    ];
    lines.push(bits.join(" | "));
  }
  if (obs.textTruncated) lines.push("", "(page text was truncated)");
  lines.push("", "PAGE TEXT:", obs.text);
  return lines.join("\n");
}

/** A field's state, stated without stating its contents. */
function describeVerdict(v: ValueVerdict): string {
  switch (v.kind) {
    case "empty":
      return "empty";
    case "matches":
      return `matches ${v.input}`;
    case "unsupplied":
      return "set, not a supplied value";
    case "masked":
      return "sensitive, masked";
  }
}
