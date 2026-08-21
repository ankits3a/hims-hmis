import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { WebSocket } from "ws";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { patientsManifest } from "../src/modules/patients";
import { tariffManifest } from "../src/modules/tariff";
import { opdManifest } from "../src/modules/opd";
import { events, workflowTimers } from "../src/kernel/db/schema";
import { addDays, istDate, istWeekday } from "../src/modules/opd/time";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import type { Db } from "../src/kernel/db/client";

/**
 * THE CLOCK IS PINNED FOR THIS WHOLE SUITE, AND HERE IS WHY (Plan 08.5 D10, ledger §3.41).
 *
 * `bookAndCheckIn` below books "today's first slot more than 20 minutes out" against the wall
 * clock, and the day's last bookable slot is 23:40 IST. After roughly 23:30 IST no such slot
 * exists, so legs 1, 2 and 3 failed on `expect(slot).toBeDefined()` for the last ~30 minutes of
 * every IST day — a docs-only commit went CI-red on it, on a suite whose code nobody had touched.
 * A suite that is green for 23½ hours a day is not a green suite; it is a bomb with a date on it.
 *
 * The fix is to stop reading the wall clock at all. `Date` — and ONLY `Date` — is faked for the
 * whole file: the `doNotFake` list below is jest's complete fakeable-API set MINUS `Date`, taken
 * verbatim from the spike report's question E (`reports/plan-08.5-spike-report.md`, "The
 * `doNotFake` list that works"), which measured that under it `new Date()` returns the pin while
 * a live `pg` round-trip containing `pg_sleep(0.2)` still takes 203 ms of REAL wall time and a
 * supertest round-trip against the booted app returns normally. Every socket, every pg timer and
 * every `setTimeout` therefore stays real, so nothing here needs `advanceTimersByTime` and there
 * is no sleep anywhere in this file. It is installed in `beforeAll` AFTER `app.init()`/`listen()`
 * and released in `afterAll` BEFORE `app.close()`, exactly as the spike measured it.
 *
 * The app boots in this same jest process, so the pin reaches every `new Date()` on BOTH sides of
 * HTTP — which is what the first test below asserts rather than assumes. It does NOT reach `now()`
 * inside SQL: Postgres keeps its own clock, correctly. Nothing in this suite compares a
 * JS-pinned instant against a database-generated timestamp.
 */
const PINNED_NOW = new Date("2026-03-11T07:30:00.000Z"); // 13:00 IST — mid-day, far from any boundary
const PINNED_IST_DATE = "2026-03-11";

/** A complete, in-range adult reading — every field the adult band requires, no danger flag. */
const adultOk = { heightCm: 165, weightKg: 62, sbp: 118, dbp: 76, pulse: 72, rr: 16, spo2: 98, tempC: 36.8 };
/** The same reading with a systolic above the adult band's 180 max — exactly one flag, on `sbp`. */
const adultDanger = { ...adultOk, sbp: 190 };
const rxLine = (drug: string): Record<string, unknown> => ({
  drug, dose: "500 mg", route: "oral", frequency: "TDS", durationDays: 3, instructions: null, noSubstitution: false,
});

type Frame = { type: string } & Record<string, unknown>;
type SlotWire = { start: string; end: string; roomId: string; booked: boolean; past: boolean };
type ApptWire = { id: string; status: string; serviceDate: string; slotStart: string; doctorId: string };
type EncounterWire = {
  id: string; patientId: string; status: string; visitType: string; serviceDate: string; workflowInstanceId: string;
  dangerFlagged: boolean; followUpDays: number | null; followUpExtended: boolean;
};
type EntryWire = {
  id: string; tokenNo: number; kind: string; appointmentAt: string | null; status: string;
  danger: boolean; reEntry: boolean; skips: number;
};
type OrderedWire = EntryWire & { queueClass: number; position: number; encounter: { id: string } };
type OpenWire = {
  encounter: EncounterWire; queueEntry: EntryWire; tokenNo: number; sessionId: string; roomId: string | null;
  visitType: string; doctorScheduledToday: boolean;
};
type QueueWire = {
  session: { id: string }; ordered: OrderedWire[]; current: EntryWire | null; waitingVitals: number;
  counts: { waiting: number; called: number; inConsult: number; done: number; left: number };
};

/**
 * One socket's frames, asserted by PREDICATE with a deadline. `expect` REJECTS when the frame does not arrive,
 * so a push that never happens fails the test — a bare sleep would turn the same miss into a silent pass, which
 * is why there is no sleep anywhere in this suite. A matched frame is CONSUMED, so two identical predicates
 * (the two `queue.called` pushes of leg 3) cannot both be satisfied by the same push.
 */
class FrameStream {
  private readonly buffered: Frame[] = [];
  private waiter: { match: (f: Frame) => boolean; deliver: (f: Frame) => void } | null = null;

  push(frame: Frame): void {
    const waiting = this.waiter;
    if (waiting !== null && waiting.match(frame)) {
      this.waiter = null;
      waiting.deliver(frame);
      return;
    }
    this.buffered.push(frame);
  }

  expect(match: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const buffered = this.buffered.findIndex(match);
    if (buffered >= 0) return Promise.resolve(this.buffered.splice(buffered, 1)[0]!);
    return new Promise<Frame>((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`no frame matched within ${timeoutMs} ms; buffered: ${JSON.stringify(this.buffered)}`));
      }, timeoutMs);
      this.waiter = { match, deliver: (frame) => { clearTimeout(deadline); resolve(frame); } };
    });
  }
}

const isEvent = (name: string, topic?: string) => (f: Frame): boolean =>
  f.type === "event" && f.name === name && (topic === undefined || f.topic === topic);

describe("opd lifecycle e2e (HTTP + WebSocket)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let port: number;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  registry.install(patientsManifest);
  registry.install(tariffManifest);
  registry.install(opdManifest);

  let deptId: string;
  let roomId: string;
  let room2Id: string;
  let clerk: { id: string; token: string };
  let vitalsDesk: { id: string; token: string };
  let supervisor: { id: string; token: string };
  let display: { id: string; token: string };
  let pharmacy: { id: string; token: string };
  let dra: { doctorId: string; userId: string; token: string };
  let drb: { doctorId: string; userId: string; token: string };
  let today: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    // setupTestDb FIRST: it creates and MIGRATES this worker's database, and AppModule's realtime tail reads
    // `select max(seq) from events` at boot. Then the per-worker DATABASE_URL, and only then the module compile.
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    // listen(0), not init(): a real ws client needs a real port (flag ⑰).
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    jest.useFakeTimers({
      doNotFake: [
        "hrtime", "nextTick", "performance", "queueMicrotask",
        "requestAnimationFrame", "cancelAnimationFrame",
        "requestIdleCallback", "cancelIdleCallback",
        "setImmediate", "clearImmediate",
        "setInterval", "clearInterval",
        "setTimeout", "clearTimeout",
      ],
      now: PINNED_NOW,
    });
  });
  afterAll(async () => { jest.useRealTimers(); await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId, room2Id } = await seedOpdMasters(db));
    today = istDate(new Date());

    const mkRole = async (key: string, permissions: string[]): Promise<void> => {
      await createRole(db, key, key);
      for (const p of permissions) await grantPermissionToRole(db, registry, key, p);
    };
    const deskPermissions = [
      "opd.appointments.read", "opd.appointments.manage", "opd.visits.read", "opd.visits.open",
      "opd.queue.read", "opd.vitals.record", "patients.register", "patients.read", "patients.update",
    ];
    await mkRole("desk", deskPermissions);
    await mkRole("doc", ["opd.consult", "opd.queue.read", "opd.queue.operate", "opd.visits.read", "patients.read"]);
    await mkRole("sup", [...deskPermissions, "opd.queue.transfer", "opd.masters.read", "opd.masters.manage", "opd.config.manage"]);
    await mkRole("disp", ["opd.display.read"]);
    await mkRole("pharm", ["opd.prescriptions.verify"]);

    clerk = await mkUser(db, "clerk", ["desk", "front_office"]);
    vitalsDesk = await mkUser(db, "vd", ["desk", "vitals_desk"]);
    supervisor = await mkUser(db, "sup", ["sup", "front_office_supervisor"]);
    display = await mkUser(db, "disp", ["disp"]);
    pharmacy = await mkUser(db, "pharm", ["pharm"]);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: dra.userId, roleKey: "doc", scopeType: "hospital" });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: drb.userId, roleKey: "doc", scopeType: "hospital" });
  });

  afterEach(() => {
    while (sockets.length > 0) sockets.pop()!.terminate();
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];
  const http = () => request(app.getHttpServer());

  /** An authenticated, subscribed socket. Both handshake replies are asserted before any push is awaited. */
  const openSocket = async (token: string, topics: string[]): Promise<FrameStream> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    const stream = new FrameStream();
    ws.on("message", (raw) => { stream.push(JSON.parse(String(raw)) as Frame); });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    ws.send(JSON.stringify({ type: "auth", token }));
    await stream.expect((f) => f.type === "authed");
    ws.send(JSON.stringify({ type: "subscribe", topics }));
    expect((await stream.expect((f) => f.type === "subscribed")).topics).toEqual(topics);
    return stream;
  };

  const registerPatientOverHttp = async (name: string, phone: string): Promise<string> => {
    const reg = await http().post("/patients").set(...auth(clerk.token))
      .send({ name, sex: "female", phone, ageYears: 30 }).expect(201);
    return reg.body.patient.id as string;
  };

  /** A weekly template covering the given IST weekdays end to end, so a bookable slot always exists. */
  const putFullDayTemplate = async (doctorId: string, weekdays: number[]): Promise<string[]> => {
    const res = await http().put(`/opd/doctors/${doctorId}/schedules`).set(...auth(supervisor.token))
      .send({
        items: weekdays.map((weekday) => ({
          weekday, startTime: "00:00", endTime: "23:50", roomId, slotMinutes: 10, validFrom: "2026-01-01",
        })),
      })
      .expect(200);
    return res.body.scheduleIds as string[];
  };

  const slotsFor = async (doctorId: string, date: string): Promise<SlotWire[]> => {
    const grid = await http().get("/opd/slots").query({ doctorId, date }).set(...auth(supervisor.token)).expect(200);
    return grid.body.slots as SlotWire[];
  };

  const queueOf = async (doctorId: string, token = clerk.token): Promise<QueueWire> => {
    const res = await http().get("/opd/queues").query({ doctorId, serviceDate: today }).set(...auth(token)).expect(200);
    return res.body as QueueWire;
  };

  const recordVitals = async (encounterId: string, body: Record<string, number>): Promise<{ flags: { vital: string }[] }> => {
    const res = await http().post(`/opd/visits/${encounterId}/vitals`).set(...auth(vitalsDesk.token)).send(body).expect(201);
    return res.body as { flags: { vital: string }[] };
  };

  /** A walk-in visit, opened by the desk. */
  const openWalkIn = async (patientId: string, doctorId = dra.doctorId): Promise<OpenWire> => {
    const res = await http().post("/opd/visits").set(...auth(clerk.token))
      .send({ patientId, departmentId: deptId, doctorId }).expect(201);
    return res.body as OpenWire;
  };

  /**
   * Leg 1's path — book today's first slot at least 20 minutes out and check in — reused by the legs that need a
   * checked-in appointment patient. The 20-minute cushion keeps the slot in the FUTURE (queue class 4) while the
   * legs run; the day's last bookable slot is 23:50 IST, so between 23:30 and midnight IST no such slot exists and
   * the expectation below fails loudly rather than silently booking a due slot.
   */
  const bookAndCheckIn = async (name: string, phone: string): Promise<{
    patientId: string; scheduleIds: string[]; slots: SlotWire[]; slotStart: string; appointment: ApptWire; checkIn: OpenWire;
  }> => {
    const scheduleIds = await putFullDayTemplate(dra.doctorId, [istWeekday(today)]);
    const patientId = await registerPatientOverHttp(name, phone);
    const slots = await slotsFor(dra.doctorId, today);
    const cutoff = Date.now() + 20 * 60_000;
    const slot = slots.find((s) => !s.booked && new Date(s.start).getTime() > cutoff);
    expect(slot).toBeDefined();
    const slotStart = slot!.start;
    const booked = await http().post("/opd/appointments").set(...auth(supervisor.token))
      .send({ patientId, doctorId: dra.doctorId, slotStart }).expect(201);
    const appointment = booked.body.appointment as ApptWire;
    const checkedIn = await http().post(`/opd/appointments/${appointment.id}/check-in`).set(...auth(clerk.token)).expect(201);
    return { patientId, scheduleIds, slots, slotStart, appointment, checkIn: checkedIn.body as OpenWire };
  };

  it("the pinned clock reaches SERVER code: /opd/slots with no date defaults to the pinned IST day", async () => {
    // THE TEETH ON THE PIN (D10). Everything else in this file would still pass if `Date` were
    // faked only inside the test file and the Nest app read the real clock — the suite would look
    // fixed and the bomb would still be armed on the server side. `GET /opd/slots` without a
    // `date` resolves it as `q.date ?? istDate(new Date())` INSIDE the controller
    // (opd-visits.controller.ts), so the day these slots land on is the server's own answer to
    // "what day is it", travelled back over HTTP.
    expect(today).toBe(PINNED_IST_DATE); // the test side of the pin, stated so the two are separable
    await putFullDayTemplate(dra.doctorId, [istWeekday(today)]);

    const defaulted = await http().get("/opd/slots").query({ doctorId: dra.doctorId }).set(...auth(supervisor.token)).expect(200);
    const slots = defaulted.body.slots as SlotWire[];
    // Both halves are load-bearing. An unpinned server would answer with the REAL today: a
    // different weekday returns zero slots (the template covers one weekday only), and the same
    // weekday returns slots dated some other day. Neither survives the pair.
    expect(slots.length).toBeGreaterThan(0);
    expect([...new Set(slots.map((s) => istDate(new Date(s.start))))]).toEqual([PINNED_IST_DATE]);
    // And the explicit-date call agrees with the defaulted one — the default is the only thing
    // under test here, not the slot grid itself.
    expect(await slotsFor(dra.doctorId, PINNED_IST_DATE)).toEqual(slots);
  });

  it("leg 1 — a booked appointment is checked in as an appointment visit and waits as a FUTURE-class token", async () => {
    const { scheduleIds, slots, slotStart, appointment, checkIn } = await bookAndCheckIn("Asha Devi", "9876543210");

    expect(scheduleIds).toHaveLength(1);
    expect(slots.length).toBeGreaterThan(0);
    expect(appointment.status).toBe("booked");
    expect(appointment.serviceDate).toBe(today);
    expect(appointment.doctorId).toBe(dra.doctorId);

    expect(checkIn.encounter.status).toBe("registered");
    expect(checkIn.encounter.visitType).toBe("new");
    expect(checkIn.tokenNo).toBe(1);
    expect(checkIn.roomId).toBe(roomId);
    expect(checkIn.doctorScheduledToday).toBe(true);
    expect(checkIn.queueEntry.kind).toBe("appointment");
    expect(new Date(checkIn.queueEntry.appointmentAt!).toISOString()).toBe(new Date(slotStart).toISOString());

    // The check-in mints the appointment-kind visit.opened, not the walk-in one.
    const opened = await db.select().from(events)
      .where(and(eq(events.name, "visit.opened"), eq(events.encounterId, checkIn.encounter.id)));
    expect(opened).toHaveLength(1);
    expect(opened[0]!.payload).toMatchObject({ kind: "appointment", appointmentId: appointment.id, tokenNo: 1 });

    // Before vitals the entry is not in the queue at all; after vitals it waits in class 4 — its slot is still ahead.
    const beforeVitals = await queueOf(dra.doctorId);
    expect(beforeVitals.waitingVitals).toBe(1);
    expect(beforeVitals.ordered).toEqual([]);

    const vitals = await recordVitals(checkIn.encounter.id, adultOk);
    expect(vitals.flags).toEqual([]);

    const queue = await queueOf(dra.doctorId);
    expect(queue.ordered).toHaveLength(1);
    expect(queue.ordered[0]!.tokenNo).toBe(1);
    expect(queue.ordered[0]!.queueClass).toBe(4);
    expect(queue.ordered[0]!.kind).toBe("appointment");
  });

  it("leg 2 — a danger reading reorders the queue over HTTP and pushes vitals.danger_flagged over the socket", async () => {
    const stream = await openSocket(clerk.token, [`queue:${dra.doctorId}:${today}`]);

    const appointmentPatient = await bookAndCheckIn("Rina Kumari", "9876543211");
    const walkInPatientId = await registerPatientOverHttp("Sita Devi", "9876543212");
    const walkIn = await openWalkIn(walkInPatientId);
    expect(walkIn.tokenNo).toBe(2); // tokens are per doctor-day: the appointment took 1

    expect((await recordVitals(walkIn.encounter.id, adultOk)).flags).toEqual([]);
    const danger = await recordVitals(appointmentPatient.checkIn.encounter.id, adultDanger);
    expect(danger.flags).toEqual([{ vital: "sbp", value: 190, bound: "max", limit: 180 }]);

    // Class 0 (danger) outranks the walk-in that arrived first AND the appointment's own future slot (class 4).
    const queue = await queueOf(dra.doctorId);
    expect(queue.ordered).toHaveLength(2);
    expect(queue.ordered[0]!.tokenNo).toBe(1);
    expect(queue.ordered[0]!.queueClass).toBe(0);
    expect(queue.ordered[0]!.danger).toBe(true);
    expect(queue.ordered[1]!.tokenNo).toBe(2);
    expect(queue.ordered[1]!.queueClass).toBe(3);

    const frame = await stream.expect(isEvent("vitals.danger_flagged", `queue:${dra.doctorId}:${today}`));
    const payload = frame.payload as { flags: { vital: string }[]; tokenNo: number; doctorId: string };
    expect(payload.flags[0]!.vital).toBe("sbp");
    expect(payload.tokenNo).toBe(1);
    expect(payload.doctorId).toBe(dra.doctorId);
  }, 30_000);

  it("leg 3 — call, skip, call again, consult, e-Rx v1 → v2 supersession, tests-ordered re-entry and completion", async () => {
    const queueStream = await openSocket(clerk.token, [`queue:${dra.doctorId}:${today}`]);
    const displayStream = await openSocket(display.token, [`display:${roomId}`]);

    const appointmentPatient = await bookAndCheckIn("Meena Devi", "9876543213");
    const encounterId = appointmentPatient.checkIn.encounter.id;
    const sessionId = appointmentPatient.checkIn.sessionId;
    expect(appointmentPatient.checkIn.roomId).toBe(roomId);

    const walkInPatientId = await registerPatientOverHttp("Gita Kumari", "9876543214");
    const walkIn = await openWalkIn(walkInPatientId);
    await recordVitals(walkIn.encounter.id, adultOk); // waits FIRST — its eligibleAt is the earliest
    await recordVitals(encounterId, adultDanger);

    // (a) the danger token is called, and the same fact reaches the queue AND the room's display board
    const firstCall = await http().post(`/opd/queues/${sessionId}/call-next`).set(...auth(dra.token)).expect(201);
    expect((firstCall.body.entry as EntryWire).tokenNo).toBe(1);
    expect((firstCall.body.entry as EntryWire).status).toBe("called");
    expect((firstCall.body.encounter as EncounterWire).id).toBe(encounterId);
    const calledFrame = await queueStream.expect(isEvent("queue.called", `queue:${dra.doctorId}:${today}`));
    expect((calledFrame.payload as { tokenNo: number }).tokenNo).toBe(1);
    const displayFrame = await displayStream.expect(isEvent("queue.called", `display:${roomId}`));
    expect((displayFrame.payload as { tokenNo: number }).tokenNo).toBe(1);

    // (b) a skip re-queues with eligibleAt = now — behind the walk-in in time, still ahead of it in CLASS
    const entryId = (firstCall.body.entry as EntryWire).id;
    const skipped = await http().post(`/opd/queues/entries/${entryId}/skip`).set(...auth(dra.token)).expect(201);
    expect((skipped.body.entry as EntryWire).status).toBe("waiting");
    expect((skipped.body.entry as EntryWire).skips).toBe(1);
    const skipFrame = await queueStream.expect(isEvent("queue.skipped", `queue:${dra.doctorId}:${today}`));
    expect((skipFrame.payload as { tokenNo: number; left: boolean }).tokenNo).toBe(1);
    expect((skipFrame.payload as { tokenNo: number; left: boolean }).left).toBe(false);

    const secondCall = await http().post(`/opd/queues/${sessionId}/call-next`).set(...auth(dra.token)).expect(201);
    expect((secondCall.body.entry as EntryWire).tokenNo).toBe(1); // the eligibleAt reset does NOT demote class 0
    expect((await queueStream.expect(isEvent("queue.called"))).payload).toMatchObject({ tokenNo: 1 });

    // (c) consultation, e-Rx v1, pharmacy scan
    const started = await http().post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);
    expect((started.body.encounter as EncounterWire).status).toBe("in_consultation");
    const v1 = await http().post(`/opd/visits/${encounterId}/prescriptions`).set(...auth(dra.token))
      .send({ lines: [rxLine("Tab Paracetamol")] }).expect(201);
    expect(v1.body.version).toBe(1);
    const v1Payload = v1.body.qrPayload as string;
    const scanV1 = await http().post("/opd/prescriptions/verify").set(...auth(pharmacy.token))
      .send({ payload: v1Payload }).expect(200);
    expect(scanV1.body.ok).toBe(true);
    expect(scanV1.body.prescription.version).toBe(1);

    // (d) tests ordered → awaiting_results → same-day re-entry keeps the SAME token
    const parked = await http().post(`/opd/visits/${encounterId}/consult/complete`).set(...auth(dra.token))
      .send({ testsOrderedReturnToday: true }).expect(201);
    expect((parked.body.encounter as EncounterWire).status).toBe("awaiting_results");
    const reEntered = await http().post(`/opd/visits/${encounterId}/re-enter`).set(...auth(clerk.token)).expect(201);
    expect((reEntered.body.encounter as EncounterWire).status).toBe("waiting");
    expect((reEntered.body.queueEntry as EntryWire).reEntry).toBe(true);
    expect((reEntered.body.queueEntry as EntryWire).tokenNo).toBe(1);
    const afterReEntry = await queueOf(dra.doctorId);
    const reEntryRow = afterReEntry.ordered.find((r) => r.encounter.id === encounterId)!;
    expect(reEntryRow.reEntry).toBe(true);
    // Class 0, not 1: this patient's danger flag never auto-clears (D4), and danger outranks re-entry.
    expect(reEntryRow.queueClass).toBe(0);

    // (e) the second consultation: v2 supersedes v1, and v1's printed card stops verifying
    await http().post(`/opd/queues/${sessionId}/call-next`).set(...auth(dra.token)).expect(201);
    await http().post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);
    const v2 = await http().post(`/opd/visits/${encounterId}/prescriptions`).set(...auth(dra.token))
      .send({ lines: [rxLine("Tab Amoxicillin"), rxLine("Tab Paracetamol")] }).expect(201);
    expect(v2.body.version).toBe(2);
    const staleScan = await http().post("/opd/prescriptions/verify").set(...auth(pharmacy.token))
      .send({ payload: v1Payload }).expect(200);
    expect(staleScan.body).toEqual({ ok: false, reason: "stale_version" });
    const scanV2 = await http().post("/opd/prescriptions/verify").set(...auth(pharmacy.token))
      .send({ payload: v2.body.qrPayload }).expect(200);
    expect(scanV2.body.ok).toBe(true);
    expect(scanV2.body.prescription.version).toBe(2);

    const completed = await http().post(`/opd/visits/${encounterId}/consult/complete`).set(...auth(dra.token))
      .send({ testsOrderedReturnToday: false, followUpDays: 21 }).expect(201);
    expect((completed.body.encounter as EncounterWire).status).toBe("completed");
    expect((completed.body.encounter as EncounterWire).followUpDays).toBe(21);
    expect((completed.body.encounter as EncounterWire).followUpExtended).toBe(true);

    // The parked pass minted no completion: exactly ONE consultation.completed for the whole visit.
    const completions = await db.select().from(events)
      .where(and(eq(events.name, "consultation.completed"), eq(events.encounterId, encounterId)));
    expect(completions).toHaveLength(1);

    const timeline = await http().get(`/opd/patients/${appointmentPatient.patientId}/timeline`)
      .set(...auth(clerk.token)).expect(200);
    expect(timeline.body.items).toHaveLength(1);
    expect(timeline.body.items[0].prescriptionLineCount).toBe(2); // v2's lines — v1 is superseded

    // (f) the same-day re-entry of a patient WITHOUT a danger flag is the class-1 case
    const walkInEncounterId = walkIn.encounter.id;
    await http().post(`/opd/queues/${sessionId}/call-next`).set(...auth(dra.token)).expect(201);
    await http().post(`/opd/visits/${walkInEncounterId}/consult/start`).set(...auth(dra.token)).expect(201);
    await http().post(`/opd/visits/${walkInEncounterId}/consult/complete`).set(...auth(dra.token))
      .send({ testsOrderedReturnToday: true }).expect(201);
    const walkInReEntry = await http().post(`/opd/visits/${walkInEncounterId}/re-enter`).set(...auth(clerk.token)).expect(201);
    expect((walkInReEntry.body.queueEntry as EntryWire).tokenNo).toBe(2); // the SAME token as its arrival
    const finalQueue = await queueOf(dra.doctorId);
    const walkInRow = finalQueue.ordered.find((r) => r.encounter.id === walkInEncounterId)!;
    expect(walkInRow.reEntry).toBe(true);
    expect(walkInRow.danger).toBe(false);
    expect(walkInRow.queueClass).toBe(1);
  }, 60_000);

  it("leg 4 — a supervisor transfers a live queue to another doctor, and the desk abandons the visit", async () => {
    const stream = await openSocket(clerk.token, [`queue:${drb.doctorId}:${today}`]);

    const patientId = await registerPatientOverHttp("Kavita Devi", "9876543215");
    const walkIn = await openWalkIn(patientId);
    expect(walkIn.tokenNo).toBe(1);
    await recordVitals(walkIn.encounter.id, adultOk);

    const transfer = await http().post("/opd/queues/transfer").set(...auth(supervisor.token))
      .send({
        fromDoctorId: dra.doctorId, toDoctorId: drb.doctorId, serviceDate: today,
        consented: true, reason: "doctor called away",
      })
      .expect(201);
    expect(transfer.body.transferred).toBe(1);

    const receiving = await queueOf(drb.doctorId);
    expect(receiving.ordered).toHaveLength(1);
    expect(receiving.ordered[0]!.tokenNo).toBe(1); // a fresh token in the target doctor-day
    expect(receiving.ordered[0]!.encounter.id).toBe(walkIn.encounter.id);
    const sending = await queueOf(dra.doctorId);
    expect(sending.ordered).toEqual([]);
    expect(sending.counts.waiting).toBe(0);

    const frame = await stream.expect(isEvent("visit.transferred", `queue:${drb.doctorId}:${today}`));
    expect(frame.payload).toMatchObject({ fromDoctorId: dra.doctorId, toDoctorId: drb.doctorId, tokenNo: 1 });

    const abandoned = await http().post(`/opd/visits/${walkIn.encounter.id}/abandon`).set(...auth(clerk.token))
      .send({ reason: "patient went home" }).expect(201);
    expect((abandoned.body.encounter as EncounterWire).status).toBe("abandoned");
    const afterAbandon = await queueOf(drb.doctorId);
    expect(afterAbandon.ordered).toEqual([]);
    expect(afterAbandon.counts.waiting).toBe(0);
  }, 30_000);

  it("leg 5 — a doctor leave cascades to needs_rebooking, the worklist rebooks it, cancelling restores nothing", async () => {
    const tomorrow = addDays(today, 1);
    const dayAfter = addDays(today, 2);
    await putFullDayTemplate(dra.doctorId, [istWeekday(tomorrow), istWeekday(dayAfter)]);

    const patientId = await registerPatientOverHttp("Laxmi Devi", "9876543216");
    const tomorrowSlots = await slotsFor(dra.doctorId, tomorrow);
    expect(tomorrowSlots.length).toBeGreaterThan(0);
    const booked = await http().post("/opd/appointments").set(...auth(supervisor.token))
      .send({ patientId, doctorId: dra.doctorId, slotStart: tomorrowSlots[0]!.start }).expect(201);
    const appointmentId = (booked.body.appointment as ApptWire).id;

    const leave = await http().post("/opd/leaves").set(...auth(supervisor.token))
      .send({ doctorId: dra.doctorId, fromDate: tomorrow, toDate: tomorrow, reason: "conference" }).expect(201);
    expect(leave.body.affectedAppointmentIds).toEqual([appointmentId]);

    const worklist = await http().get("/opd/appointments").query({ needsRebooking: "true" })
      .set(...auth(supervisor.token)).expect(200);
    expect(worklist.body.items).toHaveLength(1);
    expect((worklist.body.items[0] as ApptWire).id).toBe(appointmentId);
    expect((worklist.body.items[0] as ApptWire).status).toBe("needs_rebooking");

    const dayAfterSlots = await slotsFor(dra.doctorId, dayAfter);
    expect(dayAfterSlots.length).toBeGreaterThan(0);
    const rebooked = await http().post(`/opd/appointments/${appointmentId}/reschedule`).set(...auth(supervisor.token))
      .send({ slotStart: dayAfterSlots[0]!.start }).expect(201);
    expect((rebooked.body.from as ApptWire).status).toBe("rescheduled");
    expect((rebooked.body.to as ApptWire).status).toBe("booked");
    expect((rebooked.body.to as ApptWire).serviceDate).toBe(dayAfter);

    // Nothing to restore: the worklist already moved the only affected booking off needs_rebooking.
    const cancelled = await http().post(`/opd/leaves/${leave.body.leaveId}/cancel`).set(...auth(supervisor.token)).expect(201);
    expect(cancelled.body).toEqual({ restored: 0 });
  });

  it("leg 6 — every state entered scheduled an SLA timer, every one was cancelled by its move, none breached", async () => {
    const patientId = await registerPatientOverHttp("Pooja Devi", "9876543217");
    const walkIn = await openWalkIn(patientId);
    const encounterId = walkIn.encounter.id;
    const instanceId = walkIn.encounter.workflowInstanceId;

    await recordVitals(encounterId, adultOk);
    await http().post(`/opd/queues/${walkIn.sessionId}/call-next`).set(...auth(dra.token)).expect(201);
    await http().post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);
    await http().post(`/opd/visits/${encounterId}/consult/complete`).set(...auth(dra.token))
      .send({ testsOrderedReturnToday: false }).expect(201);

    // registered → waiting → in_consultation → completed: one SLA timer per non-terminal state entered,
    // each cancelled by the move out of it; the terminal state schedules none.
    const timers = await db.select().from(workflowTimers).where(eq(workflowTimers.instanceId, instanceId));
    expect(timers).toHaveLength(3);
    expect(timers.map((t) => t.state).sort()).toEqual(["in_consultation", "registered", "waiting"]);
    expect(timers.every((t) => t.kind === "sla")).toBe(true);
    expect(timers.every((t) => t.cancelledAt !== null)).toBe(true);
    expect(timers.filter((t) => t.state === "waiting" && t.cancelledAt !== null)).toHaveLength(1);
    expect(timers.every((t) => t.firedAt === null)).toBe(true);

    const breaches = await db.select().from(events).where(eq(events.name, "sla.breached"));
    expect(breaches).toEqual([]); // nothing waited 45 minutes
  });
});
