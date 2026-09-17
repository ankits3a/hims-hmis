import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { phiAccessLog } from "../src/kernel/db/schema";
import { opdEncounters } from "../src/kernel/db/schema/opd";
import { formatUhid } from "../src/modules/patients/uhid";
import { setupTestDb, truncateAll } from "./helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters,
} from "./helpers/opd";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — THE DESK COPILOT AGAINST A REAL DATABASE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The unit suites prove the masker masks, the phrasebook routes and the router refuses. NONE of them
 * runs a tool's query: every one of them hands the runner a fake. So until this file existed the
 * honest statement about the copilot was *"the tools typecheck"* — and a query that typechecks and
 * has never run is a query nobody has seen work.
 *
 * So this asks the owner's OWN questions, over HTTP, on a migrated database with a real patient, a
 * real doctor and a real visit:
 *
 *     "has <UHID> been seen by doctor?"          → the English form
 *     "kya <UHID> ko doctor ne dekh liya?"       → the Hinglish form
 *     "generate the day report"                  → and the rows must actually ARRIVE
 *
 * ═══ NO MODEL RUNS HERE, AND THAT IS THE POINT RATHER THAN A LIMITATION ═══
 *
 * `COPILOT_BASE_URL` / `COPILOT_API_KEY` are unset in CI, so `openAiCompatibleClient` returns null
 * and every question is answered by the phrasebook alone. That is the same doctrine `offline.ts`
 * states for speech — **CI NEVER CONTACTS A PROVIDER** — and it makes this suite deterministic. It
 * also proves the thing worth proving about cost: the owner's questions never needed a model.
 */
describe("POST /copilot/ask — against a real database", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  let clerk: { id: string; token: string };
  let stranger: { id: string; token: string };
  let patient: { id: string; uhid: string };
  let encounterId: string;

  const ask = (token: string, question: string): request.Test =>
    request(app.getHttpServer())
      .post("/copilot/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ question });

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });

  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);

    /*
      THE CLERK HOLDS WHAT A FRONT-OFFICE CLERK HOLDS, and the copilot must be reachable with
      exactly that — not with an admin token, which would prove nothing about the permission gates.
    */
    await createRole(db, "desk", "Desk");
    for (const permission of ["patients.read", "patients.register", "opd.visits.read", "opd.queue.read"]) {
      await grantPermissionToRole(db, registry, "desk", permission);
    }
    /* A signed-in user holding NOTHING — the permission-refusal case has to be a real user. */
    await createRole(db, "nobody", "Nobody");

    clerk = await mkUser(db, "desk_clerk", ["desk"]);
    stranger = await mkUser(db, "no_grants", ["nobody"]);
    const doctor = await mkDoctor(db, { username: "dr_copilot", departmentId: deptId, roomId });
    patient = await mkPatient(db, { type: "user", id: clerk.id }, { name: "Asha Devi" });
    ({ encounterId } = await openOpdVisit(
      db,
      { clerk: { type: "user", id: clerk.id }, patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId },
      new Date(),
    ));
  });

  describe("the owner's first example — has this patient been seen?", () => {
    it("answers the English form about a real patient", async () => {
      const res = await ask(clerk.token, `has ${patient.uhid} been seen by doctor?`).expect(200);
      expect(res.body.intent).toBe("visit_status");
      expect(res.body.source).toBe("phrasebook");
      /*
        The visit was opened and nobody has consulted, so the honest answer is one of the two
        not-yet states. Asserting the SET rather than one member keeps this a test of the copilot
        rather than of exactly where `openVisit` leaves a fresh encounter.
      */
      expect(["copilot.answer.visitWaiting", "copilot.answer.visitRegistered"]).toContain(res.body.answer.key);
    });

    it("answers the Hinglish form identically", async () => {
      const res = await ask(clerk.token, `kya ${patient.uhid} ko doctor ne dekh liya?`).expect(200);
      expect(res.body.intent).toBe("visit_status");
      expect(["copilot.answer.visitWaiting", "copilot.answer.visitRegistered"]).toContain(res.body.answer.key);
    });

    it("answers about a visit NUMBER as readily as a UHID", async () => {
      const visitNo = await visitNoOf(db, encounterId);
      const res = await ask(clerk.token, `has ${visitNo} been seen by doctor?`).expect(200);
      expect(res.body.intent).toBe("visit_status");
    });

    it("says so when the patient exists but has no visit on the day asked about", async () => {
      const other = await mkPatient(db, { type: "user", id: clerk.id }, { name: "Ramesh Kumar", phone: "9812345670" });
      const res = await ask(clerk.token, `has ${other.uhid} been seen by doctor?`).expect(200);
      expect(res.body.answer.key).toBe("copilot.answer.visitNoneToday");
    });

    it("says so when there is no such patient", async () => {
      // A VALID UHID (right check digit) that was never issued — the honest "no such patient".
      const unissued = formatUhid("U", 9_000_001);
      const res = await ask(clerk.token, `has ${unissued} been seen by doctor?`).expect(200);
      expect(res.body.answer.key).toBe("copilot.answer.visitUnknownPatient");
    });

    /**
     * ═══ THE DEFECT THIS SUITE EXISTS TO HAVE CAUGHT ═══
     *
     * `U99999990` is UHID-SHAPED and fails the Verhoeff check digit. The first implementation asked
     * only `isValidUhid`, so a mistyped UHID — the commonest error at a counter, and the exact thing
     * a check digit is in the number to catch — fell through to the visit-number path and came back
     * as "I could not find that visit", about a patient. No unit test could find it: every unit
     * fixture used a UHID that was real.
     */
    it("tells the clerk the UHID is mistyped rather than blaming an unknown visit", async () => {
      const res = await ask(clerk.token, "has U99999990 been seen by doctor?").expect(200);
      expect(res.body.answer.key).toBe("copilot.answer.uhidCheckFailed");
      expect(res.body.answer.params.uhid).toBe("U99999990");
    });

    it("accepts a UHID typed in lower case", async () => {
      // `isValidUhid` matches [A-Z] only, and a clerk types in whatever case the keyboard was left in.
      const res = await ask(clerk.token, `kya ${patient.uhid.toLowerCase()} ko doctor ne dekh liya?`).expect(200);
      expect(res.body.intent).toBe("visit_status");
      expect(["copilot.answer.visitWaiting", "copilot.answer.visitRegistered"]).toContain(res.body.answer.key);
    });

    /**
     * THE DISCLOSURE IS LOGGED. `counterState` reads no patient record and writes no row — right
     * for a screen polling it, and not enough when a person deliberately asked about somebody by
     * name. An enquiry asking *who was looking this patient up* must find this.
     */
    it("writes a PHI access row naming the asker, the patient and the surface", async () => {
      await ask(clerk.token, `has ${patient.uhid} been seen by doctor?`).expect(200);
      const rows = await db.select().from(phiAccessLog)
        .where(and(eq(phiAccessLog.patientId, patient.id), eq(phiAccessLog.surface, "copilot.visit_status")));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actorId).toBe(clerk.id);
    });
  });

  describe("the owner's second example — generate the day report", () => {
    /**
     * *"If the user ask to generate the day report, it should do it and give it to the user."*
     *
     * So the assertion is not that it SAID something — it is that the rows ARRIVED. An answer
     * about a report is not a report.
     */
    it("hands over the report itself, not a sentence about it", async () => {
      const res = await ask(clerk.token, "generate the day report").expect(200);
      expect(res.body.intent).toBe("my_day_report");
      expect(res.body.answer.payload).toBeDefined();
      expect(Array.isArray(res.body.answer.payload.sections)).toBe(true);
      // The clerk registered a patient and opened a visit in this test's own setup.
      expect(res.body.answer.payload.sections.length).toBeGreaterThan(0);
    });

    it("hands it over for the Hinglish phrasing too", async () => {
      const res = await ask(clerk.token, "aaj ki meri report nikaal do").expect(200);
      expect(res.body.intent).toBe("my_day_report");
      expect(res.body.answer.payload.sections.length).toBeGreaterThan(0);
    });

    it("marks today's report provisional, because the day has not closed", async () => {
      const res = await ask(clerk.token, "generate the day report").expect(200);
      expect(res.body.answer.payload.provisional).toBe(true);
      expect(res.body.answer.key).toBe("copilot.answer.dayReportProvisional");
    });

    /** Self-scoped STRUCTURALLY: `loadReport` takes no userId, so there is no argument to abuse. */
    it("gives a different person their own day, not the clerk's", async () => {
      const res = await ask(stranger.token, "generate the day report").expect(200);
      expect(res.body.answer.key).toBe("copilot.answer.dayReportEmpty");
    });
  });

  describe("the queue", () => {
    it("answers how the lines look", async () => {
      const res = await ask(clerk.token, "kis line mein kam wait hai").expect(200);
      expect(res.body.intent).toBe("queue_depth");
      expect(["copilot.answer.queueShortest", "copilot.answer.queueNoneOpen"]).toContain(res.body.answer.key);
    });
  });

  describe("what it refuses, and how", () => {
    it("refuses a tool the asker has no permission for — as a sentence, not a 403", async () => {
      const res = await ask(stranger.token, `has ${patient.uhid} been seen by doctor?`).expect(200);
      expect(res.body.answer.key).toBe("copilot.answer.notPermitted");
    });

    it("reads nothing about the patient when the permission is refused", async () => {
      // The gate runs BEFORE the tool, so a refusal must leave no PHI access row behind.
      await ask(stranger.token, `has ${patient.uhid} been seen by doctor?`).expect(200);
      const rows = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "copilot.visit_status"));
      expect(rows).toHaveLength(0);
    });

    it("asks which patient when the question named none", async () => {
      const res = await ask(clerk.token, "has the patient been seen by doctor?").expect(200);
      expect(res.body.answer.key).toBe("copilot.answer.needSubject");
    });

    it("says honestly that it did not understand", async () => {
      const res = await ask(clerk.token, "what is the weather in mumbai").expect(200);
      expect(res.body.answer.key).toBe("copilot.answer.notUnderstood");
      expect(res.body.source).toBe("none");
    });

    it("refuses an unauthenticated caller", async () => {
      await request(app.getHttpServer()).post("/copilot/ask").send({ question: "kitna wait hai" }).expect(401);
    });

    it("refuses an empty question rather than guessing", async () => {
      await ask(clerk.token, "").expect(400);
    });
  });

  /**
   * ═══ THE GUARANTEE, ASSERTED WHERE IT CAN ACTUALLY BE OBSERVED ═══
   *
   * The unit suite proves an identifier cannot reach the provider. This proves the other half of
   * the same claim from outside: whatever the copilot answers, the reply it hands back carries no
   * identifier the caller did not already type. A response body is what leaves this process.
   */
  describe("what comes back", () => {
    it("never returns the patient's UHID in an answer's own parameters", async () => {
      const res = await ask(clerk.token, `has ${patient.uhid} been seen by doctor?`).expect(200);
      expect(JSON.stringify(res.body.answer.params)).not.toContain(patient.uhid);
    });

    it("names where the routing came from, on every answer", async () => {
      for (const q of ["kitna wait hai", "generate the day report", "what is the weather"]) {
        const res = await ask(clerk.token, q).expect(200);
        expect(["phrasebook", "model", "none"]).toContain(res.body.source);
      }
    });
  });
});

/** The printed visit number, read back so the by-number path is exercised with a real one. */
async function visitNoOf(db: Db, encounterId: string): Promise<string> {
  const rows = await db.select({ visitNo: opdEncounters.visitNo }).from(opdEncounters)
    .where(eq(opdEncounters.id, encounterId));
  return rows[0]?.visitNo ?? "";
}
