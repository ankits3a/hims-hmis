import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { approvals, erBills, patientDocuments } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErBillWorld } from "../../../test/helpers/emergency";
import {
  assignErDoctor, declareStabilised, dischargeFromEr, openMlc, placeInBay, readErBill, registerArrival, setErPayer, settleErBill, takeErAdvance,
  triage,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErBillWorld } from "../../../test/helpers/emergency";

/**
 * ER review 3, part 2 (2026-10-15, DECIDED as standard practice) — lane 6:
 * - an ER advance on an episode that settles at ₹0 to the patient (BNSS s.397) becomes a refund request on the refund desk;
 * - the road-accident cap (₹1.5 lakh, 7 days) is per accident: a person's episodes of one accident share it;
 * - the 7-day window judges each line by the episode time it covers (observation by its 6-hour blocks);
 * - an accident time in the future is refused;
 * - a dues undertaking is one of the patient's own active documents.
 * Rates: the UAT sample — registration ₹200, physician ₹500, observation ₹1,000 a block.
 */
jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const HOUR = 60 * MIN;
const SUMMARY = { diagnosis: "Contusion", treatmentGiven: "Analgesia", medicines: [], returnIf: ["worsening_pain" as const] };

describe("ER lane 6 — review follow-ups, part 2", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErBillWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErBillWorld(db); });

  let n = 0;
  const seen = async (gate: Date, patientId?: string) => {
    n += 1;
    const p = patientId ?? await w.patient("female", 25 + n, `Bill Two ${String(n)}`);
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 3, decision: { lifeSaving: false, highRisk: false, resources: "many", dangerVitals: false } }, { now: gate });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: await w.bed(`ER-B2-${String(n)}`, { class: "emergency" }) }, { now: gate });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: gate });
    await declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId }, { now: gate });
    return { ...a, patientId: p };
  };
  const docFor = async (patientId: string, status = "active") => {
    const id = newId();
    await db.insert(patientDocuments).values({
      id, patientId, kind: "outside_report", mimeType: "image/jpeg", byteSize: 10, storageKey: `2026/10/${id}.jpg`, sha256: "0".repeat(64),
      capturedBy: w.billDesk.id, status,
    } as never);
    return id;
  };

  it("an advance on a BNSS episode settled at ₹0 becomes a refund request", async () => {
    const gate = new Date(Date.now() - 2 * HOUR);
    const a = await seen(gate);
    await takeErAdvance(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, tender: { tender: "cash", amountPaise: 30_000 }, payerName: "Brother" });
    await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "sexual_assault" });
    await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, reason: "Stable", summary: SUMMARY });
    const s = await settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "nothing_payable" });
    expect(s).toMatchObject({ patientPaise: 0 });
    const asked = await db.select().from(approvals).where(and(eq(approvals.patientId, a.patientId), eq(approvals.amountPaise, 30_000)));
    expect(asked.map((r) => r.typeKey.startsWith("billing_refund"))).toEqual([true]);
  });

  it("the road-accident cap is per accident: a person's second episode of one accident has only what the first left", async () => {
    const gate = new Date(Date.now() - 2 * HOUR);
    const first = await seen(gate);
    await setErPayer(db, w.billDesk, { idempotencyKey: key(), episodeId: first.episodeId, payer: "road_accident", schemeRef: "FIR 77/26", accidentRef: "ACC-NH30-0915" });
    await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: first.episodeId, reason: "Better", summary: SUMMARY });
    await settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: first.episodeId, settlement: "nothing_payable" });
    // The first episode used all but ₹500 of the cap (written directly: a ₹1.5 lakh bill needs a 150-block stay).
    await db.update(erBills).set({ payerPaise: 14_950_000, totalPaise: 14_950_000, patientPaise: 0 }).where(eq(erBills.episodeId, first.episodeId));
    const again = await seen(new Date(Date.now() - HOUR), first.patientId);
    await setErPayer(db, w.billDesk, { idempotencyKey: key(), episodeId: again.episodeId, payer: "road_accident", schemeRef: "FIR 77/26", accidentRef: "ACC-NH30-0915" });
    await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: again.episodeId, reason: "Better", summary: SUMMARY });
    const bill = await readErBill(db, w.billDesk, again.episodeId);
    expect([bill.payerPaise, bill.patientPaise]).toEqual([50_000, 20_000]);
  });

  it("the 7-day window judges observation by the blocks it covers; a future accident time is refused", async () => {
    const gate = new Date(Date.now() - 13 * HOUR);
    const a = await seen(gate);
    await expect(setErPayer(db, w.billDesk, {
      idempotencyKey: key(), episodeId: a.episodeId, payer: "road_accident", schemeRef: "FIR 9/26", accidentAt: new Date(Date.now() + 3 * HOUR).toISOString(),
    })).rejects.toMatchObject({ code: "time_in_future" });
    // The window closes 9 h after the gate: block 1 (6 h–12 h) is inside, block 2 (12 h–18 h) is not.
    await setErPayer(db, w.billDesk, {
      idempotencyKey: key(), episodeId: a.episodeId, payer: "road_accident", schemeRef: "FIR 9/26",
      accidentAt: new Date(gate.getTime() - 7 * 24 * HOUR + 9 * HOUR).toISOString(),
    });
    await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, reason: "Better", summary: SUMMARY });
    const bill = await readErBill(db, w.billDesk, a.episodeId);
    expect([bill.totalPaise, bill.payerPaise, bill.patientPaise]).toEqual([270_000, 170_000, 100_000]);
  });

  it("a dues undertaking must be the patient's own active document", async () => {
    const gate = new Date(Date.now() - 2 * HOUR);
    const a = await seen(gate);
    const other = await w.patient("male", 61, "Someone Else");
    await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, reason: "Better", summary: SUMMARY });
    const ut = (documentId: string) => ({ signerName: "Husband", relation: "husband", documentRef: "UT-1", documentId });
    await expect(settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "dues", undertaking: ut(await docFor(other)) }))
      .rejects.toMatchObject({ code: "undertaking_invalid" });
    await expect(settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "dues", undertaking: ut(await docFor(a.patientId)) }))
      .resolves.toMatchObject({ duesPaise: 70_000 });
  });
});
