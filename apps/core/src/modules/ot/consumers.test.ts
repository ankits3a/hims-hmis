import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  daycareEncounters, eventIdempotency, otCases, otSpecimens, patients, resources,
} from "../../kernel/db/schema";
import { patientMerged } from "../patients";
import { OT_PATIENT_MERGED_CONSUMER, handlePatientMerged, patientMergedConsumer } from "./consumers";
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
      { id: "win", uhid: "U00000018", name: "Sunita Devi", sex: "female", ...AUDIT },
      { id: "lose", uhid: "U00000026", name: "Sunita Devi", sex: "female", ...AUDIT },
      { id: "other", uhid: "U00000034", name: "Ram Kumar", sex: "male", ...AUDIT },
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
});
