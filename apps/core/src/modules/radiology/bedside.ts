import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { orderItems } from "../../kernel/db/schema/orders";
import { patients } from "../../kernel/db/schema/patients";
import { resources } from "../../kernel/db/schema/resources";
import { displayName } from "../patients";
import { RadiologyError } from "./errors";
import { DEVICE_PORTABLE_ATTRIBUTE } from "./kinds";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18-S RS2b — **THE PORTABLE ROUND, AND THE SEAM THE WARD WILL READ.**
 *
 * 18a-iii T3 made a bedside study the SAME study with a place (`imaging_studies.bedside_location`)
 * and nothing ever listed those studies: a technologist with the X-ray trolley had no way to see
 * which beds were waiting. This file is that list, in two cuts over one query.
 *
 *   · `portableRound` — the technologist's round: bedside studies BOOKED on a portable machine and
 *     still to be done (scheduled → in_acquisition), sorted by place then slot, so the trolley walks
 *     the ward in order. Route: `GET /radiology/portable/round` behind `radiology.acquire`.
 *   · `bedsideStudiesFor` — the IPD SEAM (below). Same row shape.
 *
 * ═══ THE PATIENT'S NAME FOLLOWS THE WORKLIST'S RULES, AND THE READ LOGS LIKE IT ═══
 *
 * `displayName` renders a CONFIDENTIAL patient under the alias for a reader without
 * `patients.confidential.read` — the legal name never leaves this function for that reader.
 * `restricted` (the PCPNDT flag on the order item) is returned as a LABEL, exactly as `read.ts`'s
 * F45 ruling has it on the worklist. One `phi_access_log` row per distinct patient on surface
 * `imaging.worklist`: the round is a departmental queue of who is being imaged, the same class of
 * disclosure as the worklist and the device diary, and a third surface name for it would split one
 * question ("who looked at the imaging queue") across two answers.
 */
export type BedsideStudyRow = {
  studyId: string;
  accessionNo: string;
  status: string;
  priority: string;
  studyTypeCode: string;
  /** The ward and bed, as the ordering side wrote it. Never null on this read. */
  bedsideLocation: string;
  scheduledAt: Date | null;
  /** Null when the study is not booked yet (only `bedsideStudiesFor` returns such rows). */
  deviceResourceId: string | null;
  deviceCode: string | null;
  encounterNo: string;
  patientId: string;
  /** Through `displayName` — a confidential patient shows their alias to a reader without clearance. */
  patientName: string;
  restricted: boolean;
};

/** Still to be done at the bed. `acquired` onwards is the reading room's; the round is finished. */
const ROUND_STATUSES = ["scheduled", "checked_in", "ready", "in_acquisition"] as const;

const device = alias(resources, "bedside_device");

/**
 * The place STARTS WITH the prefix as a whole word: "Ward 3" matches "Ward 3 · bed 12" and "ward 3"
 * but not "Ward 30 · bed 2" — a ward seeing another ward's patients is the failure a plain
 * `ILIKE 'Ward 3%'` would ship. Case-insensitive; every character of the prefix is literal (a `%`,
 * `_` or `.` in a ward name is a character, not a pattern).
 */
function wordPrefixPattern(prefix: string): string {
  return `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^[:alnum:]])`;
}

async function bedsideRows(
  db: Db,
  actor: Actor,
  opts: { bookedOnPortable: boolean; locationPrefix?: string; surfaceReason: string },
): Promise<BedsideStudyRow[]> {
  if (actor.type !== "user") {
    throw new RadiologyError(
      "forbidden",
      `a ${actor.type} actor may not read the bedside imaging list — it names patients (DD11)`,
    );
  }
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const prefix = opts.locationPrefix?.trim();

  const rows = await db
    .select({
      studyId: imagingStudies.id,
      accessionNo: imagingStudies.accessionNo,
      status: imagingStudies.status,
      priority: imagingStudies.priority,
      studyTypeCode: imagingStudies.studyTypeCode,
      bedsideLocation: imagingStudies.bedsideLocation,
      scheduledAt: imagingStudies.scheduledAt,
      deviceResourceId: imagingStudies.deviceResourceId,
      deviceCode: device.code,
      deviceAttributes: device.attributes,
      encounterNo: imagingStudies.encounterNo,
      patientId: imagingStudies.patientId,
      restricted: orderItems.restricted,
      name: patients.name,
      alias: patients.alias,
      isConfidential: patients.isConfidential,
    })
    .from(imagingStudies)
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .leftJoin(device, eq(device.id, imagingStudies.deviceResourceId))
    .where(and(
      isNotNull(imagingStudies.bedsideLocation),
      inArray(imagingStudies.status, [...ROUND_STATUSES]),
      ...(opts.bookedOnPortable
        ? [sql`(${device.attributes} ->> ${DEVICE_PORTABLE_ATTRIBUTE}) = 'true'`]
        : []),
      ...(prefix ? [sql`${imagingStudies.bedsideLocation} ~* ${wordPrefixPattern(prefix)}`] : []),
    ))
    .orderBy(asc(imagingStudies.bedsideLocation), sql`${imagingStudies.scheduledAt} asc nulls last`)
    .limit(500);

  const reason = `${opts.surfaceReason}, ${String(rows.length)} rows`;
  for (const patientId of new Set(rows.map((r) => r.patientId))) {
    await recordPhiAccess(db, { actor, patientId, surface: "imaging.worklist", reason });
  }

  return rows.map((r) => ({
    studyId: r.studyId,
    accessionNo: r.accessionNo,
    status: r.status,
    priority: r.priority,
    studyTypeCode: r.studyTypeCode,
    bedsideLocation: r.bedsideLocation ?? "",
    scheduledAt: r.scheduledAt,
    deviceResourceId: r.deviceResourceId,
    deviceCode: r.deviceCode,
    encounterNo: r.encounterNo,
    patientId: r.patientId,
    patientName: displayName(
      { name: r.name, alias: r.alias, isConfidential: r.isConfidential }, canSeeConfidential,
    ),
    restricted: r.restricted,
  }));
}

/** The technologist's round: booked on a portable machine, still to be done, by place then slot. */
export async function portableRound(db: Db, actor: Actor): Promise<BedsideStudyRow[]> {
  return bedsideRows(db, actor, { bookedOnPortable: true, surfaceReason: "portable round" });
}

/**
 * ═══ THE IPD SEAM — `bedsideStudiesFor(db, actor, locationPrefix)` ═══
 *
 * **Built ahead of the IPD plan, with no route of its own on purpose** (owner, 28 Sep: *"work on
 * the deferred items. We will connect it later when full IPD plan is built."*). The ward screen the
 * IPD plan builds imports THIS, through `modules/radiology/index.ts`, to show a ward's imaging —
 * "Ward 3" returns every bedside study whose place starts with that text, case-insensitively.
 *
 * It differs from the round in one way: it also returns bedside studies NOT YET BOOKED
 * (`deviceResourceId` and `deviceCode` null), because a ward's first question is "has radiology
 * picked up my request", and a list of only booked studies cannot answer it.
 *
 * **The permission decision belongs to the calling route**, as it does for `deviceDiary`: the IPD
 * plan decides which ward role may see its own ward's imaging and guards its route with that. What
 * this function keeps regardless of caller is the part that must not vary — a user actor only, the
 * alias for a confidential patient, and one PHI row per patient disclosed.
 */
export async function bedsideStudiesFor(
  db: Db, actor: Actor, locationPrefix: string,
): Promise<BedsideStudyRow[]> {
  return bedsideRows(db, actor, {
    bookedOnPortable: false, locationPrefix, surfaceReason: `bedside studies for "${locationPrefix}"`,
  });
}
