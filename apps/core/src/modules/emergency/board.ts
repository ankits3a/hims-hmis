import { and, desc, eq, gt, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { ER_DOOR_TO_TRIAGE_MINUTES, ER_ESI_INFO } from "@hmis/contracts";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { ER_OPEN_STATE_VALUES, erBands, erEpisodes, erPreAlerts, erSpecialtyCalls, erTriageEntries, patients, resources, roleAssignments, users } from "../../kernel/db/schema";
import { initialsOf } from "../ipd";
import { openCriticalsForEncounters } from "../lab";
import { getMergeRequest, getPatientSummaries, searchPatients } from "../patients";
import { aliasHiOf, requireErPermission, yearsOld } from "./core";
import { ER_ARRIVAL_REGISTER, ER_BOARD_VIEW, ER_BOARD_WALL, ER_TRIAGE } from "./names";
import { ErRefusal } from "./errors";
import type {
  Actor, ErAgeBand, ErArrivalMode, ErBay, ErBoard, ErDeskRow, ErDoctorOption, ErEpisodeView, ErEsiLevel, ErEws, ErDeskView, ErEpisodeState, ErExpectedCard, ErPatientHit, ErSex, ErTile,
  ErTileChip,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { EpisodeRow } from "./core";

/**
 * ER lane 1 (#808) — THE TRACKING BOARD v1 AND THE ER DESK's reads (spec §5 A, C). Reads only: no lock, no write.
 *
 * - Every name is read through the patients merge chain (`getPatientSummaries`), so an unknown merged into the true record
 *   shows the true name; a sealed record shows its alias (the patients module's rule).
 * - WALL mode never carries a name: an unidentified patient's alias (an alias is not a name) or a named patient's
 *   initials; no UHID, no complaint words.
 * - No money anywhere (decision 0058; the contract test walks every key).
 * - "Name alert" (spec §4.1 edge, IPD principle 4): two people in the department whose first names match carry it on
 *   both tiles. DECIDED: first-name match, case-blind — the sound-alike risk NABH names, on what the board can know.
 */
const AMBULANCE: ReadonlySet<string> = new Set(["own_ambulance", "ambulance_108", "inter_facility"]);
const MINUTE = 60_000;

type Named = { label: string; labelHi: string | null; uhid: string; sex: ErSex; ageYears: number | null; identified: boolean; canonicalId: string };

/** Names for episodes, through the merge chain. An unknown not yet merged keeps its alias. */
async function namesFor(db: Db, actor: Actor, eps: readonly EpisodeRow[], at: Date): Promise<Map<string, Named>> {
  const summaries = await getPatientSummaries(db, actor, eps.map((e) => e.patientId));
  const byRequested = new Map(summaries.map((s) => [s.requestedId, s] as const));
  const out = new Map<string, Named>();
  for (const e of eps) {
    const s = byRequested.get(e.patientId);
    const merged = s !== undefined && s.id !== e.patientId;
    const stillUnknown = e.unidentified && !merged;
    const label = stillUnknown ? (e.alias ?? "—") : (s?.name ?? s?.alias ?? "—");
    out.set(e.id, {
      label, labelHi: stillUnknown ? aliasHiOf(e.alias) : null, uhid: s?.uhid ?? "", identified: !stillUnknown,
      sex: (s?.administrativeGender ?? "unknown") as ErSex, ageYears: yearsOld(s?.dob ?? null, at), canonicalId: s?.id ?? e.patientId,
    });
  }
  return out;
}

function firstName(label: string): string {
  return (label.trim().split(/\s+/)[0] ?? "").toLowerCase();
}

function chipsOf(e: EpisodeRow, n: Named, alerted: ReadonlySet<string>, wall: boolean): ErTileChip[] {
  const chips: ErTileChip[] = [];
  if (!n.identified) chips.push("unidentified");
  if (alerted.has(e.id)) chips.push("name_alert");
  if (e.returnedWithin24h) chips.push("returned_24h");
  const bringer = (e.broughtBy as { kind?: string } | null)?.kind;
  // ER review (2026-10-15): police involvement is MLC-sensitive — never on the wall display.
  if (!wall && (e.arrivalMode === "police" || bringer === "police")) chips.push("police");
  if (AMBULANCE.has(e.arrivalMode)) chips.push("ambulance");
  if (e.paperSerial !== null) chips.push("paper");
  return chips;
}

/** Episode ids whose patient shares a first name with another PERSON in the list (named patients only). */
function nameAlerts(eps: readonly EpisodeRow[], names: Map<string, Named>): Set<string> {
  const byFirst = new Map<string, Set<string>>();
  for (const e of eps) {
    const n = names.get(e.id)!;
    if (!n.identified) continue;
    const k = firstName(n.label);
    if (k === "") continue;
    const set = byFirst.get(k) ?? new Set<string>();
    set.add(n.canonicalId);
    byFirst.set(k, set);
  }
  return new Set(eps.filter((e) => {
    const n = names.get(e.id)!;
    return n.identified && (byFirst.get(firstName(n.label))?.size ?? 0) > 1;
  }).map((e) => e.id));
}

function preAlertCard(p: typeof erPreAlerts.$inferSelect, wall: boolean, name: string | null): ErExpectedCard {
  return {
    preAlertId: p.id, mode: wall && p.mode === "police" ? null : p.mode as ErExpectedCard["mode"], expectedAt: p.expectedAt.toISOString(), expiresAt: p.expiresAt.toISOString(),
    count: p.count, arrivedCount: p.arrivedCount, sex: (p.sex ?? null) as ErSex | null, ageBand: (p.ageBand ?? null) as ErAgeBand | null,
    complaint: wall ? null : p.complaint,
    patientId: wall ? null : p.patientId, patientLabel: name === null ? null : wall ? initialsOf(name) : name,
  };
}

async function liveExpected(db: Db, actor: Actor, at: Date, wall: boolean): Promise<ErExpectedCard[]> {
  const rows = await db.select().from(erPreAlerts)
    .where(and(eq(erPreAlerts.state, "expected"), gt(erPreAlerts.expiresAt, at))).orderBy(erPreAlerts.expectedAt);
  const ids = rows.flatMap((r) => (r.patientId === null ? [] : [r.patientId]));
  const names = new Map((await getPatientSummaries(db, actor, ids)).map((x) => [x.requestedId, x.name ?? x.alias ?? "—"] as const));
  return rows.map((p) => preAlertCard(p, wall, p.patientId === null ? null : names.get(p.patientId) ?? null));
}

/** Every tile for these episodes: names through the merge chain, the name alert, the bay, the doctor and the clocks. */
async function tilesFor(db: Db, actor: Actor, eps: readonly EpisodeRow[], at: Date, wall: boolean): Promise<Map<string, ErTile>> {
  const names = await namesFor(db, actor, eps, at);
  const alerted = nameAlerts(eps.filter((e) => (ER_OPEN_STATE_VALUES as readonly string[]).includes(e.state)), names);
  const bayIds = eps.flatMap((e) => (e.bayId === null ? [] : [e.bayId]));
  const bays = new Map(bayIds.length === 0 ? [] : (await db.select({ id: resources.id, code: resources.code }).from(resources)
    .where(inArray(resources.id, bayIds))).map((b) => [b.id, b.code] as const));
  const docIds = eps.flatMap((e) => (e.doctorId === null ? [] : [e.doctorId]));
  const docs = new Map(docIds.length === 0 ? [] : (await db.select({ id: users.id, name: users.fullName }).from(users)
    .where(inArray(users.id, docIds))).map((d) => [d.id, d.name] as const));
  // Lane 3 (#810): an open critical (the lab's ladder), a specialty call not yet answered, stabilised.
  const openEps = eps.filter((e) => (ER_OPEN_STATE_VALUES as readonly string[]).includes(e.state));
  const critical = new Set((await openCriticalsForEncounters(db, openEps.map((e) => e.episodeNo))).map((c) => c.encounterNo));
  const waitingCall = new Set(openEps.length === 0 ? [] : (await db.select({ id: erSpecialtyCalls.episodeId }).from(erSpecialtyCalls)
    .where(and(inArray(erSpecialtyCalls.episodeId, openEps.map((e) => e.id)), isNull(erSpecialtyCalls.answeredAt)))).map((r) => r.id));
  const out = new Map<string, ErTile>();
  for (const e of eps) {
    const n = names.get(e.id)!;
    const extra: ErTileChip[] = [];
    if (critical.has(e.episodeNo)) extra.push("critical");
    if (waitingCall.has(e.id)) extra.push("call_waiting");
    if (e.stabilisedAt !== null) extra.push("stabilised");
    const esi = (e.esi ?? null) as ErEsiLevel | null;
    const doc = e.doctorId === null ? null : docs.get(e.doctorId) ?? null;
    out.set(e.id, {
      episodeId: e.id, episodeNo: e.episodeNo,
      label: wall && n.identified ? initialsOf(n.label) : n.label, labelHi: n.labelHi, uhid: wall ? null : n.uhid,
      sex: n.sex, ageBand: (e.ageBand ?? null) as ErAgeBand | null, ageYears: n.ageYears,
      state: e.state as ErEpisodeState, arrivalMode: wall && e.arrivalMode === "police" ? null : e.arrivalMode as ErArrivalMode, arrivedAt: e.arrivedAt.toISOString(),
      triageDueAt: e.state === "arrived" ? new Date(e.arrivedAt.getTime() + ER_DOOR_TO_TRIAGE_MINUTES * MINUTE).toISOString() : null,
      chips: [...extra, ...chipsOf(e, n, alerted, wall)],
      esi, bayCode: e.bayId === null ? null : bays.get(e.bayId) ?? null,
      doctor: doc === null ? null : wall ? initialsOf(doc) : doc,
      doctorDueAt: esi === null || e.seenAt !== null ? null
        : new Date(e.arrivedAt.getTime() + ER_ESI_INFO[esi].doctorWithinMin * MINUTE).toISOString(),
      retriageDueAt: e.state === "triaged" && e.retriageDueAt !== null ? e.retriageDueAt.toISOString() : null,
      // ER review (2026-10-15, DECIDED): the wall shows the number and the band, never the score's name (MEOWS discloses
      // a pregnancy); the full board keeps it.
      ews: e.ewsKind === null ? null
        : { kind: wall ? null : e.ewsKind as ErEws["kind"], value: e.ewsValue ?? 0, band: e.ewsBand as ErEws["band"] },
    });
  }
  return out;
}

export async function readErBoard(db: Db, actor: Actor, opts: { wall?: boolean; now?: Date } = {}): Promise<ErBoard> {
  // The wall display asks its own string (a kiosk holds only that); the full board asks `er.board.view`.
  await requireErPermission(db, actor, opts.wall === true ? ER_BOARD_WALL : ER_BOARD_VIEW);
  const at = opts.now ?? new Date();
  const wall = opts.wall === true;
  const open = await db.select().from(erEpisodes)
    .where(inArray(erEpisodes.state, [...ER_OPEN_STATE_VALUES])).orderBy(erEpisodes.arrivedAt);
  const tiles = await tilesFor(db, actor, open, at, wall);
  const tile = (e: EpisodeRow): ErTile => tiles.get(e.id)!;
  const waiting = open.filter((e) => e.state === "arrived").map(tile);
  // Lane 2: the department by ESI (most urgent first), then by the gate.
  const inTreatment = open.filter((e) => e.state !== "arrived")
    .sort((a, b) => (a.esi ?? 9) - (b.esi ?? 9) || a.arrivedAt.getTime() - b.arrivedAt.getTime()).map(tile);
  const today = istDayWindow(at);
  const counts = (await db.execute(sql`
    select
      count(*) filter (where ${erEpisodes.state} <> 'brought_dead') as arrivals,
      count(*) filter (where ${erEpisodes.state} = 'brought_dead') as dead
    from ${erEpisodes} where ${erEpisodes.arrivedAt} >= ${today.start} and ${erEpisodes.arrivedAt} < ${today.end}
  `)).rows[0] as { arrivals: string | number; dead: string | number };
  // The emergency-class beds of the bed registry (the 60 of the planning layout), in service.
  const bays = (await db.execute(sql`
    select count(*) filter (where ${resources.status} <> 'retired') as total,
           count(*) filter (where ${resources.status} = 'available') as free
    from ${resources} where ${resources.kind} = 'bed' and ${resources.attributes}->>'class' = 'emergency'
  `)).rows[0] as { total: string | number; free: string | number };
  const oldest = waiting[0];
  const expected = await liveExpected(db, actor, at, wall);
  return {
    generatedAt: at.toISOString(), wall,
    stats: {
      inDepartment: open.length, waitingTriage: waiting.length,
      longestTriageWaitMinutes: oldest === undefined ? null : Math.max(0, Math.floor((at.getTime() - new Date(oldest.arrivedAt).getTime()) / MINUTE)),
      expected: expected.length, arrivalsToday: Number(counts.arrivals), broughtDeadToday: Number(counts.dead),
      bays: { free: Number(bays.free), total: Number(bays.total) },
    },
    expected, waiting, inTreatment,
  };
}

/** The ER desk: every open episode and every arrival of the last 24 hours, newest first, with band and identity state. */
export async function readErDesk(db: Db, actor: Actor, opts: { now?: Date } = {}): Promise<ErDeskView> {
  await requireErPermission(db, actor, ER_ARRIVAL_REGISTER);
  const at = opts.now ?? new Date();
  const since = new Date(at.getTime() - 24 * 60 * MINUTE);
  const eps = await db.select().from(erEpisodes)
    .where(or(inArray(erEpisodes.state, [...ER_OPEN_STATE_VALUES]), gte(erEpisodes.arrivedAt, since)))
    .orderBy(desc(erEpisodes.arrivedAt)).limit(200);
  const names = await namesFor(db, actor, eps, at);
  const bands = eps.length === 0 ? [] : await db.select().from(erBands)
    .where(and(inArray(erBands.episodeId, eps.map((e) => e.id)), eq(erBands.status, "printed")));
  const bandOf = new Map(bands.map((b) => [b.episodeId, b] as const));
  const rows: ErDeskRow[] = [];
  for (const e of eps) {
    const n = names.get(e.id)!;
    const b = bandOf.get(e.id);
    let identity: ErDeskRow["identity"] = null;
    if (e.identityMergeRequestId !== null) {
      const m = await getMergeRequest(db, e.identityMergeRequestId);
      if (m !== null) {
        const stage = m.request.status === "executed" ? "merged"
          : m.approvalStatus === "rejected" || m.request.status !== "requested" ? "refused"
            : m.approvalStatus === "granted" ? "granted" : "waiting";
        const winner = (await db.select({ uhid: patients.uhid }).from(patients).where(eq(patients.id, m.request.winnerId)))[0];
        identity = { mergeRequestId: m.request.id, stage, trueUhid: winner?.uhid ?? "" };
      }
    }
    rows.push({
      episodeId: e.id, episodeNo: e.episodeNo, patientId: e.patientId, uhid: n.uhid, name: n.label, nameHi: n.labelHi,
      unidentified: !n.identified, sex: n.sex, ageBand: (e.ageBand ?? null) as ErAgeBand | null, ageYears: n.ageYears,
      state: e.state as ErEpisodeState, arrivalMode: e.arrivalMode as ErArrivalMode, arrivedAt: e.arrivedAt.toISOString(),
      registeredAt: e.registeredAt.toISOString(), returnedWithin24h: e.returnedWithin24h,
      // Stale: the band names someone else now (the identity merge ran, or the name was corrected).
      band: b === undefined ? null : { serial: b.serial, stale: (b.payload as { name?: string }).name !== n.label },
      identity,
    });
  }
  return { generatedAt: at.toISOString(), episodes: rows, expected: await liveExpected(db, actor, at, false) };
}

/** The desk's patient lookup: a scanned UHID card, a typed UHID, a phone number or a name. */
export async function searchErPatients(db: Db, actor: Actor, q: string, opts: { now?: Date } = {}): Promise<ErPatientHit[]> {
  await requireErPermission(db, actor, ER_ARRIVAL_REGISTER);
  const at = opts.now ?? new Date();
  const hits = await searchPatients(db, actor, q, 10);
  if (hits.length === 0) return [];
  const flags = await db.select({ id: patients.id, identityStatus: patients.identityStatus }).from(patients)
    .where(and(inArray(patients.id, hits.map((h) => h.id)), ne(patients.status, "merged")));
  const unknown = new Set(flags.filter((f) => f.identityStatus === "unidentified").map((f) => f.id));
  return hits.map((h) => ({
    patientId: h.id, uhid: h.uhid, name: h.name, sex: h.administrativeGender, ageYears: yearsOld(h.dob, at),
    phoneTail: h.phone === null ? null : h.phone.slice(-4), unidentified: unknown.has(h.id),
  }));
}

/** The doctors the desk may name as having examined a body brought dead (active holders of the `doctor` role). */
export async function listErDoctors(db: Db, actor: Actor, permission: string = ER_ARRIVAL_REGISTER): Promise<ErDoctorOption[]> {
  await requireErPermission(db, actor, permission === ER_TRIAGE ? ER_TRIAGE : ER_ARRIVAL_REGISTER);
  const rows = await db.selectDistinct({ userId: users.id, name: users.fullName }).from(users)
    .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
    .where(and(eq(roleAssignments.roleKey, "doctor"), eq(users.active, true)))
    .orderBy(users.fullName).limit(500);
  return rows;
}

/**
 * Lane 2 (#809) — the ER bays: every emergency-class bed of the registry in service, with its state and the ER episode in
 * it. "free" is kernel `available` with no live hold, block or repair (the act re-checks under the lock).
 */
export async function listErBays(db: Db, actor: Actor): Promise<ErBay[]> {
  await requireErPermission(db, actor, ER_TRIAGE);
  const beds = await db.select().from(resources).where(and(
    eq(resources.kind, "bed"), sql`${resources.attributes}->>'class' = 'emergency'`, ne(resources.status, "retired"),
  )).orderBy(resources.code);
  const parentIds = [...new Set(beds.flatMap((b) => (b.parentId === null ? [] : [b.parentId])))];
  const parents = new Map(parentIds.length === 0 ? [] : (await db.select({ id: resources.id, name: resources.name }).from(resources)
    .where(inArray(resources.id, parentIds))).map((p) => [p.id, p.name] as const));
  return beds.map((b) => ({
    bedId: b.id, code: b.code, zone: b.parentId === null ? null : parents.get(b.parentId) ?? null,
    status: b.occupantRef !== null ? "occupied" : b.status === "available" ? "free" : b.status === "cleaning" ? "cleaning" : "blocked",
    episodeId: b.occupantType === "er_episode" ? b.occupantRef : null,
  }));
}

/** Lane 2 (#809) — one episode for the triage screen: the tile (identity header and clocks) and its triage history. */
export async function readErEpisode(db: Db, actor: Actor, episodeId: string, opts: { now?: Date } = {}): Promise<ErEpisodeView> {
  await requireErPermission(db, actor, ER_TRIAGE);
  const at = opts.now ?? new Date();
  const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (e === undefined) throw new ErRefusal("episode_not_found");
  const tile = (await tilesFor(db, actor, [e], at, false)).get(e.id)!;
  const rows = await db.select().from(erTriageEntries).where(eq(erTriageEntries.episodeId, e.id)).orderBy(desc(erTriageEntries.recordedAt));
  const by = new Map(rows.length === 0 ? [] : (await db.select({ id: users.id, name: users.fullName }).from(users)
    .where(inArray(users.id, [...new Set(rows.map((r) => r.recordedBy))]))).map((u) => [u.id, u.name] as const));
  return {
    tile, ageYears: tile.ageYears, complaint: e.complaint,
    history: rows.map((r) => ({
      kind: r.kind as "triage" | "re_triage" | "vitals", level: (r.level ?? null) as ErEsiLevel | null,
      algorithmLevel: (r.algorithmLevel ?? null) as ErEsiLevel | null, reason: r.reason,
      ews: r.ewsKind === null ? null : { kind: r.ewsKind as ErEws["kind"], value: r.ewsValue ?? 0, band: r.ewsBand as ErEws["band"] },
      by: by.get(r.recordedBy) ?? r.recordedBy, at: r.recordedAt.toISOString(),
    })),
  };
}
