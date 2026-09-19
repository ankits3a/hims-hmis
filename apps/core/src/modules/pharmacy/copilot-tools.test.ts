import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { permissionCheckFor, runTool } from "../../kernel/copilot/catalog";
import { previewDispenseBill, billDispense } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { medicineTermOf, pharmacyCopilotTools } from "./copilot-tools";
import { pickDispense } from "./pick";
import { verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { CopilotToolCtx, CopilotToolDecl } from "../../kernel/copilot/types";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PD-7 C8 — the desk's F2, answered by lookup: stock by name (and its next expiry), and the tickets
 * paid but not collected. The kernel routes the question; these read and answer with a key.
 */
describe("medicineTermOf — the medicine a stock question names", () => {
  it.each([
    ["kitni amoxicillin bachi hai", "amoxicillin"],
    ["Mox 500 ka stock kitna hai", "mox 500"],
    ["how much crocin is left", "crocin"],
    ["pan 40 kab expire hoga", "pan 40"],
    ["कितनी पैरासिटामोल बची है", "पैरासिटामोल"],
    ["ye batch kab expire hoga", ""],
    ["<<P1>> ki dawai kitni bachi hai", ""],
  ])("%s → %s", (question: string, term: string) => {
    expect(medicineTermOf(question)).toBe(term);
  });
});

describe("the pharmacy's copilot tools (PD-7 C8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  const tool = (intent: string): CopilotToolDecl => pharmacyCopilotTools.find((t) => t.intent === intent)!;
  const ctx = (question: string, actor: Actor = fx.pharmacist.actor): CopilotToolCtx =>
    ({ db, actor, subject: null, serviceDate: "2026-08-17", question });
  const ask = (intent: string, question: string, actor?: Actor) => {
    const c = ctx(question, actor);
    return runTool(tool(intent), c, permissionCheckFor(c));
  };

  it("stock by a product's name: how many can be sold, and the batch the next sale takes", async () => {
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-LATE", expiryDate: "2028-01-31", qtyBase: 20 });
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-EARLY", expiryDate: "2027-03-31", qtyBase: 10 });
    expect(await ask("stock_on_shelf", "kitni calpol bachi hai")).toEqual({
      key: "copilot.answer.stockOnShelf", params: { name: "Calpol 500", qty: 30, uom: "tablet", batch: "CP-EARLY", expiry: "2027-03-31" },
    });
  });

  it("stock by a SALT: every product on the shelf carrying it, each with its count and next expiry", async () => {
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", expiryDate: "2027-03-31", qtyBase: 30 });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", expiryDate: "2027-05-31", qtyBase: 50 });
    const a = await ask("stock_on_shelf", "kitni paracetamol bachi hai");
    expect(a.key).toBe("copilot.answer.stockSeveral");
    expect(a.params.n).toBe(2);
    expect(a.params.items).toEqual(expect.stringContaining("Calpol 500 · 30 tablet (2027-03-31)"));
    expect(a.params.items).toEqual(expect.stringContaining("Crocin 500 · 50 tablet (2027-05-31)"));
  });

  it("says empty, unknown and 'which medicine?' as three different sentences", async () => {
    expect(await ask("stock_on_shelf", "azee 500 ka stock")).toEqual({ key: "copilot.answer.stockEmpty", params: { name: "Azee 500" } });
    expect(await ask("stock_on_shelf", "kitni dolo bachi hai")).toEqual({ key: "copilot.answer.stockNotFound", params: { term: "dolo" } });
    expect(await ask("stock_on_shelf", "ye batch kab expire hoga")).toEqual({ key: "copilot.answer.stockNeedName", params: {} });
  });

  it("paid, not collected: the billed tickets by their desk label and the patient's name; none says none", async () => {
    expect(await ask("paid_not_collected", "kiska paisa pending hai")).toEqual({ key: "copilot.answer.uncollectedNone", params: {} });

    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 50 });
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("expected a dispense");
    const id = found.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);

    const serial = Number(/(\d+)$/.exec(v.dispenseNo!.slice(7))![1]);
    const a = await ask("paid_not_collected", "kiska paisa pending hai");
    expect(a.key).toBe("copilot.answer.uncollected");
    expect(a.params.n).toBe(1);
    expect(a.params.items).toMatch(new RegExp(`^P-${String(serial)} \\S`));
  });

  it("is the desk's permission, asked by the kernel's own runner: a front-office login is told so, and nothing is read", async () => {
    expect(await ask("stock_on_shelf", "kitni calpol bachi hai", fx.clerk.actor)).toEqual({ key: "copilot.answer.notPermitted", params: {} });
    expect(await ask("paid_not_collected", "kiska paisa pending hai", fx.clerk.actor)).toEqual({ key: "copilot.answer.notPermitted", params: {} });
  });
});
