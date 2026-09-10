import { zodToJsonSchema } from "zod-to-json-schema";
import { Capability } from "./capability.js";
import { ExecutionResult } from "./result.js";
import { InterventionRequest } from "./intervention.js";
import { TaskContract } from "./task.js";
import { Policy } from "./policy.js";

/**
 * JSON Schema is emitted for review and documentation. zod remains the
 * enforcement layer -- cross-field rules expressed with superRefine are not
 * representable in JSON Schema and are therefore not present here.
 */
export const jsonSchemas = {
  TaskContract: () => zodToJsonSchema(TaskContract, "TaskContract"),
  Capability: () => zodToJsonSchema(Capability, "Capability"),
  ExecutionResult: () => zodToJsonSchema(ExecutionResult, "ExecutionResult"),
  InterventionRequest: () => zodToJsonSchema(InterventionRequest, "InterventionRequest"),
  Policy: () => zodToJsonSchema(Policy, "Policy"),
} as const;
