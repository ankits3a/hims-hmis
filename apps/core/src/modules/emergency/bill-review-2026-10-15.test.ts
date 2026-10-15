import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { erChargeLines, ipdAdmissionDeposits, stockBatches } from "../../kernel/db/schema";
import { admit, planAdmission, takeDeposit } from "../ipd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErBillWorld } from "../../../test/helpers/emergency";
import {
  assignErDoctor, declareStabilised, handToUnit, issueErMed, placeInBay, priceErLines, registerArrival, registerErChargeSink,
  registerErEncounterResolver, sweepErBoarding, takeErAdvance, triage,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErBillWorld } from "../../../test/helpers/emergency";

/**
 * ER review 3 (2026-10-15) — lane 6 money follow-ups, through the intents:
 * - a drug's price is its batch MRP for the PACK the MRP names, spread over the base units taken (₹500 a box of 10 →
 *   ₹50 a vial), never the pack price times the units;
 * - an ER advance follows the patient onto the IP bill as a deposit when the episode rolls over (never stranded);
 * - an issue still without a price at admission rolls over too (the IP desk's exception), never left behind;
 * - an episode rolled to the IP bill takes no further ER advance.
 */
jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const PAPER = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Desk Witness" };

describe("ER lane 6 — review follow-ups", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErBillWorld;
  const off: (() => void)[] = [];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErBillWorld(db);
    off.push(registerErEncounterResolver(), registerErChargeSink());
  });
  afterEach(() => { while (off.length > 0) off.pop()!(); });

  let n = 0;
  const seen = async (gate: Date) => {
    n += 1;
    const p = await w.patient("male", 40 + n, `Review Patient ${String(n)}`);
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 3, decision: { lifeSaving: false, highRisk: false, resources: "many", dangerVitals: false } }, { now: gate });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: await w.bed(`ER-RV${String(n)}`, { class: "emergency" }) }, { now: gate });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: gate });
    return a;
  };
  const admitFrom = async (episodeId: string, at: Date) => {
    const h = await handToUnit(db, w.erDoctor, {
      idempotencyKey: key(), episodeId, reason: "Needs the ward", consultantId: w.doctor.id, requestedClass: "general", provisionalDiagnosis: "AGE",
    }, { now: at });
    const t2 = new Date();
    const planned = await planAdmission(db, w.admitDesk, { idempotencyKey: key(), admissionId: h.admissionId, payerKind: "cash", requestedClass: "general", plan: { kind: "medical" } }, { now: t2 });
    const dep = planned.depositRequiredPaise > 0 ? await takeDeposit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId: h.admissionId, amountPaise: planned.depositRequiredPaise, tender: "cash", payer: { name: "Synthetic Payer", relation: "relative" },
    }, { now: t2 }) : null;
    await admit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId: h.admissionId, bedId: await w.bed(`W-RV-${String(n)}`), consent: PAPER,
      deposit: dep === null ? { exempt: "emergency_not_stabilised" } : { receiptId: dep.receiptId },
    }, { now: t2 });
    await sweepErBoarding(db, new Date(t2.getTime() + MIN));
    return h.admissionId;
  };

  it("a drug is priced at the MRP's pack spread over the base units taken", async () => {
    const gate = new Date(Date.now() - 60 * MIN);
    const a = await seen(gate);
    const drug = await w.stocked("Ceftriaxone 1 g");
    // The fixture's uoms: a box is 10 vials. This batch's MRP is ₹500 a BOX → ₹50 a vial.
    const [b] = await db.select().from(stockBatches).where(eq(stockBatches.itemId, drug));
    await db.update(stockBatches).set({ mrpPaise: 50_000, mrpUom: "box" }).where(eq(stockBatches.id, b!.id));
    const issued = await issueErMed(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, itemId: drug, doseWords: "1 g", route: "iv", units: 2, orderedBy: w.erDoctor.id });
    await priceErLines(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId });
    const [line] = await db.select().from(erChargeLines).where(eq(erChargeLines.issueId, issued.issueId));
    expect([line!.status, line!.amountPaise]).toEqual(["posted", 10_000]);
  });

  it("an ER advance becomes a deposit on the admission; an admitted episode takes no further ER advance", async () => {
    const gate = new Date(Date.now() - 3 * 60 * MIN);
    const a = await seen(gate);
    await declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId }, { now: new Date(gate.getTime() + 20 * MIN) });
    const adv = await takeErAdvance(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, tender: { tender: "cash", amountPaise: 50_000 }, payerName: "Son" });
    const admissionId = await admitFrom(a.episodeId, new Date(gate.getTime() + 60 * MIN));
    const deps = await db.select().from(ipdAdmissionDeposits).where(eq(ipdAdmissionDeposits.admissionId, admissionId));
    expect(deps.map((d) => [d.receiptId, d.amountPaise])).toContainEqual([adv.receiptId, 50_000]);
    await expect(takeErAdvance(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, tender: { tender: "cash", amountPaise: 10_000 }, payerName: "Son" }))
      .rejects.toMatchObject({ code: "rolled_to_ip" });
  });

  it("an issue still without a price at admission rolls over as the IP desk's exception, never left behind", async () => {
    const gate = new Date(Date.now() - 3 * 60 * MIN);
    const a = await seen(gate);
    const drug = await w.stocked("Pantoprazole 40 mg");
    await db.update(stockBatches).set({ mrpPaise: null, mrpUom: null }).where(eq(stockBatches.itemId, drug));
    const issued = await issueErMed(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, itemId: drug, doseWords: "40 mg", route: "iv", units: 1, orderedBy: w.erDoctor.id });
    await admitFrom(a.episodeId, new Date(gate.getTime() + 60 * MIN));
    const [line] = await db.select().from(erChargeLines).where(eq(erChargeLines.issueId, issued.issueId));
    expect(line!.status).toBe("moved");
  });
});
