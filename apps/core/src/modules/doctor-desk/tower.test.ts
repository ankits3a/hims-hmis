import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedConfirmedUnits } from "../../../test/helpers/units";
import {
  alerts, doctorDeskBriefs, labAnalytes, opdPrescriptions, opdVitals, patientAllergies, phiAccessLog, labCriticalCalls, labResults, opdDepartments, opdDoctors,
  opdEncounters, opdQueueEntries, opdQueueSessions, orderItems, orders, patients, registrationConfig,
  rosterTeamMemberships, services, users,
} from "../../kernel/db/schema";
import { teamByCode } from "../roster";
import { towerView } from "./tower";
import { nudge } from "./nudge";
import { listBriefs, markBriefSeen } from "./briefs";
import { DoctorDeskError } from "./errors";
import { recordAct } from "./acts";
import { nextCard, opdDeskView, paceOf } from "./opd-desk";
import type { Db } from "../../kernel/db/client";

/**
 * DOCTOR DESK DD-0 (#626) — the Tower read, the nudge and the login brief, against the migrated
 * database. Every instant is passed in (`towerView(db, actor, at)`); nothing here reads the real clock.
 *
 * The cast: General Medicine Unit II's SR (the reader), JR and head; an Asst. Prof. in Unit I (the
 * outsider); a visiting consultant in no unit; a doctor who moves from Unit I to Unit II mid-month.
 */
describe("doctor-desk — the Tower (DD-0)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  const AT = new Date("2026-10-06T10:00:00+05:30"); // a Tuesday, mid-OPD
  const TODAY = "2026-10-06";
  const min = (n: number): Date => new Date(AT.getTime() + n * 60_000);
  const P = { SR: "", JR: "", HEAD: "", OUT: "", GUEST: "", MOVER: "" };
  const actor = (id: string): Actor => ({ type: "user", id });
  let U1 = "";
  let U2 = "";
  let clinic = "";
  let doctorOf: Record<string, string> = {};
  let patientA = "";
  let patientB = "";
  let serviceId = "";
  let analyteK = "";
  let seq = 0;

  async function person(key: keyof typeof P, name: string): Promise<string> {
    const id = newId();
    await db.insert(users).values({ id, username: `u-${key.toLowerCase()}`, fullName: name, staffCode: `EMP-${key}`, passwordHash: "x" });
    P[key] = id;
    return id;
  }
  const post = (userId: string, teamId: string, positionKey: string, grade: string, roleInTeam: string, startsAt: Date, endsAt: Date | null = null) => ({
    id: newId(), teamId, userId, positionKey, grade, roleInTeam, kind: "parent", startsAt, endsAt, createdBy: "t", updatedBy: "t",
  });

  async function encounter(doctorUserId: string, patientId: string, serviceDate: string, status: string): Promise<{ id: string; visitNo: string }> {
    seq += 1;
    const id = newId();
    const visitNo = `V${serviceDate.slice(2).replace(/-/g, "")}${String(seq).padStart(4, "0")}`;
    await db.insert(opdEncounters).values({
      id, visitNo, patientId, status, workflowInstanceId: newId(), departmentId: clinic, doctorId: doctorOf[doctorUserId]!,
      serviceDate, visitType: "new", openedBy: "t", updatedBy: "t",
      consultStartedAt: status === "registered" ? null : new Date(`${serviceDate}T10:00:00+05:30`),
    });
    return { id, visitNo };
  }

  /** A verified result on an order whose responsible clinician is `clinicianId`, optionally delta-flagged and with an open critical call. */
  async function labResult(clinicianId: string, patientId: string, encounterNo: string, o: { critical?: boolean; delta?: boolean; at?: Date; value?: string; restricted?: boolean; analyteId?: string; status?: "verified" | "autoverified"; prevId?: string } = {}): Promise<{ resultId: string; callId: string | null }> {
    const orderId = newId();
    const itemId = newId();
    const resultId = newId();
    seq += 1;
    await db.insert(orders).values({
      id: orderId, orderNo: `L${String(seq).padStart(8, "0")}`, orderGroupId: orderId, kind: "lab", patientId, encounterNo,
      serviceDate: TODAY, priority: "routine", authority: "clinician", orderedByType: "user", orderedById: clinicianId,
      orderingClinicianId: clinicianId, placedAt: min(-120),
    });
    await db.insert(orderItems).values({ id: itemId, orderId, serviceId, restricted: o.restricted === true });
    await db.insert(labResults).values({
      id: resultId, orderItemId: itemId, analyteId: o.analyteId ?? analyteK, valueNumeric: o.value ?? "6.4", unit: "mmol/L", flag: o.critical === true ? "HH" : "H",
      enteredByType: "user", enteredById: "t", entryMode: "manual", deltaFlag: o.delta === true, deltaPrevResultId: o.prevId ?? null,
      verificationStatus: o.status ?? "verified", verifiedBy: "t", verifiedAt: o.at ?? min(-30),
    });
    let callId: string | null = null;
    if (o.critical === true) {
      callId = newId();
      await db.insert(labCriticalCalls).values({ id: callId, resultId, openedBy: "t", openedAt: o.at ?? min(-30) });
    }
    return { resultId, callId };
  }

  beforeEach(async () => {
    await truncateAll(db);
    seq = 0;
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    clinic = newId();
    await db.insert(opdDepartments).values({ id: clinic, code: "MED", name: "General Medicine", createdBy: "t", updatedBy: "t" });
    await seedConfirmedUnits(db);
    U1 = (await teamByCode(db, "MED-U1"))!.id;
    U2 = (await teamByCode(db, "MED-U2"))!.id;
    await person("SR", "Dr. Senior Two");
    await person("JR", "Dr. Junior Two");
    await person("HEAD", "Dr. Head Two");
    await person("OUT", "Dr. Faculty One");
    await person("GUEST", "Dr. Visiting");
    await person("MOVER", "Dr. Mover");
    const since = new Date("2026-01-01T00:00:00+05:30");
    const moveAt = new Date("2026-10-10T00:00:00+05:30");
    await db.insert(rosterTeamMemberships).values([
      post(P.SR, U2, "unit_sr", "senior_resident", "senior_resident", since),
      post(P.JR, U2, "ward_jr", "jr1", "junior_resident", since),
      post(P.HEAD, U2, "unit_head", "professor", "head", since),
      post(P.OUT, U1, "faculty_on_call", "assistant_professor", "faculty", since),
      post(P.MOVER, U1, "unit_sr", "senior_resident", "senior_resident", since, moveAt),
      post(P.MOVER, U2, "unit_sr", "senior_resident", "senior_resident", moveAt),
    ]);
    doctorOf = {};
    for (const [i, id] of [P.SR, P.JR, P.HEAD, P.OUT, P.GUEST, P.MOVER].entries()) {
      const doctorId = newId();
      await db.insert(opdDoctors).values({ id: doctorId, userId: id, displayName: `Doctor ${String(i)}`, code: `DR-${String(i).padStart(4, "0")}`, departmentId: clinic, createdBy: "t", updatedBy: "t" });
      doctorOf[id] = doctorId;
    }
    patientA = newId();
    patientB = newId();
    await db.insert(patients).values([
      { id: patientA, uhid: "HMS-00000001-5", name: "Patient Alpha", sex: "female", administrativeGender: "female", createdBy: "t", updatedBy: "t" },
      { id: patientB, uhid: "HMS-00000002-3", name: "Patient Beta", sex: "male", administrativeGender: "male", createdBy: "t", updatedBy: "t" },
    ]);
    serviceId = newId();
    await db.insert(services).values({ id: serviceId, code: "ELEC", name: "Electrolytes", category: "investigation", createdBy: "t", updatedBy: "t" });
    analyteK = newId();
    await db.insert(labAnalytes).values({ id: analyteK, code: "K", nameEn: "Potassium", resultType: "numeric", unit: "mmol/L", createdBy: "t", updatedBy: "t" });
  });

  it("a lab critical on my order is a Critical row with its source; a read-back keeps it amber; the act drops it (DD-1.3, D3)", async () => {
    const v = await encounter(P.SR, patientA, TODAY, "in_consultation");
    const { resultId, callId } = await labResult(P.SR, patientA, v.visitNo, { critical: true });
    const t = await towerView(db, actor(P.SR), AT);
    expect(t.attention).toHaveLength(1);
    expect(t.attention[0]).toMatchObject({
      kind: "lab_critical", tab: "critical", goneHome: false, href: `/patients/${patientA}`,
      source: { module: "lab", ref: resultId }, params: { analyte: "Potassium", unit: "mmol/L" },
      patient: { id: patientA, name: "Patient Alpha" },
    });
    expect(t.tabCounts).toEqual({ all: 1, critical: 1, change: 0, new: 0, pending: 0 });
    await db.update(labCriticalCalls).set({ closedAt: min(1), closedBy: "t", readbackText: "read back" }).where(eq(labCriticalCalls.id, callId!));
    // DD-1.3 (plan E20, D3): the lab's read-back is an acknowledgement, not the act — the row stays, amber.
    expect((await towerView(db, actor(P.SR), min(2))).attention).toMatchObject([{ kind: "lab_critical", acked: true }]);
    await recordAct(db, actor(P.SR), `lab_critical:${callId!}`, "repeat_sample_sent", null, min(3));
    expect((await towerView(db, actor(P.SR), min(4))).attention).toHaveLength(0);
  });

  it("a critical on a visit that is over says the patient has gone home", async () => {
    const v = await encounter(P.SR, patientA, "2026-10-03", "completed");
    await labResult(P.SR, patientA, v.visitNo, { critical: true });
    expect((await towerView(db, actor(P.SR), AT)).attention[0]).toMatchObject({ kind: "lab_critical", goneHome: true });
  });

  it("a delta-flagged result is Clinical change; an unfinished visit from an earlier day is a paper to sign", async () => {
    const v = await encounter(P.SR, patientB, "2026-10-05", "in_consultation");
    await labResult(P.SR, patientB, v.visitNo, { delta: true, value: "5.6" });
    await labResult(P.SR, patientB, v.visitNo, { delta: true, at: min(-60 * 30) }); // 30 h ago: outside the window
    const t = await towerView(db, actor(P.SR), AT);
    expect(t.attention.map((r) => r.kind)).toEqual(["lab_delta", "visit_open"]);
    expect(t.attention[1]).toMatchObject({ tab: "pending", href: `/opd/consult/${v.id}`, params: { date: "2026-10-05" } });
    expect(t.tabCounts).toEqual({ all: 2, critical: 0, change: 1, new: 0, pending: 1 });
    expect(t.tiles).toMatchObject({ papersToSign: 1, resultsToReview: 1 });
  });

  it("the OPD tiles equal the queue; without a session they are absent, not zero", async () => {
    expect((await towerView(db, actor(P.SR), AT)).tiles).toMatchObject({ booked: null, seen: null, waiting: null });
    const sessionId = newId();
    await db.insert(opdQueueSessions).values({ id: sessionId, doctorId: doctorOf[P.SR]!, serviceDate: TODAY, status: "in" });
    const rows: [string, Date | null][] = [["done", null], ["waiting", min(-41)], ["waiting", min(-8)], ["cancelled", null]];
    for (const [i, [status, eligibleAt]] of rows.entries()) {
      const e = await encounter(P.SR, i % 2 === 0 ? patientA : patientB, TODAY, "waiting");
      await db.insert(opdQueueEntries).values({ id: newId(), seq: i + 1, sessionId, encounterId: e.id, tokenNo: i + 1, kind: "walk_in", status, eligibleAt });
    }
    const t = await towerView(db, actor(P.SR), AT);
    expect(t.mode).toBe("opd_day");
    expect(t.tiles).toMatchObject({ booked: 3, seen: 1, waiting: 2, longestWaitMinutes: 41 });
    expect(t.schedule).toContainEqual({ kind: "opd", session: "in", booked: 3, waiting: 2 });
    // The unit's OPD today: the reader is a unit member with a session.
    expect(t.unitOverview.map((l) => [l.userId, l.booked])).toEqual([[P.SR, 3]]);
  });

  it("the unit is read at read time: a doctor who moved mid-month counts to the old unit for old days; no unit is own scope", async () => {
    expect((await towerView(db, actor(P.MOVER), AT)).unit?.teamId).toBe(U1);
    expect((await towerView(db, actor(P.MOVER), new Date("2026-10-12T10:00:00+05:30"))).unit?.teamId).toBe(U2);
    const guest = await towerView(db, actor(P.GUEST), AT);
    expect(guest.unit).toBeNull();
    expect(guest.team).toEqual([]);
    expect(guest.clocks).toEqual([]);
  });

  it("Clocks Running shows what the unit owes, who holds it, and the server's clock", async () => {
    const v = await encounter(P.JR, patientA, TODAY, "in_consultation");
    await labResult(P.JR, patientA, v.visitNo, { critical: true, at: min(-20) });
    await labResult(P.OUT, patientA, v.visitNo, { critical: true }); // Unit I's — not ours
    const t = await towerView(db, actor(P.SR), AT);
    expect(t.clocks).toHaveLength(1);
    expect(t.clocks[0]).toMatchObject({ kind: "lab_critical", holder: { userId: P.JR, name: "Dr. Junior Two" }, nudgedByMe: false });
    expect(t.clocks[0]!.dueAt).toBe(min(-5).toISOString()); // opened 20 min ago, due in 15 → 5 min over
    expect(t.team.find((m) => m.userId === P.JR)?.holds).toBe(1);
    expect(t.team.find((m) => m.userId === P.HEAD)).toMatchObject({ role: "head", holds: 0 });
  });

  it("a nudge is once per row per sender, from a unit member, never to oneself — and the bell names no patient", async () => {
    const v = await encounter(P.JR, patientA, TODAY, "in_consultation");
    await labResult(P.JR, patientA, v.visitNo, { critical: true });
    const key = (await towerView(db, actor(P.SR), AT)).clocks[0]!.key;
    const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: unknown) => (e instanceof DoctorDeskError ? e.code : String(e)));

    expect(await code(nudge(db, actor(P.SR), key, AT))).toBe("ok");
    expect(await code(nudge(db, actor(P.SR), key, min(1)))).toBe("already_nudged");
    // Another unit's member: the row is not owed by THEIR unit, so it does not exist for them.
    expect(await code(nudge(db, actor(P.OUT), key, AT))).toBe("unknown_row");
    expect(await code(nudge(db, actor(P.GUEST), key, AT))).toBe("not_unit_member");
    expect(await code(nudge(db, actor(P.JR), key, AT))).toBe("own_row");
    expect(await code(nudge(db, actor(P.HEAD), "lab_critical:NOPE", AT))).toBe("unknown_row");
    expect(await code(nudge(db, actor(P.HEAD), key, AT))).toBe("ok"); // a second sender may

    const bell = await db.select().from(alerts).where(and(eq(alerts.userId, P.JR), eq(alerts.kind, "doctor_desk_nudge")));
    expect(bell).toHaveLength(2);
    expect(bell.map((b) => b.title).sort()).toEqual(["Nudge from Dr. Head Two", "Nudge from Dr. Senior Two"]);
    for (const b of bell) expect(`${b.title} ${b.body ?? ""}`).not.toMatch(/Patient|Alpha|HMS-|Potassium|6\.4/);
    expect((await towerView(db, actor(P.SR), min(2))).clocks[0]!.nudgedByMe).toBe(true);
  });

  it("the login brief: none on a first read; built on a return; highlighted 5 min, on the Tower 60 min, then only on AI Briefs", async () => {
    const first = await towerView(db, actor(P.SR), AT);
    expect(first.brief).toBeNull();
    // A read 2 h later is not a return (under the 3 h gap): no brief.
    expect((await towerView(db, actor(P.SR), min(120))).brief).toBeNull();
    // Away, then a critical arrives while away, then the doctor returns 4 hours after that read.
    const v = await encounter(P.SR, patientA, TODAY, "in_consultation");
    await labResult(P.SR, patientA, v.visitNo, { critical: true, at: min(200) });
    const back = min(360);
    const t = await towerView(db, actor(P.SR), back);
    expect(t.brief).not.toBeNull();
    expect(t.brief!.stage).toBe("highlight");
    expect(t.brief!.windowFrom).toBe(min(120).toISOString());
    expect(t.brief!.facts[0]).toMatchObject({ key: "brief.lab_critical", source: { module: "lab" }, patient: { name: "Patient Alpha" } });
    expect(t.agentRuns[0]).toMatchObject({ agent: "login_brief", outcome: "ok" });

    const at = (m: number): Date => new Date(back.getTime() + m * 60_000);
    expect((await towerView(db, actor(P.SR), at(4))).brief?.stage).toBe("highlight");
    expect((await towerView(db, actor(P.SR), at(6))).brief?.stage).toBe("quiet");
    expect((await towerView(db, actor(P.SR), at(59))).brief?.stage).toBe("quiet");
    const gone = await towerView(db, actor(P.SR), at(61));
    expect(gone.brief).toBeNull();
    expect(gone.briefsWaiting).toBe(1);
    const all = await listBriefs(db, actor(P.SR), at(61));
    expect(all.map((b) => b.stage)).toEqual(["archived"]);
  });

  it("Got it un-highlights at once; a quiet spell is still a brief, and kept", async () => {
    await towerView(db, actor(P.SR), AT);
    const t = await towerView(db, actor(P.SR), min(200));
    expect(t.brief).toMatchObject({ stage: "highlight", facts: [] });
    await markBriefSeen(db, actor(P.SR), t.brief!.id, min(201));
    expect((await towerView(db, actor(P.SR), min(202))).brief?.stage).toBe("quiet");
    expect(await markBriefSeen(db, actor(P.JR), t.brief!.id, min(202)).then(() => "ok", (e: unknown) => (e as DoctorDeskError).code)).toBe("unknown_brief");
    expect(await db.select().from(doctorDeskBriefs)).toHaveLength(1);
  });

  it("carries no money: no fee, paid, price or payer word anywhere in the Tower", async () => {
    const sessionId = newId();
    await db.insert(opdQueueSessions).values({ id: sessionId, doctorId: doctorOf[P.SR]!, serviceDate: TODAY, status: "in" });
    const e = await encounter(P.SR, patientA, TODAY, "waiting");
    await db.update(opdEncounters).set({ feeBypassReason: "desk let through", feeBypassBy: "t", feeBypassAt: AT, intendedPayer: "pmjay" }).where(eq(opdEncounters.id, e.id));
    await db.insert(opdQueueEntries).values({ id: newId(), seq: 1, sessionId, encounterId: e.id, tokenNo: 1, kind: "walk_in", status: "waiting", eligibleAt: min(-5) });
    await towerView(db, actor(P.SR), min(-200));
    const t = await towerView(db, actor(P.SR), AT);
    expect(t.brief).not.toBeNull();
    expect(JSON.stringify(t)).not.toMatch(/fee|paid|paise|price|bypass|payer|pmjay|₹|rupee|invoice|bill/i);
  });

  /* ═══ DD-0.8 — the OPD desk ═══ */

  it("the OPD desk's pace is the queue's facts divided; colleagues are the unit's other doctors in OPD; Waiting on you is OPD-only", async () => {
    const sessionId = newId();
    await db.insert(opdQueueSessions).values({ id: sessionId, doctorId: doctorOf[P.SR]!, serviceDate: TODAY, status: "in" });
    const rows: [string, Date | null, Date | null][] = [["done", null, min(-60)], ["done", null, min(-30)], ["waiting", min(-20), null], ["waiting", min(-5), null]];
    for (const [i, [status, eligibleAt, startedAt]] of rows.entries()) {
      const e = await encounter(P.SR, patientA, TODAY, status === "done" ? "completed" : "waiting");
      if (startedAt !== null) await db.update(opdEncounters).set({ consultStartedAt: startedAt }).where(eq(opdEncounters.id, e.id));
      await db.insert(opdQueueEntries).values({ id: newId(), seq: i + 1, sessionId, encounterId: e.id, tokenNo: i + 1, kind: "walk_in", status, eligibleAt });
    }
    const jrSession = newId();
    await db.insert(opdQueueSessions).values({ id: jrSession, doctorId: doctorOf[P.JR]!, serviceDate: TODAY, status: "in" });
    const old = await encounter(P.SR, patientB, "2026-10-05", "in_consultation");
    await labResult(P.SR, patientB, old.visitNo, { delta: true });

    const d = await opdDeskView(db, actor(P.SR), AT);
    expect(d.line).toMatchObject({ booked: 4, seen: 2, waiting: 2 });
    expect(d.pace).toEqual({ seen: 2, sinceMinutes: 60, eachMinutes: 30, endsAt: min(60).toISOString() });
    expect(d.colleagues.map((c) => c.userId)).toEqual([P.JR]);
    expect(d.waitingOn.map((r) => r.kind)).toEqual(["visit_open"]); // the delta is the NEXT card's, not this list's
    expect(JSON.stringify(d)).not.toMatch(/\bfees?\b|\bpaid\b|paise|price|bypass|payer|₹|invoice|\bbill/i);
  });

  it("pace says nothing it cannot know: no start, no 'each'; nobody waiting, no end", () => {
    expect(paceOf(0, null, 3, AT)).toEqual({ seen: 0, sinceMinutes: null, eachMinutes: null, endsAt: null });
    expect(paceOf(0, min(-10), 3, AT)).toEqual({ seen: 0, sinceMinutes: 10, eachMinutes: null, endsAt: null });
    expect(paceOf(4, min(-40), 0, AT)).toEqual({ seen: 4, sinceMinutes: 40, eachMinutes: 10, endsAt: null });
  });

  it("the NEXT card: the desk's words, today's vitals, allergies, results since I last saw them and my last prescription — and a PHI row", async () => {
    const before = await encounter(P.SR, patientA, "2026-09-20", "completed");
    await db.insert(opdPrescriptions).values({
      id: newId(), encounterId: before.id, patientId: patientA, doctorId: doctorOf[P.SR]!, version: 1,
      lines: [{ drug: "Metformin 1 g", dose: "1 tab", route: "oral", frequency: "twice a day", durationDays: 30, instructions: null, noSubstitution: false }],
      document: {}, allergyOverrides: [], issuedBy: P.SR, issuedAt: new Date("2026-09-20T11:00:00+05:30"),
    });
    const v = await encounter(P.SR, patientA, TODAY, "waiting");
    await db.update(opdEncounters).set({ deskComplaint: "Tingling in the feet, two weeks", deskComplaintBy: P.HEAD, deskComplaintAt: min(-40) }).where(eq(opdEncounters.id, v.id));
    await db.insert(opdVitals).values({ id: newId(), encounterId: v.id, patientId: patientA, sbp: 148, dbp: 92, pulse: 84, band: "adult", dangerFlags: [], recordedBy: P.JR, recordedAt: min(-20) });
    await db.insert(patientAllergies).values({ id: newId(), patientId: patientA, substance: "Sulfa", source: "consult", recordedBy: "t" });
    await labResult(P.OUT, patientA, before.visitNo, { at: new Date("2026-10-01T10:00:00+05:30"), value: "8.9" });

    const c = await nextCard(db, actor(P.SR), v.id, AT);
    expect(c).toMatchObject({
      encounterId: v.id, ordinal: 2, lastSeen: "2026-09-20", allergies: ["Sulfa"],
      patient: { id: patientA, name: "Patient Alpha" },
      complaint: { text: "Tingling in the feet, two weeks", byName: "Dr. Head Two" },
      vitals: { sbp: 148, dbp: 92, pulse: 84, today: true, byName: "Dr. Junior Two" },
      lastRx: { lines: [{ drug: "Metformin 1 g", dose: "1 tab", frequency: "twice a day" }] },
    });
    expect(c.since.map((s) => [s.analyte, s.value])).toEqual([["Potassium", "8.9000"]]);
    expect(await db.select().from(phiAccessLog).where(and(eq(phiAccessLog.patientId, patientA), eq(phiAccessLog.surface, "doctor_desk.next")))).toHaveLength(1);
    expect(JSON.stringify(c)).not.toMatch(/\bfees?\b|\bpaid\b|paise|price|bypass|payer|₹|invoice|\bbill/i);
  });

  it("another doctor's visit is not on my OPD desk", async () => {
    const v = await encounter(P.JR, patientA, TODAY, "waiting");
    const got = await nextCard(db, actor(P.SR), v.id, AT).then(() => "ok", (e: unknown) => (e instanceof DoctorDeskError ? e.code : String(e)));
    expect(got).toBe("unknown_visit");
  });

  it("the NEXT card follows the lab's restricted-test rule: another doctor's restricted test is absent, my own is shown", async () => {
    const before = await encounter(P.SR, patientA, "2026-09-20", "completed");
    const v = await encounter(P.SR, patientA, TODAY, "waiting");
    const hiv = newId();
    await db.insert(labAnalytes).values({ id: hiv, code: "HIV", nameEn: "HIV 1/2 antibody", resultType: "numeric", createdBy: "t", updatedBy: "t" });
    await labResult(P.OUT, patientA, before.visitNo, { at: new Date("2026-10-01T10:00:00+05:30"), restricted: true, analyteId: hiv, value: "1" });
    expect((await nextCard(db, actor(P.SR), v.id, AT)).since.map((s) => s.analyte)).toEqual([]);
    await labResult(P.SR, patientA, before.visitNo, { at: new Date("2026-10-02T10:00:00+05:30"), restricted: true, analyteId: hiv, value: "1" });
    expect((await nextCard(db, actor(P.SR), v.id, AT)).since.map((s) => s.analyte)).toEqual(["HIV 1/2 antibody"]);
  });

  it("the NEXT card reads only verified results — not autoverified ones, as the doctor's results reader", async () => {
    const before = await encounter(P.SR, patientA, "2026-09-20", "completed");
    const v = await encounter(P.SR, patientA, TODAY, "waiting");
    await labResult(P.SR, patientA, before.visitNo, { at: new Date("2026-10-01T10:00:00+05:30"), status: "autoverified" });
    expect((await nextCard(db, actor(P.SR), v.id, AT)).since).toEqual([]);
  });

  it("a confidential patient on the NEXT card shows the alias, with no age and no sex", async () => {
    await db.update(patients).set({ isConfidential: true, alias: "Patient X-7", dob: new Date("1970-01-01") }).where(eq(patients.id, patientA));
    const v = await encounter(P.SR, patientA, TODAY, "waiting");
    const c = await nextCard(db, actor(P.SR), v.id, AT);
    expect(c.patient).toMatchObject({ name: "Patient X-7", restricted: true, ageYears: null, sex: null });
    expect(JSON.stringify(c)).not.toContain("Patient Alpha");
  });

  it("the NEXT card follows a merged patient's earlier records", async () => {
    const before = await encounter(P.SR, patientB, "2026-09-20", "completed");
    await labResult(P.SR, patientB, before.visitNo, { at: new Date("2026-10-01T10:00:00+05:30"), value: "7.1" });
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: patientA }).where(eq(patients.id, patientB));
    const v = await encounter(P.SR, patientA, TODAY, "waiting");
    const c = await nextCard(db, actor(P.SR), v.id, AT);
    expect(c.ordinal).toBe(2);
    expect(c.since.map((s) => s.value)).toEqual(["7.1000"]);
  });

  it("the Tower's Clinical change reads only verified results, as the doctor's results reader", async () => {
    const v = await encounter(P.SR, patientB, TODAY, "in_consultation");
    await labResult(P.SR, patientB, v.visitNo, { delta: true, status: "autoverified" });
    expect((await towerView(db, actor(P.SR), AT)).attention.filter((r) => r.kind === "lab_delta")).toEqual([]);
  });

  it("the NEXT card's earlier value follows the restricted-test rule too", async () => {
    const before = await encounter(P.SR, patientA, "2026-09-20", "completed");
    const v = await encounter(P.SR, patientA, TODAY, "waiting");
    const hiv = newId();
    await db.insert(labAnalytes).values({ id: hiv, code: "HIVL", nameEn: "HIV viral load", resultType: "numeric", createdBy: "t", updatedBy: "t" });
    const old = await labResult(P.OUT, patientA, before.visitNo, { at: new Date("2026-09-01T10:00:00+05:30"), restricted: true, analyteId: hiv, value: "900" });
    await labResult(P.SR, patientA, before.visitNo, { at: new Date("2026-10-01T10:00:00+05:30"), analyteId: hiv, value: "40", prevId: old.resultId });
    const row = (await nextCard(db, actor(P.SR), v.id, AT)).since.find((s) => s.analyte === "HIV viral load");
    expect(row).toMatchObject({ value: "40.0000", previous: null });
    // My own earlier value is mine to see.
    const own = await labResult(P.SR, patientA, before.visitNo, { at: new Date("2026-09-25T10:00:00+05:30"), restricted: true, analyteId: hiv, value: "300" });
    await labResult(P.SR, patientA, before.visitNo, { at: new Date("2026-10-03T10:00:00+05:30"), analyteId: hiv, value: "20", prevId: own.resultId });
    expect((await nextCard(db, actor(P.SR), v.id, AT)).since.find((s) => s.analyte === "HIV viral load")).toMatchObject({ value: "20.0000", previous: "300.0000" });
  });
});
