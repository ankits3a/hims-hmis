import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { alerts } from "../../../kernel/db/schema";
import { phoneMessage, routeOfAlertKind } from "../../../kernel/push/phone-push";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErCareWorld } from "../../../../test/helpers/emergency";
import { assignErDoctor, callCode, placeInBay, readErBoard, recordCodeEvent, registerArrival, triage } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErCareWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 7 (#814, decision 0076) — "DONE MEANS" FOR er-codes (spec SPEC-emergency-2026-10-15 §7). Every check calls the
 * INTENT functions; every instant is passed in.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 7 er-codes — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErCareWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErCareWorld(db);
  });

  const patientInBay = async (gate: Date, name: string) => {
    const p = await w.patient("male", 58, name);
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 1, decision: { lifeSaving: true, highRisk: true, resources: "many", dangerVitals: true } }, { now: gate });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: await w.bed("ER-R1", { class: "emergency" }) }, { now: gate });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: gate });
    return a;
  };

  it("(a) call_code pages the roster team within 10 s, and nothing on the page or the lock screen names the patient", async () => {
    await ensureRole(db, "anaesthetist");
    const gas = (await mkUser(db, "er.anaes", ["anaesthetist"])).actor;
    const a = await patientInBay(new Date(Date.now() - 5 * MIN), "Shyam Sundar Prasad");
    const t0 = Date.now();
    const r = await callCode(db, w.erNurse, { idempotencyKey: key(), kind: "code_blue", episodeId: a.episodeId });
    const pages = await db.select().from(alerts).where(eq(alerts.refId, r.codeId));
    expect(Date.now() - t0).toBeLessThan(10_000);
    // The anaesthetist (Code Blue's own ladder) and the ER doctor of record — each one bell row, at the call.
    expect(pages.map((p) => p.userId).sort()).toEqual([gas.id, w.erDoctor.id].sort());
    expect(r.paged).toBe(2);
    for (const p of pages) {
      expect(p.title).toBe("Code Blue · ER-R1");
      expect(`${p.title} ${p.body}`).not.toMatch(/Shyam|Sundar|Prasad|HMS\d/);
      expect(`${p.title} ${p.body}`).not.toContain(a.patientId);
      const { category, link } = routeOfAlertKind(p.kind);
      const lock = phoneMessage(category, link, "en");
      expect(`${lock.title} ${lock.body}`).not.toMatch(/Shyam|Sundar|Prasad|ER-R1|Code/);
    }
  });

  it("(b) a STEMI clock starts at door time, not activation time", async () => {
    const door = new Date(Date.now() - 40 * MIN);
    const a = await patientInBay(door, "Rakesh Verma");
    const activated = new Date(door.getTime() + 30 * MIN);
    const r = await callCode(db, w.erDoctor, { idempotencyKey: key(), kind: "stemi", episodeId: a.episodeId }, { now: activated });
    expect(r.clocks).toEqual([
      { milestone: "ecg", dueAt: new Date(door.getTime() + 10 * MIN).toISOString() },
      { milestone: "balloon", dueAt: new Date(door.getTime() + 90 * MIN).toISOString() },
    ]);
    const ecgAt = new Date(door.getTime() + 35 * MIN);
    await recordCodeEvent(db, w.erNurse, { idempotencyKey: key(), codeId: r.codeId, kind: "milestone", milestone: "ecg" }, { now: ecgAt });
    const tile = (await readErBoard(db, w.erDesk, { now: ecgAt })).inTreatment.find((t) => t.episodeId === a.episodeId)!;
    expect(tile.activations).toEqual([
      { kind: "stemi", milestone: "ecg", dueAt: new Date(door.getTime() + 10 * MIN).toISOString(), metAt: ecgAt.toISOString() },
      { kind: "stemi", milestone: "balloon", dueAt: new Date(door.getTime() + 90 * MIN).toISOString(), metAt: null },
    ]);
  });
});
