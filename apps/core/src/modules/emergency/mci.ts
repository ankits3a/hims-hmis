import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { ER_INTENTS, ER_MCI_COMMAND_ROLES, ER_OPEN_STATES, mciTagProposal, newId } from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  erBands, erBills, erEpisodes, erEventAccounts, erMciEvents, erMciPacks, erMciSurgeBeds, erMciTags, resources, roleAssignments, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { initialsOf } from "../ipd";
import { PatientError, getPatientSummaries, registerPatient } from "../patients";
import { calloutList, orgDepartmentByCode } from "../roster";
import { arriveIn, arrivedEvent, gateInstant } from "./arrival";
import { bandPerson } from "./bands";
import { aliasHiOf, istYear, lockEpisode, lockKey, onceEr, provenanceOf, requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import { erBandPrinted, erEventAccountOpened, erMciDeclared, erMciPacksMinted, erMciStoodDown, erMciSurgeOpened, erMciTagged } from "./events";
import { runningMci } from "./mci-bays";
import { openMlcIn } from "./mlc";
import { ER_ARRIVAL_REGISTER, ER_MCI } from "./names";
import type { Actor, ErBandPayload, ErIntentName, ErMciBoard, ErMciCount, ErMciSurgeBed, ErMciTag } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ER lane 8 (#815) — MASS CASUALTY, CODE YELLOW (spec SPEC-emergency §3.9, §4.8, §5 G; decision 0076 §4; contracts
 * `emergency/mci.ts`).
 *
 * - `declareMci` / `standDownMci`: the MS or the duty manager (role, on top of `er.mci`). The declaration opens the
 *   event's account (lane 6's `er_event_accounts`) in the same transaction; one running event at a time.
 * - Packs: `mintMciPacks` makes real UHIDs ahead (unidentified records, alias `Unknown-MCI26-007`), each with its band
 *   (barcode = the pack number). `registerMciArrival` opens the ER episode on the pack's record — nothing asked — opens the
 *   MLC by rule (as every unknown), records the pre-printed band and links the patient to the event.
 * - `mciTag`: START (adult) / JumpSTART (child) — the person's tag beside the findings' proposal; every tag a row
 *   (`er_mci_tags`, append-only), the episode mirrors the last. A Black re-tag needs a reason (found alive). The first tag
 *   links the patient to the event: payer `mci_event` and the event's account (lane 6 bills nothing at the point of care),
 *   unless the ER bill is already settled.
 * - Surge bays: `openSurgeBays` (MS / duty manager) opens overflow-class beds to the ER for this event; triage places
 *   into them through the IPD seam (`placeErEpisodeIn` with `surge`).
 * - While the event runs, its untriaged patients are off the door-to-triage clock (they are tagged); the stand-down puts
 *   them back on it — the normal ESI flow.
 * - Reads: `readMciBoard` (tag counts, packs ready, bays and surge bays left, hospital beds free, patients by alias or
 *   initials) and `readMciCount` (the head count for the district authority: counts only, never a name).
 */
type Input<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["input"]>;
type Output<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["output"]>;
type Opts = { now?: Date };
type MciRow = typeof erMciEvents.$inferSelect;
const OPEN: readonly string[] = ER_OPEN_STATES;
const PAEDIATRIC_BANDS = new Set(["infant", "child"]);

async function requireCommand(db: Db, actor: Actor): Promise<void> {
  const rows = await db.select({ id: users.id }).from(users)
    .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
    .where(and(eq(users.id, actor.id), eq(users.active, true), inArray(roleAssignments.roleKey, [...ER_MCI_COMMAND_ROLES]))).limit(1);
  if (rows.length === 0) throw new ErRefusal("mci_role_needed", { roles: [...ER_MCI_COMMAND_ROLES] });
}

async function lockMci(tx: Tx, mciId: string): Promise<MciRow> {
  const m = (await tx.select().from(erMciEvents).where(eq(erMciEvents.id, mciId)).for("update"))[0];
  if (m === undefined) throw new ErRefusal("mci_not_found");
  return m;
}

/** "MCI26-007" — two-digit IST year, a three-digit serial (four once past 999). */
export function packNoOf(year: number, serial: number): string {
  return `MCI${String(year % 100).padStart(2, "0")}-${String(serial).padStart(3, "0")}`;
}
const packAlias = (packNo: string): string => `Unknown-${packNo}`;
const normalPackNo = (raw: string): string => raw.replace(/\s+/g, "").toUpperCase();

function packBand(packNo: string, uhid: string): ErBandPayload {
  const alias = packAlias(packNo);
  return {
    name: alias, nameHi: aliasHiOf(alias), uhid, ageSex: "? U", episodeNo: packNo, arrivedOn: "Code Yellow pack",
    allergyWords: ["Allergy: unknown"], alertWords: ["Unidentified", "Code Yellow"], size: "adult", site: "wrist",
    barcode: packNo, qr: `ERBAND1|${packNo}|${uhid}`,
  };
}

// ═══════════════════════════════════════════ declare and stand down ═══════════════════════════════════════════

/** The Casualty department of the roster (`org_departments.code`). */
export const ER_ROSTER_DEPARTMENT = "CAS";
/** #877: the most phones one Code Yellow rings (a bound, not a target: a 1,200-bed hospital's ER + on-call is well under). */
const MCI_PAGE_MAX = 100;

/**
 * #877 item 1 — WHO A CODE YELLOW PAGES (DECIDED, the standard disaster call-out): every person on the roster's call-out
 * list for Casualty NOW (its own duty plus the hospital-wide on-call cover the roster carries), then everyone who commands
 * a Code Yellow (the MS and the duty managers, by role). Nobody on the roster → the casualty nurses (`er_nurse`). The
 * declarer is not paged (they are on the board).
 */
async function mciPageList(tx: Tx, declarer: string, at: Date): Promise<string[]> {
  const ids = new Set<string>();
  const cas = await orgDepartmentByCode(tx, ER_ROSTER_DEPARTMENT);
  if (cas !== undefined) for (const r of await calloutList(tx, cas.id, at)) if (r.userId !== null) ids.add(r.userId);
  if (ids.size === 0) for (const u of await usersHoldingRole(tx, "er_nurse")) ids.add(u);
  for (const role of ER_MCI_COMMAND_ROLES) for (const u of await usersHoldingRole(tx, role)) ids.add(u);
  ids.delete(declarer);
  return [...ids].slice(0, MCI_PAGE_MAX);
}

export async function declareMci(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"declare_mci">> {
  const input: Input<"declare_mci"> = ER_INTENTS.declare_mci.input.parse(raw);
  await requireErPermission(db, actor, ER_MCI);
  await requireCommand(db, actor);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "declare_mci", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await lockKey(tx, "er_mci");
    const running = await runningMci(tx);
    if (running !== undefined) throw new ErRefusal("mci_active", { mciId: running.id, name: running.name });
    const accountId = newId();
    await tx.insert(erEventAccounts).values({ id: accountId, name: `Code Yellow · ${input.name}`, startedAt: at, openedBy: actor.id, openedAt: at });
    await appendEvent(tx, erEventAccountOpened.make({ payload: { eventAccountId: accountId, provenance: provenanceOf(actor) }, actor, correlationId: accountId, occurredAt: at }));
    const id = newId();
    await tx.insert(erMciEvents).values({
      id, name: input.name, place: input.place ?? null, note: input.note ?? null, eventAccountId: accountId, declaredBy: actor.id, declaredAt: at,
    });
    await appendEvent(tx, erMciDeclared.make({ payload: { mciId: id, eventAccountId: accountId, provenance: provenanceOf(actor) }, actor, correlationId: id, occurredAt: at }));
    // #877: THE PAGE, in the declaration's transaction — a bell row per person, relayed to the phones as the platform's
    // content-free notice. Words: the code and the place; there is no patient in them (there is none yet).
    const pageIds = await mciPageList(tx, actor.id, at);
    for (const userId of pageIds) {
      await raiseNoticeIn(tx, {
        userId, kind: "er.code_yellow", title: `Code Yellow · ${input.place ?? "ER"}`, body: "Mass casualty · report to the ER",
        refType: "er_mci", refId: id, sourceKey: `er_mci:${id}`, at,
      });
    }
    return { mciId: id, eventAccountId: accountId, declaredAt: at.toISOString(), paged: pageIds.length };
  }), at);
}

export async function standDownMci(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"stand_down_mci">> {
  const input: Input<"stand_down_mci"> = ER_INTENTS.stand_down_mci.input.parse(raw);
  await requireErPermission(db, actor, ER_MCI);
  await requireCommand(db, actor);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "stand_down_mci", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const m = await lockMci(tx, input.mciId);
    if (m.stoodDownAt !== null) throw new ErRefusal("mci_stood_down", { stoodDownAt: m.stoodDownAt.toISOString() });
    await tx.update(erMciEvents).set({ stoodDownBy: actor.id, stoodDownAt: at, standDownNote: input.note ?? null }).where(eq(erMciEvents.id, m.id));
    // Back to ESI: the untriaged patients of the event go back on the door-to-triage clock (the sweep reads the stand-down).
    const back = await tx.select({ id: erEpisodes.id }).from(erEpisodes).where(and(eq(erEpisodes.mciId, m.id), eq(erEpisodes.state, "arrived")));
    await appendEvent(tx, erMciStoodDown.make({ payload: { mciId: m.id, backToEsi: back.length, provenance: provenanceOf(actor) }, actor, correlationId: m.id, occurredAt: at }));
    return { mciId: m.id, stoodDownAt: at.toISOString(), backToEsi: back.length };
  }), at);
}

// ═══════════════════════════════════════════ the packs ═══════════════════════════════════════════

export async function mintMciPacks(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"mint_mci_packs">> {
  const input: Input<"mint_mci_packs"> = ER_INTENTS.mint_mci_packs.input.parse(raw);
  await requireErPermission(db, actor, ER_MCI);
  await requireCommand(db, actor);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "mint_mci_packs", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const year = istYear(at);
    await lockKey(tx, `er_mci_pack:${String(year)}`);
    const rows = (await tx.execute(sql`select coalesce(max(pack_serial), 0) as last from er_mci_packs where pack_year = ${year}`)).rows as { last: number | string }[];
    let serial = Number(rows[0]!.last);
    const packs: Output<"mint_mci_packs">["packs"] = [];
    for (let i = 0; i < input.count; i += 1) {
      serial += 1;
      const packNo = packNoOf(year, serial);
      const alias = packAlias(packNo);
      let patient: { id: string; uhid: string };
      try {
        ({ patient } = await registerPatient(tx, actor, { name: alias, sex: "unknown", identityStatus: "unidentified", identityAssurance: "self_declared" }));
      } catch (e) {
        if (e instanceof PatientError && e.code === "registration_not_configured") throw new ErRefusal("registration_not_ready");
        throw e;
      }
      const packId = newId();
      await tx.insert(erMciPacks).values({ id: packId, packNo, packYear: year, packSerial: serial, patientId: patient.id, alias, mintedBy: actor.id, mintedAt: at });
      packs.push({ packId, packNo, patientId: patient.id, uhid: patient.uhid, alias, aliasHi: aliasHiOf(alias)!, band: packBand(packNo, patient.uhid) });
    }
    await appendEvent(tx, erMciPacksMinted.make({
      payload: { first: packs[0]!.packNo, last: packs[packs.length - 1]!.packNo, count: packs.length, provenance: provenanceOf(actor) },
      actor, correlationId: packs[0]!.packId, occurredAt: at,
    }));
    return { packs };
  }), at);
}

/** The packs not yet on a patient, oldest first (the desk's box; reprint list). */
export async function listMciPacks(db: Db, actor: Actor): Promise<{ ready: { packNo: string; uhid: string; alias: string; band: ErBandPayload }[] }> {
  await requireErPermission(db, actor, ER_MCI);
  const rows = await db.select({ packNo: erMciPacks.packNo, alias: erMciPacks.alias, patientId: erMciPacks.patientId }).from(erMciPacks)
    .where(isNull(erMciPacks.usedEpisodeId)).orderBy(erMciPacks.packYear, erMciPacks.packSerial).limit(200);
  const ready = [];
  for (const r of rows) {
    const { uhid } = await bandPerson(db, r.patientId);
    ready.push({ packNo: r.packNo, uhid, alias: r.alias, band: packBand(r.packNo, uhid) });
  }
  return { ready };
}

// ═══════════════════════════════════════════ arrival from a pack, and the tag ═══════════════════════════════════════════

/** Links an episode to the event: the tag (a row, mirrored), and — once — the event's account as the payer. */
async function tagIn(
  tx: Tx, actor: Actor, e: { id: string; patientId: string; mciTag: string | null; mciId: string | null }, m: MciRow,
  t: { tag: ErMciTag; method?: "start" | "jumpstart"; findings?: Record<string, unknown>; proposal: ErMciTag | null; reason?: string }, at: Date,
): Promise<ErMciTag | null> {
  const previous = (e.mciTag ?? null) as ErMciTag | null;
  await tx.insert(erMciTags).values({
    id: newId(), mciId: m.id, episodeId: e.id, tag: t.tag, previous, method: t.method ?? null, findings: t.findings ?? null,
    proposal: t.proposal, reason: t.reason ?? null, taggedBy: actor.id, taggedAt: at,
  });
  const settled = (await tx.select({ id: erBills.id }).from(erBills).where(eq(erBills.episodeId, e.id)))[0] !== undefined;
  // Decision 0076 §4: every patient tagged to the event pays nothing at the point of care; the charges post to the event.
  const payer = e.mciId === null && !settled ? { payer: "mci_event", payerRef: null, coverCapPaise: null, coverUntil: null, eventAccountId: m.eventAccountId } : {};
  await tx.update(erEpisodes).set({ mciId: m.id, mciTag: t.tag, ...payer, updatedAt: at }).where(eq(erEpisodes.id, e.id));
  await appendEvent(tx, erMciTagged.make({
    payload: { mciId: m.id, episodeId: e.id, tag: t.tag, previous, provenance: provenanceOf(actor) },
    actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
  }));
  return previous;
}

export async function registerMciArrival(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"register_mci_arrival">> {
  const input: Input<"register_mci_arrival"> = ER_INTENTS.register_mci_arrival.input.parse(raw);
  await requireErPermission(db, actor, ER_ARRIVAL_REGISTER);
  const at = opts.now ?? new Date();
  const gate = gateInstant(input, at);
  return onceEr(db, actor, "register_mci_arrival", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const m = await runningMci(tx);
    if (m === undefined) throw new ErRefusal("mci_not_active");
    const packNo = normalPackNo(input.packNo);
    const pack = (await tx.select().from(erMciPacks).where(eq(erMciPacks.packNo, packNo)).for("update"))[0];
    if (pack === undefined) throw new ErRefusal("pack_not_found", { packNo });
    if (pack.usedEpisodeId !== null) throw new ErRefusal("pack_used", { episodeId: pack.usedEpisodeId });
    const e = await arriveIn(tx, actor, {
      patientId: pack.patientId, personIds: [pack.patientId], unidentified: { year: null, serial: null, alias: pack.alias },
      ageBand: input.ageBand ?? null, marks: null, common: { arrivalMode: input.arrivalMode ?? "ambulance_108", arrivedAt: input.arrivedAt }, gate,
    }, at);
    await tx.update(erEpisodes).set({ mciPackNo: packNo }).where(eq(erEpisodes.id, e.id));
    await tx.update(erMciPacks).set({ usedEpisodeId: e.id, usedAt: at }).where(eq(erMciPacks.id, pack.id));
    await arrivedEvent(tx, actor, e, at);
    // As every unknown arrival (lane 4): an MLC by rule; the doctor corrects the category by addendum.
    const mlc = await openMlcIn(tx, actor, e, { category: "unknown_unconscious", byRule: true }, at);
    // The band came with the pack (printed ahead): recorded as this episode's live band, barcode = the pack number.
    const { uhid } = await bandPerson(tx, pack.patientId);
    const bandId = newId();
    const band = { ...packBand(packNo, uhid), size: input.ageBand !== undefined && PAEDIATRIC_BANDS.has(input.ageBand) ? "paediatric" as const : "adult" as const };
    await tx.insert(erBands).values({
      id: bandId, episodeId: e.id, serial: packNo, size: band.size, site: band.site, printerId: null, status: "printed", payload: band,
      printedBy: pack.mintedBy, printedAt: pack.mintedAt,
    });
    await appendEvent(tx, erBandPrinted.make({ payload: { episodeId: e.id, bandId, serial: packNo, provenance: provenanceOf(actor) }, actor, correlationId: e.id, patientId: e.patientId, occurredAt: at }));
    if (input.tag !== undefined) await tagIn(tx, actor, { ...e, mciTag: null, mciId: null }, m, { tag: input.tag, proposal: null }, at);
    else await tx.update(erEpisodes).set({ mciId: m.id, payer: "mci_event", eventAccountId: m.eventAccountId }).where(eq(erEpisodes.id, e.id));
    return {
      episodeId: e.id, episodeNo: e.episodeNo, patientId: pack.patientId, uhid, alias: pack.alias, mciId: m.id, tag: input.tag ?? null, mlcNo: mlc.mlcNo,
    };
  }), at);
}

export async function mciTag(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"mci_tag">> {
  const input: Input<"mci_tag"> = ER_INTENTS.mci_tag.input.parse(raw);
  await requireErPermission(db, actor, ER_MCI);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "mci_tag", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEpisode(tx, input.episodeId);
    if (!OPEN.includes(e.state)) throw new ErRefusal("episode_wrong_state", { state: e.state });
    const m = await runningMci(tx);
    if (m === undefined) throw new ErRefusal("mci_not_active");
    if (e.mciTag === "black" && input.tag !== "black" && input.reason === undefined) throw new ErRefusal("retag_needs_reason");
    const method = input.method ?? (e.ageBand !== null && PAEDIATRIC_BANDS.has(e.ageBand) ? "jumpstart" : "start");
    const proposal = input.findings === undefined ? null : mciTagProposal(method, input.findings);
    const previous = await tagIn(tx, actor, e, m, {
      tag: input.tag, method, ...(input.findings === undefined ? {} : { findings: input.findings }), proposal, ...(input.reason === undefined ? {} : { reason: input.reason }),
    }, at);
    return { episodeId: e.id, mciId: m.id, tag: input.tag, proposal, previous };
  }), at);
}

// ═══════════════════════════════════════════ surge bays ═══════════════════════════════════════════

export async function openSurgeBays(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"open_surge_bays">> {
  const input: Input<"open_surge_bays"> = ER_INTENTS.open_surge_bays.input.parse(raw);
  await requireErPermission(db, actor, ER_MCI);
  await requireCommand(db, actor);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "open_surge_bays", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const m = await lockMci(tx, input.mciId);
    if (m.stoodDownAt !== null) throw new ErRefusal("mci_stood_down", { stoodDownAt: m.stoodDownAt.toISOString() });
    const ids = [...new Set(input.bedIds)];
    const beds = await tx.select({ id: resources.id, code: resources.code, cls: sql<string | null>`${resources.attributes}->>'class'`, status: resources.status })
      .from(resources).where(and(inArray(resources.id, ids), eq(resources.kind, "bed")));
    const bad = ids.filter((id) => { const b = beds.find((x) => x.id === id); return b === undefined || b.cls !== "overflow" || b.status === "retired"; });
    if (bad.length > 0) throw new ErRefusal("surge_bed_not_overflow", { bedIds: bad });
    const opened = [];
    for (const b of beds) {
      await tx.insert(erMciSurgeBeds).values({ id: newId(), mciId: m.id, bedId: b.id, approvedBy: actor.id, approvedAt: at }).onConflictDoNothing();
      opened.push({ bedId: b.id, code: b.code });
    }
    await appendEvent(tx, erMciSurgeOpened.make({ payload: { mciId: m.id, bedIds: ids, provenance: provenanceOf(actor) }, actor, correlationId: m.id, occurredAt: at }));
    return { mciId: m.id, opened: opened.sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true })) };
  }), at);
}

/** The overflow-class beds of the registry, with whether the running event opened each (the duty manager's picker). */
export async function listMciOverflowBeds(db: Db, actor: Actor): Promise<ErMciSurgeBed[]> {
  await requireErPermission(db, actor, ER_MCI);
  const m = await runningMci(db);
  const beds = await db.select().from(resources).where(and(
    eq(resources.kind, "bed"), sql`${resources.attributes}->>'class' = 'overflow'`, sql`${resources.status} <> 'retired'`,
  )).orderBy(resources.code);
  const approved = new Set(m === undefined ? [] : (await db.select({ bedId: erMciSurgeBeds.bedId }).from(erMciSurgeBeds).where(eq(erMciSurgeBeds.mciId, m.id))).map((r) => r.bedId));
  const parentIds = [...new Set(beds.flatMap((b) => (b.parentId === null ? [] : [b.parentId])))];
  const parents = new Map(parentIds.length === 0 ? [] : (await db.select({ id: resources.id, name: resources.name }).from(resources)
    .where(inArray(resources.id, parentIds))).map((p) => [p.id, p.name] as const));
  return beds.map((b) => ({
    bedId: b.id, code: b.code, ward: b.parentId === null ? null : parents.get(b.parentId) ?? null,
    status: b.occupantRef !== null ? "occupied" as const : b.status === "available" ? "free" as const : b.status === "cleaning" ? "cleaning" as const : "blocked" as const,
    approved: approved.has(b.id),
  }));
}

// ═══════════════════════════════════════════ reads: the board and the head count ═══════════════════════════════════════════

async function countOf(db: Db, m: MciRow, at: Date): Promise<ErMciCount> {
  const r = (await db.execute(sql`
    select
      count(*) as total,
      count(*) filter (where ${erEpisodes.mciTag} = 'red') as red,
      count(*) filter (where ${erEpisodes.mciTag} = 'yellow') as yellow,
      count(*) filter (where ${erEpisodes.mciTag} = 'green') as green,
      count(*) filter (where ${erEpisodes.mciTag} = 'black') as black,
      count(*) filter (where ${erEpisodes.mciTag} is null) as untagged,
      count(*) filter (where ${erEpisodes.state} in ('arrived', 'triaged', 'in_treatment', 'disposition_decided')) as in_department,
      count(*) filter (where ${erEpisodes.outcome} = 'admitted') as admitted,
      count(*) filter (where ${erEpisodes.outcome} = 'discharged') as discharged,
      count(*) filter (where ${erEpisodes.outcome} = 'referred_out') as referred_out,
      count(*) filter (where ${erEpisodes.outcome} = 'died' or ${erEpisodes.state} = 'brought_dead') as died,
      count(*) filter (where ${erEpisodes.outcome} in ('lama', 'absconded', 'lwbs')) as left_
    from ${erEpisodes} where ${erEpisodes.mciId} = ${m.id}
  `)).rows[0] as Record<string, string | number>;
  const n = (k: string): number => Number(r[k] ?? 0);
  return {
    mciId: m.id, name: m.name, place: m.place, declaredAt: m.declaredAt.toISOString(), stoodDownAt: m.stoodDownAt?.toISOString() ?? null,
    asOf: at.toISOString(), total: n("total"),
    byTag: { red: n("red"), yellow: n("yellow"), green: n("green"), black: n("black"), untagged: n("untagged") },
    byOutcome: {
      inDepartment: n("in_department"), admitted: n("admitted"), discharged: n("discharged"), referredOut: n("referred_out"), died: n("died"), left: n("left_"),
    },
  };
}

/** The head count for the district authority: counts by tag and by where the patients are now. No names. */
export async function readMciCount(db: Db, actor: Actor, mciId: string, opts: Opts = {}): Promise<ErMciCount> {
  await requireErPermission(db, actor, ER_MCI);
  const m = (await db.select().from(erMciEvents).where(eq(erMciEvents.id, mciId)))[0];
  if (m === undefined) throw new ErRefusal("mci_not_found");
  return countOf(db, m, opts.now ?? new Date());
}

export async function readMciBoard(db: Db, actor: Actor, opts: Opts = {}): Promise<ErMciBoard> {
  await requireErPermission(db, actor, ER_MCI);
  const at = opts.now ?? new Date();
  const m = await runningMci(db);
  const recentRows = await db.select().from(erMciEvents).where(isNotNull(erMciEvents.stoodDownAt)).orderBy(desc(erMciEvents.declaredAt)).limit(3);
  const recent = [];
  for (const r of recentRows) recent.push(await countOf(db, r, at));
  let patients: ErMciBoard["patients"] = [];
  let surge = { free: 0, total: 0 };
  if (m !== undefined) {
    const rows = await db.select().from(erEpisodes).where(eq(erEpisodes.mciId, m.id)).orderBy(erEpisodes.arrivedAt).limit(500);
    const people = new Map((await getPatientSummaries(db, actor, rows.map((e) => e.patientId))).map((p) => [p.requestedId, p] as const));
    const bayIds = [...new Set(rows.flatMap((e) => (e.bayId === null ? [] : [e.bayId])))];
    const bays = new Map(bayIds.length === 0 ? [] : (await db.select({ id: resources.id, code: resources.code }).from(resources)
      .where(inArray(resources.id, bayIds))).map((b) => [b.id, b.code] as const));
    const rank: Record<string, number> = { red: 0, yellow: 1, green: 3, black: 4 };
    patients = rows.map((e) => {
      const p = people.get(e.patientId);
      const named = p !== undefined && (!e.unidentified || p.id !== e.patientId);
      return {
        episodeId: e.id, episodeNo: e.episodeNo, label: named ? initialsOf(p.name ?? "") : (e.alias ?? e.episodeNo),
        tag: (e.mciTag ?? null) as ErMciTag | null, esi: e.esi, bayCode: e.bayId === null ? null : bays.get(e.bayId) ?? null,
        state: e.state, arrivedAt: e.arrivedAt.toISOString(),
      };
    }).sort((a, b) => (rank[a.tag ?? ""] ?? 2) - (rank[b.tag ?? ""] ?? 2) || a.arrivedAt.localeCompare(b.arrivedAt));
    const s = (await db.execute(sql`
      select count(*) as total, count(*) filter (where r.status = 'available' and r.occupant_ref is null) as free
      from ${erMciSurgeBeds} s join ${resources} r on r.id = s.bed_id where s.mci_id = ${m.id}
    `)).rows[0] as { total: string | number; free: string | number };
    surge = { free: Number(s.free), total: Number(s.total) };
  }
  const b = (await db.execute(sql`
    select count(*) filter (where ${resources.attributes}->>'class' = 'emergency' and ${resources.status} <> 'retired') as er_total,
           count(*) filter (where ${resources.attributes}->>'class' = 'emergency' and ${resources.status} = 'available' and ${resources.occupantRef} is null) as er_free,
           count(*) filter (where coalesce(${resources.attributes}->>'class', '') not in ('emergency', 'overflow') and ${resources.status} = 'available' and ${resources.occupantRef} is null) as ip_free
    from ${resources} where ${resources.kind} = 'bed'
  `)).rows[0] as { er_total: string | number; er_free: string | number; ip_free: string | number };
  const packs = (await db.select({ n: sql<number>`count(*)` }).from(erMciPacks).where(isNull(erMciPacks.usedEpisodeId)))[0];
  return {
    active: m === undefined ? null : await countOf(db, m, at), recent, patients, packsReady: Number(packs?.n ?? 0),
    bays: { free: Number(b.er_free), total: Number(b.er_total) }, surge, hospitalBedsFree: Number(b.ip_free), serverNow: at.toISOString(),
  };
}
