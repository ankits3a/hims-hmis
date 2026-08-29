import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  daycareEncounters, eventIdempotency, otCaseImplants, otCases, otSpecimens, patients, resources,
} from "../../kernel/db/schema";
import { patientMerged } from "../patients";
import {
  OT_PATIENT_MERGED_CONSUMER, handleMaterialConsumed, handlePatientMerged,
  implantConfirmedConsumer, patientMergedConsumer,
} from "./consumers";
import type { MergeRewrite } from "./consumers";
import { otManifest } from "./manifest";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T2 / A5 — the merge consumer, shipped with its subscription in one commit.
 *
 * A merge means the loser's id stops being a patient. Every OT row naming it must name the winner
 * instead, or the theatre list shows a case belonging to a patient the registry says does not exist.
 * Four columns across three tables carry a patient id in this module and all four are exercised.
 */
const AUDIT = { createdBy: "t", updatedBy: "t" };

describe("the OT patient-merge consumer (Plan 15 T2 / A5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function fixture(): Promise<void> {
    await db.insert(patients).values([
      { id: "win", uhid: "U00000018", name: "Sunita Devi", sex: "female", administrativeGender: "female", ...AUDIT },
      { id: "lose", uhid: "U00000026", name: "Sunita Devi", sex: "female", administrativeGender: "female", ...AUDIT },
      { id: "other", uhid: "U00000034", name: "Ram Kumar", sex: "male", administrativeGender: "male", ...AUDIT },
    ]);
    await db.insert(resources).values({
      id: "th1", kind: "theatre", code: "OT-1", name: "Theatre 1", status: "available", ...AUDIT,
    });
  }

  async function encounter(id: string, patientId: string, escortPatientId: string | null): Promise<void> {
    await db.insert(daycareEncounters).values({
      id, encounterNo: `D260828000${id.slice(-1)}`, patientId, escortPatientId,
      payerClass: "self_pay", ...AUDIT,
    });
    await db.insert(otCases).values({
      id: `c-${id}`, encounterId: id, patientId, theatreResourceId: "th1", listDate: "2026-08-28",
      seq: 1, procedureCode: "GYN-DNC", procedureClass: "gynae_minor", surgeonId: "u1",
      packageServiceCode: "SVC-DC", quotePaise: 100, tariffVersionId: "tv1", payerClass: "self_pay",
      workflowInstanceId: `wf-${id}`, ...AUDIT,
    });
    await db.insert(otSpecimens).values({
      id: `sp-${id}`, caseId: `c-${id}`, encounterId: id, patientId,
      specimenNo: `S260828000${id.slice(-1)}`, site: "endometrium", container: "formalin", createdBy: "t",
    });
  }

  function run(eventId: string, winner: string, loser: string): Promise<MergeRewrite> {
    return withTx(db, (tx: Tx) => handlePatientMerged(tx, eventId, {
      winnerPatientId: winner, loserPatientId: loser,
      winnerUhid: "U00000018", loserUhid: "U00000026", mergeRequestId: "mr1",
    }));
  }

  it("rewrites the loser's id on the encounter, the case and the specimen, and flags re-verification", async () => {
    await fixture();
    await encounter("e1", "lose", null);
    const result = await run("ev1", "win", "lose");
    expect(result).toEqual({ handled: true, encounters: 1, cases: 1, specimens: 1, escortsCleared: 0 });

    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, "e1")))[0]!;
    expect({ patientId: enc.patientId, reVerify: enc.reVerifyIdentity })
      .toEqual({ patientId: "win", reVerify: true });
    expect((await db.select().from(otCases))[0]!.patientId).toBe("win");
    expect((await db.select().from(otSpecimens))[0]!.patientId).toBe("win");
  });

  it("leaves an UNRELATED patient's rows alone — the rewrite is scoped to the loser", async () => {
    await fixture();
    await encounter("e1", "lose", null);
    await encounter("e2", "other", null);
    await run("ev1", "win", "lose");
    const untouched = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, "e2")))[0]!;
    expect({ patientId: untouched.patientId, reVerify: untouched.reVerifyIdentity })
      .toEqual({ patientId: "other", reVerify: false });
  });

  /**
   * ═══ N14, AND IT IS THE LEG THAT WOULD HAVE DEAD-LETTERED THE WHOLE CONSUMER ═══
   *
   * "Two Sunita Devis, one is the other's escort" — and then the two turn out to be one person.
   * A blind `UPDATE … SET patient_id = winner` violates `daycare_encounters_escort_not_self_ck`,
   * aborts the transaction, and the merge consumer dead-letters with a constraint name. The escort
   * link is CLEARED and re-verification raised instead: nobody can be their own escort, and the desk
   * has to find out who is actually taking her home.
   */
  it("CLEARS the escort link when the merge would make a patient her own escort (N14)", async () => {
    await fixture();
    await encounter("e1", "lose", "win"); // the winner was recorded as the loser's escort
    const result = await run("ev1", "win", "lose");
    expect(result).toEqual({ handled: true, encounters: 1, cases: 1, specimens: 1, escortsCleared: 1 });
    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, "e1")))[0]!;
    expect({ patientId: enc.patientId, escort: enc.escortPatientId, reVerify: enc.reVerifyIdentity })
      .toEqual({ patientId: "win", escort: null, reVerify: true });
  });

  it("REWRITES an escort link that does NOT collide, and flags that encounter too", async () => {
    await fixture();
    await encounter("e1", "other", "lose"); // a different patient, escorted by the loser
    const result = await run("ev1", "win", "lose");
    expect(result).toEqual({ handled: true, encounters: 0, cases: 0, specimens: 0, escortsCleared: 0 });
    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, "e1")))[0]!;
    expect({ patientId: enc.patientId, escort: enc.escortPatientId, reVerify: enc.reVerifyIdentity })
      .toEqual({ patientId: "other", escort: "win", reVerify: true });
  });

  it("is IDEMPOTENT by event id — a redelivery rewrites nothing a second time", async () => {
    await fixture();
    await encounter("e1", "lose", null);
    await run("ev1", "win", "lose");
    const replay = await run("ev1", "win", "lose");
    expect(replay).toEqual({ handled: false, encounters: 0, cases: 0, specimens: 0, escortsCleared: 0 });
    expect(await db.select().from(eventIdempotency)).toHaveLength(1);
  });

  /** A self-merge is not a merge, and without this guard it would look like an escort collision on
   *  every encounter the patient has — clearing escort links nobody asked to clear. */
  it("does nothing when winner and loser are the same id", async () => {
    await fixture();
    await encounter("e1", "win", "other");
    const result = await run("ev1", "win", "win");
    expect(result).toEqual({ handled: true, encounters: 0, cases: 0, specimens: 0, escortsCleared: 0 });
    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, "e1")))[0]!;
    expect({ escort: enc.escortPatientId, reVerify: enc.reVerifyIdentity })
      .toEqual({ escort: "other", reVerify: false });
  });

  it("the Handler ignores every event that is not `patient.merged`", async () => {
    await fixture();
    await encounter("e1", "lose", null);
    const handler = patientMergedConsumer(db);
    await handler({
      seq: 1, eventId: "ev-other", name: "daycare.booked", payload: {},
      patientId: null, correlationId: null, occurredAt: new Date(),
    });
    expect((await db.select().from(otCases))[0]!.patientId).toBe("lose");
    expect(await db.select().from(eventIdempotency)).toHaveLength(0);
  });

  it("the consumer key the manifest subscribes with is the one this file exports", () => {
    expect(otManifest.subscriptions).toContainEqual({
      event: patientMerged.name, consumer: OT_PATIENT_MERGED_CONSUMER,
    });
  });
  // ═══════════════ T5 / DD9 — the implant-confirmed consumer ═══════════════

  /**
   * The scan's asynchronous half. `signOut`'s A18 leg proves the REFUSAL; these legs prove the
   * consumer's own contract: it matches on `caseRef`, ignores everything that is not an OT case,
   * and is idempotent by event id.
   */
  describe("the implant-confirmed consumer (Plan 15 T5 / DD9)", () => {
    const CONSUMED = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      ledgerEntryId: "led-1", itemId: "it-plate-1", batchId: "b-plate-1", ownership: "consignment",
      vendorId: "vn1", qtyBase: 1, patientId: "p-x", encounterId: "e-x",
      caseRef: { type: "ot_case", id: "c-x" },
      mrpPaise: 4_200_000, mrpUom: "each", mrpPaisePerBase: 4_200_000, ceilingPaisePerBase: 4_500_000,
      occurredAt: "2026-09-02T05:00:00.000Z", ...over,
    });

    async function anImplant(caseId: string, encounterId: string, serial: string): Promise<string> {
      const id = `im-${serial}`;
      await db.insert(otCaseImplants).values({
        id, caseId, encounterId, itemId: "it-plate-1", batchId: "b-plate-1", lotId: "lot-1",
        serial, serviceCode: "IMPL-PLATE-SET", qtyBase: 1, source: "consignment",
        state: "deploying", deployedBy: "u1",
      });
      return id;
    }

    it("stamps the ledger entry on the matching row and confirms it", async () => {
      await fixture();
      await encounter("e1", "win", null);
      const implantId = await anImplant("c-e1", "e1", "SN-1");
      const result = await withTx(db, (tx) => handleMaterialConsumed(tx, "ev-1", CONSUMED({
        caseRef: { type: "ot_case", id: "c-e1" }, encounterId: "e1",
      })));
      expect(result).toEqual({ handled: true, implantId });
      const row = (await db.select().from(otCaseImplants).where(eq(otCaseImplants.id, implantId)))[0]!;
      expect({ state: row.state, ledger: row.ledgerEntryId, event: row.eventId })
        .toEqual({ state: "confirmed", ledger: "led-1", event: "ev-1" });
    });

    it("IGNORES a consumption that is not an OT case — pharmacy will emit these from 16c", async () => {
      await fixture();
      await encounter("e1", "win", null);
      const implantId = await anImplant("c-e1", "e1", "SN-1");
      const result = await withTx(db, (tx) => handleMaterialConsumed(tx, "ev-2", CONSUMED({
        caseRef: { type: "pharmacy_dispense", id: "d-1" },
      })));
      expect(result).toEqual({ handled: true, implantId: null });
      expect((await db.select().from(otCaseImplants).where(eq(otCaseImplants.id, implantId)))[0]!.state).toBe("deploying");
    });

    it("is IDEMPOTENT by event id — a redelivery confirms nothing a second time", async () => {
      await fixture();
      await encounter("e1", "win", null);
      await anImplant("c-e1", "e1", "SN-1");
      await withTx(db, (tx) => handleMaterialConsumed(tx, "ev-3", CONSUMED({ caseRef: { type: "ot_case", id: "c-e1" } })));
      const replay = await withTx(db, (tx) => handleMaterialConsumed(tx, "ev-3", CONSUMED({ caseRef: { type: "ot_case", id: "c-e1" } })));
      expect(replay).toEqual({ handled: false, implantId: null });
    });

    /**
     * TWO identical implants on one case, confirmed in ARRIVAL ORDER. `material.consumed` was frozen
     * by Plan 14 before this module existed and does not carry the implant row's id, so the match is
     * (case, item) and the OLDEST still-deploying row wins. Stated as a test rather than left to a
     * reader, because it is the one place a frozen payload forces a heuristic.
     */
    it("confirms the OLDEST deploying row when two identical implants are on one case", async () => {
      await fixture();
      await encounter("e1", "win", null);
      const first = await anImplant("c-e1", "e1", "SN-1");
      await new Promise<void>((r) => { setTimeout(r, 5); });
      const second = await anImplant("c-e1", "e1", "SN-2");
      await db.update(otCaseImplants).set({ deployedAt: new Date(Date.now() - 60_000) }).where(eq(otCaseImplants.id, first));

      const a = await withTx(db, (tx) => handleMaterialConsumed(tx, "ev-4", CONSUMED({ caseRef: { type: "ot_case", id: "c-e1" } })));
      expect(a.implantId).toBe(first);
      const b = await withTx(db, (tx) => handleMaterialConsumed(tx, "ev-5", CONSUMED({ ledgerEntryId: "led-2", caseRef: { type: "ot_case", id: "c-e1" } })));
      expect(b.implantId).toBe(second);
    });

    it("the two consumers claim INDEPENDENTLY — one event id, two namespaced keys", async () => {
      await fixture();
      await encounter("e1", "lose", null);
      await anImplant("c-e1", "e1", "SN-1");
      // The SAME event id through both handlers: each must claim it for itself.
      await run("shared-id", "win", "lose");
      const consumed = await withTx(db, (tx) => handleMaterialConsumed(tx, "shared-id", CONSUMED({ caseRef: { type: "ot_case", id: "c-e1" } })));
      expect(consumed.handled).toBe(true);
    });

    it("the Handler ignores every event that is not `material.consumed`", async () => {
      await fixture();
      await encounter("e1", "win", null);
      const implantId = await anImplant("c-e1", "e1", "SN-1");
      const handler = implantConfirmedConsumer(db);
      await handler({
        seq: 1, eventId: "ev-x", name: "consignment.deployed", payload: {},
        patientId: null, correlationId: null, occurredAt: new Date(),
      });
      expect((await db.select().from(otCaseImplants).where(eq(otCaseImplants.id, implantId)))[0]!.state).toBe("deploying");
    });
  });
});
