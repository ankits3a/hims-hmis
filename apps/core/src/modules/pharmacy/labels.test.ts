import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, MON2, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { printJobs } from "../../kernel/db/schema";
import { renderDocument } from "../../kernel/printing/render";
import { labelCandidates, labelPayload, parseInHouseLabel, sendLabels } from "./labels";
import { registerPharmacyPrinting } from "./pharmacy.module";
import { setShelfLocation } from "./shelf-locations";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ GAP A6 — RACK AND STRIP LABELS ═══
 *
 * 50 × 25 mm stickers for the shelf edge and the loose strip, queued to the label printer through the
 * relay or, with no relay serving it, handed to the browser. Every label is checked against the books
 * before anything prints: a rack label needs a rack, a strip label a batch of that item with an MRP.
 */
describe("rack and strip labels (gap A6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let unregister: () => void;
  let cr1: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); unregister = registerPharmacyPrinting(); });
  afterAll(async () => { unregister(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    cr1 = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-01-31", mrpPaise: 2550, mrpUom: "strip", at: MON });
    await setShelfLocation(db, fx.pharmacist.actor, { storeResourceId: fx.storeId, itemId: fx.item.crocin, location: "R-12-B" }, MON);
  });
  afterEach(() => { fx.unregister(); });

  const labelsIn = (html: string): number => html.split('class="lab"').length - 1;

  it("the QR payload round-trips, and anything that is not ours is left to the GS1 / EAN path", () => {
    expect(parseInHouseLabel(labelPayload("CROC500", null))).toEqual({ itemCode: "CROC500", batchNo: null, packUom: null });
    expect(parseInHouseLabel(labelPayload("CROC500", { batchNo: "CR-1", packUom: "strip" }))).toEqual({ itemCode: "CROC500", batchNo: "CR-1", packUom: "strip" });
    for (const other of ["8901234567897", "(01)08901234567897(10)CR-1", "HMIS1|", "HMIS1|A|B", "HMIS2|CROC500"]) expect(parseInHouseLabel(other)).toBeNull();
  });

  it("the screen's list: the store's items with their rack, packs and held batches; no store gives the stores only", async () => {
    const none = await labelCandidates(db, null, "");
    expect(none.rows).toEqual([]);
    expect(none.stores.map((s) => s.id)).toContain(fx.storeId);
    const { rows } = await labelCandidates(db, fx.storeId, "");
    const crocin = rows.find((r) => r.itemId === fx.item.crocin)!;
    expect(crocin).toMatchObject({ code: "CROC500", rack: "R-12-B" });
    expect(crocin.batches).toEqual([expect.objectContaining({ batchId: cr1, batchNo: "CR-1", expiryDate: "2027-01-31", mrpPaise: 2550, mrpUom: "strip", qtyOnHand: 100 })]);
    expect(crocin.packs.length).toBeGreaterThan(0);
    expect((await labelCandidates(db, fx.storeId, "zzz")).rows).toEqual([]);
  });

  it("with no relay serving the label printer, hands the browser 50 × 25 mm stickers, one per copy, and queues nothing", async () => {
    const rack = await sendLabels(db, fx.incharge.actor, { kind: "rack", storeResourceId: fx.storeId, lines: [{ itemId: fx.item.crocin, copies: 2 }] }, MON2);
    if (rack.via !== "browser") throw new Error("expected the browser");
    expect(rack.document.page).toEqual({ widthMm: 50, heightMm: 25 });
    expect(labelsIn(rack.document.html)).toBe(2);
    for (const text of ["R-12-B", "CROC500", "<svg"]) expect(rack.document.html).toContain(text);

    const strip = await sendLabels(db, fx.incharge.actor, { kind: "strip", storeResourceId: fx.storeId, lines: [{ itemId: fx.item.crocin, batchId: cr1, copies: 3 }] }, MON2);
    if (strip.via !== "browser") throw new Error("expected the browser");
    expect(labelsIn(strip.document.html)).toBe(3);
    for (const text of ["CR-1", "EXP 01/2027", "MRP ₹25.50/strip"]) expect(strip.document.html).toContain(text);
    expect(await db.select().from(printJobs)).toHaveLength(0);
  });

  it("with the relay alive, queues one job to the label printer that renders the same stickers from ids alone", async () => {
    await db.insert(printJobs).values({
      id: newId(), document: "opd_token_slip", destination: "front_desk_thermal", params: {}, dedupeKey: `evidence:${newId()}`,
      status: "printed", claimedAt: new Date(MON2.getTime() - 3_600_000), claimedBy: "relay-1", printedAt: new Date(MON2.getTime() - 3_600_000),
    });
    const r = await sendLabels(db, fx.incharge.actor, { kind: "strip", storeResourceId: fx.storeId, lines: [{ itemId: fx.item.crocin, batchId: cr1, copies: 4 }] }, MON2);
    if (r.via !== "relay") throw new Error("expected the relay");
    const [job] = await db.select().from(printJobs).where(eq(printJobs.id, r.job.id));
    expect(job).toMatchObject({ document: "pharmacy_strip_label", destination: "pharmacy_label", requestedBy: fx.incharge.id });
    expect(job!.params).toEqual({ storeResourceId: fx.storeId, lines: [{ itemId: fx.item.crocin, batchId: cr1, packUom: null, copies: 4 }] });
    const doc = await renderDocument(db, "pharmacy_strip_label", job!.params as Record<string, unknown>, MON2, null);
    expect(doc?.page).toEqual({ widthMm: 50, heightMm: 25 });
    expect(labelsIn(doc!.html)).toBe(4);
    expect(doc!.html).toContain("MRP ₹25.50/strip");
  });

  it("refuses a label the books cannot stand behind, printing nothing", async () => {
    const refuse = async (input: Parameters<typeof sendLabels>[2], code: string): Promise<void> => {
      await expect(sendLabels(db, fx.incharge.actor, input, MON2)).rejects.toMatchObject({ code });
    };
    const s = fx.storeId;
    await refuse({ kind: "rack", storeResourceId: s, lines: [{ itemId: fx.item.calpol, copies: 1 }] }, "invalid_label"); // no rack
    await refuse({ kind: "strip", storeResourceId: s, lines: [{ itemId: fx.item.crocin, copies: 1 }] }, "invalid_label"); // no batch
    const calpol = await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", qtyBase: 10, at: MON });
    await refuse({ kind: "strip", storeResourceId: s, lines: [{ itemId: fx.item.crocin, batchId: calpol, copies: 1 }] }, "invalid_label"); // another item's batch
    const noMrp = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-0", qtyBase: 10, mrpPaise: null, mrpUom: null, at: MON });
    await refuse({ kind: "strip", storeResourceId: s, lines: [{ itemId: fx.item.crocin, batchId: noMrp, copies: 1 }] }, "invalid_label");
    await refuse({ kind: "strip", storeResourceId: s, lines: [{ itemId: fx.item.crocin, batchId: cr1, packUom: "carton", copies: 1 }] }, "invalid_label");
    await refuse({ kind: "rack", storeResourceId: s, lines: [{ itemId: fx.item.crocin, copies: 200 }, { itemId: fx.item.crocin, copies: 200 }, { itemId: fx.item.crocin, copies: 101 }] }, "invalid_label");
    await refuse({ kind: "rack", storeResourceId: s, lines: [{ itemId: newId(), copies: 1 }] }, "unknown_item");
    expect(await db.select().from(printJobs)).toHaveLength(0);
  });
});
