import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { ipdBedBlocks, ipdBedReservations, resources } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkBedWorld } from "../../../../test/helpers/ipd";
import {
  assignBed, blockBed, lapseBedReservations, releaseIncumbentBed, reserveBed, retireBed, markIncumbentBeds,
} from "../index";
import type { IpdBedNeed } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { BedWorld } from "../../../../test/helpers/ipd";

/**
 * E1.1 (#718) — "DONE MEANS" FOR THE BED INTENTS (spec SPEC-ipd-core §6 Beds and Architecture; decision 0072).
 * Every check calls the INTENT function, never a screen: a rule the screen forgot still refuses here.
 * Times are explicit `now` arguments; nothing here reads the real clock for a date it asserts.
 */

jest.setTimeout(60_000);

const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };

describe("E1.1 bed intents — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: BedWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkBedWorld(db); });

  const bedRow = async (id: string) => (await db.select().from(resources).where(eq(resources.id, id)))[0]!;
  const assignInput = (bedId: string, patientId: string, need: IpdBedNeed = GENERAL, admissionId = newId()) => ({
    idempotencyKey: randomUUID(), admissionId, bedId, patientId, need,
  });

  it("(i) a female-only bed refuses a male patient, and the refusal names the rule", async () => {
    const bedId = await w.bed("T-F1", { genderRule: "female" });
    const man = await w.patient("male");
    const refused = assignBed(db, w.desk, assignInput(bedId, man));
    await expect(refused).rejects.toMatchObject({ code: "bed_gender_mismatch", bedRule: "Female-only bed" });
    await expect(assignBed(db, w.desk, assignInput(bedId, man))).rejects.toThrow(/^Female-only bed: /);
    expect((await bedRow(bedId)).status).toBe("available");
    // The same bed takes a woman.
    const woman = await w.patient("female");
    await expect(assignBed(db, w.desk, assignInput(bedId, woman))).resolves.toMatchObject({ bedId, billedClass: "general" });
  });

  it("(ii) simultaneous assignments of one bed (four desks at once): exactly one succeeds, every other is told and offered beds", async () => {
    const bedId = await w.bed("T-RACE");
    await w.bed("T-NEXT1");
    // Four desks, four patients, one bed, all at once (each call on its own pool connection).
    const patients = [await w.patient("female"), await w.patient("female"), await w.patient("female"), await w.patient("female")];
    const desks = [w.desk, w.dutyManager, w.desk, w.dutyManager];
    const results = await Promise.allSettled(patients.map((p, i) => assignBed(db, desks[i]!, assignInput(bedId, p))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(lost).toHaveLength(3);
    for (const l of lost) {
      // Every loser hears "bed just taken" with the next rule-valid beds — never a raw registry error.
      expect(l.reason).toMatchObject({ code: "bed_not_available" });
      expect((l.reason as { detail: { nextBeds: { code: string }[] } }).detail.nextBeds.map((x) => x.code)).toEqual(["T-NEXT1"]);
    }
    const row = await bedRow(bedId);
    expect(row.status).toBe("occupied");
  });

  it("(iii) a reserved bed returns to available after 2 hours if unused (the lapse job, driven by `now`)", async () => {
    const bedId = await w.bed("T-RES");
    const p = await w.patient("male");
    const t0 = new Date(Date.now() - 3 * 3_600_000);
    const held = await reserveBed(db, w.desk, { ...assignInput(bedId, p) }, { now: t0 });
    expect(new Date(held.expiresAt).getTime() - t0.getTime()).toBe(2 * 3_600_000);

    expect(await lapseBedReservations(db, new Date(t0.getTime() + 119 * 60_000))).toEqual({ lapsed: 0 });
    // Another patient cannot have it while held.
    await expect(assignBed(db, w.desk, assignInput(bedId, await w.patient("male")), { now: new Date(t0.getTime() + 60 * 60_000) }))
      .rejects.toMatchObject({ code: "bed_not_available", bedRule: "Bed is reserved" });

    expect(await lapseBedReservations(db, new Date(t0.getTime() + 120 * 60_000))).toEqual({ lapsed: 1 });
    expect(await lapseBedReservations(db, new Date(t0.getTime() + 121 * 60_000))).toEqual({ lapsed: 0 }); // idempotent
    const r = (await db.select().from(ipdBedReservations).where(eq(ipdBedReservations.id, held.reservationId)))[0]!;
    expect(r.status).toBe("lapsed");
    expect((await bedRow(bedId)).status).toBe("available");
    await expect(assignBed(db, w.desk, assignInput(bedId, await w.patient("male")))).resolves.toMatchObject({ bedId });
  });

  it("(iv) block is refused on an occupied bed and becomes block-on-release, applied when the bed empties", async () => {
    const bedId = (await markIncumbent(w, ["T-OCC"]))[0]!;
    const block = await blockBed(db, w.desk, {
      idempotencyKey: randomUUID(), bedId, reason: "maintenance", note: "Rail broken", expectedReturnAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(block.status).toBe("block_on_release");
    expect((await bedRow(bedId)).status).toBe("occupied");
    const released = await releaseIncumbentBed(db, w.desk, { idempotencyKey: randomUUID(), bedId });
    expect(released.bedStatus).toBe("blocked");
    expect((await bedRow(bedId)).status).toBe("blocked");
    const b = (await db.select().from(ipdBedBlocks).where(eq(ipdBedBlocks.id, block.blockId)))[0]!;
    expect(b.status).toBe("active");
  });

  it("(v) a bed retired while reserved is refused", async () => {
    const bedId = await w.bed("T-RET");
    await reserveBed(db, w.desk, assignInput(bedId, await w.patient("female")));
    await expect(retireBed(db, w.desk, { bedId, reason: "ward rebuilt" }))
      .rejects.toMatchObject({ code: "bed_reserved" });
    expect((await bedRow(bedId)).status).toBe("available");
  });

  it("(vi) an overflow assignment without the duty manager's permission is refused; with it, it succeeds", async () => {
    const bedId = await w.bed("T-OVF", { class: "overflow", overflow: true });
    const p = await w.patient("male");
    await expect(assignBed(db, w.desk, assignInput(bedId, p)))
      .rejects.toMatchObject({ code: "overflow_needs_duty_manager", bedRule: "Overflow bed" });
    await expect(assignBed(db, w.dutyManager, assignInput(bedId, p))).resolves.toMatchObject({ bedId, billedClass: "general" });
  });

  it("(vii) every bed rule refuses through the intent itself, with no screen in the way", async () => {
    const child = await w.patient("female", 8);
    const woman = await w.patient("female", 40);
    const man = await w.patient("male", 40);
    const cases: [string, Record<string, unknown>, string, IpdBedNeed, string, string][] = [
      ["T-R-M", { genderRule: "male" }, woman, GENERAL, "bed_gender_mismatch", "Male-only bed"],
      ["T-R-P", { genderRule: "paediatric" }, woman, GENERAL, "bed_age_mismatch", "Paediatric bed"],
      ["T-R-AW", { genderRule: "female" }, child, GENERAL, "bed_age_mismatch", "Adult ward bed"],
      ["T-R-PVT", { class: "private" }, woman, GENERAL, "bed_class_mismatch", "Private room bed"],
      ["T-R-ISO", { isolation: "contact" }, woman, { ...GENERAL, isolation: "airborne" }, "bed_isolation_mismatch", "Contact isolation only"],
      ["T-R-ICU", { class: "icu", icu: true }, woman, { ...GENERAL, requestedClass: "icu" }, "bed_class_mismatch", "ICU bed"],
    ];
    for (const [code, attrs, patient, need, refusal, rule] of cases) {
      const bedId = await w.bed(code, attrs);
      await expect(assignBed(db, w.desk, assignInput(bedId, patient, need))).rejects.toMatchObject({ code: refusal, bedRule: rule });
    }
    // A flagged upgrade passes the class rule.
    const pvt = await w.bed("T-R-UP", { class: "private" });
    await expect(assignBed(db, w.desk, { ...assignInput(pvt, woman), classChange: "upgrade" })).resolves.toMatchObject({ bedId: pvt });
    // Twin-share room: the first occupant fixes the room's gender until it is empty.
    const r1 = await w.bed("T-R-T1", {}, "room");
    const r2 = await w.bed("T-R-T2", {}, "room");
    await assignBed(db, w.desk, assignInput(r1, man));
    await expect(assignBed(db, w.desk, assignInput(r2, await w.patient("female"))))
      .rejects.toMatchObject({ code: "bed_gender_mismatch", bedRule: "Shared room is male" });
    // And the permission is re-checked inside: a viewer cannot assign by calling the function.
    await expect(assignBed(db, w.viewer, assignInput(await w.bed("T-R-V"), woman))).rejects.toMatchObject({ code: "ipd_forbidden" });
  });

  async function markIncumbent(world: BedWorld, codes: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const c of codes) ids.push(await world.bed(c));
    const report = await markIncumbentBeds(db, world.desk, codes.map((code) => ({ code })), { apply: true });
    expect(report.problems).toEqual([]);
    return ids;
  }
});
