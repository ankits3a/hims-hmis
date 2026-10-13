import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import { ipdAdmissions, ipdBedStays, ipdDischarges, ipdGatePasses, ipdStayExits } from "../../kernel/db/schema";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { getPatientSummaries } from "../patients";
import { holdsPermission, readAdmission, requireIpdPermission } from "./admission-core";
import { userNames } from "./admissions";
import { ageInYears } from "./bed-rules";
import { bedWithWard } from "./beds";
import { IPD_DEPARTMENT_ROLES, confirmationsOf, isTreatingConsultant, pendingDepartments, summaryOf } from "./discharge";
import { finalBillRow, finalBillView } from "./discharge-bill";
import {
  IPD_BILL_VIEW, IPD_DISCHARGE_BILL, IPD_DISCHARGE_CONFIRM, IPD_DISCHARGE_DECLARE, IPD_DISCHARGE_EXIT, IPD_DISCHARGE_VIEW, IPD_GATE_PASS,
  IPD_GATE_SCAN,
} from "./manifest";
import type { Actor, IpdDischargeBoard, IpdDischargeDepartment, IpdDischargeStep, IpdDischargeTracker } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E3.2 (#730) — THE DISCHARGE DESK'S READS (spec §4.9 F, staff view): per admission the steps fit → departments → summary
 * → bill → gate pass → exit, each with its instant, the step that is "now", whom it waits for, and the blocker in words.
 * Money only in `bill`, filled for a viewer holding `ipd.bill.view` or `ipd.discharge.bill` (never a doctor — 0058).
 */

const DEPT_WORDS: Record<IpdDischargeDepartment, string> = {
  pharmacy: "Pharmacy", lab: "Lab", radiology: "Radiology", ot: "OT", ward: "Ward nursing", dietary: "Dietary", cssd: "CSSD",
  blood_bank: "Blood bank", billing: "Billing",
};

const CASCADE = new Set(["fit_declared", "discharging"]);
const ENDED_OTHERWISE: Record<string, "lama" | "absconded" | "deceased"> = { lama: "lama", absconded: "absconded", deceased: "deceased" };

type Step = IpdDischargeTracker["steps"][number];
const step = (key: IpdDischargeStep, state: Step["state"], at: Date | null = null, waitingFor: string | null = null): Step =>
  ({ key, state, at: at?.toISOString() ?? null, waitingFor });

function ageSex(dob: Date | null, gender: string, at: Date): string {
  const age = ageInYears(dob, at);
  return `${gender === "male" ? "M" : gender === "female" ? "F" : "O"} ${age === null ? "?" : String(age)}`;
}

async function latestDischarge(db: Db, admissionId: string) {
  return (await db.select().from(ipdDischarges).where(eq(ipdDischarges.admissionId, admissionId)).orderBy(desc(ipdDischarges.declaredAt)).limit(1))[0];
}

async function trackerOf(db: Db, actor: Actor, a: AdmissionRow, at: Date): Promise<IpdDischargeTracker> {
  const [p] = await getPatientSummaries(db, actor, [a.patientId]);
  const stay = (await db.select().from(ipdBedStays).where(eq(ipdBedStays.admissionId, a.id)).orderBy(desc(ipdBedStays.startedAt)).limit(1))[0];
  const bed = stay === undefined ? null : await bedWithWard(db, stay.bedId);
  const d = await latestDischarge(db, a.id);
  const live = d !== undefined && (d.status === "active" || d.status === "completed") ? d : undefined;
  const confirmations = live === undefined ? [] : await confirmationsOf(db, live.id);
  const pending = pendingDepartments(confirmations);
  const summary = await summaryOf(db, a.id);
  const bill = await finalBillRow(db, a.id);
  const pass = (await db.select().from(ipdGatePasses).where(and(eq(ipdGatePasses.admissionId, a.id), or(eq(ipdGatePasses.status, "issued"), eq(ipdGatePasses.status, "used"))))
    .orderBy(desc(ipdGatePasses.issuedAt)).limit(1))[0];
  const exitRow = (await db.select().from(ipdStayExits).where(eq(ipdStayExits.admissionId, a.id)))[0];
  const names = await userNames(db, [
    a.consultantId, ...confirmations.flatMap((c) => (c.confirmedBy === null ? [] : [c.confirmedBy])),
    ...(summary?.signedBy == null ? [] : [summary.signedBy]),
  ]);
  const consultantName = names.get(a.consultantId) ?? a.consultantId;

  const fitDone = live !== undefined;
  const deptsDone = fitDone && pending.length === 0;
  const lastConfirm = confirmations.reduce<Date | null>((m, c) => (c.confirmedAt !== null && (m === null || c.confirmedAt > m) ? c.confirmedAt : m), null);
  const signed = summary?.status === "signed";
  const ended = a.state === "discharged" || a.state === "transferred_out";
  const exitKind = exitRow === undefined ? null : exitRow.kind as "lama" | "dama" | "absconded" | "deceased";

  let steps: Step[];
  if (ENDED_OTHERWISE[a.state] !== undefined) {
    steps = [
      fitDone ? step("fit", "done", live.declaredAt) : step("fit", "skipped"),
      step("departments", "skipped"),
      signed ? step("summary", "done", summary.signedAt) : step("summary", "now", null, `Dr ${consultantName}`),
      bill !== undefined ? step("bill", "done", bill.settledAt) : step("bill", "now", null, "Billing"),
      step("gate_pass", "skipped"),
      step("exit", "done", exitRow?.at ?? a.endedAt),
    ];
  } else {
    const waitDepts = pending.map((x) => DEPT_WORDS[x]).join(", ");
    steps = [
      fitDone ? step("fit", "done", live.declaredAt) : step("fit", a.state === "admitted" ? "now" : "waiting", null, `Dr ${consultantName}`),
      deptsDone ? step("departments", "done", lastConfirm) : step("departments", fitDone ? "now" : "waiting", null, fitDone ? waitDepts : null),
      signed ? step("summary", "done", summary.signedAt)
        : step("summary", fitDone ? "now" : "waiting", null, summary?.status === "awaiting_cosign" ? `Co-sign: Dr ${consultantName}` : `Dr ${consultantName}`),
      bill !== undefined ? step("bill", "done", bill.settledAt) : step("bill", deptsDone ? "now" : "waiting", null, deptsDone ? "Billing" : null),
      pass !== undefined ? step("gate_pass", "done", pass.issuedAt)
        : step("gate_pass", deptsDone && signed && bill !== undefined ? "now" : "waiting", null, deptsDone && signed && bill !== undefined ? "Desk" : null),
      ended ? step("exit", "done", pass?.scannedAt ?? a.endedAt) : step("exit", a.state === "discharging" ? "now" : "waiting", null, a.state === "discharging" ? "Gate scan" : null),
    ];
  }

  const blockers: string[] = [];
  if (a.state === "fit_declared") {
    if (pending.length > 0) blockers.push(`Waiting: ${pending.map((x) => DEPT_WORDS[x]).join(", ")}`);
    if (!signed) blockers.push(summary?.status === "awaiting_cosign" ? "Summary needs the consultant's co-sign" : "Summary not signed");
    if (bill === undefined) blockers.push("Final bill not settled");
  }

  const may = async (perm: string) => holdsPermission(db, actor, perm);
  const [mDeclare, mConfirm, mBill, mPass, mScan, mExit, mMoney] = await Promise.all([
    may(IPD_DISCHARGE_DECLARE), may(IPD_DISCHARGE_CONFIRM), may(IPD_DISCHARGE_BILL), may(IPD_GATE_PASS), may(IPD_GATE_SCAN),
    may(IPD_DISCHARGE_EXIT), may(IPD_BILL_VIEW),
  ]);
  const treating = isTreatingConsultant(a, actor);
  const confirmable: IpdDischargeDepartment[] = [];
  if (mConfirm && a.state === "fit_declared") {
    for (const dep of pending) {
      if (dep === "billing" && pending.length > 1) continue;
      if (await actorHoldsAnyRole(db as unknown as Tx, actor.id, [...IPD_DEPARTMENT_ROLES[dep]])) confirmable.push(dep);
    }
  }
  const billable = ["fit_declared", "lama", "absconded", "deceased"].includes(a.state);
  return {
    admissionId: a.id, admissionNo: a.admissionNo, state: a.state as IpdDischargeTracker["state"],
    patient: {
      id: a.patientId, uhid: p?.uhid ?? "", name: p === undefined ? null : p.restricted ? p.alias : p.name,
      ageSex: p === undefined ? "" : ageSex(p.dob, p.administrativeGender, at),
    },
    bedCode: bed?.code ?? null, wardName: bed?.wardName ?? null,
    consultant: { id: a.consultantId, name: consultantName },
    disposition: (live?.disposition ?? null) as IpdDischargeTracker["disposition"],
    fitAt: live?.declaredAt.toISOString() ?? null, targetAt: live?.targetAt.toISOString() ?? null,
    steps,
    departments: confirmations.map((c) => ({
      department: c.department as IpdDischargeDepartment, basis: c.basis as "lines" | "open_orders" | "always",
      confirmedAt: c.confirmedAt?.toISOString() ?? null, confirmedBy: c.confirmedBy === null ? null : names.get(c.confirmedBy) ?? c.confirmedBy,
    })),
    summary: {
      status: (summary?.status ?? "none") as IpdDischargeTracker["summary"]["status"],
      signedBy: summary?.signedBy == null ? null : names.get(summary.signedBy) ?? summary.signedBy, version: summary?.version ?? 0,
    },
    gatePass: pass === undefined ? null : {
      code: pass.code, status: pass.status as "issued" | "used", kind: pass.kind as "discharge" | "transfer_out", duesRecorded: mMoney || mBill ? pass.duesRecorded : null,
      issuedAt: pass.issuedAt.toISOString(), scannedAt: pass.scannedAt?.toISOString() ?? null, receivingHospital: pass.receivingHospital?.name ?? null,
    },
    exit: exitKind === null ? null : { kind: exitKind, at: exitRow!.at.toISOString() },
    blocker: blockers.length === 0 ? null : blockers.join(" · "),
    bill: mMoney || mBill ? await finalBillView(db, a, at).catch(() => null) : null,
    can: {
      declareFit: mDeclare && treating && a.state === "admitted",
      cancelFit: mDeclare && treating && CASCADE.has(a.state),
      confirm: confirmable,
      editSummary: mDeclare && summary?.status !== "signed" && a.state !== "requested" && a.state !== "reserved" && a.state !== "cancelled",
      signSummary: mDeclare && summary !== undefined && summary.status !== "signed",
      settle: mBill && billable && bill === undefined && (a.state !== "fit_declared" || pending.length === 0),
      issueGatePass: mPass && a.state === "fit_declared" && deptsDone && signed && bill !== undefined,
      scan: mScan && a.state === "discharging",
      exit: mExit && (a.state === "admitted" || a.state === "fit_declared"),
    },
  };
}

export async function readDischargeTracker(db: Db, actor: Actor, admissionId: string, opts: { now?: Date } = {}): Promise<IpdDischargeTracker> {
  await requireIpdPermission(db, actor, IPD_DISCHARGE_VIEW);
  return trackerOf(db, actor, await readAdmission(db, admissionId), opts.now ?? new Date());
}

/** The desk list: admissions in the cascade (fit declared, gate pass out) and those whose stay ended today (IST). */
export async function readDischargeBoard(db: Db, actor: Actor, opts: { now?: Date } = {}): Promise<IpdDischargeBoard> {
  await requireIpdPermission(db, actor, IPD_DISCHARGE_VIEW);
  const at = opts.now ?? new Date();
  const midnight = new Date(`${istDayString(at)}T00:00:00+05:30`);
  const rows = await db.select().from(ipdAdmissions).where(or(
    inArray(ipdAdmissions.state, ["fit_declared", "discharging"]),
    and(inArray(ipdAdmissions.state, ["discharged", "transferred_out", "lama", "absconded", "deceased"]), gte(ipdAdmissions.endedAt, midnight)),
  )).orderBy(desc(ipdAdmissions.updatedAt)).limit(100);
  const out: IpdDischargeBoard["rows"] = [];
  for (const a of rows) {
    const t = await trackerOf(db, actor, a, at);
    out.push({
      admissionId: a.id, admissionNo: a.admissionNo, state: t.state, patientName: t.patient.name, uhid: t.patient.uhid, bedCode: t.bedCode,
      fitAt: t.fitAt, targetAt: t.targetAt, nextStep: t.steps.find((s) => s.state === "now")?.key ?? null, blocker: t.blocker,
    });
  }
  // Oldest fit first: the one closest to breaching the 3-hour target is on top.
  out.sort((x, y) => (x.fitAt ?? "9").localeCompare(y.fitAt ?? "9"));
  return { rows: out };
}

