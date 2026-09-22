import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, addAllergy, issueRx, line, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { mkUser, testCfg } from "../../../test/helpers/opd";
import { events, pharmacyAuthorisations } from "../../kernel/db/schema";
import { decideAuthorisation, pendingAuthorisationsFor, requestAuthorisation } from "./authorisations";
import { claimDispense, findAtCounter } from "./claim";
import { pharmacyAuthorisationsDeskProvider } from "./desk-provider";
import { getDispense } from "./queue";
import { precheckTicket, verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PD-9 — OWNER RULING 2026-09-19: "the doctor must authorise dispensing against a recorded allergy."
 *
 * The pharmacist asks THE PRESCRIBER — a person, not a role — to authorise one refusal on one line;
 * the doctor authorises or declines with a reason; an authorisation clears exactly that refusal and
 * nothing else. Nobody but the prescriber may decide, and never the person who asked.
 */
describe("the prescriber authorises what the check would refuse (PD-9)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  /** Crocin (paracetamol) and Azee (azithromycin), claimed; the allergies are recorded AFTER the issue. */
  async function claimedWithAllergy(...substances: string[]): Promise<string> {
    const { issued } = await issueRx(db, fx, [
      line({ drug: "Crocin 500", medicineId: fx.med.crocin }),
      line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 }),
    ]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("expected a dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    for (const s of substances) await addAllergy(db, fx.patient.id, s);
    return r.dispense.id;
  }
  const verify = (id: string) =>
    verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }, { lineIdx: 1, qtyBase: 3 }] }, MON2);
  const ask = (id: string, lineIdx = 0, about = "Paracetamol") =>
    requestAuthorisation(db, fx.pharmacist.actor, { dispenseId: id, lineIdx, book: "allergy", about, note: "says she took it last year without trouble" }, MON2);

  it("is addressed to the prescriber; only the prescriber decides, with a reason; then the check passes the line", async () => {
    const id = await claimedWithAllergy("Paracetamol");
    await expect(verify(id)).rejects.toThrow(expect.objectContaining({ code: "allergy_block" }));

    const asked = await ask(id);
    expect(asked).toMatchObject({ status: "pending", prescriberUserId: fx.doctor.userId, book: "allergy", about: "Paracetamol" });
    expect((await pendingAuthorisationsFor(db, fx.doctor.actor)).map((a) => a.id)).toEqual([asked.id]);
    expect(await pendingAuthorisationsFor(db, fx.pharmacist.actor)).toEqual([]);

    // the pharmacist who asked may not decide; nor may a doctor who did not prescribe
    await expect(decideAuthorisation(db, fx.pharmacist.actor, asked.id, { authorise: true, reason: "fine" }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "permission_denied", detail: expect.objectContaining({ reason: "not_the_prescriber" }) }));
    const other = await mkUser(db, "dr.other", ["doctor"]);
    await expect(decideAuthorisation(db, other.actor, asked.id, { authorise: true, reason: "fine" }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "permission_denied" }));
    await expect(decideAuthorisation(db, fx.doctor.actor, asked.id, { authorise: true, reason: " " }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "reason_required" }));

    await decideAuthorisation(db, fx.doctor.actor, asked.id, { authorise: true, reason: "mild rash only, benefit outweighs" }, MON2);
    const v = await verify(id);
    expect(v.status).toBe("verified");
    expect((await db.select().from(events).where(eq(events.name, "authorisation.decided"))).map((e) => e.payload))
      .toEqual([expect.objectContaining({ authorisationId: asked.id, status: "authorised", decidedBy: fx.doctor.userId })]);
  });

  it("a decline keeps the refusal; the pharmacist may ask again, and a decided request cannot be decided twice", async () => {
    const id = await claimedWithAllergy("Paracetamol");
    const first = await ask(id);
    await decideAuthorisation(db, fx.doctor.actor, first.id, { authorise: false, reason: "anaphylaxis on record — change the drug" }, MON2);
    await expect(verify(id)).rejects.toThrow(expect.objectContaining({ code: "allergy_block" }));
    await expect(decideAuthorisation(db, fx.doctor.actor, first.id, { authorise: true, reason: "changed my mind" }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "authorisation_not_pending" }));
    const again = await ask(id);
    expect(again.id).not.toBe(first.id);
    // asking twice while one is open answers with the open one
    expect((await ask(id)).id).toBe(again.id);
  });

  it("clears exactly its line and its allergy — another line, or another allergy, is still refused", async () => {
    const id = await claimedWithAllergy("Paracetamol", "Azithromycin");
    const a = await ask(id, 0, "Paracetamol");
    await decideAuthorisation(db, fx.doctor.actor, a.id, { authorise: true, reason: "tolerated before" }, MON2);
    await expect(verify(id)).rejects.toThrow(expect.objectContaining({ code: "allergy_block", detail: { hits: [{ lineIdx: 1, substance: "Azithromycin" }] } }));
    expect((await precheckTicket(db, fx.pharmacist.actor, id, MON2)).lines.map((l) => [l.lineIdx, l.verdict])).toEqual([[0, "clear"], [1, "blocked"]]);
  });

  it("names a refusal the check actually raises, or it is refused as not needed", async () => {
    const id = await claimedWithAllergy("Paracetamol");
    await expect(ask(id, 0, "Ibuprofen")).rejects.toThrow(expect.objectContaining({ code: "authorisation_not_needed" }));
    await expect(ask(id, 1, "Paracetamol")).rejects.toThrow(expect.objectContaining({ code: "authorisation_not_needed" }));
    expect(await db.select().from(pharmacyAuthorisations)).toEqual([]);
  });

  it("the ticket shows each line's request, and the prescriber by name", async () => {
    const id = await claimedWithAllergy("Paracetamol");
    const a = await ask(id);
    const d = await getDispense(db, fx.pharmacist.actor, id, MON2);
    expect(d.prescriberName).toBe("Dr dr.sen");
    expect(d.lines[0]!.authorisations).toEqual([expect.objectContaining({ id: a.id, book: "allergy", about: "Paracetamol", status: "pending" })]);
    expect(d.lines[1]!.authorisations).toEqual([]);
  });

  it("the prescriber's own desk carries the request, linked to the page that decides it; nobody else's does", async () => {
    const id = await claimedWithAllergy("Paracetamol");
    const a = await ask(id);
    const ctx = (actor: typeof fx.doctor.actor) => ({ db, actor, reader: actor, date: "2026-08-17", now: MON2 });
    const cards = await pharmacyAuthorisationsDeskProvider.load(ctx(fx.doctor.actor));
    expect(cards).toEqual([expect.objectContaining({
      key: "pharmacy.authorisations", titleKey: "desk.pharmacy.authorise",
      rows: [expect.objectContaining({ id: a.id, badge: expect.stringMatching(/^P-\d+$/), subtitle: "allergy · Paracetamol", href: `/pharmacy/authorisations/${a.id}`, severity: "hot" })],
    })]);
    expect(await pharmacyAuthorisationsDeskProvider.load(ctx(fx.pharmacist.actor))).toEqual([]);
    await decideAuthorisation(db, fx.doctor.actor, a.id, { authorise: true, reason: "tolerated before" }, MON2);
    expect(await pharmacyAuthorisationsDeskProvider.load(ctx(fx.doctor.actor))).toEqual([]);
  });
});
