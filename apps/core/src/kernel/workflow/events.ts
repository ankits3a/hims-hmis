import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

// The plan's complete event surface — five catalog names (§10.6), module "workflow".

export const workflowDefinitionUpdated = defineEvent(
  "workflow.definition.updated",
  "workflow",
  z.object({
    definitionId: z.string(),
    defKey: z.string(),
    version: z.number().int(),
    changeClass: z.enum(["A", "B", "C"]),
    action: z.enum(["drafted", "approved", "activated"]),
    emergency: z.boolean().optional(), // set on E-5 emergency-path approvals/activations
    retiredVersion: z.number().int().optional(), // set when activation retires a previous version
  }),
);

export const slaBreached = defineEvent(
  "sla.breached",
  "workflow",
  z.object({
    instanceId: z.string(),
    defKey: z.string(),
    definitionVersion: z.number().int(),
    state: z.string(),
    slaMinutes: z.number().int(),
    alerting: z.enum(["active", "record_only"]), // §10.3: structure everywhere, alerts selective
    dueAt: z.string(), // ISO timestamp
  }),
);

export const escalationTriggered = defineEvent(
  "escalation.triggered",
  "workflow",
  z.object({
    instanceId: z.string(),
    defKey: z.string(),
    state: z.string(),
    rung: z.number().int(),
    role: z.string(),
    resolvedUserIds: z.array(z.string()), // static role holders — roster substrate is the Plan 11 seam
    fallback: z.boolean(), // rung role resolved to nobody; duty_manager took over (fix 11)
    fallbackExhausted: z.boolean(), // even duty_manager empty — owner SMS is Plan 10's half of fix 11
  }),
);

export const instanceMigrated = defineEvent(
  "instance.migrated",
  "workflow",
  z.object({
    instanceId: z.string(),
    defKey: z.string(),
    fromDefinitionId: z.string(),
    toDefinitionId: z.string(),
    fromVersion: z.number().int(),
    toVersion: z.number().int(),
    fromState: z.string(),
    toState: z.string(),
    reason: z.string(),
  }),
);

export const instanceAborted = defineEvent(
  "instance.aborted",
  "workflow",
  z.object({
    instanceId: z.string(),
    defKey: z.string(),
    state: z.string(),
    reason: z.string(),
  }),
);
