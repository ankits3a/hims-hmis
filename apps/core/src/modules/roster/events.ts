import { z } from "zod";
import { defineEvent } from "@hmis/contracts";
import {
  ROSTER_AMENDMENT_KINDS, ROSTER_ORIGINS, ROSTER_RULE_SEVERITIES, ROSTER_SCOPE_TYPES,
  STAFF_ABSENCE_KINDS,
} from "../../kernel/db/schema/roster";

const MODULE = "roster";

/**
 * PHASE R (R2) — **INVARIANT V9: EVERY PAYLOAD IS IDS, CODES AND INSTANTS.**
 *
 * ═══ WHY A ROSTER EVENT IN PARTICULAR MUST CARRY NO PROSE ═══
 *
 * The event log is read by consumers this module does not know, is retained far longer than a
 * roster, and — this being an agentic system — is a plausible thing for a future summariser to
 * feed to a model. A roster's free text is exactly the material that must never travel: a swap's
 * reason is *"covering for Dr Rao, her father is in ICU"*, a withdrawal's is *"suspended pending
 * enquiry"*, an absence's is a diagnosis. Stress test A-4/L-13: **a posting or a slot never tells
 * an external LLM a name, a phone or a leave reason.**
 *
 * The title of a period is prose too, and is equally absent: a consumer that wants it reads the
 * row, under whatever permission it holds, at the moment it needs it.
 *
 * So the three constructors below are the only string shapes used, and `events.test.ts` walks every
 * schema and fails on any field that is not one of them:
 *
 *   · **`id()`** — an opaque identifier, capped so prose cannot be smuggled through one;
 *   · **`code()`** — a closed vocabulary, imported from the schema so it cannot drift from the CHECK;
 *   · **`instant()`** — an ISO-8601 instant, never a formatted local time.
 */

/** A ULID is 26 characters. The cap is what makes this a different TYPE from free text, not a hint. */
const id = (): z.ZodString => z.string().min(1).max(64);
const code = (values: readonly string[]) => z.enum([...values] as [string, ...string[]]);
const instant = (): z.ZodString => z.string().datetime();

const scopeType = () => code(ROSTER_SCOPE_TYPES);

export const rosterPeriodDrafted = defineEvent("roster.period_drafted", MODULE, z.object({
  periodId: id(),
  scopeType: scopeType(),
  scopeId: id().nullable(),
  departmentId: id().nullable(),
  startsAt: instant(),
  endsAt: instant(),
  version: z.number().int().positive(),
  origin: code(ROSTER_ORIGINS),
  basedOnPeriodId: id().nullable(),
  copiedAssignments: z.number().int().nonnegative(),
}));

/**
 * The governed act (D3). `supersededPeriodId` is on the SAME event on purpose: a consumer that
 * caches "who is on" must drop v1 and take v2 in one step, and two events would give it an instant
 * in which both — or neither — were live.
 *
 * `contentHash` travels because it is the only thing that lets a later reader ask *"is this the
 * roster the head actually approved?"* without trusting the row it is asking about.
 */
export const rosterPeriodPublished = defineEvent("roster.period_published", MODULE, z.object({
  periodId: id(),
  scopeType: scopeType(),
  scopeId: id().nullable(),
  departmentId: id().nullable(),
  startsAt: instant(),
  endsAt: instant(),
  version: z.number().int().positive(),
  assignmentCount: z.number().int().positive(),
  contentHash: id(),
  publishedAt: instant(),
  supersededPeriodId: id().nullable(),
}));

export const rosterPeriodSuperseded = defineEvent("roster.period_superseded", MODULE, z.object({
  periodId: id(),
  scopeType: scopeType(),
  scopeId: id().nullable(),
  supersededByPeriodId: id(),
  supersededAt: instant(),
}));

/**
 * ═══ THE ONE EVENT A PERSON'S OWN SCREEN LISTENS TO ═══
 *
 * One per PERSON per publish or amendment, not one per slot: *"your duties changed"* is the thing a
 * resident needs at 19:30 on the evening a holiday is declared, and twelve separate slot events
 * would arrive as twelve notifications about one change.
 *
 * `added` and `removed` are assignment IDS. Deliberately not the windows: a consumer that renders
 * them reads the rows, so the person's clearance is applied at read time rather than baked into a
 * log entry that outlives it.
 */
export const rosterDutyChanged = defineEvent("roster.duty_changed", MODULE, z.object({
  userId: id(),
  periodId: id(),
  added: z.array(id()),
  removed: z.array(id()),
  amendmentId: id().nullable(),
  effectiveFrom: instant(),
}));

export const rosterAmendmentApplied = defineEvent("roster.amendment_applied", MODULE, z.object({
  amendmentId: id(),
  periodId: id(),
  kind: code(ROSTER_AMENDMENT_KINDS),
  afterTheFact: z.boolean(),
  supersededCount: z.number().int().nonnegative(),
  addedCount: z.number().int().nonnegative(),
  appliedAt: instant(),
}));

/**
 * PHASE R (R4) — somebody has asked to be away. **The REASON is not here and never will be**: it is
 * the most sensitive string this phase stores (D6), and an event log outlives every screen that
 * would have redacted it. A consumer that needs it reads the row under `redactReason`.
 */
export const rosterAbsenceRequested = defineEvent("roster.absence_requested", MODULE, z.object({
  absenceId: id(),
  userId: id(),
  kind: code(STAFF_ABSENCE_KINDS),
  startsAt: instant(),
  endsAt: instant(),
}));

/**
 * The moment a clinic's appointments stop being answerable. `modules/opd`'s `needs_rebooking`
 * cascade subscribes to this, which is what lets a JUNIOR RESIDENT's approved leave move an OPD
 * list — something `opd_doctor_leaves` could never express, because a JR has no row in it.
 */
export const rosterAbsenceApproved = defineEvent("roster.absence_approved", MODULE, z.object({
  absenceId: id(),
  userId: id(),
  kind: code(STAFF_ABSENCE_KINDS),
  startsAt: instant(),
  endsAt: instant(),
  decidedAt: instant(),
}));

/**
 * PHASE R (R8) — **THE OVERRIDE, EVENTED.**
 *
 * Doc 10 §3.9 rules post-night rest a hard block with an *evented* HOD override, and R-067 makes a
 * staffing shortfall a gate. Both are overridden the same way: a named human accepts the finding.
 * This is the event that makes the override visible outside the roster.
 *
 * **The REASON is deliberately not in the payload.** V9 admits ids, codes and instants only, and an
 * acceptance reason is exactly the free text this file's header warns about — *"covering for Dr
 * Rao, her father is in ICU"*. Whoever needs the reason reads `roster_findings`, where it is kept
 * forever under the hospital's own access rules; the event says that an override happened, who did
 * it and against which rule, and nothing a summariser could turn into a disclosure.
 */
export const rosterFindingAccepted = defineEvent("roster.finding_accepted", MODULE, z.object({
  findingId: id(),
  periodId: id(),
  ruleKey: id(),
  severity: code(ROSTER_RULE_SEVERITIES),
  acceptedAt: instant(),
}));

export const ROSTER_EVENTS = [
  rosterPeriodDrafted, rosterPeriodPublished, rosterPeriodSuperseded,
  rosterDutyChanged, rosterAmendmentApplied, rosterAbsenceRequested, rosterAbsenceApproved,
  rosterFindingAccepted,
] as const;
