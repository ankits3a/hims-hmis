import { and, eq } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { raiseNotice } from "../../kernel/alerts/notices";
import { istDayString } from "../../kernel/approvals/cumulative";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { patients } from "../../kernel/db/schema/patients";
import { orders } from "../../kernel/db/schema/orders";
import { users } from "../../kernel/db/schema/auth";
import { listAllergies } from "../patients";
import { latestVerifiedCreatinine } from "../lab";
import { ageInYearsOn } from "./applicability";
import { deriveGateSet } from "./checkin";
import { assessEgfr } from "./egfr";
import { RadiologyError } from "./errors";
import { READINESS_FORECAST_KINDS, imagingReadinessForecast } from "./events";
import { RENAL_CREATININE_CEILING_UMOL_L, isContrastAllergen, pregnancyPolicy, renalValidityDays } from "./gates";
import { contrastReactionHistory } from "./reactions";
import { requireStudyType } from "./study-types";
import type { ReadinessForecastKind, ReadinessReviewReason } from "./events";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * #1084 (IM6b) — **WILL THE PREP BAY FIND THIS PATIENT READY ON THE DAY? Answered at booking, from facts on file.**
 *
 * Kidney function, a past contrast reaction and a contrast allergy were discovered at the prep bay on the
 * day, though each was already on file when the desk booked. This answers the question early, for the SLOT
 * date, and asks it exactly as check-in and the gates will:
 *
 *   · **which gates the bay will open** — `deriveGateSet`, check-in's own function, with the published
 *     pregnancy policy and the patient's age ON THE SLOT DATE. A forecast for a gate check-in will not open
 *     would be a question nobody asks.
 *   · **the creatinine** — the lab's latest SIGNED one (`latestVerifiedCreatinine`, the pointer the kidney
 *     gate reads), aged at the slot against the gate's own window (`renalValidityDays`). None →
 *     `creatinine_missing`; too old by the slot → `creatinine_stale`. A valid one is put through the gate's
 *     own eGFR rule: below the hold level (or, with no eGFR computable, above the creatinine ceiling) the
 *     contrast is the radiologist's decision → `radiologist_review`.
 *   · **a past contrast reaction or a contrast allergy** — the reaction register (`contrastReactionHistory`)
 *     and the patient master's ACTIVE allergies through the gate's own `isContrastAllergen` →
 *     `radiologist_review`.
 *   · **the pregnancy screen** — when check-in will open it → `pregnancy_screen_due`. It is asked at the bay
 *     on the day, so it is shown and never a blocker.
 *
 * ═══ IT DECIDES NOTHING AND WRITES NOTHING ═══
 *
 * No gate row is opened, satisfied or touched; no creatinine is ordered (DECIDED in the spec: the doctor
 * orders it). A CKD flag is typed only at the gate, so the forecast uses the un-flagged window — a flagged
 * patient can be shorter on the day, never longer.
 */

/** Headline first: what stops contrast, then what the doctor must order, then what the bay asks anyway. */
const HEADLINE: readonly ReadinessForecastKind[] = READINESS_FORECAST_KINDS;

/** What somebody can act on before the day. The pregnancy question is the bay's, on the day. */
export const BLOCKING_FORECAST_KINDS: readonly ReadinessForecastKind[] = ["radiologist_review", "creatinine_missing", "creatinine_stale"];

export type ReadinessForecast = {
  studyId: string;
  slotAt: string;
  verdict: "ready" | ReadinessForecastKind;
  /** Everything found, headline first. Empty means `ready`. */
  kinds: ReadinessForecastKind[];
  blocking: boolean;
  reviewReasons: ReadinessReviewReason[];
  /** The signed creatinine the kidney gate will read, and whether the gate's window still covers it on the slot date. */
  creatinine: { resultId: string; sampledAt: string; validDays: number; validAtSlot: boolean } | null;
};

const DAY_MS = 86_400_000;

export async function readinessForecast(exec: Db | Tx, studyId: string, slotAt: Date): Promise<ReadinessForecast> {
  const db = exec as Db;
  const row = (await db
    .select({
      patientId: imagingStudies.patientId, encounterNo: imagingStudies.encounterNo,
      studyTypeCode: imagingStudies.studyTypeCode, formFRequired: imagingStudies.formFRequired,
      sex: patients.sex, dob: patients.dob,
    })
    .from(imagingStudies)
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(eq(imagingStudies.id, studyId)))[0];
  if (!row) throw new RadiologyError("unknown_study", `no study ${studyId}`, { studyId });

  const type = await requireStudyType(exec, row.studyTypeCode);
  const { policy } = await pregnancyPolicy(exec);
  const { kinds: gates } = deriveGateSet(type, { sex: row.sex, dob: row.dob }, { formFRequired: row.formFRequired }, policy, slotAt);

  const found = new Set<ReadinessForecastKind>();
  const reasons: ReadinessReviewReason[] = [];
  let creatinine: ReadinessForecast["creatinine"] = null;

  if (gates.includes("renal_function")) {
    const crea = await latestVerifiedCreatinine(exec, row.patientId);
    if (crea === null) {
      found.add("creatinine_missing");
    } else {
      const { validDays } = renalValidityDays(row.encounterNo);
      const validAtSlot = (slotAt.getTime() - crea.sampledAt.getTime()) / DAY_MS <= validDays;
      creatinine = { resultId: crea.resultId, sampledAt: crea.sampledAt.toISOString(), validDays, validAtSlot };
      if (!validAtSlot) {
        found.add("creatinine_stale");
      } else {
        const assessed = assessEgfr(crea.valueUmolL, {
          sex: row.sex, ageYears: row.dob === null ? null : ageInYearsOn(row.dob, slotAt),
        });
        if (assessed.computed && assessed.band === "hold") reasons.push("egfr_below_hold");
        if (!assessed.computed && crea.valueUmolL > RENAL_CREATININE_CEILING_UMOL_L) reasons.push("creatinine_above_ceiling");
      }
    }
  }

  if (gates.includes("prior_contrast_reaction")) {
    if ((await contrastReactionHistory(exec, row.patientId)).length > 0) reasons.push("past_contrast_reaction");
    const allergic = (await listAllergies(db, row.patientId))
      .some((a) => a.status === "active" && isContrastAllergen(a.substance));
    if (allergic) reasons.push("contrast_allergy");
  }
  if (reasons.length > 0) found.add("radiologist_review");
  if (gates.includes("pregnancy_screen")) found.add("pregnancy_screen_due");

  const kinds = HEADLINE.filter((k) => found.has(k));
  return {
    studyId,
    slotAt: slotAt.toISOString(),
    verdict: kinds[0] ?? "ready",
    kinds,
    blocking: kinds.some((k) => BLOCKING_FORECAST_KINDS.includes(k)),
    reviewReasons: reasons,
    creatinine,
  };
}

/** True when the appointment message and the desk's "tell the patient" list need not ask for a creatinine report. */
export function creatinineOnFile(f: Pick<ReadinessForecast, "creatinine">): boolean {
  return f.creatinine?.validAtSlot === true;
}

/* ═══════════════════════════════ at booking ═══════════════════════════════ */

/** The bell row's kind and what it points at (the room's own ref type for a study). */
export const READINESS_ALERT_KIND = "imaging_readiness";
const READINESS_REF_TYPE = "imaging_study";

/**
 * #1084 — the forecast a booking or a move takes, in the booking's own transaction (L1 for the desk, which
 * reads the same answer in its lane; an L3 notice when it finds a BLOCKER):
 *
 *   · `imaging.readiness_forecast` is appended — codes and the creatinine's pointer, nothing clinical;
 *   · the ORDERING doctor gets one bell row for this booking's slot (`sourceKey` holds it to one), when the
 *     order names a doctor who is a live user here. The text is structural (GC6): no patient, no study
 *     name, no value — "a contrast study you ordered" and the slot's IST day. The doctor opens the visit's
 *     imaging orders, where the card says what is short.
 *
 * Nothing is ordered and no gate is touched: `readinessForecast` decides nothing.
 */
export async function forecastAtBooking(
  tx: Tx, actor: Actor,
  study: { id: string; patientId: string; encounterNo: string; orderId: string },
  scheduledAt: Date, now: Date = new Date(),
): Promise<ReadinessForecast> {
  const f = await readinessForecast(tx, study.id, scheduledAt);
  if (!f.blocking) return f;
  const kinds = f.kinds.filter((k) => BLOCKING_FORECAST_KINDS.includes(k));
  await appendEvent(tx, imagingReadinessForecast.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo, occurredAt: now,
    payload: {
      studyId: study.id, scheduledAt: f.slotAt, verdict: kinds[0]!, kinds,
      reviewReasons: f.reviewReasons, creatinineResultId: f.creatinine?.resultId ?? null,
    },
  }));

  const [order] = await (tx as unknown as Db).select({ clinician: orders.orderingClinicianId })
    .from(orders).where(eq(orders.id, study.orderId));
  const clinician = order?.clinician ?? null;
  if (clinician === null) return f;
  const [live] = await (tx as unknown as Db).select({ id: users.id }).from(users)
    .where(and(eq(users.id, clinician), eq(users.active, true)));
  if (live === undefined) return f;
  const day = istDayString(scheduledAt);
  const needsCreatinine = kinds.includes("creatinine_missing") || kinds.includes("creatinine_stale");
  const needsReview = kinds.includes("radiologist_review");
  await raiseNotice(tx as unknown as Db, {
    userId: live.id, kind: READINESS_ALERT_KIND, refType: READINESS_REF_TYPE, refId: study.id,
    title: "A booked imaging study needs you before its slot",
    body: `A contrast study you ordered is booked for ${day}. `
      + (needsCreatinine ? "There is no creatinine in the valid window for that day: order one. " : "")
      + (needsReview ? "The radiologist will review contrast before the scan. " : "")
      + "Open the patient's imaging orders to see what is short.",
    sourceKey: `imaging-readiness:${study.id}:${f.slotAt}`,
    at: now,
  });
  return f;
}
