import { Logger } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { ER_ESI_INFO, ER_SINCE_MAX_LINES } from "@hmis/contracts";
import {
  erDoses, erEpisodes, erMedIssues, erNotes, erProcedures, erSpecialtyCalls, erTriageEntries, orderItems, orders, services, users,
} from "../../kernel/db/schema";
import { quantitiesIn } from "../ipd";
import { openCriticalsForEncounters } from "../lab";
import { requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import { mlcOfEpisode } from "./mlc";
import { ER_CARE } from "./names";
import type { Actor, ErEsiLevel, ErSinceArrival, ErSinceLine, ErSinceSource, ErVitals } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ER lane 9 (#816) — "SINCE ARRIVAL" (spec §4.9, §5 D: the ER doctor's patient view opens on it). Four to six lines, each
 * with its SOURCE chip and the RECORDS it was read from. Deterministic: no model call, no write (DECIDED, lane 9 — the
 * ER trolley cannot wait on a model, and the record's own words are what a doctor checks against).
 *
 * THE NUMBER RULE (done means: "a since-arrival line whose number differs from its source fails the suite"): every
 * record carries a LABEL built from the row's own fields, separately from the line's wording; every number and clock
 * time in a line's text must be in its records' labels (`verifyErSinceLine`). A line that fails is dropped from the
 * answer and logged — never shown. Lines state values and times, never a count the records do not state.
 *
 * No money (decision 0058). A restricted test (HIV, PCPNDT-class) is not named.
 */

const MIN = 60_000;
const logger = new Logger("er-since");

/** "14:06", IST, from a server instant. */
export function istHm(d: Date): string {
  const ist = new Date(d.getTime() + 330 * MIN);
  return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
}

type Rec = ErSinceLine["records"][number];
type Candidate = ErSinceLine & { rank: number };

const rec = (id: string, at: Date | null, label: string): Rec => ({ id, at: at?.toISOString() ?? null, label });

/** May this line stand? Every number and clock time in its text is in the labels of its own records. */
export function verifyErSinceLine(line: Pick<ErSinceLine, "text" | "records">): { ok: true } | { ok: false; reason: string } {
  if (line.records.length === 0) return { ok: false, reason: "no_records" };
  const said = quantitiesIn(line.text);
  const known = line.records.map((r) => quantitiesIn(r.label));
  const numbers = known.flatMap((k) => k.numbers);
  const times = new Set(known.flatMap((k) => k.times));
  for (const n of said.numbers) if (!numbers.some((x) => Math.abs(x - n) < 1e-9)) return { ok: false, reason: `number_not_in_source:${String(n)}` };
  for (const t of said.times) if (!times.has(t)) return { ok: false, reason: `time_not_in_source:${t}` };
  return { ok: true };
}

const MODE_WORDS: Record<string, string> = {
  walk_in: "walked in", private_vehicle: "private vehicle", own_ambulance: "hospital ambulance", ambulance_108: "108 ambulance",
  police: "brought by police", referred_in: "referred in", inter_facility: "inter-facility transfer",
};

const vitalsLabel = (v: ErVitals): string =>
  Object.entries(v).map(([k, x]) => `${k} ${String(x)}`).join("; ");

/** The vitals line's words: what was measured, in the bedside's own short forms. */
function vitalsWords(v: ErVitals): string {
  const parts: string[] = [];
  if (v.pulse !== undefined) parts.push(`P ${String(v.pulse)}`);
  if (v.systolic !== undefined) parts.push(v.diastolic === undefined ? `SBP ${String(v.systolic)}` : `BP ${String(v.systolic)}/${String(v.diastolic)}`);
  if (v.respRate !== undefined) parts.push(`RR ${String(v.respRate)}`);
  if (v.spo2 !== undefined) parts.push(`SpO2 ${String(v.spo2)}%${v.onOxygen === true ? " on O2" : ""}`);
  if (v.temperatureC !== undefined) parts.push(`T ${String(v.temperatureC)}`);
  if (v.consciousness !== undefined && v.consciousness !== "alert") parts.push(v.consciousness);
  return parts.join(" · ");
}

/** Every candidate line for one episode (unchosen), each with its records. Exported for the acceptance suite. */
export async function sinceCandidates(db: Db, episodeId: string, now: Date): Promise<{ arrivedAt: Date; lines: Candidate[] }> {
  const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (e === undefined) throw new ErRefusal("episode_not_found");
  const out: Candidate[] = [];
  const push = (rank: number, key: string, source: ErSinceSource, at: Date | null, abnormal: boolean, text: string, records: Rec[]): void => {
    out.push({ rank, key, source, at: at?.toISOString() ?? null, abnormal, text, records });
  };

  // ── arrival ──
  push(90, "arrival", "arrival", e.arrivedAt, false, `Arrived ${istHm(e.arrivedAt)} · ${MODE_WORDS[e.arrivalMode] ?? e.arrivalMode}${e.complaint === null ? "" : ` · ${e.complaint.slice(0, 80)}`}`,
    [rec(e.id, e.arrivedAt, `arrived ${istHm(e.arrivedAt)}; mode ${e.arrivalMode}; complaint ${e.complaint ?? ""}`)]);

  // ── triage and vitals ──
  const entries = await db.select().from(erTriageEntries).where(eq(erTriageEntries.episodeId, e.id)).orderBy(asc(erTriageEntries.recordedAt));
  const levels = entries.filter((t) => t.level !== null);
  const last = levels.at(-1);
  if (last !== undefined) {
    const lv = last.level as ErEsiLevel;
    const prev = levels.at(-2);
    const was = prev !== undefined && prev.level !== lv ? ` (was ESI ${String(prev.level)})` : "";
    push(30, "triage", "triage", last.recordedAt, lv <= 2, `ESI ${String(lv)} ${ER_ESI_INFO[lv].word} at ${istHm(last.recordedAt)}${was}`,
      [last, ...(prev === undefined ? [] : [prev])].map((t) => rec(t.id, t.recordedAt, `${t.kind} at ${istHm(t.recordedAt)}; level ${String(t.level)}`)));
  }
  const lastVitals = [...entries].reverse().find((t) => t.vitals !== null && Object.keys(t.vitals).length > 0);
  if (lastVitals !== undefined) {
    const v = lastVitals.vitals as ErVitals;
    const ews = lastVitals.ewsKind === null ? "" : ` · ${lastVitals.ewsKind.toUpperCase()} ${String(lastVitals.ewsValue)} ${lastVitals.ewsBand ?? ""}`.trimEnd();
    const abnormal = lastVitals.ewsBand === "high" || lastVitals.ewsBand === "medium";
    push(abnormal ? 15 : 35, "vitals", "vitals", lastVitals.takenAt, abnormal, `Vitals ${istHm(lastVitals.takenAt)}: ${vitalsWords(v)}${ews}`,
      [rec(lastVitals.id, lastVitals.takenAt, `vitals at ${istHm(lastVitals.takenAt)}; ${vitalsLabel(v)}; ${lastVitals.ewsKind ?? ""} ${String(lastVitals.ewsValue ?? "")} ${lastVitals.ewsBand ?? ""}`)]);
  }

  // ── the doctor ──
  const level = (e.esi ?? null) as ErEsiLevel | null;
  if (e.seenAt !== null) {
    const doc = e.doctorId === null ? undefined : (await db.select({ n: users.fullName }).from(users).where(eq(users.id, e.doctorId)))[0]?.n;
    const mins = Math.max(0, Math.floor((e.seenAt.getTime() - e.arrivedAt.getTime()) / MIN));
    push(40, "doctor", "doctor", e.seenAt, false, `Seen by ${doc ?? "the ER doctor"} at ${istHm(e.seenAt)}, ${String(mins)} min after arrival`,
      [rec(e.id, e.seenAt, `arrived ${istHm(e.arrivedAt)}; seen ${istHm(e.seenAt)}; door to doctor ${String(mins)} min`)]);
  } else if (level !== null && e.departedAt === null) {
    const waited = Math.max(0, Math.floor((now.getTime() - e.arrivedAt.getTime()) / MIN));
    const target = ER_ESI_INFO[level].doctorWithinMin;
    push(waited > target ? 12 : 45, "doctor", "doctor", null, waited > target, `No doctor yet · waiting ${String(waited)} min (ESI ${String(level)} target ${String(target)} min)`,
      [rec(e.id, e.arrivedAt, `arrived ${istHm(e.arrivedAt)}; waited ${String(waited)} min; level ${String(level)}; target ${String(target)} min`)]);
  }

  // ── specialty calls ──
  const calls = await db.select().from(erSpecialtyCalls).where(eq(erSpecialtyCalls.episodeId, e.id)).orderBy(desc(erSpecialtyCalls.calledAt)).limit(3);
  for (const c of calls) {
    const open = c.answeredAt === null;
    const waited = Math.max(0, Math.floor(((c.answeredAt ?? now).getTime() - c.calledAt.getTime()) / MIN));
    const text = open
      ? `${c.departmentCode} called ${istHm(c.calledAt)} · not answered, ${String(waited)} min`
      : `${c.departmentCode} called ${istHm(c.calledAt)} · answered ${istHm(c.answeredAt!)}${c.answerNote === null ? "" : `: ${c.answerNote.slice(0, 60)}`}`;
    push(open && waited >= 15 ? 14 : 50, `call:${c.id}`, "call", c.calledAt, open && waited >= 15, text,
      [rec(c.id, c.calledAt, `call ${c.departmentCode} at ${istHm(c.calledAt)}; answered ${c.answeredAt === null ? "no" : istHm(c.answeredAt)}; waited ${String(waited)} min; ${c.answerNote ?? ""}`)]);
  }

  // ── criticals (the lab's open ones) and results ──
  for (const c of await openCriticalsForEncounters(db, [e.episodeNo])) {
    push(10, `critical:${c.callId}`, "critical", c.openedAt, true, `Critical: ${c.analyteCode} ${c.value}${c.unit === null ? "" : ` ${c.unit}`} at ${istHm(c.openedAt)} · not yet read back`,
      [rec(c.callId, c.openedAt, `critical ${c.analyteCode} ${c.value} ${c.unit ?? ""} opened ${istHm(c.openedAt)}`)]);
  }
  const items = await db.select({ id: orderItems.id, status: orderItems.status, completedAt: orderItems.completedAt, name: services.name, placedAt: orders.placedAt })
    .from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId)).innerJoin(services, eq(services.id, orderItems.serviceId))
    .where(and(eq(orders.encounterNo, e.episodeNo), eq(orderItems.restricted, false), isNull(orderItems.cancelledAt)))
    .orderBy(desc(orders.placedAt)).limit(6);
  if (items.length > 0) {
    const shown = items.slice(0, 4);
    const words = shown.map((i) => (i.completedAt === null ? `${i.name} pending` : `${i.name} done ${istHm(i.completedAt)}`)).join("; ");
    push(55, "results", "results", items[0]!.placedAt, false, `Tests: ${words}${items.length > shown.length ? "; and more" : ""}`,
      shown.map((i) => rec(i.id, i.completedAt ?? i.placedAt, `test ${i.name}; placed ${istHm(i.placedAt)}; ${i.completedAt === null ? "pending" : `done ${istHm(i.completedAt)}`}`)));
  }

  // ── medicines and procedures ──
  const meds = await db.select().from(erMedIssues).where(eq(erMedIssues.episodeId, e.id)).orderBy(desc(erMedIssues.issuedAt)).limit(6);
  const doses = meds.length === 0 ? [] : await db.select().from(erDoses).where(inArray(erDoses.issueId, meds.map((m) => m.id)));
  const doseOf = new Map(doses.map((d) => [d.issueId, d] as const));
  const recorded = meds.filter((m) => doseOf.has(m.id)).slice(0, 3);
  if (recorded.length > 0) {
    const words = recorded.map((m) => { const d = doseOf.get(m.id)!; return `${m.name} ${m.doseWords} ${d.outcome} ${istHm(d.recordedAt)}`; }).join("; ");
    push(60, "meds", "meds", doseOf.get(recorded[0]!.id)!.recordedAt, false, `Medicines: ${words}`,
      recorded.map((m) => { const d = doseOf.get(m.id)!; return rec(d.id, d.recordedAt, `dose ${m.name}; ${m.doseWords}; ${d.outcome} at ${istHm(d.recordedAt)}`); }));
  }
  const procs = await db.select().from(erProcedures).where(eq(erProcedures.episodeId, e.id)).orderBy(desc(erProcedures.performedAt)).limit(3);
  if (procs.length > 0) {
    push(65, "procedures", "procedure", procs[0]!.performedAt, false, `Procedures: ${procs.map((p) => `${p.name} ${istHm(p.performedAt)}`).join("; ")}`,
      procs.map((p) => rec(p.id, p.performedAt, `procedure ${p.name} at ${istHm(p.performedAt)}`)));
  }

  // ── the MLC, the disposition, the last note ──
  const mlc = await mlcOfEpisode(db, e.id);
  if (mlc !== undefined) {
    push(70, "mlc", "mlc", mlc.openedAt, false, `MLC ${mlc.mlcNo} opened ${istHm(mlc.openedAt)}`, [rec(mlc.id, mlc.openedAt, `mlc ${mlc.mlcNo} opened ${istHm(mlc.openedAt)}`)]);
  }
  if (e.disposition !== null && e.dispositionAt !== null) {
    const boarding = e.boardingSince !== null && e.state === "disposition_decided" ? ` · boarding since ${istHm(e.boardingSince)}` : "";
    push(25, "disposition", "disposition", e.dispositionAt, false, `Decision: ${e.disposition.replace("_", " ")} at ${istHm(e.dispositionAt)}${boarding}`,
      [rec(e.id, e.dispositionAt, `disposition ${e.disposition} at ${istHm(e.dispositionAt)}; boarding since ${e.boardingSince === null ? "" : istHm(e.boardingSince)}`)]);
  }
  const note = (await db.select().from(erNotes).where(eq(erNotes.episodeId, e.id)).orderBy(desc(erNotes.recordedAt)).limit(1))[0];
  if (note !== undefined) {
    const excerpt = note.text.replace(/\s+/g, " ").trim();
    push(75, "note", "note", note.recordedAt, false, `Note ${istHm(note.recordedAt)}${note.status === "draft" ? " (draft)" : ""}: ${excerpt.length > 120 ? `${excerpt.slice(0, 117)}…` : excerpt}`,
      [rec(note.id, note.recordedAt, `note at ${istHm(note.recordedAt)}: ${note.text}`)]);
  }
  return { arrivedAt: e.arrivedAt, lines: out };
}

/** The doctor's "since arrival": the six most telling lines (critical and abnormal first), each verified, none written. */
export async function readSinceArrival(db: Db, actor: Actor, episodeId: string, opts: { now?: Date } = {}): Promise<ErSinceArrival> {
  await requireErPermission(db, actor, ER_CARE);
  const now = opts.now ?? new Date();
  const { arrivedAt, lines } = await sinceCandidates(db, episodeId, now);
  const kept = lines.filter((l) => {
    const v = verifyErSinceLine(l);
    if (!v.ok) logger.warn(`since-arrival line ${l.key} dropped: ${v.reason}`);
    return v.ok;
  });
  const chosen = kept.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)).slice(0, ER_SINCE_MAX_LINES)
    .map(({ rank: _rank, ...line }) => line);
  return { episodeId, asOf: now.toISOString(), arrivedAt: arrivedAt.toISOString(), lines: chosen };
}
