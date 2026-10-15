import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedBillingBase } from "./helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { invoices, opdAppointments } from "../src/kernel/db/schema";
import { patientsManifest } from "../src/modules/patients";
import { tariffManifest } from "../src/modules/tariff";
import { opdManifest } from "../src/modules/opd";
import { billingManifest } from "../src/modules/billing";
import { openTeleVisitFor } from "../src/modules/opd/tele";
import { addDays, istDate } from "../src/modules/opd/time";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * TELE-CALL OVER HTTP (fix round 2026-10-09). The five routes this lane added or widened — each one
 * unauthenticated (401), without its permission (403), and on its happy path — and the hard rule on
 * the wire: what a DOCTOR's login reads for a tele visit carries no money key at all.
 */
const MONEY_KEY = /fee|paid|advance|receipt|quote|paise|invoice/i;
const keysOf = (o: unknown, path = ""): string[] => (o !== null && typeof o === "object"
  ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => [`${path}.${k}`, ...keysOf(v, `${path}.${k}`)]) : []);

describe("tele-call e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of [authManifest, workflowManifest, approvalsManifest, patientsManifest, tariffManifest, opdManifest, billingManifest]) registry.install(m);

  let desk: { id: string; token: string };
  let office: { id: string; token: string };
  let rando: { id: string; token: string };
  let dra: { doctorId: string; userId: string; token: string };
  let drb: { doctorId: string; userId: string; token: string };
  let patientId: string;

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
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId, room2Id } = await seedOpdMasters(db);
    await seedBillingBase(db);
    const mkRole = async (key: string, permissions: string[]): Promise<void> => {
      await createRole(db, key, key);
      for (const p of permissions) await grantPermissionToRole(db, registry, key, p);
    };
    await mkRole("tele_desk", ["opd.appointments.read", "opd.appointments.manage", "opd.visits.read", "opd.visits.open", "patients.read", "billing.receipt.record", "billing.session.own"]);
    await mkRole("tele_doc", ["opd.consult", "opd.queue.read", "opd.queue.operate", "opd.visits.read", "patients.read"]);
    await mkRole("tele_office", ["billing.config.write", "billing.reports.read"]);
    desk = await mkUser(db, "tele_desk_user", ["tele_desk", "front_office"]);
    office = await mkUser(db, "tele_office_user", ["tele_office"]);
    rando = await mkUser(db, "tele_rando", []);
    dra = await mkDoctor(db, { username: "tdra", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: dra.userId, roleKey: "tele_doc", scopeType: "hospital" });
    drb = await mkDoctor(db, { username: "tdrb", departmentId: deptId, roomId: room2Id, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: drb.userId, roleKey: "tele_doc", scopeType: "hospital" });
    patientId = (await mkPatient(db, { type: "user", id: desk.id }, { phone: "9876500001" })).id;
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];
  const http = () => request(app.getHttpServer());

  /** A tele appointment for tomorrow's first slot, booked over HTTP. */
  const bookTele = async (): Promise<{ id: string; slotStart: string; date: string }> => {
    const date = addDays(istDate(new Date()), 1);
    const slots = await http().get(`/opd/slots?doctorId=${dra.doctorId}&date=${date}`).set(...auth(desk.token)).expect(200);
    const slotStart = (slots.body.slots as { start: string; booked: boolean }[]).find((s) => !s.booked)!.start;
    const booked = await http().post("/opd/appointments").set(...auth(desk.token))
      .send({ patientId, doctorId: dra.doctorId, slotStart, mode: "tele", telePhone: "+91 98765 43021" }).expect(201);
    expect(booked.body.appointment).toMatchObject({ mode: "tele", telePhone: "9876543021" });
    return { id: booked.body.appointment.id as string, slotStart, date };
  };

  it("PUT /billing/config — the hospital's UPI id: 401, 403, saved, read back, and a malformed id is a 400", async () => {
    await http().put("/billing/config").send({ upiVpa: "crkmch@sbi" }).expect(401);
    await http().put("/billing/config").set(...auth(rando.token)).send({ upiVpa: "crkmch@sbi" }).expect(403);
    await http().put("/billing/config").set(...auth(desk.token)).send({ upiVpa: "crkmch@sbi" }).expect(403);
    const saved = await http().put("/billing/config").set(...auth(office.token)).send({ upiVpa: "crkmch@sbi", upiPayeeName: "CRK Hospital" }).expect(200);
    expect(saved.body).toMatchObject({ upiVpa: "crkmch@sbi", upiPayeeName: "CRK Hospital" });
    expect((await http().get("/billing/config").set(...auth(office.token)).expect(200)).body).toMatchObject({ upiVpa: "crkmch@sbi", upiPayeeName: "CRK Hospital" });
    const bad = await http().put("/billing/config").set(...auth(office.token)).send({ upiVpa: "not-an-id" }).expect(400);
    expect(bad.body.code).toBe("invalid_upi_id");
  });

  it("GET tele-fee and POST advance — 401, 403, then the desk is quoted and takes exactly the fee, once; the QR appears only with a UPI id", async () => {
    const a = await bookTele();
    await http().get(`/opd/appointments/${a.id}/tele-fee`).expect(401);
    await http().get(`/opd/appointments/${a.id}/tele-fee`).set(...auth(rando.token)).expect(403);
    await http().get(`/opd/appointments/${a.id}/tele-fee`).set(...auth(dra.token)).expect(403); // a doctor's login cannot read what a tele-call costs
    const fee = await http().get(`/opd/appointments/${a.id}/tele-fee`).set(...auth(desk.token)).expect(200);
    expect(fee.body).toMatchObject({ appointmentId: a.id, amountPaise: 50_000, covered: false, upi: null });
    await http().put("/billing/config").set(...auth(office.token)).send({ upiVpa: "crkmch@sbi" }).expect(200);
    const withQr = await http().get(`/opd/appointments/${a.id}/tele-fee`).set(...auth(desk.token)).expect(200);
    expect(withQr.body.upi.uri).toContain("pa=crkmch%40sbi&am=500.00&cu=INR");
    expect((withQr.body.upi.qr as string[]).length).toBeGreaterThan(20);

    const body = { amountPaise: 50_000, tenders: [{ mode: "upi", amountPaise: 50_000, refText: "428311907755" }] };
    await http().post(`/opd/appointments/${a.id}/advance`).send(body).expect(401);
    await http().post(`/opd/appointments/${a.id}/advance`).set(...auth(rando.token)).send(body).expect(403);
    await http().post(`/opd/appointments/${a.id}/advance`).set(...auth(dra.token)).send(body).expect(403);
    // no open drawer yet: billing's own refusal, with its own status
    const noDrawer = await http().post(`/opd/appointments/${a.id}/advance`).set(...auth(desk.token)).send(body).expect(409);
    expect(noDrawer.body.code).toBe("no_open_session");
    await http().post("/billing/sessions").set(...auth(desk.token)).send({ floatPaise: 0 }).expect(201);
    const wrong = await http().post(`/opd/appointments/${a.id}/advance`).set(...auth(desk.token)).send({ amountPaise: 40_000, tenders: [{ mode: "cash", amountPaise: 40_000 }] }).expect(409);
    expect(wrong.body).toMatchObject({ code: "tele_amount_mismatch", detail: { expectedPaise: 50_000 } });
    const paid = await http().post(`/opd/appointments/${a.id}/advance`).set(...auth(desk.token)).set("Idempotency-Key", "k-1").send(body).expect(201);
    expect(paid.body).toMatchObject({ amountPaise: 50_000, opened: false });
    // the same key is ANSWERED, not repeated; a fresh try is told it is already paid
    const replay = await http().post(`/opd/appointments/${a.id}/advance`).set(...auth(desk.token)).set("Idempotency-Key", "k-1").send(body).expect(201);
    expect(replay.body.receiptId).toBe(paid.body.receiptId);
    const again = await http().post(`/opd/appointments/${a.id}/advance`).set(...auth(desk.token)).send(body).expect(409);
    expect(again.body.code).toBe("tele_advance_state_conflict");
    // the desk's list says it is covered
    const list = await http().get(`/opd/appointments?doctorId=${dra.doctorId}&serviceDate=${a.date}`).set(...auth(desk.token)).expect(200);
    expect(list.body.items[0]).toMatchObject({ id: a.id, mode: "tele", telePhone: null, teleDesk: { amountPaise: 50_000, covered: true } });
  });

  it("POST tele/call and tele/outcome — 401, 403, another doctor refused; the treating doctor gets the number, 'spoke' unlocks Complete — and NOTHING a doctor reads for the tele visit carries a money key", async () => {
    const a = await bookTele();
    await http().post("/billing/sessions").set(...auth(desk.token)).send({ floatPaise: 0 }).expect(201);
    await http().post(`/opd/appointments/${a.id}/advance`).set(...auth(desk.token)).send({ amountPaise: 50_000, tenders: [{ mode: "cash", amountPaise: 50_000 }] }).expect(201);
    // the slot is reached (the minute job's own function, at the slot's instant)
    const openedAt = await openTeleVisitFor(db, a.id, new Date(a.slotStart));
    expect(openedAt.opened).toBe(true);
    const encounterId = openedAt.encounterId!;

    // the doctor's line
    const queue = await http().get(`/opd/queues?doctorId=${dra.doctorId}&serviceDate=${a.date}`).set(...auth(dra.token)).expect(200);
    const row = (queue.body.ordered as Record<string, unknown>[])[0]!;
    expect(row).toMatchObject({ tele: true, encounterId, appointmentAt: a.slotStart });
    expect(keysOf({ ...row, patient: null }).filter((k) => MONEY_KEY.test(k))).toEqual([]);
    expect(JSON.stringify(queue.body)).not.toContain("9876543021");

    await http().post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);
    // the visit read
    const visit = await http().get(`/opd/visits/${encounterId}`).set(...auth(dra.token)).expect(200);
    expect(visit.body.encounter).toMatchObject({ consultMode: "tele", teleOutcome: null });
    expect(visit.body.teleSlotAt).toBe(a.slotStart);
    expect(keysOf({ ...visit.body, patient: null }).filter((k) => MONEY_KEY.test(k))).toEqual([]);
    expect(JSON.stringify(visit.body)).not.toContain("9876543021");

    await http().post(`/opd/visits/${encounterId}/tele/call`).expect(401);
    await http().post(`/opd/visits/${encounterId}/tele/call`).set(...auth(rando.token)).expect(403);
    await http().post(`/opd/visits/${encounterId}/tele/call`).set(...auth(desk.token)).expect(403);
    expect((await http().post(`/opd/visits/${encounterId}/tele/call`).set(...auth(drb.token)).expect(409)).body.code).toBe("not_your_patient");
    const call = await http().post(`/opd/visits/${encounterId}/tele/call`).set(...auth(dra.token)).expect(200);
    expect(call.body).toMatchObject({ encounterId, telePhone: "9876543021" });
    expect(keysOf(call.body).filter((k) => MONEY_KEY.test(k))).toEqual([]);

    // complete is refused before 'spoke', in words with no money in them
    const early = await http().post(`/opd/visits/${encounterId}/consult/complete`).set(...auth(dra.token)).send({ testsOrderedReturnToday: false }).expect(409);
    expect(early.body.code).toBe("tele_outcome_required");
    expect(String(early.body.message)).not.toMatch(MONEY_KEY);

    await http().post(`/opd/visits/${encounterId}/tele/outcome`).send({ outcome: "spoke" }).expect(401);
    await http().post(`/opd/visits/${encounterId}/tele/outcome`).set(...auth(rando.token)).send({ outcome: "spoke" }).expect(403);
    await http().post(`/opd/visits/${encounterId}/tele/outcome`).set(...auth(dra.token)).send({ outcome: "maybe" }).expect(400);
    const spoke = await http().post(`/opd/visits/${encounterId}/tele/outcome`).set(...auth(dra.token)).send({ outcome: "spoke" }).expect(200);
    expect(spoke.body).toMatchObject({ outcome: "spoke", final: true, encounter: { teleOutcome: "spoke" } });
    // one settled invoice stands behind it, raised by the system — and the answer said nothing of it
    expect((await db.select().from(invoices).where(eq(invoices.encounterId, encounterId))).map((i) => ({ net: i.netPayablePaise, by: i.issuedBy }))).toEqual([{ net: 50_000, by: "opd-tele-bill" }]);
    expect(keysOf({ ...spoke.body, encounter: null }).filter((k) => MONEY_KEY.test(k))).toEqual([]);
    await http().post(`/opd/visits/${encounterId}/consult/complete`).set(...auth(dra.token)).send({ testsOrderedReturnToday: false }).expect(201);
    expect((await db.select().from(opdAppointments).where(eq(opdAppointments.id, a.id)))[0]!.status).toBe("checked_in");
  });
});
