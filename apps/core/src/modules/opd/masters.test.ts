import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, opdDepartments, opdDoctorSchedules, resourceStatusHistory, resources } from "../../kernel/db/schema";
import {
  createDepartment, createDoctor, createRoom, doctorForUser, getDoctor, listDepartments, listRooms, updateDepartment, updateDoctor, updateRoom,
} from "./masters";
import { replaceDoctorSchedules } from "./schedules";
import type { Db } from "../../kernel/db/client";

describe("opd masters", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); await seedOpdBase(db); });

  it("createDepartment inserts, listDepartments returns it; a duplicate code fails and leaves ONE row", async () => {
    const admin = await mkUser(db, "admin1", ["opd_admin"]);
    await withTx(db, (tx) => createDepartment(tx, admin.actor, { code: "MED", name: "General Medicine" }));
    const list = await listDepartments(db);
    expect(list.map((d) => d.code)).toEqual(["MED"]);

    await expect(
      withTx(db, (tx) => createDepartment(tx, admin.actor, { code: "MED", name: "Duplicate Medicine" })),
    ).rejects.toMatchObject({ code: "duplicate_department_code" });
    const rows = await db.select().from(opdDepartments).where(eq(opdDepartments.code, "MED"));
    expect(rows).toHaveLength(1);
  });

  it("createRoom inserts, listRooms returns it; a duplicate code fails and leaves ONE row", async () => {
    const admin = await mkUser(db, "admin2", ["opd_admin"]);
    await withTx(db, (tx) => createRoom(tx, admin.actor, { code: "12", name: "Room 12" }));
    const list = await listRooms(db);
    expect(list.map((r) => r.code)).toEqual(["12"]);

    await expect(
      withTx(db, (tx) => createRoom(tx, admin.actor, { code: "12", name: "Duplicate Room" })),
    ).rejects.toMatchObject({ code: "duplicate_room_code" });
    // PLAN 13 T6 — the row lives in `resources` now; `createRoom`'s refusal code is unchanged, which
    // is DD9's whole promise (the controller and the screen above it never learn a table moved).
    const rows = await db.select().from(resources).where(eq(resources.code, "12"));
    expect(rows).toHaveLength(1);
  });

  it("createDoctor resolves the username; refuses unknown_user, user_already_doctor, department_inactive", async () => {
    const admin = await mkUser(db, "admin3", ["opd_admin"]);
    const { deptId } = await seedOpdMasters(db);
    const doc1 = await mkUser(db, "doc1", ["doctor"]);

    const { doctorId, userId } = await withTx(db, (tx) =>
      createDoctor(tx, admin.actor, { username: "doc1", displayName: "Dr One", departmentId: deptId }),
    );
    expect(userId).toBe(doc1.id);
    expect(typeof doctorId).toBe("string");

    await expect(
      withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "no_such_user", displayName: "X", departmentId: deptId })),
    ).rejects.toMatchObject({ code: "unknown_user" });

    await expect(
      withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "doc1", displayName: "Dr One Again", departmentId: deptId })),
    ).rejects.toMatchObject({ code: "user_already_doctor" });

    await withTx(db, (tx) => updateDepartment(tx, admin.actor, deptId, { active: false }));
    const doc2 = await mkUser(db, "doc2", ["doctor"]);
    await expect(
      withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "doc2", displayName: "Dr Two", departmentId: deptId })),
    ).rejects.toMatchObject({ code: "department_inactive" });
    void doc2;
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * FD-29 — THE DOCTOR ID, WHICH THE PRESCRIPTION PRINTS AND NOBODY TYPES
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Owner, 2026-09-06: the A4 letterhead names the prescriber by id, not by name and council number.
   * That is only safe if EVERY doctor has an id, which is why the column is NOT NULL and why it is
   * minted rather than asked for. These rows pin the four things that makes true.
   */
  describe("the minted doctor id", () => {
    it("mints DR-0001 upward, and steps past a RETIRED doctor's id rather than reissuing it", async () => {
      const admin = await mkUser(db, "admin-code-1", ["opd_admin"]);
      const { deptId } = await seedOpdMasters(db);
      await mkUser(db, "codedoc1", ["doctor"]);
      await mkUser(db, "codedoc2", ["doctor"]);
      await mkUser(db, "codedoc3", ["doctor"]);

      const a = await withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "codedoc1", displayName: "Dr A", departmentId: deptId }));
      const b = await withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "codedoc2", displayName: "Dr B", departmentId: deptId }));
      expect((await getDoctor(db, a.doctorId))?.code).toBe("DR-0001");
      expect((await getDoctor(db, b.doctorId))?.code).toBe("DR-0002");

      /*
        RETIRE the highest and mint again. This is what actually happens when a doctor leaves — there
        is no delete route — and the id must NOT come back: a prescription is paper that outlives an
        employment, and a reissued id makes an old sheet name the wrong person. A COUNT-based
        sequence, or one that filtered to `active`, would hand DR-0002 to Dr C.
      */
      await withTx(db, (tx) => updateDoctor(tx, admin.actor, b.doctorId, { active: false }));
      const c = await withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "codedoc3", displayName: "Dr C", departmentId: deptId }));
      expect((await getDoctor(db, c.doctorId))?.code).toBe("DR-0003");
      expect((await getDoctor(db, b.doctorId))?.code).toBe("DR-0002");
    });

    it("takes a college's own faculty number when one is supplied, and does not let it derail the sequence", async () => {
      const admin = await mkUser(db, "admin-code-2", ["opd_admin"]);
      const { deptId } = await seedOpdMasters(db);
      await mkUser(db, "codedoc4", ["doctor"]);
      await mkUser(db, "codedoc5", ["doctor"]);

      const own = await withTx(db, (tx) =>
        createDoctor(tx, admin.actor, { username: "codedoc4", displayName: "Dr D", departmentId: deptId, code: "  CRK/FAC/0114  " }));
      expect((await getDoctor(db, own.doctorId))?.code).toBe("CRK/FAC/0114");

      /* The minter reads only `DR-nnnn`, so a hospital's own numbering alongside it is invisible to
         the sequence rather than something the sequence tries to parse. */
      const next = await withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "codedoc5", displayName: "Dr E", departmentId: deptId }));
      expect((await getDoctor(db, next.doctorId))?.code).toBe("DR-0001");
    });

    /**
     * THE CASE THAT SEPARATES MAX FROM COUNT, and the reason this row exists rather than the
     * retirement row above: retiring a doctor leaves the row in place, so a count and a max agree
     * and a `count(*)` mutant survives. They part company the moment a DR- number is SET rather
     * than minted — an admin matching the hospital's existing paper register, which is exactly when
     * this happens in a hospital that has been running on paper.
     */
    it("steps past a DR- number an admin set by hand, instead of colliding with it", async () => {
      const admin = await mkUser(db, "admin-code-5", ["opd_admin"]);
      const { deptId } = await seedOpdMasters(db);
      await mkUser(db, "codedoc9", ["doctor"]);
      await mkUser(db, "codedoc10", ["doctor"]);

      await withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "codedoc9", displayName: "Dr I", departmentId: deptId, code: "DR-0114" }));
      const after = await withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "codedoc10", displayName: "Dr J", departmentId: deptId }));
      // A count would say "one doctor, so DR-0002" and hand out a number BELOW one already issued.
      expect((await getDoctor(db, after.doctorId))?.code).toBe("DR-0115");
    });

    it("refuses a blank id, and refuses to reuse one another doctor already holds", async () => {
      const admin = await mkUser(db, "admin-code-3", ["opd_admin"]);
      const { deptId } = await seedOpdMasters(db);
      await mkUser(db, "codedoc6", ["doctor"]);
      await mkUser(db, "codedoc7", ["doctor"]);
      const first = await withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "codedoc6", displayName: "Dr F", departmentId: deptId }));

      await expect(
        withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "codedoc7", displayName: "Dr G", departmentId: deptId, code: "   " })),
      ).rejects.toMatchObject({ code: "invalid_doctor_code" });

      /* `opd_doctors_code_ux`, not a read-then-write check: two admins creating a doctor at once
         must not both pass a "is it taken" query and then both insert. */
      await expect(
        withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "codedoc7", displayName: "Dr G", departmentId: deptId, code: "DR-0001" })),
      ).rejects.toThrow();
      expect((await getDoctor(db, first.doctorId))?.code).toBe("DR-0001");
    });

    it("lets an admin change the id but never clear it", async () => {
      const admin = await mkUser(db, "admin-code-4", ["opd_admin"]);
      const { deptId } = await seedOpdMasters(db);
      await mkUser(db, "codedoc8", ["doctor"]);
      const { doctorId } = await withTx(db, (tx) => createDoctor(tx, admin.actor, { username: "codedoc8", displayName: "Dr H", departmentId: deptId }));

      await withTx(db, (tx) => updateDoctor(tx, admin.actor, doctorId, { code: "CRK/FAC/0207" }));
      expect((await getDoctor(db, doctorId))?.code).toBe("CRK/FAC/0207");

      await expect(
        withTx(db, (tx) => updateDoctor(tx, admin.actor, doctorId, { code: "" })),
      ).rejects.toMatchObject({ code: "invalid_doctor_code" });
      expect((await getDoctor(db, doctorId))?.code).toBe("CRK/FAC/0207");
    });
  });

  it("doctorForUser finds the profile; updateDoctor(active:false) then getDoctor shows inactive", async () => {
    const admin = await mkUser(db, "admin4", ["opd_admin"]);
    const { deptId } = await seedOpdMasters(db);
    const doc3 = await mkUser(db, "doc3", ["doctor"]);
    const { doctorId } = await withTx(db, (tx) =>
      createDoctor(tx, admin.actor, { username: "doc3", displayName: "Dr Three", departmentId: deptId }),
    );

    const found = await doctorForUser(db, doc3.id);
    expect(found?.id).toBe(doctorId);

    await withTx(db, (tx) => updateDoctor(tx, admin.actor, doctorId, { active: false }));
    const row = await getDoctor(db, doctorId);
    expect(row?.active).toBe(false);
  });

  it("non-user actors are refused with user_actor_required", async () => {
    const systemActor = { type: "system" as const, id: "sys" };
    await expect(
      withTx(db, (tx) => createDepartment(tx, systemActor, { code: "SYS", name: "System" })),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });

  // ══════════════════ PLAN 13 T6 / DD9 — THE MAPPER, AND THE TWO FIELDS IT DERIVES ══════════════════

  /**
   * **A8 and A9 at the MAPPER end.** The migration writes `floor` into `attributes` and `active`
   * into `status`; these legs prove the OPD side reads them back the same way. **The migration and
   * the mapper must agree, and this is where that agreement is measured** — a backfill that got
   * either mapping wrong and a mapper that got it wrong the same way would agree with each other
   * and with nothing else.
   *
   * **PRODUCTION HAS ZERO ROOMS WITH A FLOOR AND ZERO INACTIVE ROOMS** (spike Q1, re-measured at
   * kickoff: two SYN rooms, `floor` NULL and `active` true on both). A fixture shaped like
   * production therefore exercises NEITHER field. §2.102 in one sentence: name the field whose value
   * coincides across every production row, and build the leg where it differs.
   */
  it("A8: `floor` round-trips through attributes, and a room with NO floor reads null rather than a null-valued key", async () => {
    const admin = await mkUser(db, "adminA8", ["opd_admin"]);
    await withTx(db, (tx) => createRoom(tx, admin.actor, { code: "F2", name: "Second floor room", floor: "2" }));
    await withTx(db, (tx) => createRoom(tx, admin.actor, { code: "F0", name: "No floor room" }));

    const byCode = new Map((await listRooms(db)).map((r) => [r.code, r]));
    expect(byCode.get("F2")?.floor).toBe("2");
    expect(byCode.get("F0")?.floor).toBeNull();

    // THE STORED SHAPE, not just the mapped one. `{}` and NOT `{"floor": null}` — a field that
    // exists and says nothing is a field every later reader has to special-case, and `0032` writes
    // the same shape for the same reason.
    const rows = await db.select().from(resources).where(eq(resources.kind, "room"));
    const attrs = new Map(rows.map((r) => [r.code, r.attributes]));
    expect(attrs.get("F2")).toEqual({ floor: "2" });
    expect(attrs.get("F0")).toEqual({});

    // …and it round-trips through an UPDATE in both directions, including being cleared.
    const f2 = byCode.get("F2")!;
    await withTx(db, (tx) => updateRoom(tx, admin.actor, f2.id, { floor: "3" }));
    expect((await listRooms(db)).find((r) => r.code === "F2")?.floor).toBe("3");
    await withTx(db, (tx) => updateRoom(tx, admin.actor, f2.id, { floor: null }));
    expect((await listRooms(db)).find((r) => r.code === "F2")?.floor).toBeNull();
    expect((await db.select().from(resources).where(eq(resources.id, f2.id)))[0]!.attributes).toEqual({});
  });

  it("A9: `active` IS a status and not a column — activeOnly excludes the retired room, and the row survives", async () => {
    const admin = await mkUser(db, "adminA9", ["opd_admin"]);
    const { roomId } = await withTx(db, (tx) => createRoom(tx, admin.actor, { code: "ON", name: "Open room" }));
    const { roomId: offId } = await withTx(db, (tx) => createRoom(tx, admin.actor, { code: "OFF", name: "Closing room" }));
    await withTx(db, (tx) => updateRoom(tx, admin.actor, offId, { active: false }));

    // The mapper's half.
    expect((await listRooms(db)).map((r) => [r.code, r.active])).toEqual([["OFF", false], ["ON", true]]);
    expect((await listRooms(db, { activeOnly: true })).map((r) => r.code)).toEqual(["ON"]);

    // The registry's half — `retired`, read from the row, with NO `active` column anywhere.
    const rows = await db.select().from(resources).where(eq(resources.kind, "room"));
    expect(new Map(rows.map((r) => [r.code, r.status]))).toEqual(new Map([["ON", "available"], ["OFF", "retired"]]));
    // DEACTIVATION IS NOT DELETION. Both rows are still there, and so is the id every schedule
    // and every queue session that ever named this room still holds.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([offId, roomId].sort());

    // …and it comes BACK. `active: true` returns the room to the kind's declared `initial`.
    await withTx(db, (tx) => updateRoom(tx, admin.actor, offId, { active: true }));
    expect((await listRooms(db, { activeOnly: true })).map((r) => r.code)).toEqual(["OFF", "ON"]);
  });

  it("A9: an unknown id is `unknown_room` — and so is a registry row of the WRONG KIND", async () => {
    const admin = await mkUser(db, "adminA9b", ["opd_admin"]);
    await expect(
      withTx(db, (tx) => updateRoom(tx, admin.actor, "NOSUCH", { name: "x" })),
    ).rejects.toMatchObject({ code: "unknown_room" });

    // A BED is a registry row with an id, and `updateRoom` must not administer it. Without the
    // `kind` half of the predicate this call would succeed and OPD would be editing a bed.
    await db.insert(resources).values({ id: "BED1", kind: "bed", code: "B1", name: "Bed 1", status: "available", createdBy: "t", updatedBy: "t" });
    await expect(
      withTx(db, (tx) => updateRoom(tx, admin.actor, "BED1", { name: "x" })),
    ).rejects.toMatchObject({ code: "unknown_room" });
    // …and it is not in the room book either.
    expect((await listRooms(db)).map((r) => r.code)).not.toContain("B1");
  });

  /**
   * **A10 at the CODE end** — the leg the migration cannot write for itself. A room created through
   * the NEW path exists in `resources` and in NO other table; a schedule created in it therefore
   * proves the foreign key names `resources` and holds. Against a `0032` that repointed only the
   * nullable `opd_queue_sessions` key, this insert violates the stale one.
   */
  it("A10: a schedule can be created in a room that exists ONLY in the registry — the NOT NULL FK names resources", async () => {
    const admin = await mkUser(db, "adminA10", ["opd_admin"]);
    const { deptId } = await seedOpdMasters(db);
    const doc = await mkUser(db, "docA10", ["doctor"]);
    const { doctorId } = await withTx(db, (tx) =>
      createDoctor(tx, admin.actor, { username: "docA10", displayName: "Dr Ten", departmentId: deptId }));
    const { roomId } = await withTx(db, (tx) => createRoom(tx, admin.actor, { code: "NEW-1", name: "Registry-only room" }));

    await withTx(db, (tx) => replaceDoctorSchedules(tx, admin.actor, doctorId, [
      { weekday: 1, startTime: "09:00", endTime: "12:00", roomId, validFrom: "2026-01-01" },
    ]));
    const rows = await db.select().from(opdDoctorSchedules).where(eq(opdDoctorSchedules.doctorId, doctorId));
    expect(rows.map((r) => r.roomId)).toEqual([roomId]);

    // …and a RETIRED room is refused by the schedule guard, which is DD2's predicate on the
    // schedules side rather than `active`.
    await withTx(db, (tx) => updateRoom(tx, admin.actor, roomId, { active: false }));
    await expect(
      withTx(db, (tx) => replaceDoctorSchedules(tx, admin.actor, doctorId, [
        { weekday: 2, startTime: "09:00", endTime: "12:00", roomId, validFrom: "2026-01-01" },
      ])),
    ).rejects.toMatchObject({ code: "unknown_room" });
  });

  it("A10: a schedule cannot name a registry row that is not a room", async () => {
    const admin = await mkUser(db, "adminA10b", ["opd_admin"]);
    const { deptId } = await seedOpdMasters(db);
    await mkUser(db, "docA10b", ["doctor"]);
    const { doctorId } = await withTx(db, (tx) =>
      createDoctor(tx, admin.actor, { username: "docA10b", displayName: "Dr Ten B", departmentId: deptId }));
    await db.insert(resources).values({ id: "FLOOR1", kind: "floor", code: "1", name: "First floor", status: "available", createdBy: "t", updatedBy: "t" });

    await expect(
      withTx(db, (tx) => replaceDoctorSchedules(tx, admin.actor, doctorId, [
        { weekday: 1, startTime: "09:00", endTime: "12:00", roomId: "FLOOR1", validFrom: "2026-01-01" },
      ])),
    ).rejects.toMatchObject({ code: "unknown_room" });
  });

  it("createRoom now leaves an audit trail where it left none — DD8's widening, in its first caller", async () => {
    const admin = await mkUser(db, "adminEv", ["opd_admin"]);
    const { roomId } = await withTx(db, (tx) => createRoom(tx, admin.actor, { code: "AUD", name: "Audited room" }));
    const names = (await db.select({ name: events.name }).from(events)).map((e) => e.name);
    expect(names).toContain("resource.registered");
    const history = await db.select().from(resourceStatusHistory).where(eq(resourceStatusHistory.resourceId, roomId));
    expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([[null, "available"]]);
  });
});
