import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { alerts, erEpisodes, rosterDutyWindows, rosterTeams, tasks } from "../../../kernel/db/schema";
import { orgDepartmentByCode, seedOrgDepartments } from "../../roster";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErWorld } from "../../../../test/helpers/emergency";
import { reTriage, registerArrival, registerUnidentified, sweepErTriageClocks, triage } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 2 (#809, decision 0076) — "DONE MEANS" FOR er-triage (spec SPEC-emergency-2026-10-15 §7). Every check calls
 * the INTENT function, never a screen. Every instant is passed in (`now`), so no check reads the real clock.
 */

jest.setTimeout(120_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const NO_RESOURCES = { lifeSaving: false, highRisk: false, resources: "none" as const, dangerVitals: false };
const HIGH_RISK = { lifeSaving: false, highRisk: true, resources: "many" as const, dangerVitals: false };

describe("ER lane 2 er-triage — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  const unknownAt = (now: Date) => registerUnidentified(db, w.erDesk, {
    idempotencyKey: key(), sex: "male", ageBand: "young_adult", arrivalMode: "walk_in",
  }, { now });

  it("(a) each ESI level sets its re-triage interval; an overdue re-triage becomes a task once, then climbs", async () => {
    const t0 = new Date();
    const intervals: Record<number, number | null> = { 1: null, 2: 15, 3: 30, 4: 60, 5: 120 };
    const byLevel: Record<number, string> = {};
    for (const level of [1, 2, 3, 4, 5] as const) {
      const u = await unknownAt(t0);
      byLevel[level] = u.episodeId;
      const decision = level === 1 ? { ...NO_RESOURCES, lifeSaving: true } : level === 2 ? HIGH_RISK
        : level === 3 ? { ...NO_RESOURCES, resources: "many" as const } : level === 4 ? { ...NO_RESOURCES, resources: "one" as const } : NO_RESOURCES;
      const r = await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, decision, level }, { now: t0 });
      const m = intervals[level] ?? null;
      expect([level, r.retriageDueAt]).toEqual([level, m === null ? null : new Date(t0.getTime() + m * MIN).toISOString()]);
    }
    const supervisor = await (async () => { await ensureRole(db, "nursing_supervisor"); return (await mkUser(db, "er.ns", ["nursing_supervisor"])).actor; })();
    const ep2 = byLevel[2]!;
    const retriageTasks = () => db.select().from(tasks).where(like(tasks.sourceRef, `er_retriage:${ep2}:%`));

    // Not yet due: nothing. Due: ONE task. The next ticks: still one.
    await sweepErTriageClocks(db, new Date(t0.getTime() + 14 * MIN));
    expect(await retriageTasks()).toHaveLength(0);
    await sweepErTriageClocks(db, new Date(t0.getTime() + 15 * MIN));
    await sweepErTriageClocks(db, new Date(t0.getTime() + 16 * MIN));
    const raised = await retriageTasks();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: "er_retriage", priority: "urgent", dueAt: new Date(t0.getTime() + 15 * MIN) });

    // 15 minutes past due with no re-triage: it climbs, ONCE, to the nursing supervisor (no roster row names a position).
    const climbs = () => db.select().from(alerts).where(and(eq(alerts.userId, supervisor.id), eq(alerts.kind, "er.retriage_overdue"), eq(alerts.refId, ep2)));
    await sweepErTriageClocks(db, new Date(t0.getTime() + 29 * MIN));
    expect(await climbs()).toHaveLength(0);
    await sweepErTriageClocks(db, new Date(t0.getTime() + 30 * MIN));
    await sweepErTriageClocks(db, new Date(t0.getTime() + 31 * MIN));
    expect(await climbs()).toHaveLength(1);
    expect(await retriageTasks()).toHaveLength(1);

    // The re-triage it asked for closes the task and starts the next clock from now.
    const t1 = new Date(t0.getTime() + 32 * MIN);
    const again = await reTriage(db, w.erNurse, { idempotencyKey: key(), episodeId: ep2, level: 2 }, { now: t1 });
    expect(again.retriageDueAt).toBe(new Date(t1.getTime() + 15 * MIN).toISOString());
    expect((await retriageTasks())[0]!.state).toBe("cancelled");
    // ESI 1 never runs the clock; nothing was raised for it.
    expect(await db.select().from(tasks).where(like(tasks.sourceRef, `er_retriage:${byLevel[1]!}:%`))).toHaveLength(0);
  });

  it("(b) a down-triage without a reason is refused; an up-triage is not", async () => {
    const now = new Date();
    const u = await unknownAt(now);
    // The questions say ESI 2; the nurse picks 3 — less urgent than the proposal: a reason, or nothing is saved.
    await expect(triage(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, decision: HIGH_RISK, level: 3 }, { now }))
      .rejects.toMatchObject({ code: "down_triage_needs_reason", detail: { level: 3, algorithmLevel: 2 } });
    expect((await db.select().from(erEpisodes).where(eq(erEpisodes.id, u.episodeId)))[0]).toMatchObject({ state: "arrived", esi: null });
    await expect(triage(db, w.erNurse, {
      idempotencyKey: key(), episodeId: u.episodeId, decision: HIGH_RISK, level: 3, reason: "Pain settled after rest; walking, talking",
    }, { now })).resolves.toMatchObject({ level: 3, algorithmLevel: 2, downTriage: true });
    // Re-triage less urgent than the last level (3 → 4) without a reason: refused. More urgent (3 → 1): no reason asked.
    await expect(reTriage(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, level: 4 }, { now }))
      .rejects.toMatchObject({ code: "down_triage_needs_reason", detail: { lastLevel: 3 } });
    await expect(reTriage(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, level: 1 }, { now }))
      .resolves.toMatchObject({ level: 1, downTriage: false, retriageDueAt: null });
    // Choosing more urgent than the proposal is never questioned either.
    const v = await unknownAt(now);
    await expect(triage(db, w.erNurse, { idempotencyKey: key(), episodeId: v.episodeId, decision: NO_RESOURCES, level: 2 }, { now }))
      .resolves.toMatchObject({ level: 2, algorithmLevel: 5, downTriage: false });
  });

  it("(c) a 07:55 arrival entered 08:10 is stamped to the night's take unit", async () => {
    await seedOrgDepartments(db);
    const med = (await orgDepartmentByCode(db, "MED"))!.id;
    const by = { createdBy: w.doctor.id, updatedBy: w.doctor.id };
    const night = newId();
    const day = newId();
    const since = new Date("2026-01-01T00:00:00Z");
    await db.insert(rosterTeams).values([
      { id: night, kind: "clinical_unit", departmentId: med, code: "T-MED-U2", name: "Medicine Unit II", active: true, validFrom: since, ...by },
      { id: day, kind: "clinical_unit", departmentId: med, code: "T-MED-U3", name: "Medicine Unit III", active: true, validFrom: since, ...by },
    ] as never);
    // Takes run [08:00, 08:00) IST: 08:00 IST is 02:30 UTC. Unit II took yesterday 08:00 → today 08:00; Unit III from today 08:00.
    const today0800 = new Date("2026-03-10T02:30:00Z");
    const day$ = 24 * 60 * MIN;
    await db.insert(rosterDutyWindows).values([
      { id: newId(), departmentId: med, teamId: night, activity: "take", startsAt: new Date(today0800.getTime() - day$), endsAt: today0800, source: "cycle", ...by },
      { id: newId(), departmentId: med, teamId: day, activity: "take", startsAt: today0800, endsAt: new Date(today0800.getTime() + day$), source: "cycle", ...by },
    ] as never);
    const gate = new Date(today0800.getTime() - 5 * MIN); // 07:55 IST
    const entered = new Date(today0800.getTime() + 10 * MIN); // 08:10 IST
    const p = await w.patient("male", 58, "Shyam Sundar");
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: entered });
    const r = await triage(db, w.erNurse, {
      idempotencyKey: key(), episodeId: a.episodeId, decision: { ...NO_RESOURCES, resources: "many" }, level: 3, departmentCode: "med",
    }, { now: new Date(entered.getTime() + 2 * MIN) });
    expect(r.take).toEqual({ departmentCode: "MED", teamId: night, source: "published" });
    expect((await db.select().from(erEpisodes).where(eq(erEpisodes.id, a.episodeId)))[0]).toMatchObject({ takeTeamId: night, takeSource: "published" });
    await expect(triage(db, w.erNurse, { idempotencyKey: key(), episodeId: (await unknownAt(entered)).episodeId, decision: NO_RESOURCES, level: 5, departmentCode: "XYZ" }, { now: entered }))
      .rejects.toMatchObject({ code: "department_not_found" });
  });
});
