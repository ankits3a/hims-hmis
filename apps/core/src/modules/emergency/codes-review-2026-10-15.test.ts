import { randomUUID } from "node:crypto";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { authManifest } from "../../kernel/auth/manifest";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErCareWorld } from "../../../test/helpers/emergency";
import {
  assignErDoctor, callCode, emergencyManifest, endCode, placeInBay, readErBoard, readErCodes, recordCodeEvent, registerArrival, triage,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErCareWorld } from "../../../test/helpers/emergency";

/**
 * ER review 4 (2026-10-15) — lane 7 follow-ups, through the intents:
 * - the wall carries no activation clock (a STEMI / stroke / snakebite milestone is clinical detail);
 * - a non-clinical holder of `er.codes` (security, the front office) calls a code and sees Code Grey, never a clinical
 *   code's record or its patient; nor writes to it;
 * - a resuscitation record event is never dated before the patient's arrival (a milestone "met" before the door);
 * - Code Grey ends on a doctor's or the duty manager's word, not anyone's;
 * - the ER doctor of record is always on the page, whatever the team's size.
 */
jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 7 — review follow-ups", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErCareWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErCareWorld(db); });

  const patientInBay = async (gate: Date, name: string, bed: string) => {
    const p = await w.patient("male", 58, name);
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 1, decision: { lifeSaving: true, highRisk: true, resources: "many", dangerVitals: true } }, { now: gate });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: await w.bed(bed, { class: "emergency" }) }, { now: gate });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: gate });
    return a;
  };
  const guard = async () => {
    const reg = new ModuleRegistry();
    reg.install(authManifest);
    reg.install(emergencyManifest);
    await syncPermissions(db, reg);
    await ensureRole(db, "security_guard");
    await grantPermissionToRole(db, reg, "security_guard", "er.codes");
    return (await mkUser(db, "er.guard", ["security_guard"])).actor;
  };

  it("the wall carries no activation clock; the full board keeps it", async () => {
    const door = new Date(Date.now() - 20 * MIN);
    const a = await patientInBay(door, "Rakesh Verma", "ER-R1");
    await callCode(db, w.erDoctor, { idempotencyKey: key(), kind: "stemi", episodeId: a.episodeId });
    const full = (await readErBoard(db, w.erDesk)).inTreatment.find((t) => t.episodeId === a.episodeId)!;
    expect(full.activations?.length).toBe(2);
    const wall = (await readErBoard(db, w.erDesk, { wall: true })).inTreatment.find((t) => t.episodeId === a.episodeId)!;
    expect(wall.activations).toBeUndefined();
  });

  it("security calls a code and sees Code Grey, never a clinical code's record; nor writes to one", async () => {
    const g = await guard();
    const a = await patientInBay(new Date(Date.now() - 20 * MIN), "Mohan Das", "ER-R2");
    const blue = await callCode(db, w.erNurse, { idempotencyKey: key(), kind: "code_blue", episodeId: a.episodeId });
    await recordCodeEvent(db, w.erNurse, { idempotencyKey: key(), codeId: blue.codeId, kind: "drug", drug: "Adrenaline", dose: "1 mg" });
    const grey = await callCode(db, g, { idempotencyKey: key(), kind: "code_grey", place: "ER entrance" });
    const seen = await readErCodes(db, g);
    expect(seen.active.map((c) => c.kind)).toEqual(["code_grey"]);
    expect(JSON.stringify(seen)).not.toMatch(/Mohan|Adrenaline/);
    await expect(recordCodeEvent(db, g, { idempotencyKey: key(), codeId: blue.codeId, kind: "note", note: "x" })).rejects.toMatchObject({ code: "er_forbidden" });
    await expect(endCode(db, g, { idempotencyKey: key(), codeId: grey.codeId, outcome: "resolved" })).rejects.toMatchObject({ code: "er_forbidden" });
    await expect(endCode(db, w.erDoctor, { idempotencyKey: key(), codeId: grey.codeId, outcome: "resolved" })).resolves.toHaveProperty("endedAt");
  });

  it("a record event is never dated before the patient arrived", async () => {
    const door = new Date(Date.now() - 30 * MIN);
    const a = await patientInBay(door, "Ravi Kant", "ER-R3");
    const r = await callCode(db, w.erDoctor, { idempotencyKey: key(), kind: "stemi", episodeId: a.episodeId });
    await expect(recordCodeEvent(db, w.erNurse, {
      idempotencyKey: key(), codeId: r.codeId, kind: "milestone", milestone: "ecg", at: new Date(door.getTime() - 10 * MIN).toISOString(), fromPaper: true,
    })).rejects.toMatchObject({ code: "event_before_arrival" });
  });

  it("the ER doctor of record is always paged", async () => {
    await ensureRole(db, "anaesthetist");
    for (let i = 0; i < 14; i += 1) await mkUser(db, `er.anaes${String(i)}`, ["anaesthetist"]);
    const a = await patientInBay(new Date(Date.now() - 5 * MIN), "Sita Ram", "ER-R4");
    const r = await callCode(db, w.erNurse, { idempotencyKey: key(), kind: "code_blue", episodeId: a.episodeId });
    const codes = await readErCodes(db, w.erNurse);
    expect(codes.active.find((c) => c.codeId === r.codeId)!.team.map((m) => m.userId)).toContain(w.erDoctor.id);
  });
});
