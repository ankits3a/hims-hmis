import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { IPD_INTENTS, IpdSaveSummaryDraftSchema, IpdSummaryContentSchema, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  icd10Codes, ipdChargeLines, ipdDischargeConfirmations, ipdDischargeSummaries, ipdDischarges, ipdFinalBills, ipdGatePasses, ipdOrders, orders,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withIdempotency } from "../billing";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { lockAdmission, moveAdmission, onceIpd, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { userNames } from "./admissions";
import { draftForSigning, draftProvenances } from "./copilot-drafts";
import { medicineFlagsOf } from "./discharge-medicines";
import { chargesConfirmed, fitCancelled, fitDeclared, summarySigned } from "./discharge-events";
import { IpdError, IpdRefusal } from "./errors";
import { IPD_DISCHARGE_CONFIRM, IPD_DISCHARGE_DECLARE, IPD_DISCHARGE_VIEW } from "./manifest";
import type { Actor, IpdDischargeDepartment, IpdIntentName, IpdSummaryContent, IpdSummaryView } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E3.2 (#730) — FIT FOR DISCHARGE, THE DEPARTMENTS' CONFIRMATIONS AND THE STRUCTURED SUMMARY (spec SPEC-ipd-core §4.7).
 *
 * - `declareFit` (the treating consultant) moves the admission to `fit_declared`, starts the 3-hour clock (the
 *   workflow's SLA ladder tells the duty manager at the target) and lists the departments that must confirm "no pending
 *   charge". Its answer carries no money (decision 0058).
 * - `confirmCharges`: each department confirms its own (the actor's ROLE decides which department is theirs);
 *   billing confirms LAST. The gate pass refuses while any department is silent (`charges_unconfirmed`).
 * - `cancelFit`: the patient worsened — every unsigned step stops (the confirmations are void with the declaration; a
 *   live gate pass is voided); signed documents stay (the summary stays signed).
 * - The summary is a TEMPLATE (diagnosis with an optional ICD-10 code from the catalogue, course, procedures, condition,
 *   medicines, follow-up, advice, warning signs, pending results). The treating consultant's sign completes it; any other
 *   doctor's sign is a resident's and waits for the consultant's co-sign (§4.7). The copilot drafter is M5: its model id
 *   and prompt version stay null and the label says "Draft" until a named consultant signs.
 *
 * DECIDED (E3.2, standard Indian corporate-hospital practice):
 * - Departments = `ward` always (nursing confirms ward consumables and returns), `lab` / `radiology` when an order placed
 *   since admission is still open, and `billing` always and last. Pharmacy issue to IPD is not in this branch (no
 *   pharmacy lines or orders to read): pharmacy joins the list when the eMAR lane posts its issues (seam).
 * - The treating consultant = the admission's consultant or the one they cover for.
 * - A medicine on the summary: a row the drafter copied from an order must match that ACTIVE order at signing
 *   (`medicine_not_on_active_order`); a typed row is flagged, never refused (E5.4, `discharge-medicines.ts`).
 */

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

/** §4.7: 3 hours from fit to exit for cash (the workflow's `fit_declared` SLA says the same). */
export const IPD_DISCHARGE_TARGET_MINUTES = 180;

/** Which roles confirm which department's charges (an actor confirms only a department one of their roles owns). */
export const IPD_DEPARTMENT_ROLES: Record<IpdDischargeDepartment, readonly string[]> = {
  pharmacy: ["pharmacy", "pharmacy_incharge", "pharmacy_assistant"],
  lab: ["lab_reception", "lab_technician", "pathologist"],
  radiology: ["radiology_receptionist", "radiographer", "radiologist"],
  ot: ["ot_incharge"],
  ward: ["ward_nurse", "nursing_supervisor", "duty_manager"],
  dietary: ["duty_manager"],
  cssd: ["duty_manager"],
  blood_bank: ["pathologist", "lab_technician"],
  billing: ["cashier", "billing_manager"],
};

export function isTreatingConsultant(a: Pick<AdmissionRow, "consultantId" | "coveringFor">, actor: Actor): boolean {
  return actor.id === a.consultantId || (a.coveringFor !== null && actor.id === a.coveringFor);
}

export type DischargeRow = typeof ipdDischarges.$inferSelect;
export type ConfirmationRow = typeof ipdDischargeConfirmations.$inferSelect;

export async function activeDischarge(db: Db | Tx, admissionId: string): Promise<DischargeRow | undefined> {
  return (await db.select().from(ipdDischarges).where(and(eq(ipdDischarges.admissionId, admissionId), eq(ipdDischarges.status, "active"))))[0];
}

export async function confirmationsOf(db: Db | Tx, dischargeId: string): Promise<ConfirmationRow[]> {
  return db.select().from(ipdDischargeConfirmations).where(eq(ipdDischargeConfirmations.dischargeId, dischargeId))
    .orderBy(asc(ipdDischargeConfirmations.department));
}

/** The departments that have not confirmed, billing last (it is the last to be asked). */
export function pendingDepartments(rows: readonly ConfirmationRow[]): IpdDischargeDepartment[] {
  const pending = rows.filter((r) => r.confirmedAt === null).map((r) => r.department as IpdDischargeDepartment);
  return [...pending.filter((d) => d !== "billing"), ...pending.filter((d) => d === "billing")];
}

/** An order kind → the department that confirms it (open kinds; unknown kinds are ignored). */
function departmentOfOrderKind(kind: string): IpdDischargeDepartment | null {
  if (kind === "lab") return "lab";
  if (kind === "imaging" || kind === "radiology") return "radiology";
  if (kind === "pharmacy" || kind === "medication") return "pharmacy";
  return null;
}

/** DECIDED (E3.2): ward and billing always; lab / radiology / pharmacy when the patient has an order still open since admission. */
export async function departmentsFor(tx: Tx, a: AdmissionRow): Promise<{ department: IpdDischargeDepartment; basis: "lines" | "open_orders" | "always" }[]> {
  const out = new Map<IpdDischargeDepartment, "lines" | "open_orders" | "always">();
  const anyLine = (await tx.select({ id: ipdChargeLines.id }).from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, a.id)).limit(1)).length > 0;
  out.set("ward", anyLine ? "lines" : "always");
  if (a.admittedAt !== null) {
    const open = await tx.selectDistinct({ kind: orders.kind }).from(orders)
      .where(and(eq(orders.patientId, a.patientId), eq(orders.status, "open"), gte(orders.placedAt, a.admittedAt)));
    for (const o of open) {
      const d = departmentOfOrderKind(o.kind);
      if (d !== null && !out.has(d)) out.set(d, "open_orders");
    }
  }
  out.set("billing", "always");
  return [...out.entries()].map(([department, basis]) => ({ department, basis }));
}

// ═══════════════════════════════════════════ declare_fit / cancel_fit ═══════════════════════════════════════════

export async function declareFit(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"declare_fit">> {
  const input: Input<"declare_fit"> = IPD_INTENTS.declare_fit.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_DECLARE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "declare_fit", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    const out = await declareFitIn(tx, actor, a, input, at);
    return { admissionId: out.admissionId, state: out.state, clockStartedAt: out.clockStartedAt, targetAt: out.targetAt };
  }), at);
}

/**
 * The fit declaration on the CALLER's transaction, the admission already locked (E4.2 #734: "Fit for discharge" from the
 * round runs here inside the round's own act, so the round and the cascade commit together or not at all). The caller
 * owns permission and idempotency.
 */
export async function declareFitIn(
  tx: Tx, actor: Actor, a: AdmissionRow, input: Pick<Input<"declare_fit">, "when" | "disposition" | "note">, at: Date,
): Promise<Output<"declare_fit"> & { declarationId: string }> {
  if (a.state !== "admitted") throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
  if (!isTreatingConsultant(a, actor)) throw new IpdRefusal("not_treating_consultant");
  await moveAdmission(tx, actor, a, "fit_declared", at, {}, "declare_fit");
  const dischargeId = newId();
  const targetAt = new Date(at.getTime() + IPD_DISCHARGE_TARGET_MINUTES * 60_000);
  await tx.insert(ipdDischarges).values({
    id: dischargeId, admissionId: a.id, status: "active", fitWhen: input.when, disposition: input.disposition,
    note: input.note ?? null, declaredBy: actor.id, declaredAt: at, targetAt,
  });
  for (const d of await departmentsFor(tx, a)) {
    await tx.insert(ipdDischargeConfirmations).values({ id: newId(), dischargeId, admissionId: a.id, department: d.department, basis: d.basis });
  }
  await appendEvent(tx, fitDeclared.make({
    payload: {
      admissionId: a.id, declarationId: dischargeId, disposition: input.disposition, fitWhen: input.when, targetAt: targetAt.toISOString(),
      provenance: provenanceOf(actor),
    },
    actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
  }));
  return { admissionId: a.id, state: "fit_declared" as const, clockStartedAt: at.toISOString(), targetAt: targetAt.toISOString(), declarationId: dischargeId };
}

export async function cancelFit(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"cancel_fit">> {
  const input: Input<"cancel_fit"> = IPD_INTENTS.cancel_fit.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_DECLARE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "cancel_fit", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (a.state !== "fit_declared" && a.state !== "discharging") throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    if (!isTreatingConsultant(a, actor)) throw new IpdRefusal("not_treating_consultant");
    // Review #762 RED 3 ($): a LIVE settled bill must be voided by billing first (#763: `void_bill`); a voided one is no bar.
    const settledBill = (await tx.select({ id: ipdFinalBills.id }).from(ipdFinalBills)
      .where(and(eq(ipdFinalBills.admissionId, a.id), isNull(ipdFinalBills.voidedAt))))[0];
    if (settledBill !== undefined) throw new IpdRefusal("final_bill_exists", undefined, { finalBillId: settledBill.id });
    const d = await activeDischarge(tx, a.id);
    const confirmed = d === undefined ? 0 : (await confirmationsOf(tx, d.id)).filter((c) => c.confirmedAt !== null).length;
    const voided = await tx.update(ipdGatePasses).set({ status: "void", voidedBy: actor.id, voidedAt: at, voidReason: "fit_cancelled" })
      .where(and(eq(ipdGatePasses.admissionId, a.id), eq(ipdGatePasses.status, "issued"))).returning({ id: ipdGatePasses.id });
    await moveAdmission(tx, actor, a, "admitted", at, {}, `cancel_fit: ${input.reason}`);
    if (d !== undefined) {
      await tx.update(ipdDischarges).set({ status: "cancelled", endedBy: actor.id, endedAt: at, cancelReason: input.reason })
        .where(eq(ipdDischarges.id, d.id));
    }
    await appendEvent(tx, fitCancelled.make({
      payload: { admissionId: a.id, declarationId: d?.id ?? a.id, gatePassVoided: voided.length > 0, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { admissionId: a.id, state: "admitted" as const, stepsStopped: confirmed + voided.length, gatePassVoided: voided.length > 0 };
  }), at);
}

// ═══════════════════════════════════════════ confirm_charges ═══════════════════════════════════════════

export async function confirmCharges(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"confirm_charges">> {
  const input: Input<"confirm_charges"> = IPD_INTENTS.confirm_charges.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_CONFIRM);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "confirm_charges", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (a.state !== "fit_declared") throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    // Review #762 item 13: no system bypass — a department is a ROLE; no system caller confirms charges today.
    if (!(await actorHoldsAnyRole(tx, actor.id, [...IPD_DEPARTMENT_ROLES[input.department]]))) {
      throw new IpdRefusal("department_not_yours", undefined, { department: input.department });
    }
    const d = await activeDischarge(tx, a.id);
    if (d === undefined) throw new IpdRefusal("admission_wrong_state", "No fit declaration");
    const rows = await confirmationsOf(tx, d.id);
    const mine = rows.find((r) => r.department === input.department);
    if (mine === undefined) throw new IpdRefusal("department_not_yours", "Not on this discharge's list", { department: input.department });
    // Billing confirms last: every other department first.
    if (input.department === "billing") {
      const others = pendingDepartments(rows).filter((x) => x !== "billing");
      if (others.length > 0) throw new IpdRefusal("charges_unconfirmed", undefined, { pending: others });
    }
    if (mine.confirmedAt === null) {
      await tx.update(ipdDischargeConfirmations).set({ confirmedBy: actor.id, confirmedAt: at, note: input.note ?? null })
        .where(eq(ipdDischargeConfirmations.id, mine.id));
    }
    const pending = pendingDepartments(await confirmationsOf(tx, d.id));
    await appendEvent(tx, chargesConfirmed.make({
      payload: { admissionId: a.id, declarationId: d.id, department: input.department, allConfirmed: pending.length === 0, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { admissionId: a.id, department: input.department, pending, allConfirmed: pending.length === 0 };
  }), at);
}

// ═══════════════════════════════════════════ the summary ═══════════════════════════════════════════

/** The states in which a summary may be written: from admission to the end of the stay (LAMA and death still get one). */
const SUMMARY_STATES: ReadonlySet<string> = new Set([
  "admitted", "transferring", "fit_declared", "discharging", "discharged", "lama", "absconded", "deceased", "transferred_out",
]);

export type SummaryRow = typeof ipdDischargeSummaries.$inferSelect;

export async function summaryOf(db: Db | Tx, admissionId: string): Promise<SummaryRow | undefined> {
  return (await db.select().from(ipdDischargeSummaries).where(eq(ipdDischargeSummaries.admissionId, admissionId)))[0];
}

async function checkIcd10(tx: Tx, content: IpdSummaryContent): Promise<void> {
  const code = content.diagnosis.icd10Code;
  if (code === undefined) return;
  const hit = (await tx.select({ code: icd10Codes.code }).from(icd10Codes).where(eq(icd10Codes.code, code.toUpperCase())))[0];
  if (hit === undefined) throw new IpdError("icd10_unknown", `the ICD-10 catalogue has no code ${code}`, { code });
}

/**
 * Creates the draft (version 1) or replaces it (version + 1). A save after a resident's sign returns it to `draft` (the
 * co-sign must read what is signed). A signed summary is immutable.
 */
export async function saveSummaryDraft(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<IpdSummaryView> {
  const input = IpdSaveSummaryDraftSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_DECLARE);
  const at = opts.now ?? new Date();
  const key = { actorId: actor.id, route: "ipd:save_summary_draft", key: input.idempotencyKey.toLowerCase() };
  await withIdempotency(db, key, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!SUMMARY_STATES.has(a.state)) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    await checkIcd10(tx, input.content);
    const cur = await summaryOf(tx, a.id);
    if (cur?.status === "signed") throw new IpdError("summary_already_signed", "a signed summary cannot be edited", { summaryId: cur.id });
    // E5.4 — text started from a copilot draft: the SERVER stamps the draft's own model id and prompt version (never the
    // client's word for them). Provenance is sticky: a later save without `draftId` keeps what the summary already carries.
    const draft = input.draftId === undefined ? undefined : await draftForSigning(tx, input.draftId, a.id, "discharge");
    if (input.draftId !== undefined && draft === undefined) throw new IpdError("summary_draft_not_found", "no discharge draft of this admission has that id");
    const stamp = draft === undefined ? {} : { draftSource: "copilot_draft", draftModelId: draft.modelId, draftPromptVersion: draft.promptVersion, draftId: draft.id };
    if ((cur?.version ?? 0) !== input.expectedVersion) {
      throw new IpdRefusal("draft_changed", undefined, { version: cur?.version ?? 0 });
    }
    if (cur === undefined) {
      const summaryId = newId();
      await tx.insert(ipdDischargeSummaries).values({
        id: summaryId, admissionId: a.id, status: "draft", version: 1, content: input.content as unknown as Record<string, unknown>,
        draftSource: "person", draftModelId: null, draftPromptVersion: null, draftedBy: actor.id, draftedAt: at, ...stamp,
      });
      return summaryId;
    }
    await tx.update(ipdDischargeSummaries).set({
      status: "draft", version: cur.version + 1, content: input.content as unknown as Record<string, unknown>,
      draftedBy: actor.id, draftedAt: at, residentSignedBy: null, residentSignedAt: null, ...stamp,
    }).where(eq(ipdDischargeSummaries.id, cur.id));
    return cur.id;
  }), at);
  return readSummaryIn(db, input.admissionId);
}

/** A draft for a stay that ended another way (LAMA, death): the summary is still given (§4.7). */
export async function ensureSummaryDraft(tx: Tx, actor: Actor, a: AdmissionRow, at: Date): Promise<string> {
  const cur = await summaryOf(tx, a.id);
  if (cur !== undefined) return cur.id;
  const summaryId = newId();
  const content = IpdSummaryContentSchema.parse({ diagnosis: { text: a.provisionalDiagnosis ?? "To be completed" } });
  await tx.insert(ipdDischargeSummaries).values({
    id: summaryId, admissionId: a.id, status: "draft", version: 1, content: content as unknown as Record<string, unknown>,
    draftSource: "person", draftModelId: null, draftPromptVersion: null, draftedBy: actor.id, draftedAt: at,
  });
  return summaryId;
}

export async function signSummary(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"sign_summary">> {
  const input: Input<"sign_summary"> = IPD_INTENTS.sign_summary.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_DECLARE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "sign_summary", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!SUMMARY_STATES.has(a.state)) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    const s = await summaryOf(tx, a.id);
    if (s?.id !== input.draftId) throw new IpdError("summary_not_found", "no summary draft with that id on this admission");
    if (s.status === "signed") throw new IpdError("summary_already_signed", "the summary is already signed", { summaryId: s.id });
    if (s.version !== input.draftVersion) throw new IpdRefusal("draft_changed", undefined, { version: s.version });
    // E5.4: a row the drafter copied from an order must still match that ACTIVE order (the machine copied it; the order
    // changed since). A row the doctor typed is flagged on the summary, never refused (`discharge-medicines.ts`).
    const stale = medicineFlagsOf(IpdSummaryContentSchema.parse(s.content).medicines.filter((m) => m.source === "order"), await drugOrdersOf(tx, a.id));
    if (stale.length > 0) throw new IpdRefusal("medicine_not_on_active_order", undefined, { medicines: stale.map((f) => f.name) });
    const documentId = s.documentId ?? newId();
    const consultant = isTreatingConsultant(a, actor);
    const status = consultant ? "signed" as const : "awaiting_cosign" as const;
    if (consultant) {
      await tx.update(ipdDischargeSummaries).set({ status, signedBy: actor.id, signedAt: at, documentId }).where(eq(ipdDischargeSummaries.id, s.id));
    } else {
      await tx.update(ipdDischargeSummaries).set({ status, residentSignedBy: actor.id, residentSignedAt: at, documentId })
        .where(eq(ipdDischargeSummaries.id, s.id));
    }
    await appendEvent(tx, summarySigned.make({
      payload: { admissionId: a.id, summaryId: s.id, status, documentId, version: s.version, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { summaryId: s.id, status, signedBy: actor.id, documentId };
  }), at);
}

const drugOrdersOf = (db: Db | Tx, admissionId: string) =>
  db.select().from(ipdOrders).where(and(eq(ipdOrders.admissionId, admissionId), eq(ipdOrders.kind, "drug")));

async function readSummaryIn(db: Db, admissionId: string): Promise<IpdSummaryView> {
  const s = await summaryOf(db, admissionId);
  if (s === undefined) throw new IpdError("summary_not_found", "no summary on this admission yet");
  const content = IpdSummaryContentSchema.parse(s.content);
  const draft = s.draftId === null ? null : (await draftProvenances(db, [s.draftId])).get(s.draftId) ?? null;
  const names = await userNames(db, [s.draftedBy, ...(s.signedBy === null ? [] : [s.signedBy]), ...(s.residentSignedBy === null ? [] : [s.residentSignedBy])]);
  const who = (id: string | null) => (id === null ? null : { id, name: names.get(id) ?? id });
  return {
    summaryId: s.id, admissionId: s.admissionId, status: s.status as IpdSummaryView["status"], version: s.version,
    content,
    provenance: {
      source: s.draftSource as "person" | "copilot_draft", draftModelId: s.draftModelId, draftPromptVersion: s.draftPromptVersion,
      draftedBy: { id: s.draftedBy, name: names.get(s.draftedBy) ?? s.draftedBy }, draftedAt: s.draftedAt.toISOString(), draft,
    },
    // A signed summary's flags are not recomputed against later order changes: it says what was true to its signer's eye.
    medicineFlags: s.status === "signed" ? [] : medicineFlagsOf(content.medicines, await drugOrdersOf(db, admissionId)),
    label: s.status === "signed" ? "Signed" : s.status === "awaiting_cosign" ? "Awaiting co-sign" : "Draft",
    residentSignedBy: who(s.residentSignedBy), signedBy: who(s.signedBy), signedAt: s.signedAt?.toISOString() ?? null,
    documentId: s.documentId,
  };
}

/** The summary as the screen and the print show it (the signed copy names the doctor). No money anywhere in it. */
export async function readSummary(db: Db, actor: Actor, admissionId: string): Promise<IpdSummaryView> {
  await requireIpdPermission(db, actor, IPD_DISCHARGE_VIEW);
  await readAdmission(db, admissionId);
  return readSummaryIn(db, admissionId);
}

