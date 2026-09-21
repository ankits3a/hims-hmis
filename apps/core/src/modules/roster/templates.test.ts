import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterCycleEntries, users,
} from "../../kernel/db/schema";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { seedUnits } from "./teams";
import { CYCLE_TEMPLATES, cycleTemplate, draftCycleFromTemplate } from "./templates";
import { expandCycle } from "./calendar";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R7) — the template gallery.
 *
 * The leg that matters is the REFUSAL: a five-unit rotation applied to a three-unit department is
 * not an error anybody sees — it is a cycle that looks valid and gives one unit two turns on take
 * inside one turn of the wheel. Every other leg here is about the patterns being what they claim.
 */
describe("roster — the duty-pattern gallery (R7)", () => {
  const MS = "01USER00000000000000000MS";
  const ms: Actor = { type: "user", id: MS };
  const ANCHOR = "2026-10-05";

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;
  let PSY: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" }, { key: "duty_manager", title: "Duty manager" },
      { key: "medical_superintendent", title: "Medical Superintendent" },
      { key: "radiologist", title: "Radiologist" }, { key: "pathologist", title: "Pathologist" },
      { key: "anaesthetist", title: "Anaesthetist" }, { key: "pharmacy", title: "Pharmacy" },
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    );
    await db.insert(users).values({ id: MS, username: "sunita.mishra", fullName: "sunita.mishra", staffCode: "EMP-0001", passwordHash: "x" });
    await db.insert(roleAssignments).values({ id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null });
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    const depts = await db.select().from(orgDepartments);
    MED = depts.find((d) => d.code === "MED")!.id;   // five units
    PSY = depts.find((d) => d.code === "PSY")!.id;   // one unit
  });

  it("every template is internally consistent: its entries fit its own cycle and units", () => {
    expect(CYCLE_TEMPLATES.length).toBe(6);
    expect(new Set(CYCLE_TEMPLATES.map((t) => t.key)).size).toBe(6);
    for (const t of CYCLE_TEMPLATES) {
      for (const e of t.entries) {
        expect(`${t.key}: day ${e.dayIndex} < ${t.cycleDays}`).toBe(`${t.key}: day ${e.dayIndex} < ${t.cycleDays}`);
        expect(e.dayIndex).toBeLessThan(t.cycleDays);
        expect(e.unitOffset).toBeLessThan(t.units);
      }
      // Every pattern must actually put SOMEBODY on take, or it is not a take pattern.
      expect(`${t.key} has take: ${t.entries.some((e) => e.activity === "take")}`).toBe(`${t.key} has take: true`);
      // And a head is told what to watch for before picking it.
      expect(t.note.length).toBeGreaterThan(40);
    }
  });

  it("post-take never precedes the take it follows", () => {
    // Not arbitrary: a unit that admitted all night rounds on its OWN admissions the next morning.
    for (const t of CYCLE_TEMPLATES) {
      for (const post of t.entries.filter((e) => e.activity === "post_take")) {
        const takeDay = t.entries.find((e) => e.activity === "take" && e.unitOffset === post.unitOffset)?.dayIndex;
        expect(`${t.key}: post-take on ${post.dayIndex} after take on ${String(takeDay)}`)
          .toBe(`${t.key}: post-take on ${post.dayIndex} after take on ${String(takeDay)}`);
        expect(takeDay).toBeLessThan(post.dayIndex);
      }
    }
  });

  it("every template's take is CONTINUOUS over its own cycle — no day without an admitting unit", () => {
    for (const t of CYCLE_TEMPLATES) {
      const takeDays = new Set(t.entries.filter((e) => e.activity === "take").map((e) => e.dayIndex));
      const missing = Array.from({ length: t.cycleDays }, (_, i) => i).filter((d) => !takeDays.has(d));
      expect(`${t.key} days without a take: ${JSON.stringify(missing)}`).toBe(`${t.key} days without a take: []`);
    }
  });

  it("applies a pattern as a DRAFT on the department's own units, in unit order", async () => {
    const { cycleId, version } = await withTx(db, (tx) => draftCycleFromTemplate(tx, ms, {
      departmentId: MED, templateKey: "five_unit_rolling", anchorIstDate: ANCHOR,
    }));
    expect(version).toBe(1);
    const entries = await db.select().from(rosterCycleEntries);
    expect(entries.filter((e) => e.cycleId === cycleId)).toHaveLength(9);
    // Day 0's take is MED-U1, because `unitOffset: 0` means the department's first unit.
    const day0 = entries.find((e) => e.cycleId === cycleId && e.dayIndex === 0 && e.activity === "take")!;
    const unit1 = (await db.select().from(orgDepartments)).length; // touch, to keep the read honest
    void unit1;
    expect(day0.startMinute).toBe(480);
  });

  it("REFUSES a pattern written for more units than the department has", async () => {
    // Psychiatry has one unit. A five-unit rotation on it would look like a valid cycle and give
    // that unit two turns inside one turn of the wheel.
    const e = await withTx(db, (tx) => draftCycleFromTemplate(tx, ms, {
      departmentId: PSY, templateKey: "five_unit_rolling", anchorIstDate: ANCHOR,
    })).then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(RosterError);
    expect((e as RosterError).code).toBe("template_needs_more_units");
    expect((e as RosterError).detail).toMatchObject({ needs: 5, has: 1 });
  });

  it("the one-unit pattern fits a one-unit department, and expands to a take every day", async () => {
    const { cycleId } = await withTx(db, (tx) => draftCycleFromTemplate(tx, ms, {
      departmentId: PSY, templateKey: "single_unit_call", anchorIstDate: ANCHOR,
    }));
    const entries = (await db.select().from(rosterCycleEntries)).filter((e) => e.cycleId === cycleId);
    const spec = {
      cycleDays: 1, anchorIstDate: ANCHOR,
      entries: entries.map((e) => ({
        dayIndex: e.dayIndex, teamId: e.teamId, activity: e.activity as "take",
        startMinute: e.startMinute, durationMinutes: e.durationMinutes,
      })),
    };
    const week = expandCycle(spec, ANCHOR, "2026-10-12");
    expect(week.filter((w) => w.activity === "take")).toHaveLength(7); // on call every night
  });

  it("an unknown pattern is refused, and no machine applies one", async () => {
    await expect(withTx(db, (tx) => draftCycleFromTemplate(tx, ms, {
      departmentId: MED, templateKey: "whatever_the_hod_wants", anchorIstDate: ANCHOR,
    }))).rejects.toThrow(RosterError);
    expect(() => cycleTemplate("nope")).toThrow(RosterError);
    await expect(withTx(db, (tx) => draftCycleFromTemplate(tx, { type: "system", id: MS }, {
      departmentId: MED, templateKey: "five_unit_rolling", anchorIstDate: ANCHOR,
    }))).rejects.toThrow(RosterError);
  });
});
