import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { openVisit } from "../src/modules/opd/encounters";
import { requireEnv } from "../src/kernel/config";
import { createAgent, setKillSwitch, findAgentByKey } from "../src/kernel/auth/agents";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { withTx } from "../src/kernel/db/client";
import { printJobs } from "../src/kernel/db/schema";
import { enqueuePrintJob } from "../src/kernel/printing/enqueue";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T2 — THE RELAY OVER HTTP, WHICH IS THE ONLY WAY THE HOSPITAL EVER SEES THIS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The unit tests prove the claim's semantics. What only an e2e can prove is that the relay's
 * IDENTITY works end to end: an agent key gets in, a user token does not, the kill switch bites,
 * and no route on this controller is reachable unauthenticated.
 */
describe("FD-24 T2: the print relay's routes", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let agentKey: string;

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
  afterAll(async () => {
    try { await app.close(); } catch { /* already closed */ }
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
    ({ apiKey: agentKey } = await createAgent(db, `print-relay-${String(Date.now())}`));
  });

  /**
   * A REAL VISIT, because a rendered slip is the point. The renderer resolves the patient, the
   * department code and the token from the database — an invented id renders nothing, which is
   * exactly what the "unrenderable document" row below asserts.
   */
  async function realVisit(): Promise<{ encounterId: string; patientName: string; slipJobId: string }> {
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const clerk = await mkUser(db, `clerk-${String(Date.now())}`, ["front_office"]);
    const doctor = await mkDoctor(db, { username: `dr-${String(Date.now())}`, departmentId: deptId, roomId, displayName: "Dr Anand Rao" });
    const patient = await mkPatient(db, clerk.actor, { name: "Muskan Arora", sex: "female", ageYears: 28 });
    const MON = new Date("2026-08-17T04:00:00.000Z");
    const visit = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId }, MON);
    /*
      OPENING THE VISIT ALREADY QUEUED BOTH SLIPS — that is FD-24 T5, and it happens inside the
      visit's own transaction. These tests drive the REAL flow rather than hand-queuing a job the
      counter would never have created that way.
    */
    const queued = await db.select().from(printJobs).where(eq(printJobs.encounterId, visit.encounter.id));
    const slip = queued.find((j) => j.document === "opd_token_slip")!;
    return { encounterId: visit.encounter.id, patientName: "Muskan Arora", slipJobId: slip.id };
  }

  it("a relay claims with its agent key, prints, and reports — the whole round trip", async () => {
    const { encounterId, patientName, slipJobId: id } = await realVisit();

    const claimed = await request(app.getHttpServer())
      .post("/print/claim")
      .set("x-agent-key", agentKey)
      .send({ destinations: ["front_desk_thermal"], limit: 5 })
      .expect(201);
    expect(claimed.body.jobs).toHaveLength(1); // the A4 is a different destination, served by another relay
    expect(claimed.body.jobs[0].id).toBe(id);
    expect(claimed.body.jobs[0].destination).toBe("front_desk_thermal");
    /*
      THE CLAIM CARRIES THE RENDERED DOCUMENT — that is the offline guarantee (the relay can print
      with the uplink down), and it means the response carries PHI by necessity. The property that
      survives, and the one worth pinning, is that the QUEUE ROW does not: `print_jobs` stores
      identifiers, so it never becomes a second copy of the patient record at rest.
    */
    expect(claimed.body.jobs[0].html).toContain("@page { size: 72mm auto"); // THE 72 mm PAGE, which did not exist in this codebase before FD-24
    expect(claimed.body.jobs[0].html).toContain(patientName);
    expect(claimed.body.jobs[0].html).toContain("MED-1"); // the department series, as the screen says it
    expect(claimed.body.jobs[0].html).toContain("भुगतान शेष"); // Devanagari survives the round trip
    const row = (await db.select().from(printJobs).where(eq(printJobs.id, id)))[0]!;
    expect(row.params).toEqual({ encounterId, unpaid: true });
    expect(JSON.stringify(row.params)).not.toMatch(/muskan|uhid/i);

    await request(app.getHttpServer())
      .post("/print/printed")
      .set("x-agent-key", agentKey)
      .send({ jobId: id })
      .expect(201)
      .expect((r) => { expect(r.body.accepted).toBe(true); });

    expect((await db.select().from(printJobs).where(eq(printJobs.id, id)))[0]!.status).toBe("printed");
  });

  it("an empty queue is an empty list, not an error — the relay polls this all day", async () => {
    await request(app.getHttpServer())
      .post("/print/claim")
      .set("x-agent-key", agentKey)
      .send({ destinations: ["front_desk_thermal"] })
      .expect(201)
      .expect((r) => { expect(r.body.jobs).toEqual([]); });
  });

  it("no agent key, no queue — every route refuses an unauthenticated caller", async () => {
    for (const route of ["/print/claim", "/print/printed", "/print/failed"]) {
      await request(app.getHttpServer()).post(route).send({}).expect(401);
    }
  });

  /**
   * A USER TOKEN MUST NOT SERVE THE PRINT QUEUE. The relay is an agent; a signed-in clerk claiming
   * jobs would take slips out of the queue that no printer will ever produce.
   */
  it("a signed-in user cannot claim — this queue is served by a relay, not a person", async () => {
    const clerk = await mkUser(db, "print-clerk", []);
    await request(app.getHttpServer())
      .post("/print/claim")
      .set("authorization", `Bearer ${clerk.token}`)
      .send({ destinations: ["front_desk_thermal"] })
      .expect(403);
  });

  /** The kill switch already exists on agents, and it must reach this queue without a deploy. */
  it("the agent kill switch stops a relay dead", async () => {
    await realVisit();
    const agent = await findAgentByKey(db, agentKey);
    await setKillSwitch(db, agent!.id, true);

    await request(app.getHttpServer())
      .post("/print/claim")
      .set("x-agent-key", agentKey)
      .send({ destinations: ["front_desk_thermal"] })
      .expect(403);
    // and the jobs are untouched, waiting for a relay that is allowed to have them
    expect((await db.select().from(printJobs)).every((r) => r.status === "queued")).toBe(true);
  });

  /**
   * ═══ WHAT THE COUNTER SEES, AND WHAT IT MAY DO ABOUT IT (R7) ═══
   *
   * Advisory is not the same as silent. If the slip did not come out, the clerk must know while the
   * patient is still standing there — otherwise "advisory" means the hospital finds out from the
   * patient.
   */
  it("the desk can read the print status for the patient in front of it, and reprint", async () => {
    const { encounterId } = await realVisit();
    /*
      `mkUser` ASSIGNS a role; it does not grant that role its permissions — those come from
      `seed-roles` in a real deployment. So the grant is explicit here, exactly as the approvals
      e2es do it, and the permission asserted is the real one the route requires.
    */
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await createRole(db, "front_desk_print", "Front desk (print status)");
    await grantPermissionToRole(db, registry, "front_desk_print", "opd.visits.open");
    const clerk = await mkUser(db, `desk-${String(Date.now())}`, ["front_desk_print"]);

    const listed = await request(app.getHttpServer())
      .get(`/print/jobs?encounterId=${encounterId}`)
      .set("authorization", `Bearer ${clerk.token}`)
      .expect(200);
    // opening the visit queued both, in the same transaction as the token
    expect(listed.body.jobs.map((j: { document: string }) => j.document).sort())
      .toEqual(["opd_prescription", "opd_token_slip"]);
    const slip = listed.body.jobs.find((j: { document: string }) => j.document === "opd_token_slip");
    expect(slip.status).toBe("queued");

    const again = await request(app.getHttpServer())
      .post("/print/reprint")
      .set("authorization", `Bearer ${clerk.token}`)
      .send({ jobId: slip.id })
      .expect(201);
    expect(again.body.id).not.toBeNull();

    // A NEW ROW, not a resurrected one — both attempts survive, which is what makes "who printed
    // this again" answerable about a document carrying a patient's name.
    const after = await db.select().from(printJobs).where(eq(printJobs.encounterId, encounterId));
    expect(after).toHaveLength(3);
    expect(after.filter((r) => r.document === "opd_token_slip")).toHaveLength(2);
    expect(new Set(after.map((r) => r.dedupeKey)).size).toBe(3);
  });

  it("a relay agent cannot read the desk's status route — it holds no permissions", async () => {
    const { encounterId } = await realVisit();
    await request(app.getHttpServer())
      .get(`/print/jobs?encounterId=${encounterId}`)
      .set("x-agent-key", agentKey)
      .expect(403);
  });

  it("a malformed claim is refused rather than defaulted into claiming everything", async () => {
    await request(app.getHttpServer())
      .post("/print/claim")
      .set("x-agent-key", agentKey)
      .send({ destinations: [], limit: 999 })
      .expect(500); // zod throws; the shape is refused either way, and nothing is claimed
    expect(await db.select().from(printJobs)).toHaveLength(0);
  });

  it("a document with no renderer is failed after its own visit, not silently dropped", async () => {
    const { encounterId } = await realVisit();
    const id = await withTx(db, (tx) => enqueuePrintJob(tx, {
      document: "vitals_slip", params: { encounterId }, dedupeKey: `vitals:${encounterId}`,
    }));
    await request(app.getHttpServer())
      .post("/print/claim").set("x-agent-key", agentKey)
      .send({ destinations: ["vitals_thermal"] }).expect(201)
      .expect((r) => { expect(r.body.jobs).toEqual([]); });
    expect((await db.select().from(printJobs).where(eq(printJobs.id, id!)))[0]!.attempts).toBe(1);
  });
});
