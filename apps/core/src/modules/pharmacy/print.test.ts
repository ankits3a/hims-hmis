import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { printJobs } from "../../kernel/db/schema";
import { claimPrintJobs } from "../../kernel/printing/claim";
import { renderDocument } from "../../kernel/printing/render";
import { relayServes } from "../../kernel/printing/served";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { dispensePaper, dispensePrintJobs, gstSummary, sendDispensePaper } from "./print";
import { registerPharmacyPrinting } from "./pharmacy.module";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P1 — THE DESK PRINTS ═══
 *
 * After a hand-over the desk sends the bill and the labels to the counter's roll through the
 * server's print relay (owner ruling 2026-09-04: printing is server-side), or — when no relay is
 * serving that roll — prints the same documents in the browser and says so.
 */
describe("the desk's paper (pharmacy P1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let unregister: () => void;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); unregister = registerPharmacyPrinting(); });
  afterAll(async () => { unregister(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", at: MON });
  });
  afterEach(() => { fx.unregister(); });

  async function ticket(upTo: "picked" | "handed_over"): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    if (upTo === "picked") return id;
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3);
    return id;
  }

  /** Evidence that the site's relay is alive: a job it claimed (any destination) at `at`. */
  async function relayClaimed(destination: string, at: Date): Promise<void> {
    await db.insert(printJobs).values({
      id: newId(), document: "opd_token_slip", destination, params: {}, dedupeKey: `evidence:${newId()}`,
      status: "printed", claimedAt: at, claimedBy: "relay-1", printedAt: at,
    });
  }

  it("with no relay serving the roll, queues nothing and tells the desk to print in the browser", async () => {
    const id = await ticket("handed_over");
    expect(await sendDispensePaper(db, fx.pharmacist.actor, id, {}, MON3)).toEqual({ via: "browser", documents: ["pharmacy_bill", "pharmacy_labels"] });
    expect(await db.select().from(printJobs).where(eq(printJobs.destination, "pharmacy_thermal"))).toHaveLength(0);
  });

  it("with the site's relay alive, queues the bill and the labels to the pharmacy roll once; a Reprint is a second copy", async () => {
    const id = await ticket("handed_over");
    await relayClaimed("front_desk_thermal", new Date(MON3.getTime() - 3_600_000));
    const first = await sendDispensePaper(db, fx.pharmacist.actor, id, {}, MON3);
    if (first.via !== "relay") throw new Error("expected the relay");
    expect(first.jobs.map((j) => j.document).sort()).toEqual(["pharmacy_bill", "pharmacy_labels"]);
    const rows = await db.select().from(printJobs).where(eq(printJobs.destination, "pharmacy_thermal"));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.requestedBy === fx.pharmacist.id && r.status === "queued")).toBe(true);
    // A second ask without "reprint" is the same paper, already coming — no new rows.
    const again = await sendDispensePaper(db, fx.pharmacist.actor, id, {}, MON3);
    expect(again.via === "relay" ? again.jobs.map((j) => j.id).sort() : []).toEqual(first.jobs.map((j) => j.id).sort());
    const reprint = await sendDispensePaper(db, fx.pharmacist.actor, id, { reprint: true }, MON3);
    expect(reprint.via).toBe("relay");
    expect(await db.select().from(printJobs).where(eq(printJobs.destination, "pharmacy_thermal"))).toHaveLength(4);
    expect(await dispensePrintJobs(db, id)).toHaveLength(4);
  });

  it("refuses before there is anything to print — a ticket picked but not billed", async () => {
    const id = await ticket("picked");
    await expect(sendDispensePaper(db, fx.pharmacist.actor, id, {}, MON3)).rejects.toMatchObject({ code: "nothing_to_print" });
  });

  it("the relay's claim renders the pharmacy's documents: the bill's rows, totals and GST summary; each label's batch and directions", async () => {
    const id = await ticket("handed_over");
    await relayClaimed("pharmacy_thermal", new Date(MON3.getTime() - 2 * 86_400_000));
    await sendDispensePaper(db, fx.pharmacist.actor, id, {}, MON3);
    const claimed = await claimPrintJobs(db, { relayId: "relay-1", destinations: ["pharmacy_thermal"], limit: 10, now: MON3 });
    expect(claimed).toHaveLength(2);
    const bill = await renderDocument(db, "pharmacy_bill", { dispenseId: id }, MON3, fx.pharmacist.actor);
    const labels = await renderDocument(db, "pharmacy_labels", { dispenseId: id }, MON3, fx.pharmacist.actor);
    expect(bill?.page).toEqual({ widthMm: 72, heightMm: null });
    expect(bill?.html).toMatch(/TAX INVOICE|BILL OF SUPPLY/);
    expect(bill?.html).toContain("Net payable");
    expect(bill?.html).toContain("Taxable");
    expect(labels?.html).toContain("CR-1");
    expect(labels?.html).toContain("2027-12-31");
    // The browser's copy is the same two renderings on one roll.
    const paper = await dispensePaper(db, fx.pharmacist.actor, id, MON3);
    expect(paper.html).toContain("Net payable");
    expect(paper.html).toContain("CR-1");
  });

  it("does not believe stale evidence: a pharmacy job claimed eight days ago, and nothing since", async () => {
    await relayClaimed("pharmacy_thermal", new Date(MON3.getTime() - 8 * 86_400_000));
    expect(await relayServes(db, "pharmacy_thermal", MON3)).toBe(false);
    await relayClaimed("pharmacy_thermal", new Date(MON3.getTime() - 6 * 86_400_000));
    expect(await relayServes(db, "pharmacy_thermal", MON3)).toBe(true);
  });

  it("the GST summary is a fold of the stored heads — rows add up to the invoice's own CGST and SGST", () => {
    const lines = [
      { rateBps: 500, exempt: false, taxableBasePaise: 9524, cgstPaise: 238, sgstPaise: 238 },
      { rateBps: 500, exempt: false, taxableBasePaise: 1905, cgstPaise: 48, sgstPaise: 47 },
      { rateBps: 0, exempt: true, taxableBasePaise: 5000, cgstPaise: 0, sgstPaise: 0 },
    ];
    expect(gstSummary(lines)).toEqual([
      { rateBps: 500, exempt: false, taxableBasePaise: 11429, cgstPaise: 286, sgstPaise: 285 },
      { rateBps: 0, exempt: true, taxableBasePaise: 5000, cgstPaise: 0, sgstPaise: 0 },
    ]);
  });
});
