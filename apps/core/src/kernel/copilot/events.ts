import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * E0.1 — the ask ledger was pruned. A COUNT, once per sweep, never one event per row — the
 * `search.audit_pruned` shape and reason: after the delete nothing else can say how much was there.
 */
export const copilotAsksPruned = defineEvent(
  "copilot.asks_pruned",
  "copilot",
  z.object({
    rows: z.number().int().positive(),
    retainDays: z.number().int().positive(),
    cutoff: z.string().min(1),
  }),
);

/**
 * E0.3 — the copilot's halt switch was thrown or cleared. Each names WHO by the event's actor, and
 * the scope; a clear also names who had halted it and when, so the pair reads as one story.
 */
export const copilotHaltSet = defineEvent(
  "copilot.halt_set",
  "copilot",
  z.object({ scope: z.enum(["read", "act", "draft", "global"]), reason: z.string().max(200).nullable() }),
);

export const copilotHaltCleared = defineEvent(
  "copilot.halt_cleared",
  "copilot",
  z.object({
    scope: z.enum(["read", "act", "draft", "global"]),
    haltedBy: z.string().min(1),
    haltedAt: z.string().min(1),
  }),
);
