import { isModuleOn } from "../../kernel/modules/switch";
import {
  admissionFacts, admissionPlace, ageInYears, bedsOf, changesSince, dayOfStay, lastSeenBy, lastSeenByMany, latestVitalsOf, nowIdentities,
  onTreatingTeam, roundsBy, takeDayOf, takeWindow, unitCensus, unitOfAt,
} from "../ipd";
import { getPatientSummaries, listAllergies } from "../patients";
import { doctorUnitsOn, istDateOfInstant } from "../roster";
import { DoctorDeskError } from "./errors";
import { deskScope, namesOf } from "./scope";
import type { UnitBed } from "../ipd";
import type { DeskScope } from "./scope";
import type { Actor, WireTowerWard, WireWardBed, WireWardBeds, WireWardRound } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * #962 (spec docs/specs/962-doctor-desk-ward.md; plan §3.4 DD-IPD.1, .3, .4) — THE WARD ON THE DOCTOR DESK, part 1.
 *
 * The Desk READS IPD only through `ipd/index.ts` (`bedsOf`, `unitCensus`, `changesSince`, `lastSeenBy`…) and writes no
 * bed or clinical row: a round note is IPD's own `signRound` (POST /ipd/rounds/sign), called by the phone with its
 * client id as the idempotency key. IPD switched off (decision 0085) → the Tower's inpatient parts are absent and the
 * two ward routes answer 404 (`ward_closed`). No unit → no ward (absent, never zero). No money anywhere (decision 0058).
 *
 * THE CHANGE MARK IS PER DOCTOR (D5): a bed is marked when something was recorded on the patient after the ASKER's own
 * last round on them (IPD's `lastSeenBy`; never seen → since admission). Another doctor's round clears nothing for her.
 */

export function wardOn(): boolean {
  return isModuleOn("ipd");
}

type Occupant = NonNullable<UnitBed["occupant"]>;

/** Tower inpatient mode (DD-IPD.1): null when IPD is off, the doctor has no unit, or the read fails (one source failing never drops the Tower). */
export async function towerWard(db: Db, scope: DeskScope, at: Date): Promise<WireTowerWard | null> {
  if (!wardOn() || scope.unit === null) return null;
  try {
    const teamId = scope.unit.teamId;
    const takeDay = takeDayOf(at);
    const [census, beds] = await Promise.all([unitCensus(db, teamId, takeDay, at), bedsOf(db, teamId, at)]);
    const ours = beds.filter((b) => b.occupant?.ours === true);
    const allotted = beds.filter((b) => b.allotted).length;
    return {
      takeDay,
      census: {
        takeDay, from: census.from.toISOString(), to: census.to.toISOString(),
        admitted: census.admitted, discharged: census.discharged, lama: census.lama, absconded: census.absconded, deaths: census.deaths,
        transfersIn: census.transfersIn, transfersOut: census.transfersOut, occupied: census.occupied, bedsAtMidnight: census.bedsAtMidnight,
      },
      totalBeds: allotted === 0 ? null : allotted,
      critical: ours.filter((b) => b.flag === "critical").length,
      dischargeCandidates: ours.filter((b) => b.flag === "could_go_home").length,
      beds: beds.filter((b) => !b.outlier).map((b) => ({ bedId: b.bedId, bedCode: b.bedCode, status: b.status, flag: b.flag, outlier: false })),
    };
  } catch {
    return null;
  }
}

type Person = { patient: WireWardRound["patient"]; ageSex: string | null; sealed: boolean };

async function peopleOf(db: Db, actor: Actor, occupants: readonly { admissionId: string; patientId: string }[], at: Date): Promise<Map<string, Person>> {
  const out = new Map<string, Person>();
  if (occupants.length === 0) return out;
  const ids = await nowIdentities(db, actor, occupants.map((o) => ({ id: o.admissionId, patientId: o.patientId })));
  const summaries = new Map((await getPatientSummaries(db, actor, [...new Set(occupants.map((o) => o.patientId))])).map((s) => [s.requestedId, s] as const));
  for (const o of occupants) {
    const id = ids.get(o.admissionId);
    const s = summaries.get(o.patientId);
    const hidden = id?.sealed === true || s?.restricted === true;
    const age = hidden || s?.dob == null ? null : ageInYears(s.dob, at);
    const sex = s === undefined ? null : s.administrativeGender === "male" ? "M" : s.administrativeGender === "female" ? "F" : "O";
    out.set(o.admissionId, {
      patient: { id: o.patientId, uhid: id?.sealed === true ? null : (s?.uhid ?? null), name: id?.name ?? null, restricted: hidden },
      ageSex: hidden || age === null || sex === null ? null : `${String(age)} ${sex}`,
      sealed: id?.sealed === true,
    });
  }
  return out;
}

function stayDay(o: Occupant, istDate: string): number {
  return o.admittedAt === null ? 1 : Math.max(1, dayOfStay(o.admittedAt, istDate));
}

/** Beds (phone, DD-IPD.3): walk order; the unit's patients lodged in another ward apart; a per-doctor change mark. */
export async function wardBeds(db: Db, actor: Actor, at: Date): Promise<WireWardBeds> {
  if (!wardOn()) throw new DoctorDeskError("ward_closed");
  const scope = await deskScope(db, actor, at);
  const unit = scope.unit === null ? null : { teamId: scope.unit.teamId, name: scope.unit.unitName, short: scope.unit.short, departmentName: scope.unit.departmentName };
  const base = { at: at.toISOString(), istDate: scope.istDate, unit };
  if (scope.unit === null) return { ...base, beds: [], outliers: [], free: 0 };

  const beds = await bedsOf(db, scope.unit.teamId, at);
  const ours = beds.flatMap((b) => (b.occupant?.ours === true ? [b.occupant] : []));
  const people = await peopleOf(db, actor, ours, at);
  const seen = await lastSeenByMany(db, ours.map((o) => o.admissionId), actor.id, at);
  const { from: takeFrom } = takeWindow(takeDayOf(at));
  const changed = new Map<string, boolean>();
  await Promise.all(ours.map(async (o) => {
    const since = seen.get(o.admissionId) ?? o.admittedAt ?? new Date(at.getTime() - 24 * 3_600_000);
    changed.set(o.admissionId, (await changesSince(db, { id: o.admissionId, patientId: o.patientId }, since, at, { actorId: actor.id })).length > 0);
  }));

  const view = (b: UnitBed): WireWardBed => {
    const o = b.occupant?.ours === true ? b.occupant : null;
    const p = o === null ? undefined : people.get(o.admissionId);
    return {
      bedId: b.bedId, bedCode: b.bedCode, wardCode: b.wardCode, wardName: b.wardName, status: b.status, flag: b.flag, outlier: b.outlier,
      changed: o === null ? null : (changed.get(o.admissionId) ?? false),
      occupant: o === null || p === undefined ? null : {
        admissionId: o.admissionId, patient: p.patient, ageSex: p.ageSex,
        dx: p.sealed ? null : o.provisionalDiagnosis, dayOfStay: stayDay(o, scope.istDate), ews: o.ews,
        tags: [...(o.admittedAt !== null && o.admittedAt >= takeFrom ? ["new" as const] : []), ...(o.mlc && !p.sealed ? ["mlc" as const] : [])],
      },
    };
  };
  const main = beds.filter((b) => !b.outlier).map(view);
  return { ...base, beds: main, outliers: beds.filter((b) => b.outlier).map(view), free: main.filter((b) => b.status === "free").length };
}

function bpOf(s: number | null, d: number | null): string | null {
  return s === null ? null : d === null ? String(s) : `${String(s)}/${String(d)}`;
}

/** Round (phone, DD-IPD.4): one bed — since-you-last-saw lines with their source, the vitals strip, my notes' two times. */
export async function wardRound(db: Db, actor: Actor, admissionId: string, at: Date): Promise<WireWardRound> {
  if (!wardOn()) throw new DoctorDeskError("ward_closed");
  const a = (await admissionFacts(db, [admissionId])).get(admissionId);
  if (a === undefined) throw new DoctorDeskError("unknown_admission");
  const scope = await deskScope(db, actor, at);
  const unitId = await unitOfAt(db, a, at);
  const mayRead = (scope.unit !== null && unitId === scope.unit.teamId) || await onTreatingTeam(db, a.id, actor.id, at);
  // Not this doctor's unit or team: answered as unknown, so the route says nothing about a patient she may not see.
  if (!mayRead) throw new DoctorDeskError("unknown_admission");

  const person = (await peopleOf(db, actor, [{ admissionId: a.id, patientId: a.patientId }], at)).get(a.id)!;
  const since = await lastSeenBy(db, a.id, actor.id, at);
  const from = since ?? a.admittedAt ?? new Date(at.getTime() - 24 * 3_600_000);
  const [changes, vitals, mine, place, allergies, names] = await Promise.all([
    changesSince(db, a, from, at, { actorId: actor.id }),
    latestVitalsOf(db, [a.id], at).then((m) => m.get(a.id)),
    roundsBy(db, a.id, actor.id),
    admissionPlace(db, a.id),
    person.sealed ? Promise.resolve([]) : listAllergies(db, a.patientId).then((rows) => rows.filter((r) => r.status === "active").map((r) => r.substance)),
    namesOf(db, [a.consultantId]),
  ]);
  const istDate = istDateOfInstant(at);
  const unitName = unitId === null ? null : (await doctorUnitsOn(db, istDate)).find((u) => u.teamId === unitId)?.short ?? null;

  // Previous and next bed on the walk: the asker's unit's own ward, occupied by the unit's patients, in bed order.
  const walk = scope.unit === null ? [] : (await bedsOf(db, scope.unit.teamId, at)).filter((b) => !b.outlier && b.occupant?.ours === true);
  const walkPeople = await peopleOf(db, actor, walk.map((b) => b.occupant!), at);
  const i = walk.findIndex((b) => b.occupant?.admissionId === a.id);
  const stop = (b: UnitBed | undefined) => b === undefined ? null
    : { admissionId: b.occupant!.admissionId, bedCode: b.bedCode, name: walkPeople.get(b.occupant!.admissionId)?.patient.name ?? null };

  return {
    at: at.toISOString(), admissionId: a.id, patient: person.patient, ageSex: person.ageSex,
    bedCode: place?.bedCode ?? null, dx: person.sealed ? null : a.provisionalDiagnosis,
    dayOfStay: a.admittedAt === null ? 1 : Math.max(1, dayOfStay(a.admittedAt, istDate)),
    unitName, consultantName: names.get(a.consultantId) ?? null, allergies,
    since: since?.toISOString() ?? null,
    changes: changes.map((c) => ({
      key: c.key, text: c.text, source: c.source, abnormal: c.abnormal, at: c.at?.toISOString() ?? null,
      records: c.records.map((r) => ({ id: r.id, at: r.at?.toISOString() ?? null, label: r.label })),
    })),
    vitals: vitals === undefined ? null : {
      observedAt: vitals.observedAt.toISOString(), bp: bpOf(vitals.systolic, vitals.diastolic), pulse: vitals.pulse,
      temperatureC: vitals.temperatureC, spo2: vitals.spo2, ews: vitals.ews,
    },
    mine: mine.map((m) => ({
      roundId: m.roundId, signedAt: m.seenAt.toISOString(), syncedAt: m.createdAt.toISOString(),
      status: m.status === "awaiting_cosign" ? "awaiting_cosign" as const : "signed" as const,
    })),
    position: { index: i < 0 ? 0 : i + 1, of: walk.length },
    prev: i <= 0 ? null : stop(walk[i - 1]),
    next: i < 0 ? null : stop(walk[i + 1]),
  };
}
