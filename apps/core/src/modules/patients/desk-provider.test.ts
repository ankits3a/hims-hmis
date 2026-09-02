import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser, seedOpdBase } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { patientMergeRequests, patients } from "../../kernel/db/schema";
import { registerPatient, updatePatient } from "./registration";
import { patientsDeskProvider } from "./desk-provider";
import type { DeskProviderCtx } from "../../kernel/desk/types";
import type { Db } from "../../kernel/db/client";

/**
 * FD-1 T1 — two clerks, one desk each. Every figure is pinned against seeded rows and clerk B's
 * cards carry none of clerk A's counts (phase doc D8).
 */
/**
 * The REAL clock, deliberately: `registerPatient` and `updatePatient` stamp `created_at` and the
 * event log with `now()`, so a pinned fictional date would count nothing (the OPD provider's
 * suite learned the same). Outliers are re-stamped relative to now.
 */
const T0 = new Date();
const DATE = new Date(T0.getTime() + 330 * 60_000).toISOString().slice(0, 10); // today, IST
const daysAgo = (n: number): Date => new Date(T0.getTime() - n * 86_400_000);

describe("patients desk provider (FD-1 T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let a: Awaited<ReturnType<typeof mkUser>>;
  let b: Awaited<ReturnType<typeof mkUser>>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    a = await mkUser(db, "clerkA", ["front_office"]);
    b = await mkUser(db, "clerkB", ["front_office"]);
  });
  const ctxFor = (u: Awaited<ReturnType<typeof mkUser>>): DeskProviderCtx => ({ db, actor: u.actor, reader: u.actor, date: DATE, now: T0 });
  const reg = (u: Awaited<ReturnType<typeof mkUser>>, name: string, phone?: string) =>
    withTx(db, (tx) => registerPatient(tx, u.actor, { name, sex: "female", ageYears: 30, ...(phone === undefined ? {} : { phone }) }));
  const stampCreated = (id: string, at: Date) => db.update(patients).set({ createdAt: at }).where(eq(patients.id, id));
  const statOf = (cards: { key: string; stats?: { key: string; value: string }[] }[], card: string, stat: string): string =>
    cards.find((c) => c.key === card)!.stats!.find((s) => s.key === stat)!.value;

  it("the registration card counts MY day — registered, without a mobile, duplicates flagged — and names nobody", async () => {
    await reg(a, "Sunita Devi", "9876500001");
    const { patient: p2 } = await reg(a, "Kamla");            // no mobile
    const { patient: g } = await reg(b, "Ganesh Oraon", "9876500002");
    // B flags A's Kamla as a duplicate of B's Ganesh — the LOSER's registrar (A) owns the count, the winner's (B) does not
    await db.insert(patientMergeRequests).values({
      id: "MR-1", winnerId: g.id, loserId: p2.id, approvalId: "AP-1", requestNote: "same person", snapshot: {},
      status: "requested", requestedBy: b.id, requestedAt: T0,
    });
    const cardsA = await patientsDeskProvider.load(ctxFor(a));
    expect(cardsA.map((c) => c.key)).toEqual(["patients.registration", "patients.cameBack"]);
    expect(statOf(cardsA, "patients.registration", "desk.patients.registered")).toBe("2");
    expect(statOf(cardsA, "patients.registration", "desk.patients.noMobile")).toBe("1");
    expect(statOf(cardsA, "patients.registration", "desk.patients.duplicatesPending")).toBe("1");
    expect(JSON.stringify(cardsA)).not.toContain("Sunita");
    expect(JSON.stringify(cardsA)).not.toContain("Kamla");
    expect(cardsA.every((c) => c.rows === undefined)).toBe(true);
    const cardsB = await patientsDeskProvider.load(ctxFor(b));
    expect(statOf(cardsB, "patients.registration", "desk.patients.registered")).toBe("1");
    expect(statOf(cardsB, "patients.registration", "desk.patients.noMobile")).toBe("0");
    expect(statOf(cardsB, "patients.registration", "desk.patients.duplicatesPending")).toBe("0");   // the loser is A's, not B's
    // every stat is a door
    expect(cardsA.flatMap((c) => c.stats!.map((s) => s.href))).toEqual(["/registration", "/registration", "/merge", "/merge", "/registration", "/registration"]);
  });

  it("what came back, last thirty days: duplicates CONFIRMED (executed, loser mine), no-mobile, amended within a WEEK", async () => {
    const { patient: p1 } = await reg(a, "Sunita Devi", "9876500001");
    const { patient: p2 } = await reg(a, "Kamla");
    const { patient: p3 } = await reg(a, "Radha", "9876500003");
    const { patient: old } = await reg(a, "Ancient");
    const { patient: g } = await reg(b, "Ganesh Oraon", "9876500002");   // B's — the winner of both merges
    await stampCreated(p2.id, daysAgo(16));        // in the thirty-day window
    await stampCreated(old.id, daysAgo(38));       // out of it
    await stampCreated(p3.id, daysAgo(2));         // two days ago: this month, not today
    // executed merge of Kamla (A's) — confirmed duplicate; a requested one is not yet a fact
    await db.insert(patientMergeRequests).values([
      { id: "MR-1", winnerId: g.id, loserId: p2.id, approvalId: "AP-1", requestNote: "dup", snapshot: {}, status: "executed", requestedBy: b.id, requestedAt: T0, executedBy: b.id, executedAt: T0 },
      { id: "MR-2", winnerId: g.id, loserId: p3.id, approvalId: "AP-2", requestNote: "maybe", snapshot: {}, status: "requested", requestedBy: b.id, requestedAt: T0 },
    ]);
    // Radha's spelling fixed at the second visit (inside a week); Sunita's photo/QR do not count; an amendment 10 days later does not count
    await withTx(db, (tx) => updatePatient(tx, a.actor, p3.id, { name: "Radha Kumari" }));
    await stampCreated(p1.id, daysAgo(12));
    await withTx(db, (tx) => updatePatient(tx, a.actor, p1.id, { addressLine: "Ward 4" }));   // 12 days after registration: not "within a week"
    const cards = await patientsDeskProvider.load(ctxFor(a));
    expect(statOf(cards, "patients.cameBack", "desk.patients.duplicatesConfirmed")).toBe("1");
    expect(statOf(cards, "patients.cameBack", "desk.patients.noMobileMonth")).toBe("1");        // Kamla; Ancient is out of the window
    expect(statOf(cards, "patients.cameBack", "desk.patients.amendedWeek")).toBe("1");          // Radha
    expect(statOf(cards, "patients.registration", "desk.patients.registered")).toBe("0");      // nothing registered TODAY after the re-stamps
    const facts = await patientsDeskProvider.facts!(ctxFor(a));
    expect(facts).toEqual({ "patients.noMobile": 0, "patients.duplicates": 1 });
    const cardsB = await patientsDeskProvider.load(ctxFor(b));
    expect(statOf(cardsB, "patients.cameBack", "desk.patients.duplicatesConfirmed")).toBe("0");
    expect(statOf(cardsB, "patients.cameBack", "desk.patients.amendedWeek")).toBe("0");
  });
});
