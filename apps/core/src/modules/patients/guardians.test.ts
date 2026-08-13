import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, patientGuardians, patients, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerPatient } from "./registration";
import {
  NO_AUTHORITY, effectiveGuardianAuthority, endGuardian, linkGuardian,
  sweepGuardianMajority, updateGuardianAuthority,
} from "./guardians";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };
const NOW = new Date(Date.UTC(2026, 7, 13)); // fixed clock for age arithmetic

function dobAged(years: number, extraDays = 0): Date {
  const d = new Date(Date.UTC(2026 - years, 7, 13));
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d;
}

describe("guardians", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
  });

  async function minorWithGuardian(dob: Date, sensitive = false): Promise<{ patientId: string; guardianId: string }> {
    const { patient, guardianId } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, {
        name: "Minor P", sex: "other", dob, sensitiveContext: sensitive,
        guardian: { name: "G", relationship: "father", phone: "9800000000" },
      }),
    );
    return { patientId: patient.id, guardianId: guardianId! };
  }

  // guardian.authority_changed events for ONE guardian, in insertion order. Scoping by
  // guardian keeps each fixture's assertions independent when a test uses more than one.
  async function authorityEventsFor(guardianId: string): Promise<{ payload: unknown }[]> {
    const rows = await db.select().from(events).where(eq(events.name, "guardian.authority_changed"));
    return rows.filter((e) => (e.payload as { guardianId: string }).guardianId === guardianId);
  }

  it("effectiveGuardianAuthority: full for an active minor's guardian; messages sealed under sensitive context", async () => {
    const { patientId, guardianId } = await minorWithGuardian(dobAged(10));
    const patient = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!;
    const guardian = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, guardianId)))[0]!;
    expect(effectiveGuardianAuthority(patient, guardian, NOW)).toEqual({
      messages: true, consents: true, dsr: false, bills: true,
    });

    const sealed = await minorWithGuardian(dobAged(12), true);
    const p2 = (await db.select().from(patients).where(eq(patients.id, sealed.patientId)))[0]!;
    const g2 = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, sealed.guardianId)))[0]!;
    expect(effectiveGuardianAuthority(p2, g2, NOW)).toEqual({
      messages: false, consents: true, dsr: false, bills: true, // ONLY the message channel seals (D-31)
    });
  });

  it("read-time enforcement: authority is all-false the moment the patient is 18 — row still 'active'", async () => {
    const { patientId, guardianId } = await minorWithGuardian(dobAged(17, -1)); // 18 in ~a day... registered as minor
    const patient = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!;
    const guardian = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, guardianId)))[0]!;
    expect(guardian.status).toBe("active");
    const at18 = new Date(Date.UTC(2027, 7, 14));
    expect(effectiveGuardianAuthority(patient, guardian, at18)).toEqual(NO_AUTHORITY);
    // and an explicit validTo in the past does the same
    await withTx(db, (tx) => updateGuardianAuthority(tx, clerk, guardianId, { validTo: new Date(Date.UTC(2020, 0, 1)) }));
    const g2 = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, guardianId)))[0]!;
    expect(effectiveGuardianAuthority(patient, g2, NOW)).toEqual(NO_AUTHORITY);
  });

  it("updateGuardianAuthority events the EFFECTIVE authority; endGuardian is single-winner", async () => {
    const { patientId, guardianId } = await minorWithGuardian(dobAged(10));
    await withTx(db, (tx) => updateGuardianAuthority(tx, clerk, guardianId, { dsr: true, messages: false }));
    let evs = await authorityEventsFor(guardianId);
    expect(evs).toHaveLength(1);
    // PLAN DEFECT fix: the plan's cast here drops `dsr`/`messages`, which the `let` above
    // already fixed as the variable's type (TS2322). Widened to keep both assignments legal;
    // the assertions below are the plan's, unchanged.
    let payload = evs[0]!.payload as { reason: string; authority: { dsr: boolean; messages: boolean; consents: boolean } };
    expect(payload.reason).toBe("update");
    expect(payload.authority.dsr).toBe(true);
    expect(payload.authority.messages).toBe(false);

    await withTx(db, (tx) => endGuardian(tx, clerk, guardianId));
    await expect(withTx(db, (tx) => endGuardian(tx, clerk, guardianId))).rejects.toMatchObject({
      code: "guardian_not_active",
    });
    evs = await authorityEventsFor(guardianId);
    expect(evs).toHaveLength(2);
    payload = evs[1]!.payload as { reason: string; authority: { dsr: boolean; messages: boolean; consents: boolean } };
    expect(payload.reason).toBe("ended");
    expect(payload.authority).toEqual(NO_AUTHORITY);

    // The not-active gate of effectiveGuardianAuthority, isolated: this patient is 10 at NOW
    // and validTo is null, so neither the DOB gate nor the validity gate can fire — only the
    // status gate can produce all-false. (Stored flags are still consents/dsr/bills true.)
    const patientRow = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!;
    const endedRow = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, guardianId)))[0]!;
    expect(endedRow.status).toBe("ended");
    expect(endedRow.validTo).toBeNull();
    expect(effectiveGuardianAuthority(patientRow, endedRow, NOW)).toEqual(NO_AUTHORITY);

    // EFFECTIVE, not stored: on an already-major patient (20 against the real clock, which is
    // the clock updateGuardianAuthority computes with) the patch stores dsr/messages true, yet
    // the event payload must be all-false. Only a computed authority can produce that.
    const major = await minorWithGuardian(dobAged(20));
    await withTx(db, (tx) => updateGuardianAuthority(tx, clerk, major.guardianId, { dsr: true, messages: true }));
    const majorRow = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, major.guardianId)))[0]!;
    expect(majorRow.authorityDsr).toBe(true);
    expect(majorRow.authorityMessages).toBe(true);
    const majorEvs = await authorityEventsFor(major.guardianId);
    expect(majorEvs).toHaveLength(1);
    const majorPayload = majorEvs[0]!.payload as { reason: string; authority: Record<string, boolean> };
    expect(majorPayload.reason).toBe("update");
    expect(majorPayload.authority).toEqual(NO_AUTHORITY);
  });

  it("sweepGuardianMajority flips exactly the majored guardians, events each, and is idempotent", async () => {
    await minorWithGuardian(dobAged(10)); // stays
    const turned18 = await minorWithGuardian(dobAged(18)); // flips (birthday today)
    const adult20 = await minorWithGuardian(dobAged(20)); // flips (registered via test backdate)
    const ended = await minorWithGuardian(dobAged(19));
    await withTx(db, (tx) => endGuardian(tx, clerk, ended.guardianId)); // 'ended' — sweep must not touch

    const flipped = await sweepGuardianMajority(db, NOW);
    expect(flipped).toBe(2);
    for (const g of [turned18.guardianId, adult20.guardianId]) {
      const row = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, g)))[0]!;
      expect(row.status).toBe("majority_ended");
    }
    const majorityEvents = (await db.select().from(events).where(eq(events.name, "guardian.authority_changed")))
      .filter((e) => (e.payload as { reason: string }).reason === "majority");
    expect(majorityEvents).toHaveLength(2);

    expect(await sweepGuardianMajority(db, NOW)).toBe(0); // idempotent
    // ...and idempotent means silent too: the second run emitted no further events.
    const afterSecondRun = (await db.select().from(events).where(eq(events.name, "guardian.authority_changed")))
      .filter((e) => (e.payload as { reason: string }).reason === "majority");
    expect(afterSecondRun).toHaveLength(2);
  });

  it("two concurrent sweeps split the rows and never double-fire", async () => {
    await minorWithGuardian(dobAged(19));
    await minorWithGuardian(dobAged(21));
    await minorWithGuardian(dobAged(25));
    const [a, b] = await Promise.all([sweepGuardianMajority(db, NOW), sweepGuardianMajority(db, NOW)]);
    expect(a + b).toBe(3);
    const majorityEvents = (await db.select().from(events).where(eq(events.name, "guardian.authority_changed")))
      .filter((e) => (e.payload as { reason: string }).reason === "majority");
    expect(majorityEvents).toHaveLength(3);
  });
});
