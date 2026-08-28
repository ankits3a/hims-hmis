import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * PLAN 07a T2 — ONE event, and it is about DESTRUCTION rather than access.
 *
 * Ordinary reads stay off the spine for the reason `db/schema/phi-access.ts` gives: at 2,000 visits
 * a day they arrive on the rhythm of a mouse, and the spine is sized for semantic facts. The one
 * thing that IS a fact about the hospital is the moment an access log is pruned — because after the
 * delete nothing else in the system can answer "how much was in it". A retention window that
 * destroys a records-access log and leaves no record of the destruction is the kind of gap an
 * auditor finds rather than is told about. `search.audit_pruned` carries the same reasoning.
 */
export const phiAccessPruned = defineEvent(
  "phi.access_log_pruned",
  "phi",
  z.object({
    rows: z.number().int().positive(),
    retainDays: z.number().int().positive(),
    cutoff: z.string().min(1),
  }),
);
