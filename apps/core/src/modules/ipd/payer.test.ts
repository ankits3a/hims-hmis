import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissions, ipdPayerAuths, patientCoverages } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkChargesWorld } from "../../../test/helpers/ipd";
import { mkTpaDesk } from "../../../test/helpers/ipd-payer";
import { lockAdmission } from "./admission-core";
import {
  addPayerNonPayable, postNightlyIpdCharges, printInterimBillSnapshot, readInterimBill, recordPayerAuth,
} from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ChargesWorld } from "../../../test/helpers/ipd";

/**
 * E2.2 (#726) — the authorisation record the payer split reads, and the review fixes on its edges. Explicit instants;
 * fake amounts.
 */
jest.setTimeout(120_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);

describe("record_payer_auth and the split's edges (E2.2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ChargesWorld;
  let tpa: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkChargesWorld(db); tpa = await mkTpaDesk(db); });

  let minute = 0;
  const authAs = (who: Actor, admissionId: string, over: Record<string, unknown>) => {
    minute += 1;
    return recordPayerAuth(db, who, {
      idempotencyKey: randomUUID(), admissionId, payerKind: "insurance_cashless", entry: "initial", status: "requested",
      provisionalCashlessSigned: true, ...over,
    }, { now: new Date(ist("2026-03-10T11:00:00").getTime() + minute * 60_000) });
  };
  const coverage = async (patientId: string, sumInsuredPaise: number): Promise<string> => {
    const id = newId();
    await db.insert(patientCoverages).values({ id, patientId, kind: "insurance", payerName: "Fake Insurer", sumInsuredPaise, createdBy: tpa.id });
    return id;
  };

  it("a requested pre-auth is answered by a second initial; a requested enhancement approves nothing and does not inflate the next", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const auth = (over: Record<string, unknown>) => authAs(w.admitDesk, admissionId, over);
    await expect(auth({ approvedAmountPaise: 500_000 })).resolves.toMatchObject({ approvedTotalPaise: 0, coversFrom: null });
    await expect(auth({ status: "approved", approvedAmountPaise: 300_000 })).resolves.toMatchObject({ approvedTotalPaise: 300_000 });
    // An answered initial refuses a third.
    await expect(auth({ status: "approved", approvedAmountPaise: 1 })).rejects.toMatchObject({ code: "auth_out_of_order" });
    await expect(auth({ entry: "enhancement", approvedAmountPaise: 200_000 })).resolves.toMatchObject({ approvedTotalPaise: 300_000 });
    await expect(auth({ entry: "enhancement", status: "approved", approvedAmountPaise: 150_000 })).resolves.toMatchObject({ approvedTotalPaise: 450_000 });
  });

  it("review RED 1: one entry may not state the cap both ways — the intent refuses and so does the database", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await expect(authAs(tpa, admissionId, { status: "approved", approvedAmountPaise: 1, roomRentCapPaise: 100_000, roomRentCapSiBp: 100 }))
      .rejects.toMatchObject({ name: "ZodError" });
    await authAs(tpa, admissionId, { status: "approved", approvedAmountPaise: 1, roomRentCapPaise: 100_000 });
    const [row] = await db.select().from(ipdPayerAuths).where(eq(ipdPayerAuths.admissionId, admissionId));
    await expect(db.execute(sql`update ipd_payer_auths set room_rent_cap_si_bp = 100 where id = ${row!.id}`))
      .rejects.toMatchObject({ constraint: "ipd_payer_auths_one_cap_ck" });
  });

  it("review 11: the money terms and the non-payables list need ipd.payer.terms; status and number do not", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await expect(authAs(w.admitDesk, admissionId, { status: "approved", approvedAmountPaise: 1, coPayBp: 1_000 }))
      .rejects.toMatchObject({ code: "ipd_forbidden" });
    await expect(authAs(w.admitDesk, admissionId, { status: "approved", approvedAmountPaise: 1, preAuthNumber: "PA-FAKE" })).resolves.toBeDefined();
    await expect(authAs(tpa, admissionId, { entry: "enhancement", status: "approved", approvedAmountPaise: 1, coPayBp: 1_000 })).resolves.toBeDefined();
    const nonPay = { matchKind: "category", matchValue: "toiletries", reason: "IRDAI non-medical" };
    await expect(addPayerNonPayable(db, w.admitDesk, nonPay)).rejects.toMatchObject({ code: "ipd_forbidden" });
    await expect(addPayerNonPayable(db, tpa, nonPay)).resolves.toMatchObject({ matchValue: "toiletries" });
  });

  it("review 6: a payer change carries the coverage; a % cap resolves against the CURRENT coverage's sum insured", async () => {
    const { admissionId, patientId } = await w.admitAt("private", ist("2026-03-10T10:00:00"));
    const first = await coverage(patientId, 10_000_000);
    const second = await coverage(patientId, 20_000_000);
    await authAs(tpa, admissionId, { status: "approved", approvedAmountPaise: 5_000_000, roomRentCapSiBp: 100, coverageId: first });
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    expect((await readInterimBill(db, tpa, admissionId)).payerSplit.roomRentCapPaise).toBe(100_000);
    await authAs(tpa, admissionId, {
      entry: "payer_change", payerKind: "corporate", status: "approved", approvedAmountPaise: 5_000_000, roomRentCapSiBp: 100,
      coverageId: second, counsellingDocumentId: newId(),
    });
    const [a] = await db.select({ coverageId: ipdAdmissions.coverageId, payerKind: ipdAdmissions.payerKind }).from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId));
    expect(a).toEqual({ coverageId: second, payerKind: "corporate" });
    expect((await readInterimBill(db, tpa, admissionId)).payerSplit.roomRentCapPaise).toBe(200_000);
    // Someone else's coverage is refused.
    const stranger = await coverage(await w.patient("female"), 1);
    await expect(authAs(tpa, admissionId, { entry: "payer_change", payerKind: "cash", status: "approved", coverageId: stranger, counsellingDocumentId: newId() }))
      .rejects.toMatchObject({ code: "state_changed" });
  });

  it("review $9: an approval on appeal after a denial is recorded and reinstates insurance; the cash consent flag clears", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await authAs(tpa, admissionId, {});
    await authAs(tpa, admissionId, { entry: "denial", status: "denied" });
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    expect((await readInterimBill(db, tpa, admissionId)).payerSplit.exceptions).toEqual(["cash_consent_missing"]);
    await expect(authAs(tpa, admissionId, { entry: "enhancement", status: "approved", approvedAmountPaise: 1 })).rejects.toMatchObject({ code: "auth_out_of_order" });
    await expect(authAs(tpa, admissionId, { status: "approved", approvedAmountPaise: 2_000_000 })).resolves.toMatchObject({ approvedTotalPaise: 2_000_000 });
    const split = (await readInterimBill(db, tpa, admissionId)).payerSplit;
    expect(split).toMatchObject({ authState: "approved", exceptions: [] });
    expect(split.lines.every((l) => l.patientPaise === 0)).toBe(true);
  });

  it("review 4: printing takes the admission's lock and reads after it — an act committing under the lock is on the paper", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await authAs(tpa, admissionId, {});
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    let printing: Promise<{ payerSplit: { authState: string } }> | null = null;
    await withTx(db, async (tx) => {
      await lockAdmission(tx, admissionId);
      printing = printInterimBillSnapshot(db, tpa, admissionId, ist("2026-03-11T09:00:00"));
      await new Promise((r) => setTimeout(r, 400));
      // The insurer's approval lands while the print is waiting.
      await tx.insert(ipdPayerAuths).values({
        id: newId(), admissionId, payerKind: "insurance_cashless", entry: "initial", status: "approved", approvedAmountPaise: 9_000_000,
        approvedTotalPaise: 9_000_000, provisionalCashlessSigned: true, recordedBy: tpa.id, recordedAt: ist("2026-03-11T08:59:00"),
      });
    });
    await expect(printing!).resolves.toMatchObject({ payerSplit: { authState: "approved" } });
  });
});
