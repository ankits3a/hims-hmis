import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

const MODULE = "roster";
const id = z.string().min(1);

export const rosterPeriodDrafted = defineEvent("roster.period_drafted", MODULE, z.object({
  periodId: id,
  scopeType: z.string().min(1),
  scopeId: z.string().nullable(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  version: z.number().int().positive(),
  copiedFromPeriodId: z.string().nullable(),
}));

/**
 * The governed act (D3). `supersededPeriodId` is on the SAME event on purpose: a consumer that
 * caches "who is on" must drop v1 and take v2 in one step, and two events would give it an instant
 * in which both — or neither — were live.
 */
export const rosterPeriodPublished = defineEvent("roster.period_published", MODULE, z.object({
  periodId: id,
  scopeType: z.string().min(1),
  scopeId: z.string().nullable(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  version: z.number().int().positive(),
  assignmentCount: z.number().int().positive(),
  supersededPeriodId: z.string().nullable(),
}));

export const ROSTER_EVENTS = [rosterPeriodDrafted, rosterPeriodPublished] as const;
