import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { opdDepartments, opdRooms } from "../../kernel/db/schema";
import {
  createDepartment, createDoctor, createRoom, doctorForUser, getDoctor, listDepartments, listRooms, updateDepartment, updateDoctor,
} from "./masters";
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
    const rows = await db.select().from(opdRooms).where(eq(opdRooms.code, "12"));
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
});
