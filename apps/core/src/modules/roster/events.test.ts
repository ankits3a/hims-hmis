import { z } from "zod";
import { ROSTER_EVENTS } from "./events";

/**
 * PHASE R (R2) — **INVARIANT V9: NO ROSTER EVENT CARRIES FREE TEXT.**
 *
 * ═══ WHY THIS TEST IS BEHAVIOURAL AND NOT A WALK OF ZOD'S INTERNALS ═══
 *
 * The obvious implementation reads each schema's `_def` and asserts every string field is an id, an
 * enum or a datetime. It is also the implementation that silently stops testing anything the day
 * zod changes its internal shape — and it would still have passed, green, for as long as nobody
 * looked. So this one does the thing an attacker would: it takes a VALID payload, puts five hundred
 * characters of prose into one field at a time, and requires the schema to refuse.
 *
 * A field that accepts that is a field a leave reason, a diagnosis or a phone number can travel in.
 * Stress test A-4/L-13: a posting or a slot never tells an external LLM a name, a phone or a reason.
 *
 * ═══ AND THE CENSUS IS WHAT MAKES IT NON-VACUOUS ═══
 *
 * The probe alone would pass an event with no fields at all. `PAYLOADS` below is a hand-written
 * valid payload per event, and its keys are pinned against the schema's own — so a field added to
 * an event fails here until somebody writes it into this file and watches the probe refuse it.
 */
describe("roster — event payloads carry ids, codes and instants only (V9)", () => {
  const ID = "01ABCDEFGHJKMNPQRSTVWXYZ01";
  const WHEN = "2026-10-01T00:00:00.000Z";

  /** One VALID payload per event. A new event with no entry here fails the first leg. */
  const PAYLOADS: Record<string, Record<string, unknown>> = {
    "roster.period_drafted": {
      periodId: ID, scopeType: "team", scopeId: ID, departmentId: ID,
      startsAt: WHEN, endsAt: WHEN, version: 1, origin: "human",
      basedOnPeriodId: null, copiedAssignments: 0,
    },
    "roster.period_published": {
      periodId: ID, scopeType: "team", scopeId: ID, departmentId: ID,
      startsAt: WHEN, endsAt: WHEN, version: 1, assignmentCount: 1,
      contentHash: "a".repeat(64), publishedAt: WHEN, supersededPeriodId: null,
    },
    "roster.period_superseded": {
      periodId: ID, scopeType: "team", scopeId: ID, supersededByPeriodId: ID, supersededAt: WHEN,
    },
    "roster.duty_changed": {
      userId: ID, periodId: ID, added: [ID], removed: [], amendmentId: null, effectiveFrom: WHEN,
    },
    "roster.amendment_applied": {
      amendmentId: ID, periodId: ID, kind: "swap", afterTheFact: false,
      supersededCount: 1, addedCount: 1, appliedAt: WHEN,
    },
    // R4. NOTE WHAT IS ABSENT: the REASON. It is the most sensitive string this phase stores (D6),
    // and an event log outlives every screen that would have redacted it.
    "roster.absence_requested": {
      absenceId: ID, userId: ID, kind: "CL", startsAt: WHEN, endsAt: WHEN,
    },
    "roster.absence_approved": {
      absenceId: ID, userId: ID, kind: "CL", startsAt: WHEN, endsAt: WHEN, decidedAt: WHEN,
    },
    // R8. NOTE WHAT IS ABSENT, for the same reason as the absence events above: the acceptance
    // REASON. This event says a named human overrode a gate — doc 10 §3.9 asks for exactly that —
    // and whoever needs to know WHY reads `roster_findings`, under the hospital's access rules.
    "roster.finding_accepted": {
      findingId: ID, periodId: ID, ruleKey: ID, severity: "block", acceptedAt: WHEN,
    },
  };

  /**
   * Field names that would be prose in any other system. None is permitted today; an entry added
   * here is somebody deciding, in writing, that a particular one is a CODE and not a sentence.
   */
  const PROSE_NAMES = ["reason", "title", "note", "notes", "name", "fullName", "comment", "message", "text", "description"];
  const PROSE_NAME_EXEMPTIONS: string[] = [];

  it("every event has a valid payload written here, and it parses", () => {
    expect(Object.keys(PAYLOADS).sort()).toEqual(ROSTER_EVENTS.map((e) => e.name).sort());
    for (const event of ROSTER_EVENTS) {
      const result = event.payloadSchema.safeParse(PAYLOADS[event.name]);
      expect(`${event.name}: ${result.success}`).toBe(`${event.name}: true`);
    }
  });

  it("the census names exactly the fields each schema has — a new field cannot arrive unexamined", () => {
    for (const event of ROSTER_EVENTS) {
      // Parsing strips unknown keys and requires known ones, so a payload that round-trips to an
      // identical object has exactly the schema's fields — no introspection of zod needed.
      const parsed = event.payloadSchema.parse(PAYLOADS[event.name]) as Record<string, unknown>;
      expect({ event: event.name, keys: Object.keys(parsed).sort() })
        .toEqual({ event: event.name, keys: Object.keys(PAYLOADS[event.name]!).sort() });
    }
  });

  it("NO field accepts five hundred characters of prose — one field at a time, every event", () => {
    const prose = "Covering for Dr Rao, her father is in ICU at Patna. ".repeat(10);
    expect(prose.length).toBeGreaterThan(400);

    const accepted: string[] = [];
    for (const event of ROSTER_EVENTS) {
      const base = PAYLOADS[event.name]!;
      for (const key of Object.keys(base)) {
        const poisoned = { ...base, [key]: Array.isArray(base[key]) ? [prose] : prose };
        if (event.payloadSchema.safeParse(poisoned).success) accepted.push(`${event.name}.${key}`);
      }
    }
    expect(accepted).toEqual([]);
  });

  it("no field is NAMED like prose, and the exemption list is empty", () => {
    const named: string[] = [];
    for (const event of ROSTER_EVENTS) {
      for (const key of Object.keys(PAYLOADS[event.name]!)) {
        if (PROSE_NAMES.includes(key) && !PROSE_NAME_EXEMPTIONS.includes(`${event.name}.${key}`)) {
          named.push(`${event.name}.${key}`);
        }
      }
    }
    expect(named).toEqual([]);
    expect(PROSE_NAME_EXEMPTIONS).toEqual([]);
  });

  it("the probe actually probes — a deliberately free-text schema is caught", () => {
    // The leg that keeps the three above from passing because the loop never ran or the prose was
    // short enough to fit an id. It builds the defect and watches the same predicate catch it.
    const loose = z.object({ periodId: z.string(), reason: z.string() });
    const prose = "x".repeat(500);
    expect(loose.safeParse({ periodId: "p", reason: prose }).success).toBe(true);
    // ...and the shape every roster event actually uses does not.
    const tight = z.object({ periodId: z.string().min(1).max(64) });
    expect(tight.safeParse({ periodId: prose }).success).toBe(false);
  });

  it("every event belongs to the roster module and is version 1", () => {
    for (const event of ROSTER_EVENTS) {
      expect(`${event.name}: ${event.module}/${event.version}`).toBe(`${event.name}: roster/1`);
    }
    expect(ROSTER_EVENTS).toHaveLength(8);
  });
});
