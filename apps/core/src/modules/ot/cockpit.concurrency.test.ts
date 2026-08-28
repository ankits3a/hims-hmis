import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { mkOtPatient, mkOtUser, seedOtBase } from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import { assignResource, createResource } from "../../kernel/resources/registry";
import { OT_RESOURCE_KINDS } from "./kinds";
import { otCases, resources } from "../../kernel/db/schema";
import { recordReceipt } from "../billing";
import { bookCase, caseState } from "./booking";
import { holdDeposit } from "./deposit";
import { caseGates, satisfyGate } from "./gates";
import { publishList } from "./lists";
import { signIn, toHolding } from "./cockpit";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T5 / A12 — **TWO SIGN-INS, ONE THEATRE.**
 *
 * ═══ WHY THIS IS A SEPARATE FILE, AND WHAT IT ASSERTS ═══
 *
 * `ledger.concurrency.test.ts`'s discipline, transcribed: a `Promise.all` over two `withTx` calls
 * is a coin flip, not a race (§3.22), and a timing assertion is green on an idle host and red on a
 * busy one (§2.99). So this asserts a **STATE** — exactly one sign-in succeeded, the other was
 * refused `already_occupied`, and the theatre row names the winner — and it produces the overlap
 * deterministically with a barrier rather than by hoping two promises collide.
 *
 * ═══ TWO THEATRES DO NOT DISCRIMINATE, AND THE PLAN SAYS SO ═══
 *
 * The Assertion Book names it: *"Two theatres do not discriminate."* Of course they do not — there
 * is no contention. The leg is written against ONE theatre, which is also the only theatre this
 * unit has.
 *
 * ═══ THE LOCK THIS DEPENDS ON DID NOT EXIST WHEN THE PLAN WAS WRITTEN (finding T5-a) ═══
 *
 * A12 assumes the race *"goes through the registry's `assign`, which owns that lock"*. It did not:
 * `assignResource` read the row with a plain `SELECT` and was a read-check-write.
 * `kernel/resources/registry.concurrency.test.ts` reproduces the kernel defect and this commit
 * fixes it there. This file is the OT-level proof that `signIn` inherits the fix.
 */
const LIST_DATE = "2026-09-02";
const SLOT = "2026-09-02T03:30:00.000Z";
const PROBE_MS = 400;

jest.setTimeout(40_000);

const delay = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

describe("the OT cockpit under contention (Plan 15 T5, A12)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let f: OtBaseFixture;
  let cashier: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    f = await seedOtBase(db);
    cashier = await mkOtUser(db, "ot_cashier_x", ["cashier"]);
    await openSessionFor(db, { id: cashier.id }, 0);
  });

  /** A case driven all the way to the holding bay, ready to be signed in. */
  async function caseInHolding(name: string, phone: string): Promise<string> {
    const patientId = await mkOtPatient(db, f.coordinator, name, { phone });
    const r = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: LIST_DATE, payerClass: "self_pay", force: true,
    });
    const g = new Map((await caseGates(db, r.caseId)).map((x) => [x.kind, x.id]));
    const consent = {
      procedureCode: "GYN-DNC-01", templateVersion: "v3", language: "hi", signer: "patient",
      thumbImpression: false, laterality: null, conversionCovered: true, signedAt: "2026-09-01T10:00:00.000Z",
    };
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("consent_procedure")!, consent));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("consent_anaesthesia")!, consent));
    await withTx(db, (tx) => satisfyGate(tx, f.anaesthetist, g.get("anaesthesia_review")!, {
      asaGrade: 1, reviewedBy: f.anaesthetist.id, reviewedAt: "2026-08-30T06:00:00.000Z",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("npo")!, {
      plannedStart: SLOT, lastSolidsAt: "2026-09-01T16:00:00.000Z",
      lastClearFluidsAt: "2026-09-01T21:00:00.000Z", attestedBy: "patient",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("escort")!, {
      name: "Ram Kumar", relation: "husband", phone: "9800002222", idType: "aadhaar", idLast4: "4321", ageYears: 40,
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("privilege")!, {}));
    const { receiptId } = await recordReceipt(db, cashier, {
      patientId, tenders: [{ mode: "upi", amountPaise: 6_000_000, refText: `UPI/${phone}` }],
    });
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: r.encounterId, receiptId, amountPaise: 6_000_000 }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("deposit")!, {}));
    await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
    await toHolding(db, f.incharge, r.caseId);
    return r.caseId;
  }

  /**
   * A12 — **exactly one sign-in wins, and the theatre ends `in_use` with ONE occupant.**
   *
   * The overlap is produced deterministically: transaction A signs in and then holds open on a
   * barrier the test controls, so B's `assignResource` is guaranteed to run while A is uncommitted.
   * A read-check-write lets B past; the locked read makes it wait and then see the truth.
   */
  it("A12 — two concurrent sign-ins on ONE theatre: exactly one succeeds, the other is refused", async () => {
    const caseA = await caseInHolding("Sunita Devi", "9800001111");
    const caseB = await caseInHolding("Meena Kumari", "9800002211");

    let releaseBarrier: () => void = () => { /* replaced below */ };
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });

    // A signs in inside a transaction that stays open until the test lets it commit. It uses the
    // module's own pieces rather than `signIn` so the barrier can sit INSIDE the transaction.
    const a = withTx(db, async (tx) => {
      const kase = (await tx.select().from(otCases).where(eq(otCases.id, caseA)))[0]!;
      await assignResource(tx, f.anaesthetist, OT_RESOURCE_KINDS, kase.theatreResourceId, {
        occupantType: "ot_case", occupantRef: caseA,
      });
      await barrier;
    });
    a.catch(() => { /* observed below */ });
    await delay(50);

    // B is the REAL `signIn`, overlapping A.
    const b = signIn(db, f.anaesthetist, caseB);
    b.catch(() => { /* observed below */ });

    // A STATE, never a duration (§2.99): a busy host makes "still waiting" more true, not less.
    const state = await Promise.race([
      b.then(() => "settled", () => "settled"),
      delay(PROBE_MS).then(() => "pending"),
    ]);
    expect(state).toBe("pending");

    releaseBarrier();
    const [aResult, bResult] = await Promise.allSettled([a, b]);

    expect(aResult.status).toBe("fulfilled");
    expect(bResult.status).toBe("rejected");
    expect(String((bResult as PromiseRejectedResult).reason)).toMatch(/already occupied/);

    // ONE occupant, and it is A's. Under a read-check-write both fulfil and the theatre names B,
    // while B's caller has been told it has the theatre AND A's has too.
    const theatre = (await db.select().from(resources).where(eq(resources.id, f.theatreId)))[0]!;
    expect({ status: theatre.status, occupantType: theatre.occupantType, occupantRef: theatre.occupantRef })
      .toEqual({ status: "in_use", occupantType: "ot_case", occupantRef: caseA });

    // …and B's case never moved: the loser's whole transaction rolled back, so it is still in the
    // holding bay rather than `signed_in` for a theatre it does not have.
    expect(await caseState(db, caseB)).toBe("in_holding");
  });

  /**
   * The NON-discriminating leg, kept and labelled — the plan names it: *"Two theatres do not
   * discriminate."* With a second theatre there is no contention and both sign-ins succeed under
   * every implementation.
   */
  it("A12 — two sign-ins on DIFFERENT theatres both succeed: this leg discriminates NOTHING", async () => {
    const caseA = await caseInHolding("Sunita Devi", "9800001111");
    const caseB = await caseInHolding("Meena Kumari", "9800002211");
    const second = await withTx(db, (tx) => createResource(tx, f.incharge, OT_RESOURCE_KINDS, {
      kind: "theatre", code: "OT-2", name: "Theatre 2",
    }));
    await db.update(otCases).set({ theatreResourceId: second.resourceId }).where(eq(otCases.id, caseB));

    await signIn(db, f.anaesthetist, caseA);
    await signIn(db, f.anaesthetist, caseB);
    expect(await caseState(db, caseA)).toBe("signed_in");
    expect(await caseState(db, caseB)).toBe("signed_in");
  });
});
