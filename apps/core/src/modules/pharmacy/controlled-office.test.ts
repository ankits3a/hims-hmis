import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkPatient, mkUser, seedOpdBase } from "../../../test/helpers/opd";
import { approveRequest } from "../../kernel/approvals/decisions";
import { setPin } from "../../kernel/auth/identity";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { controlledStockRegister, events, phiAccessLog, stockBatches } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { addMedicine, addSalt } from "../formulary";
import {
  activateVendor, addVendorDocument, captureGrn, createStore, postGrn, postMovement, postWriteOff, raiseWriteOff, registerItem,
  registerMaterialsApprovalTypes, registerVendor, runGateQc,
} from "../materials";
import { recordControlledLicence } from "./controlled";
import { controlledToday, readControlledBalance, readControlledRegister, recordCheck, witnessedAct } from "./controlled-office";
import { controlledRegisterDocument } from "./controlled-print";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P6 — THE OFFICE'S CONTROLLED SIDE: the acts under two keys, the day's card, the registers ═══
 *
 * A GRN into the cabinet is posted only as a witnessed act (the materials route, which names no witness,
 * is refused by the ledger); an NDPS destruction needs the officer the Controller of Drugs nominated
 * (NDPS Rules r.52V(1)); the "needs you today" card names what is missing; the register reads as Form 3H
 * and as the Schedule X register, each patient's read logged.
 */
const T0 = new Date("2026-09-24T04:30:00.000Z"); // 10:00 IST, 24 Sep 2026
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const PIN = "1357";

describe("the office's controlled side (pharmacy P6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let keeper: { id: string; actor: Actor };
  let witness: { id: string; actor: Actor };
  let head: { id: string; actor: Actor };
  let ms: { id: string; actor: Actor };
  let cabinet: string;
  let morphineItem: string;
  let vendor: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db); // registration (a patient's UHID) and the letterhead the registers print under
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    for (const role of ["materials_head", "pharmacy", "pharmacy_incharge", "medical_superintendent"]) await ensureRole(db, role);
    const grants: Record<string, string[]> = {
      materials_head: ["materials.grn.capture", "materials.grn.qc", "materials.items.manage", "materials.vendors.manage", "materials.stock.read", "pharmacy.ndps.witness"],
      pharmacy: ["pharmacy.ndps.witness"],
      pharmacy_incharge: [
        "pharmacy.ndps.custody", "pharmacy.ndps.witness", "pharmacy.licences.manage", "pharmacy.register.read", "materials.writeoffs.manage", "materials.stock.read",
      ],
      medical_superintendent: ["approvals.requests.decide", "approvals.requests.read", "pharmacy.ndps.witness"],
    };
    for (const [role, perms] of Object.entries(grants)) for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    keeper = await mkUser(db, "ph.keeper", ["pharmacy_incharge"]);
    witness = await mkUser(db, "ph.witness", ["pharmacy"]);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    ms = await mkUser(db, "the.ms", ["medical_superintendent"]);
    await setPin(db, witness.id, PIN);
    ({ resourceId: cabinet } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-NDPS", name: "Controlled-drug cabinet", attributes: { controlled: true } })));
    const medicineId = await withTx(db, async (tx) => {
      const salt = await addSalt(tx, head.actor, { name: "Morphine", ndpsClass: "narcotic" });
      return (await addMedicine(tx, head.actor, { brandName: "Morcontin 10", form: "tablet", routeClass: "systemic", strengthLabel: "10 mg", scheduleFlag: "H", salts: [{ saltId: salt.saltId, strength: "10 mg" }] })).medicineId;
    });
    ({ itemId: morphineItem } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code: "MORC10", name: "Morcontin 10 tablet", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: medicineId, storageClass: "narcotic",
      gstRateBps: 1200, hsnCode: "30049099", uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    })));
    vendor = await withTx(db, async (tx) => {
      const { vendorId } = await registerVendor(tx, head.actor, { code: "ACME", legalName: "ACME Pharma Pvt Ltd", gstin: "27AAACA1234A1Z5" });
      for (const [type, number] of [["gst_certificate", "g"], ["pan", "p"], ["drug_licence_20b", "20B-PUN-1"], ["drug_licence_21b", "21B-PUN-1"]] as const) {
        await addVendorDocument(tx, head.actor, vendorId, { type, number });
      }
      await activateVendor(tx, head.actor, vendorId, T0);
      return vendorId;
    });
  });

  const w = { username: "ph.witness", pin: PIN };

  async function inCabinet(batchNo: string, qty: number, expiryDate = "2027-12-31"): Promise<string> {
    const batchId = newId();
    await db.insert(stockBatches).values({ id: batchId, itemId: morphineItem, batchNo, expiryDate, landedCostPaise: 300, ownership: "owned", createdBy: head.id });
    await withTx(db, (tx) => postMovement(tx, keeper.actor, { resourceId: cabinet, batchId, qtyDelta: qty, reason: "grn", occurredAt: at(0), custody: { witnessId: witness.id } }));
    return batchId;
  }

  it("a GRN into the cabinet posts only as a witnessed act; the register copies the supplier, its drug licences and the invoice", async () => {
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, head.actor, {
      vendorId: vendor, source: "challan", storeResourceId: cabinet, challanNo: "CH-9", challanDate: "2026-09-24", invoiceNo: "INV-4411",
      lines: [{ itemId: morphineItem, uom: "strip", qtyInUom: 3, batchNo: "MO-9", expiryDate: "2028-06-30", mrpPaise: 5000, mrpUom: "strip", unitCostPaise: 90 }], now: at(1),
    }));
    await withTx(db, (tx) => runGateQc(tx, head.actor, grnId));
    // The materials route names no witness: the ledger refuses it at the cabinet.
    await expect(withTx(db, (tx) => postGrn(tx, head.actor, grnId, at(2)))).rejects.toMatchObject({ code: "custody_required" });
    // The head witnesses but holds no key.
    await expect(witnessedAct(db, head.actor, w, { act: "grn_post", grnId }, at(3))).rejects.toMatchObject({ code: "custody_not_permitted" });
    await witnessedAct(db, keeper.actor, w, { act: "grn_post", grnId }, at(3));
    const [row] = await db.select().from(controlledStockRegister);
    expect(row).toMatchObject({
      movement: "grn", direction: "in", qtyBase: 30, balanceAfter: 30, holderId: keeper.id, witnessId: witness.id,
      counterparty: "ACME Pharma Pvt Ltd", counterpartyAddress: "GSTIN 27AAACA1234A1Z5", counterpartyLicence: "20B-PUN-1, 21B-PUN-1",
      documentRef: "INV-4411", documentDate: "2026-09-24", ndpsClass: "narcotic",
    });
    expect(await db.select().from(events).where(eq(events.name, "controlled.act_witnessed"))).toHaveLength(1);
  });

  it("destroying an NDPS drug needs the officer the Controller of Drugs nominated (r.52V(1)), recorded on the register beside both keys", async () => {
    const batch = await inCabinet("MO-OLD", 40, "2026-08-31");
    const wo = await raiseWriteOff(db, keeper.actor, { storeResourceId: cabinet, reason: "expiry", lines: [{ batchId: batch, qtyBase: 40 }] }, at(5));
    await approveRequest(db, ms.actor, { approvalId: wo.approvalId, note: "condemned" });
    const disposal = { disposalAgency: "BioCare CBWTF", manifestNo: "M-501", disposalDate: "2026-09-24" };
    await expect(postWriteOff(db, keeper.actor, wo.id, disposal, at(6))).rejects.toMatchObject({ code: "custody_required" });
    await expect(witnessedAct(db, keeper.actor, w, { act: "write_off_post", writeOffId: wo.id, disposal }, at(6))).rejects.toMatchObject({ code: "controlled_act_invalid", message: expect.stringContaining("r.52V(1)") });
    await witnessedAct(db, keeper.actor, w, {
      act: "write_off_post", writeOffId: wo.id, disposal, officer: { name: "S. Patil", designation: "Drugs Inspector, Pune", orderRef: "FDA/NDPS/2026/88" },
    }, at(6));
    const [row] = await db.select().from(controlledStockRegister).where(eq(controlledStockRegister.movement, "adjust"));
    expect(row).toMatchObject({ direction: "out", qtyBase: 40, balanceAfter: 0, counterparty: "BioCare CBWTF", documentRef: expect.stringContaining("M-501") });
    expect(row?.extraWitnesses).toEqual([{ userId: null, name: "S. Patil", role: expect.stringContaining("nominated by the Controller of Drugs, order FDA/NDPS/2026/88") }]);
    const balance = await readControlledBalance(db, keeper.actor, { from: "2026-09-24", to: "2026-09-24" });
    expect(balance.rows[0]).toMatchObject({ received: 40, destroyed: 40, closing: 0, ledgerClosing: 0, reconciled: true });
  });

  it("the day's card names what is missing: both licences, the custodian pair, today's check; a licence inside 60 days is a renewal", async () => {
    const empty = await controlledToday(db, keeper.actor, at(0));
    expect(empty.needsYou.map((n) => n.key)).toEqual(expect.arrayContaining(["licence_missing", "checkNotDone"]));
    expect(empty.needsYou.filter((n) => n.key === "licence_missing")).toHaveLength(2);
    expect(empty.custodianPairHeld).toBe(true); // the keeper holds a key; the witness (another person) witnesses
    await recordControlledLicence(db, keeper.actor, {
      kind: "ndps_rmi", licenceNo: "RMI/MH/117", form: "Form 3G", issuingAuthority: "Controller of Drugs, Maharashtra", holderName: "Sunrise Hospital",
      responsiblePerson: "Dr S. Rao", validFrom: "2024-01-01", validUntil: "2026-11-10",
    }, at(0));
    await expect(recordControlledLicence(db, keeper.actor, {
      kind: "ndps_rmi", licenceNo: "RMI/MH/118", form: "Form 3G", issuingAuthority: "Controller of Drugs", holderName: "Sunrise Hospital",
      responsiblePerson: "Dr S. Rao", validFrom: "2026-01-01", validUntil: "2030-01-01",
    }, at(0))).rejects.toMatchObject({ code: "invalid_controlled_licence" }); // r.52-O: at most three years
    await inCabinet("MO-1", 10);
    await recordCheck(db, keeper.actor, { witness: w, lines: [{ batchId: (await db.select().from(stockBatches))[0]!.id, countedQty: 10 }] }, at(30));
    const later = await controlledToday(db, keeper.actor, at(40));
    expect(later.needsYou.find((n) => n.key === "licence_renewal")).toMatchObject({ params: { until: "2026-11-10", days: 47 } });
    expect(later.needsYou.map((n) => n.key)).not.toContain("checkNotDone");
    expect(later.checkedToday).toMatchObject({ balanced: true });
  });

  it("the registers read by the month, each patient's read logged; Form 3H and the Schedule X register print in their own layout", async () => {
    const batch = await inCabinet("MO-1", 30);
    const patient = await mkPatient(db, head.actor, { name: "Kamala Iyer", addressLine: "4 Temple Street, Pune" });
    await withTx(db, (tx) => postMovement(tx, keeper.actor, {
      resourceId: cabinet, batchId: batch, qtyDelta: -10, reason: "consume", refType: "pharmacy_dispense", occurredAt: at(60), patientId: patient.id,
      custody: { witnessId: witness.id, counterparty: "Kamala Iyer", counterpartyAddress: "4 Temple Street, Pune", patientId: patient.id, documentRef: "INV/9", prescriberName: "Dr Sen", prescriberRegNo: "BMC/12345" },
    }));
    const reg = await readControlledRegister(db, keeper.actor, { register: "ndps", from: "2026-09-24", to: "2026-09-24" });
    expect(reg.rows.map((r) => [r.movement, r.qtyBase, r.balanceAfter, r.uhid])).toEqual([["grn", 30, 30, null], ["consume", 10, 20, patient.uhid]]);
    expect(await db.select().from(phiAccessLog).where(and(eq(phiAccessLog.surface, "pharmacy.controlled_register"), eq(phiAccessLog.patientId, patient.id)))).toHaveLength(1);
    await expect(readControlledRegister(db, keeper.actor, { register: "ndps", from: "2026-08-01", to: "2026-09-24" })).rejects.toMatchObject({ code: "invalid_range" });
    await expect(readControlledRegister(db, head.actor, { register: "ndps", from: "2026-09-24", to: "2026-09-24" })).rejects.toMatchObject({ code: "permission_denied" });

    const f3h = await controlledRegisterDocument(db, keeper.actor, { kind: "form3h", from: "2026-09-24", to: "2026-09-24" });
    expect(f3h.html).toContain("Form 3H — NDPS Rules 1985, r.52R(1)(c)");
    expect(f3h.html).toContain("Morcontin 10 tablet");
    expect(f3h.html).toContain(`${patient.uhid} × 10`);
    const f3e = await controlledRegisterDocument(db, keeper.actor, { kind: "form3e", from: "2026-09-24", to: "2026-09-24", patientId: patient.id });
    expect(f3e.html).toContain("Form 3E");
    expect(f3e.html).toContain("4 Temple Street, Pune");
    const none = await controlledRegisterDocument(db, keeper.actor, { kind: "schedule_x", from: "2026-09-24", to: "2026-09-24" });
    expect(none.html).toContain("No entries in this period."); // morphine is not Schedule X

    // A Schedule X drug in the same cabinet: its own register, in r.65(21)'s columns.
    const ritalin = await withTx(db, async (tx) => {
      const salt = await addSalt(tx, head.actor, { name: "Methylphenidate" });
      const med = await addMedicine(tx, head.actor, { brandName: "Ritalin 10", form: "tablet", routeClass: "systemic", strengthLabel: "10 mg", scheduleFlag: "X", salts: [{ saltId: salt.saltId, strength: "10 mg" }] });
      return (await registerItem(tx, head.actor, {
        code: "RITALIN10", name: "Ritalin 10 tablet", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: med.medicineId, storageClass: "narcotic",
        gstRateBps: 1200, uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
      })).itemId;
    });
    const rb = newId();
    await db.insert(stockBatches).values({ id: rb, itemId: ritalin, batchNo: "RT-1", expiryDate: "2027-03-31", landedCostPaise: 900, ownership: "owned", createdBy: head.id });
    await withTx(db, (tx) => postMovement(tx, keeper.actor, {
      resourceId: cabinet, batchId: rb, qtyDelta: 60, reason: "grn", occurredAt: at(70),
      custody: { witnessId: witness.id, counterparty: "ACME Pharma Pvt Ltd", counterpartyAddress: "GSTIN 27AAACA1234A1Z5", counterpartyLicence: "20B-PUN-1, 21B-PUN-1", documentRef: "INV-4412", documentDate: "2026-09-24" },
    }));
    await withTx(db, (tx) => postMovement(tx, keeper.actor, {
      resourceId: cabinet, batchId: rb, qtyDelta: -10, reason: "consume", refType: "pharmacy_dispense", occurredAt: at(80), patientId: patient.id,
      custody: { witnessId: witness.id, holderRegNo: "BSPC-44120", counterparty: "Kamala Iyer", counterpartyAddress: "4 Temple Street, Pune", patientId: patient.id, documentRef: "PH/26-27/000931", documentDate: "2026-09-24", rxRef: "P2609240031 · Rx rx-9 v1", prescriberName: "Dr Sen", prescriberRegNo: "BMC/12345", collectedBy: "Kamala Iyer (self)", collectedIdProof: "Aadhaar ending 7731" },
    }));
    const x = await controlledRegisterDocument(db, keeper.actor, { kind: "schedule_x", from: "2026-09-24", to: "2026-09-24" });
    expect(x.html).toContain("r.65(21)");
    expect(x.html).toContain("Ritalin 10 tablet");
    expect(x.html).toContain("DL 20B-PUN-1, 21B-PUN-1");
    expect(x.html).toContain("P2609240031 · Rx rx-9 v1");
    expect(x.html).not.toContain("Morcontin"); // a narcotic that is not Schedule X is in Form 3H only
    // The walk's A4 screenshots print these very files (`P6_PRINT_OUT`); a normal run writes nothing.
    if (process.env.P6_PRINT_OUT !== undefined) {
      writeFileSync(join(process.env.P6_PRINT_OUT, "form3h.html"), f3h.html);
      writeFileSync(join(process.env.P6_PRINT_OUT, "schedule-x.html"), x.html);
    }
  });
});
