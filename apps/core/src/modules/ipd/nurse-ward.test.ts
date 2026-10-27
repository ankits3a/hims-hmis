import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { IPD_RATIO_DEFAULTS, patientsPerRnOf, ratioUnitOf, rnsNeededFor } from "@hmis/contracts";
import { alerts } from "../../kernel/db/schema";
import { loadDesk } from "../../kernel/desk/registry";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkWardWorld } from "../../../test/helpers/ipd";
import {
  ipdManifest, publishShiftMap, recordNursingAssessment, recordVitals, saveShiftMap, sweepIpdNursing,
} from "./index";
import { previousSlot, shiftSlot, shiftSlotOf } from "./nurse-ward";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { WardWorld } from "../../../test/helpers/ipd";

/**
 * WM-1 (#982) — the pieces the acceptance file does not reach: the ratio arithmetic at its limits, the shift slots at
 * their edges, the early-warning step reaching the bed's assigned nurse, and the in-charge's "Ward needs you" card.
 */

const ist = (s: string): Date => new Date(`${s}+05:30`);

describe("WM-1 ratio arithmetic (decision 0089)", () => {
  it("needs one nurse per ventilated patient and the rest at the ward's ratio, rounded up", () => {
    expect(rnsNeededFor({ patients: 6, ventilated: 0, patientsPerRn: 6 })).toBe(1);
    expect(rnsNeededFor({ patients: 7, ventilated: 0, patientsPerRn: 6 })).toBe(2);
    expect(rnsNeededFor({ patients: 0, ventilated: 0, patientsPerRn: 6 })).toBe(0);
    expect(rnsNeededFor({ patients: 1, ventilated: 1, patientsPerRn: 6 })).toBe(1);
    expect(rnsNeededFor({ patients: 7, ventilated: 1, patientsPerRn: 6 })).toBe(2);
    expect(rnsNeededFor({ patients: 8, ventilated: 1, patientsPerRn: 6 })).toBe(3);
  });

  it("picks the unit from the ward's own setting, its unit type, then its beds", () => {
    expect(ratioUnitOf({ unitType: "WARD", ratioUnit: "private" }, [])).toBe("private");
    expect(ratioUnitOf({ unitType: "MICU" }, ["icu"])).toBe("hdu_icu");
    expect(ratioUnitOf({ unitType: "HDU" }, [])).toBe("hdu_icu");
    expect(ratioUnitOf({ unitType: "LDR" }, [])).toBe("labour_nicu");
    expect(ratioUnitOf({ unitType: "WARD" }, ["private", "private", "general"])).toBe("private");
    expect(ratioUnitOf({ unitType: "WARD" }, ["private", "general"])).toBe("general");
    expect(ratioUnitOf({ unitType: "WARD", ratioUnit: "nonsense" }, [])).toBe("general");
  });

  it("uses the day value by day and the night value by night, unless the ward sets its own", () => {
    expect(patientsPerRnOf("general", false)).toBe(IPD_RATIO_DEFAULTS.general.day);
    expect(patientsPerRnOf("general", true)).toBe(8);
    expect(patientsPerRnOf("private", false)).toBe(4);
    expect(patientsPerRnOf("general", false, { day: 5, night: 7 })).toBe(5);
    expect(patientsPerRnOf("general", true, { day: 5, night: 7 })).toBe(7);
    expect(patientsPerRnOf("general", true, { night: 0 })).toBe(8);
  });
});

describe("WM-1 shift slots", () => {
  it("dates a shift by the IST day it starts on, at each edge", () => {
    expect(shiftSlotOf(ist("2026-03-10T07:59:59"))).toMatchObject({ date: "2026-03-09", key: "night" });
    expect(shiftSlotOf(ist("2026-03-10T08:00:00"))).toMatchObject({ date: "2026-03-10", key: "morning" });
    expect(shiftSlotOf(ist("2026-03-10T14:00:00"))).toMatchObject({ date: "2026-03-10", key: "evening" });
    expect(shiftSlotOf(ist("2026-03-10T20:00:00"))).toMatchObject({ date: "2026-03-10", key: "night" });
    expect(shiftSlotOf(ist("2026-03-11T02:00:00"))).toMatchObject({ date: "2026-03-10", key: "night" });
    expect(previousSlot(shiftSlot("2026-03-10", "morning"))).toMatchObject({ date: "2026-03-09", key: "night" });
    expect(shiftSlot("2026-03-10", "night").endsAt).toEqual(ist("2026-03-11T08:00:00"));
  });
});

describe("WM-1 early warning and the Now card", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: WardWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkWardWorld(db);
  }, 120_000);

  const publishMorning = async (beds: { bedId: string; nurseId: string }[], staff: Actor[]) => {
    const d = await saveShiftMap(db, w.incharge, {
      idempotencyKey: randomUUID(), wardId: w.wardId, shiftDate: "2026-03-10", shift: "morning",
      staff: staff.map((a) => ({ userId: a.id, kind: "rn" })), beds,
    }, { now: ist("2026-03-10T07:00:00") });
    await publishShiftMap(db, w.incharge, { idempotencyKey: randomUUID(), mapId: d.mapId }, { now: ist("2026-03-10T07:20:00") });
  };

  it("an early-warning alert nobody acknowledged in 10 minutes reaches the bed's assigned nurse as well", async () => {
    const bedId = await w.bed("EW-B01");
    const p = await w.admitOn(bedId, ist("2026-03-10T06:00:00"));
    await publishMorning([{ bedId, nurseId: w.nurse2.id }], [w.nurse2]);
    const t = ist("2026-03-10T09:00:00");
    await recordNursingAssessment(db, w.nurse, {
      idempotencyKey: randomUUID(), admissionId: p.admissionId, happenedAt: t.toISOString(), source: "person", morse: 30, braden: 18, nutrition: "no_risk",
      allergyChecked: true, allergies: [], homeMedicines: [], painScore: 2, pressureInjuriesOnAdmission: [],
    }, { now: t });
    await recordVitals(db, w.nurse, {
      idempotencyKey: randomUUID(), admissionId: p.admissionId, observedAt: t.toISOString(), source: "person",
      values: { temperatureC: 37, pulse: 111, respRate: 21, systolic: 125, diastolic: 80, spo2: 94, onOxygen: false, consciousness: "alert" },
    }, { now: t });
    expect(await sweepIpdNursing(db, new Date(t.getTime() + 11 * 60_000))).toMatchObject({ ewsUnacked: 1 });
    const told = await db.select().from(alerts).where(and(eq(alerts.kind, "ipd.ews_unacknowledged"), eq(alerts.userId, w.nurse2.id)));
    expect(told).toHaveLength(1);
    expect(await db.select().from(alerts).where(and(eq(alerts.kind, "ipd.ews_unacknowledged"), eq(alerts.userId, w.supervisor.id)))).toHaveLength(1);
  });

  it("'Ward needs you' shows a bed with no nurse and the next shift unpublished, only to the assign permission", async () => {
    const a = await w.bed("NY-B01");
    await w.admitOn(a, ist("2026-03-10T06:00:00"));
    await publishMorning([{ bedId: a, nurseId: w.nurse.id }], [w.nurse]);
    const fresh = await w.bed("NY-B02");
    await w.admitOn(fresh, ist("2026-03-10T09:00:00"));
    const card = async (actor: Actor, now: Date) =>
      (await loadDesk(ipdManifest.desk!, { db, actor, reader: actor, date: "", now })).cards.find((c) => c.key === "ipd.ward_needs_you");

    const at10 = await card(w.incharge, ist("2026-03-10T10:00:00"));
    expect(at10?.rows?.map((r) => r.title)).toEqual(["Bed NY-B02 — no nurse"]);
    expect(await card(w.nurse, ist("2026-03-10T10:00:00"))).toBeUndefined();
    const at1340 = await card(w.incharge, ist("2026-03-10T13:40:00"));
    expect(at1340?.rows?.map((r) => r.id)).toEqual([`unassigned:${fresh}`, `publish:${w.wardId}`]);
  });
});
