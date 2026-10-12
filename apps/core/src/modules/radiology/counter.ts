import { and, eq, inArray } from "drizzle-orm";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { patients } from "../../kernel/db/schema/patients";
import { services } from "../../kernel/db/schema/tariff";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { displayName } from "../patients";
import { deriveGateSet } from "./checkin";
import { RadiologyError } from "./errors";
import { pregnancyPolicy } from "./gates";
import { authorisationOf, encounterPayer, imagingFreeAt } from "./money";
import { prepFor } from "./prep";
import { clearanceOf } from "./read";
import { requireStudyType } from "./study-types";
import type { DerivedGateSet } from "./checkin";
import type { PrepKey } from "./prep";
import type { ImagingAuthorisation, ImagingGateKind } from "../../kernel/db/schema/radiology";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18-S RS3 — **THE IMAGING COUNTER'S READ: one study, everything the desk's four steps need.**
 *
 * Studies → Checks → Bill → Slot & slip. The desk had no read that answered any of the three
 * questions in the middle, and each has exactly one right owner on the server:
 *
 *   · **Checks** — which safety gates check-in WILL open. `deriveGateSet` is the function check-in
 *     itself runs (with the published pregnancy policy), so the desk tells the patient what the prep
 *     bay will ask for without a second copy of the rule. Nothing is opened here: opening is
 *     check-in's, and satisfying is the prep bay's (the manifest's first separation).
 *   · **Prep** — what to do before the slot (`prepFor`, the one derivation the slip and the
 *     appointment message also read).
 *   · **Bill** — who pays (`encounterPayer`) and whether this scan is authorised to start
 *     (`authorisationOf`, the rule acquisition applies at the machine). A null authorisation is
 *     exactly the `payment_required` the room would refuse with.
 *
 * **Film and CD add-ons (ruling 1) are offered only when the tariff carries them** — `RAD-FILM` and
 * `RAD-CD`, active. The desk never prices anything itself; an absent service is a note, not a
 * control. An X-ray includes one film, so film is never offered on one.
 *
 * Confidentiality: the name goes through `displayName`, and the read logs one `imaging.worklist`
 * PHI row, the surface the desk's queue already logs under.
 */

export const FILM_SERVICE_CODE = "RAD-FILM";
export const CD_SERVICE_CODE = "RAD-CD";

export type CounterAddOn = { kind: "film" | "cd"; serviceId: string; code: string; name: string };

export type CounterView = {
  studyId: string;
  accessionNo: string;
  status: string;
  priority: string;
  studyTypeCode: string;
  studyTypeName: string;
  modality: string;
  /** The study type's booked length — the diary block and the slip read it. */
  durationMin: number;
  serviceId: string;
  encounterNo: string;
  patientId: string;
  patientName: string;
  uhid: string;
  restricted: boolean;
  scheduledAt: Date | null;
  deviceResourceId: string | null;
  bedsideLocation: string | null;
  invoiceLineId: string | null;
  intendedPayer: string;
  authorisation: ImagingAuthorisation | null;
  checks: {
    gates: ImagingGateKind[];
    pregnancyReason: DerivedGateSet["pregnancyReason"];
    policySource: "published" | "default";
    prep: PrepKey[];
  };
  addOns: CounterAddOn[];
};

export async function counterView(db: Db, actor: Actor, studyId: string, now: Date = new Date()): Promise<CounterView> {
  const clearance = await clearanceOf(db, actor);
  const rows = await db
    .select({
      study: imagingStudies,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
      uhid: patients.uhid, sex: patients.sex, dob: patients.dob,
    })
    .from(imagingStudies)
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(eq(imagingStudies.id, studyId));
  const row = rows[0];
  if (!row) throw new RadiologyError("unknown_study", `no study ${studyId}`, { studyId });
  const study = row.study;

  const studyType = await requireStudyType(db, study.studyTypeCode);
  const { policy, source } = await pregnancyPolicy(db);
  const derived = deriveGateSet(studyType, { sex: row.sex, dob: row.dob }, { formFRequired: study.formFRequired }, policy, now);
  const { intendedPayer } = await encounterPayer(db, study.encounterNo);

  const tariffRows = await db
    .select({ id: services.id, code: services.code, name: services.name })
    .from(services)
    .where(and(inArray(services.code, [FILM_SERVICE_CODE, CD_SERVICE_CODE]), eq(services.active, true)));
  const film = tariffRows.find((s) => s.code === FILM_SERVICE_CODE);
  const cd = tariffRows.find((s) => s.code === CD_SERVICE_CODE);
  const addOns: CounterAddOn[] = [
    ...(film !== undefined && studyType.modality !== "xray" ? [{ kind: "film" as const, serviceId: film.id, code: film.code, name: film.name }] : []),
    ...(cd !== undefined ? [{ kind: "cd" as const, serviceId: cd.id, code: cd.code, name: cd.name }] : []),
  ];

  await recordPhiAccess(db, { actor, patientId: study.patientId, surface: "imaging.worklist", reason: `imaging counter ${study.accessionNo}` });

  return {
    studyId: study.id,
    accessionNo: study.accessionNo,
    status: study.status,
    priority: study.priority,
    studyTypeCode: study.studyTypeCode,
    studyTypeName: studyType.name,
    modality: studyType.modality,
    durationMin: studyType.duration_min,
    serviceId: study.serviceId,
    encounterNo: study.encounterNo,
    patientId: study.patientId,
    patientName: displayName({ name: row.name, alias: row.alias, isConfidential: row.isConfidential }, clearance.canSeeConfidential),
    uhid: row.uhid,
    restricted: row.isConfidential && !clearance.canSeeConfidential,
    scheduledAt: study.scheduledAt,
    deviceResourceId: study.deviceResourceId,
    bedsideLocation: study.bedsideLocation,
    invoiceLineId: study.invoiceLineId,
    intendedPayer,
    authorisation: authorisationOf(
      { invoiceLineId: study.invoiceLineId, priority: study.priority, encounterNo: study.encounterNo },
      { intendedPayer },
      await imagingFreeAt(db, study.createdAt),
    ),
    checks: { gates: derived.kinds, pregnancyReason: derived.pregnancyReason, policySource: source, prep: prepFor(studyType) },
    addOns,
  };
}
