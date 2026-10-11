import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { newId } from "@hmis/contracts";
import { AppModule } from "../../../app.module";
import { configureApp } from "../../../app.bootstrap";
import { createRole, grantPermissionToRole, syncPermissions } from "../../auth/permissions";
import { ModuleRegistry } from "../../modules/loader";
import { ALL_MANIFESTS } from "../../modules/manifests";
import { copilotActs, events, opdAppointments, opdDoctorLeaves, patients } from "../../db/schema";
import { requireEnv } from "../../config";
import { routeQuestion } from "../router";
import { maskQuestion } from "../mask";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { openSessionFor, seedBillingBase } from "../../../../test/helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../../test/helpers/opd";
import { addDays, istDate } from "../../../modules/opd/time";
import { listQueue } from "../../../modules/opd/queue";
import { openTeleVisitFor, recordTeleAdvance } from "../../../modules/opd/tele";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { CopilotApptPick } from "@hmis/contracts";
import type { Proposal } from "../act";
import type { ChoiceClient, InferenceClient } from "../../inference/types";
import type { Db } from "../../db/client";

/**
 * ═══ E2.1 — BOOK / MOVE AN APPOINTMENT FROM THE COPILOT CHAT: THE OWNER'S "DONE MEANS" ═══
 *
 * Spec /opt/hmis-context/SPEC-copilot-appt-2026-10-11.md, approved by the owner 2026-10-11. LOCKED once
 * merged (tools/ci/acceptance-guard.mjs): add new checks, never edit one. Check 8 (the same answer text on
 * the phone and the web) is the clients' parity tests.
 *
 * Every date is relative to the real clock: the day booked is the day after tomorrow, IST ("parso"), on a
 * doctor who sits every day 09:00–13:00, so any hour the suite runs at has free times on it.
 */
describe("E2.1 — appointments from the copilot chat (acceptance)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let reader: Awaited<ReturnType<typeof mkUser>>;
  let owner: Awaited<ReturnType<typeof mkUser>>;
  let doctor: Awaited<ReturnType<typeof mkDoctor>>;
  let asha: { id: string; uhid: string };
  let day: string;

  const http = () => request(app.getHttpServer());
  const ask = (token: string, question: string) =>
    http().post("/copilot/ask").set("Authorization", `Bearer ${token}`).send({ question }).expect(200);
  const confirm = (token: string, proposal: Proposal) =>
    http().post("/copilot/confirm").set("Authorization", `Bearer ${token}`).send({ proposal }).expect(200);
  const appointments = () => db.select().from(opdAppointments);
  const acts = () => db.select().from(copilotActs);
  const pickOf = (body: { answer: { payload?: unknown } }) => body.answer.payload as CopilotApptPick;

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
    await app.close();
    await teardown();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    await seedBillingBase(db);
    await createRole(db, "appt_desk", "Appointment desk");
    for (const p of ["opd.appointments.manage", "opd.appointments.read"]) await grantPermissionToRole(db, registry, "appt_desk", p);
    await createRole(db, "appt_reader", "Appointment reader");
    await grantPermissionToRole(db, registry, "appt_reader", "opd.appointments.read");
    await createRole(db, "halt_owner", "Owner");
    for (const p of ["copilot.halt.set", "copilot.halt.clear"]) await grantPermissionToRole(db, registry, "halt_owner", p);
    clerk = await mkUser(db, "appt_clerk", ["appt_desk", "cashier"]);
    reader = await mkUser(db, "appt_reader", ["appt_reader"]);
    owner = await mkUser(db, "appt_owner", ["halt_owner"]);
    doctor = await mkDoctor(db, {
      username: "meera", displayName: "Dr Meera Rao", departmentId: m.deptId, roomId: m.roomId, weekdays: [0, 1, 2, 3, 4, 5, 6],
    });
    asha = await mkPatient(db, clerk.actor, { name: "Asha Devi", phone: "9876500001" });
    day = addDays(istDate(new Date()), 2);
  });

  it("done means 1: a chat booking equals a screen booking except 'via copilot'", async () => {
    // The screen books Asha at 12:00 on the day; the chat books her too.
    const screen = await http().post("/opd/appointments").set("Authorization", `Bearer ${clerk.token}`)
      .send({ patientId: asha.id, doctorId: doctor.doctorId, slotStart: new Date(`${day}T12:00:00+05:30`).toISOString() }).expect(201);

    const asked = await ask(clerk.token, `Dr Meera Rao parso 9 baje ${asha.uhid} ka appointment`);
    expect(asked.body).toMatchObject({ source: "phrasebook", intent: "appointment_book", answer: { key: "copilot.answer.apptPickTime" } });
    const pick = pickOf(asked.body);
    expect(pick).toMatchObject({ action: "book", pickPatient: false });
    expect(pick.rows).toHaveLength(1);
    expect(pick.rows[0]!.patient).toMatchObject({ uhid: asha.uhid, name: "Asha Devi" });
    expect(pick.rows[0]!.times.map((t) => t.at)).toEqual([
      new Date(`${day}T09:00:00+05:30`).toISOString(), new Date(`${day}T09:10:00+05:30`).toISOString(), new Date(`${day}T09:20:00+05:30`).toISOString(),
    ]);
    expect(await appointments()).toHaveLength(1); // the ask wrote nothing

    const done = await confirm(clerk.token, asked.body.proposals[pick.rows[0]!.times[0]!.proposal]);
    expect(done.body).toEqual({
      outcome: "done",
      answer: { key: "copilot.answer.apptBooked", params: { patient: "Asha Devi", uhid: asha.uhid, doctor: "Dr Meera Rao", when: new Date(`${day}T09:00:00+05:30`).toISOString() } },
    });

    const rows = await appointments();
    const viaScreen = rows.find((r) => r.id === screen.body.appointment.id)!;
    const viaChat = rows.find((r) => r.id !== viaScreen.id)!;
    const same = (r: typeof viaChat) => ({
      patientId: r.patientId, doctorId: r.doctorId, departmentId: r.departmentId, serviceDate: r.serviceDate, status: r.status,
      source: r.source, note: r.note, mode: r.mode, telePhone: r.telePhone, bookedBy: r.bookedBy, updatedBy: r.updatedBy,
      encounterId: r.encounterId, rescheduledFromId: r.rescheduledFromId, advanceQuotedAt: r.advanceQuotedAt,
      numberSeries: r.appointmentNo.replace(/\d+$/, ""),
    });
    expect(same(viaChat)).toEqual(same(viaScreen));

    const booked = await db.select().from(events).where(eq(events.name, "appointment.booked"));
    expect(booked).toHaveLength(2);
    const payloadKeys = booked.map((e) => Object.keys(e.payload as object).sort());
    expect(payloadKeys[0]).toEqual(payloadKeys[1]);

    const [act] = await acts();
    expect(act).toMatchObject({ tool: "appointment_book", resultModule: "opd", resultRowId: viaChat.id, subjectPatientId: asha.id, actorId: clerk.id });

    const list = await http().get(`/opd/appointments?serviceDate=${day}`).set("Authorization", `Bearer ${clerk.token}`).expect(200);
    const view = (id: string) => (list.body.items as { id: string; viaCopilot?: boolean }[]).find((i) => i.id === id)!;
    expect(view(viaChat.id).viaCopilot).toBe(true);
    expect(view(viaScreen.id).viaCopilot).toBeUndefined();
  });

  it("done means 2 (G7): every act's patient is the appointment's patient and the event's patient", async () => {
    const ravi = await mkPatient(db, clerk.actor, { name: "Ravi Shankar", phone: "9876500002" });
    for (const p of [asha, ravi]) {
      const asked = await ask(clerk.token, `${p.uhid} ka appointment Dr Meera Rao parso`);
      const pick = pickOf(asked.body);
      await confirm(clerk.token, asked.body.proposals[pick.rows[0]!.times[p === asha ? 0 : 1]!.proposal]).then((r) => expect(r.body.outcome).toBe("done"));
    }
    const moved = await ask(clerk.token, `${ravi.uhid} ka appointment kal pe shift karo`);
    expect(moved.body).toMatchObject({ intent: "appointment_move" });
    const mp = pickOf(moved.body);
    expect(mp.rows[0]!.from).not.toBeNull();
    await confirm(clerk.token, moved.body.proposals[mp.rows[0]!.times[0]!.proposal]).then((r) => expect(r.body).toMatchObject({ outcome: "done", answer: { key: "copilot.answer.apptMoved" } }));

    // THE RECONCILIATION QUERY (plan §1 G7): acts whose subject is not the written row's patient, or not the event's.
    const wrong = await db.execute(sql`
      SELECT a.id FROM copilot_acts a
      JOIN opd_appointments o ON o.id = a.result_row_id
      JOIN events e ON e.name IN ('appointment.booked', 'appointment.rescheduled')
        AND COALESCE(e.payload->>'appointmentId', e.payload->>'toAppointmentId') = a.result_row_id
      WHERE a.result_module = 'opd' AND (a.subject_patient_id IS DISTINCT FROM o.patient_id OR a.subject_patient_id IS DISTINCT FROM e.payload->>'patientId')`);
    expect(wrong.rows).toEqual([]);
    const reconciled = await db.execute(sql`
      SELECT a.id FROM copilot_acts a
      JOIN events e ON COALESCE(e.payload->>'appointmentId', e.payload->>'toAppointmentId') = a.result_row_id
      WHERE a.result_module = 'opd'`);
    expect(reconciled.rows).toHaveLength(3);
    expect(await acts()).toHaveLength(3);
  });

  it("done means 3: a chat-booked tele-call is absent from the doctor's queue until paid; moved paid, it keeps its payment", async () => {
    await openSessionFor(db, clerk, 0);
    const asked = await ask(clerk.token, `${asha.uhid} ka tele call appointment Dr Meera Rao parso`);
    const pick = pickOf(asked.body);
    expect(pick.rows[0]!.mode).toBe("tele");
    const done = await confirm(clerk.token, asked.body.proposals[pick.rows[0]!.times[0]!.proposal]);
    expect(done.body.outcome).toBe("done");
    const [tele] = await appointments();
    expect(tele).toMatchObject({ mode: "tele", telePhone: "9876500001", advanceQuotedAt: null });

    const atSlot = new Date(tele!.slotStart.getTime() + 60_000);
    expect(await openTeleVisitFor(db, tele!.id, atSlot)).toEqual({ opened: false, encounterId: null });
    expect(await listQueue(db, doctor.actor, doctor.doctorId, day, atSlot)).toBeNull();

    await recordTeleAdvance(db, clerk.actor, tele!.id, { amountPaise: 50_000, tenders: [{ mode: "cash", amountPaise: 50_000 }] }, new Date());
    const paid = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, tele!.id)))[0]!;
    expect(paid.advanceReceiptId).not.toBeNull();

    const moved = await ask(clerk.token, `${asha.uhid} ka appointment reschedule karo`);
    const mp = pickOf(moved.body);
    expect(mp.rows[0]!.mode).toBe("tele");
    await confirm(clerk.token, moved.body.proposals[mp.rows[0]!.times[0]!.proposal]).then((r) => expect(r.body.outcome).toBe("done"));
    const to = (await db.select().from(opdAppointments).where(eq(opdAppointments.rescheduledFromId, tele!.id)))[0]!;
    expect(to).toMatchObject({ status: "booked", mode: "tele", advanceReceiptId: paid.advanceReceiptId, advanceQuotePaise: paid.advanceQuotePaise });
    expect(await openTeleVisitFor(db, to.id, new Date(to.slotStart.getTime() + 60_000))).toMatchObject({ opened: true });
  });

  it("done means 4: a name with two matches proposes nothing until one is tapped; a sealed patient never appears without clearance", async () => {
    const r1 = await mkPatient(db, clerk.actor, { name: "Ramesh Kumar", phone: "9876500011" });
    const r2 = await mkPatient(db, clerk.actor, { name: "Ramesh Kumar", phone: "9876500012" });
    const sealed = await mkPatient(db, clerk.actor, { name: "Ramesh Kumar", phone: "9876500013" });
    await db.update(patients).set({ isConfidential: true }).where(eq(patients.id, sealed.id));

    const asked = await ask(clerk.token, "Ramesh Kumar ka appointment Dr Meera Rao parso laga do");
    expect(asked.body).toMatchObject({ intent: "appointment_book", answer: { key: "copilot.answer.apptPick", params: { count: 2 } } });
    const pick = pickOf(asked.body);
    expect(pick.pickPatient).toBe(true);
    expect(pick.rows.map((r) => r.patient.uhid).sort()).toEqual([r1.uhid, r2.uhid].sort());
    expect(JSON.stringify(asked.body)).not.toContain(sealed.uhid);
    // Each option binds the patient it is shown under: the tap picks one person, never the other.
    for (const row of pick.rows) {
      const ids = new Set(row.times.map((t) => (asked.body.proposals[t.proposal] as Proposal).subject));
      expect([...ids]).toEqual([row.patient.uhid === r1.uhid ? r1.id : r2.id]);
    }
    expect(await appointments()).toHaveLength(0);
    expect(await acts()).toHaveLength(0);

    // The same patient by a mobile number is still a tap, even with one match.
    const byPhone = await ask(clerk.token, "9876500011 ka appointment Dr Meera Rao parso");
    expect(pickOf(byPhone.body)).toMatchObject({ pickPatient: true, rows: [{ patient: { uhid: r1.uhid } }] });
  });

  it("done means 5: the slot taken, or the doctor on leave, between propose and confirm: refused, nothing written", async () => {
    const asked = await ask(clerk.token, `${asha.uhid} ka appointment Dr Meera Rao parso`);
    const pick = pickOf(asked.body);
    const [first, second] = pick.rows[0]!.times;
    const other = await mkPatient(db, clerk.actor, { name: "Other Person", phone: "9876500003" });
    await http().post("/opd/appointments").set("Authorization", `Bearer ${clerk.token}`)
      .send({ patientId: other.id, doctorId: doctor.doctorId, slotStart: first!.at }).expect(201);

    const taken = await confirm(clerk.token, asked.body.proposals[first!.proposal]);
    expect(taken.body).toEqual({ outcome: "stateChanged", answer: { key: "copilot.answer.apptSlotTaken", params: {} } });
    expect(await appointments()).toHaveLength(1);

    await db.insert(opdDoctorLeaves).values({ id: newId(), doctorId: doctor.doctorId, fromDate: day, toDate: day, reason: "conference", createdBy: "t" });
    const leave = await confirm(clerk.token, asked.body.proposals[second!.proposal]);
    expect(leave.body).toEqual({ outcome: "stateChanged", answer: { key: "copilot.answer.apptDoctorOnLeave", params: {} } });
    expect(await appointments()).toHaveLength(1);
    expect(await acts()).toHaveLength(0);
  });

  it("done means 6: a booking question routes by the phrasebook — zero chooser or model calls", async () => {
    let calls = 0;
    const model: InferenceClient = { complete: () => { calls += 1; return Promise.reject(new Error("must not be called")); } } as unknown as InferenceClient;
    const chooser: ChoiceClient = { choose: () => { calls += 1; return Promise.reject(new Error("must not be called")); } };
    const { masked, slots } = maskQuestion(`Dr Singh kal 10 baje ${asha.uhid} ka appointment`, []);
    const routed = await routeQuestion(masked, slots, model, chooser);
    expect(routed).toMatchObject({ intent: "appointment_book", via: "phrasebook" });
    const moved = maskQuestion(`${asha.uhid} ka appointment kal pe shift karo`, []);
    expect(await routeQuestion(moved.masked, moved.slots, model, chooser)).toMatchObject({ intent: "appointment_move", via: "phrasebook" });
    expect(calls).toBe(0);
  });

  it("done means 7: without opd.appointments.manage, or with the act halt on, nothing is proposed or written", async () => {
    const refused = await ask(reader.token, `${asha.uhid} ka appointment Dr Meera Rao parso`);
    expect(refused.body).toMatchObject({ answer: { key: "copilot.answer.notPermitted" } });
    expect(refused.body.proposals).toBeUndefined();

    const before = await ask(clerk.token, `${asha.uhid} ka appointment Dr Meera Rao parso`);
    expect(before.body.proposals).toHaveLength(3);
    await http().post("/copilot/halt").set("Authorization", `Bearer ${owner.token}`).send({ scope: "act" }).expect((r) => expect(r.status).toBeLessThan(300));

    const halted = await ask(clerk.token, `${asha.uhid} ka appointment Dr Meera Rao parso`);
    expect(halted.body).toMatchObject({ answer: { key: "copilot.answer.paused" } });
    expect(halted.body.proposals).toBeUndefined();
    const late = await confirm(clerk.token, before.body.proposals[0]);
    expect(late.body).toMatchObject({ outcome: "halted" });

    // And a proposal confirmed by someone who has lost the permission is not theirs to confirm anyway.
    expect((await confirm(reader.token, before.body.proposals[1])).body.outcome).toBe("invalid");
    expect(await appointments()).toHaveLength(0);
    expect(await db.select().from(copilotActs).where(and(eq(copilotActs.resultModule, "opd"), inArray(copilotActs.tool, ["appointment_book", "appointment_move"])))).toHaveLength(0);
  });
});
