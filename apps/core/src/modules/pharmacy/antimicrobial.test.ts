import { eq } from "drizzle-orm";
import { openSessionFor } from "../../../test/helpers/billing";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { assignRole, grantPermissionToRole } from "../../kernel/auth/permissions";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { approvals, formularyMedicines } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { AWARE_LIST, addMedicine, addSalt, classifyAwareMedicines, updateMedicine } from "../formulary";
import { createStore } from "../materials";
import { askSteward, judgeSteward, stewardStates, stewardToday } from "./antimicrobial";
import { registerPharmacyApprovalTypes } from "./approval-types";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { RETAIL_PHARMACY_STORE_CODE } from "./config";
import { PharmacyError } from "./errors";
import { handOverDispense } from "./handover";
import { buildNeeds } from "./office-needs";
import { pickDispense } from "./pick";
import { previewRetailSale, recordRetailLicence, sellRetail } from "./retail";
import { verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { NeedInputs } from "./office-needs";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";

class NoDocs implements DocumentStore {
  async put(): Promise<void> {}
  async get(): Promise<Buffer> { throw new Error("none"); }
  async remove(): Promise<void> {}
}

/**
 * ═══ PHARMACY STAGE D5 — THE RESERVE / RESTRICTED ANTIMICROBIAL GATE ═══
 *
 * Crocin stands in for meropenem: the fixture's formulary has no antibiotic, and what the gate reads is the product's
 * `antimicrobial_restricted` flag, not its name. What this stage must not get wrong:
 *   1. a restricted line does not pass verify, nor hand-over, without a GRANTED steward approval;
 *   2. the approval is bound to THIS dispense (and moiety set) — another dispense's grant does not carry over;
 *   3. a steward may not approve their own prescription;
 *   4. while nobody holds the role, the refusal says the hospital must appoint one.
 */
const refusal = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try { await p; } catch (e) { if (e instanceof PharmacyError) return { code: e.code, message: e.message }; throw e; }
  return { code: "no refusal", message: "" };
};

const ASK = { indication: "culture-proven ESBL pyelonephritis", cultureSent: true, plannedDays: 7 };

describe("the restricted-antimicrobial gate (pharmacy stage D5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let steward: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await registerPharmacyApprovalTypes(db, fx.base.activator);
    await db.update(formularyMedicines).set({ antimicrobialRestricted: true, awareCategory: "Reserve" }).where(eq(formularyMedicines.id, fx.med.crocin));
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 200 });
  });
  afterEach(() => { fx.unregister(); });

  const appoint = async (username = "dr.steward"): Promise<void> => { steward = await mkUser(db, username, ["antimicrobial_steward"]); };

  /** A Crocin ticket claimed at `when`: ready for the check. */
  async function claimed(when: Date = MON2): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })], { at: when });
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, when);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, when);
    return r.dispense.id;
  }
  const verify = (id: string, when: Date = MON2) => verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, when);
  async function toBilled(id: string, when: Date = MON2): Promise<void> {
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, when);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, when);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, when);
  }
  const grant = async (id: string, by: Actor, when: Date = MON2): Promise<string> => {
    const asked = await askSteward(db, fx.pharmacist.actor, id, 0, ASK, when);
    await approveRequest(db, by, { approvalId: asked.approvalId!, note: "agreed — 7 days, de-escalate on sensitivities" });
    return asked.approvalId!;
  };

  it("refuses at verify a restricted line with no approval, naming the drug and the authorisation sheet", async () => {
    await appoint();
    const id = await claimed();
    const r = await refusal(verify(id));
    expect(r.code).toBe("antimicrobial_steward_approval_required");
    expect(r.message).toContain("Crocin 500");
    expect(r.message).toContain("ask the antimicrobial steward from the authorisation sheet");
    // An unrestricted medicine on the same counter is untouched by the gate.
    await db.update(formularyMedicines).set({ antimicrobialRestricted: false }).where(eq(formularyMedicines.id, fx.med.crocin));
    await verify(id);
  });

  it("while nobody holds antimicrobial_steward, the refusal says the hospital must appoint one — and the ask is refused too", async () => {
    const id = await claimed();
    const r = await refusal(verify(id));
    expect(r.code).toBe("antimicrobial_steward_not_appointed");
    expect(r.message).toContain("must appoint one");
    expect((await refusal(askSteward(db, fx.pharmacist.actor, id, 0, ASK, MON2))).code).toBe("antimicrobial_steward_not_appointed");
    const today = await stewardToday(db, MON2);
    expect(today.notAppointed).toBe(true);
  });

  it("passes verify and hand-over once the steward has granted it; pending and rejected do not", async () => {
    await appoint();
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    const id = await claimed();
    const asked = await askSteward(db, fx.pharmacist.actor, id, 0, ASK, MON2);
    expect(asked.status).toBe("pending");
    // Idempotent: asking again returns the pending one.
    expect((await askSteward(db, fx.pharmacist.actor, id, 0, ASK, MON2)).approvalId).toBe(asked.approvalId);
    expect((await refusal(verify(id))).code).toBe("antimicrobial_steward_approval_required");
    await rejectRequest(db, steward.actor, { approvalId: asked.approvalId!, note: "not indicated — narrower agent" });
    expect((await stewardStates(db, fx.pharmacist.actor, id))[0]).toMatchObject({ status: "rejected", drug: "Crocin 500", appointed: true });
    expect((await refusal(verify(id))).code).toBe("antimicrobial_steward_approval_required");

    await grant(id, steward.actor);
    expect((await stewardStates(db, fx.pharmacist.actor, id))[0]).toMatchObject({ status: "granted" });
    await verify(id);
    await toBilled(id);
    const handed = await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3);
    expect(handed.status).toBe("handed_over");
  });

  it("refuses at hand-over a line restricted after verify, until the steward grants it", async () => {
    await appoint();
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await db.update(formularyMedicines).set({ antimicrobialRestricted: false }).where(eq(formularyMedicines.id, fx.med.crocin));
    const id = await claimed();
    await verify(id);
    await toBilled(id);
    // The hospital restricts it while the patient is at the window: the last gate asks again.
    await db.update(formularyMedicines).set({ antimicrobialRestricted: true }).where(eq(formularyMedicines.id, fx.med.crocin));
    expect((await refusal(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3))).code).toBe("antimicrobial_steward_approval_required");
    await grant(id, steward.actor, MON3);
    expect((await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3)).status).toBe("handed_over");
  });

  it("a grant bound to ANOTHER dispense does not carry over — not for the same patient, drug or day", async () => {
    await appoint();
    const first = await claimed(MON2);
    await grant(first, steward.actor);
    await verify(first);
    const second = await claimed(MON3);
    const r = await refusal(verify(second, MON3));
    expect(r.code).toBe("antimicrobial_steward_approval_required");
    // And the binding is asked of the ROW: the first dispense's grant, offered for the second, is not bound to it.
    const [row] = await db.select().from(approvals);
    const v = judgeSteward([row!], { dispenseId: second, patientId: fx.patient.id, key: row!.subjectId.split("|")[1]! }, null);
    expect(v.status).toBe("none");
  });

  it("a steward may not approve their own prescription: the prescriber's grant is refused at verify, another steward's passes", async () => {
    await appoint();
    // The prescribing doctor also holds the steward role (an ID physician who prescribes).
    await assignRole(db, { userId: fx.doctor.userId, roleKey: "antimicrobial_steward", scopeType: "hospital" });
    const id = await claimed();
    await grant(id, fx.doctor.actor);
    const r = await refusal(verify(id));
    expect(r.code).toBe("antimicrobial_self_approval");
    expect(r.message).toContain("may not approve their own prescription");
    expect((await stewardStates(db, fx.pharmacist.actor, id))[0]).toMatchObject({ status: "self_approved" });
    // The counter asks again; the other steward decides.
    await grant(id, steward.actor);
    await verify(id);
  });

  it("the walk-in counter never sells a restricted antimicrobial on an outside prescription — refused, not gated", async () => {
    await appoint();
    await ensureRole(db, "pharmacy_incharge");
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
    const incharge = await mkUser(db, "ph.d5.incharge", ["pharmacy_incharge"]);
    const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
    const { resourceId: retailId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }));
    await recordRetailLicence(db, incharge.actor, {
      form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001", validFrom: "2026-01-01", validTo: "2030-12-31", pharmacistInCharge: "A. Kulkarni",
    }, MON);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 50, resourceId: retailId });
    const lines = [{ medicineId: fx.med.crocin, qtyBase: 10 }];
    const p = await previewRetailSale(db, fx.pharmacist.actor, { lines }, MON2);
    const r = await refusal(sellRetail(db, new NoDocs(), fx.pharmacist.actor, {
      customer: { register: { name: "Ramesh Patil", sex: "male", ageYears: 52, phone: "9822001122" } },
      lines, tenders: [{ mode: "cash", amountPaise: p.totals.netPayablePaise }],
    }, undefined, MON2));
    expect(r.code).toBe("restricted_antimicrobial_walk_in");
    expect(r.message).toContain("Crocin 500");
  });

  it("the office's LAW side: red when restricted products exist and nobody is appointed; amber per ask waiting over four hours", async () => {
    const empty: NeedInputs = { buy: null, pay: null, returns: null, grns: null, retail: null, cabinet: null, pharmacists: null, adr: null, incidents: null, cold: null, steward: null };
    const out = buildNeeds({ ...empty, steward: { notAppointed: true, waiting: [{ approvalId: "a1", dispenseNo: "RX-1", requestedAt: new Date(MON.getTime() - 5 * 3_600_000).toISOString() }] } }, MON);
    expect(out.sides).toEqual(["LAW"]);
    expect(out.rows.map((r) => [r.kind, r.tier, r.clock.tone])).toEqual([["steward_not_appointed", 0, "rd"], ["steward_approval_waiting", 3, "gd"]]);
    await appoint();
    const id = await claimed();
    await askSteward(db, fx.pharmacist.actor, id, 0, ASK, MON2);
    expect((await stewardToday(db, new Date(Date.now() + 3 * 3_600_000))).waiting).toHaveLength(0);
    expect((await stewardToday(db, new Date(Date.now() + 5 * 3_600_000))).waiting).toHaveLength(1);
    expect((await stewardToday(db, MON2)).notAppointed).toBe(false);
  });

  it("the AWaRe seed fills nulls by moiety set and route, raises restricted, and never overwrites a pharmacist's value", async () => {
    const ids = await withTx(db, async (tx) => {
      const mero = await addSalt(tx, fx.pharmacist.actor, { name: "meropenem" });
      const fosfo = await addSalt(tx, fx.pharmacist.actor, { name: "fosfomycin" });
      const amox = await addSalt(tx, fx.pharmacist.actor, { name: "amoxicillin" });
      const clav = await addSalt(tx, fx.pharmacist.actor, { name: "clavulanic acid" });
      const mk = async (brandName: string, form: string, salts: string[], routeClass: "systemic" | "topical" = "systemic") =>
        (await addMedicine(tx, fx.pharmacist.actor, { brandName, form, routeClass, strengthLabel: null, salts: salts.map((saltId) => ({ saltId })) })).medicineId;
      return {
        meronem: await mk("Meronem 1 g", "Powder for solution for injection", [mero.saltId]),
        fosfoIv: await mk("Fosfocin 4 g", "Powder for solution for infusion", [fosfo.saltId]),
        fosfoOral: await mk("Fosfocin 3 g", "Granules for oral solution", [fosfo.saltId]),
        augmentin: await mk("Augmentin 625", "Oral tablet", [amox.saltId, clav.saltId]),
        amoxCream: await mk("Amox cream", "Cream", [amox.saltId], "topical"),
        manual: await mk("Mox 500", "Oral capsule", [amox.saltId]),
      };
    });
    // A pharmacist classified this one first — the seed must leave it alone.
    await db.update(formularyMedicines).set({ awareCategory: "Watch" }).where(eq(formularyMedicines.id, ids.manual));
    const report = await withTx(db, (tx) => classifyAwareMedicines(tx, fx.base.activator));
    const read = async (id: string) => (await db.select({ c: formularyMedicines.awareCategory, r: formularyMedicines.antimicrobialRestricted }).from(formularyMedicines).where(eq(formularyMedicines.id, id)))[0];
    expect(await read(ids.meronem)).toEqual({ c: "Watch", r: true }); // a carbapenem: Watch, restricted by policy
    expect(await read(ids.fosfoIv)).toEqual({ c: "Reserve", r: true });
    expect(await read(ids.fosfoOral)).toEqual({ c: "Watch", r: false });
    expect(await read(ids.augmentin)).toEqual({ c: "Access", r: false });
    expect(await read(ids.amoxCream)).toEqual({ c: null, r: false });
    expect(await read(ids.manual)).toEqual({ c: "Watch", r: false });
    // The fixture's own Azee 500 (azithromycin) is Watch too: the seed reads the whole catalogue.
    expect(await read(fx.med.azithro)).toEqual({ c: "Watch", r: false });
    expect(report.classified).toEqual({ Access: 1, Watch: 3, Reserve: 1 });
    expect(report.restricted).toBe(2);
    expect(report.moietiesInCatalogue).toEqual(expect.arrayContaining(["meropenem", "fosfomycin", "amoxicillin", "clavulanic acid"]));
    // A second run changes nothing.
    expect((await withTx(db, (tx) => classifyAwareMedicines(tx, fx.base.activator))).classified).toEqual({ Access: 0, Watch: 0, Reserve: 0 });
  });

  it("a pharmacist sets the class and the restriction under formulary.manage; the database refuses a class AWaRe does not have", async () => {
    await withTx(db, (tx) => updateMedicine(tx, fx.pharmacist.actor, fx.med.azithro, { awareCategory: "Watch", antimicrobialRestricted: true }));
    const [row] = await db.select({ c: formularyMedicines.awareCategory, r: formularyMedicines.antimicrobialRestricted }).from(formularyMedicines).where(eq(formularyMedicines.id, fx.med.azithro));
    expect(row).toEqual({ c: "Watch", r: true });
    await expect(db.update(formularyMedicines).set({ awareCategory: "Unrestricted" }).where(eq(formularyMedicines.id, fx.med.azithro))).rejects.toThrow();
  });

  it("the cited list: every moiety set is written as the seed compares it (alphabetical, lower case) and none is listed twice for one route", () => {
    for (const e of AWARE_LIST) {
      const parts = e.moieties.split("+");
      expect([...parts].sort()).toEqual(parts);
      expect(e.moieties).toBe(e.moieties.toLowerCase());
      if (e.category === "Reserve") expect(e.restricted).toBe(true);
    }
    const keys = AWARE_LIST.map((e) => `${e.moieties}@${e.route}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
