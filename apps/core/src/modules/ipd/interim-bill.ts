import { and, asc, eq, gte, inArray, sum } from "drizzle-orm";
import { IPD_RATE_COMPONENTS, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  enteredInErrorMarks, ipdAdmissionDeposits, ipdPayerSplitSnapshots, ipdBedStays, ipdChargeExceptions, ipdChargeLines, refundVouchers, resources, tariffVersions,
} from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { roundTotalToRupee } from "../tariff";
import { lockAdmission, readAdmission, requireIpdPermission } from "./admission-core";
import { userNames } from "./admissions";
import { IPD_ENDED_STATES } from "./charges";
import { IPD_BILL_VIEW } from "./manifest";
import { computePayerSplit } from "./payer-bill";
import type { Actor, IpdBedClass, IpdBillDay, IpdChargeComponent, IpdChargeLineView, IpdInterimBill, IpdRateComponent, IpdSplitSnapshot } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E2.1 (#725) — THE INTERIM BILL (spec §4.3 "interim bill on screen any time", §4.9 H). Posted lines grouped by IST day
 * and component, totals, the deposit paid and the balance. Needs `ipd.bill.view`, which no doctor role holds
 * (decision 0058). Read-only: it posts nothing — days post nightly up to yesterday, so today is not on it yet.
 *
 * Totals: Σ of the lines' own frozen amounts (reversals carry negatives), and the net rounded ONCE to the rupee, as
 * the final invoice will be. Balance = deposit paid (Σ the admission's deposit receipts) − the rounded total.
 */
export async function readInterimBill(db: Db, actor: Actor, admissionId: string): Promise<IpdInterimBill> {
  await requireIpdPermission(db, actor, IPD_BILL_VIEW);
  const a = await readAdmission(db, admissionId);
  const people = await getPatientSummaries(db, actor, [a.patientId]);
  const p = people[0];
  const lines = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, a.id))
    .orderBy(asc(ipdChargeLines.serviceDate), asc(ipdChargeLines.postedAt), asc(ipdChargeLines.id));
  const stays = await db.select({
    bedId: ipdBedStays.bedId, bedClass: ipdBedStays.bedClass, billedClass: ipdBedStays.billedClass,
    startedAt: ipdBedStays.startedAt, endedAt: ipdBedStays.endedAt,
  }).from(ipdBedStays).where(eq(ipdBedStays.admissionId, a.id)).orderBy(asc(ipdBedStays.startedAt));
  const beds = stays.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: resources.id, code: resources.code }).from(resources)
      .where(inArray(resources.id, stays.map((s) => s.bedId)))).map((r) => [r.id, r.code] as const));
  const exceptions = (await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, a.id))
    .orderBy(asc(ipdChargeExceptions.serviceDate), asc(ipdChargeExceptions.component))).filter((x) => x.resolvedAt === null);
  const names = await userNames(db, lines.flatMap((l) => (l.consultantUserId === null ? [] : [l.consultantUserId])));
  const reversed = new Set(lines.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
  const versionId = a.tariffVersionId ?? lines[0]?.tariffVersionId ?? null;
  const version = versionId === null ? undefined
    : (await db.select({ no: tariffVersions.versionNo }).from(tariffVersions).where(eq(tariffVersions.id, versionId)))[0];

  const byDay = new Map<string, IpdBillDay>();
  const byComponent = new Map<IpdChargeComponent, number>(); // IPD/ER train B2: the contracts are final (#893 union)
  const totals = { grossPaise: 0, discountPaise: 0, gstPaise: 0, netPaise: 0 };
  for (const l of lines) {
    const view: IpdChargeLineView = {
      id: l.id, serviceDate: l.serviceDate, component: l.component as IpdChargeComponent,
      billedClass: l.billedClass as IpdBedClass | null, serviceCode: l.serviceCode, serviceName: l.serviceName, qty: l.qty,
      unitPaise: l.unitPaise, grossPaise: l.grossPaise, discountPaise: l.discountPaise, gstPaise: l.cgstPaise + l.sgstPaise,
      netPaise: l.netPaise, source: l.source as IpdChargeLineView["source"],
      consultantName: l.consultantUserId === null ? null : names.get(l.consultantUserId) ?? null,
      reversalOf: l.reversalOf, reversed: reversed.has(l.id), reason: l.reason, postedAt: l.postedAt.toISOString(),
    };
    const day = byDay.get(l.serviceDate) ?? { date: l.serviceDate, billedClass: null, lines: [], totalPaise: 0 };
    day.lines.push(view);
    day.totalPaise += l.netPaise;
    if (l.component === "room" && l.source === "ipd.nightly") day.billedClass = view.billedClass;
    byDay.set(l.serviceDate, day);
    byComponent.set(view.component, (byComponent.get(view.component) ?? 0) + l.netPaise);
    totals.grossPaise += l.grossPaise;
    totals.discountPaise += l.discountPaise;
    totals.gstPaise += view.gstPaise;
    totals.netPaise += l.netPaise;
  }
  const { roundedPaise } = roundTotalToRupee(Math.max(totals.netPaise, 0));
  const deposit = await depositHeldPaise(db, a);
  // E2.2 (#726): the payer split, computed on read; the patient's balance is against the patient-payable part only.
  const payerSplit = await computePayerSplit(db, a, lines);
  const patientRounded = roundTotalToRupee(Math.max(payerSplit.totals.patientPaise, 0)).roundedPaise;
  const ended = (IPD_ENDED_STATES as readonly string[]).includes(a.state) ? a.endedAt : null;
  const nightly = lines.filter((l) => l.source === "ipd.nightly").map((l) => l.serviceDate);
  const name = p === undefined ? null : p.restricted ? p.alias : p.name;
  return {
    admissionId: a.id, admissionNo: a.admissionNo, state: a.state as IpdInterimBill["state"],
    patient: { id: a.patientId, uhid: p?.uhid ?? "", name },
    admittedAt: a.admittedAt?.toISOString() ?? null, dischargedAt: ended?.toISOString() ?? null,
    payerKind: a.payerKind, tariffVersionNo: version?.no ?? null,
    postedThrough: nightly.length === 0 ? null : nightly.reduce((m, d) => (d > m ? d : m)),
    stays: stays.map((s) => ({
      bedCode: beds.get(s.bedId) ?? "", bedClass: s.bedClass as IpdBedClass, billedClass: s.billedClass as IpdBedClass,
      startedAt: s.startedAt.toISOString(), endedAt: s.endedAt?.toISOString() ?? null,
    })),
    days: [...byDay.values()],
    byComponent: IPD_RATE_COMPONENTS.filter((c) => byComponent.has(c)).map((c) => ({ component: c, netPaise: byComponent.get(c)! })),
    totals: { ...totals, roundedPaise },
    depositPaidPaise: deposit,
    balancePaise: deposit - roundedPaise,
    exceptions: exceptions.map((x) => ({
      serviceDate: x.serviceDate, component: x.component as IpdRateComponent | null, billedClass: x.billedClass as IpdBedClass | null,
      serviceCode: x.serviceCode, reason: x.reason as "rate_missing" | "tariff_missing" | "posting_failed", errorCode: x.errorCode,
      failCount: x.failCount, firstSeenAt: x.firstSeenAt.toISOString(),
    })),
    payerSplit,
    patientBalancePaise: deposit - patientRounded,
  };
}

/**
 * Review #756 item 5 — THE DEPOSIT STILL HELD: Σ the admission's deposit receipts (an entered-in-error receipt
 * excepted) minus the patient's ADVANCE refunds issued since the admission was requested, never below zero. Billing's
 * advance refunds are per patient, not per receipt, so a refund in the stay's window is netted against its deposit
 * (DECIDED; the same reading as `cancelAdmission`'s "owed back = min(deposits, advance)").
 */
export async function depositHeldPaise(db: Db | Tx, a: Pick<AdmissionRow, "id" | "patientId" | "requestedAt">): Promise<number> {
  const deps = await db.select({ receiptId: ipdAdmissionDeposits.receiptId, amount: ipdAdmissionDeposits.amountPaise })
    .from(ipdAdmissionDeposits).where(eq(ipdAdmissionDeposits.admissionId, a.id));
  if (deps.length === 0) return 0;
  const void_ = new Set((await db.select({ id: enteredInErrorMarks.docId }).from(enteredInErrorMarks)
    .where(and(eq(enteredInErrorMarks.docType, "receipt"), inArray(enteredInErrorMarks.docId, deps.map((d) => d.receiptId))))).map((r) => r.id));
  const paid = deps.filter((d) => !void_.has(d.receiptId)).reduce((s, d) => s + d.amount, 0);
  const [r] = await db.select({ total: sum(refundVouchers.amountPaise) }).from(refundVouchers).where(and(
    eq(refundVouchers.patientId, a.patientId), eq(refundVouchers.kind, "advance_refund"), gte(refundVouchers.issuedAt, a.requestedAt),
  ));
  return Math.max(0, paid - Number(r?.total ?? 0));
}

/**
 * E2.2 (#726, review 4) — THE DESK PRINTS THE INTERIM BILL: under the admission's lock, in ONE transaction, the lines,
 * the authorisation, the coverage, the approvals, the non-payables and the deposit are read, the split computed and
 * kept (append-only), and that same split is answered — the screen prints exactly what was kept (review 5).
 * `ipd.bill.view`.
 */
export async function printInterimBillSnapshot(db: Db, actor: Actor, admissionId: string, at: Date = new Date()): Promise<IpdSplitSnapshot> {
  await requireIpdPermission(db, actor, IPD_BILL_VIEW);
  return withTx(db, async (tx) => {
    const a = await lockAdmission(tx, admissionId);
    const lines = await tx.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, a.id));
    const split = await computePayerSplit(tx, a, lines);
    const deposit = await depositHeldPaise(tx, a);
    const patientBalancePaise = deposit - roundTotalToRupee(Math.max(split.totals.patientPaise, 0)).roundedPaise;
    const id = newId();
    await tx.insert(ipdPayerSplitSnapshots).values({
      id, admissionId: a.id, kind: "interim", payerPaise: split.totals.payerPaise, patientPaise: split.totals.patientPaise,
      split: { ...split, patientBalancePaise } as unknown as Record<string, unknown>, printedBy: actor.id, printedAt: at,
    });
    return {
      snapshotId: id, printedAt: at.toISOString(), payerPaise: split.totals.payerPaise, patientPaise: split.totals.patientPaise,
      payerSplit: split, patientBalancePaise,
    };
  });
}
