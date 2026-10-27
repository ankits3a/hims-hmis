import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { alerts, events } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkWardWorld } from "../../../../test/helpers/ipd";
import {
  acceptHandover, assignNurse, endMyDuty, moveFloatNurse, publishShiftMap, readBedBoard, readFloatPool, readMyShift,
  readNurseStation, readWardCockpit, saveShiftMap, setAcuity, startTransfer, sweepWardShifts,
} from "../index";
import { IpdError, IpdRefusal } from "../errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { WardWorld } from "../../../../test/helpers/ipd";

/**
 * SPEC #982 — WARD WM-1: SHIFT ASSIGNMENT, RATIO AND ACUITY, IN-CHARGE COCKPIT (docs/specs/982-ward-assignment.md;
 * rulings decision 0089). One block per "Done means" id, D1–D7. Every act and read takes an EXPLICIT instant in IST;
 * nothing here reads the real clock. Nursing shifts are 08–14 (morning), 14–20 (evening) and 20–08 (night) IST; a
 * shift's date is the IST date it starts on. Every name is made up.
 */

jest.setTimeout(240_000);

const DAY = "2026-03-10";
const ist = (s: string): Date => new Date(`${s}+05:30`);
const at = (hhmm: string): Date => ist(`${DAY}T${hhmm}:00`);
const key = (): string => randomUUID();
const SBAR = { situation: "Stable", background: "Pneumonia", assessment: "Vitals in range", recommendation: "Routine observations" };

type Bed = { bedId: string; nurseId: string; studentId?: string };
type Staff = { userId: string; kind: "rn" | "student" | "incharge" | "float"; pairedWithId?: string };

async function refusalOf(p: Promise<unknown>): Promise<IpdRefusal | IpdError> {
  try { await p; } catch (e) { if (e instanceof IpdRefusal || e instanceof IpdError) return e; throw e; }
  throw new Error("expected a refusal, the act succeeded");
}

describe("spec #982 WM-1 ward assignment — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: WardWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkWardWorld(db);
  });

  const rn = (a: Actor): Staff => ({ userId: a.id, kind: "rn" });
  const save = (beds: Bed[], staff: Staff[], o: { wardId?: string; shift?: "morning" | "evening" | "night"; now?: Date } = {}) =>
    saveShiftMap(db, w.incharge, {
      idempotencyKey: key(), wardId: o.wardId ?? w.wardId, shiftDate: DAY, shift: o.shift ?? "morning", staff, beds,
    }, { now: o.now ?? at("07:00") });
  const publish = (mapId: string, now = at("07:20"), actor = w.incharge) =>
    publishShiftMap(db, actor, { idempotencyKey: key(), mapId }, { now });
  const publishMorning = async (beds: Bed[], staff: Staff[], wardId?: string) => publish((await save(beds, staff, { wardId })).mapId);
  /** Ward-1 beds `n` occupied at 06:00 IST. */
  const occupied = async (n: number, prefix = "W1") => {
    const out: { bedId: string; admissionId: string }[] = [];
    for (let i = 1; i <= n; i += 1) {
      const bedId = await w.bed(`${prefix}-B${String(i).padStart(2, "0")}`);
      out.push({ bedId, ...(await w.admitOn(bedId, at("06:00"))) });
    }
    return out;
  };
  const noticesTo = async (userId: string, kind: string) => db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.kind, kind)));
  const eventsNamed = async (name: string) => db.select().from(events).where(eq(events.name, name));
  const cockpit = (now: Date, wardId = w.wardId, actor = w.incharge) => readWardCockpit(db, actor, { wardId, now });
  const assign = (actor: Actor, bedId: string, nurseId: string, now: Date, reason?: string) =>
    assignNurse(db, actor, { idempotencyKey: key(), bedId, nurseId, ...(reason === undefined ? {} : { reason }) }, { now });

  describe("spec #982 D1 — a published shift gives every occupied bed exactly one registered nurse", () => {
    it("publish refuses an occupied bed with no nurse and a student as a bed's only nurse; a paired student publishes", async () => {
      const [a, b, c] = await occupied(3);
      const free = await w.bed("W1-B09");
      const staff = [rn(w.nurse), rn(w.nurse2), { userId: w.student.id, kind: "student" as const, pairedWithId: w.nurse2.id }];

      const gap = await save([{ bedId: a!.bedId, nurseId: w.nurse.id }, { bedId: b!.bedId, nurseId: w.nurse2.id }], staff);
      const unassigned = await refusalOf(publish(gap.mapId));
      expect(unassigned.code).toBe("bed_unassigned");
      expect((unassigned as IpdRefusal).detail?.bedIds).toEqual([c!.bedId]);

      const alone = await save([
        { bedId: a!.bedId, nurseId: w.nurse.id }, { bedId: b!.bedId, nurseId: w.nurse2.id }, { bedId: c!.bedId, nurseId: w.student.id },
      ], staff);
      expect(alone.mapId).toBe(gap.mapId); // one draft per ward, date and shift: saving again replaces it
      expect((await refusalOf(publish(alone.mapId))).code).toBe("student_alone");

      const good = await save([
        { bedId: a!.bedId, nurseId: w.nurse.id }, { bedId: b!.bedId, nurseId: w.nurse2.id },
        { bedId: c!.bedId, nurseId: w.nurse2.id, studentId: w.student.id },
      ], staff);
      expect(await publish(good.mapId)).toMatchObject({ mapId: good.mapId, status: "published", late: false });
      expect(await eventsNamed("ipd.nursing.shift_map_published")).toHaveLength(1);

      const view = await cockpit(at("08:30"));
      expect(view.map?.status).toBe("published");
      const occupiedBeds = view.beds.filter((x) => x.admissionId !== null);
      expect(occupiedBeds).toHaveLength(3);
      expect(occupiedBeds.map((x) => x.nurse?.userId).sort()).toEqual([w.nurse.id, w.nurse2.id, w.nurse2.id].sort());
      expect(occupiedBeds.every((x) => x.unassigned === false)).toBe(true);
      expect(view.beds.find((x) => x.bedId === c!.bedId)?.student?.userId).toBe(w.student.id);
      expect(view.beds.find((x) => x.bedId === free)?.nurse ?? null).toBeNull();
    });

    it("a publish after the deadline (30 minutes before the shift) still publishes, flagged late", async () => {
      const [a] = await occupied(1);
      const d = await save([{ bedId: a!.bedId, nurseId: w.nurse.id }], [rn(w.nurse)]);
      expect(await publish(d.mapId, at("07:45"))).toMatchObject({ status: "published", late: true });
    });
  });

  describe("spec #982 D2 — nothing published by shift start: the previous map carries over and the supervisor is told", () => {
    it("carries the morning map into the evening once, tells the supervisor once, and leaves a ward that published alone", async () => {
      const [a, b] = await occupied(2);
      await publishMorning([{ bedId: a!.bedId, nurseId: w.nurse.id }, { bedId: b!.bedId, nurseId: w.nurse2.id }], [rn(w.nurse), rn(w.nurse2)]);
      // Ward 2 publishes both its shifts in time: nothing of it carries over.
      const w2bed = await w.bed2("W2-B01");
      await w.admitOn(w2bed, at("06:00"));
      await publishMorning([{ bedId: w2bed, nurseId: w.floater.id }], [rn(w.floater)], w.ward2Id);
      const evening2 = await save([{ bedId: w2bed, nurseId: w.floater.id }], [rn(w.floater)], { wardId: w.ward2Id, shift: "evening", now: at("13:00") });
      await publish(evening2.mapId, at("13:10"));

      expect(await sweepWardShifts(db, at("13:59"))).toMatchObject({ carriedOver: 0, failed: 0 });
      expect(await sweepWardShifts(db, ist(`${DAY}T14:00:30`))).toMatchObject({ carriedOver: 1, failed: 0 });
      expect(await sweepWardShifts(db, ist(`${DAY}T14:01:30`))).toMatchObject({ carriedOver: 0, failed: 0 });

      const view = await cockpit(at("14:05"));
      expect(view.shift.key).toBe("evening");
      expect(view.map?.status).toBe("carried_over");
      expect(Object.fromEntries(view.beds.filter((x) => x.admissionId !== null).map((x) => [x.bedId, x.nurse?.userId])))
        .toEqual({ [a!.bedId]: w.nurse.id, [b!.bedId]: w.nurse2.id });
      expect(await noticesTo(w.supervisor.id, "ipd.shift_map_carried")).toHaveLength(1);
      expect(await eventsNamed("ipd.nursing.shift_map_carried_over")).toHaveLength(1);
      expect((await cockpit(at("14:05"), w.ward2Id)).map?.status).toBe("published");
    });
  });

  describe("spec #982 D3 — a bed admitted or transferred in with no nurse shows red until assigned", () => {
    it("the Beds board and the cockpit show the new bed red, suggest the lowest-load nurse, and turn when assigned", async () => {
      const [a, b, c] = await occupied(3);
      await publishMorning([
        { bedId: a!.bedId, nurseId: w.nurse.id }, { bedId: b!.bedId, nurseId: w.nurse.id }, { bedId: c!.bedId, nurseId: w.nurse2.id },
      ], [rn(w.nurse), rn(w.nurse2)]);

      // A new admission after the publish lands on a bed nobody holds.
      const fresh = await w.bed("W1-B07");
      await w.admitOn(fresh, at("09:00"));
      // A transfer in from ward 2 lands on another.
      const w2bed = await w.bed2("W2-B01");
      const moving = await w.admitOn(w2bed, at("06:00"));
      const target = await w.bed("W1-B08");
      const started = await startTransfer(db, w.sender, { idempotencyKey: key(), admissionId: moving.admissionId, toBedId: target, reason: "bed_management", handover: SBAR }, { now: at("09:10") });
      await acceptHandover(db, w.receiver, { idempotencyKey: key(), transferId: started.transferId }, { now: at("09:20") });

      const tile = async (bedId: string, now: Date) =>
        (await readBedBoard(db, w.incharge, { now })).floors.flatMap((f) => f.wards).flatMap((x) => x.beds).find((x) => x.id === bedId)!;
      for (const bedId of [fresh, target]) expect(await tile(bedId, at("09:30"))).toMatchObject({ status: "occupied", nurse: null, nurseMissing: true });
      expect(await tile(a!.bedId, at("09:30"))).toMatchObject({ nurseMissing: false, nurse: { initials: expect.any(String) } });

      const view = await cockpit(at("09:30"));
      const red = view.beds.filter((x) => x.unassigned);
      expect(red.map((x) => x.bedId).sort()).toEqual([fresh, target].sort());
      // nurse holds two beds, nurse2 one: the suggestion is the lighter load.
      expect(red.every((x) => x.suggestedNurseId === w.nurse2.id)).toBe(true);

      // The sweep tells the in-charge once per unassigned bed per shift.
      expect(await sweepWardShifts(db, at("09:31"))).toMatchObject({ unassignedBeds: 2, failed: 0 });
      expect(await sweepWardShifts(db, at("09:32"))).toMatchObject({ unassignedBeds: 0, failed: 0 });
      expect(await noticesTo(w.incharge.id, "ipd.bed_unassigned")).toHaveLength(2);

      // A first assignment needs no reason; the tile turns.
      await assign(w.incharge, fresh, w.nurse2.id, at("09:40"));
      await assign(w.incharge, target, w.nurse2.id, at("09:41"));
      for (const bedId of [fresh, target]) expect(await tile(bedId, at("09:45"))).toMatchObject({ nurseMissing: false, nurse: { initials: expect.any(String) } });
      expect((await cockpit(at("09:45"))).beds.filter((x) => x.unassigned)).toEqual([]);
    });
  });

  describe("spec #982 D4 — no end of duty with beds still held; a reassignment needs a reason and tells both nurses", () => {
    it("refuses end of duty until each bed is with a named registered nurse; reassignments carry a reason", async () => {
      const [a, b, c] = await occupied(3);
      await publishMorning([
        { bedId: a!.bedId, nurseId: w.nurse.id }, { bedId: b!.bedId, nurseId: w.nurse.id }, { bedId: c!.bedId, nurseId: w.nurse2.id },
      ], [rn(w.nurse), rn(w.nurse2), rn(w.nurse3), { userId: w.student.id, kind: "student", pairedWithId: w.nurse2.id }]);

      const held = await refusalOf(endMyDuty(db, w.nurse, { idempotencyKey: key(), wardId: w.wardId }, { now: at("10:00") }));
      expect(held.code).toBe("beds_still_assigned");
      expect(((held as IpdRefusal).detail?.bedIds as string[]).sort()).toEqual([a!.bedId, b!.bedId].sort());

      expect((await refusalOf(assign(w.incharge, a!.bedId, w.nurse2.id, at("10:05")))).code).toBe("reassign_reason_required");
      expect((await refusalOf(assign(w.incharge, a!.bedId, w.student.id, at("10:05"), "Short of staff"))).code).toBe("student_alone");

      await assign(w.incharge, a!.bedId, w.nurse2.id, at("10:10"), "Nurse going off sick");
      expect(await noticesTo(w.nurse.id, "ipd.bed_reassigned")).toHaveLength(1);
      expect(await noticesTo(w.nurse2.id, "ipd.bed_reassigned")).toHaveLength(1);
      const moved = await eventsNamed("ipd.nursing.bed_reassigned");
      expect(moved).toHaveLength(1);
      expect(moved[0]!.payload).toMatchObject({ bedId: a!.bedId, fromNurseId: w.nurse.id, toNurseId: w.nurse2.id, reason: "Nurse going off sick" });

      // The nurse hands her last bed over herself.
      await assign(w.nurse, b!.bedId, w.nurse3.id, at("10:20"), "End of duty handover");
      expect(await endMyDuty(db, w.nurse, { idempotencyKey: key(), wardId: w.wardId }, { now: at("10:30") })).toMatchObject({ endedAt: at("10:30").toISOString() });
      expect(await eventsNamed("ipd.nursing.duty_ended")).toHaveLength(1);
      expect((await readMyShift(db, w.nurse, { wardId: w.wardId, now: at("10:35") })).patients).toEqual([]);
      const ended = (await cockpit(at("10:35"))).staff.find((s) => s.userId === w.nurse.id);
      expect(ended?.endedAt).toBe(at("10:30").toISOString());
    });
  });

  describe("spec #982 D5 — the ratio is computed from acuity against the table; one breach event and alert per ward per shift", () => {
    it("a ventilated patient needs her own nurse; the breach is told once a shift and never blocks an admission", async () => {
      const beds = await occupied(5);
      // 5 patients for 1 registered nurse is inside the general ward's day 1:6 — until one is ventilated.
      await setAcuity(db, w.nurse, { idempotencyKey: key(), admissionId: beds[0]!.admissionId, level: "full_care", ventilated: true }, { now: at("07:00") });
      for (const x of beds.slice(1)) {
        await setAcuity(db, w.nurse, { idempotencyKey: key(), admissionId: x.admissionId, level: "self_care" }, { now: at("07:00") });
      }
      const published = await publishMorning(beds.map((x) => ({ bedId: x.bedId, nurseId: w.nurse.id })), [rn(w.nurse)]);
      expect(published.ratioBreach).toBe(true);

      const view = await cockpit(at("08:30"));
      expect(view.ratio).toMatchObject({ unit: "general", night: false, patientsPerRn: 6, patients: 5, rnsOnDuty: 1, rnsNeeded: 2, breach: true });
      // Load is the sum of acuity points: full care 2 + four self-care 1.
      expect(view.loads.find((l) => l.userId === w.nurse.id)).toMatchObject({ beds: 5, points: 6 });
      expect(await eventsNamed("ipd.nursing.ratio_breached")).toHaveLength(1);
      expect(await noticesTo(w.supervisor.id, "ipd.ratio_breach")).toHaveLength(1);

      // The breach never blocks: a sixth admission goes through; assigning it and the sweep say nothing new this shift.
      const sixth = await w.bed("W1-B06");
      await w.admitOn(sixth, at("09:00"));
      await assign(w.incharge, sixth, w.nurse.id, at("09:05"));
      await sweepWardShifts(db, at("09:10"));
      expect(await eventsNamed("ipd.nursing.ratio_breached")).toHaveLength(1);
      expect(await noticesTo(w.supervisor.id, "ipd.ratio_breach")).toHaveLength(1);

      // A new shift is a new breach: the carried-over evening map breaches once more.
      await sweepWardShifts(db, ist(`${DAY}T14:00:30`));
      await sweepWardShifts(db, ist(`${DAY}T14:01:30`));
      expect(await eventsNamed("ipd.nursing.ratio_breached")).toHaveLength(2);
      expect(await noticesTo(w.supervisor.id, "ipd.ratio_breach")).toHaveLength(2);
    });

    it("the night value applies at night", async () => {
      const [a] = await occupied(1);
      const d = await save([{ bedId: a!.bedId, nurseId: w.nurse.id }], [rn(w.nurse)], { shift: "night", now: at("19:00") });
      await publish(d.mapId, at("19:20"));
      expect((await cockpit(at("21:00"))).ratio).toMatchObject({ unit: "general", night: true, patientsPerRn: 8, breach: false });
    });
  });

  describe("spec #982 D6 — the supervisor floats a nurse to another ward for a shift; the move is recorded and her beds count there", () => {
    it("lists the least-loaded nurses on the floor, moves one with a reason, and counts her on the receiving ward", async () => {
      const [a, b] = await occupied(2);
      await publishMorning([{ bedId: a!.bedId, nurseId: w.nurse.id }, { bedId: b!.bedId, nurseId: w.nurse.id }], [rn(w.nurse)]);
      const w2bed = await w.bed2("W2-B01");
      await w.admitOn(w2bed, at("06:00"));
      await publishMorning([{ bedId: w2bed, nurseId: w.nurse2.id }], [rn(w.nurse2), rn(w.floater)], w.ward2Id);

      const pool = await readFloatPool(db, w.supervisor, { floorId: w.floorId, now: at("09:00") });
      expect(pool.nurses[0]).toMatchObject({ userId: w.floater.id, wardId: w.ward2Id, beds: 0, points: 0 });

      const input = { idempotencyKey: key(), userId: w.floater.id, toWardId: w.wardId, shiftDate: DAY, shift: "morning" as const, reason: "Ward 1 short" };
      expect((await refusalOf(moveFloatNurse(db, w.incharge, input, { now: at("09:05") }))).code).toBe("ipd_forbidden");
      await moveFloatNurse(db, w.supervisor, input, { now: at("09:05") });
      const moved = await eventsNamed("ipd.nursing.float_moved");
      expect(moved).toHaveLength(1);
      expect(moved[0]!.payload).toMatchObject({ userId: w.floater.id, fromWardId: w.ward2Id, toWardId: w.wardId, reason: "Ward 1 short" });

      await assign(w.incharge, b!.bedId, w.floater.id, at("09:10"), "Float nurse arrived");
      const here = await cockpit(at("09:15"));
      expect(here.ratio.rnsOnDuty).toBe(2);
      expect(here.staff.find((s) => s.userId === w.floater.id)).toMatchObject({ kind: "float", homeWardId: w.ward2Id });
      expect(here.loads.find((l) => l.userId === w.floater.id)).toMatchObject({ beds: 1 });
      expect((await cockpit(at("09:15"), w.ward2Id)).ratio.rnsOnDuty).toBe(1);
      expect((await readMyShift(db, w.floater, { wardId: w.wardId, now: at("09:15") })).patients.map((p) => p.identity.admissionId)).toEqual([b!.admissionId]);
    });
  });

  describe("spec #982 D7 — My shift and the nurse station list exactly the beds assigned to that nurse", () => {
    it("before a publish the ward's list, labelled; after it, each nurse's own beds", async () => {
      const [a, b, c] = await occupied(3);
      const before = await readMyShift(db, w.nurse, { wardId: w.wardId, now: at("07:00") });
      expect(before.assignment).toBe("ward");
      expect(before.patients).toHaveLength(3);

      await publishMorning([
        { bedId: a!.bedId, nurseId: w.nurse.id }, { bedId: b!.bedId, nurseId: w.nurse.id },
        { bedId: c!.bedId, nurseId: w.nurse2.id, studentId: w.student.id },
      ], [rn(w.nurse), rn(w.nurse2), { userId: w.student.id, kind: "student", pairedWithId: w.nurse2.id }]);

      const mine = async (actor: Actor) => {
        const s = await readMyShift(db, actor, { wardId: w.wardId, now: at("09:00") });
        expect(s.assignment).toBe("mine");
        return s.patients.map((p) => p.identity.admissionId).sort();
      };
      expect(await mine(w.nurse)).toEqual([a!.admissionId, b!.admissionId].sort());
      expect(await mine(w.nurse2)).toEqual([c!.admissionId]);
      expect(await mine(w.student)).toEqual([c!.admissionId]);

      const station = await readNurseStation(db, w.nurse, { wardId: w.wardId, now: at("09:00"), mine: true });
      expect(station.beds.map((x) => x.bedId).sort()).toEqual([a!.bedId, b!.bedId].sort());
      const all = await readNurseStation(db, w.nurse, { wardId: w.wardId, now: at("09:00") });
      expect(all.beds).toHaveLength(3);
      expect(all.beds.find((x) => x.bedId === c!.bedId)?.nurse).toMatchObject({ userId: w.nurse2.id, initials: expect.any(String) });
    });
  });
});
