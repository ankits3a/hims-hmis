import { and, eq, inArray } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { patients, rolePermissions, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { usersHoldingRoleAtScope } from "../../kernel/workflow/roles";
import { ndpsClassByMedicine } from "../formulary";
import {
  assertNotPoApprover, controlledAdjustmentsToBook, controlledBalance, controlledCheckSheet, controlledChecksOn, controlledRegisterRows,
  dispatchSupplierReturn, getGrn, getSupplierReturn, getTransfer, getWriteOff, itemsByIds, listGrns, listTransfers, listWriteOffs,
  openControlledDiscrepancies, postAdjustments, postGrn, postWriteOff, purchaseOrderOfGrn, recordControlledCheck, receiveStock,
} from "../materials";
import { displayName, resolvePatientId } from "../patients";
import { isIsoDate, istDateOf } from "./config";
import {
  CUSTODY_PERMISSION, LICENCES_PERMISSION, WITNESS_PERMISSION, controlledLicenceStates, controlledStore, requireControlledStore, requireCustodian,
  requirePerson, verifyWitness,
} from "./controlled";
import { PharmacyError } from "./errors";
import { controlledActWitnessed, controlledChecked } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type {
  ControlledBalance, ControlledCheckResult, ControlledRegister, ControlledRegisterRow, ControlledSheetLine, Custody, DisposalInput,
} from "../materials";
import type { ControlledLicenceKind, ControlledLicenceState, WitnessInput } from "./controlled";

/**
 * ═══ PHARMACY P6 — THE OFFICE'S CONTROLLED SIDE (`/pharmacy/office?view=controlled`) ═══
 *
 * What the pharmacist in charge sees and does for the cabinet, federated (it owns nothing: the stock and
 * its register are materials', the licences are `controlled.ts`'s):
 *
 *   - `controlledToday` — "needs you today": a licence missing, lapsed or within 60 days of its end; today's
 *     balance check not done; a check that did not balance; the cabinet acts waiting for two keys; and
 *     whether a custodian and a separate witness exist at all.
 *   - the day's balance check (`checkSheet` / `recordCheck`);
 *   - the acts at the cabinet made under two keys (`witnessedAct`): post a GRN into it, receive a transfer
 *     into it, dispatch a return from it, destroy from it, book a check's variance;
 *   - the registers (`readControlledRegister`) and the balance (`readControlledBalance`).
 */
export const REGISTER_MAX_DAYS = 31;
export const BALANCE_MAX_DAYS = 366;

export type ControlledToday = {
  storePresent: boolean;
  storeId: string | null;
  licences: Record<ControlledLicenceKind, ControlledLicenceState>;
  checkedToday: { countId: string; checkedAt: string; balanced: boolean } | null;
  discrepancies: { countId: string; checkedAt: string }[];
  custodianPairHeld: boolean;
  pending: {
    grns: { id: string; grnNo: string; challanNo: string; status: string }[];
    transfers: { id: string; fromResourceId: string; issuedAt: string }[];
    writeOffs: { id: string; writeOffNo: string; approvalStatus: string }[];
    adjustments: { approvalId: string; countId: string; lines: number; netQty: number }[];
  };
  /** The headline list, in the order a person should act. Keys the screen renders in the operator's language. */
  needsYou: { key: string; params: Record<string, string | number> }[];
};

async function requireReader(db: Db, actor: Actor, what: string): Promise<string> {
  const id = requirePerson(actor, what);
  for (const p of [CUSTODY_PERMISSION, LICENCES_PERMISSION, "pharmacy.register.read"]) {
    if (await hasPermission(db, id, p, "hospital")) return id;
  }
  throw new PharmacyError("permission_denied", `${what} needs ${CUSTODY_PERMISSION}, ${LICENCES_PERMISSION} or pharmacy.register.read`);
}

/**
 * A custodian and a DIFFERENT witness can both be found among active staff: somebody holds the custody
 * grant, and somebody else holds the witness grant. (One person holding both does not make a pair.)
 */
export async function custodianPairHeld(db: Db): Promise<boolean> {
  const holdersOf = async (permission: string): Promise<Set<string>> => {
    const roles = await db.select({ roleKey: rolePermissions.roleKey }).from(rolePermissions).where(eq(rolePermissions.permission, permission));
    const ids = new Set<string>();
    for (const r of roles) for (const u of await withTx(db, (tx) => usersHoldingRoleAtScope(tx, r.roleKey, "hospital"))) ids.add(u);
    if (ids.size === 0) return ids;
    const active = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, [...ids]), eq(users.active, true)));
    return new Set(active.map((a) => a.id));
  };
  const custodians = await holdersOf(CUSTODY_PERMISSION);
  const witnesses = await holdersOf(WITNESS_PERMISSION);
  for (const c of custodians) for (const w of witnesses) if (c !== w) return true;
  return false;
}

export async function controlledToday(db: Db, actor: Actor, now: Date): Promise<ControlledToday> {
  await requireReader(db, actor, "reading the controlled-drug cabinet");
  const store = await controlledStore(db);
  const licences = await controlledLicenceStates(db, now);
  const today = istDateOf(now);
  const checks = store === undefined ? [] : await controlledChecksOn(db, store.id, today);
  const discrepancies = store === undefined ? [] : await openControlledDiscrepancies(db, store.id);
  const pair = await custodianPairHeld(db);
  const pending: ControlledToday["pending"] = { grns: [], transfers: [], writeOffs: [], adjustments: [] };
  if (store !== undefined) {
    const grns = [...await listGrns(db, { storeResourceId: store.id, status: "accepted" }), ...await listGrns(db, { storeResourceId: store.id, status: "partially_accepted" })];
    pending.grns = grns.map((g) => ({ id: g.id, grnNo: g.grnNo, challanNo: g.challanNo, status: g.status }));
    pending.transfers = (await listTransfers(db, { toResourceId: store.id, status: "in_transit" }))
      .map((t) => ({ id: t.id, fromResourceId: t.fromResourceId, issuedAt: t.issuedAt.toISOString() }));
    pending.adjustments = await controlledAdjustmentsToBook(db, store.id);
    try {
      pending.writeOffs = (await listWriteOffs(db, actor, { statuses: ["requested"] }))
        .filter((w) => w.storeResourceId === store.id)
        .map((w) => ({ id: w.id, writeOffNo: w.writeOffNo, approvalStatus: w.approvalStatus }));
    } catch {
      pending.writeOffs = []; // a reader without the write-off grant is not shown them
    }
  }
  const needsYou: ControlledToday["needsYou"] = [];
  if (store === undefined) needsYou.push({ key: "storeMissing", params: {} });
  for (const s of Object.values(licences)) {
    if (s.state !== "current") needsYou.push({ key: `licence_${s.state}`, params: { name: s.name, until: s.licence?.validUntil ?? "" } });
    else if (s.renewalDue) needsYou.push({ key: "licence_renewal", params: { name: s.name, until: s.licence?.validUntil ?? "", days: s.daysLeft ?? 0 } });
  }
  if (!pair) needsYou.push({ key: "noPair", params: {} });
  if (store !== undefined && checks.length === 0) needsYou.push({ key: "checkNotDone", params: { day: today } });
  if (discrepancies.length > 0) needsYou.push({ key: "discrepancies", params: { count: discrepancies.length } });
  const waiting = pending.grns.length + pending.transfers.length + pending.adjustments.length + pending.writeOffs.filter((w) => w.approvalStatus === "granted").length;
  if (waiting > 0) needsYou.push({ key: "actsWaiting", params: { count: waiting } });
  const latest = checks[0];
  return {
    storePresent: store !== undefined, storeId: store?.id ?? null, licences,
    checkedToday: latest === undefined ? null : { countId: latest.countId, checkedAt: latest.checkedAt, balanced: latest.balanced },
    discrepancies, custodianPairHeld: pair, pending, needsYou,
  };
}

// ═══════════════════════════════════ THE DAILY CHECK ═══════════════════════════════════

export async function checkSheet(db: Db, actor: Actor): Promise<ControlledSheetLine[]> {
  await requireCustodian(db, actor, "counting the controlled-drug cabinet");
  const store = await requireControlledStore(db);
  return controlledCheckSheet(db, store.id);
}

export async function recordCheck(
  db: Db, actor: Actor, input: { witness: WitnessInput; lines: { batchId: string; countedQty: number }[]; note?: string }, now: Date,
): Promise<ControlledCheckResult> {
  await requireCustodian(db, actor, "the controlled-drug cabinet's balance check");
  const store = await requireControlledStore(db);
  const witness = await verifyWitness(db, actor, input.witness, now);
  const result = await recordControlledCheck(db, actor, { storeResourceId: store.id, witnessId: witness.userId, lines: input.lines, note: input.note ?? null }, now);
  await withTx(db, (tx) => appendEvent(tx, controlledChecked.make({
    occurredAt: now, actor,
    payload: {
      countId: result.countId, storeResourceId: store.id, holderId: actor.id, witnessId: witness.userId, batches: result.lines.length,
      balanced: result.balanced, approvalId: result.approvalId,
    },
  })));
  return result;
}

// ═══════════════════════════════════ THE ACTS UNDER TWO KEYS ═══════════════════════════════════

export type WitnessedActInput =
  | { act: "grn_post"; grnId: string }
  | { act: "transfer_receive"; transferId: string; lines: { lineId: string; qtyReceived: number }[] }
  | { act: "return_dispatch"; returnId: string; controllerApprovalRef?: string }
  | { act: "write_off_post"; writeOffId: string; disposal?: DisposalInput; officer?: { name: string; designation: string; orderRef: string } }
  | { act: "adjustment_post"; approvalId: string };

async function ndpsOfItems(db: Db, itemIds: readonly string[]): Promise<Map<string, string>> {
  const items = await itemsByIds(db, [...new Set(itemIds)]);
  const meds = [...items.values()].map((i) => i.formularyMedicineId).filter((x): x is string => x !== null);
  const cls = await ndpsClassByMedicine(db, meds);
  const out = new Map<string, string>();
  for (const i of items.values()) {
    const c = i.formularyMedicineId === null ? undefined : cls.get(i.formularyMedicineId);
    if (c !== undefined) out.set(i.id, c);
  }
  return out;
}

/**
 * One act at the cabinet under two keys. The holder holds `pharmacy.ndps.custody`; the witness proves
 * presence with their PIN; the materials act is then called with the witness, and the ledger writes the
 * register row for every movement in the same transaction. What the law adds per act:
 *   - a destruction of an NDPS drug is made "in the presence of an officer nominated by the Controller of
 *     Drugs" (NDPS Rules r.52V(1)) — their name, designation and nomination order are required;
 *   - a narcotic drug does not leave for another institution (a supplier) without the Controller's prior
 *     approval (r.52V(3)) — its reference is required.
 */
export async function witnessedAct(db: Db, actor: Actor, witnessIn: WitnessInput, input: WitnessedActInput, now: Date): Promise<{ act: string; refId: string }> {
  await requireCustodian(db, actor, "an act at the controlled-drug cabinet");
  const store = await requireControlledStore(db);
  const notHere = (what: string): never => {
    throw new PharmacyError("controlled_act_invalid", `${what} is not at the controlled-drug cabinet (${store.code}) — it is done from the office's other sides`);
  };
  let refId: string;
  let custody: Custody | undefined;
  let officers = 0;
  const witness = async (): Promise<Custody> => ({ witnessId: (await verifyWitness(db, actor, witnessIn, now)).userId });
  switch (input.act) {
    case "grn_post": {
      const grn = await getGrn(db, input.grnId);
      if (grn === undefined) throw new PharmacyError("controlled_act_invalid", `GRN ${input.grnId} not found`);
      if (grn.storeResourceId !== store.id) notHere(`GRN ${grn.grnNo}`);
      // PARITY P2's SoD: whoever approved the order does not receive against it — asked here as the route does.
      const poId = await purchaseOrderOfGrn(db, grn.id);
      if (poId !== null) await assertNotPoApprover(db, actor, poId);
      custody = await witness();
      await withTx(db, (tx) => postGrn(tx, actor, grn.id, now, { custody }));
      refId = grn.id;
      break;
    }
    case "transfer_receive": {
      const t = await getTransfer(db, input.transferId);
      if (t === undefined) throw new PharmacyError("controlled_act_invalid", `transfer ${input.transferId} not found`);
      if (t.toResourceId !== store.id) notHere(`transfer ${t.id}`);
      custody = await witness();
      await withTx(db, (tx) => receiveStock(tx, actor, t.id, input.lines, now, undefined, { custody }));
      refId = t.id;
      break;
    }
    case "return_dispatch": {
      const r = await getSupplierReturn(db, actor, input.returnId);
      const here = r.lines.filter((l) => l.storeResourceId === store.id);
      if (here.length === 0) notHere(`return ${r.returnNo}`);
      const cls = await ndpsOfItems(db, here.map((l) => l.itemId));
      const narcotic = here.some((l) => cls.get(l.itemId) === "narcotic");
      const ref = input.controllerApprovalRef?.trim() ?? "";
      if (narcotic && ref === "") {
        throw new PharmacyError("controlled_act_invalid", `return ${r.returnNo} carries a narcotic drug: it leaves for the supplier only with the Controller of Drugs' prior approval (NDPS Rules r.52V(3)) — enter its reference`);
      }
      custody = { ...(await witness()), counterparty: r.vendorName, ...(ref === "" ? {} : { note: `Controller of Drugs' approval ${ref} (NDPS Rules r.52V(3))` }) };
      await dispatchSupplierReturn(db, actor, r.id, now, { custody });
      refId = r.id;
      break;
    }
    case "write_off_post": {
      const w = await getWriteOff(db, actor, input.writeOffId, now);
      if (w.storeResourceId !== store.id) notHere(`write-off ${w.writeOffNo}`);
      const cls = await ndpsOfItems(db, w.lines.map((l) => l.itemId));
      const ndps = w.lines.some((l) => cls.has(l.itemId));
      const o = input.officer;
      const officer = o === undefined ? null : { name: o.name.trim(), designation: o.designation.trim(), orderRef: o.orderRef.trim() };
      if (ndps && (officer === null || officer.name === "" || officer.designation === "" || officer.orderRef === "")) {
        throw new PharmacyError(
          "controlled_act_invalid",
          `write-off ${w.writeOffNo} destroys an NDPS drug: it is done in the presence of an officer nominated by the Controller of Drugs (NDPS Rules r.52V(1)) — enter their name, designation and the nomination order`,
        );
      }
      custody = {
        ...(await witness()),
        ...(officer === null || officer.name === "" ? {} : {
          officers: [{ name: officer.name, role: `${officer.designation}, nominated by the Controller of Drugs, order ${officer.orderRef} (NDPS Rules r.52V(1))` }],
        }),
      };
      officers = custody.officers?.length ?? 0;
      await postWriteOff(db, actor, w.id, input.disposal ?? {}, now, { custody });
      refId = w.id;
      break;
    }
    case "adjustment_post": {
      custody = await witness();
      await postAdjustments(db, actor, input.approvalId, now, { custody });
      refId = input.approvalId;
      break;
    }
  }
  await withTx(db, (tx) => appendEvent(tx, controlledActWitnessed.make({
    occurredAt: now, actor,
    payload: { act: input.act, refId, storeResourceId: store.id, holderId: actor.id, witnessId: custody!.witnessId, officers },
  })));
  return { act: input.act, refId };
}

// ═══════════════════════════════════ THE REGISTERS ═══════════════════════════════════

export type ControlledRegisterView = {
  register: ControlledRegister;
  period: { from: string; to: string };
  rows: (ControlledRegisterRow & { uhid: string | null; restricted: boolean })[];
};

function requireRange(from: string, to: string, maxDays: number): void {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new PharmacyError("invalid_range", `the period must be two dates (YYYY-MM-DD), not "${from}" to "${to}"`);
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days < 1 || days > maxDays) {
    throw new PharmacyError("invalid_range", `the period runs from ${from} to ${to}: it must run forwards and cover at most ${String(maxDays)} days`, { days });
  }
}

/**
 * The cabinet's register over at most a month (the H1 register's rule): a patient's name and address as
 * copied at the hand-over, withheld for a sealed patient from a reader without the sealed-read grant, and
 * one PHI access row per patient shown.
 */
export async function readControlledRegister(
  db: Db, actor: Actor, input: { register: ControlledRegister; from: string; to: string; patientId?: string },
): Promise<ControlledRegisterView> {
  const userId = requirePerson(actor, "reading the controlled-drug register");
  if (!(await hasPermission(db, userId, "pharmacy.register.read", "hospital")) && !(await hasPermission(db, userId, CUSTODY_PERMISSION, "hospital"))) {
    throw new PharmacyError("permission_denied", "reading the controlled-drug register needs pharmacy.register.read or pharmacy.ndps.custody");
  }
  requireRange(input.from, input.to, REGISTER_MAX_DAYS);
  const store = await requireControlledStore(db);
  const rows = await controlledRegisterRows(db, {
    storeResourceId: store.id, fromDay: input.from, toDay: input.to, register: input.register,
    ...(input.patientId === undefined ? {} : { patientId: input.patientId }),
  });
  const ids = [...new Set(rows.map((r) => r.patientId).filter((x): x is string => x !== null))];
  const people = ids.length === 0 ? [] : await db.select({ id: patients.id, uhid: patients.uhid, alias: patients.alias, isConfidential: patients.isConfidential })
    .from(patients).where(inArray(patients.id, ids));
  const person = new Map(people.map((p) => [p.id, p] as const));
  const canSeeConfidential = await hasPermission(db, userId, "pharmacy.register.read_sealed", "hospital")
    || await hasPermission(db, userId, "patients.confidential.read", "hospital");
  const out = rows.map((r) => {
    const p = r.patientId === null ? undefined : person.get(r.patientId);
    const withheld = p !== undefined && p.isConfidential && !canSeeConfidential;
    return {
      ...r,
      counterparty: withheld ? displayName({ name: r.counterparty ?? "", alias: p.alias, isConfidential: true }, false) : r.counterparty,
      counterpartyAddress: withheld ? null : r.counterpartyAddress,
      collectedBy: withheld ? null : r.collectedBy,
      collectedIdProof: withheld ? null : r.collectedIdProof,
      uhid: p?.uhid ?? null, restricted: withheld,
    };
  });
  const reason = `controlled-drug register (${input.register}) ${input.from} to ${input.to}, ${String(out.length)} entries`;
  for (const id of ids) {
    await recordPhiAccess(db, {
      actor, patientId: (await resolvePatientId(db, id)) ?? id, surface: "pharmacy.controlled_register", reason,
      sealed: person.get(id)?.isConfidential ?? false,
    });
  }
  return { register: input.register, period: { from: input.from, to: input.to }, rows: out };
}

export async function readControlledBalance(db: Db, actor: Actor, input: { from: string; to: string }): Promise<ControlledBalance> {
  await requireReader(db, actor, "reading the controlled-drug balance");
  requireRange(input.from, input.to, BALANCE_MAX_DAYS);
  const store = await requireControlledStore(db);
  return controlledBalance(db, { storeResourceId: store.id, fromDay: input.from, toDay: input.to });
}
