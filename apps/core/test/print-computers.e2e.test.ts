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
import { createAgent } from "../src/kernel/auth/agents";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { agents, events, printComputers, printEnrolmentCodes, printJobs } from "../src/kernel/db/schema";
import { PRINT_DESTINATIONS } from "../src/kernel/printing/enqueue";
import { PRINT_COMPUTER_ALIVE_SECONDS, PRINT_COMPUTER_EVENTS, counterDestination } from "../src/kernel/printing/computers";
import { forgetEnrolTries } from "../src/kernel/printing/computers.controller";
import { relayServes } from "../src/kernel/printing/served";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * Decision 0047 — the counter's own print program. One computer is one agent with one destination;
 * these rows are the properties that make that safe: a code is spent once, a program fetches only
 * its own counter's paper, a revoke stops it at the next poll, a paper is never parked behind a
 * computer that is off, and one program being alive is not evidence that the site's relay is.
 */
describe("decision 0047: a counter's own print program", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;

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
    forgetEnrolTries();
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function signIn(permissions: string[]): Promise<{ auth: { authorization: string }; userId: string }> {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const role = `r_${String(Date.now())}_${String(Math.random()).slice(2, 8)}`;
    await createRole(db, role, role);
    for (const p of permissions) await grantPermissionToRole(db, registry, role, p);
    const user = await mkUser(db, `u-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`, [role]);
    return { auth: { authorization: `Bearer ${user.token}` }, userId: user.id };
  }

  async function enrolOne(admin: { authorization: string }, name = "Front desk 1", printer: string | null = "HP LaserJet M1005"): Promise<{ computerId: string; agentKey: string; destination: string; code: string }> {
    const issued = await http().post("/print/computers/codes").set(admin).send({ name }).expect(201);
    const enrolled = await http().post("/print/enrol").send({ code: issued.body.code, platform: "win32", appVersion: "1.0.0" }).expect(201);
    // A program reports its printer when it starts; a computer with none is never sent a paper.
    if (printer !== null) await http().post("/print/heartbeat").set("x-agent-key", enrolled.body.agentKey).send({ printer, printers: [printer] }).expect(201);
    return { ...enrolled.body, code: issued.body.code } as { computerId: string; agentKey: string; destination: string; code: string };
  }

  async function rxJob(): Promise<{ jobId: string; encounterId: string }> {
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const clerk = await mkUser(db, `clerk-${String(Date.now())}`, ["front_office"]);
    const doctor = await mkDoctor(db, { username: `dr-${String(Date.now())}`, departmentId: deptId, roomId, displayName: "Dr Anand Rao" });
    const patient = await mkPatient(db, clerk.actor, { name: "Muskan Arora", sex: "female", ageYears: 28 });
    const visit = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId }, new Date("2026-08-17T04:00:00.000Z"));
    const rows = await db.select().from(printJobs).where(eq(printJobs.encounterId, visit.encounter.id));
    const rx = rows.find((r) => r.document === "opd_prescription");
    if (rx === undefined) throw new Error("the visit queued no prescription sheet");
    return { jobId: rx.id, encounterId: visit.encounter.id };
  }

  it("a code is shown once, kept only as a hash, and enrols exactly one computer", async () => {
    const admin = await signIn(["auth.users.manage"]);
    const issued = await http().post("/print/computers/codes").set(admin.auth).send({ name: "Front desk 1" }).expect(201);
    expect(issued.body.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const [stored] = await db.select().from(printEnrolmentCodes);
    expect(stored!.codeHash).not.toContain(String(issued.body.code).replace("-", ""));
    expect(stored!.expiresAt.getTime() - stored!.createdAt.getTime()).toBe(15 * 60_000);

    // Typed in lower case with a space: still the code.
    const first = await http().post("/print/enrol").send({ code: String(issued.body.code).toLowerCase().replace("-", " "), platform: "win32", appVersion: "1.0.0" }).expect(201);
    expect(first.body).toMatchObject({ name: "Front desk 1", destination: counterDestination(first.body.computerId), aliveSeconds: PRINT_COMPUTER_ALIVE_SECONDS });
    expect(typeof first.body.agentKey).toBe("string");

    // The same code again enrols nobody.
    const second = await http().post("/print/enrol").send({ code: issued.body.code }).expect(403);
    expect(second.body.code).toBe("enrolment_code_refused");
    expect(await db.select().from(printComputers)).toHaveLength(1);

    // One agent, granted its own destination and nothing else; the key is not at rest.
    const [agent] = await db.select().from(agents);
    expect(agent!.printDestinations).toEqual([first.body.destination]);
    expect(agent!.apiKeyHash).not.toBe(first.body.agentKey);

    const names = (await db.select({ name: events.name }).from(events)).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["print.computer_code_issued", "print.computer_enrolled"]));
    expect(PRINT_COMPUTER_EVENTS.map((e) => [e.name, e.module])).toEqual([
      ["print.computer_code_issued", "printing"], ["print.computer_enrolled", "printing"],
      ["print.computer_revoked", "printing"], ["print.job_sent_to_computer", "printing"],
    ]);
  });

  it("an expired code, a wrong code and a flood of guesses are all refused", async () => {
    const admin = await signIn(["auth.users.manage"]);
    const issued = await http().post("/print/computers/codes").set(admin.auth).send({ name: "Front desk 2" }).expect(201);
    await db.update(printEnrolmentCodes).set({ expiresAt: new Date(Date.now() - 1000) });
    await http().post("/print/enrol").send({ code: issued.body.code }).expect(403);
    await http().post("/print/enrol").send({ code: "AAAA-AAAA" }).expect(403);
    for (let i = 0; i < 8; i++) await http().post("/print/enrol").send({ code: "BBBB-BBBB" }).expect(403);
    const flooded = await http().post("/print/enrol").send({ code: "BBBB-BBBB" }).expect(429);
    expect(flooded.body.code).toBe("too_many_attempts");
    expect(await db.select().from(printComputers)).toHaveLength(0);
  });

  it("only an administrator issues codes, lists computers and revokes; the desk sees names only", async () => {
    const desk = await signIn(["opd.paper.reprint"]);
    await http().post("/print/computers/codes").set(desk.auth).send({ name: "x" }).expect(403);
    await http().get("/print/computers").set(desk.auth).expect(403);
    await http().post("/print/computers/abc/revoke").set(desk.auth).expect(403);
    await http().post("/print/computers/abc/test").set(desk.auth).expect(403);
    const admin = await signIn(["auth.users.manage"]);
    const pc = await enrolOne(admin.auth);
    const here = await http().get("/print/computers/here").set(desk.auth).expect(200);
    expect(here.body.computers).toEqual([{ id: pc.computerId, name: "Front desk 1", printer: "HP LaserJet M1005", alive: true }]);
    await http().get("/print/computers/here").expect(401);
  });

  it("the desk sends a sheet to its own computer; that program claims it and no other program can", async () => {
    const admin = await signIn(["auth.users.manage"]);
    const desk = await signIn(["opd.paper.reprint", "patients.read"]);
    const one = await enrolOne(admin.auth, "Front desk 1");
    const two = await enrolOne(admin.auth, "Front desk 2");
    const { jobId, encounterId } = await rxJob();

    const sent = await http().post(`/print/jobs/${jobId}/send-to-computer`).set(desk.auth).send({ computerId: one.computerId }).expect(201);
    expect(sent.body).toEqual({ sent: true, reason: null, destination: one.destination });

    // Computer two asks for its own paper AND for computer one's: it is served neither of one's.
    const other = await http().post("/print/claim").set("x-agent-key", two.agentKey).send({ destinations: [two.destination, one.destination], limit: 5 }).expect(201);
    expect(other.body.jobs).toEqual([]);
    expect(other.body.refusedDestinations).toEqual([one.destination]);
    // Asking ONLY for somebody else's counter is refused outright.
    await http().post("/print/claim").set("x-agent-key", two.agentKey).send({ destinations: [one.destination], limit: 5 }).expect(403);
    // A counter's program is not the site relay either.
    await http().post("/print/claim").set("x-agent-key", two.agentKey).send({ destinations: ["front_desk_a4"], limit: 5 }).expect(403);

    const mine = await http().post("/print/claim").set("x-agent-key", one.agentKey).send({ destinations: [one.destination], limit: 5 }).expect(201);
    expect(mine.body.jobs).toHaveLength(1);
    expect(mine.body.jobs[0]).toMatchObject({ id: jobId, document: "opd_prescription", destination: one.destination });
    expect(mine.body.jobs[0].html).toContain("Muskan Arora");

    // Claimed by the program: the browser cannot also take it (no double print).
    const browser = await http().post(`/print/jobs/${jobId}/printed-here`).set(desk.auth).expect(201);
    expect(browser.body).toEqual({ accepted: false });
    await http().post("/print/printed").set("x-agent-key", one.agentKey).send({ jobId }).expect(201);
    const [row] = await db.select().from(printJobs).where(eq(printJobs.id, jobId));
    expect(row).toMatchObject({ status: "printed", destination: one.destination });

    // A printed sheet is not sent anywhere again.
    const again = await http().post(`/print/jobs/${jobId}/send-to-computer`).set(desk.auth).send({ computerId: one.computerId }).expect(201);
    expect(again.body).toMatchObject({ sent: false, reason: "not_sendable" });

    // The desk's read still finds the paper by its visit, wherever it was printed.
    const listed = await http().get(`/print/jobs?encounterId=${encounterId}`).set(desk.auth).expect(200);
    expect(listed.body.jobs.find((j: { id: string }) => j.id === jobId)).toMatchObject({ status: "printed", printedVia: "relay" });
  });

  it("a paper is never parked behind a computer that is off, and a roll slip is never sent to an A4 program", async () => {
    const admin = await signIn(["auth.users.manage"]);
    const desk = await signIn(["opd.paper.reprint", "patients.read"]);
    const pc = await enrolOne(admin.auth);
    const { jobId, encounterId } = await rxJob();

    await db.update(printComputers).set({ lastSeenAt: new Date(Date.now() - (PRINT_COMPUTER_ALIVE_SECONDS + 5) * 1000) });
    const off = await http().post(`/print/jobs/${jobId}/send-to-computer`).set(desk.auth).send({ computerId: pc.computerId }).expect(201);
    expect(off.body).toEqual({ sent: false, reason: "offline", destination: null });
    const [still] = await db.select().from(printJobs).where(eq(printJobs.id, jobId));
    expect(still).toMatchObject({ status: "queued", destination: "front_desk_a4" });
    // …so the browser prints it, exactly as decision 0045 describes.
    expect((await http().post(`/print/jobs/${jobId}/printed-here`).set(desk.auth).expect(201)).body).toEqual({ accepted: true });

    // The program's next poll is what brings it back to life.
    await http().post("/print/claim").set("x-agent-key", pc.agentKey).send({ destinations: [pc.destination], limit: 5 }).expect(201);
    const listed = await http().get("/print/computers").set(admin.auth).expect(200);
    expect(listed.body.computers[0]).toMatchObject({ id: pc.computerId, alive: true, revoked: false });

    const slips = await db.select().from(printJobs).where(eq(printJobs.encounterId, encounterId));
    const slip = slips.find((r) => r.document === "opd_token_slip");
    if (slip !== undefined) {
      const roll = await http().post(`/print/jobs/${slip.id}/send-to-computer`).set(desk.auth).send({ computerId: pc.computerId }).expect(201);
      expect(roll.body).toMatchObject({ sent: false, reason: "not_sendable" });
    }
    // A program that is running but has no printer chosen is not sent a paper either.
    const bare = await enrolOne(admin.auth, "No printer yet", null);
    const { jobId: second } = await (async () => {
      const rows = await db.select().from(printJobs).where(eq(printJobs.encounterId, encounterId));
      const again = await http().post("/print/reprint").set(desk.auth).send({ jobId: rows.find((r) => r.document === "opd_prescription")!.id, reason: "second copy" }).expect(201);
      return { jobId: String(again.body.id) };
    })();
    const noPrinter = await http().post(`/print/jobs/${second}/send-to-computer`).set(desk.auth).send({ computerId: bare.computerId }).expect(201);
    expect(noPrinter.body).toEqual({ sent: false, reason: "no_printer", destination: null });

    const unknown = await http().post(`/print/jobs/${jobId}/send-to-computer`).set(desk.auth).send({ computerId: "nope" }).expect(201);
    expect(unknown.body).toMatchObject({ sent: false, reason: "unknown_computer" });
  });

  it("a heartbeat records the printer and version; a revoke stops the program at its next poll and hands its paper back", async () => {
    const admin = await signIn(["auth.users.manage"]);
    const desk = await signIn(["opd.paper.reprint", "patients.read"]);
    const pc = await enrolOne(admin.auth);
    await http().post("/print/heartbeat").set("x-agent-key", pc.agentKey)
      .send({ printer: "HP LaserJet M1005 (प्रिंटर)", printers: ["HP LaserJet M1005 (प्रिंटर)", "Microsoft Print to PDF"], platform: "win32", appVersion: "1.0.1" }).expect(201);
    const listed = await http().get("/print/computers").set(admin.auth).expect(200);
    expect(listed.body.computers[0]).toMatchObject({ printer: "HP LaserJet M1005 (प्रिंटर)", appVersion: "1.0.1", platform: "win32", alive: true });
    await http().post("/print/heartbeat").set(desk.auth).send({}).expect(403);

    const { jobId } = await rxJob();
    await http().post(`/print/jobs/${jobId}/send-to-computer`).set(desk.auth).send({ computerId: pc.computerId }).expect(201);

    expect((await http().post(`/print/computers/${pc.computerId}/revoke`).set(admin.auth).expect(201)).body).toEqual({ revoked: true });
    expect((await http().post(`/print/computers/${pc.computerId}/revoke`).set(admin.auth).expect(201)).body).toEqual({ revoked: false });
    // The very next poll is refused: the agent's kill switch is on.
    const refused = await http().post("/print/claim").set("x-agent-key", pc.agentKey).send({ destinations: [pc.destination], limit: 5 });
    expect([401, 403]).toContain(refused.status);
    // Its waiting paper is the site's again, so a browser can print it.
    const [row] = await db.select().from(printJobs).where(eq(printJobs.id, jobId));
    expect(row).toMatchObject({ status: "queued", destination: "front_desk_a4" });
    expect((await http().get("/print/computers/here").set(desk.auth).expect(200)).body.computers).toEqual([]);
    const names = (await db.select({ name: events.name }).from(events)).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["print.computer_revoked", "print.job_sent_to_computer"]));
  });

  it("the administrator's test page goes to that computer only, and is refused while it is off", async () => {
    const admin = await signIn(["auth.users.manage"]);
    const pc = await enrolOne(admin.auth);
    const test = await http().post(`/print/computers/${pc.computerId}/test`).set(admin.auth).expect(201);
    expect(typeof test.body.jobId).toBe("string");
    const claimed = await http().post("/print/claim").set("x-agent-key", pc.agentKey).send({ destinations: [pc.destination], limit: 5 }).expect(201);
    expect(claimed.body.jobs).toHaveLength(1);
    expect(claimed.body.jobs[0]).toMatchObject({ document: "print_test_page", page: { widthMm: 210, heightMm: 297 } });
    expect(claimed.body.jobs[0].html).toContain("Front desk 1");

    await db.update(printComputers).set({ lastSeenAt: new Date(Date.now() - (PRINT_COMPUTER_ALIVE_SECONDS + 5) * 1000) });
    const off = await http().post(`/print/computers/${pc.computerId}/test`).set(admin.auth).expect(409);
    expect(off.body.code).toBe("print_computer_offline");
    const bare = await enrolOne(admin.auth, "No printer yet", null);
    const none = await http().post(`/print/computers/${bare.computerId}/test`).set(admin.auth).expect(409);
    expect(none.body.code).toBe("print_computer_no_printer");
    // Nothing was queued for a browser to pick up by mistake.
    expect((await db.select().from(printJobs)).filter((j) => j.document === "print_test_page" && j.status === "queued")).toHaveLength(0);
  });

  it("one counter's program being alive is NOT evidence that the site relay serves the front desk", async () => {
    const admin = await signIn(["auth.users.manage"]);
    const desk = await signIn(["opd.paper.reprint", "patients.read"]);
    const pc = await enrolOne(admin.auth);
    const { jobId } = await rxJob();
    await http().post(`/print/jobs/${jobId}/send-to-computer`).set(desk.auth).send({ computerId: pc.computerId }).expect(201);
    await http().post("/print/claim").set("x-agent-key", pc.agentKey).send({ destinations: [pc.destination], limit: 5 }).expect(201);
    // A claim happened seconds ago — but for a counter's own destination.
    expect(await relayServes(db, "front_desk_a4")).toBe(false);
    // The site's relay claiming is still evidence, as before.
    const { apiKey } = await createAgent(db, `site-relay-${String(Date.now())}`, { printDestinations: [...PRINT_DESTINATIONS] });
    await db.insert(printJobs).values({ id: "site-job-1", document: "opd_token_slip", destination: "front_desk_thermal", params: {}, dedupeKey: "site-job-1" });
    await http().post("/print/claim").set("x-agent-key", apiKey).send({ destinations: ["front_desk_thermal"], limit: 5 }).expect(201);
    expect(await relayServes(db, "front_desk_a4")).toBe(true);
  });
});
