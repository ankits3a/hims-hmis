import { and, asc, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  ADR_CAUSALITY, ADR_CHALLENGE, ADR_CHANNELS, ADR_OUTCOMES, ADR_SERIOUSNESS,
  pharmacyAdrEvents, pharmacyAdrReports, pharmacyAdrSuspects, pharmacyDispenses, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { saltsByIds } from "../formulary";
import { addAllergy, getPatientSummaries } from "../patients";
import { istDateOf } from "./config";
import { PharmacyError } from "./errors";
import { adrEventRecorded, adrReported } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type {
  AdrCausality, AdrChallenge, AdrChannel, AdrConcomitant, AdrEventKind, AdrOutcome, AdrSeriousness,
} from "../../kernel/db/schema";

/**
 * ═══ PHARMACY STAGE D1 — ADVERSE DRUG REACTION REPORTING (PvPI, NABH MOM, WHO-UMC causality) ═══
 *
 * A pharmacist, the pharmacist in charge or a doctor records a suspected adverse drug reaction in the
 * shape of the PvPI Suspected ADR Reporting Form. The in-charge or the medical superintendent then
 * assesses causality (WHO-UMC), sends the form to PvPI (by the AMC, the ADR PvPI app or e-mail — PvPI
 * has no API, so the send is a person's act recorded here) and closes it.
 *
 * ═══ THE LOOP THAT HAS TO CLOSE — the allergy is written in the SAME transaction ═══
 *
 * A reaction that does not reach the next prescription's allergy check is THE defect. So every suspected
 * medicine is written to the patient's allergy book through `patients`' own seam (`addAllergy`, source
 * `pharmacy`) inside the transaction that files the report, and `pharmacy_adr_suspects.allergy_id` is
 * NOT NULL — a suspect without its allergy is a row the database cannot hold (the radiology contrast
 * reaction's rule, `radiology/reactions.ts`).
 *
 * The SUBSTANCE is the formulary moiety's name when the suspect was picked from the formulary (never the
 * brand the reporter typed): opd's allergy check resolves `patient_allergies.substance` against the salt
 * table by name, so "Amoxicillin" blocks every amoxicillin brand, where "Mox 500" would block only a line
 * that spells the brand. A suspect not in the formulary falls back to its typed name, which the check's
 * substring layer still reads.
 *
 * DECIDED (2026-09-28, standard Indian-corporate-hospital answer, recorded in the stage-D doc): every
 * suspect writes an allergy — the rx-checks rule that over-warning costs one reasoned override and a miss
 * costs a patient. Severity comes from seriousness: death, life-threatening, hospitalisation, disability
 * and congenital anomaly are `severe`; other medically important is `moderate`; not serious is `mild`.
 */
export const ADR_RECORD_PERMISSION = "pharmacy.adr.record";
export const ADR_MANAGE_PERMISSION = "pharmacy.adr.manage";
/** PvPI guidance: a serious reaction is reported within 15 days of the hospital knowing of it. */
export const ADR_SERIOUS_REPORT_DAYS = 15;
const MAX_SUSPECTS = 10;
const MAX_CONCOMITANTS = 20;
const LIST_LIMIT = 200;

export function allergySeverityOf(s: AdrSeriousness): "mild" | "moderate" | "severe" {
  if (s === "not_serious") return "mild";
  if (s === "other_medically_important") return "moderate";
  return "severe";
}

export const isSerious = (s: string): boolean => s !== "not_serious";

export const adrNumber = (seq: number): string => `ADR-${String(seq).padStart(6, "0")}`;

export type AdrSuspectInput = {
  saltId?: string | null;
  name?: string | null;
  itemId?: string | null;
  batchNo?: string | null;
  manufacturer?: string | null;
  dose?: string | null;
  route?: string | null;
  frequency?: string | null;
  indication?: string | null;
  startDate?: string | null;
  stopDate?: string | null;
  dispenseId?: string | null;
};

export type RecordAdrInput = {
  patientId: string;
  reaction: string;
  onsetDate: string;
  recoveryDate?: string | null;
  seriousness: AdrSeriousness;
  outcome: AdrOutcome;
  dechallenge: AdrChallenge;
  rechallenge: AdrChallenge;
  weightKg?: number | null;
  suspects: AdrSuspectInput[];
  concomitants?: Partial<AdrConcomitant>[];
  relevantTests?: string | null;
  relevantHistory?: string | null;
};

export type AdrEventInput =
  | { kind: "causality_assessed"; causality: AdrCausality; note?: string | null }
  | { kind: "sent_to_pvpi"; sentOn: string; channel: AdrChannel; pvpiRef?: string | null; note?: string | null }
  | { kind: "closed"; note?: string | null };

export type AdrPatient = { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean; gender: string; dob: string | null };

export type AdrSuspectView = {
  position: number; saltId: string | null; name: string; itemId: string | null; batchNo: string | null; manufacturer: string | null;
  dose: string | null; route: string | null; frequency: string | null; indication: string | null;
  startDate: string | null; stopDate: string | null; dispenseId: string | null; allergyId: string;
};

export type AdrEventView = {
  id: string; kind: AdrEventKind; causality: string | null; sentOn: string | null; channel: string | null; pvpiRef: string | null;
  note: string | null; recordedBy: string; recordedByCode: string; recordedAt: string;
};

/** Where a report stands, derived from its events (the table holds acts, never a status column). */
export type AdrState = {
  causality: string | null;
  sentOn: string | null;
  channel: string | null;
  pvpiRef: string | null;
  closed: boolean;
};

export type AdrListRow = {
  id: string; no: string; patient: AdrPatient | null; onsetDate: string; seriousness: string; outcome: string;
  suspects: string[]; reportedByCode: string; createdAt: string; state: AdrState;
};

export type AdrDetail = AdrListRow & {
  reaction: string; recoveryDate: string | null; dechallenge: string; rechallenge: string; weightKg: string | null;
  concomitants: AdrConcomitant[]; relevantTests: string | null; relevantHistory: string | null;
  suspectLines: AdrSuspectView[]; events: AdrEventView[];
};

const trimOrNull = (v: string | null | undefined): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t;
};
const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

function bad(message: string, detail?: Record<string, unknown>): never {
  throw new PharmacyError("invalid_adr", message, detail);
}

/** Reading the register is for the people who write it or manage it. */
export async function assertAdrReader(db: Db | Tx, actor: Actor): Promise<string> {
  if (actor.type !== "user") throw new PharmacyError("permission_denied", "the ADR register is read by a person");
  for (const p of [ADR_RECORD_PERMISSION, ADR_MANAGE_PERMISSION]) {
    if (await hasPermission(db as Db, actor.id, p, "hospital")) return actor.id;
  }
  throw new PharmacyError("permission_denied", `reading the ADR register needs ${ADR_RECORD_PERMISSION} or ${ADR_MANAGE_PERMISSION}`);
}

function checkDate(label: string, v: string | null, today: string): void {
  if (v === null) return;
  if (!isDay(v)) bad(`${label} is not a date (YYYY-MM-DD)`, { field: label });
  if (v > today) bad(`${label} ${v} has not happened yet`, { field: label });
}

/**
 * Record a suspected ADR: the report, its suspected medicines, and one allergy per suspected moiety —
 * one transaction, so none of them exists without the others.
 */
export async function recordAdr(db: Db, actor: Actor, input: RecordAdrInput, now: Date = new Date()): Promise<{ reportId: string; no: string; allergyIds: string[] }> {
  if (actor.type !== "user") throw new PharmacyError("permission_denied", "an ADR is reported by a person");
  const today = istDateOf(now);
  const reaction = input.reaction.trim();
  if (reaction === "") bad("describe the reaction — that is the report");
  if (!(ADR_SERIOUSNESS as readonly string[]).includes(input.seriousness)) bad(`"${input.seriousness}" is not a seriousness`);
  if (!(ADR_OUTCOMES as readonly string[]).includes(input.outcome)) bad(`"${input.outcome}" is not an outcome`);
  for (const c of [input.dechallenge, input.rechallenge]) {
    if (!(ADR_CHALLENGE as readonly string[]).includes(c)) bad(`"${c}" is not a dechallenge/rechallenge answer`);
  }
  checkDate("onsetDate", input.onsetDate, today);
  const recoveryDate = trimOrNull(input.recoveryDate);
  checkDate("recoveryDate", recoveryDate, today);
  if (recoveryDate !== null && recoveryDate < input.onsetDate) bad("the reaction cannot resolve before it started");
  if (input.suspects.length === 0) bad("name at least one suspected medicine");
  if (input.suspects.length > MAX_SUSPECTS) bad(`at most ${String(MAX_SUSPECTS)} suspected medicines on one report`);
  const concomitants = input.concomitants ?? [];
  if (concomitants.length > MAX_CONCOMITANTS) bad(`at most ${String(MAX_CONCOMITANTS)} concomitant medicines on one report`);
  if (input.weightKg !== undefined && input.weightKg !== null && !(input.weightKg > 0 && input.weightKg < 1000)) bad("weight is in kilograms");

  const saltIds = [...new Set(input.suspects.map((s) => trimOrNull(s.saltId)).filter((s): s is string => s !== null))];

  return withTx(db, async (tx) => {
    const salts = await saltsByIds(tx, saltIds);
    for (const id of saltIds) if (!salts.has(id)) bad(`no formulary moiety ${id}`, { saltId: id });

    const lines = input.suspects.map((s, i) => {
      const saltId = trimOrNull(s.saltId);
      const typed = trimOrNull(s.name);
      const salt = saltId === null ? undefined : salts.get(saltId);
      const name = typed ?? salt?.name ?? null;
      if (name === null) bad(`suspected medicine ${String(i + 1)} names no drug`, { position: i + 1 });
      const startDate = trimOrNull(s.startDate);
      const stopDate = trimOrNull(s.stopDate);
      checkDate(`suspects[${String(i)}].startDate`, startDate, today);
      checkDate(`suspects[${String(i)}].stopDate`, stopDate, today);
      if (startDate !== null && stopDate !== null && stopDate < startDate) bad(`suspected medicine ${String(i + 1)} stops before it starts`);
      return {
        position: i + 1, saltId, name, substance: salt?.name ?? name,
        itemId: trimOrNull(s.itemId), batchNo: trimOrNull(s.batchNo), manufacturer: trimOrNull(s.manufacturer),
        dose: trimOrNull(s.dose), route: trimOrNull(s.route), frequency: trimOrNull(s.frequency), indication: trimOrNull(s.indication),
        startDate, stopDate, dispenseId: trimOrNull(s.dispenseId),
      };
    });

    /* A dispense named on the form must be THIS patient's: the ref is evidence, and evidence about somebody else is not. */
    const dispenseIds = [...new Set(lines.map((l) => l.dispenseId).filter((d): d is string => d !== null))];
    if (dispenseIds.length > 0) {
      const found = await tx.select({ id: pharmacyDispenses.id, patientId: pharmacyDispenses.patientId }).from(pharmacyDispenses)
        .where(inArray(pharmacyDispenses.id, dispenseIds));
      const byId = new Map(found.map((d) => [d.id, d.patientId]));
      for (const d of dispenseIds) {
        if (byId.get(d) !== input.patientId) bad(`dispense ${d} is not this patient's`, { dispenseId: d });
      }
    }

    /*
     * ═══ THE ALLERGIES FIRST, because the suspect rows cannot exist without their ids ═══
     * One allergy per distinct substance on this report: two brands of one moiety are one allergy.
     */
    const severity = allergySeverityOf(input.seriousness);
    const allergyBySubstance = new Map<string, string>();
    for (const l of lines) {
      const key = l.saltId ?? `name:${l.substance.toLowerCase()}`;
      if (allergyBySubstance.has(key)) continue;
      const { allergyId } = await addAllergy(tx, actor, input.patientId, {
        substance: l.substance, reaction, severity, source: "pharmacy", saltId: l.saltId,
      });
      allergyBySubstance.set(key, allergyId);
    }

    const reportId = newId();
    const inserted = await tx.insert(pharmacyAdrReports).values({
      id: reportId, patientId: input.patientId, reaction, onsetDate: input.onsetDate, recoveryDate,
      seriousness: input.seriousness, outcome: input.outcome, dechallenge: input.dechallenge, rechallenge: input.rechallenge,
      weightKg: input.weightKg === undefined || input.weightKg === null ? null : input.weightKg.toFixed(1),
      concomitants: concomitants.map((c) => ({
        name: (c.name ?? "").trim(), dose: trimOrNull(c.dose), route: trimOrNull(c.route),
        startDate: trimOrNull(c.startDate), stopDate: trimOrNull(c.stopDate), indication: trimOrNull(c.indication),
      })).filter((c) => c.name !== ""),
      relevantTests: trimOrNull(input.relevantTests), relevantHistory: trimOrNull(input.relevantHistory),
      reportedBy: actor.id, createdAt: now,
    }).returning({ seq: pharmacyAdrReports.seq });

    await tx.insert(pharmacyAdrSuspects).values(lines.map((l) => ({
      id: newId(), reportId, position: l.position, saltId: l.saltId, name: l.name, itemId: l.itemId, batchNo: l.batchNo,
      manufacturer: l.manufacturer, dose: l.dose, route: l.route, frequency: l.frequency, indication: l.indication,
      startDate: l.startDate, stopDate: l.stopDate, dispenseId: l.dispenseId,
      allergyId: allergyBySubstance.get(l.saltId ?? `name:${l.substance.toLowerCase()}`)!,
    })));

    const allergyIds = [...allergyBySubstance.values()];
    await appendEvent(tx, adrReported.make({
      actor, patientId: input.patientId, occurredAt: now,
      payload: { reportId, patientId: input.patientId, seriousness: input.seriousness, suspects: lines.length, allergyIds },
    }));
    return { reportId, no: adrNumber(inserted[0]!.seq), allergyIds };
  });
}

function stateOf(events: readonly { kind: string; causality: string | null; sentOn: string | null; channel: string | null; pvpiRef: string | null }[]): AdrState {
  const out: AdrState = { causality: null, sentOn: null, channel: null, pvpiRef: null, closed: false };
  for (const e of events) {
    if (e.kind === "causality_assessed") out.causality = e.causality;
    if (e.kind === "sent_to_pvpi") { out.sentOn = e.sentOn; out.channel = e.channel; out.pvpiRef = e.pvpiRef; }
    if (e.kind === "closed") out.closed = true;
  }
  return out;
}

/** A later act on a report. The in-charge's or the MS's (`pharmacy.adr.manage`, checked at the route). */
export async function addAdrEvent(db: Db, actor: Actor, reportId: string, input: AdrEventInput, now: Date = new Date()): Promise<{ eventId: string }> {
  if (actor.type !== "user") throw new PharmacyError("permission_denied", "an act on an ADR report is a person's");
  const today = istDateOf(now);
  return withTx(db, async (tx) => {
    const report = (await tx.select({ id: pharmacyAdrReports.id, patientId: pharmacyAdrReports.patientId, createdAt: pharmacyAdrReports.createdAt })
      .from(pharmacyAdrReports).where(eq(pharmacyAdrReports.id, reportId)))[0];
    if (report === undefined) throw new PharmacyError("unknown_adr", `ADR report ${reportId} not found`);
    const prior = await tx.select().from(pharmacyAdrEvents).where(eq(pharmacyAdrEvents.reportId, reportId)).orderBy(asc(pharmacyAdrEvents.recordedAt));
    const state = stateOf(prior);
    if (state.closed) throw new PharmacyError("adr_closed", "this report is closed — a closed report takes no further act");

    const note = trimOrNull(input.note);
    const row = { id: newId(), reportId, kind: input.kind, causality: null as string | null, sentOn: null as string | null, channel: null as string | null,
      pvpiRef: null as string | null, note, recordedBy: actor.id, recordedAt: now };
    if (input.kind === "causality_assessed") {
      if (!(ADR_CAUSALITY as readonly string[]).includes(input.causality)) bad(`"${input.causality}" is not a WHO-UMC category`);
      row.causality = input.causality;
    } else if (input.kind === "sent_to_pvpi") {
      if (state.sentOn !== null) bad(`this report went to PvPI on ${state.sentOn}`);
      if (!(ADR_CHANNELS as readonly string[]).includes(input.channel)) bad(`"${input.channel}" is not a PvPI channel`);
      checkDate("sentOn", input.sentOn, today);
      if (input.sentOn < istDateOf(report.createdAt)) bad("the form cannot have gone before the report was recorded");
      row.sentOn = input.sentOn; row.channel = input.channel; row.pvpiRef = trimOrNull(input.pvpiRef);
    } else if (input.kind === "closed") {
      /* A report closed without going to PvPI says why — that is the only thing a reviewer will ask. */
      if (state.sentOn === null && note === null) bad("closing a report that was never sent to PvPI needs a reason");
    } else {
      bad("unknown act");
    }
    await tx.insert(pharmacyAdrEvents).values(row);
    await appendEvent(tx, adrEventRecorded.make({ actor, patientId: report.patientId, occurredAt: now, payload: { reportId, eventId: row.id, kind: input.kind } }));
    return { eventId: row.id };
  });
}

async function patientsOf(db: Db, actor: Actor, ids: string[]): Promise<Map<string, AdrPatient>> {
  const out = new Map<string, AdrPatient>();
  for (const s of await getPatientSummaries(db, actor, ids)) {
    out.set(s.requestedId, {
      id: s.id, uhid: s.uhid, name: s.name, alias: s.alias, restricted: s.restricted, gender: s.administrativeGender,
      dob: s.dob === null ? null : s.dob.toISOString().slice(0, 10),
    });
  }
  return out;
}

async function codesOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const u = [...new Set(ids)];
  if (u.length === 0) return new Map();
  const rows = await db.select({ id: users.id, code: users.staffCode }).from(users).where(inArray(users.id, u));
  return new Map(rows.map((r) => [r.id, r.code]));
}

/** The register, newest first. `open` keeps the reports not yet sent to PvPI and not closed. */
export async function listAdr(db: Db, actor: Actor, opts: { open?: boolean; patientId?: string } = {}): Promise<AdrListRow[]> {
  await assertAdrReader(db, actor);
  const where = opts.patientId === undefined ? undefined : eq(pharmacyAdrReports.patientId, opts.patientId);
  const reports = await db.select().from(pharmacyAdrReports).where(where).orderBy(desc(pharmacyAdrReports.seq)).limit(LIST_LIMIT);
  if (reports.length === 0) return [];
  const ids = reports.map((r) => r.id);
  const [suspects, events, people, codes] = await Promise.all([
    db.select({ reportId: pharmacyAdrSuspects.reportId, name: pharmacyAdrSuspects.name }).from(pharmacyAdrSuspects)
      .where(inArray(pharmacyAdrSuspects.reportId, ids)).orderBy(asc(pharmacyAdrSuspects.position)),
    db.select().from(pharmacyAdrEvents).where(inArray(pharmacyAdrEvents.reportId, ids)).orderBy(asc(pharmacyAdrEvents.recordedAt)),
    patientsOf(db, actor, reports.map((r) => r.patientId)),
    codesOf(db, reports.map((r) => r.reportedBy)),
  ]);
  const rows = reports.map((r): AdrListRow => ({
    id: r.id, no: adrNumber(r.seq), patient: people.get(r.patientId) ?? null, onsetDate: r.onsetDate, seriousness: r.seriousness, outcome: r.outcome,
    suspects: suspects.filter((s) => s.reportId === r.id).map((s) => s.name), reportedByCode: codes.get(r.reportedBy) ?? "",
    createdAt: r.createdAt.toISOString(), state: stateOf(events.filter((e) => e.reportId === r.id)),
  }));
  return opts.open === true ? rows.filter((r) => r.state.sentOn === null && !r.state.closed) : rows;
}

export async function getAdr(db: Db, actor: Actor, reportId: string): Promise<AdrDetail> {
  await assertAdrReader(db, actor);
  const r = (await db.select().from(pharmacyAdrReports).where(eq(pharmacyAdrReports.id, reportId)))[0];
  if (r === undefined) throw new PharmacyError("unknown_adr", `ADR report ${reportId} not found`);
  const [suspects, events, people] = await Promise.all([
    db.select().from(pharmacyAdrSuspects).where(eq(pharmacyAdrSuspects.reportId, r.id)).orderBy(asc(pharmacyAdrSuspects.position)),
    db.select().from(pharmacyAdrEvents).where(eq(pharmacyAdrEvents.reportId, r.id)).orderBy(asc(pharmacyAdrEvents.recordedAt)),
    patientsOf(db, actor, [r.patientId]),
  ]);
  const codes = await codesOf(db, [r.reportedBy, ...events.map((e) => e.recordedBy)]);
  return {
    id: r.id, no: adrNumber(r.seq), patient: people.get(r.patientId) ?? null, onsetDate: r.onsetDate, seriousness: r.seriousness, outcome: r.outcome,
    suspects: suspects.map((s) => s.name), reportedByCode: codes.get(r.reportedBy) ?? "", createdAt: r.createdAt.toISOString(), state: stateOf(events),
    reaction: r.reaction, recoveryDate: r.recoveryDate, dechallenge: r.dechallenge, rechallenge: r.rechallenge, weightKg: r.weightKg,
    concomitants: r.concomitants, relevantTests: r.relevantTests, relevantHistory: r.relevantHistory,
    suspectLines: suspects.map((s) => ({
      position: s.position, saltId: s.saltId, name: s.name, itemId: s.itemId, batchNo: s.batchNo, manufacturer: s.manufacturer, dose: s.dose,
      route: s.route, frequency: s.frequency, indication: s.indication, startDate: s.startDate, stopDate: s.stopDate, dispenseId: s.dispenseId, allergyId: s.allergyId,
    })),
    events: events.map((e) => ({
      id: e.id, kind: e.kind as AdrEventKind, causality: e.causality, sentOn: e.sentOn, channel: e.channel, pvpiRef: e.pvpiRef, note: e.note,
      recordedBy: e.recordedBy, recordedByCode: codes.get(e.recordedBy) ?? "", recordedAt: e.recordedAt.toISOString(),
    })),
  };
}

/** The office's LAW side: reports neither sent to PvPI nor closed. Ids and codes only — no patient, no narrative. */
export type AdrAwaitingPvpi = { id: string; no: string; seriousness: string; onsetDate: string; createdAt: string; suspects: string[] };

export async function adrAwaitingPvpi(db: Db, actor: Actor): Promise<AdrAwaitingPvpi[]> {
  await assertAdrReader(db, actor);
  /* Bounded by what is still open, never by the register's size: a NOT EXISTS against the two settling acts. */
  const open = await db.select({ id: pharmacyAdrReports.id, seq: pharmacyAdrReports.seq, seriousness: pharmacyAdrReports.seriousness,
    onsetDate: pharmacyAdrReports.onsetDate, createdAt: pharmacyAdrReports.createdAt })
    .from(pharmacyAdrReports)
    .where(notExists(db.select({ one: sql`1` }).from(pharmacyAdrEvents).where(and(
      eq(pharmacyAdrEvents.reportId, pharmacyAdrReports.id), inArray(pharmacyAdrEvents.kind, ["sent_to_pvpi", "closed"]),
    ))))
    .orderBy(asc(pharmacyAdrReports.seq)).limit(LIST_LIMIT);
  if (open.length === 0) return [];
  const suspects = await db.select({ reportId: pharmacyAdrSuspects.reportId, name: pharmacyAdrSuspects.name }).from(pharmacyAdrSuspects)
    .where(inArray(pharmacyAdrSuspects.reportId, open.map((r) => r.id))).orderBy(asc(pharmacyAdrSuspects.position));
  return open.map((r) => ({
    id: r.id, no: adrNumber(r.seq), seriousness: r.seriousness, onsetDate: r.onsetDate, createdAt: r.createdAt.toISOString(),
    suspects: suspects.filter((s) => s.reportId === r.id).map((s) => s.name),
  }));
}
