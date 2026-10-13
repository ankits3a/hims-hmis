import { and, eq, isNull } from "drizzle-orm";
import { IPD_PLACED_STATES } from "@hmis/contracts";
import { ipdAdmissions, ipdBedStays, resources } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * E1.3 (#720) — WHERE AN ADMISSION IS, for the modules beside IPD (passes first; diet, linen and transport later).
 * A read, no lock, no write: the admission's state, its open bed stay, the bed and the ward or hall above it.
 * Companion modules ask this instead of reading `ipd_admissions` / `ipd_bed_stays` themselves.
 */
export type AdmissionPlace = {
  admissionId: string;
  patientId: string;
  admissionNo: string | null;
  state: string;
  /** In a state where the patient lies on a bed: admitted, transferring, fit declared, discharging. */
  placed: boolean;
  /** Ended for good: discharged, LAMA, absconded, deceased, transferred out (cancelled is not an end of a stay). */
  ended: boolean;
  bedId: string | null;
  bedCode: string | null;
  /** The class of the bed the patient lies on (the open stay's), not the class asked for. */
  bedClass: string | null;
  wardId: string | null;
  wardCode: string | null;
  wardName: string | null;
};

/** #785 review: the list lives in contracts (radiology reads it too); re-exported here for every existing import. */
export { IPD_PLACED_STATES } from "@hmis/contracts";
export const IPD_ENDED_STATES = ["discharged", "lama", "absconded", "deceased", "transferred_out"] as const;

/**
 * The events that END a stay (contract names, `IPD_INTENTS[...].events`): the gate-pass scan emits `discharged` for
 * both a home discharge and a refer-out (§4.4: refer-out is a discharge type). Emitted by ipd-discharge (E4.x); a
 * consumer subscribed now loses nothing between the lanes.
 */
export const IPD_ADMISSION_ENDED_EVENT_NAMES = [
  "ipd.admission.discharged", "ipd.admission.lama", "ipd.admission.absconded", "ipd.admission.deceased",
] as const;
/** A ward transfer completes on the receiving nurse's acceptance (§4.4); emitted by ipd-transfer (E2.x). */
export const IPD_TRANSFER_ACCEPTED_EVENT_NAME = "ipd.transfer.accepted";

export async function admissionPlace(db: Db | Tx, admissionId: string): Promise<AdmissionPlace | null> {
  const a = (await db.select({
    id: ipdAdmissions.id, patientId: ipdAdmissions.patientId, admissionNo: ipdAdmissions.admissionNo, state: ipdAdmissions.state,
  }).from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0];
  if (a === undefined) return null;
  const stay = (await db.select({ bedId: ipdBedStays.bedId, bedClass: ipdBedStays.bedClass })
    .from(ipdBedStays).where(and(eq(ipdBedStays.admissionId, a.id), isNull(ipdBedStays.endedAt))))[0];
  let bedCode: string | null = null;
  let ward: { id: string; code: string; name: string } | null = null;
  if (stay !== undefined) {
    let cur = (await db.select().from(resources).where(eq(resources.id, stay.bedId)))[0];
    bedCode = cur?.code ?? null;
    // Walk up: bed → (room) → ward or hall. Four steps is deeper than any layout the loader accepts.
    for (let i = 0; i < 4 && cur !== undefined && cur.parentId !== null; i += 1) {
      cur = (await db.select().from(resources).where(eq(resources.id, cur.parentId)))[0];
      if (cur !== undefined && (cur.kind === "ward" || cur.kind === "hall")) { ward = { id: cur.id, code: cur.code, name: cur.name }; break; }
    }
  }
  return {
    admissionId: a.id, patientId: a.patientId, admissionNo: a.admissionNo, state: a.state,
    placed: (IPD_PLACED_STATES as readonly string[]).includes(a.state),
    ended: (IPD_ENDED_STATES as readonly string[]).includes(a.state),
    bedId: stay?.bedId ?? null, bedCode, bedClass: stay?.bedClass ?? null,
    wardId: ward?.id ?? null, wardCode: ward?.code ?? null, wardName: ward?.name ?? null,
  };
}
