import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedConfirmedUnits } from "../../../test/helpers/units";
import {
  alerts, approvalTypes, approvals, doctorDeskActs, doctorDeskMoves, doctorDeskRatings, events, labAnalytes, workflowDefinitions, workflowInstances, labCriticalCalls, labResults, opdDepartments,
  opdDoctors, opdEncounters, orderItems, orders, patients, registrationConfig, roleAssignments, roles, rosterOfficiating,
  rosterTeamMemberships, services, users,
} from "../../kernel/db/schema";
import { countingUnits, orgDepartmentByCode, teamByCode } from "../roster";
import { departmentHeads, deskLevel, deskScope } from "./scope";
import { unitBoard } from "./unit-board";
import { moveRow } from "./moves";
import { recordAct } from "./acts";
import { nowView, professorView } from "./phone";
import { logbookCsv, myRatings, rateWork } from "./ratings";
import { towerView } from "./tower";
import { owedByUnit } from "./owed";
import { DoctorDeskError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * DOCTOR DESK DD-1 — the unit and the ladder (spec /opt/hmis-context/SPEC-doctor-desk-dd1-2026-10-16.md,
 * done-means DM1–DM8), against the migrated database. Every instant is passed in.
 *
 * The cast, General Medicine Unit II: the head (professor), an assistant professor (faculty), an SR, a
 * JR and an intern; Unit I: an outsider. A medical superintendent; an HOD by officiating row.
 */
describe("doctor-desk — DD-1 the unit and the ladder", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  const AT = new Date("2026-10-06T10:00:00+05:30");
  const TODAY = "2026-10-06";
  const min = (n: number): Date => new Date(AT.getTime() + n * 60_000);
  const P = { HEAD: "", FAC: "", SR: "", JR: "", INT: "", OUT: "", MS: "", HOD: "" };
  const actor = (id: string): Actor => ({ type: "user", id });
  const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: unknown) => (e instanceof DoctorDeskError ? e.code : String(e)));
  let U1 = "";
  let U2 = "";
  let clinic = "";
  let doctorOf: Record<string, string> = {};
  let patientA = "";
  let serviceId = "";
  let analyteK = "";
  let seq = 0;

  const post = (userId: string, teamId: string, positionKey: string, grade: string, roleInTeam: string) => ({
    id: newId(), teamId, userId, positionKey, grade, roleInTeam, kind: "parent", startsAt: new Date("2026-01-01T00:00:00+05:30"), createdBy: "t", updatedBy: "t",
  });

  async function encounter(doctorUserId: string, serviceDate: string, status: string): Promise<{ id: string; visitNo: string }> {
    seq += 1;
    const id = newId();
    const visitNo = `V${serviceDate.slice(2).replace(/-/g, "")}${String(seq).padStart(4, "0")}`;
    await db.insert(opdEncounters).values({
      id, visitNo, patientId: patientA, status, workflowInstanceId: newId(), departmentId: clinic, doctorId: doctorOf[doctorUserId]!,
      serviceDate, visitType: "new", openedBy: "t", updatedBy: "t",
      consultStartedAt: new Date(`${serviceDate}T10:00:00+05:30`),
      consultCompletedAt: status === "completed" ? new Date(`${serviceDate}T10:20:00+05:30`) : null,
    });
    return { id, visitNo };
  }

  /** A lab critical on an order whose responsible clinician is `clinicianId`; returns the owed row key. */
  async function critical(clinicianId: string, o: { at?: Date; restricted?: boolean } = {}): Promise<{ key: string; callId: string }> {
    seq += 1;
    const orderId = newId(); const itemId = newId(); const resultId = newId(); const callId = newId();
    await db.insert(orders).values({
      id: orderId, orderNo: `L${String(seq).padStart(8, "0")}`, orderGroupId: orderId, kind: "lab", patientId: patientA, encounterNo: `V${String(seq)}`,
      serviceDate: TODAY, priority: "routine", authority: "clinician", orderedByType: "user", orderedById: clinicianId,
      orderingClinicianId: clinicianId, placedAt: min(-120),
    });
    await db.insert(orderItems).values({ id: itemId, orderId, serviceId, restricted: o.restricted === true });
    await db.insert(labResults).values({
      id: resultId, orderItemId: itemId, analyteId: analyteK, valueNumeric: "6.4", unit: "mmol/L", flag: "HH",
      enteredByType: "user", enteredById: "t", entryMode: "manual", verificationStatus: "verified", verifiedBy: "t", verifiedAt: o.at ?? min(-30),
    });
    await db.insert(labCriticalCalls).values({ id: callId, resultId, openedBy: "t", openedAt: o.at ?? min(-30) });
    return { key: `lab_critical:${callId}`, callId };
  }
  const readBack = (callId: string, at: Date) =>
    db.update(labCriticalCalls).set({ closedAt: at, closedBy: "t", readbackText: "read back" }).where(eq(labCriticalCalls.id, callId));

  beforeEach(async () => {
    await truncateAll(db);
    seq = 0;
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    clinic = newId();
    await db.insert(opdDepartments).values({ id: clinic, code: "MED", name: "General Medicine", createdBy: "t", updatedBy: "t" });
    await seedConfirmedUnits(db);
    U1 = (await teamByCode(db, "MED-U1"))!.id;
    U2 = (await teamByCode(db, "MED-U2"))!.id;
    const names: Record<keyof typeof P, string> = {
      HEAD: "Dr. Head Two", FAC: "Dr. Faculty Two", SR: "Dr. Senior Two", JR: "Dr. Junior Two", INT: "Dr. Intern Two",
      OUT: "Dr. Faculty One", MS: "Dr. Superintendent", HOD: "Dr. Department Head",
    };
    for (const k of Object.keys(P) as (keyof typeof P)[]) {
      const id = newId();
      await db.insert(users).values({ id, username: `u-${k.toLowerCase()}`, fullName: names[k], staffCode: `EMP-${k}`, passwordHash: "x" });
      P[k] = id;
    }
    await db.insert(rosterTeamMemberships).values([
      post(P.HEAD, U2, "unit_head", "professor", "head"),
      post(P.FAC, U2, "faculty_on_call", "assistant_professor", "faculty"),
      post(P.SR, U2, "unit_sr", "senior_resident", "senior_resident"),
      post(P.JR, U2, "ward_jr", "jr1", "junior_resident"),
      post(P.INT, U2, "intern", "intern", "intern"),
      post(P.OUT, U1, "faculty_on_call", "assistant_professor", "faculty"),
      post(P.HOD, U1, "unit_head", "professor", "head"),
    ]);
    doctorOf = {};
    for (const [i, id] of [P.HEAD, P.FAC, P.SR, P.JR, P.INT, P.OUT].entries()) {
      const doctorId = newId();
      await db.insert(opdDoctors).values({ id: doctorId, userId: id, displayName: `Doctor ${String(i)}`, code: `DR-${String(i).padStart(4, "0")}`, departmentId: clinic, createdBy: "t", updatedBy: "t" });
      doctorOf[id] = doctorId;
    }
    patientA = newId();
    await db.insert(patients).values({ id: patientA, uhid: "HMS-00000001-5", name: "Patient Alpha", sex: "female", administrativeGender: "female", createdBy: "t", updatedBy: "t" });
    serviceId = newId();
    await db.insert(services).values({ id: serviceId, code: "ELEC", name: "Electrolytes", category: "investigation", createdBy: "t", updatedBy: "t" });
    analyteK = newId();
    await db.insert(labAnalytes).values({ id: analyteK, code: "K", nameEn: "Potassium", resultType: "numeric", unit: "mmol/L", createdBy: "t", updatedBy: "t" });
  });

  /* ═══ DM1 — the scope is derived, never chosen ═══ */

  it("DM1 an officiating head has the unit's scope only inside the window; the MS reads the hospital; a HOD the department", async () => {
    await db.insert(rosterOfficiating).values({
      id: newId(), teamId: U2, userId: P.FAC, role: "head", startsAt: min(-60 * 24), endsAt: min(60 * 24), reason: "head on leave",
      approvedBy: P.HEAD, createdBy: "t", updatedBy: "t",
    });
    const lv = async (id: string, at: Date) => (await deskLevel(db, actor(id), await deskScope(db, actor(id), at), at));
    expect(await lv(P.FAC, AT)).toMatchObject({ level: "unit", officiating: true });
    expect((await lv(P.FAC, min(60 * 48))).level).toBe("member");
    expect((await lv(P.SR, AT)).level).toBe("member");
    expect((await lv(P.HEAD, min(60 * 48))).level).toBe("unit");

    await db.insert(roles).values({ key: "medical_superintendent", title: "MS" }).onConflictDoNothing();
    await db.insert(roleAssignments).values({ id: newId(), userId: P.MS, roleKey: "medical_superintendent", scopeType: "hospital" });
    expect((await lv(P.MS, AT)).level).toBe("hospital");
    const ms = await unitBoard(db, actor(P.MS), AT);
    expect(ms.units.length).toBe((await countingUnits(db, AT)).length);

    const med = (await orgDepartmentByCode(db, "MED"))!;
    await db.insert(rosterOfficiating).values({
      id: newId(), teamId: U1, userId: P.HOD, role: "hod", startsAt: min(-60), endsAt: min(60), reason: "HOD on leave",
      approvedBy: P.MS, createdBy: "t", updatedBy: "t",
    });
    expect(await lv(P.HOD, AT)).toMatchObject({ level: "department", departmentId: med.id });
    const hod = await unitBoard(db, actor(P.HOD), AT);
    expect(hod.units.map((u) => u.departmentName)).toEqual(hod.units.map(() => "General Medicine"));
    expect(hod.units.map((u) => u.teamId)).toEqual(expect.arrayContaining([U1, U2]));
    expect(JSON.stringify(hod.units)).not.toMatch(/Dr\.|Patient/);
    expect((await lv(P.HOD, min(120))).level).toBe("unit");
  });

  /* ═══ DM2 — the unit board's horizon and order ═══ */

  it("DM2 your people: a JR sees her own row, the SR sees the JRs and interns, the head sees the unit; owed is oldest first", async () => {
    await critical(P.JR, { at: min(-10) });
    await critical(P.SR, { at: min(-50) });
    const ids = async (id: string) => (await unitBoard(db, actor(id), AT)).people.map((p) => p.userId).sort();
    expect(await ids(P.JR)).toEqual([P.JR]);
    expect(await ids(P.SR)).toEqual([P.SR, P.JR, P.INT].sort());
    expect(await ids(P.HEAD)).toEqual([P.HEAD, P.FAC, P.SR, P.JR, P.INT].sort());
    const head = await unitBoard(db, actor(P.HEAD), AT);
    expect(head.owed.map((r) => r.holder.userId)).toEqual([P.SR, P.JR]);
    expect(head.people.find((p) => p.userId === P.JR)).toMatchObject({ open: 1, visitsDone: 0, criticalToActMedian: null });
    expect(head.units).toEqual([]);
  });

  /* ═══ DM3 — Move ═══ */

  it("DM3 a JR may not move; a non-member is refused; a move writes one row, one event, one bell, and the next read shows the new holder", async () => {
    const { key } = await critical(P.JR);
    expect(await code(moveRow(db, actor(P.JR), key, P.SR, AT))).toBe("not_allowed_to_move");
    expect(await code(moveRow(db, actor(P.HEAD), key, P.OUT, AT))).toBe("not_unit_member");
    expect(await code(moveRow(db, actor(P.HOD), key, P.SR, AT))).toBe("not_unit_member");
    expect(await code(moveRow(db, actor(P.HEAD), key, P.JR, AT))).toBe("same_holder");
    const { moveId } = await moveRow(db, actor(P.HEAD), key, P.SR, AT);
    expect(await db.select().from(doctorDeskMoves)).toHaveLength(1);
    const ev = await db.select().from(events).where(eq(events.name, "doctor_desk.row_moved"));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toEqual({ moveId, rowKey: key, teamId: U2, fromUserId: P.JR, toUserId: P.SR });
    const bell = await db.select().from(alerts).where(eq(alerts.kind, "doctor_desk_move"));
    expect(bell).toHaveLength(1);
    expect(bell[0]!.userId).toBe(P.SR);
    expect(`${bell[0]!.title} ${bell[0]!.body ?? ""}`).not.toMatch(/Patient Alpha|HMS-|Potassium|6\.4/);
    const after = await unitBoard(db, actor(P.HEAD), min(1));
    expect(after.owed[0]).toMatchObject({ key, holder: { userId: P.SR }, movedBy: { userId: P.HEAD }, mayMove: true });
    expect(after.moveTo.map((m) => m.userId)).toContain(P.SR);
    expect((await unitBoard(db, actor(P.JR), min(1))).moveTo).toEqual([]);
    // the source row is untouched: the critical is still the JR's order, still open
    expect((await db.select().from(labCriticalCalls))[0]!.closedAt).toBeNull();
  });

  /* ═══ DM4 — the act closes the loop ═══ */

  it("DM4 a critical read back with no act stays (amber); an act removes it; a second act is refused; critical→act is act − open", async () => {
    const { key, callId } = await critical(P.JR, { at: min(-12) });
    await readBack(callId, min(-6));
    const jrTower = await towerView(db, actor(P.JR), AT);
    expect(jrTower.attention).toHaveLength(1);
    expect(jrTower.attention[0]).toMatchObject({ key, kind: "lab_critical", acked: true });
    expect((await owedByUnit(db, [{ userId: P.JR, name: "" }], AT))[0]).toMatchObject({ key, acked: true });
    expect(await code(recordAct(db, actor(P.SR), key, "other", "  ", AT))).toBe("note_required");
    expect(await code(recordAct(db, actor(P.OUT), key, "treatment_started", null, AT))).toBe("unknown_row");
    const r = await recordAct(db, actor(P.SR), key, "treatment_started", null, AT);
    expect(r.minutes).toBe(12);
    expect(await code(recordAct(db, actor(P.JR), key, "ecg_ordered", null, min(1)))).toBe("already_acted");
    expect((await towerView(db, actor(P.JR), min(1))).attention).toHaveLength(0);
    expect(await owedByUnit(db, [{ userId: P.JR, name: "" }], min(1))).toHaveLength(0);
    const board = await unitBoard(db, actor(P.HEAD), min(1));
    expect(board.people.find((p) => p.userId === P.SR)).toMatchObject({ criticalToActMedian: 12, criticalActs: 1 });
    const prof = await professorView(db, actor(P.HEAD), min(1));
    expect(prof.handled).toEqual([expect.objectContaining({ key, by: { userId: P.SR, name: "Dr. Senior Two" }, choice: "treatment_started", minutes: 12, analyte: "Potassium" })]);
    expect((await db.select().from(doctorDeskActs))[0]).toMatchObject({ holderId: P.JR, actorId: P.SR, teamId: U2 });
  });

  it("DM4 an open critical is red on the SR phone's NOW; unread work is TODAY", async () => {
    const { key } = await critical(P.SR);
    await encounter(P.SR, "2026-10-05", "in_consultation");
    const now = await nowView(db, actor(P.SR), AT);
    expect(now.now.map((r) => r.key)).toEqual([key]);
    expect(now.now[0]!.acked).toBeUndefined();
    expect(now.today.map((r) => r.kind)).toEqual(["visit_open"]);
    expect(now.scope.level).toBe("member");
  });

  /* ═══ DM5 — restricted tests and confidential patients on "Handled without you" ═══ */

  it("DM5 handled without you drops a restricted test the viewer did not order, and shows a confidential patient by alias", async () => {
    const plain = await critical(P.JR);
    const hidden = await critical(P.JR, { restricted: true });
    await recordAct(db, actor(P.SR), plain.key, "repeat_sample_sent", null, AT);
    await recordAct(db, actor(P.SR), hidden.key, "seen_at_bedside", null, AT);
    await db.update(patients).set({ isConfidential: true, alias: "Patient X-7" }).where(eq(patients.id, patientA));
    const prof = await professorView(db, actor(P.HEAD), min(1));
    expect(prof.handled.map((h) => h.key)).toEqual([plain.key]);
    expect(prof.handled[0]!.patient).toMatchObject({ name: "Patient X-7", restricted: true });
    expect(JSON.stringify(prof)).not.toContain("Patient Alpha");
  });

  /* ═══ DM6 — work ratings ═══ */

  it("DM6 ratings: self, non-senior, other unit and a second rating are refused; Needs rework needs a reason", async () => {
    const jrVisit = await encounter(P.JR, TODAY, "completed");
    const srVisit = await encounter(P.SR, TODAY, "completed");
    const old = await encounter(P.JR, "2026-10-01", "completed");
    const rate = (who: string, workId: string, rating: "good" | "fine" | "needs_rework" = "good", reason: string | null = null) =>
      rateWork(db, actor(who), { workKind: "opd_visit", workId, rating, reason }, AT);
    expect(await code(rate(P.JR, jrVisit.id))).toBe("self_rating");
    expect(await code(rate(P.JR, srVisit.id))).toBe("not_a_senior");
    expect(await code(rate(P.INT, jrVisit.id))).toBe("not_a_senior");
    expect(await code(rate(P.OUT, jrVisit.id))).toBe("not_a_senior");
    expect(await code(rate(P.HEAD, old.id))).toBe("unknown_work");
    expect(await code(rate(P.HEAD, jrVisit.id, "needs_rework", " "))).toBe("note_required");
    expect(await code(rate(P.SR, jrVisit.id, "fine"))).toBe("ok");
    expect(await code(rate(P.HEAD, jrVisit.id))).toBe("ok");
    expect(await code(rate(P.HEAD, jrVisit.id, "fine"))).toBe("already_rated");
    expect(await code(rate(P.SR, srVisit.id))).toBe("self_rating");
    expect(await code(rate(P.FAC, srVisit.id, "needs_rework", "plan missing"))).toBe("ok");
    const items = (await professorView(db, actor(P.HEAD), AT)).toRate;
    expect(items.map((i) => [i.workId, i.mine])).toEqual(expect.arrayContaining([[jrVisit.id, "good"], [srVisit.id, null]]));
    expect(items.find((i) => i.workId === jrVisit.id)!.resident).toMatchObject({ userId: P.JR, role: "junior_resident" });
    // the board's "your last word" is the asker's own word only
    expect((await unitBoard(db, actor(P.HEAD), AT)).people.find((p) => p.userId === P.JR)!.lastWord).toEqual({ rating: "good", workDate: TODAY });
  });

  it("DM6 my ratings: own figures; an average only above the floor; never another person's name; the logbook is mine alone", async () => {
    const jrVisit = await encounter(P.JR, TODAY, "completed");
    await rateWork(db, actor(P.HEAD), { workKind: "opd_visit", workId: jrVisit.id, rating: "needs_rework", reason: "=SUM(A1) plan" }, AT);
    const first = await myRatings(db, actor(P.JR), AT);
    expect(first).toMatchObject({ month: "2026-10", counts: { good: 0, fine: 0, needs_rework: 1, total: 1 }, share: { you: null, department: null, hospital: null } });

    const med = (await orgDepartmentByCode(db, "MED"))!;
    const YESTERDAY = "2026-10-05";
    const row = (rated: string, rating: string, i: number, day = YESTERDAY) => ({
      id: newId(), workKind: "opd_visit", workId: `w-${rated}-${day}-${String(i)}`, workDate: day, ratedUserId: rated, raterId: P.HEAD,
      teamId: U2, departmentId: med.id, rating, reason: rating === "needs_rework" ? "redo" : null,
    });
    // Two OTHER residents (SR, INT) with 8 settled ratings: below the floor of three others — still no average.
    await db.insert(doctorDeskRatings).values([
      ...[0, 1, 2, 3, 4].map((i) => row(P.JR, "good", i)),
      ...[0, 1, 2, 3].map((i) => row(P.SR, i === 0 ? "good" : "fine", i)),
      ...[0, 1, 2, 3].map((i) => row(P.INT, i === 0 ? "good" : "fine", i)),
    ]);
    expect((await myRatings(db, actor(P.JR), AT)).share.department).toBeNull();
    // A third other (FAC: 3 Good of 4) and three Good given TODAY to SR (not settled, left out):
    // others' pool = 12 ratings, 5 Good = 41.7 % → 40 %. With the asker's own 5 Good it would be 60 %; with today's, 55 %.
    await db.insert(doctorDeskRatings).values([
      ...[0, 1, 2, 3].map((i) => row(P.FAC, i < 3 ? "good" : "fine", i)),
      ...[5, 6, 7].map((i) => row(P.SR, "good", i, TODAY)),
    ]);
    const mine = await myRatings(db, actor(P.JR), AT);
    expect(mine.counts).toEqual({ good: 5, fine: 0, needs_rework: 1, total: 6 });
    expect(mine.share).toEqual({ you: 83, department: 40, hospital: 40 });
    const text = JSON.stringify(mine);
    expect(text).not.toMatch(/Dr\.|Senior|Intern|Head/);
    expect(text).not.toContain(P.SR);
    const csv = await logbookCsv(db, actor(P.JR));
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("date,work,visit,rating,reason");
    expect(lines).toHaveLength(7);
    expect(lines).toContain(`${TODAY},OPD visit,${jrVisit.visitNo},Needs rework,'=SUM(A1) plan`);
    expect(csv).not.toMatch(/Dr\.|Patient/);
  });

  /* ═══ DM7 — obligations ignore the copilot toggles (D1) ═══ */

  it("DM7 the obligation paths never read the copilot toggles", () => {
    for (const f of ["owed.ts", "nudge.ts", "moves.ts", "acts.ts", "waiting-on.ts"]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      const imports = src.split("\n").filter((l) => /^\s*import\b|from "/.test(l)).join("\n");
      expect(imports).not.toMatch(/copilot/i);
      expect(src).not.toMatch(/cds_doctor_prefs|cdsDoctorPrefs|copilotSettings|doctorCopilotSettings|draftProse/);
    }
  });

  /* ═══ DM8 — no money ═══ */

  it("DM8 carries no money: the unit board, both phones and my ratings", async () => {
    await critical(P.JR);
    const v = await encounter(P.JR, TODAY, "completed");
    await db.update(opdEncounters).set({ feeBypassReason: "desk let through", feeBypassBy: "t", feeBypassAt: AT, intendedPayer: "pmjay" }).where(eq(opdEncounters.id, v.id));
    const payloads = [
      await unitBoard(db, actor(P.HEAD), AT), await nowView(db, actor(P.JR), AT),
      await professorView(db, actor(P.HEAD), AT), await myRatings(db, actor(P.JR), AT),
    ];
    for (const p of payloads) expect(JSON.stringify(p)).not.toMatch(/fee|paid|paise|price|bypass|payer|pmjay|₹|rupee|invoice|bill/i);
  });

  /* ═══ review fixes ═══ */

  it("F1 the Professor's asks come from the server: allowlisted non-money kinds only, id + kind + time; a discount never shows", async () => {
    const DEF = {
      key: "approval_x", title: "X", changeClass: "C", initialState: "pending",
      states: [{ name: "pending", sla: { minutes: 45, alerting: "active" } }, { name: "granted", terminal: true }, { name: "rejected", terminal: true }],
      transitions: [{ from: "pending", to: "granted", roles: ["unit_approver"] }, { from: "pending", to: "rejected", roles: ["unit_approver"] }],
    };
    await db.insert(roles).values({ key: "unit_approver", title: "Approver" }).onConflictDoNothing();
    await db.insert(roleAssignments).values({ id: newId(), userId: P.HEAD, roleKey: "unit_approver", scopeType: "hospital" });
    const ask = async (typeKey: string, note: string): Promise<string> => {
      const id = newId(); const instanceId = newId(); const defId = newId(); const defKey = `approval_${typeKey}`;
      await db.insert(workflowDefinitions).values({ id: defId, defKey, version: 1, title: typeKey, changeClass: "C", definition: { ...DEF, key: defKey }, draftedBy: P.SR });
      await db.insert(approvalTypes).values({ typeKey, title: typeKey, defKey, approverRole: "unit_approver", createdBy: P.SR });
      await db.insert(workflowInstances).values({ id: instanceId, definitionId: defId, defKey, currentState: "pending", subjectType: "s", subjectId: id, stateEnteredAt: AT });
      await db.insert(approvals).values({
        id, typeKey, instanceId, requesterId: P.SR, approverRole: "unit_approver", urgencyClass: "routine", subjectType: "s", subjectId: id,
        amountPaise: null, requestNote: note, status: "pending", requestedAt: min(-20),
      });
      return id;
    };
    const merge = await ask("patient_merge", "two records, one person");
    await ask("pharmacy_discount_incharge", "12% discount on the bill, fee waived");
    await ask("some_future_kind", "anything");
    const prof = await professorView(db, actor(P.HEAD), AT);
    expect(prof.asks).toEqual([{ id: merge, typeKey: "patient_merge", requestedAt: min(-20).toISOString() }]);
    expect(JSON.stringify(prof)).not.toMatch(/fee|paid|paise|price|discount|%|₹|rupee|bill|amount/i);
    expect((await professorView(db, actor(P.SR), AT)).asks).toEqual([]);
  });

  it("F3 a self-approved officiating row gives no department scope and no HOD bell", async () => {
    const med = (await orgDepartmentByCode(db, "MED"))!;
    await db.insert(rosterOfficiating).values({
      id: newId(), teamId: U1, userId: P.OUT, role: "hod", startsAt: min(-60), endsAt: min(60), reason: "self",
      approvedBy: P.OUT, createdBy: "t", updatedBy: "t",
    });
    const lv = await deskLevel(db, actor(P.OUT), await deskScope(db, actor(P.OUT), AT), AT);
    expect(lv.level).toBe("member");
    expect(await departmentHeads(db, med.id, AT)).not.toContain(P.OUT);
    await db.insert(rosterOfficiating).values({
      id: newId(), teamId: (await teamByCode(db, "MED-U3"))!.id, userId: P.HOD, role: "hod", startsAt: min(-60), endsAt: min(60), reason: "HOD on leave",
      approvedBy: P.HEAD, createdBy: "t", updatedBy: "t",
    });
    expect(await departmentHeads(db, med.id, AT)).toEqual([P.HOD]);
  });

  it("F7 a self-approved officiating head may not move a row (old rows can predate #904)", async () => {
    await db.insert(rosterOfficiating).values({
      id: newId(), teamId: U2, userId: P.FAC, role: "head", startsAt: min(-60 * 24), endsAt: min(60 * 24), reason: "self",
      approvedBy: P.FAC, createdBy: "t", updatedBy: "t",
    });
    const { key } = await critical(P.JR);
    expect(await code(moveRow(db, actor(P.FAC), key, P.SR, AT))).toBe("not_allowed_to_move");
    expect((await unitBoard(db, actor(P.FAC), AT)).owed.every((r) => !r.mayMove)).toBe(true);
    expect((await moveRow(db, actor(P.HEAD), key, P.SR, AT)).moveId).toBeTruthy();
  });

  it("F4 an act appends doctor_desk.critical_acted in its own transaction, naming no patient", async () => {
    const { key } = await critical(P.JR, { at: min(-12) });
    const r = await recordAct(db, actor(P.SR), key, "ecg_ordered", null, AT);
    const ev = await db.select().from(events).where(eq(events.name, "doctor_desk.critical_acted"));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toEqual({ actId: r.actId, rowKey: key, teamId: U2, holderId: P.JR, choice: "ecg_ordered", minutes: 12 });
    expect(await code(recordAct(db, actor(P.JR), key, "ecg_ordered", null, min(1)))).toBe("already_acted");
    expect(await db.select().from(events).where(eq(events.name, "doctor_desk.critical_acted"))).toHaveLength(1);
  });
});
