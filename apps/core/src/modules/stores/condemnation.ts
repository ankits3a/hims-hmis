import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { requestApproval } from "../../kernel/approvals/requests";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  approvals, episodeSeries, items, roleAssignments, rolePermissions, stockWriteOffs, storesAssetUnitEvents, storesCondemnationSignatures, storesCondemnationSteps,
  storesCondemnations, storesGatePasses, storesScrapSales, users, vendors,
} from "../../kernel/db/schema";
import {
  CONDEMNATION_OWNER_APPROVAL_TYPE, OPENING_BALANCE_REF_TYPE, TRANSIT_STORE_CODE, ensureCondemnedStore, postMovements, postWriteOff, raiseWriteOff,
} from "../materials";
import { STORES_GATEPASS_RAISE, STORES_MASTERS, holds, recordAct, requireStoresStore } from "./access";
import { itemRules } from "./asset-rules";
import {
  STORES_ASSETS_MANAGE, STORES_ASSETS_READ, appendUnitEvents, homeDepartmentOf, itemName, lastTag, regulationOf, storeInfos, unitState, unitStates,
} from "./assets";
import { StoresError } from "./errors";
import { raiseGatePassInTx } from "./gate-pass";
import type { UnitState } from "./assets";
import type {
  Actor, StoresCommitteeSeat, StoresCondemnationReason, StoresCondemnationStatus, WireAssetRemoval, WireCondemnation,
} from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S4b (#1114, decisions 13, 14, ruling 0101 Q5) — THE END OF A UNIT'S LIFE: condemnation, loss, disposal.
 *
 *   propose (the HOD or biomedical, a reason from the list; or the chaser, 30 days after a round did not see a unit;
 *   or the materials head resolving a tagged unit lost in transit)
 *     → each committee seat signs once, any order (the user department's HOD, accounts, the materials head, and
 *       biomedical for medical equipment). Seats are filled by role; one person never fills two seats. An objection
 *       stops it ("Objected"); the unit stays in use.
 *     → the last signature: the unit's books move to the `CONDEMNED` hold and the write-off is raised with the
 *       approval that exists today (`materials_stock_adjustment`, the medical superintendent), by the materials-head
 *       seat; above ₹50,000 or cost unknown the owner's approval is asked too. Nothing is destroyed yet.
 *     → both granted: "Condemned" (a loss: still "Missing"). A rejection returns the books to where they stood.
 *     → disposal (the materials head): scrap sale, buy-back or e-waste recycler posts the write-off (reason
 *       `condemned`) and raises the non-returnable gate pass; the guard's exit scan writes "Disposed". A loss posts the
 *       write-off with "lost" and the inquiry note's number, no pass: "Written off". `markFound` re-enters it through
 *       the opening path naming that write-off; nothing is edited.
 *
 * Status is DERIVED (signatures, steps, the two approvals), never stored. Every table here is append-only in the
 * database (migration 0243). Every act appends one `stores.act_recorded`; reading the approvals back (`settle`) is not
 * an act: the approver's decision is the kernel's own audited event, and the unit event it writes names the approver.
 */
export const STORES_ASSETS_CONDEMN = "stores.assets.condemn";
/** Ruling 0101 Q5: the owner also approves above this original cost, or when the cost is unknown (the PO-tier line). */
export const CONDEMN_OWNER_LINE_PAISE = 5_000_000;
/** Decision 14 (DECIDED on the ruled quote bands): one buyer up to ₹25,000 expected; three written bids above. */
export const SCRAP_ONE_BUYER_PAISE = 2_500_000;
/** … and the owner approves a sale above ₹5 lakh. */
export const SCRAP_OWNER_PAISE = 50_000_000;
/** Decision 12: a unit not seen 30 days after its round closed becomes a loss proposal. */
export const LOSS_AFTER_MS = 30 * 24 * 60 * 60_000;
const SEAT_ORDER: readonly StoresCommitteeSeat[] = ["hod", "accounts", "materials", "biomedical"];
/** Seats are filled by role (decision 13): the role key each seat is drawn from. */
export const SEAT_ROLE: Record<StoresCommitteeSeat, string> = {
  hod: "department_head", accounts: "accounts_officer", materials: "materials_head", biomedical: "biomedical_engineer",
};
const SYSTEM: Actor = { type: "system", id: "stores-loss-sweep" };
const WORDS = {
  toSign: ["Condemnation to sign", "नाकारा पर हस्ताक्षर करें"],
  notSeen: ["Asset not seen", "संपत्ति नहीं मिली"],
} as const;

type CondRow = typeof storesCondemnations.$inferSelect;
type SigRow = typeof storesCondemnationSignatures.$inferSelect;
type StepRow = typeof storesCondemnationSteps.$inferSelect;
type Disposal = typeof storesScrapSales.$inferSelect;
type Full = { row: CondRow; sigs: SigRow[]; steps: StepRow[]; sale: Disposal | null; ms: { approvalId: string; status: string } | null; owner: { approvalId: string; status: string } | null };

const clean = (s: string | null | undefined): string | null => (s == null || s.trim() === "" ? null : s.trim());

// ═══════════════════════════════ seats ═══════════════════════════════

/** The active users who may sit a seat: the seat's role (at the department for the HOD), whose role holds the condemn grant. */
export async function seatHolders(db: Db | Tx, seat: StoresCommitteeSeat, departmentId: string | null): Promise<string[]> {
  if (seat === "hod" && departmentId === null) return [];
  const rows = await (db as Db).selectDistinct({ u: roleAssignments.userId }).from(roleAssignments)
    .innerJoin(users, eq(users.id, roleAssignments.userId))
    .innerJoin(rolePermissions, and(eq(rolePermissions.roleKey, roleAssignments.roleKey), eq(rolePermissions.permission, STORES_ASSETS_CONDEMN)))
    .where(and(
      eq(roleAssignments.roleKey, SEAT_ROLE[seat]), eq(users.active, true),
      seat === "hod" ? and(eq(roleAssignments.scopeType, "department"), eq(roleAssignments.scopeId, departmentId!)) : eq(roleAssignments.scopeType, "hospital"),
    ));
  return rows.map((r) => r.u).sort();
}

/** The user department of a unit: its home shelf's, or (lost on its way) the department the ticket was for. */
async function userDepartmentOf(db: Db | Tx, s: UnitState): Promise<string | null> {
  const home = homeDepartmentOf(s, await storeInfos(db, s.events.map((e) => e.storeId).filter((x): x is string => x !== null)));
  if (home !== null) return home;
  if (s.place.kind === "transit" && s.placeEvent.refType === "transfer" && s.placeEvent.refId !== null) {
    const r = (await (db as Db).execute(sql`select to_resource_id from transfers where id = ${s.placeEvent.refId}`)).rows[0] as { to_resource_id: string } | undefined;
    if (r !== undefined) return (await storeInfos(db, [r.to_resource_id])).get(r.to_resource_id)?.departmentId ?? null;
  }
  return null;
}

/** Decision 13: HOD of the user department (when there is one), accounts, the materials head, and biomedical for medical equipment. */
async function seatsFor(db: Db | Tx, s: UnitState, departmentId: string | null): Promise<StoresCommitteeSeat[]> {
  const rules = await itemRules(db, s.unit.itemId);
  return SEAT_ORDER.filter((seat) => (seat === "hod" ? departmentId !== null : seat === "biomedical" ? rules.tagRule === "always" : true));
}

// ═══════════════════════════════ reading a proposal ═══════════════════════════════

async function loadAll(db: Db | Tx, rows: CondRow[]): Promise<Full[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const sigs = await (db as Db).select().from(storesCondemnationSignatures).where(inArray(storesCondemnationSignatures.condemnationId, ids))
    .orderBy(asc(storesCondemnationSignatures.at));
  const steps = await (db as Db).select().from(storesCondemnationSteps).where(inArray(storesCondemnationSteps.condemnationId, ids));
  const sales = await (db as Db).select().from(storesScrapSales).where(inArray(storesScrapSales.condemnationId, ids));
  const woIds = steps.map((s) => s.writeOffId).filter((x): x is string => x !== null);
  const wos = woIds.length === 0 ? [] : await (db as Db).select({ id: stockWriteOffs.id, approvalId: stockWriteOffs.approvalId }).from(stockWriteOffs).where(inArray(stockWriteOffs.id, woIds));
  const apIds = [...wos.map((w) => w.approvalId), ...steps.map((s) => s.ownerApprovalId).filter((x): x is string => x !== null)];
  const aps = new Map(apIds.length === 0 ? [] : (await (db as Db).select({ id: approvals.id, status: approvals.status }).from(approvals).where(inArray(approvals.id, apIds))).map((a) => [a.id, a.status] as const));
  return rows.map((row) => {
    const mySteps = steps.filter((s) => s.condemnationId === row.id);
    const raised = mySteps.find((s) => s.kind === "raised");
    const wo = wos.find((w) => w.id === raised?.writeOffId);
    return {
      row, sigs: sigs.filter((s) => s.condemnationId === row.id), steps: mySteps, sale: sales.find((s) => s.condemnationId === row.id) ?? null,
      ms: wo === undefined ? null : { approvalId: wo.approvalId, status: aps.get(wo.approvalId) ?? "pending" },
      owner: raised?.ownerApprovalId == null ? null : { approvalId: raised.ownerApprovalId, status: aps.get(raised.ownerApprovalId) ?? "pending" },
    };
  });
}

async function loadOne(db: Db | Tx, id: string): Promise<Full> {
  const [row] = await (db as Db).select().from(storesCondemnations).where(eq(storesCondemnations.id, id));
  if (row === undefined) throw new StoresError("unknown_condemnation", "no such condemnation", { id });
  return (await loadAll(db, [row]))[0]!;
}

function statusOfFull(f: Full): StoresCondemnationStatus {
  if (f.sigs.some((s) => s.kind === "object") || f.steps.some((s) => s.kind === "rejected")) return "objected";
  if (f.steps.some((s) => s.kind === "posted")) return f.row.kind === "loss" ? "written_off" : "disposed";
  if (f.steps.some((s) => s.kind === "approved")) return "approved";
  return "pending";
}

/** Still in play: not objected, not rejected, not posted (a posted condemnation is over too). */
function isOpen(f: Full): boolean {
  const st = statusOfFull(f);
  return st === "pending" || st === "approved";
}

/** The newest proposal of each unit that is still open (pending or approved). */
export async function openCondemnationOf(db: Db | Tx, unitId: string): Promise<Full | null> {
  const rows = await (db as Db).select().from(storesCondemnations).where(eq(storesCondemnations.unitId, unitId)).orderBy(desc(storesCondemnations.proposedAt));
  for (const f of await loadAll(db, rows)) if (isOpen(f)) return f;
  return null;
}

/** The newest proposal of a unit, open or closed, with its word (the passport's line). */
export async function latestCondemnation(db: Db | Tx, unitId: string): Promise<{ id: string; condNo: string; kind: "condemn" | "loss"; status: StoresCondemnationStatus } | null> {
  const rows = await (db as Db).select().from(storesCondemnations).where(eq(storesCondemnations.unitId, unitId)).orderBy(desc(storesCondemnations.proposedAt)).limit(1);
  const f = (await loadAll(db, rows))[0];
  return f === undefined ? null : { id: f.row.id, condNo: f.row.condNo, kind: f.row.kind as "condemn" | "loss", status: statusOfFull(f) };
}

async function namesOf(db: Db | Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const want = [...new Set(ids)].filter((x) => x !== "" && x !== SYSTEM.id);
  if (want.length === 0) return new Map();
  return new Map((await (db as Db).select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, want))).map((u) => [u.id, u.n] as const));
}

async function view(db: Db | Tx, actor: Actor, f: Full, now: Date): Promise<WireCondemnation> {
  const s = await unitState(db, f.row.unitId);
  const holders = new Map<StoresCommitteeSeat, string[]>();
  for (const seat of f.row.seats as StoresCommitteeSeat[]) holders.set(seat, await seatHolders(db, seat, f.row.departmentId));
  const names = await namesOf(db, [...f.sigs.map((x) => x.actorId), ...[...holders.values()].flat(), f.row.proposedBy]);
  const status = statusOfFull(f);
  const mySeat = (f.row.seats as StoresCommitteeSeat[]).find((seat) => (holders.get(seat) ?? []).includes(actor.id) && !f.sigs.some((x) => x.seat === seat));
  const acted = f.sigs.some((x) => x.actorId === actor.id);
  const raised = f.steps.some((x) => x.kind === "raised");
  const head = await holds(db, actor, STORES_MASTERS);
  const dept = s.place.departmentId === null ? null : (await storeInfos(db, [s.place.id])).get(s.place.id) ?? null;
  const reg = await regulationOf(db, s);
  const repairs12m = s.events.filter((e) => e.kind === "repair_opened" && now.getTime() - e.occurredAt.getTime() <= 365 * 24 * 60 * 60_000).length;
  const age = s.putToUse === null ? null : Math.max(0, Math.floor((Date.parse(istDayString(now)) - Date.parse(s.putToUse)) / (365.25 * 24 * 60 * 60_000)));
  let passId: string | null = null;
  if (f.sale !== null) {
    const [p] = await (db as Db).select({ id: storesGatePasses.id }).from(storesGatePasses)
      .where(and(inArray(storesGatePasses.refId, [f.sale.id, f.sale.writeOffId]), sql`not exists (select 1 from stores_gate_pass_scans s where s.pass_id = ${storesGatePasses.id} and s.kind = 'close')`)).limit(1);
    passId = p?.id ?? null;
  }
  const buyer = f.sale === null ? null : (await (db as Db).select({ n: vendors.legalName }).from(vendors).where(eq(vendors.id, f.sale.buyerId)))[0]?.n ?? "";
  const out: WireCondemnation = {
    id: f.row.id, condNo: f.row.condNo, kind: f.row.kind as "condemn" | "loss", reason: f.row.reason as StoresCondemnationReason, note: f.row.note,
    unit: {
      id: s.unit.id, tagNo: lastTag(s), last4: lastTag(s).slice(-4), name: await itemName(db, s.unit.itemId), place: s.place.name,
      department: dept?.departmentId == null ? null : (await (db as Db).execute(sql`select name from org_departments where id = ${dept.departmentId}`)).rows.map((r) => (r as { name: string }).name)[0] ?? null,
    },
    status, ageYears: age, repairs12m, holdsData: f.row.holdsData, regulatedBy: reg.regulatedBy, regulatorPaper: reg.paper,
    seats: (f.row.seats as StoresCommitteeSeat[]).map((seat) => {
      const sig = f.sigs.find((x) => x.seat === seat);
      return {
        seat, holders: (holders.get(seat) ?? []).map((u) => names.get(u) ?? u),
        signed: sig === undefined ? null : { by: names.get(sig.actorId) ?? sig.actorId, at: sig.at.toISOString(), kind: sig.kind as "sign" | "object", reason: sig.reason },
      };
    }),
    needsOwner: f.row.needsOwner, approvals: { ms: f.ms, owner: f.owner }, writeOffId: f.steps.find((x) => x.kind === "raised")?.writeOffId ?? null,
    disposal: f.sale === null ? null : { method: f.sale.method as "scrap_sale" | "buy_back" | "e_waste", amountPaise: f.sale.amountPaise, invoiceNo: f.sale.invoiceNo, buyer: buyer ?? "", passId },
    proposedBy: { id: f.row.proposedBy, name: names.get(f.row.proposedBy) ?? "" }, proposedAt: f.row.proposedAt.toISOString(),
    can: {
      sign: status === "pending" && !raised && !acted && mySeat !== undefined,
      object: status === "pending" && !raised && !acted && mySeat !== undefined,
      dispose: status === "approved" && f.row.kind === "condemn" && head,
      writeOff: status === "approved" && f.row.kind === "loss" && head,
    },
  };
  if ((await holds(db, actor, STORES_ASSETS_READ)) || (await holds(db, actor, STORES_ASSETS_CONDEMN))) out.costPaise = f.row.costPaise;
  return out;
}

async function mayRead(db: Db | Tx, actor: Actor, f: Full): Promise<boolean> {
  if ((await holds(db, actor, STORES_ASSETS_READ)) || (await holds(db, actor, STORES_ASSETS_MANAGE)) || (await holds(db, actor, STORES_MASTERS))) return true;
  for (const seat of f.row.seats as StoresCommitteeSeat[]) if ((await seatHolders(db, seat, f.row.departmentId)).includes(actor.id)) return true;
  return false;
}

/** One proposal, its approvals read back first. */
export async function getCondemnation(db: Db, actor: Actor, id: string, now: Date = new Date()): Promise<WireCondemnation> {
  await settleCondemnations(db, now, [id]);
  const f = await loadOne(db, id);
  if (!(await mayRead(db, actor, f))) throw new StoresError("not_permitted", "No permission", { permission: STORES_ASSETS_CONDEMN });
  return view(db, actor, f, now);
}

/** `/stores/assets` Condemnation tab: every proposal the reader may see, open ones first, newest first. */
export async function listCondemnations(db: Db, actor: Actor, now: Date = new Date()): Promise<{ rows: WireCondemnation[] }> {
  await settleCondemnations(db, now);
  const rows = await db.select().from(storesCondemnations).orderBy(desc(storesCondemnations.proposedAt)).limit(200);
  const out: WireCondemnation[] = [];
  for (const f of await loadAll(db, rows)) if (await mayRead(db, actor, f)) out.push(await view(db, actor, f, now));
  const rank: Record<StoresCondemnationStatus, number> = { pending: 0, approved: 1, objected: 2, disposed: 3, written_off: 3 };
  return { rows: out.sort((a, b) => rank[a.status] - rank[b.status] || b.proposedAt.localeCompare(a.proposedAt)) };
}

/** The signer's card: proposals with a seat this person may still sign. */
export async function condemnationsToSign(db: Db, actor: Actor, now: Date = new Date()): Promise<WireCondemnation[]> {
  if (actor.type !== "user") return [];
  const rows = await db.select().from(storesCondemnations).orderBy(asc(storesCondemnations.proposedAt)).limit(500);
  const out: WireCondemnation[] = [];
  for (const f of await loadAll(db, rows)) {
    if (statusOfFull(f) !== "pending" || f.steps.some((s) => s.kind === "raised") || f.sigs.some((s) => s.actorId === actor.id)) continue;
    let mine = false;
    for (const seat of f.row.seats as StoresCommitteeSeat[]) {
      if (!f.sigs.some((s) => s.seat === seat) && (await seatHolders(db, seat, f.row.departmentId)).includes(actor.id)) { mine = true; break; }
    }
    if (mine) out.push(await view(db, actor, f, now));
  }
  return out;
}

// ═══════════════════════════════ propose ═══════════════════════════════

async function nextCondNo(tx: Tx, now: Date): Promise<string> {
  const month = `${istDayString(now).slice(0, 7)}-01`;
  await (tx as Db).insert(episodeSeries).values({ seriesKey: "asset_condemnation", serviceDate: month, nextNo: 1 }).onConflictDoNothing();
  const rows = await (tx as Db).update(episodeSeries).set({ nextNo: sql`${episodeSeries.nextNo} + 1` })
    .where(and(eq(episodeSeries.seriesKey, "asset_condemnation"), eq(episodeSeries.serviceDate, month))).returning({ n: episodeSeries.nextNo });
  return `CDN${month.slice(2, 4)}${month.slice(5, 7)}${String(rows[0]!.n - 1).padStart(4, "0")}`;
}

async function topCategoryCode(db: Db | Tx, itemId: string): Promise<string> {
  const r = (await (db as Db).execute(sql`select coalesce(p.code, c.code, '') as code from items i left join item_categories c on c.id = i.category_id
    left join item_categories p on p.id = c.parent_id where i.id = ${itemId}`)).rows[0] as { code: string } | undefined;
  return (r?.code ?? "").toUpperCase();
}

/** Writes one proposal in the caller's transaction (the checks of who may propose are the caller's). */
async function proposeInTx(
  tx: Tx, actor: Actor, s: UnitState, input: { reason: StoresCondemnationReason; note: string | null; holdsData?: boolean; replacesId?: string | null; roundId?: string | null },
  now: Date,
): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-condemn:${s.unit.id}`}))`);
  if (s.ended !== null) throw new StoresError("unit_ended", "this unit is no longer in service");
  if (s.place.kind === "out_on_pass" || s.pendingTransfer !== null) throw new StoresError("unit_not_here", "bring the unit back before it is condemned");
  if (s.place.kind === "condemned") throw new StoresError("already_proposed", "this unit is already before the committee");
  const open = await openCondemnationOf(tx, s.unit.id);
  if (open !== null) throw new StoresError("already_proposed", "this unit is already before the committee", { condemnationId: open.row.id, condNo: open.row.condNo });
  const departmentId = await userDepartmentOf(tx, s);
  const seats = await seatsFor(tx, s, departmentId);
  for (const seat of seats) {
    if ((await seatHolders(tx, seat, departmentId)).length === 0) throw new StoresError("committee_seat_empty", `No ${seat} member yet`, { seat });
  }
  const cost = (s.corrected.unitCostPaise as number | undefined) ?? s.unit.unitCostPaise;
  const kind = input.reason === "lost" ? "loss" : "condemn";
  const id = newId();
  const condNo = await nextCondNo(tx, now);
  const holdsData = input.holdsData ?? (await topCategoryCode(tx, s.unit.itemId)) === "ITP";
  await tx.insert(storesCondemnations).values({
    id, condNo, unitId: s.unit.id, kind, reason: input.reason, note: input.note, departmentId, seats, holdsData, costPaise: cost,
    needsOwner: cost === null || cost > CONDEMN_OWNER_LINE_PAISE, replacesId: input.replacesId ?? null, roundId: input.roundId ?? null,
    proposedBy: actor.id, proposedAt: now,
  });
  await appendUnitEvents(tx, actor, now, [{
    unitId: s.unit.id, kind: kind === "loss" ? "loss_proposed" : "condemn_proposed", refType: "condemnation", refId: id,
    data: { condNo, reason: input.reason, note: input.note },
  }]);
  await recordAct(tx, actor, now, {
    act: kind === "loss" ? "propose_loss" : "propose_condemnation", storeId: s.place.id, itemId: s.unit.itemId, refId: s.unit.id, reason: input.note,
    after: { condemnationId: id, condNo, reason: input.reason, seats, needsOwner: cost === null || cost > CONDEMN_OWNER_LINE_PAISE, replacesId: input.replacesId ?? null },
  });
  const name = await itemName(tx, s.unit.itemId);
  const words = kind === "loss" ? WORDS.notSeen : WORDS.toSign;
  for (const seat of seats) {
    for (const u of await seatHolders(tx, seat, departmentId)) {
      if (u === actor.id) continue;
      await raiseNotice(tx as unknown as Db, {
        userId: u, kind: "stores.asset", title: words[0], body: `${words[1]} · ${name} · ${lastTag(s).slice(-4)}`,
        refType: "stores_condemnation", refId: id, sourceKey: `stores-condemn:${id}:${u}`, at: now,
      });
    }
  }
  return id;
}

/**
 * Decision 13: the HOD of the unit's department or biomedical (or the materials head) proposes, with a reason from the
 * list. Refused while a seat has no holder (`committee_seat_empty`, naming the seat). A fresh proposal after an
 * objection is a new row naming the old one.
 */
export async function proposeCondemnation(
  db: Db, actor: Actor, input: { unitId: string; reason: StoresCondemnationReason; note?: string | null; holdsData?: boolean; replacesId?: string | null },
  now: Date = new Date(),
): Promise<WireCondemnation> {
  if (!["beyond_repair", "obsolete", "damaged", "lost"].includes(input.reason)) throw new StoresError("bad_quantity", "a reason from the list");
  const id = await withTx(db, async (tx) => {
    const s = await unitState(tx, input.unitId);
    const dept = await userDepartmentOf(tx, s);
    const may = (await holds(tx, actor, STORES_ASSETS_MANAGE)) || (dept !== null && (await seatHolders(tx, "hod", dept)).includes(actor.id));
    if (!may) throw new StoresError("not_permitted", "the HOD or biomedical proposes", { permission: STORES_ASSETS_CONDEMN });
    return proposeInTx(tx, actor, s, { reason: input.reason, note: clean(input.note), holdsData: input.holdsData, replacesId: input.replacesId ?? null }, now);
  });
  return view(db, actor, await loadOne(db, id), now);
}

/** S4a's lost short of a tagged unit routes here (custody `resolveShort`): one loss proposal per unit, by the materials head. */
export async function proposeLossInTx(tx: Tx, actor: Actor, unitId: string, note: string | null, now: Date): Promise<string> {
  return proposeInTx(tx, actor, await unitState(tx, unitId), { reason: "lost", note }, now);
}

// ═══════════════════════════════ sign, object ═══════════════════════════════

async function requireSeat(tx: Tx, actor: Actor, f: Full): Promise<StoresCommitteeSeat> {
  if (f.sigs.some((s) => s.actorId === actor.id)) throw new StoresError("already_signed", "Already signed");
  if (statusOfFull(f) !== "pending" || f.steps.some((s) => s.kind === "raised")) throw new StoresError("condemnation_closed", "this proposal is no longer open for signatures");
  for (const seat of f.row.seats as StoresCommitteeSeat[]) {
    if (f.sigs.some((s) => s.seat === seat)) continue;
    if ((await seatHolders(tx, seat, f.row.departmentId)).includes(actor.id)) return seat;
  }
  throw new StoresError("not_a_seat", "you hold no open seat on this proposal", { permission: STORES_ASSETS_CONDEMN });
}

/** Every seat signed: the books move to the CONDEMNED hold, the write-off is raised and the owner asked (above the line). */
async function raiseAfterSeats(tx: Tx, f: Full, now: Date): Promise<{ writeOffId: string; ownerApprovalId: string | null }> {
  const s = await unitState(tx, f.row.unitId);
  const materialsSig = f.sigs.find((x) => x.seat === "materials");
  const raiser: Actor = { type: "user", id: materialsSig!.actorId };
  const hold = await ensureCondemnedStore(tx);
  const fromTransit = s.place.code === TRANSIT_STORE_CODE && s.placeEvent.refType === "transfer" ? s.placeEvent.refId : null;
  await postMovements(tx, raiser, [
    { resourceId: s.place.id, batchId: s.unit.batchId, qtyDelta: -1, reason: "issue", refType: fromTransit === null ? "stores_condemnation" : "transfer", refId: fromTransit ?? f.row.id, occurredAt: now },
    { resourceId: hold, batchId: s.unit.batchId, qtyDelta: 1, reason: "receive", refType: "stores_condemnation", refId: f.row.id, occurredAt: now },
  ]);
  await appendUnitEvents(tx, raiser, now, [{
    unitId: s.unit.id, kind: "moved", storeId: hold, refType: "condemnation", refId: f.row.id, data: { hold: f.row.kind === "loss" ? "loss" : "condemned", fromStoreId: s.place.id },
  }]);
  const wo = await raiseWriteOff(tx as unknown as Db, raiser, {
    storeResourceId: hold, reason: "condemned", lines: [{ batchId: s.unit.batchId, qtyBase: 1 }],
    note: `${f.row.condNo} · ${lastTag(s)} · ${f.row.reason}`,
  }, now);
  let ownerApprovalId: string | null = null;
  if (f.row.needsOwner) {
    ({ approvalId: ownerApprovalId } = await requestApproval(tx, raiser, {
      typeKey: CONDEMNATION_OWNER_APPROVAL_TYPE, subject: { type: "stores_condemnation", id: f.row.id },
      requestNote: `${f.row.condNo} · ${await itemName(tx, s.unit.itemId)} ${lastTag(s).slice(-4)} · ${f.row.reason} · cost ${f.row.costPaise === null ? "unknown" : `₹${(f.row.costPaise / 100).toFixed(2)}`}`,
    }));
  }
  await tx.insert(storesCondemnationSteps).values({
    id: newId(), condemnationId: f.row.id, kind: "raised", writeOffId: wo.id, ownerApprovalId, actorId: raiser.id, at: now,
    data: { fromStoreId: s.place.id, transferId: fromTransit, placeRefType: s.placeEvent.refType, placeRefId: s.placeEvent.refId },
  });
  return { writeOffId: wo.id, ownerApprovalId };
}

/** One seat's signature. The holder of two seats signs once (one person never fills two seats on one proposal). */
export async function signCondemnation(db: Db, actor: Actor, id: string, now: Date = new Date()): Promise<WireCondemnation> {
  await withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-condemn-sign:${id}`}))`);
    const f = await loadOne(tx, id);
    const seat = await requireSeat(tx, actor, f);
    await tx.insert(storesCondemnationSignatures).values({ id: newId(), condemnationId: id, seat, kind: "sign", actorId: actor.id, reason: null, at: now });
    const after = await loadOne(tx, id);
    const all = (after.row.seats as StoresCommitteeSeat[]).every((x) => after.sigs.some((g) => g.seat === x && g.kind === "sign"));
    const raised = all ? await raiseAfterSeats(tx, after, now) : null;
    await appendUnitEvents(tx, actor, now, [{ unitId: f.row.unitId, kind: "condemn_signed", refType: "condemnation", refId: id, data: { seat, condNo: f.row.condNo } }]);
    const s = await unitState(tx, f.row.unitId);
    await recordAct(tx, actor, now, {
      act: "sign_condemnation", storeId: s.place.id, itemId: s.unit.itemId, refId: f.row.unitId,
      after: { condemnationId: id, condNo: f.row.condNo, seat, ...(raised === null ? {} : { raised }) },
    });
  });
  return view(db, actor, await loadOne(db, id), now);
}

/** Any seat may object, with a reason: "Objected". The unit stays in use; a fresh proposal is a new row. */
export async function objectCondemnation(db: Db, actor: Actor, id: string, input: { reason: string }, now: Date = new Date()): Promise<WireCondemnation> {
  const reason = clean(input.reason);
  if (reason === null) throw new StoresError("reason_required", "say why");
  await withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-condemn-sign:${id}`}))`);
    const f = await loadOne(tx, id);
    const seat = await requireSeat(tx, actor, f);
    await tx.insert(storesCondemnationSignatures).values({ id: newId(), condemnationId: id, seat, kind: "object", actorId: actor.id, reason, at: now });
    await appendUnitEvents(tx, actor, now, [{ unitId: f.row.unitId, kind: "condemn_objected", refType: "condemnation", refId: id, data: { seat, reason, condNo: f.row.condNo } }]);
    const s = await unitState(tx, f.row.unitId);
    await recordAct(tx, actor, now, { act: "object_condemnation", storeId: s.place.id, itemId: s.unit.itemId, refId: f.row.unitId, reason, after: { condemnationId: id, seat } });
  });
  return view(db, actor, await loadOne(db, id), now);
}

// ═══════════════════════════════ settle: the approvals read back ═══════════════════════════════

/**
 * For every raised proposal not yet settled: both approvals granted → `approved` (a condemnation's unit reads
 * "Condemned"); either rejected → `rejected` ("Objected"), and the unit's books go back to where they stood. Idempotent
 * (one step per kind; advisory lock). Not an act: the decision is the approver's, and the unit event names them.
 */
export async function settleCondemnations(db: Db, now: Date = new Date(), ids?: readonly string[]): Promise<number> {
  const raised = await db.select({ id: storesCondemnationSteps.condemnationId }).from(storesCondemnationSteps)
    .where(and(eq(storesCondemnationSteps.kind, "raised"), ...(ids === undefined ? [] : [inArray(storesCondemnationSteps.condemnationId, [...ids])]),
      sql`not exists (select 1 from stores_condemnation_steps x where x.condemnation_id = ${storesCondemnationSteps.condemnationId} and x.kind in ('approved', 'rejected'))`));
  let moved = 0;
  for (const { id } of raised) {
    const f = await loadOne(db, id);
    const statuses = [f.ms?.status ?? "pending", ...(f.owner === null ? [] : [f.owner.status])];
    const rejected = statuses.includes("rejected");
    if (!rejected && !statuses.every((x) => x === "granted")) continue;
    await withTx(db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-condemn-settle:${id}`}))`);
      const done = await tx.select({ id: storesCondemnationSteps.id }).from(storesCondemnationSteps)
        .where(and(eq(storesCondemnationSteps.condemnationId, id), inArray(storesCondemnationSteps.kind, ["approved", "rejected"])));
      if (done.length > 0) return;
      const apIds = [f.ms?.approvalId, f.owner?.approvalId].filter((x): x is string => typeof x === "string");
      const decided = await tx.select({ id: approvals.id, by: approvals.decidedBy, note: approvals.decisionNote, status: approvals.status, at: approvals.decidedAt })
        .from(approvals).where(inArray(approvals.id, apIds));
      const decider = (rejected ? decided.find((d) => d.status === "rejected") : [...decided].sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0)).at(-1));
      const by: Actor = { type: "user", id: decider?.by ?? "unknown" };
      await tx.insert(storesCondemnationSteps).values({ id: newId(), condemnationId: id, kind: rejected ? "rejected" : "approved", writeOffId: null, ownerApprovalId: null, actorId: by.id, at: now, data: { note: decider?.note ?? null } });
      const s = await unitState(tx, f.row.unitId);
      if (rejected) {
        const step = f.steps.find((x) => x.kind === "raised")!;
        const d = step.data as { fromStoreId: string; transferId: string | null; placeRefType: string | null; placeRefId: string | null };
        await postMovements(tx, by, [
          { resourceId: s.place.id, batchId: s.unit.batchId, qtyDelta: -1, reason: "issue", refType: "stores_condemnation", refId: id, occurredAt: now },
          { resourceId: d.fromStoreId, batchId: s.unit.batchId, qtyDelta: 1, reason: "receive", refType: d.transferId === null ? "stores_condemnation" : "transfer", refId: d.transferId ?? id, occurredAt: now },
        ]);
        await appendUnitEvents(tx, by, now, [
          { unitId: s.unit.id, kind: "condemn_objected", refType: "condemnation", refId: id, data: { approval: "rejected", reason: decider?.note ?? null, condNo: f.row.condNo } },
          { unitId: s.unit.id, kind: "moved", storeId: d.fromStoreId, refType: d.placeRefType ?? "condemnation", refId: d.placeRefId ?? id, data: { back: true } },
        ]);
      } else if (f.row.kind === "condemn") {
        await appendUnitEvents(tx, by, now, [{ unitId: s.unit.id, kind: "condemned", refType: "condemnation", refId: id, data: { condNo: f.row.condNo } }]);
      }
      moved += 1;
    });
  }
  return moved;
}

/** Settle the open proposal of one unit (the passport's read). */
export async function settleUnit(db: Db, unitId: string, now: Date): Promise<void> {
  const ids = (await db.select({ id: storesCondemnations.id }).from(storesCondemnations).where(eq(storesCondemnations.unitId, unitId))).map((r) => r.id);
  if (ids.length > 0) await settleCondemnations(db, now, ids);
}

// ═══════════════════════════════ disposal (decision 14) ═══════════════════════════════

export type DisposeInput = {
  method: "scrap_sale" | "buy_back" | "e_waste"; buyerId: string; amountPaise: number; invoiceNo: string; receiptRef?: string | null; poRef?: string | null;
  certificateNo?: string | null; wipeCertificateNo?: string | null; bids?: { vendorId: string; amountPaise: number }[];
};

async function requireApproved(db: Db, id: string, kind: "condemn" | "loss", now: Date): Promise<Full> {
  await settleCondemnations(db, now, [id]);
  const f = await loadOne(db, id);
  const st = statusOfFull(f);
  if (f.row.kind !== kind) throw new StoresError("condemnation_closed", kind === "loss" ? "this is a condemnation: dispose of it" : "this is a loss: write it off");
  if (st === "objected" || st === "disposed" || st === "written_off") throw new StoresError("condemnation_closed", "this proposal is closed", { status: st });
  if (st !== "approved") throw new StoresError("not_approved", "waiting for the committee and the approvals", { ms: f.ms?.status ?? null, owner: f.owner?.status ?? null });
  return f;
}

/**
 * The materials head disposes of a condemned unit: scrap sale (one buyer up to ₹25,000; three written bids above, the
 * highest wins; the owner's approval above ₹5 lakh), buy-back (the purchase order) or an authorised e-waste recycler
 * (its certificate). A unit that held data needs the wipe certificate; a regulated unit the regulator's paper. Posts
 * the write-off (reason `condemned`: the buyer or recycler is the agency, the invoice or certificate the manifest, today
 * the date) and raises the non-returnable gate pass in the same transaction. HMIS computes no GST or TCS on the sale.
 */
export async function disposeUnit(db: Db, actor: Actor, id: string, input: DisposeInput, now: Date = new Date()): Promise<{ condemnation: WireCondemnation; saleId: string; passId: string | null; writeOffId: string }> {
  if (!(await holds(db, actor, STORES_MASTERS))) throw new StoresError("not_permitted", "the materials head disposes", { permission: STORES_MASTERS });
  const f = await requireApproved(db, id, "condemn", now);
  const s = await unitState(db, f.row.unitId);
  const reg = await regulationOf(db, s);
  if (reg.regulatedBy !== null && !reg.paper) throw new StoresError("regulator_paper_needed", "Regulator paper needed", { regulatedBy: reg.regulatedBy });
  if (f.row.holdsData && clean(input.wipeCertificateNo) === null) throw new StoresError("wipe_certificate_needed", "Wipe certificate needed");
  if (!["scrap_sale", "buy_back", "e_waste"].includes(input.method)) throw new StoresError("bad_quantity", "scrap sale, buy-back or e-waste");
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < 0) throw new StoresError("bad_quantity", "an amount is paise, zero or more");
  const invoiceNo = clean(input.invoiceNo);
  if (invoiceNo === null) throw new StoresError("ref_required", "the sale invoice or the recycler's number");
  const [buyer] = await db.select({ id: vendors.id, name: vendors.legalName }).from(vendors).where(eq(vendors.id, input.buyerId));
  if (buyer === undefined) throw new StoresError("unknown_supplier", "choose the buyer from the list");
  const bids = (input.bids ?? []).filter((b) => b.vendorId !== "");
  if (input.method === "scrap_sale") {
    if (input.amountPaise > SCRAP_ONE_BUYER_PAISE) {
      const distinct = new Set(bids.map((b) => b.vendorId));
      const top = [...bids].sort((a, b) => b.amountPaise - a.amountPaise)[0];
      if (distinct.size < 3 || top === undefined || top.vendorId !== input.buyerId || top.amountPaise !== input.amountPaise) {
        throw new StoresError("bids_required", "above ₹25,000: three written bids, the highest wins");
      }
    }
    if (input.amountPaise > SCRAP_OWNER_PAISE && !(f.row.needsOwner && f.owner?.status === "granted")) {
      throw new StoresError("not_approved", "above ₹5 lakh the owner approves the sale");
    }
  }
  if (input.method === "buy_back" && clean(input.poRef) === null) throw new StoresError("ref_required", "the purchase order of the new unit");
  if (input.method === "e_waste" && clean(input.certificateNo) === null) throw new StoresError("ref_required", "the authorised recycler's certificate");
  const writeOffId = f.steps.find((x) => x.kind === "raised")!.writeOffId!;
  const raisePass = await holds(db, actor, STORES_GATEPASS_RAISE);
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-condemn-post:${id}`}))`);
    if ((await tx.select({ id: storesScrapSales.id }).from(storesScrapSales).where(eq(storesScrapSales.condemnationId, id))).length > 0) {
      throw new StoresError("condemnation_closed", "already disposed");
    }
    const manifest = input.method === "e_waste" ? clean(input.certificateNo)! : invoiceNo;
    await postWriteOff(tx as unknown as Db, actor, writeOffId, { disposalAgency: buyer.name, manifestNo: manifest, disposalDate: istDayString(now) }, now);
    const saleId = newId();
    await tx.insert(storesScrapSales).values({
      id: saleId, condemnationId: id, unitId: s.unit.id, method: input.method, buyerId: buyer.id, amountPaise: input.amountPaise, invoiceNo,
      receiptRef: clean(input.receiptRef), bids, poRef: clean(input.poRef), certificateNo: clean(input.certificateNo), wipeCertificateNo: clean(input.wipeCertificateNo),
      writeOffId, recordedBy: actor.id, at: now,
    });
    await tx.insert(storesCondemnationSteps).values({ id: newId(), condemnationId: id, kind: "posted", writeOffId, ownerApprovalId: null, actorId: actor.id, at: now, data: { saleId } });
    let passId: string | null = null;
    let passNo: string | null = null;
    if (raisePass) {
      const pass = await raiseGatePassInTx(tx, actor, {
        kind: "non_returnable", refType: input.method === "e_waste" ? "write_off" : "scrap_sale", refId: input.method === "e_waste" ? writeOffId : saleId,
        note: f.row.condNo,
      }, now, { quiet: true });
      passId = pass.id;
      passNo = pass.passNo;
    }
    await recordAct(tx, actor, now, {
      act: "dispose_unit", storeId: s.place.id, itemId: s.unit.itemId, refId: s.unit.id,
      after: { condemnationId: id, condNo: f.row.condNo, method: input.method, buyer: buyer.name, amountPaise: input.amountPaise, invoiceNo, writeOffId, saleId, passId, passNo },
    });
    return { condemnation: await view(tx, actor, await loadOne(tx, id), now), saleId, passId, writeOffId };
  });
}

/** A loss after the seats and approvals: the write-off posts with "lost" and the inquiry note's (or police report's) number. No pass. */
export async function writeOffLoss(db: Db, actor: Actor, id: string, input: { inquiryNo: string }, now: Date = new Date()): Promise<WireCondemnation> {
  if (!(await holds(db, actor, STORES_MASTERS))) throw new StoresError("not_permitted", "the materials head writes off a loss", { permission: STORES_MASTERS });
  const inquiryNo = clean(input.inquiryNo);
  if (inquiryNo === null) throw new StoresError("ref_required", "the inquiry note's number");
  const f = await requireApproved(db, id, "loss", now);
  const writeOffId = f.steps.find((x) => x.kind === "raised")!.writeOffId!;
  await withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-condemn-post:${id}`}))`);
    if ((await tx.select({ id: storesCondemnationSteps.id }).from(storesCondemnationSteps).where(and(eq(storesCondemnationSteps.condemnationId, id), eq(storesCondemnationSteps.kind, "posted")))).length > 0) {
      throw new StoresError("condemnation_closed", "already written off");
    }
    await postWriteOff(tx as unknown as Db, actor, writeOffId, { disposalAgency: "lost", manifestNo: inquiryNo, disposalDate: istDayString(now) }, now);
    await tx.insert(storesCondemnationSteps).values({ id: newId(), condemnationId: id, kind: "posted", writeOffId, ownerApprovalId: null, actorId: actor.id, at: now, data: { inquiryNo } });
    await appendUnitEvents(tx, actor, now, [{ unitId: f.row.unitId, kind: "written_off", refType: "write_off", refId: writeOffId, data: { condNo: f.row.condNo, inquiryNo } }]);
    const s = await unitState(tx, f.row.unitId);
    await recordAct(tx, actor, now, { act: "write_off_loss", storeId: s.place.id, itemId: s.unit.itemId, refId: f.row.unitId, after: { condemnationId: id, writeOffId, inquiryNo } });
  });
  return view(db, actor, await loadOne(db, id), now);
}

/**
 * A written-off unit found later comes back by an event, never by editing the write-off: `found` at the place it was
 * found, and one opening ledger row there on its own batch naming the write-off (`ref_type = 'opening_balance'`).
 */
export async function markFound(db: Db, actor: Actor, unitId: string, input: { storeId: string }, now: Date = new Date()): Promise<{ unitId: string }> {
  if (!(await holds(db, actor, STORES_MASTERS)) && !(await holds(db, actor, STORES_ASSETS_MANAGE))) {
    throw new StoresError("not_permitted", "the materials head or biomedical", { permission: STORES_ASSETS_MANAGE });
  }
  const store = await requireStoresStore(db, input.storeId);
  await withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-condemn:${unitId}`}))`);
    const s = await unitState(tx, unitId);
    if (s.ended !== "written_off") throw new StoresError("not_written_off", "only a written-off unit is found again");
    const lastOff = [...s.events].reverse().find((e) => e.kind === "written_off")!;
    const writeOffId = lastOff.refId!;
    await postMovements(tx, actor, [{ resourceId: store.id, batchId: s.unit.batchId, qtyDelta: 1, reason: "adjust", refType: OPENING_BALANCE_REF_TYPE, refId: writeOffId, occurredAt: now }]);
    await appendUnitEvents(tx, actor, now, [{ unitId, kind: "found", storeId: store.id, refType: "write_off", refId: writeOffId, data: {} }]);
    await recordAct(tx, actor, now, { act: "mark_found", storeId: store.id, itemId: s.unit.itemId, refId: unitId, after: { writeOffId } });
  });
  return { unitId };
}

// ═══════════════════════════════ loss after a round (decision 12) ═══════════════════════════════

/**
 * Ridden by the chaser: each unit a closed round did not see, still unseen 30 days after the close, and with no open
 * proposal, becomes ONE loss proposal (`loss_proposed`) for the committee. Nothing is written off by itself; no ledger
 * row. A seat with no holder skips the unit (the card waits until the seat is filled).
 */
export async function runLossProposals(db: Db, now: Date = new Date()): Promise<number> {
  const rows = (await db.execute(sql`
    select distinct on (v.department_id) v.round_id, v.department_id, v.at, v.result from stores_asset_verifications v
     where v.kind = 'close' order by v.department_id, v.at desc`)).rows as { round_id: string; at: Date | string; result: { notSeen?: { unitId: string }[] } | null }[];
  let made = 0;
  for (const r of rows) {
    const closedAt = new Date(r.at);
    if (now.getTime() - closedAt.getTime() < LOSS_AFTER_MS) continue;
    const ids = (r.result?.notSeen ?? []).map((n) => n.unitId);
    if (ids.length === 0) continue;
    const since = await db.select({ unitId: storesAssetUnitEvents.unitId }).from(storesAssetUnitEvents)
      .where(and(inArray(storesAssetUnitEvents.unitId, ids), sql`${storesAssetUnitEvents.recordedAt} > ${closedAt}`,
        sql`(${storesAssetUnitEvents.kind} in ('verified_seen', 'seen_elsewhere', 'found', 'loss_proposed') or ${storesAssetUnitEvents.storeId} is not null)`));
    const skip = new Set(since.map((x) => x.unitId));
    for (const unitId of ids.filter((u) => !skip.has(u))) {
      try {
        await withTx(db, async (tx) => {
          const s = await unitState(tx, unitId);
          if (s.ended !== null || (await openCondemnationOf(tx, unitId)) !== null) return;
          await proposeInTx(tx, SYSTEM, s, { reason: "lost", note: null, roundId: r.round_id }, now);
          made += 1;
        });
      } catch (e) {
        if (!(e instanceof StoresError)) throw e;
      }
    }
  }
  return made;
}

// ═══════════════════════════════ removals for Tally (decision 15) ═══════════════════════════════

const REMOVAL_HEAD = ["Tag", "Item", "Category", "Condemnation", "Reason", "Method", "Amount (paise)", "Invoice", "Removed on", "Cost (paise)"];

/** Every unit removed from the books in the IST month (a disposal or a loss written off), with its condemnation and the sale amount. One audit event. */
export async function assetRemovals(db: Db, actor: Actor, month: string, now: Date = new Date()): Promise<{ month: string; rows: WireAssetRemoval[]; csv: string }> {
  if (!(await holds(db, actor, "stores.assets.export"))) throw new StoresError("not_permitted", "No permission", { permission: "stores.assets.export" });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new StoresError("bad_window", "a month is YYYY-MM");
  const posted = await db.select().from(storesCondemnationSteps).where(eq(storesCondemnationSteps.kind, "posted"));
  const inMonth = posted.filter((p) => istDayString(p.at).startsWith(month));
  const fulls = await loadAll(db, inMonth.length === 0 ? [] : await db.select().from(storesCondemnations).where(inArray(storesCondemnations.id, inMonth.map((p) => p.condemnationId))));
  const states = await unitStates(db, fulls.map((f) => f.row.unitId));
  const rows: WireAssetRemoval[] = [];
  for (const f of fulls) {
    const s = states.get(f.row.unitId)!;
    const p = inMonth.find((x) => x.condemnationId === f.row.id)!;
    const cat = (await db.execute(sql`select coalesce(pc.name, c.name, '') as name from items i left join item_categories c on c.id = i.category_id
      left join item_categories pc on pc.id = c.parent_id where i.id = ${s.unit.itemId}`)).rows[0] as { name: string } | undefined;
    rows.push({
      unitId: s.unit.id, tagNo: lastTag(s), name: (await db.select({ n: items.name }).from(items).where(eq(items.id, s.unit.itemId)))[0]?.n ?? "", category: cat?.name ?? "",
      condemnationNo: f.row.condNo, reason: f.row.reason as StoresCondemnationReason, method: f.sale === null ? "lost" : (f.sale.method as WireAssetRemoval["method"]),
      amountPaise: f.sale?.amountPaise ?? 0, invoiceNo: f.sale?.invoiceNo ?? ((p.data as { inquiryNo?: string }).inquiryNo ?? null), on: istDayString(p.at),
      costPaise: f.row.costPaise,
    });
  }
  rows.sort((a, b) => a.on.localeCompare(b.on) || a.tagNo.localeCompare(b.tagNo));
  const cell = (v: unknown): string => {
    const raw = v === null || v === undefined ? "" : String(v);
    const t = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = [REMOVAL_HEAD.join(","), ...rows.map((r) => [r.tagNo, r.name, r.category, r.condemnationNo, r.reason, r.method, r.amountPaise, r.invoiceNo, r.on, r.costPaise].map(cell).join(","))].join("\n");
  await withTx(db, (tx) => recordAct(tx, actor, now, { act: "asset_export", after: { kind: "removals", month, rows: rows.length } }));
  return { month, rows, csv };
}

/** The disposal form's buyer list: active suppliers (a scrap buyer or recycler is registered as a supplier first). */
export async function disposalBuyers(db: Db, actor: Actor): Promise<{ id: string; name: string }[]> {
  if (!(await holds(db, actor, STORES_MASTERS))) throw new StoresError("not_permitted", "No permission", { permission: STORES_MASTERS });
  return (await db.select({ id: vendors.id, name: vendors.legalName }).from(vendors).where(eq(vendors.status, "active")).orderBy(asc(vendors.legalName)).limit(500));
}
