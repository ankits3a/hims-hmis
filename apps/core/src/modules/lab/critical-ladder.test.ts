import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode, uhidOf,
} from "../../../test/helpers/lab";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import {
  alerts, events, labAnalytes, labCriticalCalls, orgDepartments, patients, rosterAssignments, rosterPeriods,
  rosterTeamMemberships, rosterTeams,
} from "../../kernel/db/schema";
import { alertsConsumer } from "../../kernel/alerts/consumer";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { kindSentence } from "../../kernel/push/phone-push";
import { templateByKey } from "../../kernel/notify/templates";
import { seedOrgDepartments, seedRosterPositions } from "../roster";
import { receive } from "./accession";
import { collect } from "./collection";
import { acknowledgeCritical } from "./criticals";
import { criticalReadbackByWeek, rungDue, sweepLabCriticalLadder } from "./critical-ladder";
import { deskOrder } from "./desk";
import { enterResult } from "./results";
import { printLabels } from "./specimens";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * E3.2 (#595, owner 2026-10-12) — A LAB CRITICAL NOBODY READS BACK IS CHASED UP A LADDER:
 * ordering doctor (rung 0, at open) → unit head (15 min) → duty RMO (30) → HOD (45). A read-back
 * stops it. The fixture clock is injected everywhere; nothing here reads the real clock.
 */
const AT = new Date("2026-08-30T20:30:00Z"); // 02:00 IST
const after = (min: number): Date => new Date(AT.getTime() + min * 60_000);
const RESOLVER_ON = { ROSTER_RESOLVER_ENABLED: "true" } as NodeJS.ProcessEnv;

describe("lab critical ladder (E3.2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let doc: string; let head: string; let rmo: string; let hod: string; let dutyManager: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    doc = (await mkUser(db, "ordering.doctor", ["doctor"])).id;
    head = (await mkUser(db, "unit.head", ["doctor"])).id;
    rmo = (await mkUser(db, "duty.rmo", ["doctor"])).id;
    hod = (await mkUser(db, "the.ms", ["medical_superintendent"])).id;
    dutyManager = (await mkUser(db, "duty.manager", ["duty_manager"])).id;

    for (const role of ["radiologist", "anaesthetist", "pharmacy", "pathologist", "doctor", "duty_manager", "medical_superintendent"]) {
      await ensureRole(db, role);
    }
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    const [dept] = await db.select({ id: orgDepartments.id }).from(orgDepartments).limit(1);
    const team = newId();
    await db.insert(rosterTeams).values({
      id: team, kind: "clinical_unit", departmentId: dept!.id, code: "MED-U9", name: "Medicine Unit IX",
      active: true, createdBy: "t", updatedBy: "t",
    });
    const since = new Date("2026-01-01T00:00:00Z");
    await db.insert(rosterTeamMemberships).values([
      { id: newId(), teamId: team, userId: doc, positionKey: "unit_sr", grade: "assistant_professor", roleInTeam: "faculty", startsAt: since, createdBy: "t", updatedBy: "t" },
      { id: newId(), teamId: team, userId: head, positionKey: "unit_head", grade: "professor", roleInTeam: "head", startsAt: since, createdBy: "t", updatedBy: "t" },
    ]);
    /** Tonight's published duty RMO (`casualty_mo`), hospital-wide. */
    const period = newId();
    await db.insert(rosterPeriods).values({
      id: period, scopeType: "hospital", scopeId: null, title: "August nights", version: 1, status: "published",
      startsAt: after(-24 * 60), endsAt: after(24 * 60), coversPositions: ["casualty_mo"],
      publishedAt: after(-24 * 60), publishedBy: "t", contentHash: "h", createdBy: "t", updatedBy: "t",
    });
    await db.insert(rosterAssignments).values({
      id: newId(), periodId: period, userId: rmo, positionKey: "casualty_mo", startsAt: after(-60), endsAt: after(12 * 60),
      departmentId: dept!.id, coverScope: "hospital", effective: true, lineageId: newId(), proposedByActorId: "t",
      createdBy: "t", updatedBy: "t",
    });
  });
  afterEach(() => { fx.unregister(); });

  /** A potassium of 6.8 keyed at 02:00 IST on an RFT the ordering doctor asked for. */
  async function criticalCall(): Promise<{ callId: string; resultId: string }> {
    const placed = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.newVisit(), serviceDate: fx.serviceDate,
      orderingClinicianId: doc,
      items: [{ serviceId: serviceIdForLabCode("RFT") }],
      credit: { reason: "counter order" }, placedAt: AT,
    }, AT));
    const { specimens } = await printLabels(db, fx.bench.actor, {
      orderGroupId: placed.orderGroupId, scannedUhid: await uhidOf(db, fx.patientId),
    }, AT);
    for (const s of specimens) {
      await withTx(db, (tx) => collect(tx, fx.bench.actor, { specimenId: s.specimenId, wristbandScanned: true }, AT));
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }, AT));
    }
    const [k] = await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, "K"));
    const entered = await enterResult(db, fx.bench.actor, {
      orderItemId: placed.itemIds[0]!, analyteId: k!.id, value: "6.8", entryMode: "manual",
    }, AT);
    return { callId: entered.criticalCallId!, resultId: entered.resultId };
  }

  const overdueEvents = () => db.select().from(events).where(eq(events.name, "lab.critical_overdue")).orderBy(asc(events.seq));

  /** Hand every chase event to the alerts consumer, as the dispatcher would (at-least-once is fine). */
  async function deliver(): Promise<void> {
    const handler = alertsConsumer(db);
    for (const r of await overdueEvents()) {
      await handler({
        seq: r.seq, eventId: r.eventId, name: r.name, payload: r.payload,
        patientId: r.patientId, correlationId: r.correlationId, occurredAt: r.occurredAt,
      });
    }
  }
  const alertsFor = (userId: string) => db.select().from(alerts).where(eq(alerts.userId, userId));

  it("rungDue: one rung per 15 minutes, capped at the HOD", () => {
    expect([0, 14, 15, 29, 30, 44, 45, 90].map((m) => rungDue(AT, after(m)))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it("DONE 1 — a new critical has an owner (the ordering doctor), a clock and rung 0, and the doctor is alerted", async () => {
    const { callId } = await criticalCall();
    const [call] = await db.select().from(labCriticalCalls).where(eq(labCriticalCalls.id, callId));
    expect(call).toMatchObject({ ownerUserId: doc, ladderRung: 0, openedAt: AT, lastChasedAt: AT });

    const chased = await overdueEvents();
    expect(chased.map((e) => e.payload)).toEqual([{ callId, resultId: call!.resultId, rung: "ordering_doctor", minutesOpen: 0, recipientIds: [doc] }]);
    await deliver();
    expect((await alertsFor(doc)).map((a) => [a.kind, a.refType, a.refId])).toEqual([["lab_critical", "lab_critical_call", callId]]);
  });

  it("DONE 2 — unanswered: 15 min → the unit head, 30 min → the duty RMO, 45 → the HOD, and never further", async () => {
    const { callId } = await criticalCall();
    expect((await sweepLabCriticalLadder(db, after(14), RESOLVER_ON)).chased).toEqual([]);

    expect((await sweepLabCriticalLadder(db, after(15), RESOLVER_ON)).chased).toEqual([{ callId, rung: "unit_head", recipients: 1 }]);
    expect((await sweepLabCriticalLadder(db, after(16), RESOLVER_ON)).chased).toEqual([]);
    expect((await sweepLabCriticalLadder(db, after(30), RESOLVER_ON)).chased).toEqual([{ callId, rung: "duty_rmo", recipients: 1 }]);
    /** The HOD rung is every `medical_superintendent` holder (the fixture's OPD activator is one too). */
    const msHolders = await withTx(db, (tx) => usersHoldingRole(tx, "medical_superintendent"));
    expect(msHolders).toContain(hod);
    expect((await sweepLabCriticalLadder(db, after(45), RESOLVER_ON)).chased).toEqual([{ callId, rung: "hod", recipients: msHolders.length }]);
    expect((await sweepLabCriticalLadder(db, after(120), RESOLVER_ON)).chased).toEqual([]);

    const payloads = (await overdueEvents()).map((e) => e.payload as { rung: string; recipientIds: string[]; minutesOpen: number });
    expect(payloads.map((p) => [p.rung, p.recipientIds, p.minutesOpen])).toEqual([
      ["ordering_doctor", [doc], 0], ["unit_head", [head], 15], ["duty_rmo", [rmo], 30], ["hod", msHolders, 45],
    ]);
    await deliver();
    for (const who of [doc, head, rmo, hod]) {
      expect((await alertsFor(who)).map((a) => a.refId)).toEqual([callId]);
    }
    const [call] = await db.select().from(labCriticalCalls).where(eq(labCriticalCalls.id, callId));
    expect([call!.ladderRung, call!.lastChasedAt]).toEqual([3, after(45)]);
  });

  it("a rung that names nobody falls back to the duty managers (no published roster for the RMO)", async () => {
    await criticalCall();
    await sweepLabCriticalLadder(db, after(30), {}); // resolver off: no roster answers
    const last = (await overdueEvents()).at(-1)!;
    expect(last.payload).toMatchObject({ rung: "duty_rmo", recipientIds: [] });
    await deliver();
    expect((await alertsFor(dutyManager)).map((a) => a.kind)).toEqual(["lab_critical"]);
  });

  it("DONE 3 — a read-back at rung 1 stops the chase: no further rung, no further alert", async () => {
    const { callId } = await criticalCall();
    await sweepLabCriticalLadder(db, after(15), RESOLVER_ON);
    await withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, { callId, readback: "potassium six point eight" }, after(20)));

    for (const m of [30, 45, 60, 240]) {
      expect((await sweepLabCriticalLadder(db, after(m), RESOLVER_ON)).chased).toEqual([]);
    }
    expect((await overdueEvents()).map((e) => (e.payload as { rung: string }).rung)).toEqual(["ordering_doctor", "unit_head"]);
    await deliver();
    expect(await alertsFor(rmo)).toEqual([]);
    expect(await alertsFor(hod)).toEqual([]);
    const [call] = await db.select().from(labCriticalCalls).where(eq(labCriticalCalls.id, callId));
    expect(call!.ladderRung).toBe(1);
  });

  it("DONE 4 — no event, alert, phone push or relay carries the patient's name, UHID or the value", async () => {
    const { callId } = await criticalCall();
    for (const m of [15, 30, 45]) await sweepLabCriticalLadder(db, after(m), RESOLVER_ON);
    await deliver();

    const [p] = await db.select({ name: patients.name, uhid: patients.uhid }).from(patients).where(eq(patients.id, fx.patientId));
    const forbidden = [p!.name, p!.uhid, "6.8", "6,8", "K "];
    const raised = await db.select().from(alerts).where(eq(alerts.refId, callId));
    expect(raised.length).toBeGreaterThanOrEqual(4);
    const phone = ["en", "hi"].map((lang) => kindSentence("lab_critical", lang));
    expect(phone[0]).toBe("Critical lab result waiting");
    const relay = (["en", "hi"] as const).map((lang) => templateByKey("staff_alert_relay_now").render[lang]({
      kind: "lab_critical", lane: "now", remainingMinutes: "5", link: "/lab/bench",
    }));
    expect(relay[0]).toBe("Critical lab result waiting · now · 5 min left. Open: /lab/bench");

    const surfaces = [
      JSON.stringify((await overdueEvents()).map((e) => e.payload)),
      JSON.stringify(raised.map((a) => [a.title, a.body])),
      JSON.stringify(phone), JSON.stringify(relay),
    ];
    for (const text of surfaces) {
      for (const bad of forbidden) expect(text).not.toContain(bad);
    }
    expect(raised[0]!.title).toBe("Critical lab result waiting");
  });

  it("DONE 5 — the G5 report: per ISO week, count, median and p95 minutes to read-back; open calls not counted", async () => {
    /** One real call (read back at 2 min), and four more rows on the same result with known waits. */
    const first = await criticalCall();
    await withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, { callId: first.callId, readback: "six point eight" }, after(2)));
    for (const m of [4, 6, 8, 40]) {
      await db.insert(labCriticalCalls).values({
        id: newId(), resultId: first.resultId, openedAt: AT, openedBy: fx.bench.id, attempts: [],
        readbackText: "6.8", closedBy: fx.bench.id, closedAt: after(m),
      });
    }
    await db.insert(labCriticalCalls).values({ id: newId(), resultId: first.resultId, openedAt: AT, openedBy: fx.bench.id, attempts: [] }); // still open
    expect(await criticalReadbackByWeek(db)).toEqual([
      { week: "2026-W36", count: 5, medianMin: 6, p95Min: 33.6 },
    ]);
    expect(await criticalReadbackByWeek(db, { since: after(60) })).toEqual([]);
  });
});
