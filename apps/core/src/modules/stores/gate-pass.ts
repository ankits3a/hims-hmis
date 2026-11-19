import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { raiseNotice } from "../../kernel/alerts/notices";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import {
  items, resources, stockLedger, stockWriteOffLines, stockWriteOffs, storesGatePassLines, storesGatePassScans, storesGatePasses, supplierReturnLines,
  supplierReturns, users, vendors,
} from "../../kernel/db/schema";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { enqueuePrintJob } from "../../kernel/printing/enqueue";
import { availableQty, ensureOutOnPassStore, fefoPick, postMovements } from "../materials";
import { STORES_GATEPASS_RAISE, STORES_GATEPASS_SCAN, holds, recordAct, requireStoresStore } from "./access";
import { scanClock } from "./custody";
import { StoresError } from "./errors";
import { requireStoresItem } from "./items";
import { listStoresStores } from "./shelves";
import type {
  GatePassLookup, GatePassRefType, GatePassScanInput, GatePassScanResult, GatePassSource, GatePassStatus, GatePassView, RaiseGatePassInput,
  ScanFlag,
} from "./types";
import type { MovementInput } from "../materials";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S2c (#1119, decisions 1–6) — GATE PASSES AND THE GUARD'S SCAN.
 *
 *   raise (storekeeper / materials head) ─→ print (QR = the pass number) ─→ exit scan (guard) ─→ entry scan(s) (guard)
 *                                       └─→ close (the raiser's side, before it leaves, with a reason)
 *
 * A RETURNABLE pass (repair, calibration, refill, loan) names its source store, party, due-back day and lines. The
 * exit scan posts two ledger rows per batch (source −, `OUT-ON-PASS` +, `ref_type = 'gate_pass'`); an entry scan
 * posts the reverse for what came back. What is still out is READ OFF THE LEDGER at OUT-ON-PASS, never stored, so
 * the stock is always in exactly one place (programme invariant I1). A partial return leaves the pass open.
 *
 * A NON-RETURNABLE pass stands on a dispatched supplier return or a posted write-off (S4 adds the scrap sale); its
 * lines are copied from that record. It moves no stock — the return or the write-off already did — and its exit
 * scan records the gate only.
 *
 * Who: `stores.gatepass.raise` raises, prints and closes; `stores.gatepass.scan` scans; the raiser never scans
 * their own pass (`own_pass`). Status is derived from the gate log (`stores_gate_pass_scans`, append-only in the
 * database), never stored. Every act appends one `stores.act_recorded` with `storeId` = OUT-ON-PASS (the gate's
 * ledger place) and the source store on each line, so the audit pack finds a pass by either store.
 */

/** Decision 6: the gate pass print, rendered by `gate-pass-print.ts`. */
export const GATE_PASS_DOCUMENT = "stores_gate_pass";
export const GATE_PASS_REF = "gate_pass";

const NOTICE_KIND = "stores.gate_pass";
export const GATE_WORDS = { overdue: ["Pass overdue", "पास का समय निकला"] } as const;

const MAX_LINES = 50;
const MAX_TEXT = 200;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type PassRow = typeof storesGatePasses.$inferSelect;
type ScanRow = typeof storesGatePassScans.$inferSelect;

const clean = (s: string | null | undefined): string | null => (s == null || s.trim() === "" ? null : s.trim().slice(0, MAX_TEXT));

async function requireRaiser(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_GATEPASS_RAISE))) {
    throw new StoresError("not_permitted", "only the store raises a gate pass", { permission: STORES_GATEPASS_RAISE });
  }
}

async function requireGuard(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_GATEPASS_SCAN))) {
    throw new StoresError("not_permitted", "only the guard scans a gate pass", { permission: STORES_GATEPASS_SCAN });
  }
}

// ═══════════════════════════════ reading a pass ═══════════════════════════════

/** What is still out per item and batch: the ledger's rows at OUT-ON-PASS for these passes, summed. */
async function outstanding(db: Db | Tx, passIds: readonly string[], outId: string | null): Promise<Map<string, { itemId: string; batchId: string; qty: number; first: number }[]>> {
  const out = new Map<string, { itemId: string; batchId: string; qty: number; first: number }[]>();
  if (passIds.length === 0 || outId === null) return out;
  const rows = await db.select({
    refId: stockLedger.refId, itemId: stockLedger.itemId, batchId: stockLedger.batchId,
    qty: sql<string>`coalesce(sum(${stockLedger.qtyDelta}), 0)`, first: sql<string>`min(${stockLedger.seq})`,
  }).from(stockLedger)
    .where(and(eq(stockLedger.resourceId, outId), eq(stockLedger.refType, GATE_PASS_REF), inArray(stockLedger.refId, [...passIds])))
    .groupBy(stockLedger.refId, stockLedger.itemId, stockLedger.batchId);
  for (const r of rows) {
    if (r.refId === null || Number(r.qty) <= 0) continue;
    const list = out.get(r.refId) ?? [];
    list.push({ itemId: r.itemId, batchId: r.batchId, qty: Number(r.qty), first: Number(r.first) });
    out.set(r.refId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.first - b.first);
  return out;
}

async function outOnPassId(db: Db | Tx): Promise<string | null> {
  const [r] = await db.select({ id: resources.id }).from(resources).where(and(eq(resources.kind, "store"), sql`lower(${resources.code}) = 'out-on-pass'`, eq(resources.siteId, "main")));
  return r?.id ?? null;
}

function statusOf(p: PassRow, scans: ScanRow[], outQty: number, today: string): GatePassStatus {
  if (scans.some((s) => s.kind === "close")) return "closed";
  if (!scans.some((s) => s.kind === "exit")) return "raised";
  if (p.kind === "non_returnable") return "closed";
  if (outQty <= 0) return "back";
  return p.dueBack !== null && p.dueBack < today ? "overdue" : "out";
}

async function refNos(db: Db | Tx, passes: PassRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ret = passes.filter((p) => p.refType === "supplier_return").map((p) => p.refId!);
  const wo = passes.filter((p) => p.refType === "write_off").map((p) => p.refId!);
  if (ret.length > 0) for (const r of await db.select({ id: supplierReturns.id, no: supplierReturns.returnNo }).from(supplierReturns).where(inArray(supplierReturns.id, ret))) out.set(r.id, r.no);
  if (wo.length > 0) for (const w of await db.select({ id: stockWriteOffs.id, no: stockWriteOffs.writeOffNo }).from(stockWriteOffs).where(inArray(stockWriteOffs.id, wo))) out.set(w.id, w.no);
  return out;
}

export async function gatePassViews(db: Db | Tx, passes: PassRow[], now: Date): Promise<GatePassView[]> {
  if (passes.length === 0) return [];
  const ids = passes.map((p) => p.id);
  const today = istDayString(now);
  const lines = await db.select({ l: storesGatePassLines, code: items.code, name: items.name, uom: items.baseUom }).from(storesGatePassLines)
    .innerJoin(items, eq(items.id, storesGatePassLines.itemId)).where(inArray(storesGatePassLines.passId, ids)).orderBy(asc(storesGatePassLines.lineIdx));
  const scans = await db.select().from(storesGatePassScans).where(inArray(storesGatePassScans.passId, ids))
    .orderBy(asc(storesGatePassScans.recordedAt), asc(storesGatePassScans.id));
  const stores = new Map((await db.select({ id: resources.id, code: resources.code, name: resources.name }).from(resources)
    .where(inArray(resources.id, [...new Set(passes.map((p) => p.sourceStoreId))]))).map((r) => [r.id, r] as const));
  const people = [...new Set([...passes.map((p) => p.raisedBy), ...scans.map((s) => s.actorId)])];
  const names = new Map((await db.select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, people))).map((u) => [u.id, u.n] as const));
  const person = (id: string) => ({ id, name: names.get(id) ?? id });
  const left = await outstanding(db, ids, await outOnPassId(db));
  const nos = await refNos(db, passes);

  return passes.map((p) => {
    const mine = scans.filter((s) => s.passId === p.id);
    const outRows = left.get(p.id) ?? [];
    const exited = mine.some((s) => s.kind === "exit");
    const outQty = outRows.reduce((a, r) => a + r.qty, 0);
    return {
      id: p.id, passNo: p.passNo, kind: p.kind as GatePassView["kind"], purpose: (p.purpose ?? null) as GatePassView["purpose"], party: p.party,
      dueBack: p.dueBack, status: statusOf(p, mine, outQty, today),
      store: stores.get(p.sourceStoreId) ?? { id: p.sourceStoreId, code: "", name: "" },
      ref: p.refType === null || p.refId === null ? null : { type: p.refType as GatePassRefType, id: p.refId, no: nos.get(p.refId) ?? "" },
      note: p.note,
      lines: lines.filter((l) => l.l.passId === p.id).map((l) => {
        const out = p.kind === "returnable" ? outRows.filter((r) => r.itemId === l.l.itemId).reduce((a, r) => a + r.qty, 0) : 0;
        const wentOut = exited ? l.l.qty : 0;
        return { itemId: l.l.itemId, itemCode: l.code, itemName: l.name, baseUom: l.uom, qty: l.l.qty, out, back: p.kind === "returnable" ? Math.max(0, wentOut - out) : 0 };
      }),
      raisedBy: person(p.raisedBy), raisedAt: p.raisedAt.toISOString(),
      scans: mine.map((s) => ({
        kind: s.kind as "exit" | "entry" | "close", by: person(s.actorId), at: s.occurredAt.toISOString(), recordedAt: s.recordedAt.toISOString(),
        flag: (s.flag ?? null) as ScanFlag | null, reason: s.reason,
        lines: Object.values(s.lines.reduce<Record<string, { itemId: string; qty: number }>>((acc, l) => {
          acc[l.itemId] = { itemId: l.itemId, qty: (acc[l.itemId]?.qty ?? 0) + l.qty };
          return acc;
        }, {})),
      })),
    };
  });
}

export async function getGatePass(db: Db | Tx, passId: string, now: Date = new Date()): Promise<GatePassView | null> {
  const [p] = await db.select().from(storesGatePasses).where(eq(storesGatePasses.id, passId));
  return p === undefined ? null : (await gatePassViews(db, [p], now))[0]!;
}

const ORDER: Record<GatePassStatus, number> = { overdue: 0, out: 1, raised: 2, back: 3, closed: 4 };

/** The store's Passes tab: overdue first, then out, then not out yet, then the finished ones; newest first within each. */
export async function listGatePasses(db: Db, actor: Actor, now: Date = new Date()): Promise<GatePassView[]> {
  await requireRaiser(db, actor);
  await notifyOverdueGatePasses(db, now);
  const rows = await db.select().from(storesGatePasses).orderBy(desc(storesGatePasses.raisedAt)).limit(200);
  const views = await gatePassViews(db, rows, now);
  return views.sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.raisedAt.localeCompare(a.raisedAt));
}

/** Decision 1: open returnable passes past their due-back day (IST). S3 turns each into a red card. */
export async function overdueGatePasses(db: Db | Tx, now: Date = new Date()): Promise<GatePassView[]> {
  const rows = await db.select().from(storesGatePasses)
    .where(and(eq(storesGatePasses.kind, "returnable"), lt(storesGatePasses.dueBack, istDayString(now)))).orderBy(asc(storesGatePasses.dueBack));
  return (await gatePassViews(db, rows, now)).filter((p) => p.status === "overdue");
}

/** Spec "Notices": the raiser is told once per pass, "Pass overdue". Idempotent (the notice's source key). */
export async function notifyOverdueGatePasses(db: Db, now: Date = new Date()): Promise<number> {
  let sent = 0;
  for (const p of await overdueGatePasses(db, now)) {
    const raised = await raiseNotice(db, {
      userId: p.raisedBy.id, kind: NOTICE_KIND, title: GATE_WORDS.overdue[0], body: `${GATE_WORDS.overdue[1]} · ${p.passNo}`,
      refType: "stores_gate_pass", refId: p.id, sourceKey: `stores-gate-pass:${p.id}:overdue`, at: now,
    });
    if (raised) sent += 1;
  }
  return sent;
}

// ═══════════════════════════════ raise ═══════════════════════════════

type SourceRecord = { storeId: string; party: string; no: string; lines: { itemId: string; qty: number }[] };

/** Decision 2: the record a non-returnable pass stands on — a dispatched supplier return or a posted write-off — or `ref_required`. */
async function sourceRecord(db: Db | Tx, refType: GatePassRefType, refId: string): Promise<SourceRecord> {
  if (refType === "supplier_return") {
    const [r] = await db.select({ r: supplierReturns, legal: vendors.legalName, trade: vendors.tradeName }).from(supplierReturns)
      .innerJoin(vendors, eq(vendors.id, supplierReturns.vendorId)).where(eq(supplierReturns.id, refId));
    if (r === undefined || !["dispatched", "credited", "closed"].includes(r.r.status)) {
      throw new StoresError("ref_required", "a non-returnable pass needs a dispatched supplier return", { refType, status: r?.r.status ?? null });
    }
    const lines = await db.select().from(supplierReturnLines).where(eq(supplierReturnLines.returnId, refId)).orderBy(asc(supplierReturnLines.id));
    return { storeId: lines[0]?.storeResourceId ?? "", party: r.trade ?? r.legal, no: r.r.returnNo, lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qtyBase })) };
  }
  const [w] = await db.select().from(stockWriteOffs).where(eq(stockWriteOffs.id, refId));
  if (w === undefined || w.status !== "posted") {
    throw new StoresError("ref_required", "a non-returnable pass needs a posted write-off", { refType, status: w?.status ?? null });
  }
  const lines = await db.select().from(stockWriteOffLines).where(eq(stockWriteOffLines.writeOffId, refId)).orderBy(asc(stockWriteOffLines.id));
  return { storeId: w.storeResourceId, party: w.disposalAgency ?? "", no: w.writeOffNo, lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qtyBase })) };
}

/** One line per item, in the order first named; quantities of a repeated item add up. */
function mergeLines(lines: { itemId: string; qty: number }[]): { itemId: string; qty: number }[] {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.itemId, (m.get(l.itemId) ?? 0) + l.qty);
  return [...m].map(([itemId, qty]) => ({ itemId, qty }));
}

export async function raiseGatePass(db: Db, actor: Actor, input: RaiseGatePassInput, now: Date = new Date()): Promise<GatePassView> {
  await requireRaiser(db, actor);
  const today = istDayString(now);
  let pass: Omit<PassRow, "id" | "passNo" | "raisedBy" | "raisedAt">;
  let lines: { itemId: string; qty: number }[];

  if (input.kind === "returnable") {
    const party = clean(input.party);
    if (party === null) throw new StoresError("party_required", "name who the goods go to");
    if (typeof input.dueBack !== "string" || !DAY_RE.test(input.dueBack) || Number.isNaN(Date.parse(input.dueBack)) || input.dueBack < today) {
      throw new StoresError("due_back_required", "a returnable pass needs a due-back day, today or later");
    }
    const store = await requireStoresStore(db, input.storeId);
    lines = mergeLines(input.lines ?? []);
    if (lines.length === 0 || lines.length > MAX_LINES || lines.some((l) => !Number.isSafeInteger(l.qty) || l.qty <= 0)) {
      throw new StoresError("bad_quantity", "each line needs a whole quantity above zero");
    }
    for (const l of lines) {
      await requireStoresItem(db, l.itemId);
      const have = await availableQty(db, store.id, l.itemId, now);
      if (have < l.qty) throw new StoresError("more_than_on_hand", "more than the store holds", { itemId: l.itemId, onHand: have });
    }
    pass = { kind: "returnable", purpose: input.purpose, sourceStoreId: store.id, party, dueBack: input.dueBack, refType: null, refId: null, note: clean(input.note) };
  } else {
    if (input.refType == null || input.refId == null || input.refId.trim() === "") {
      throw new StoresError("ref_required", "a non-returnable pass needs a supplier return or a write-off");
    }
    const src = await sourceRecord(db, input.refType, input.refId);
    lines = mergeLines(src.lines);
    if (lines.length === 0 || src.storeId === "") throw new StoresError("ref_required", "that record names nothing to let out");
    pass = { kind: "non_returnable", purpose: null, sourceStoreId: src.storeId, party: src.party === "" ? src.no : src.party, dueBack: null, refType: input.refType, refId: input.refId, note: clean(input.note) };
  }

  const id = await withTx(db, async (tx) => {
    if (pass.refId !== null) {
      // One live pass per record: serialise raisers of the same record, then look.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-gate-pass:${pass.refId}`}))`);
      const live = await tx.select({ id: storesGatePasses.id }).from(storesGatePasses)
        .where(and(eq(storesGatePasses.refType, pass.refType!), eq(storesGatePasses.refId, pass.refId),
          sql`not exists (select 1 from stores_gate_pass_scans s where s.pass_id = ${storesGatePasses.id} and s.kind = 'close')`));
      if (live.length > 0) throw new StoresError("already_on_pass", "that record already has a gate pass", { passId: live[0]!.id });
    }
    const passId = newId();
    const passNo = await nextEpisodeNo(tx, "gate_pass", today);
    const outId = await ensureOutOnPassStore(tx);
    await tx.insert(storesGatePasses).values({ id: passId, passNo, ...pass, raisedBy: actor.id, raisedAt: now });
    await tx.insert(storesGatePassLines).values(lines.map((l, i) => ({ passId, lineIdx: i, itemId: l.itemId, qty: l.qty })));
    await recordAct(tx, actor, now, {
      act: "raise_gate_pass", storeId: outId, refId: passId, reason: pass.note,
      after: { passNo, kind: pass.kind, purpose: pass.purpose, party: pass.party, dueBack: pass.dueBack, refType: pass.refType, refId: pass.refId },
      lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, storeId: pass.sourceStoreId })),
    });
    // Decision 6: the pass prints with its QR. The relay prints it; the store's own browser can print it too (`/print`).
    await enqueuePrintJob(tx, { document: GATE_PASS_DOCUMENT, params: { passId }, dedupeKey: `stores-gate-pass:${passId}`, requestedBy: actor.id });
    return passId;
  });
  return (await getGatePass(db, id, now))!;
}

/** The records a non-returnable pass may stand on and that have no live pass yet, newest first. */
export async function gatePassSources(db: Db, actor: Actor): Promise<GatePassSource[]> {
  await requireRaiser(db, actor);
  const taken = new Set((await db.select({ refId: storesGatePasses.refId }).from(storesGatePasses)
    .where(sql`${storesGatePasses.refId} is not null and not exists (select 1 from stores_gate_pass_scans s where s.pass_id = ${storesGatePasses.id} and s.kind = 'close')`))
    .map((r) => r.refId!));
  const out: GatePassSource[] = [];
  const rets = await db.select({ r: supplierReturns, legal: vendors.legalName, trade: vendors.tradeName }).from(supplierReturns)
    .innerJoin(vendors, eq(vendors.id, supplierReturns.vendorId)).where(eq(supplierReturns.status, "dispatched"))
    .orderBy(desc(supplierReturns.dispatchedAt)).limit(50);
  const wos = await db.select().from(stockWriteOffs).where(eq(stockWriteOffs.status, "posted")).orderBy(desc(stockWriteOffs.postedAt)).limit(50);
  const wanted = [
    ...rets.filter((r) => !taken.has(r.r.id)).map((r) => ({ type: "supplier_return" as const, id: r.r.id, no: r.r.returnNo, party: r.trade ?? r.legal, at: (r.r.dispatchedAt ?? r.r.updatedAt).toISOString() })),
    ...wos.filter((w) => !taken.has(w.id)).map((w) => ({ type: "write_off" as const, id: w.id, no: w.writeOffNo, party: w.disposalAgency ?? "", at: (w.postedAt ?? w.requestedAt).toISOString() })),
  ];
  for (const w of wanted) {
    const src = await sourceRecord(db, w.type, w.id);
    if (src.lines.length === 0) continue;
    const [store] = await db.select({ id: resources.id, code: resources.code, name: resources.name }).from(resources).where(eq(resources.id, src.storeId));
    const names = new Map((await db.select({ id: items.id, n: items.name }).from(items).where(inArray(items.id, src.lines.map((l) => l.itemId)))).map((i) => [i.id, i.n] as const));
    out.push({
      ...w, store: store ?? { id: src.storeId, code: "", name: "" },
      lines: mergeLines(src.lines).map((l) => ({ itemId: l.itemId, itemName: names.get(l.itemId) ?? l.itemId, qty: l.qty })),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// ═══════════════════════════════ the guard's scan ═══════════════════════════════

/**
 * The QR carries the pass number; the typed fallback is its last four digits, matched among the passes still in
 * play (not closed, not all back). None is `pass_not_valid`, two are `ambiguous_code`.
 */
async function passByCode(db: Db | Tx, code: string, now: Date): Promise<{ row: PassRow; view: GatePassView; method: "scan" | "typed" }> {
  const c = code.trim().toUpperCase();
  const typed = /^\d{4}$/.test(c);
  if (!typed && c.length < 5) throw new StoresError("pass_not_valid", "scan the pass or type its last four digits");
  const rows = typed
    ? await db.select().from(storesGatePasses).where(sql`${storesGatePasses.passNo} like ${`%${c}`}`).orderBy(desc(storesGatePasses.raisedAt)).limit(50)
    : await db.select().from(storesGatePasses).where(sql`upper(${storesGatePasses.passNo}) = ${c}`);
  if (rows.length === 0) throw new StoresError("pass_not_valid", "no pass has that number");
  const views = await gatePassViews(db, rows, now);
  if (typed) {
    const live = views.filter((v) => v.status === "raised" || v.status === "out" || v.status === "overdue");
    if (live.length > 1) throw new StoresError("ambiguous_code", "two passes end in those digits: scan the pass", { count: live.length });
    const pick = live[0] ?? views[0]!;
    return { row: rows.find((r) => r.id === pick.id)!, view: pick, method: "typed" };
  }
  return { row: rows[0]!, view: views[0]!, method: "scan" };
}

/** What the guard may do with this pass now, or the refusal the gate shows. */
function nextAct(actor: Actor, row: PassRow, view: GatePassView): "exit" | "entry" {
  if (row.raisedBy === actor.id) throw new StoresError("own_pass", "you raised this pass: another guard scans it");
  if (view.status === "closed") {
    if (view.kind === "non_returnable" && view.scans.some((s) => s.kind === "exit")) throw new StoresError("already_out", "this pass has already gone out");
    throw new StoresError("pass_not_valid", "this pass is closed");
  }
  if (view.status === "back") throw new StoresError("pass_not_valid", "everything on this pass is back");
  return view.status === "raised" ? "exit" : "entry";
}

/** Decision 4: the guard's lookup before the one tap — the pass, and whether it is going out or coming in. */
export async function gatePassLookup(db: Db, actor: Actor, code: string, now: Date = new Date()): Promise<GatePassLookup> {
  await requireGuard(db, actor);
  const { row, view } = await passByCode(db, code, now);
  return { pass: view, act: nextAct(actor, row, view) };
}

async function seenKey(db: Db | Tx, actor: Actor, clientKey: string | null | undefined): Promise<string | null> {
  const key = clean(clientKey);
  if (key === null) return null;
  const [k] = await db.select({ passId: storesGatePassScans.passId }).from(storesGatePassScans)
    .where(and(eq(storesGatePassScans.actorId, actor.id), eq(storesGatePassScans.clientKey, key)));
  return k?.passId ?? null;
}

/**
 * Decisions 1, 2, 4: "Let out" / "Let in". A key seen before records nothing and answers the pass as it is. An exit
 * of a pass already out is `already_out`; an entry names what came back (default: everything still out), each
 * line at most what is out (`more_than_out`).
 */
export async function scanGatePass(db: Db, actor: Actor, input: GatePassScanInput, now: Date = new Date()): Promise<GatePassScanResult> {
  const seen = await seenKey(db, actor, input.clientKey);
  if (seen !== null) return { pass: (await getGatePass(db, seen, now))!, duplicate: true, flag: null };
  await requireGuard(db, actor);
  const clock = scanClock(input.scannedAt, now);
  const { row, method } = await passByCode(db, input.code, now);

  const dup = await withTx(db, async (tx) => {
    await tx.select({ id: storesGatePasses.id }).from(storesGatePasses).where(eq(storesGatePasses.id, row.id)).for("update");
    const view = (await gatePassViews(tx, [row], now))[0]!;
    const act = nextAct(actor, row, view);
    if (input.act === "exit" && act !== "exit") throw new StoresError("already_out", "this pass has already gone out");
    if (input.act === "entry" && act !== "entry") {
      throw new StoresError(row.kind === "non_returnable" ? "pass_not_valid" : "not_out", row.kind === "non_returnable" ? "nothing comes back on this pass" : "it has not gone out yet");
    }
    const outId = await ensureOutOnPassStore(tx);
    const movements: MovementInput[] = [];
    const crossed: { itemId: string; batchId: string | null; qty: number }[] = [];
    const base = { refType: GATE_PASS_REF, refId: row.id, occurredAt: clock.occurredAt };

    if (input.act === "exit") {
      for (const l of view.lines) {
        if (row.kind === "non_returnable") { crossed.push({ itemId: l.itemId, batchId: null, qty: l.qty }); continue; }
        const picks = await fefoPick(tx, row.sourceStoreId, l.itemId, l.qty, now);
        if (picks.reduce((a, p) => a + p.qty, 0) < l.qty) throw new StoresError("more_than_on_hand", "the store no longer holds what the pass names", { itemId: l.itemId });
        for (const p of picks) {
          movements.push({ resourceId: row.sourceStoreId, batchId: p.batchId, qtyDelta: -p.qty, reason: "issue", ...base });
          movements.push({ resourceId: outId, batchId: p.batchId, qtyDelta: p.qty, reason: "issue", ...base });
          crossed.push({ itemId: l.itemId, batchId: p.batchId, qty: p.qty });
        }
      }
    } else {
      const left = (await outstanding(tx, [row.id], outId)).get(row.id) ?? [];
      const asked = input.lines === undefined || input.lines.length === 0
        ? view.lines.filter((l) => l.out > 0).map((l) => ({ itemId: l.itemId, qty: l.out }))
        : mergeLines(input.lines);
      if (asked.some((a) => !Number.isSafeInteger(a.qty) || a.qty <= 0)) throw new StoresError("bad_quantity", "each line needs a whole quantity above zero");
      for (const a of asked) {
        const rows = left.filter((r) => r.itemId === a.itemId);
        if (rows.reduce((s, r) => s + r.qty, 0) < a.qty) throw new StoresError("more_than_out", "more than is out on this pass", { itemId: a.itemId });
        let want = a.qty;
        for (const r of rows) {
          if (want <= 0) break;
          const take = Math.min(want, r.qty);
          movements.push({ resourceId: outId, batchId: r.batchId, qtyDelta: -take, reason: "receive", ...base });
          movements.push({ resourceId: row.sourceStoreId, batchId: r.batchId, qtyDelta: take, reason: "receive", ...base });
          crossed.push({ itemId: a.itemId, batchId: r.batchId, qty: take });
          want -= take;
        }
      }
    }

    const won = await tx.insert(storesGatePassScans).values({
      id: newId(), passId: row.id, kind: input.act, actorId: actor.id, method, clientKey: clean(input.clientKey), lines: crossed, reason: null,
      phoneAt: clock.phoneAt, occurredAt: clock.occurredAt, recordedAt: now, flag: clock.flag,
    }).onConflictDoNothing({ target: [storesGatePassScans.actorId, storesGatePassScans.clientKey], where: sql`${storesGatePassScans.clientKey} is not null` })
      .returning({ id: storesGatePassScans.id });
    if (won.length === 0) return true;
    if (movements.length > 0) await postMovements(tx, actor, movements);
    const outBefore = view.lines.reduce((a, l) => a + l.out, 0);
    const delta = crossed.reduce((a, c) => a + c.qty, 0);
    await recordAct(tx, actor, now, {
      act: input.act === "exit" ? "gate_pass_out" : "gate_pass_in", storeId: outId, refId: row.id, reason: clock.flag,
      before: row.kind === "returnable" ? outBefore : null,
      after: row.kind === "returnable" ? (input.act === "exit" ? outBefore + delta : outBefore - delta) : null,
      lines: crossed.map((c) => ({ ...c, storeId: row.sourceStoreId })),
    });
    return false;
  });
  return { pass: (await getGatePass(db, row.id, now))!, duplicate: dup, flag: dup ? null : clock.flag };
}

/** Decision 5: a pass that never went out is closed by the store, with a reason. Once out, only the gate closes it. */
export async function closeGatePass(db: Db, actor: Actor, passId: string, reason: string, now: Date = new Date()): Promise<GatePassView> {
  await requireRaiser(db, actor);
  const why = clean(reason);
  if (why === null) throw new StoresError("reason_required", "say why the pass is closed");
  await withTx(db, async (tx) => {
    const [row] = await tx.select().from(storesGatePasses).where(eq(storesGatePasses.id, passId)).for("update");
    if (row === undefined) throw new StoresError("pass_not_valid", "no such pass", { passId });
    const view = (await gatePassViews(tx, [row], now))[0]!;
    if (view.scans.some((s) => s.kind === "close")) throw new StoresError("pass_closed", "this pass is already closed");
    if (view.scans.some((s) => s.kind === "exit")) throw new StoresError("already_out", "it has gone out: the gate closes it");
    await tx.insert(storesGatePassScans).values({
      id: newId(), passId, kind: "close", actorId: actor.id, method: null, clientKey: null, lines: [], reason: why,
      phoneAt: null, occurredAt: now, recordedAt: now, flag: null,
    });
    await recordAct(tx, actor, now, {
      act: "close_gate_pass", storeId: await ensureOutOnPassStore(tx), refId: passId, reason: why,
      lines: view.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, storeId: row.sourceStoreId })),
    });
  });
  return (await getGatePass(db, passId, now))!;
}

/** The "New pass" sheet in one read: the stores a returnable pass may leave from, and the records a non-returnable one may stand on. */
export async function gatePassForm(db: Db, actor: Actor): Promise<{ stores: { id: string; code: string; name: string }[]; sources: GatePassSource[] }> {
  await requireRaiser(db, actor);
  const stores = (await listStoresStores(db)).map((s) => ({ id: s.id, code: s.code, name: s.name }));
  return { stores, sources: await gatePassSources(db, actor) };
}
