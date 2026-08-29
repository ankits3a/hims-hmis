import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * PLAN 07c T3 — AN EXPORT IS A DATA-EGRESS EVENT, AND IT IS THE ONE THING HERE THAT BELONGS ON THE
 * SPINE.
 *
 * Reading a report is telemetry; taking a copy of it out of the building is a fact about the
 * hospital. After an incident, "who exported the day's patient list, and when" is asked by people
 * who will not accept "we don't record that" — and the DPDP register needs an answer that is not a
 * web-server log. The row COUNT rides along for the same reason `search.audit_pruned` carries one:
 * afterwards, nothing else can say how much left.
 */
export const reportExported = defineEvent(
  "report.exported",
  "report",
  z.object({
    date: z.string().min(1),
    scope: z.string().min(1),
    sections: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
  }),
);
