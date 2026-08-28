import { and, eq, inArray } from "drizzle-orm";
import { opdEncounters } from "../../kernel/db/schema";
import { doctorForUser } from "./masters";
import { istDate } from "./time";
import type { CareContext } from "../../kernel/phi/audit";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07a T2 — HOW WAS THIS READER CONNECTED TO THIS PATIENT'S CARE, RIGHT NOW?
 *
 * The PHI access log stamps this at write time because it is only knowable then: the encounter
 * closes, the doctor changes, the queue empties, and an hour later the same read looks different.
 *
 * ═══ WHY THREE VALUES AND NOT A BOOLEAN ═══
 *
 * `requireTreatingDoctor` already answers the clinician question — is this actor the doctor ON this
 * encounter — and it is the right answer for a WRITE. It is the wrong answer for a read log,
 * because most legitimate reads are not by the treating doctor at all: the registration clerk
 * checking a phone number, the cashier reading a payer, the vitals nurse opening the chart she is
 * about to write into. Marking all of those "out of context" would put a few hundred blameless
 * rows a day on a review worklist, and a worklist nobody can finish is a worklist nobody reads.
 *
 * So `serving` exists between `treating` and `none`, and `none` stays rare enough to mean
 * something: nobody at this hospital is looking after this patient today, and somebody opened
 * their chart anyway.
 *
 * ═══ THE STATUSES THAT COUNT AS LIVE ═══
 *
 * Everything the OPD visit definition treats as non-terminal. `completed` and `abandoned` are the
 * two terminal states, so an encounter in either is history rather than care in progress — reading
 * a chart because of a visit that finished last Tuesday is exactly the `none` this exists to name.
 */
const LIVE_STATUSES = ["registered", "waiting", "in_consultation", "awaiting_results"] as const;

export async function careContextFor(
  db: Db,
  actor: Actor,
  patientId: string,
  now: Date = new Date(),
): Promise<CareContext> {
  // System actors are internal machinery, not people looking at charts.
  if (actor.type !== "user") return "none";

  const live = await db
    .select({ doctorId: opdEncounters.doctorId })
    .from(opdEncounters)
    .where(and(
      eq(opdEncounters.patientId, patientId),
      eq(opdEncounters.serviceDate, istDate(now)),
      inArray(opdEncounters.status, [...LIVE_STATUSES]),
    ));
  if (live.length === 0) return "none";

  const doctor = await doctorForUser(db, actor.id);
  if (doctor && live.some((e) => e.doctorId === doctor.id)) return "treating";
  return "serving";
}
