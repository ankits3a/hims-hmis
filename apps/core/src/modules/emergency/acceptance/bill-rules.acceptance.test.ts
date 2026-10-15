import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { erPayerClaims } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErBillWorld } from "../../../../test/helpers/emergency";
import {
  assignErDoctor, declareStabilised, dischargeFromEr, issueErMed, listErClaims, observationBlocks, openErEventAccount, placeInBay,
  priceErLines, readErBill, registerArrival, setErPayer, settleErBill, triage,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErBillWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 6 (#813) — THE BILL'S RULES beyond "done means" (0076 §1–§4): observation per started 6 hours after the first
 * 6; drugs at the batch MRP and nothing settles unpriced; PM-JAY at ₹0 with a claim for the TPA desk; road-accident
 * cashless to its cap; a mass-casualty event account.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const HOUR = 60 * MIN;
const SUMMARY = { diagnosis: "Contusion", treatmentGiven: "Analgesia", medicines: [], returnIf: ["worsening_pain" as const] };

describe("ER lane 6 er-bill — the rules", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErBillWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErBillWorld(db);
  });

  let n = 0;
  const seen = async (gate: Date) => {
    n += 1;
    const p = await w.patient("male", 25 + n, `Rules Patient ${String(n)}`);
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 3, decision: { lifeSaving: false, highRisk: false, resources: "many", dangerVitals: false } }, { now: gate });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: await w.bed(`ER-RU${String(n)}`, { class: "emergency" }) }, { now: gate });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: gate });
    await declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId }, { now: gate });
    return a;
  };

  it("observation: nothing for the first 6 hours, then one block per STARTED 6 hours", () => {
    const t0 = new Date("2026-10-15T00:00:00Z");
    const at = (h: number, m = 0) => new Date(t0.getTime() + h * HOUR + m * MIN);
    expect([observationBlocks(t0, at(6)), observationBlocks(t0, at(6, 1)), observationBlocks(t0, at(12)), observationBlocks(t0, at(12, 1))]).toEqual([0, 1, 1, 2]);
  });

  it("a 13-hour stay bills two observation blocks; a drug at its batch MRP; nothing settles while a line is unpriced", async () => {
    const gate = new Date(Date.now() - 13 * HOUR);
    const a = await seen(gate);
    const drug = await w.stocked("Diclofenac 75 mg");
    await issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, itemId: drug, doseWords: "75 mg", route: "im", units: 1, orderedBy: w.erDoctor.id }, { now: gate });
    await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, reason: "Pain settled", summary: SUMMARY });
    const before = await readErBill(db, w.billDesk, a.episodeId);
    expect(before.unpriced).toBe(1);
    await expect(settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "paid", tenders: [{ tender: "cash", amountPaise: 1_000_000 }] }))
      .rejects.toMatchObject({ code: "lines_unpriced" });
    await priceErLines(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId });
    const bill = await readErBill(db, w.billDesk, a.episodeId);
    // Registration ₹200 + physician ₹500 + 2 × observation ₹1,000 + the drug at MRP ₹50.
    expect(bill.lines.find((l) => l.source === "er.observation")).toMatchObject({ qty: 2, amountPaise: 200_000 });
    expect(bill.totalPaise).toBe(20_000 + 50_000 + 200_000 + 5_000);
  });

  it("PM-JAY at ₹0 with a claim for the TPA desk; road-accident cashless to its cap; a mass-casualty event account", async () => {
    const gate = new Date(Date.now() - 2 * HOUR);
    const a = await seen(gate);
    await expect(setErPayer(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, payer: "pmjay" })).rejects.toMatchObject({ code: "payer_ref_needed" });
    await setErPayer(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, payer: "pmjay", schemeRef: "PMJAY-SAMPLE-1" });
    await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, reason: "Better", summary: SUMMARY });
    const s = await settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "nothing_payable" });
    expect(s).toMatchObject({ patientPaise: 0, payerPaise: 70_000 });
    expect((await listErClaims(db)).map((c) => [c.episodeId, c.payer, c.amountPaise])).toEqual([[a.episodeId, "pmjay", 70_000]]);

    const r = await seen(gate);
    const set = await setErPayer(db, w.billDesk, { idempotencyKey: key(), episodeId: r.episodeId, payer: "road_accident", schemeRef: "FIR 12/26" });
    expect(set.coverCapPaise).toBe(15_000_000);
    expect(new Date(set.coverUntil!).getTime() - gate.getTime()).toBe(7 * 24 * HOUR);

    await expect(setErPayer(db, w.billDesk, { idempotencyKey: key(), episodeId: r.episodeId, payer: "bnss_free" })).rejects.toMatchObject({ code: "bnss_needs_mlc" });
    const ev = await openErEventAccount(db, w.billDesk, { idempotencyKey: key(), name: "Bus collision NH-30" });
    const m = await seen(gate);
    await setErPayer(db, w.billDesk, { idempotencyKey: key(), episodeId: m.episodeId, payer: "mci_event", eventAccountId: ev.eventAccountId });
    await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: m.episodeId, reason: "Minor", summary: SUMMARY });
    await settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: m.episodeId, settlement: "nothing_payable" });
    expect((await db.select().from(erPayerClaims).where(eq(erPayerClaims.episodeId, m.episodeId)))[0])
      .toMatchObject({ payer: "mci_event", eventAccountId: ev.eventAccountId, amountPaise: 70_000 });
  });
});
