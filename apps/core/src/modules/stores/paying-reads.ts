import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { raiseNotice } from "../../kernel/alerts/notices";
import { istDayString } from "../../kernel/approvals/cumulative";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  grns, itemCategories, items, orgDepartments, resources, storesServiceEntries, supplierBillLines, supplierPaymentRunLines, supplierPaymentRuns, supplierPayments,
  supplierBills, vendors,
} from "../../kernel/db/schema";
import { decidePaymentRun, getPaymentRun, listPaymentRuns, payables, submitPaymentRun, unbilledGrns } from "../materials";
import { STORES_HOLDS_RELEASE } from "./access";
import { apportion, holdsRole, usersWithRole } from "./buying-common";
import { StoresError } from "./errors";
import { heldBillIds, holdsToClear, requirePayingReader } from "./holds";
import { payingSettings } from "./paying-settings";
import { unbilledServiceEntries } from "./service-entries";
import type { Actor, WirePayDue, WirePayRun, WirePayablesByGroup, WirePayingDesk, WireRunToAuthorise } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S6a (#1116, decisions 1, 9; Screens) — THE PAYING DESK'S READS: one book with pharmacy (decision 0099 Q4), so
 * every read here sits on materials' payables, runs and payments, never a second table.
 *
 * `payablesByGroup` splits what is owed by item group (a Stores line's top category; every drug line one group,
 * "drugs") and by cost centre (a service line's department; a GRN line's receiving place — a shelf's department, else
 * the store's code). Each bill's outstanding is shared over its lines by line value, the paisa remainder to the largest
 * shares (`apportion`), so each split sums to `payables`' total to the paisa.
 */
const DUE_SOON_DAYS = 5;
const OWNER_WORDS = { runToAuthorise: ["Run to authorise", "भुगतान रन अधिकृत करें"] } as const;

const daysFrom = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export async function payablesByGroup(db: Db, actor: Actor, now: Date = new Date()): Promise<WirePayablesByGroup> {
  await requirePayingReader(db, actor);
  const p = await payables(db, actor, now);
  const open = p.bills.filter((b) => b.outstandingPaise > 0);
  const lines = open.length === 0 ? [] : await db.select({
    billId: supplierBillLines.billId, taxable: supplierBillLines.taxablePaise, c: supplierBillLines.cgstPaise, s: supplierBillLines.sgstPaise, i: supplierBillLines.igstPaise,
    klass: items.class, trackMode: items.trackMode, catCode: itemCategories.code, catName: itemCategories.name, catParent: itemCategories.parentId,
    sesId: supplierBillLines.sesId, grnStore: grns.storeResourceId,
  }).from(supplierBillLines).innerJoin(items, eq(items.id, supplierBillLines.itemId))
    .leftJoin(itemCategories, eq(itemCategories.id, items.categoryId)).leftJoin(grns, eq(grns.id, supplierBillLines.grnId))
    .where(inArray(supplierBillLines.billId, open.map((b) => b.id)));
  const parents = [...new Set(lines.map((l) => l.catParent).filter((x): x is string => x !== null))];
  const tops = new Map(parents.length === 0 ? [] : (await db.select().from(itemCategories).where(inArray(itemCategories.id, parents))).map((c) => [c.id, c] as const));
  const sesIds = [...new Set(lines.map((l) => l.sesId).filter((x): x is string => x !== null))];
  const sesDept = new Map(sesIds.length === 0 ? [] : (await db.select({ id: storesServiceEntries.id, code: orgDepartments.code, name: orgDepartments.name })
    .from(storesServiceEntries).innerJoin(orgDepartments, eq(orgDepartments.id, storesServiceEntries.departmentId))
    .where(inArray(storesServiceEntries.id, sesIds))).map((r) => [r.id, r] as const));
  const storeIds = [...new Set(lines.map((l) => l.grnStore).filter((x): x is string => x !== null))];
  const stores = new Map(storeIds.length === 0 ? [] : (await db.select({ id: resources.id, code: resources.code, name: resources.name, attributes: resources.attributes })
    .from(resources).where(inArray(resources.id, storeIds))).map((r) => [r.id, r] as const));

  const byGroup = new Map<string, { group: string; name: string; paise: number }>();
  const byDept = new Map<string, { costCentre: string; name: string; paise: number }>();
  const add = <T extends { paise: number }>(m: Map<string, T>, k: string, mk: () => T, paise: number): void => { const v = m.get(k) ?? mk(); v.paise += paise; m.set(k, v); };
  for (const b of open) {
    const mine = lines.filter((l) => l.billId === b.id);
    const shares = apportion(b.outstandingPaise, mine.map((l) => l.taxable + l.c + l.s + l.i));
    if (mine.length === 0) { add(byGroup, "other", () => ({ group: "other", name: "Other", paise: 0 }), b.outstandingPaise); add(byDept, "—", () => ({ costCentre: "—", name: "—", paise: 0 }), b.outstandingPaise); continue; }
    mine.forEach((l, i) => {
      const share = shares[i]!;
      const drug = l.klass === "drug" || l.trackMode === null;
      const top = l.catParent === null ? (l.catCode === null ? null : { code: l.catCode, name: l.catName ?? l.catCode }) : tops.get(l.catParent) ?? null;
      if (drug || top === null) add(byGroup, "drugs", () => ({ group: "drugs", name: "Drugs", paise: 0 }), share);
      else add(byGroup, top.code, () => ({ group: top.code, name: top.name, paise: 0 }), share);
      const d = l.sesId === null ? null : sesDept.get(l.sesId);
      const st = l.grnStore === null ? undefined : stores.get(l.grnStore);
      const attrs = (st?.attributes ?? {}) as { departmentCode?: string };
      const cc = d !== null && d !== undefined ? { code: d.code, name: d.name } : st !== undefined ? { code: attrs.departmentCode ?? st.code, name: st.name } : { code: "—", name: "—" };
      add(byDept, cc.code, () => ({ costCentre: cc.code, name: cc.name, paise: 0 }), share);
    });
  }
  return {
    asOf: p.asOf, totalPaise: p.totalOutstandingPaise,
    byGroup: [...byGroup.values()].sort((a, b) => b.paise - a.paise || a.group.localeCompare(b.group)),
    byDepartment: [...byDept.values()].sort((a, b) => b.paise - a.paise || a.costCentre.localeCompare(b.costCentre)),
  };
}

async function can(db: Db, actor: Actor, perm: string): Promise<boolean> {
  return actor.type === "user" && hasPermission(db, actor.id, perm, "hospital");
}

/** The desk's one read: To book, Holds, Due (MSME due in ≤ 5 days first), Runs, Payments, the switches. */
export async function payingDesk(db: Db, actor: Actor, now: Date = new Date()): Promise<WirePayingDesk> {
  await requirePayingReader(db, actor);
  const today = istDayString(now);
  const flags = {
    book: await can(db, actor, "materials.bills.manage"), release: await can(db, actor, STORES_HOLDS_RELEASE),
    prepare: await can(db, actor, "materials.payments.prepare"), record: await can(db, actor, "materials.payments.record"),
    owner: await holdsRole(db, actor, "owner"), export: await can(db, actor, "pharmacy.tally.export"),
  };
  const grnsToBook = flags.book ? await unbilledGrns(db, actor) : [];
  const sesToBook = flags.book ? await unbilledServiceEntries(db) : [];
  const p = await payables(db, actor, now);
  const openBills = p.bills.filter((b) => b.outstandingPaise > 0);
  const held = await heldBillIds(db, openBills.map((b) => b.id), now);
  const due: WirePayDue[] = openBills.filter((b) => b.dueDate !== null).map((b): WirePayDue => {
    const daysLeft = daysFrom(today, b.dueDate!);
    return {
      billId: b.id, billNo: b.billNo, vendorBillNo: b.vendorBillNo, vendorName: b.vendorName, msme: b.msme, dueDate: b.dueDate!, daysLeft,
      outstandingPaise: b.outstandingPaise, status: held.has(b.id) ? "on_hold" : b.reservedPaise > 0 ? "in_run" : "accepted",
      dueWord: daysLeft < 0 ? "overdue" : b.msme && daysLeft <= DUE_SOON_DAYS ? "due_soon" : null,
    };
  }).sort((a, b) => Number(b.dueWord === "due_soon" && b.msme) - Number(a.dueWord === "due_soon" && a.msme) || a.dueDate.localeCompare(b.dueDate) || a.billNo.localeCompare(b.billNo));
  const runs: WirePayRun[] = [];
  const heldOut = due.filter((d) => d.status === "on_hold").length;
  for (const r of await listPaymentRuns(db, actor, { limit: 30 })) runs.push({ ...(await runLine(db, r.id)), heldOut: r.status === "completed" || r.status === "cancelled" ? 0 : heldOut });
  const pays = await db.select({ p: supplierPayments, runNo: supplierPaymentRuns.runNo, legal: vendors.legalName, trade: vendors.tradeName }).from(supplierPayments)
    .innerJoin(supplierPaymentRuns, eq(supplierPaymentRuns.id, supplierPayments.runId)).innerJoin(vendors, eq(vendors.id, supplierPayments.vendorId))
    .orderBy(desc(supplierPayments.recordedAt)).limit(50);
  return {
    can: flags,
    toBook: [
      ...grnsToBook.map((g) => ({ kind: "grn" as const, id: g.grnId, no: g.grnNo, vendorId: g.vendorId, vendorName: g.vendorName, at: g.postedAt, poNo: g.poNo })),
      ...sesToBook.map((s) => ({ kind: "ses" as const, id: s.id, no: s.sesNo, vendorId: s.vendorId, vendorName: s.vendorName, at: s.at, poNo: s.poNo })),
    ].sort((a, b) => a.at.localeCompare(b.at)),
    holds: await holdsToClear(db, actor, now), due, runs,
    payments: pays.map(({ p: x, runNo, legal, trade }) => ({
      id: x.id, paymentNo: x.paymentNo, runNo, vendorName: trade ?? legal, mode: x.mode, reference: x.reference, paidOn: x.paidOn, amountPaise: x.amountPaise,
    })),
    settings: await payingSettings(db),
  };
}

/** One run as the desk lists it: total, bills, MSME bills. */
async function runLine(db: Db, runId: string): Promise<Omit<WirePayRun, "heldOut">> {
  const [r] = await db.select().from(supplierPaymentRuns).where(eq(supplierPaymentRuns.id, runId));
  if (r === undefined) throw new StoresError("unknown_payment_run", `payment run ${runId} not found`);
  const lines = await db.select({ msme: supplierBills.msme }).from(supplierPaymentRunLines).innerJoin(supplierBills, eq(supplierBills.id, supplierPaymentRunLines.billId))
    .where(eq(supplierPaymentRunLines.runId, runId));
  return { id: r.id, runNo: r.runNo, status: r.status as WirePayRun["status"], totalPaise: r.totalPaise, bills: lines.length, msme: lines.filter((l) => l.msme).length };
}

/** How many payable bills due within the run's week are held out of it now. */
async function heldOutNow(db: Db, now: Date): Promise<number> {
  const due = await db.select({ id: supplierBills.id }).from(supplierBills).where(and(inArray(supplierBills.status, ["accepted", "part_paid"]), isNull(supplierBills.cancelledAt)));
  return (await heldBillIds(db, due.map((d) => d.id), now)).size;
}

/** The owner's phone line for one run (Screens: "₹ total · n bills · m MSME · k held out"). */
export async function runToAuthorise(db: Db, actor: Actor, runId: string, now: Date = new Date()): Promise<WireRunToAuthorise> {
  await requirePayingReader(db, actor);
  const run = await getPaymentRun(db, actor, runId, now);
  const line = await runLine(db, runId);
  const decide = await can(db, actor, "approvals.requests.decide");
  return {
    runId, runNo: run.runNo, status: run.status, totalPaise: run.totalPaise, bills: line.bills, msme: line.msme, heldOut: await heldOutNow(db, now),
    canDecide: decide && run.status === "pending_authorisation" && run.createdBy !== actor.id,
  };
}

/** Authorise (or send back, with a reason) from the phone: the approvals kernel decides, as on the run's own sheet. */
export async function decideRunFromPhone(db: Db, actor: Actor, runId: string, input: { approve: boolean; reason?: string | null }, now: Date = new Date()): Promise<WireRunToAuthorise> {
  const why = input.reason?.trim() ?? "";
  if (!input.approve && why === "") throw new StoresError("reason_required", "say why the run goes back");
  await decidePaymentRun(db, actor, runId, input.approve ? "approve" : "reject", input.approve ? (why === "" ? "Authorised on the phone" : why) : why, now);
  return runToAuthorise(db, actor, runId, now);
}

/** Submit from the desk, and tell the owner: "Run to authorise" (no supplier, no amount). */
export async function submitRunFromDesk(db: Db, actor: Actor, runId: string, now: Date = new Date()): Promise<WireRunToAuthorise> {
  const run = await submitPaymentRun(db, actor, runId, now);
  for (const u of await usersWithRole(db, "owner")) {
    await raiseNotice(db, {
      userId: u, kind: "stores.purchase", title: OWNER_WORDS.runToAuthorise[0], body: `${OWNER_WORDS.runToAuthorise[1]} · ${run.runNo}`,
      refType: "stores_pay_run", refId: runId, sourceKey: `stores-pay-run:${runId}:${run.submittedAt ?? ""}:${u}`, at: now,
    });
  }
  return runToAuthorise(db, actor, runId, now);
}
