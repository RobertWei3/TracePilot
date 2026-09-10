import { z } from "zod";

/**
 * Enforced identically in discovery and replay. Loaded from policy.json.
 */
export const Policy = z
  .object({
    allowedOrigins: z.array(z.string().url()).min(1),
    /** Glob-ish route allowlist. Anything not matched is refused. */
    allowedRoutes: z.array(z.string()).min(1),
    allowedActions: z.array(z.string()).min(1),
    /** Routes whose mutation is consequential and therefore gated. */
    consequentialRoutes: z.array(z.string()).default([]),
    /** Constants the compiler may embed as literals. Everything else must be a ref. */
    approvedConstants: z.array(z.string()).default([]),
    budgets: z
      .object({
        actionSteps: z.number().int().min(1),
        observations: z.number().int().min(1),
        modelCalls: z.number().int().min(1),
        wallClockMs: z.number().int().min(1000),
        stepTimeoutMs: z.number().int().min(500),
      })
      .strict(),
    observation: z
      .object({
        maxElements: z.number().int().min(10),
        maxTextChars: z.number().int().min(200),
        screenshotWidth: z.number().int().min(320),
        screenshotHeight: z.number().int().min(240),
        screenshotQuality: z.number().int().min(10).max(100),
      })
      .strict(),
    recovery: z
      .object({
        transientRetries: z.number().int().min(0).max(5),
        reloads: z.number().int().min(0).max(2),
        relogins: z.number().int().min(0).max(2),
      })
      .strict(),
    /** Selectors masked in every screenshot before transmission and persistence. */
    maskSelectors: z.array(z.string()).default([]),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;
