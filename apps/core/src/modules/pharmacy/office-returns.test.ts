import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { MON, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { approveRequest } from "../../kernel/approvals/decisions";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { opdConfig, stockBatches } from "../../kernel/db/schema";
import {
  activateVendor, addVendorDocument, approveSupplierReturn, createSupplierReturn, dispatchSupplierReturn, postMovement, postWriteOff,
  raiseRecall, raiseWriteOff, registerMaterialsApprovalTypes, registerVendor,
} from "../materials";
import { debitNoteDocument, officeDraftReturns, officeRecall, officeReturns, writeOffManifestDocument } from "./office";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PARITY P4 — THE OFFICE'S RETURNS SIDE, ON REAL DATA ═══
 *
 * The office federates: its "needs you today" counts come from materials' expiry list, plan, returns,
 * write-offs and recalls; the debit note and the destruction manifest are the A4 papers that go with
 * the goods; the recall's callback list names the patient and the phone, read under the PHI log. An
 * out-of-state vendor's return is IGST because the letterhead's GSTIN state is not the vendor's.
 */
const NOW = new Date("2026-08-20T06:30:00.000Z"); // noon IST, 20 Aug 2026
const HOSPITAL_GSTIN = "10AAATL6484H1ZP"; // Bihar

describe("the office returns (parity P4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let head: { id: string; actor: Actor };
  let ms: { id: string; actor: Actor };
  const SEED: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const [cfg] = await db.select().from(opdConfig);
    await db.update(opdConfig).set({ letterhead: { ...(cfg!.letterhead as { name: string; addressLines: string[] }), legalName: "LEELAWATI DEVI EDUCATIONAL TRUST", gstin: HOSPITAL_GSTIN } });
    for (const p of ["materials.returns.manage", "materials.bills.manage", "materials.writeoffs.manage", "materials.recall.manage"]) {
      await grantPermissionToRole(db, fx.registry, "pharmacy", p);
    }
    for (const role of ["materials_head", "medical_superintendent"]) await ensureRole(db, role);
    for (const p of ["materials.stock.read", "materials.returns.manage", "materials.returns.approve", "materials.bills.manage", "materials.recall.manage", "materials.writeoffs.manage"]) {
      await grantPermissionToRole(db, fx.registry, "materials_head", p);
    }
    for (const p of ["approvals.requests.decide", "approvals.requests.read"]) await grantPermissionToRole(db, fx.registry, "medical_superintendent", p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    ms = await mkUser(db, "the.ms", ["medical_superintendent"]);
  });
  afterEach(() => { fx.unregister(); });

  async function vendorBatch(code: string, gstin: string | null, batchNo: string, expiryDate: string, qty: number): Promise<{ vendorId: string; batchId: string }> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, SEED, { code, legalName: `${code} Distributors Pvt Ltd`, gstin }));
    await withTx(db, (tx) => addVendorDocument(tx, SEED, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, SEED, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, SEED, vendorId, MON));
    const batchId = newId();
    await db.insert(stockBatches).values({
      id: batchId, itemId: fx.item.crocin, batchNo, expiryDate, mrpPaise: 3_500, mrpUom: "strip", landedCostPaise: 250, vendorId, ownership: "owned", createdBy: SEED.id,
    });
    await withTx(db, (tx) => postMovement(tx, SEED, { resourceId: fx.storeId, batchId, qtyDelta: qty, reason: "grn", refType: "test", refId: batchId, occurredAt: MON }));
    return { vendorId, batchId };
  }

  it("counts what expires with its value, drafts through the office with the hospital's GSTIN state, and prints the debit note", async () => {
    await vendorBatch("ACME", "10AAACA1234A1Z5", "AC-EXP", "2026-08-01", 40); // expired, inside the window
    const del = await vendorBatch("DELHI", "07AAACD1234A1Z5", "DL-NEAR", "2026-09-10", 20); // 21 days to expiry
    const home = await officeReturns(db, fx.pharmacist.actor, NOW);
    expect(home.expiring).toMatchObject({ expired: 1, d30: 1, d60: 1, d90: 1, expiredValuePaise: 10_000, d30ValuePaise: 5_000 });
    expect(home.plan).toMatchObject({ vendors: 2, lines: 2, taxablePaise: 15_000, toDestroy: 0 });

    const drafts = await officeDraftReturns(db, fx.pharmacist.actor, NOW);
    const delhi = drafts.find((r) => r.vendorId === del.vendorId)!;
    expect([delhi.interState, delhi.igstPaise, delhi.cgstPaise]).toEqual([true, 600, 0]); // Delhi → Bihar: IGST
    const acme = drafts.find((r) => r.vendorId !== del.vendorId)!;
    expect([acme.interState, acme.cgstPaise, acme.sgstPaise]).toEqual([false, 600, 600]);

    // Before dispatch the paper is a RETURN NOTE, never mistakable for the voucher.
    const note = await debitNoteDocument(db, fx.pharmacist.actor, acme.id);
    expect(note.html).toContain("RETURN NOTE — NOT A DEBIT NOTE");
    await approveSupplierReturn(db, head.actor, acme.id, NOW);
    const sent = await dispatchSupplierReturn(db, fx.pharmacist.actor, acme.id, NOW);
    const doc = await debitNoteDocument(db, fx.pharmacist.actor, acme.id);
    expect(doc.page).toEqual({ widthMm: 210, heightMm: 297 });
    expect(doc.title).toBe(`${sent.debitNoteNo!} — ACME Distributors Pvt Ltd`);
    for (const s of ["Debit Note", sent.debitNoteNo!, "GSTIN 10AAACA1234A1Z5", "GSTIN 10AAATL6484H1ZP", "CGST", "SGST", "112.00", "AC-EXP"]) {
      expect({ s, found: doc.html.includes(s) }).toEqual({ s, found: true });
    }
    expect(doc.html).not.toContain("RETURN NOTE");
    const after = await officeReturns(db, fx.pharmacist.actor, NOW);
    expect([after.drafts.length, after.awaitingCredit.length]).toEqual([1, 1]);
  });

  it("the destruction manifest prints the agency, its manifest number and the MS who approved it", async () => {
    const { batchId } = await vendorBatch("OPENING-STOCK", null, "OPEN-1", "2026-06-30", 30);
    const home = await officeReturns(db, fx.pharmacist.actor, NOW);
    expect(home.plan).toMatchObject({ vendors: 0, toDestroy: 1, toDestroyValuePaise: 7_500 });
    const w = await raiseWriteOff(db, fx.incharge.actor, { storeResourceId: fx.storeId, reason: "expiry", lines: [{ batchId, qtyBase: 30 }] }, NOW);
    expect((await writeOffManifestDocument(db, fx.incharge.actor, w.id)).html).toContain("CONDEMNATION LIST — NOT YET DESTROYED");
    expect((await officeReturns(db, fx.pharmacist.actor, NOW)).writeOffsAwaiting.map((x) => x.writeOffNo)).toEqual([w.writeOffNo]);
    await approveRequest(db, ms.actor, { approvalId: w.approvalId, note: "condemned" });
    expect((await officeReturns(db, fx.pharmacist.actor, NOW)).writeOffsToPost.map((x) => x.writeOffNo)).toEqual([w.writeOffNo]);
    await postWriteOff(db, fx.incharge.actor, w.id, { disposalAgency: "BioCare CBWTF", manifestNo: "M-2026-077", disposalDate: "2026-08-20" }, NOW);
    const doc = await writeOffManifestDocument(db, fx.incharge.actor, w.id);
    for (const s of ["Destruction Manifest", w.writeOffNo, "BioCare CBWTF", "M-2026-077", "Yellow category (d)", "OPEN-1", "75.00", "the.ms"]) {
      expect({ s, found: doc.html.includes(s) }).toEqual({ s, found: true });
    }
  });

  it("a recall's callback list names the patient and the phone, read-only", async () => {
    const { batchId } = await vendorBatch("ACME", "10AAACA1234A1Z5", "RC-9", "2027-06-30", 50);
    await withTx(db, (tx) => postMovement(tx, fx.pharmacist.actor, {
      resourceId: fx.storeId, batchId, qtyDelta: -6, reason: "consume", patientId: fx.patient.id, encounterId: "V2608150001", occurredAt: MON,
    }));
    const { recall } = await raiseRecall(db, head.actor, { batchId, source: "manufacturer", reference: "MFR/RC/77", reason: "label misprint" }, NOW);
    const seen = await officeRecall(db, head.actor, recall.id);
    expect(seen.dispensed.map((d) => [d.patientId, d.encounterId, d.qtyBase])).toEqual([[fx.patient.id, "V2608150001", 6]]);
    expect(seen.patients[fx.patient.id]).toMatchObject({ uhid: fx.patient.uhid, restricted: false });
    expect((await officeReturns(db, fx.pharmacist.actor, NOW)).openRecalls.map((r) => r.recallNo)).toEqual([recall.recallNo]);
    // One tap: its return, from the office.
    const r = await createSupplierReturn(db, fx.pharmacist.actor, { vendorId: recall.vendorId!, lines: [{ batchId, storeResourceId: fx.storeId, qtyBase: 44, reason: "recalled" }] }, { now: NOW });
    expect(r.lines.map((l) => [l.reason, l.qtyBase])).toEqual([["recalled", 44]]);
  });
});
