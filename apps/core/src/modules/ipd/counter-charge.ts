import { and, desc, eq } from "drizzle-orm";
import { IPD_COUNTER_RETURN_REF, IPD_COUNTER_SALE_REF, IPD_INTENTS, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissions, ipdChargeLines, patients } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { medicinesByIds, ndpsClassByMedicine } from "../formulary";
import { MaterialsError, batchLocations, fefoPick, findStoreByCode, getBatch, itemsByIds, movementsFor, postMovements } from "../materials";
import { resolvePatientId } from "../patients";
import { OPD_PHARMACY_STORE_CODE, controlOf, searchShelfAt, shelfByMedicine } from "../pharmacy";
import { lockAdmission, onceIpd, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { liveBills } from "./bill-cover";
import { evaluateDepositLadderSafely } from "./deposit-ladder";
import { creditedUnitsOf, postCounterDrugLinesIn, postDrugReturnCreditsIn } from "./drug-charges";
import { counterCharged, counterReturned } from "./emar-events";
import { IpdRefusal } from "./errors";
import { IPD_NURSING_STATES } from "./nursing";
import { IPD_EMAR_ISSUE } from "./permissions";
import { identitiesOf, placesOf } from "./rounds-read";
import type { Actor, IpdCounterAdmission, IpdCounterSales, IpdCounterShelfEntry } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * #787 (IP counter) — CHARGE TO IP AT THE OPD PHARMACY COUNTER. An admitted patient's attendant buys at the OPD counter
 * (PHARM-OPD) and the sale goes on the admission's running bill instead of taking cash — the "IP credit" sale of Indian
 * hospitals. Every rule below is DECIDED by standard practice; the money ones come from decisions 0073 / 0074.
 *
 * - FIND: by IP number (`IP26-000123`) or by UHID with an open admission. The answer names the bed and the ward, so the
 *   pharmacist confirms the patient (a sealed patient shows the alias and no bed — the shared identity rule).
 * - REFUSED: no admission yet (`not_admitted`: requested / reserved / cancelled, or a UHID with none open); a stay that
 *   ended (`ip_discharged`); a live settled final bill (`ip_bill_settled` — later medicines go on the supplementary bill
 *   through the ward, or are sold for cash). A controlled drug (Schedule X, NDPS) reaches an inpatient only against a ward
 *   order (`controlled_at_counter`).
 * - PRICE AND CHARGE: the ward issue's own path (`drug-charges.ts`): batch MRP per unit by the counter's price function at
 *   the sale instant, tax-inclusive, NO member benefit, one `ipd.pharmacy` line per batch. A missing price refuses the sale.
 * - THE RECORD: no table of its own — the stock ledger rows (`ref_type` `ipd_counter_sale`, `ref_id` the sale, the patient
 *   and the admission as encounter), the charge lines (`issue_id` = `order_id` = the sale) and the event
 *   `ipd.med.counter_charged` (the audit) ARE the sale.
 * - RETURN: stock back to the batches it left (newest-taken first, each only what is still out of it); the credit is the
 *   ward return's (`postDrugReturnCreditsIn`): reversal plus kept units at the sale's own price, or a `return_after_bill`
 *   decision when a settled bill took the line.
 * - WHO: `ipd.emar.issue` — the pharmacist who issues to the ward (`pharmacist`, `pharmacy_incharge`). No new permission.
 */

type Input<N extends "counter_charge" | "counter_return"> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends "counter_charge" | "counter_return"> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type CounterOpts = { now?: Date };

const ENDED_STATES = new Set(["discharged", "lama", "absconded", "deceased", "transferred_out"]);
const IP_NO_RE = /^IP(\d{2})-?(\d{1,6})$/;

/** The refusal for an admission the counter may not charge, or null. Under the lock for an act; plain for the lookup. */
async function counterRefusal(db: Db | Tx, a: AdmissionRow): Promise<IpdRefusal | null> {
  if (ENDED_STATES.has(a.state)) return new IpdRefusal("ip_discharged", undefined, { admissionId: a.id, state: a.state, admissionNo: a.admissionNo });
  if (!(IPD_NURSING_STATES as readonly string[]).includes(a.state)) return new IpdRefusal("not_admitted", undefined, { admissionId: a.id, state: a.state });
  if ((await liveBills(db, a.id)).some((b) => b.kind === "final")) {
    return new IpdRefusal("ip_bill_settled", undefined, { admissionId: a.id, admissionNo: a.admissionNo, next: ["supplementary_bill", "cash_sale"] });
  }
  return null;
}

/** The admission a typed IP number or UHID names (newest first for a UHID), or the refusal. */
async function findAdmission(db: Db, q: string): Promise<AdmissionRow> {
  const text = q.trim().toUpperCase();
  const ip = IP_NO_RE.exec(text);
  if (ip !== null) {
    const no = `IP${ip[1]!}-${ip[2]!.padStart(6, "0")}`;
    const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.admissionNo, no)))[0];
    if (a === undefined) throw new IpdRefusal("admission_not_found", undefined, { admissionNo: no });
    return a;
  }
  const found = (await db.select({ id: patients.id }).from(patients).where(eq(patients.uhid, text)))[0];
  const patientId = found === undefined ? null : await resolvePatientId(db, found.id);
  if (patientId === null) throw new IpdRefusal("not_admitted", undefined, { uhid: text });
  const all = await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.patientId, patientId)).orderBy(desc(ipdAdmissions.requestedAt));
  const open = all.find((a) => (IPD_NURSING_STATES as readonly string[]).includes(a.state));
  if (open === undefined) throw new IpdRefusal("not_admitted", undefined, { uhid: text });
  return open;
}

/** The counter's lookup: the admission, its patient, bed and ward — or the refusal the charge would give. */
export async function lookupCounterAdmission(db: Db, actor: Actor, q: string, opts: CounterOpts = {}): Promise<IpdCounterAdmission> {
  await requireIpdPermission(db, actor, IPD_EMAR_ISSUE);
  const at = opts.now ?? new Date();
  const a = await findAdmission(db, q);
  const refusal = await counterRefusal(db, a);
  if (refusal !== null) throw refusal;
  const identity = (await identitiesOf(db, actor, [a], at)).get(a.id)!;
  const place = (await placesOf(db, [a.id])).get(a.id);
  return {
    admissionId: a.id, admissionNo: a.admissionNo, state: a.state as IpdCounterAdmission["state"], identity,
    bedCode: identity.sealed ? null : place?.bedCode ?? null, wardName: identity.sealed ? null : place?.wardName ?? null,
  };
}

/** The OPD counter's shelf (PHARM-OPD), Schedule X never offered — the pharmacy's own search. */
export async function searchCounterShelfForIp(db: Db, actor: Actor, q: string, opts: CounterOpts = {}): Promise<IpdCounterShelfEntry[]> {
  await requireIpdPermission(db, actor, IPD_EMAR_ISSUE);
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (store === undefined) return [];
  return (await searchShelfAt(db, store.id, q, opts.now ?? new Date())).map((e) => ({
    medicineId: e.medicineId, itemId: e.itemId, brandName: e.brandName, strengthLabel: e.strengthLabel, scheduleFlag: e.scheduleFlag,
    baseUom: e.baseUom, available: e.available,
  }));
}

/** CHARGE TO IP: the sale's stock leaves PHARM-OPD and its lines go on the running bill, in one transaction. */
export async function counterCharge(db: Db, actor: Actor, raw: unknown, opts: CounterOpts = {}): Promise<Output<"counter_charge">> {
  const input: Input<"counter_charge"> = IPD_INTENTS.counter_charge.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_ISSUE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "counter_charge", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    const refusal = await counterRefusal(tx, a);
    if (refusal !== null) throw refusal;
    const store = await findStoreByCode(tx, OPD_PHARMACY_STORE_CODE);
    if (store === undefined) throw new IpdRefusal("medicine_not_stocked", undefined, { store: OPD_PHARMACY_STORE_CODE });
    const ids = [...new Set(input.lines.map((l) => l.medicineId))];
    const [shelf, meds, ndps] = await Promise.all([shelfByMedicine(tx as unknown as Db), medicinesByIds(tx as unknown as Db, ids), ndpsClassByMedicine(tx, ids)]);
    const saleId = newId();
    const plan: { medicineId: string; itemId: string; picks: { batchId: string; qty: number }[] }[] = [];
    for (const l of input.lines) {
      const entry = shelf.get(l.medicineId);
      const med = meds.get(l.medicineId);
      if (entry === undefined || med === undefined) throw new IpdRefusal("medicine_not_stocked", undefined, { medicineId: l.medicineId });
      if (controlOf(med.scheduleFlag, ndps.get(l.medicineId)).controlled) throw new IpdRefusal("controlled_at_counter", undefined, { medicineId: l.medicineId });
      if (l.batchId !== undefined) {
        const batch = await getBatch(tx, l.batchId);
        const here = batch === undefined ? [] : (await batchLocations(tx, batch.id)).filter((x) => x.resourceId === store.id && x.qtyOnHand > 0);
        if (batch === undefined || batch.itemId !== entry.item.id || here.length === 0) {
          throw new IpdRefusal("batch_mismatch", undefined, { batchId: l.batchId, itemId: batch?.itemId ?? null });
        }
      }
      // The same medicine twice in one sale: the second pick must not offer the units the first already took.
      const taken = plan.filter((p) => p.itemId === entry.item.id).flatMap((p) => p.picks);
      const picks = l.batchId !== undefined ? [{ batchId: l.batchId, qty: l.units }]
        : await fefoPick(tx, store.id, entry.item.id, l.units + taken.reduce((t, p) => t + p.qty, 0), at).then((all) => less(all, taken));
      const got = picks.reduce((t, p) => t + p.qty, 0);
      if (got < l.units) throw new IpdRefusal("stock_short", undefined, { medicineId: l.medicineId, asked: l.units, available: got });
      plan.push({ medicineId: l.medicineId, itemId: entry.item.id, picks });
    }
    try {
      await postMovements(tx, actor, plan.flatMap((p) => p.picks.map((x) => ({
        resourceId: store.id, batchId: x.batchId, qtyDelta: -x.qty, reason: "consume" as const, refType: IPD_COUNTER_SALE_REF, refId: saleId,
        patientId: a.patientId, encounterId: a.id, occurredAt: at,
      }))));
    } catch (e) {
      if (e instanceof MaterialsError) throw new IpdRefusal("stock_short", undefined, { reason: e.code });
      throw e;
    }
    const lines: Output<"counter_charge">["lines"] = [];
    const chargeLineIds: string[] = [];
    for (const p of plan) {
      const posted = await postCounterDrugLinesIn(tx, actor, a, { saleId, itemId: p.itemId, batches: p.picks, at });
      chargeLineIds.push(...posted.map((x) => x.id));
      lines.push({ medicineId: p.medicineId, units: p.picks.reduce((t, x) => t + x.qty, 0), netPaise: posted.reduce((t, x) => t + x.netPaise, 0) });
    }
    const totalPaise = lines.reduce((t, l) => t + l.netPaise, 0);
    await appendEvent(tx, counterCharged.make({
      payload: {
        saleId, admissionId: a.id, storeId: store.id, lines: lines.length, units: lines.reduce((t, l) => t + l.units, 0), chargeLineIds, totalPaise,
        provenance: provenanceOf(actor),
      },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    await evaluateDepositLadderSafely(tx as unknown as Db, a.id, at, "counter charge");
    return { saleId, admissionId: a.id, lines, totalPaise };
  }), at);
}

/** FEFO picks less what an earlier line of the same sale already took (batch by batch). */
function less(all: readonly { batchId: string; qty: number }[], taken: readonly { batchId: string; qty: number }[]): { batchId: string; qty: number }[] {
  const used = new Map<string, number>();
  for (const t of taken) used.set(t.batchId, (used.get(t.batchId) ?? 0) + t.qty);
  return all.map((p) => {
    const u = Math.min(used.get(p.batchId) ?? 0, p.qty);
    used.set(p.batchId, (used.get(p.batchId) ?? 0) - u);
    return { batchId: p.batchId, qty: p.qty - u };
  }).filter((p) => p.qty > 0);
}

type SaleRows = { admissionId: string; issued: Map<string, { itemId: string; batchId: string; qty: number; resourceId: string }[]>; returned: Map<string, number>; soldAt: Date };

/** A sale from its ledger rows: per item the batches issued (in pick order) and, per batch, the units already back. */
async function saleOf(db: Db | Tx, saleId: string): Promise<SaleRows | null> {
  const first = (await db.select({ admissionId: ipdChargeLines.admissionId }).from(ipdChargeLines)
    .where(and(eq(ipdChargeLines.issueId, saleId), eq(ipdChargeLines.orderId, saleId), eq(ipdChargeLines.source, "ipd.pharmacy"))))[0];
  if (first === undefined) return null;
  return salesOf(db, first.admissionId).then((all) => all.get(saleId) ?? null);
}

async function salesOf(db: Db | Tx, admissionId: string): Promise<Map<string, SaleRows>> {
  const out = new Map<string, SaleRows>();
  const rows = await movementsFor(db, { encounterId: admissionId }, { order: "asc" });
  for (const m of rows) {
    if (m.refType !== IPD_COUNTER_SALE_REF || m.refId === null) continue;
    const s = out.get(m.refId) ?? { admissionId, issued: new Map(), returned: new Map(), soldAt: m.occurredAt };
    const list = s.issued.get(m.itemId) ?? [];
    list.push({ itemId: m.itemId, batchId: m.batchId, qty: -m.qtyDelta, resourceId: m.resourceId });
    s.issued.set(m.itemId, list);
    out.set(m.refId, s);
  }
  for (const m of rows) {
    if (m.refType !== IPD_COUNTER_RETURN_REF || m.refId === null) continue;
    const s = out.get(m.refId.split(":")[0] ?? "");
    if (s !== undefined) s.returned.set(m.batchId, (s.returned.get(m.batchId) ?? 0) + m.qtyDelta);
  }
  return out;
}

/** The admission's counter sales and what may still come back of each item — the counter's Return list. */
export async function readCounterSales(db: Db, actor: Actor, admissionId: string): Promise<IpdCounterSales> {
  await requireIpdPermission(db, actor, IPD_EMAR_ISSUE);
  await readAdmission(db, admissionId);
  const sales = await salesOf(db, admissionId);
  const itemIds = [...new Set([...sales.values()].flatMap((s) => [...s.issued.keys()]))];
  const items = await itemsByIds(db, itemIds);
  return {
    admissionId,
    sales: [...sales.entries()].map(([saleId, s]) => ({
      saleId, soldAt: s.soldAt.toISOString(),
      lines: [...s.issued.entries()].map(([itemId, batches]) => ({
        itemId, name: items.get(itemId)?.name ?? itemId, units: batches.reduce((t, b) => t + b.qty, 0),
        returned: batches.reduce((t, b) => t + (s.returned.get(b.batchId) ?? 0), 0),
      })),
    })).sort((x, y) => y.soldAt.localeCompare(x.soldAt)),
  };
}

/** Units of a counter sale back to the counter: stock in, the running bill credited as a ward return is. */
export async function counterReturn(db: Db, actor: Actor, raw: unknown, opts: CounterOpts = {}): Promise<Output<"counter_return">> {
  const input: Input<"counter_return"> = IPD_INTENTS.counter_return.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_ISSUE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "counter_return", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const found = await saleOf(tx, input.saleId);
    if (found === null) throw new IpdRefusal("counter_sale_not_found", undefined, { saleId: input.saleId });
    const a = await lockAdmission(tx, found.admissionId);
    // Re-read under the lock: a return racing this one has committed its rows by now.
    const sale = (await saleOf(tx, input.saleId))!;
    const batches = sale.issued.get(input.itemId);
    if (batches === undefined) throw new IpdRefusal("not_on_sale", undefined, { saleId: input.saleId, itemId: input.itemId });
    const out = batches.reduce((t, b) => t + b.qty, 0) - batches.reduce((t, b) => t + (sale.returned.get(b.batchId) ?? 0), 0);
    if (input.units > out) throw new IpdRefusal("return_exceeds_issue", undefined, { sold: batches.reduce((t, b) => t + b.qty, 0), out });
    // Newest-taken first; each batch takes back only what is still out of it (the ward return's rule).
    const back = new Map(sale.returned);
    let left = input.units;
    const plan: { batchId: string; qty: number; resourceId: string }[] = [];
    for (const b of [...batches].reverse()) {
      if (left <= 0) break;
      const still = b.qty - (back.get(b.batchId) ?? 0);
      const q = Math.min(still, left);
      if (q <= 0) continue;
      back.set(b.batchId, (back.get(b.batchId) ?? 0) + q);
      plan.push({ batchId: b.batchId, qty: q, resourceId: b.resourceId });
      left -= q;
    }
    const returnId = newId();
    await postMovements(tx, actor, plan.map((p) => ({
      resourceId: p.resourceId, batchId: p.batchId, qtyDelta: p.qty, reason: "return" as const, refType: IPD_COUNTER_RETURN_REF, refId: `${input.saleId}:${returnId}`,
      patientId: a.patientId, encounterId: a.id, occurredAt: at,
    })));
    const creditedUnits = creditedUnitsOf(await postDrugReturnCreditsIn(tx, actor, a, {
      issueId: input.saleId, returnId, batches: plan.map((p) => ({ batchId: p.batchId, qty: p.qty })), reason: input.reason, at,
    }));
    await appendEvent(tx, counterReturned.make({
      payload: { returnId, saleId: input.saleId, admissionId: a.id, itemId: input.itemId, units: input.units, creditedUnits, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { returnId, units: input.units, creditedUnits };
  }), at);
}

