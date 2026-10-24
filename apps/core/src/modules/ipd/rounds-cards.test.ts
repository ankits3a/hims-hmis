import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { ipdAdmissions, ipdEmarAllergyFlags, ipdRounds, patientAllergies, patients } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkEmarWorld } from "../../../test/helpers/ipd";
import { backfillEmarAllergyFlags, decideAllergyFlag, ipdManifest, placeIpOrder } from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DeskProviderCtx } from "../../kernel/desk/types";
import type { EmarWorld } from "../../../test/helpers/ipd";

/**
 * The doctor's allergy Now card (`ipd.allergy_flags`, `rounds-cards.ts`): an open allergy flag waiting on the doctor, or
 * an allergy recorded since the doctor's last round, on the doctor's own inpatients. Explicit IST instants passed as `now`.
 */
jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const H = (hhmm: string): Date => ist(`2026-03-11T${hhmm}:00`);

describe("ipd.allergy_flags — the doctor's allergy Now card", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: EmarWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkEmarWorld(db); });

  const provider = () => ipdManifest.desk!.find((p) => p.key === "ipd.allergy_flags")!;
  const ctxFor = (actor: Actor, now: Date): DeskProviderCtx => ({ db, actor, reader: actor, date: "", now });
  const load = (actor: Actor, now: Date) => provider().load(ctxFor(actor, now));
  const allergy = (patientId: string, substance: string, at: Date) => db.insert(patientAllergies).values({
    id: newId(), patientId, substance, severity: "severe", source: "consult", recordedBy: w.admitDesk.id, recordedAt: at,
  } as never);
  const round = (admissionId: string, patientId: string, by: Actor, at: Date) => db.insert(ipdRounds).values({
    id: newId(), admissionId, patientId, authorId: by.id, authorKind: "consultant", mode: "bedside", seenAt: at, soap: { plan: "Continue" },
    source: "typed", provenance: "direct", status: "signed", visitOutcome: "remote", createdAt: at,
  });

  it("is its own provider on the doctor's round permission", () => {
    expect(provider().permission).toBe("ipd.round.sign");
  });

  it("an open flag waits on the doctor (hot) and a new allergy is named; decided → only the new allergy; a round after → no card", async () => {
    const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Zemoxicillin 500", { moiety: "Zemoxicillin" });
    const order = await placeIpOrder(db, w.consultant, {
      idempotencyKey: randomUUID(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "TDS", startAt: H("07:00").toISOString(), antibiotic: false, durationDays: 5 },
    }, { now: H("07:00") });
    // A stable patient makes no card.
    expect(await load(w.consultant, H("07:30"))).toEqual([]);

    await allergy(patientId, "Zemoxicillin", H("07:45"));
    expect(await backfillEmarAllergyFlags(db, H("08:00"))).toBe(1);

    const [card] = await load(w.consultant, H("09:00"));
    expect(card!.key).toBe("ipd.allergy_flags");
    expect(card!.band).toBe("now");
    expect(card!.titleKey).toBe("desk.ipdAllergyFlags.title");
    expect(card!.rows!).toHaveLength(1);
    const row = card!.rows![0]!;
    expect(row).toMatchObject({ id: admissionId, href: `/ipd/rounds/${admissionId}`, severity: "hot", action: "Review" });
    expect(row.subtitle).toContain("1 order to decide · 1 new allergy");
    // No drug, allergen or money words on a desk row.
    expect(JSON.stringify(card)).not.toMatch(/zemox|₹|paise|deposit|bill/i);

    // The unit's resident sees it (same team); a doctor on no team does not.
    expect((await load(w.unitResident, H("09:00"))).map((c) => c.rows!.length)).toEqual([1]);
    expect(await load(w.outsider, H("09:00"))).toEqual([]);

    // Decided by the doctor: the flag now waits on the pharmacist, not the doctor. The new allergy stays until a round.
    const flag = (await db.select().from(ipdEmarAllergyFlags).where(eq(ipdEmarAllergyFlags.orderId, order.orderId)))[0]!;
    await decideAllergyFlag(db, w.consultant, { idempotencyKey: randomUUID(), flagId: flag.id, decision: "continue", reason: "Mild rash only" }, { now: H("09:10") });
    const after = (await load(w.consultant, H("09:20")))[0]!.rows![0]!;
    expect(after.severity).toBe("warn");
    expect(after.subtitle).toContain("1 new allergy");
    expect(after.subtitle).not.toContain("to decide");

    // This doctor's round after the allergy clears it for this doctor; the resident has not rounded, so still sees it.
    await round(admissionId, patientId, w.consultant, H("09:30"));
    expect(await load(w.consultant, H("09:40"))).toEqual([]);
    expect((await load(w.unitResident, H("09:40"))).map((c) => c.rows!.length)).toEqual([1]);

    // An allergy recorded after that round shows again.
    await allergy(patientId, "Sulpha", H("10:00"));
    expect((await load(w.consultant, H("10:05")))[0]!.rows![0]!.subtitle).toContain("1 new allergy");
  });

  it("review: two allergies flagging ONE order count one order to decide", async () => {
    const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Zemoxicillin 500", { moiety: "Zemoxicillin" });
    await placeIpOrder(db, w.consultant, {
      idempotencyKey: randomUUID(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "TDS", startAt: H("07:00").toISOString(), antibiotic: false, durationDays: 5 },
    }, { now: H("07:00") });
    await allergy(patientId, "Zemoxicillin", H("07:45"));
    await allergy(patientId, "Zemoxicillin 500", H("07:46"));
    expect(await backfillEmarAllergyFlags(db, H("08:00"))).toBe(2);
    const row = (await load(w.consultant, H("09:00")))[0]!.rows![0]!;
    expect(row.subtitle).toContain("1 order to decide · 2 new allergies");
  });

  it("an allergy recorded before the admission is not new; a sealed patient's row shows no UHID and no bed", async () => {
    const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    await allergy(patientId, "Peanut", ist("2026-03-09T10:00:00"));
    expect(await load(w.consultant, H("09:00"))).toEqual([]);

    await allergy(patientId, "Latex", H("08:00"));
    await db.update(patients).set({ sensitiveContext: true, alias: "Patient K" } as never).where(eq(patients.id, patientId));
    const row = (await load(w.consultant, H("09:00")))[0]!.rows![0]!;
    expect(row.title).toBe("Patient K");
    const uhid = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.uhid;
    expect(row.subtitle).not.toContain(uhid);
    expect(row.subtitle).toBe("1 new allergy");
    // A discharged stay is not on the doctor's list.
    await db.update(ipdAdmissions).set({ state: "discharged" } as never).where(eq(ipdAdmissions.id, admissionId));
    expect(await load(w.consultant, H("09:00"))).toEqual([]);
  });
});
