import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { counterparties, partnerAgreements } from "../../kernel/db/schema";
import { counterpartyFacts, rateSnapshotOf, requireAgreementAt, resolveAgreementAt } from "./agreements";
import { PartnersError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * DD6 — the agreements resolver. Every code, rate and category below was INVENTED here (DD3 /
 * O-9): the partner book may not be transcribed into a tracked file, and every case this suite
 * tests is a CLASS — an amendment, an open-ended version, a superseded one, a draft — which does
 * not care which invented rate carries it.
 */
const T0 = new Date("2026-04-01T00:00:00Z");
const T1 = new Date("2026-07-01T00:00:00Z");
const T2 = new Date("2026-10-01T00:00:00Z");

const V1_TERMS = { payableRateBps: 1000, eligibleCategories: ["consultation"], kicker: null };
const V2_TERMS = { payableRateBps: 2000, eligibleCategories: ["consultation", "lab"], kicker: null };

describe("partner agreements: the version that governed an instant (DD6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let counterpartyId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    counterpartyId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-CP-${counterpartyId.slice(-6)}`, name: "Invented Channel Partner",
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
  });

  const addVersion = async (args: {
    versionNo: number; from: Date; to: Date | null; terms: unknown; status?: string;
  }): Promise<string> => {
    const id = newId();
    await db.insert(partnerAgreements).values({
      id, counterpartyId, versionNo: args.versionNo, effectiveFrom: args.from, effectiveTo: args.to,
      terms: args.terms, status: args.status ?? "active", createdBy: "test",
    });
    return id;
  };

  it("resolves the version whose HALF-OPEN window contains the instant, and the amendment governs its own first instant", async () => {
    const v1 = await addVersion({ versionNo: 1, from: T0, to: T1, terms: V1_TERMS });
    const v2 = await addVersion({ versionNo: 2, from: T1, to: null, terms: V2_TERMS });

    const before = await resolveAgreementAt(db, counterpartyId, new Date(T1.getTime() - 1));
    expect(before?.agreementId).toBe(v1);
    expect(before?.terms.payableRateBps).toBe(1000);

    // `[from, to)` — T1 itself belongs to the amendment and to nothing else. An inclusive upper
    // bound would put one instant in two versions, and "which rate governed that payment" would
    // depend on which row the planner returned first.
    const at = await resolveAgreementAt(db, counterpartyId, T1);
    expect(at?.agreementId).toBe(v2);
    expect(at?.terms).toEqual({ payableRateBps: 2000, eligibleCategories: ["consultation", "lab"], kicker: null });

    const after = await resolveAgreementAt(db, counterpartyId, T2);
    expect(after?.agreementId).toBe(v2);
  });

  it("an instant before the first version, and one after a CLOSED last version, resolve to nothing", async () => {
    await addVersion({ versionNo: 1, from: T0, to: T1, terms: V1_TERMS });
    expect(await resolveAgreementAt(db, counterpartyId, new Date(T0.getTime() - 1))).toBeNull();
    // O-7's `terminated` path is exactly this: a termination closes the window, and an invoice
    // issued after the term date resolves no version and accrues nothing.
    expect(await resolveAgreementAt(db, counterpartyId, T2)).toBeNull();
  });

  it("only an ACTIVE version prices anything — a draft and a superseded one are invisible", async () => {
    await addVersion({ versionNo: 1, from: T0, to: null, terms: V1_TERMS, status: "superseded" });
    await addVersion({ versionNo: 2, from: T0, to: null, terms: V2_TERMS, status: "draft" });
    expect(await resolveAgreementAt(db, counterpartyId, T1)).toBeNull();
  });

  it("two overlapping ACTIVE versions resolve DETERMINISTICALLY to the highest version_no", async () => {
    // `partner_agreements` carries no exclusion constraint, so this state is expressible. A replay
    // must reach the same answer the live run did, so the tie-break is stated rather than left to
    // the planner.
    await addVersion({ versionNo: 1, from: T0, to: null, terms: V1_TERMS });
    const v2 = await addVersion({ versionNo: 2, from: T0, to: null, terms: V2_TERMS });
    for (let i = 0; i < 3; i += 1) {
      expect((await resolveAgreementAt(db, counterpartyId, T1))?.agreementId).toBe(v2);
    }
  });

  it("terms this lane cannot read are a REFUSAL, never a silent zero", async () => {
    await addVersion({ versionNo: 1, from: T0, to: null, terms: { rate: "ten percent" } });
    await expect(resolveAgreementAt(db, counterpartyId, T1)).rejects.toThrow(PartnersError);
    await expect(resolveAgreementAt(db, counterpartyId, T1)).rejects.toMatchObject({ code: "unknown_agreement" });
  });

  it("an agreement with NO eligibleCategories key fails to parse — an unconfigured set is not an empty one", async () => {
    // Deliberately not defaulted: an agreement whose eligible set was never configured must fail
    // loudly rather than silently accrue on every line in the hospital.
    await addVersion({ versionNo: 1, from: T0, to: null, terms: { payableRateBps: 1000 } });
    await expect(resolveAgreementAt(db, counterpartyId, T1)).rejects.toMatchObject({ code: "unknown_agreement" });
  });

  it("an agreement that earns on NOTHING is expressible, and parses", async () => {
    await addVersion({ versionNo: 1, from: T0, to: null, terms: { payableRateBps: 1000, eligibleCategories: [] } });
    expect((await resolveAgreementAt(db, counterpartyId, T1))?.terms.eligibleCategories).toEqual([]);
  });

  it("terms keys this lane does not own are CARRIED, not refused — later lanes read `rawTerms`", async () => {
    await addVersion({
      versionNo: 1, from: T0, to: null,
      terms: { ...V1_TERMS, receivableRateBps: 750, settlementDays: 45 },
    });
    const resolved = await resolveAgreementAt(db, counterpartyId, T1);
    expect(resolved?.terms.payableRateBps).toBe(1000);
    expect(resolved?.rawTerms).toEqual({ ...V1_TERMS, receivableRateBps: 750, settlementDays: 45 });
  });

  it("`requireAgreementAt` refuses with `no_effective_agreement` where `resolveAgreementAt` returns null", async () => {
    await expect(requireAgreementAt(db, counterpartyId, T1)).rejects.toMatchObject({ code: "no_effective_agreement" });
    await addVersion({ versionNo: 1, from: T0, to: null, terms: V1_TERMS });
    expect((await requireAgreementAt(db, counterpartyId, T1)).versionNo).toBe(1);
  });

  it("the SNAPSHOT carries resolved numbers and the instant they were pinned at, never a pointer", async () => {
    const v1 = await addVersion({ versionNo: 1, from: T0, to: T1, terms: V1_TERMS });
    const agreement = (await requireAgreementAt(db, counterpartyId, T0));
    expect(rateSnapshotOf(agreement, T0)).toEqual({
      agreementId: v1,
      versionNo: 1,
      effectiveFrom: T0.toISOString(),
      payableRateBps: 1000,
      eligibleCategories: ["consultation"],
      pinnedAt: T0.toISOString(),
      pinnedTo: "invoice.issued_at",
    });
  });

  it("`counterpartyFacts` reports the class and the status, and nothing for an id this database does not hold", async () => {
    expect(await counterpartyFacts(db, counterpartyId)).toEqual({
      counterpartyId, payeeClass: "channel_partner", status: "active",
    });
    expect(await counterpartyFacts(db, newId())).toBeNull();
  });

  it("`counterparties_status_ck` refuses a status outside O-7's three", async () => {
    // The phase relay records this CHECK as shipping with no assertion anywhere; this task writes
    // a `status` predicate, so it asserts the refusal here rather than assuming one exists.
    await expect(
      db.insert(counterparties).values({
        id: newId(), code: `INV-CP-BAD-${newId().slice(-6)}`, name: "Invented bad-status partner",
        payeeClass: "channel_partner", status: "paused", createdBy: "test",
      }),
    ).rejects.toThrow(/counterparties_status_ck/);
  });
});
