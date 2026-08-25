import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * PLAN 11h T5 — ONE event, and the count is the point.
 *
 * DD4 keeps ordinary searching OFF the spine (see `db/schema/search.ts`), so this file names the
 * single case that is a FACT ABOUT THE HOSPITAL rather than telemetry: a record the caller may not
 * fully read was nonetheless surfaced to them as a restricted stub. That is an access-control
 * event, it is rare, and it is exactly the kind of thing a reviewer should be able to find by
 * replaying the spine rather than by remembering to query a side table.
 *
 * TWO CASES THE PHASE DOCUMENT NAMED AND THIS FILE DOES NOT DEFINE, disclosed rather than quietly
 * dropped:
 *   - "break-glass used from the palette" — T2 REMOVED break-glass from the search path entirely
 *     (it was a privilege escalation; see that commit), so there is no such moment to record. If
 *     the owner's D6 ruling puts it back, the event is defined then, beside the code that can fire
 *     it.
 *   - "a sealed row returned to an authorised holder" — the fan-out cannot observe this. It sees
 *     hits, not confidentiality; only the patients provider knows, and teaching the wire response
 *     to carry "this row was confidential" would put a flag on the response purely so the audit
 *     layer could read it. The moment that actually matters is the OPEN, and `search_audit`
 *     records that with the record's own ref.
 */
export const searchRestrictedSurfaced = defineEvent(
  "search.restricted_surfaced",
  "search",
  z.object({
    auditId: z.string().min(1),
    entities: z.array(z.string().min(1)).min(1), // which entity classes carried a restricted stub
    count: z.number().int().positive(),
  }),
);

/**
 * The access log was pruned. It carries the ROW COUNT for the reason `retention.partition_dropped`
 * carries its own: after the delete, nothing else in the system can answer "how much was in it",
 * and a retention window that destroys an access log without leaving a record of the destruction
 * is the kind of gap an auditor finds rather than is told about.
 */
export const searchAuditPruned = defineEvent(
  "search.audit_pruned",
  "search",
  z.object({
    rows: z.number().int().positive(),
    retainDays: z.number().int().positive(),
    cutoff: z.string().min(1),
  }),
);

/**
 * An actor was refused for rate (DD8). It is an EVENT rather than a row in `search_audit` for two
 * reasons: it must be RARE — a desk cannot reach the limit by typing — and counting refusals in the
 * table the limiter reads would make every retry extend the block. If this name starts appearing in
 * volume, that is the signal it exists to give.
 */
export const searchRateLimited = defineEvent(
  "search.rate_limited",
  "search",
  z.object({
    windowSec: z.number().int().positive(),
    limit: z.number().int().positive(),
    used: z.number().int().nonnegative(),
    retryAfterSec: z.number().int().positive(),
  }),
);
