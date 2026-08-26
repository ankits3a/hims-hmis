import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { eq } from "drizzle-orm";
import { opdAppointments, opdDoctors } from "../../kernel/db/schema";
import { newId } from "@hmis/contracts";
import { parseSearchQuery } from "@hmis/contracts";
import { appointmentSearchProvider, departmentSearchProvider, doctorSearchProvider } from "./search-providers";
import type { Actor, SearchChip } from "@hmis/contracts";
import type { SearchProvider, SearchProviderResult } from "../../kernel/search/types";
import type { Db } from "../../kernel/db/client";

describe("OPD search providers", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); await seedOpdBase(db); });

  async function run(
    p: SearchProvider, actor: Actor, text: string,
    over: { chips?: SearchChip[]; range?: { from: string; to: string }; limit?: number; now?: Date } = {},
  ): Promise<SearchProviderResult> {
    const limit = over.limit ?? 5;
    const query = { ...parseSearchQuery(text, limit), chips: over.chips ?? [], ...(over.range ? { range: over.range } : {}) };
    return p.run({ db, actor, query, limit, signal: new AbortController().signal, ...(over.now ? { now: over.now } : {}) });
  }

  describe("doctors", () => {
    it("matches on display name and carries the department", async () => {
      const { deptId, roomId } = await seedOpdMasters(db);
      await mkDoctor(db, { username: "mehra", departmentId: deptId, roomId, displayName: "Dr Mehra" });
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);

      // The assertion that matters: every doctor is stored as "Dr Something", so a desk types the
      // SURNAME. A first-word-only prefix match answers nothing here, which is what T3 measured.
      const res = await run(doctorSearchProvider, clerk.actor, "mehra");

      expect(res.hits.map((h) => h.title)).toEqual(["Dr Mehra"]);
      expect(res.hits[0]?.subtitle).toContain("General Medicine");
      expect(res.total).toBe(1);
    });

    it("a department chip narrows the list, and needs no typed text at all", async () => {
      const { deptId, dept2Id, roomId } = await seedOpdMasters(db);
      await mkDoctor(db, { username: "mehra", departmentId: deptId, roomId, displayName: "Dr Mehra" });
      await mkDoctor(db, { username: "rao", departmentId: dept2Id, roomId, displayName: "Dr Rao" });
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);

      const chips: SearchChip[] = [{ entity: "department", id: dept2Id, label: "Paediatrics" }];
      const res = await run(doctorSearchProvider, clerk.actor, "", { chips });

      expect(res.hits.map((h) => h.title)).toEqual(["Dr Rao"]);
    });

    it("an inactive doctor is not a search result", async () => {
      const { deptId, roomId } = await seedOpdMasters(db);
      const { doctorId } = await mkDoctor(db, { username: "gone", departmentId: deptId, roomId, displayName: "Dr Gone" });
      await db.update(opdDoctors).set({ active: false }).where(eq(opdDoctors.id, doctorId));
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);

      expect((await run(doctorSearchProvider, clerk.actor, "gone")).hits).toEqual([]);
    });
  });

  describe("departments", () => {
    it("matches on NAME or CODE — a desk says MED as often as Medicine", async () => {
      await seedOpdMasters(db);
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);

      expect((await run(departmentSearchProvider, clerk.actor, "gen")).hits.map((h) => h.title)).toEqual(["General Medicine"]);
      // ...and the second word too: "General Medicine" must answer to `medicine`.
      expect((await run(departmentSearchProvider, clerk.actor, "medicine")).hits.map((h) => h.title)).toEqual(["General Medicine"]);
      expect((await run(departmentSearchProvider, clerk.actor, "ped")).hits.map((h) => h.title)).toEqual(["Paediatrics"]);
    });

    it("LIKE metacharacters are literal", async () => {
      await seedOpdMasters(db);
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);
      expect((await run(departmentSearchProvider, clerk.actor, "%")).hits).toEqual([]);
    });
  });

  describe("appointments", () => {
    async function book(patientId: string, doctorId: string, departmentId: string, serviceDate: string): Promise<string> {
      const id = newId();
      await db.insert(opdAppointments).values({
        id, appointmentNo: `AFX-${id}`, patientId, doctorId, departmentId, serviceDate,
        slotStart: new Date(`${serviceDate}T09:00:00Z`), slotEnd: new Date(`${serviceDate}T09:15:00Z`),
        status: "booked", source: "desk", bookedBy: "t", updatedBy: "t",
      });
      return id;
    }

    it("with NO chips and NO text there is no query — a palette is not a worklist", async () => {
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);
      expect(await run(appointmentSearchProvider, clerk.actor, "")).toEqual({ hits: [], total: 0 });
    });

    it("free text resolves through the patients module and labels the row with the patient", async () => {
      const { deptId, roomId } = await seedOpdMasters(db);
      const { doctorId } = await mkDoctor(db, { username: "mehra", departmentId: deptId, roomId });
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);
      const patient = await mkPatient(db, clerk.actor, { name: "Asha Devi" });
      await book(patient.id, doctorId, deptId, "2026-08-20");

      const res = await run(appointmentSearchProvider, clerk.actor, "asha", { now: new Date("2026-08-22T06:00:00Z") });

      expect(res.total).toBe(1);
      expect(res.hits[0]?.title).toContain("Asha Devi");
      expect(res.hits[0]?.subtitle).toContain("booked");
    });

    it("A CONFIDENTIAL PATIENT'S APPOINTMENTS ARE UNREACHABLE — the gate is not re-implemented here", async () => {
      const { deptId, roomId } = await seedOpdMasters(db);
      const { doctorId } = await mkDoctor(db, { username: "mehra", departmentId: deptId, roomId });
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);
      const vip = await mkPatient(db, clerk.actor, { name: "Asha Confidential", phone: "9111111111", isConfidential: true, alias: "Guest One" });
      await book(vip.id, doctorId, deptId, "2026-08-20");

      // `searchPatients` yields no id for a sealed patient, so no appointment row can be reached
      // through the text lane. This is the property that keeps ONE confidentiality rule in ONE
      // module instead of one per provider.
      const res = await run(appointmentSearchProvider, clerk.actor, "asha");
      expect(res.hits).toEqual([]);
      expect(res.total).toBe(0);
    });

    it("a patient chip needs no text, and a date range narrows it", async () => {
      const { deptId, roomId } = await seedOpdMasters(db);
      const { doctorId } = await mkDoctor(db, { username: "mehra", departmentId: deptId, roomId });
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);
      const patient = await mkPatient(db, clerk.actor);
      await book(patient.id, doctorId, deptId, "2026-08-20");
      await book(patient.id, doctorId, deptId, "2026-01-05");

      const chips: SearchChip[] = [{ entity: "patient", id: patient.id, label: "Asha" }];

      /**
       * CORRECTED AT CLOSE (MINOR 9): a bare chip is windowed to ±7 days, so it answers "this
       * week", not "everything since 2019". With `now` pinned to 2026-08-22, the August booking is
       * inside the window and the January one is not.
       */
      const nearby = await run(appointmentSearchProvider, clerk.actor, "", { chips, now: new Date("2026-08-22T06:00:00Z") });
      expect(nearby.total).toBe(1);
      expect(nearby.hits[0]?.meta?.date).toBe("2026-08-20");

      // A date chip REPLACES the window — history is one word away.
      const ranged = await run(appointmentSearchProvider, clerk.actor, "", { chips, range: { from: "2026-01-01", to: "2026-01-31" } });
      expect(ranged.total).toBe(1);
      expect(ranged.hits[0]?.meta?.date).toBe("2026-01-05");
    });

    it("A @patient CHIP MUST NOT BYPASS THE SEALED CLASS — the id is not a capability", async () => {
      /**
       * INDEPENDENT REVIEWER, Plan 11h close — CRITICAL 1, the OPD half. A clerk holding
       * `opd.appointments.read` and not `patients.confidential.read` could read a confidential
       * patient's appointment dates, doctor, department and status by passing an id they already
       * had. The text lane was gated; the chip lane was not, and this file's own comment claimed
       * otherwise.
       */
      const { deptId, roomId } = await seedOpdMasters(db);
      const { doctorId } = await mkDoctor(db, { username: "mehra", departmentId: deptId, roomId });
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);
      const vip = await mkPatient(db, clerk.actor, { name: "Asha Confidential", phone: "9111111111", isConfidential: true, alias: "Guest One" });
      await book(vip.id, doctorId, deptId, "2026-08-20");

      const chips: SearchChip[] = [{ entity: "patient", id: vip.id, label: "known-id" }];
      const res = await run(appointmentSearchProvider, clerk.actor, "", { chips, now: new Date("2026-08-22T06:00:00Z") });

      expect(res.hits).toEqual([]);
      expect(res.total).toBe(0);
    });

    it("a doctor chip alone is a valid query", async () => {
      const { deptId, roomId } = await seedOpdMasters(db);
      const { doctorId } = await mkDoctor(db, { username: "mehra", departmentId: deptId, roomId });
      await ensureRole(db, "clerk");
      const clerk = await mkUser(db, "clerk1", ["clerk"]);
      const patient = await mkPatient(db, clerk.actor);
      await book(patient.id, doctorId, deptId, "2026-08-20");

      const chips: SearchChip[] = [{ entity: "doctor", id: doctorId, label: "Dr mehra" }];
      expect((await run(appointmentSearchProvider, clerk.actor, "", { chips, now: new Date("2026-08-22T06:00:00Z") })).total).toBe(1);
    });
  });
});
