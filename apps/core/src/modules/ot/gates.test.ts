import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { mkOtPatient, mkOtUser, publishOtDefinition, seedOtBase } from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import { approveRequest } from "../../kernel/approvals/decisions";
import { events, otCaseGates, otCases } from "../../kernel/db/schema";
import { recordReceipt } from "../billing";
import { bookCase, caseState, changePayerClass } from "./booking";
import { holdDeposit, requestDepositException } from "./deposit";
import { caseGates, evaluateReadiness, gateState, overrideGate, satisfyGate, waiveGate } from "./gates";
import { publishList } from "./lists";
import { guardiansWithAuthority } from "../patients";
import { OtError } from "./errors";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T4 / DD5 — the gates. Every kind is COMPUTED; the override lane is not uniform.
 */
const LIST_DATE = "2026-09-02";
/** IST, not UTC noon — Plan 14's m2. A 09:00 list is `03:30Z`. */
const SLOT = "2026-09-02T03:30:00.000Z";

describe("the OT gates (Plan 15 T4 / DD5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let f: OtBaseFixture;
  let patientId: string;
  let cashier: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    f = await seedOtBase(db);
    patientId = await mkOtPatient(db, f.coordinator, "Sunita Devi", { phone: "9800001111" });
    cashier = await mkOtUser(db, "ot_cashier_g", ["cashier"]);
    await openSessionFor(db, { id: cashier.id }, 0);
  });

  async function book(over: Record<string, unknown> = {}): Promise<{ caseId: string; encounterId: string }> {
    const r = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: LIST_DATE, payerClass: "self_pay", ...over,
    });
    return { caseId: r.caseId, encounterId: r.encounterId };
  }

  async function gateId(caseId: string, kind: string): Promise<string> {
    const gates = await caseGates(db, caseId);
    const found = gates.find((g) => g.kind === kind);
    if (!found) throw new Error(`no ${kind} gate on ${caseId}`);
    return found.id;
  }

  /**
   * Satisfies the deposit gate by actually paying for it.
   *
   * **UPI, not cash, and that is a fixture decision rather than a detail.** A ₹60,000 CASH advance
   * trips billing's own PAN threshold (`panThresholdPaise` 5,000,000) and refuses — which is D15
   * working correctly and has nothing to do with any gate. Paying by UPI keeps this helper about the
   * gate; the cash-law path gets its own leg in T7's A31, where it is the property under test rather
   * than an accident of the fixture.
   */
  async function payAndSatisfyDeposit(caseId: string, encounterId: string, amountPaise = 6_000_000): Promise<void> {
    const { receiptId } = await recordReceipt(db, cashier, { patientId, tenders: [{ mode: "upi", amountPaise, refText: "UPI/2026/0902" }] });
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId, receiptId, amountPaise }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "deposit"), {}));
  }
  // Resolved eagerly per test; a tiny cache so the helper above stays synchronous where it reads.
  let gateIdCache: Map<string, string> = new Map();
  function gateIdSync(caseId: string, kind: string): string {
    const found = gateIdCache.get(`${caseId}:${kind}`);
    if (found === undefined) throw new Error(`gate ${kind} not cached`);
    return found;
  }
  async function cacheGates(caseId: string): Promise<void> {
    gateIdCache = new Map();
    for (const g of await caseGates(db, caseId)) gateIdCache.set(`${caseId}:${g.kind}`, g.id);
  }

  const CONSENT = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    procedureCode: "GYN-DNC-01", templateVersion: "v3", language: "hi", signer: "patient",
    thumbImpression: false, laterality: null, conversionCovered: true,
    signedAt: "2026-09-01T10:00:00.000Z", ...over,
  });

  // ═══════════════════════════════ A6 ═══════════════════════════════

  /**
   * ═══ A6 — `listed → ready` NEEDS EVERY GATE, NOT MOST OF THEM ═══
   *
   * Eight of nine satisfied. The shipped code leaves the case `listed`; the mutant — which counts
   * `satisfied + open` as done — flips it to `ready`, and a case in `ready` can be wheeled into the
   * holding bay with an open consent.
   */
  it("A6 — a case cannot reach `ready` while ANY required gate is open", async () => {
    const { caseId, encounterId } = await book({
      procedureClass: "ortho_distal_radius_fixation", procedureCode: "ORT-RAD-01", laterality: "right",
    });
    await cacheGates(caseId);
    const gates = await caseGates(db, caseId);
    expect(gates).toHaveLength(9);

    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_procedure"), CONSENT({
      procedureCode: "ORT-RAD-01", laterality: "right",
    })));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_anaesthesia"), CONSENT({
      procedureCode: "ORT-RAD-01", laterality: "right",
    })));
    await withTx(db, (tx) => satisfyGate(tx, f.anaesthetist, gateIdSync(caseId, "anaesthesia_review"), {
      asaGrade: 2, reviewedBy: f.anaesthetist.id, reviewedAt: "2026-08-30T06:00:00.000Z",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.surgeon, gateIdSync(caseId, "site_marking"), {
      laterality: "right", markedBy: f.surgeon.id, markedAt: "2026-09-02T03:00:00.000Z",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "npo"), {
      plannedStart: SLOT, lastSolidsAt: "2026-09-01T16:00:00.000Z",
      lastClearFluidsAt: "2026-09-01T21:00:00.000Z", attestedBy: "patient",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "escort"), {
      name: "Ram Kumar", relation: "husband", phone: "9800002222", idType: "aadhaar",
      idLast4: "4321", ageYears: 40,
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "privilege"), {}));
    await withTx(db, (tx) => satisfyGate(tx, f.incharge, gateIdSync(caseId, "mlc"), {
      status: "ruled_out", decidedBy: f.incharge.id,
    }));

    // EIGHT of nine. The ninth — `deposit` — is untouched.
    const eight = await caseGates(db, caseId);
    expect(eight.filter((g) => g.state === "open").map((g) => g.kind)).toEqual(["deposit"]);

    // The case has to be `listed` for readiness to be evaluable at all.
    await withTx(db, (tx) => evaluateReadiness(tx, caseId));
    expect(await caseState(db, caseId)).toBe("booked");
  });

  it("A6 — satisfying the LAST gate flips the case to `ready` in the same call", async () => {
    const { caseId, encounterId } = await book();
    await cacheGates(caseId);
    // A D&C: seven gates.
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_procedure"), CONSENT()));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_anaesthesia"), CONSENT()));
    await withTx(db, (tx) => satisfyGate(tx, f.anaesthetist, gateIdSync(caseId, "anaesthesia_review"), {
      asaGrade: 1, reviewedBy: f.anaesthetist.id, reviewedAt: "2026-08-30T06:00:00.000Z",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "npo"), {
      plannedStart: SLOT, lastSolidsAt: "2026-09-01T16:00:00.000Z",
      lastClearFluidsAt: "2026-09-01T21:00:00.000Z", attestedBy: "patient",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "escort"), {
      name: "Ram Kumar", relation: "husband", phone: "9800002222", idType: "aadhaar", idLast4: "4321", ageYears: 40,
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "privilege"), {}));
    await payAndSatisfyDeposit(caseId, encounterId);

    // Now `listed`, then the evaluation flips it.
    await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
    expect(await caseState(db, caseId)).toBe("ready");
  });

  // ═══════════════════════════════ A7 ═══════════════════════════════

  /**
   * ═══ A7 — CASE = CONSENT = MARKING, ALL THREE ═══
   *
   * The discriminating input is **case L, consent R, marking L**: the surgeon marked the side the
   * booking says, and the patient consented to the other one. A check that compares the marking to
   * the CASE passes this — the two agree — and lets a wrong-side operation through with a correct
   * marking. Case ≠ marking is the fixture that does NOT discriminate.
   */
  it("A7 — `site_marking` is refused when the CONSENT disagrees, though case and marking agree", async () => {
    const { caseId } = await book({
      procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left",
    });
    await cacheGates(caseId);
    // The consent gate has to be satisfied first — and a consent whose laterality is not the case's
    // is refused there. So the RIGHT consent is written by hand onto the gate row, which is the only
    // way to reach the state A7 describes: a consent that disagrees, already recorded.
    await db.update(otCaseGates)
      .set({ evidence: { kind: "consent", consent: { laterality: "right" } } })
      .where(eq(otCaseGates.id, gateIdSync(caseId, "consent_procedure")));

    await expect(withTx(db, (tx) => satisfyGate(tx, f.surgeon, gateIdSync(caseId, "site_marking"), {
      laterality: "left", markedBy: f.surgeon.id, markedAt: "2026-09-02T03:00:00.000Z",
    }))).rejects.toThrow(/laterality disagrees — booking left, consent right, marking left/);

    // The NON-discriminating leg: case L, marking R. Both implementations refuse.
    await expect(withTx(db, (tx) => satisfyGate(tx, f.surgeon, gateIdSync(caseId, "site_marking"), {
      laterality: "right", markedBy: f.surgeon.id, markedAt: "2026-09-02T03:00:00.000Z",
    }))).rejects.toThrow(/laterality disagrees/);

    // And with all three agreeing, it satisfies.
    await db.update(otCaseGates)
      .set({ evidence: { kind: "consent", consent: { laterality: "left" } } })
      .where(eq(otCaseGates.id, gateIdSync(caseId, "consent_procedure")));
    await withTx(db, (tx) => satisfyGate(tx, f.surgeon, gateIdSync(caseId, "site_marking"), {
      laterality: "left", markedBy: f.surgeon.id, markedAt: "2026-09-02T03:00:00.000Z",
    }));
    expect(await gateState(db, gateIdSync(caseId, "site_marking"))).toBe("satisfied");
  });

  // ═══════════════════════════════ A8 ═══════════════════════════════

  /**
   * ═══ A8 — TWO PEOPLE, AND THE FIXTURE HAS TO MAKE THAT THE ONLY THING THAT CAN REFUSE ═══
   *
   * One user holding BOTH roles, acting as themselves. Every other guard on this path passes: the
   * engine's transition allows `surgeon` and `anaesthetist` and this actor holds both, the reason is
   * present, the kind is overridable, the gate is open. **The distinct-id check is the only line
   * left that can say no**, which is what makes this a kill of the mutation rather than of the
   * fixture.
   *
   * The first version of this test used the IN-CHARGE as the acting user, and the mutant died — on
   * the ENGINE's role check, with "transition open→overridden allows roles: surgeon, anaesthetist".
   * That is a kill of the wrong thing: it proves the workflow definition is right, not that this
   * function counts people. Recorded because rule 21 exists for exactly this, and because the
   * corrected fixture is one word different and an entirely different assertion.
   */
  it("A8 — an override with the SAME user as surgeon and anaesthetist is refused `same_actor`", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    const both = await mkOtUser(db, "ot_both_roles", ["surgeon", "anaesthetist"]);
    await expect(withTx(db, (tx) => overrideGate(tx, both, gateIdSync(caseId, "npo"), {
      surgeonId: both.id, anaesthetistId: both.id, reason: "fasted since 22:00 per the ward chart",
    }))).rejects.toThrow(/must be different actors/);
    // The control: the SAME actor, with two DIFFERENT ids, succeeds. So the refusal above is about
    // the pair being one person and not about who is holding the mouse.
    await withTx(db, (tx) => overrideGate(tx, both, gateIdSync(caseId, "npo"), {
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id, reason: "ward chart shows 22:00",
    }));
    expect(await gateState(db, gateIdSync(caseId, "npo"))).toBe("overridden");
  });

  it("A8 — two users LACKING the named roles are refused, and the success path emits the event", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    await expect(withTx(db, (tx) => overrideGate(tx, f.incharge, gateIdSync(caseId, "npo"), {
      surgeonId: f.coordinator.id, anaesthetistId: f.anaesthetist.id, reason: "x",
    }))).rejects.toThrow(/does not hold the surgeon role/);
    await expect(withTx(db, (tx) => overrideGate(tx, f.incharge, gateIdSync(caseId, "npo"), {
      surgeonId: f.surgeon.id, anaesthetistId: f.otNurse.id, reason: "x",
    }))).rejects.toThrow(/does not hold the anaesthetist role/);
    await expect(withTx(db, (tx) => overrideGate(tx, f.incharge, gateIdSync(caseId, "npo"), {
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id, reason: "   ",
    }))).rejects.toThrow(/must carry a reason/);

    await withTx(db, (tx) => overrideGate(tx, f.surgeon, gateIdSync(caseId, "npo"), {
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      reason: "ward chart shows fasting from 22:00; family's time is unreliable",
    }));
    expect(await gateState(db, gateIdSync(caseId, "npo"))).toBe("overridden");
    const emitted = (await db.select().from(events)).filter((e) => e.name === "gate.overridden");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({
      kind: "npo", surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
    });
    // The row carries the pair too, so the case's own record answers "who overrode this".
    const row = (await db.select().from(otCaseGates).where(eq(otCaseGates.id, gateIdSync(caseId, "npo"))))[0]!;
    expect(row.override).toMatchObject({ surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id });
  });

  // ═══════════════════════════════ A9 (T4's) ═══════════════════════════════

  /**
   * ═══ A9 — THE OVERRIDE LANE IS NOT UNIFORM ═══
   *
   * `escort` has NO lane, for anybody. `deposit` has one and it is an APPROVAL, not two clinicians.
   * The mutant applies one lane to every kind, which is the shape almost every implementation takes.
   */
  it("A9 — `escort` is not overridable, by two valid clinicians or anybody else", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    await expect(withTx(db, (tx) => overrideGate(tx, f.surgeon, gateIdSync(caseId, "escort"), {
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      reason: "the patient lives next door and insists",
    }))).rejects.toThrow(/no override lane at all/);
    expect(await gateState(db, gateIdSync(caseId, "escort"))).toBe("open");
  });

  it("A9 — `deposit` is refused a clinical override, and satisfies ONLY through a granted exception", async () => {
    const { caseId, encounterId } = await book();
    await cacheGates(caseId);
    await expect(withTx(db, (tx) => overrideGate(tx, f.surgeon, gateIdSync(caseId, "deposit"), {
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id, reason: "poor family",
    }))).rejects.toThrow(/granted ot_deposit_exception is the only path/);

    // With NOTHING paid and no exception, the gate refuses.
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "deposit"), {})))
      .rejects.toThrow(/deposit 0p against a required 6000000p/);

    // A PENDING exception is not a granted one.
    const { approvalId } = await withTx(db, (tx) => requestDepositException(tx, f.coordinator, {
      encounterId, patientId, allowedShortfallPaise: 6_000_000, reason: "BPL family; MS counselled",
    }));
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "deposit"), {
      exceptionApprovalId: approvalId,
    }))).rejects.toThrow(/deposit 0p against a required/);

    // Granted — and NOW it satisfies, with `paid < required`. N12's only path.
    await approveRequest(db, f.owner, { approvalId, note: "approved by the owner" });
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "deposit"), {
      exceptionApprovalId: approvalId,
    }));
    expect(await gateState(db, gateIdSync(caseId, "deposit"))).toBe("satisfied");
    const row = (await db.select().from(otCaseGates).where(eq(otCaseGates.id, gateIdSync(caseId, "deposit"))))[0]!;
    expect(row.evidence).toMatchObject({ requiredPaise: 6_000_000, heldPaise: 0, allowedShortfallPaise: 6_000_000 });
  });

  it("A9 — `privilege` has no override lane either: credentialing is not a clinical judgement", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    await expect(withTx(db, (tx) => overrideGate(tx, f.surgeon, gateIdSync(caseId, "privilege"), {
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id, reason: "he has done hundreds",
    }))).rejects.toThrow(/not overridable/);
  });

  // ═══════════════════════════════ A10 ═══════════════════════════════

  /**
   * ═══ A10 — NPO IS COMPUTED FROM TWO TYPED TIMES ═══
   *
   * Slot 09:00 IST. Solids 05:30 (3.5 h — needs 6) and clear fluids 07:30 (1.5 h — needs 2): BOTH
   * fail. The plan's row names a 4 h intake that fails for solids and passes for fluids, and both
   * shapes are asserted, because a single-threshold implementation passes one of them.
   *
   * The mutant trusts a typed `satisfied: true`, which is what a checkbox is.
   */
  it("A10 — a 4 h fast fails SOLIDS and passes CLEAR FLUIDS, and the failure names which", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    // Solids 4 h before the slot: 3.5 h short. Fluids 4 h before: 2 h clear.
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "npo"), {
      plannedStart: SLOT,
      lastSolidsAt: "2026-09-01T23:30:00.000Z",       // 05:00 IST — 4 h before a 09:00 slot
      lastClearFluidsAt: "2026-09-01T23:30:00.000Z",  // the same instant
      attestedBy: "patient",
    }))).rejects.toThrow(/solids 4\.0 h before the slot \(needs 6 h\)/);

    // The fluid rule alone is met at 4 h — so the refusal above is about SOLIDS only, and a
    // one-threshold implementation would either pass this or fail the next leg.
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "npo"), {
      plannedStart: SLOT,
      lastSolidsAt: "2026-09-01T18:00:00.000Z",       // 23:30 IST the night before — 9.5 h
      lastClearFluidsAt: "2026-09-01T23:30:00.000Z",  // 05:00 IST — 4 h
      attestedBy: "patient",
    }));
    expect(await gateState(db, gateIdSync(caseId, "npo"))).toBe("satisfied");
  });

  it("A10 — the plan's own fixture: solids 05:30 and clear fluids 07:30 against a 09:00 slot", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    try {
      await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "npo"), {
        plannedStart: SLOT,
        lastSolidsAt: "2026-09-02T00:00:00.000Z",      // 05:30 IST — 3.5 h
        lastClearFluidsAt: "2026-09-02T02:00:00.000Z", // 07:30 IST — 1.5 h
        attestedBy: "patient",
      }));
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(OtError);
      expect((error as OtError).detail).toMatchObject({ solidsHours: 3.5, fluidsHours: 1.5 });
    }
  });

  it("A10 — the BOUNDARY is inclusive: exactly six hours is fasted", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "npo"), {
      plannedStart: SLOT,
      lastSolidsAt: "2026-09-01T21:30:00.000Z",       // exactly 6 h
      lastClearFluidsAt: "2026-09-02T01:30:00.000Z",  // exactly 2 h
      attestedBy: "patient",
    }));
    expect(await gateState(db, gateIdSync(caseId, "npo"))).toBe("satisfied");
  });

  // ═══════════════════════════════ A11 ═══════════════════════════════

  /**
   * ═══ A11 — A MINOR'S CONSENT NEEDS A GUARDIAN WITH `consents` AUTHORITY ═══
   *
   * The discriminating input is a guardian holding `messages` authority ONLY — which is a real
   * configuration and, at a registration desk, a common one. The mutant skips the SCOPE and accepts
   * any live guardian.
   */
  it("A11 — a guardian with `messages` authority only cannot consent for a minor", async () => {
    const minor = await mkOtPatient(db, f.coordinator, "Baby Devi", {
      dob: new Date(Date.UTC(2016, 0, 1)),
      guardian: {
        name: "Ram Kumar", relationship: "father", phone: "9800003333",
        authorityMessages: true, authorityConsents: false, authorityDsr: false, authorityBills: false,
      },
    });
    const guardians = await guardiansWithAuthority(db, minor);
    expect(guardians).toHaveLength(1);
    expect(guardians[0]!.authority).toMatchObject({ messages: true, consents: false });

    const r = await bookCase(db, f.coordinator, {
      patientId: minor, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: LIST_DATE, payerClass: "self_pay",
    });
    await cacheGates(r.caseId);
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(r.caseId, "consent_procedure"),
      CONSENT({ signer: "guardian", guardianId: guardians[0]!.guardianId }))))
      .rejects.toThrow(/does not hold CONSENT authority/);
  });

  it("A11 — with `consents` authority the gate satisfies, and an unknown guardian is refused", async () => {
    const minor = await mkOtPatient(db, f.coordinator, "Baby Two", {
      dob: new Date(Date.UTC(2016, 0, 1)),
      guardian: {
        name: "Sita Devi", relationship: "mother", phone: "9800004444",
        authorityMessages: true, authorityConsents: true, authorityDsr: false, authorityBills: true,
      },
    });
    const guardians = await guardiansWithAuthority(db, minor);
    const r = await bookCase(db, f.coordinator, {
      patientId: minor, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: LIST_DATE, payerClass: "self_pay",
    });
    await cacheGates(r.caseId);
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(r.caseId, "consent_procedure"),
      CONSENT({ signer: "guardian", guardianId: guardians[0]!.guardianId })));
    expect(await gateState(db, gateIdSync(r.caseId, "consent_procedure"))).toBe("satisfied");

    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(r.caseId, "consent_anaesthesia"),
      CONSENT({ signer: "guardian", guardianId: "no-such-guardian" }))))
      .rejects.toThrow(/is not a live guardian/);
  });

  // ═══════════════════════ the consent shape's own refusals ═══════════════════════

  it("refuses a consent for a DIFFERENT procedure, and one whose laterality is not the case's (H6/A3)", async () => {
    const { caseId } = await book({
      procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left",
    });
    await cacheGates(caseId);
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_procedure"),
      CONSENT({ procedureCode: "GYN-DNC-01", laterality: "left" }))))
      .rejects.toThrow(/this consent is for "GYN-DNC-01" and the case is "ORT-GANG-01"/);
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_procedure"),
      CONSENT({ procedureCode: "ORT-GANG-01", laterality: "right" }))))
      .rejects.toThrow(/is not the case's/);
  });

  it("refuses a thumb-impression consent with no witness (K4), and a guardian signer with no guardian", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_procedure"),
      CONSENT({ thumbImpression: true })))).rejects.toThrow(/requires a named witness/);
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_procedure"),
      CONSENT({ signer: "guardian" })))).rejects.toThrow(/must name the guardian/);
    // With a witness it passes — the refusal is about the missing witness, not the thumb.
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_procedure"),
      CONSENT({ thumbImpression: true, witness: "Lata Gowda, staff nurse" })));
  });

  // ═══════════════════════ the other computed kinds ═══════════════════════

  it("refuses an ASA above the class maximum, and a review that has expired by the list date", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    await expect(withTx(db, (tx) => satisfyGate(tx, f.anaesthetist, gateIdSync(caseId, "anaesthesia_review"), {
      asaGrade: 3, reviewedBy: f.anaesthetist.id, reviewedAt: "2026-08-30T06:00:00.000Z",
    }))).rejects.toThrow(/ASA 3 exceeds the class maximum of 2/);
    await expect(withTx(db, (tx) => satisfyGate(tx, f.anaesthetist, gateIdSync(caseId, "anaesthesia_review"), {
      asaGrade: 2, reviewedBy: f.anaesthetist.id, reviewedAt: "2026-06-01T06:00:00.000Z",
    }))).rejects.toThrow(/days old on the list date and is valid for 30/);
  });

  it("refuses a minor escort and a patient escorting themselves (N2, A7/N14)", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    const escort = { name: "Chotu", relation: "brother", phone: "9800005555", idType: "aadhaar", idLast4: "1111" };
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "escort"), {
      ...escort, ageYears: 15,
    }))).rejects.toThrow(/must be an adult/);
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "escort"), {
      ...escort, ageYears: 40, escortPatientId: patientId,
    }))).rejects.toThrow(/cannot escort themselves/);
  });

  it("re-evaluates PRIVILEGE at the gate, so a revocation after booking bites (R-3.15)", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    await publishOtDefinition(db, {
      kind: "privileges",
      body: { surgeons: [{ surgeonId: f.surgeon.id, procedureClasses: ["ortho_ganglion_excision"] }] },
      drafter: f.drafter, ms: f.ms,
    });
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "privilege"), {})))
      .rejects.toThrow(/no longer privileged/);
  });

  it("refuses a registered MLC with no police reference (E5)", async () => {
    const { caseId } = await book({
      procedureClass: "ortho_distal_radius_fixation", procedureCode: "ORT-RAD-01", laterality: "right",
    });
    await cacheGates(caseId);
    await expect(withTx(db, (tx) => satisfyGate(tx, f.incharge, gateIdSync(caseId, "mlc"), {
      status: "registered", decidedBy: f.incharge.id,
    }))).rejects.toThrow(/must carry its police reference/);
    // "Ruled out" IS a decision and needs no reference — that asymmetry is E5's point.
    await withTx(db, (tx) => satisfyGate(tx, f.incharge, gateIdSync(caseId, "mlc"), {
      status: "ruled_out", decidedBy: f.incharge.id,
    }));
  });

  // ═══════════════════════ waiving, and the terminal guard ═══════════════════════

  it("waives ONLY a gate this class's criteria mark waivable, and only once", async () => {
    const ganglion = await book({
      procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left",
    });
    await cacheGates(ganglion.caseId);
    // `site_marking` is waivable on this class and NOT on the radius one.
    await withTx(db, (tx) => waiveGate(tx, f.incharge, gateIdSync(ganglion.caseId, "site_marking"), "single ganglion, midline"));
    expect(await gateState(db, gateIdSync(ganglion.caseId, "site_marking"))).toBe("waived");
    await expect(withTx(db, (tx) => waiveGate(tx, f.incharge, gateIdSync(ganglion.caseId, "site_marking"), "again")))
      .rejects.toThrow(/already waived/);
    await expect(withTx(db, (tx) => waiveGate(tx, f.incharge, gateIdSync(ganglion.caseId, "escort"), "family outside")))
      .rejects.toThrow(/is not waivable for this procedure class/);
  });

  it("a satisfied gate cannot be satisfied, waived or overridden again", async () => {
    const { caseId } = await book();
    await cacheGates(caseId);
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_procedure"), CONSENT()));
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, gateIdSync(caseId, "consent_procedure"), CONSENT())))
      .rejects.toThrow(/already satisfied/);
    await expect(withTx(db, (tx) => overrideGate(tx, f.surgeon, gateIdSync(caseId, "consent_procedure"), {
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id, reason: "x",
    }))).rejects.toThrow(/already satisfied/);
  });
});

describe("CLOSE REVIEW M1 — the deposit gate reads the ENCOUNTER's payer class", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let f: OtBaseFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); f = await seedOtBase(db); });

  /**
   * The scenario the review named, and it is not exotic: a case is booked `govt_scheme`, whose
   * deposit policy is `zero`; the scheme then refuses cover and the desk re-classes the encounter
   * to `self_pay`, which is 100% of the quote. `changePayerClass` wrote only
   * `daycare_encounters.payer_class`; the gate read `ot_cases.payer_class`. So the gate went on
   * requiring ₹0 and satisfying at ₹0 held, the patient reached theatre unfunded, and the shortfall
   * surfaced only at discharge — as `unsettled_issue_refused`, with the operation already done.
   */
  it("M1 — re-classing govt_scheme → self_pay makes the deposit gate require the real money", async () => {
    const patientId = await mkOtPatient(db, f.coordinator, "Sunita Devi");
    const { caseId, encounterId } = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, listDate: "2026-09-02", payerClass: "govt_scheme",
    });
    const depositGateId = (await caseGates(db, caseId)).find((g) => g.kind === "deposit")!.id;

    // The scheme refuses cover, so the desk re-classes the ENCOUNTER to self-pay.
    await changePayerClass(db, f.coordinator, {
      encounterId, to: "self_pay", reason: "scheme refused cover",
    });

    // The gate now demands the real money, with nothing held — because it reads the encounter.
    // Before this fix it read `ot_cases.payer_class`, which `changePayerClass` never wrote, and
    // satisfied at ₹0 required against ₹0 held.
    await expect(withTx(db, (tx) => satisfyGate(tx, f.coordinator, depositGateId, {})))
      .rejects.toThrow(/deposit/i);

    // …and the case snapshot was carried along, so no reader sees the two rows disagree.
    const kase = (await db.select().from(otCases).where(eq(otCases.id, caseId)))[0]!;
    expect(kase.payerClass).toBe("self_pay");
  });

  it("M1 — a case still on its ORIGINAL scheme class satisfies at zero, as the policy says", async () => {
    const patientId = await mkOtPatient(db, f.coordinator, "Kamala Iyer");
    const { caseId } = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, listDate: "2026-09-02", payerClass: "govt_scheme",
    });
    const depositGateId = (await caseGates(db, caseId)).find((g) => g.kind === "deposit")!.id;
    // The non-discriminating control: without the re-class, both readings agree, and this leg
    // proves the fix did not simply make every scheme case demand a deposit.
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, depositGateId, {}));
    expect((await caseGates(db, caseId)).find((g) => g.kind === "deposit")!.state).toBe("satisfied");
  });
});
