/**
 * Who authorised a consequential change, and when they did it.
 *
 * Shared by discovery and replay because the question is the same in both: a
 * durable write needs a person behind it. `interactive` asks one at the moment
 * of the write. `pre_approved` records that someone authorised the run in
 * advance -- which is what an unattended run needs, and the reason it is a
 * named mode carrying an identity and a timestamp rather than a flag. The
 * diff and its digest are computed either way, so the record says exactly what
 * was authorised, not merely that something was.
 */
export type ApprovalMode =
  | { mode: "interactive" }
  | { mode: "pre_approved"; approvedBy: string; at: string };
