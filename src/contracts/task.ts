import { z } from "zod";
import { FieldSpec } from "./common.js";

/**
 * Input to discovery. Declares the *types* of the workflow's inputs and outputs
 * upfront -- but prescribes no navigation, no targets and no ordering, so
 * discovery stays genuinely LLM-driven. Values live in a separate values file.
 */
export const TaskContract = z
  .object({
    taskId: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/, "taskId must look like vendor.workflow"),
    goal: z.string().min(10),
    targetUrl: z.string().url(),
    inputs: z.record(FieldSpec),
    outputs: z.record(FieldSpec),
    requires: z
      .object({
        session: z.object({ credentialRef: z.string().min(1) }).strict().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type TaskContract = z.infer<typeof TaskContract>;
