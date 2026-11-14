import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { openSessionFor } from "../../../../test/helpers/billing";
import { MON, MON2, line, issueRx, seedPharmacyBase, stockIn } from "../../../../test/helpers/pharmacy";
import { testCfg } from "../../../../test/helpers/opd";
import { grantPermissionToRole } from "../../../kernel/auth/permissions";
import { withTx } from "../../../kernel/db/client";
import { addMedicine, addSalt } from "../../formulary";
import { registerItem } from "../../materials";
import { addDispenseLine } from "../add-line";
import { billDispense, previewDispenseBill } from "../bill";
import { claimDispense, findAtCounter } from "../claim";
import { labelFor } from "../label";
import { pickDispense } from "../pick";
import { dispensePaper } from "../print";
import { getDispense } from "../queue";
import { registerSaleItem } from "../sale-items";
import { updatePharmacySettings } from "../settings";
import { declineLine, verifyDispense } from "../verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../../test/helpers/pharmacy";
import type { Db } from "../../../kernel/db/client";
import type { DocumentStore } from "../../../kernel/documents/store";
import type { RxLine } from "../../opd";

/**
 * ACCEPTANCE — issue #1055, spec docs/specs/1055-pharmacy-desk-two-columns.md (owner APPROVED 2026-11-13, ruling 0094):
 * the server half of D5. The layout ids (D1–D4, D6) and D5's screen are the web's
 * (`apps/web/src/screens/acceptance/pharmacy-two-columns-1055.test.tsx`).
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const docs: DocumentStore = { put: async () => {}, get: async () => Buffer.alloc(0), remove: async () => {} };
const PHOTO = { mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) };

describe("a medicine added by hand at the counter (spec #1055)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let A: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    A = fx.pharmacist.actor;
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000 });
  });
  afterEach(() => { fx.unregister(); });

  /** A medicine of its own salt, its own drug item bridged to a sale item, stocked at the counter. */
  async function stocked(code: string, brandName: string, salt: string, scheduleFlag: string, opts: { ndps?: "narcotic"; storage?: "narcotic" } = {}): Promise<string> {
    return withTx(db, async (tx) => {
      const s = await addSalt(tx, A, { name: salt, drugClass: `${salt} class`, ...(opts.ndps === undefined ? {} : { ndpsClass: opts.ndps }) });
      const { medicineId } = await addMedicine(tx, A, {
        brandName, form: "tablet", routeClass: "systemic", strengthLabel: "10 mg", scheduleFlag, salts: [{ saltId: s.saltId, strength: "10 mg" }],
      });
      const { itemId } = await registerItem(tx, HEAD, {
        code, name: `${brandName} tablet`, class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: medicineId, gstRateBps: 1200,
        ...(opts.storage === undefined ? {} : { storageClass: opts.storage }),
        uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, A, itemId);
      return itemId;
    });
  }

  async function ticket(lines: RxLine[]): Promise<string> {
    const { issued } = await issueRx(db, fx, lines, { at: MON });
    const found = await findAtCounter(db, testCfg, A, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, A, { dispenseId: found.dispense.id, door: "rx_qr" }, MON2);
    return found.dispense.id;
  }

  it("spec #1055 D5: a Schedule H medicine is added as 'not prescribed' and another as 'the doctor wrote it on paper' (with the slip photo unless quick desk mode is on); Schedule X and narcotics are refused; each added line is marked 'added at the counter by <name>' with its reason on the ticket and the bill", async () => {
    const brufen = await stocked("IBUG400", "Ibugesic 400", "Ibuprofen-1055", "H");
    const voveran = await stocked("VOVE50", "Voveran 50", "Diclofenac-1055", "H");
    const alprax = await stocked("RSTL05", "Restyl 0.5", "Alprazolam-1055", "X", { storage: "narcotic" });
    const morphine = await stocked("MORC10", "Morcontin 10", "Morphine-1055", "H", { ndps: "narcotic", storage: "narcotic" });
    for (const [itemId, batchNo] of [[brufen, "BR-1"], [voveran, "VV-1"]] as const) {
      await stockIn(db, fx, { itemId, batchNo, qtyBase: 50, expiryDate: "2027-12-31", mrpPaise: 3000 });
    }
    const id = await ticket([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);

    // Not prescribed: a Schedule H medicine is added (ruling 0094), and the line says who added it and why.
    const a = await addDispenseLine(db, docs, A, fx.decls, id, { itemId: brufen, reason: "not_prescribed", qtyBase: 10 }, MON2);
    const byHand = a.lines.find((l) => l.item?.id === brufen);
    expect(byHand).toMatchObject({ status: "open", scheduleFlag: "H", qtyBase: 10, added: { reason: "not_prescribed", by: A.id, byName: "ph.mehta" } });

    // Written on paper: a Schedule H line needs the slip's photo …
    await expect(addDispenseLine(db, docs, A, fx.decls, id, { itemId: voveran, reason: "paper", qtyBase: 10 }, MON2))
      .rejects.toMatchObject({ code: "prescription_required" });
    const b = await addDispenseLine(db, docs, A, fx.decls, id, { itemId: voveran, reason: "paper", qtyBase: 10, photo: PHOTO }, MON2);
    const onPaper = b.lines.find((l) => l.item?.id === voveran);
    expect(onPaper).toMatchObject({ scheduleFlag: "H", added: { reason: "paper", byName: "ph.mehta", documentId: expect.any(String) } });
    // … unless quick desk mode is on (0022).
    await declineLine(db, A, fx.decls, id, onPaper!.lineIdx, "patient changed their mind", MON2);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.licences.manage");
    await withTx(db, (tx) => updatePharmacySettings(tx, A, { quickDesk: true }, MON2));
    const c = await addDispenseLine(db, docs, A, fx.decls, id, { itemId: voveran, reason: "paper", qtyBase: 10 }, MON2);
    expect(c.lines.filter((l) => l.item?.id === voveran && l.status === "open")).toHaveLength(1);

    // Schedule X and narcotics are never added by hand, for either reason.
    for (const reason of ["not_prescribed", "paper"] as const) {
      for (const itemId of [alprax, morphine]) {
        await expect(addDispenseLine(db, docs, A, fx.decls, id, { itemId, reason, qtyBase: 10, photo: PHOTO }, MON2))
          .rejects.toMatchObject({ code: "paper_rx_controlled" });
      }
    }

    // The ticket carries the marks; so does the bill, once paid.
    const shown = await getDispense(db, A, id, MON2);
    expect(shown.lines.filter((l) => l.status === "open" && l.added != null).map((l) => l.added!.reason).sort()).toEqual(["not_prescribed", "paper"]);
    await verifyDispense(db, A, fx.decls, id, { lines: shown.lines.filter((l) => l.status === "open").map((l) => ({ lineIdx: l.lineIdx, qtyBase: 10 })) }, MON2);
    await pickDispense(db, A, fx.decls, id, {}, MON2);
    const p = await previewDispenseBill(db, A, id, MON2, { tender: "cash" });
    await billDispense(db, A, id, { tenders: [{ mode: "cash", amountPaise: p.byTender.cash.netPayablePaise }] }, MON2);
    const label = await labelFor(db, A, id, MON2);
    expect(label.lines.filter((l) => l.added != null).map((l) => l.added)).toEqual(expect.arrayContaining([
      { reason: "not_prescribed", byName: "ph.mehta" }, { reason: "paper", byName: "ph.mehta" },
    ]));
    const { html } = await dispensePaper(db, A, id, MON2, ["pharmacy_bill"]);
    expect(html).toContain("added at the counter by ph.mehta · not prescribed");
    expect(html).toContain("added at the counter by ph.mehta · the doctor wrote it on paper");
  });
});
