import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { grantLabResultPermissions, seedLabDeskBase } from "./helpers/lab";
import { assertDemoDataAllowed, seedLabDemo } from "../scripts/seed-lab-demo";
import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import {
  labInstruments, labSpecimenItems, labSpecimens, orderItems, roleAssignments,
} from "../src/kernel/db/schema";
import type { LabDeskFixture } from "./helpers/lab";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ THE LAB-PATH DEMO SEED ═══
 *
 * The five lab seats all open onto an empty list on a fresh box, and nothing in this repository
 * produced a patient, an order or a collected tube. This seed is the fix, and this suite exists
 * because a seed nobody tests is a seed that rots silently between the day it is written and the
 * day somebody stands a hospital up with it.
 *
 * The assertion that matters most is not "rows were created". It is that the rows are the ones the
 * REAL write paths produce — a hand-inserted `lab_specimens` row with no `lab_specimen_items` link
 * looks perfect on a worklist and fails the instant anybody scans it.
 */
describe("seed:lab-demo — synthetic clinical data for the five seats", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    await grantPermissionToRole(db, fx.registry, "pathologist", "lab.instruments.manage");
    await grantPermissionToRole(db, fx.registry, "lab_reception", "patients.register");
  });
  afterEach(() => { fx.unregister(); });

  it("produces a RECEIVED tube that is actually scannable, which is the whole point", async () => {
    const report = await seedLabDemo(db);
    expect(report.patientsCreated).toBe(6);
    expect(report.specimensReceived).toBeGreaterThan(0);

    const received = await db.select().from(labSpecimens).where(eq(labSpecimens.status, "received"));
    expect(received.length).toBe(report.specimensReceived);

    /**
     * ═══ EVERY TUBE IS LINKED TO ITS ORDER ITEMS, AND THOSE ITEMS ARE OPEN ═══
     *
     * This is the assertion a hand-rolled seed would fail. The bench's scan resolves a tube to its
     * `lab_specimen_items` and then to an `in_progress` order item; a tube with neither is a row
     * that renders and cannot be worked on.
     */
    for (const tube of received) {
      const links = await db
        .select({ orderItemId: labSpecimenItems.orderItemId, status: orderItems.status })
        .from(labSpecimenItems)
        .innerJoin(orderItems, eq(orderItems.id, labSpecimenItems.orderItemId))
        .where(eq(labSpecimenItems.specimenId, tube.id));
      expect(links.length).toBeGreaterThan(0);
      expect(links.every((l) => l.status === "in_progress")).toBe(true);
    }
  });

  /**
   * A seed that received every tube would leave the collection chair as empty as it found it. The
   * three stages are the deliverable, not a side effect, so they are asserted as three.
   */
  it("leaves work at THREE different stages, so every seat has something to open", async () => {
    await seedLabDemo(db);
    const all = await db.select().from(labSpecimens);
    const byStatus = new Map<string, number>();
    for (const s of all) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);

    /** `labelled` is the vocabulary's own word for a printed, undrawn tube — `LAB_SPECIMEN_STATES`. */
    expect(byStatus.get("labelled") ?? 0).toBeGreaterThan(0);
    expect(byStatus.get("collected") ?? 0).toBeGreaterThan(0);
    expect(byStatus.get("received") ?? 0).toBeGreaterThan(0);
  });

  /** The three machines, so T3/T4/T5 have something to post to, load and lay out. */
  it("registers one instrument per naming mode that has a writer", async () => {
    const report = await seedLabDemo(db);
    expect(report.instrumentsRegistered).toBe(3);
    const modes = (await db.select().from(labInstruments)).map((i) => i.sampleIdMode).sort();
    expect(modes).toEqual(["barcode", "plate_map", "run_sheet"]);
  });

  /**
   * ═══ IDEMPOTENT, BECAUSE A SEED AN OPERATOR IS AFRAID TO RE-RUN IS A SEED THEY RUN ONCE ═══
   *
   * The second run must find the same six people and add no seventh. It is keyed on the reserved
   * demo phone numbers, so this also pins that the key is stable — a seed that deduplicated on NAME
   * would break the day two real patients share one, which in an Indian register is a Tuesday.
   */
  it("is idempotent — a second run creates no seventh patient and no fourth machine", async () => {
    const first = await seedLabDemo(db);
    const second = await seedLabDemo(db);

    expect([first.patientsCreated, first.patientsExisting]).toEqual([6, 0]);
    expect([second.patientsCreated, second.patientsExisting]).toEqual([0, 6]);
    /**
     * Every order is skipped by the hospital's OWN guard rather than by a flag this script keeps:
     * one patient may not have two open lab visits in a day. Asserting the SKIP COUNT rather than
     * merely "it did not throw" is what pins that the re-run key is that refusal.
     */
    expect([second.ordersPlaced, second.ordersSkipped]).toEqual([0, first.ordersPlaced]);
    expect(second.instrumentsRegistered).toBe(0);
    expect(await db.select().from(labInstruments)).toHaveLength(3);
  });

  /**
   * ═══ THE TWO REFUSALS THAT KEEP SYNTHETIC PEOPLE OUT OF A LIVE REGISTER ═══
   *
   * A patient cannot be deleted once orders, invoices and results reference them, so this guard is
   * the difference between a demo and a permanent contamination of a hospital's register. It is
   * tested as a function rather than by launching the CLI, because a guard only exercisable by
   * subprocess gets verified by hand once and then rots.
   */
  describe("assertDemoDataAllowed", () => {
    /**
     * ═══ PHASE 11i T5 — A THIRD DOOR, AND THE PROSE ABOVE HAD TO CHANGE WITH IT ═══
     *
     * This block used to say *"the opt-in does NOT override production — the two refusals are
     * independent, not a ladder"*, and that is still true of `ALLOW_DEMO_DATA`. What changed is
     * that `NODE_ENV` stopped being able to separate the hospital from the bench: **UAT runs the
     * PRODUCTION IMAGE**, which sets `NODE_ENV=production`, because a rehearsal on a different
     * build proves nothing about the build that ships.
     *
     * So there is now a third refusal, `HMIS_SYNTHETIC_DATA_OK=1` (11i D5) — an ENVIRONMENT fact
     * rather than an argument, living in `/opt/hmis-uat/.env` and in no other `.env` on the host,
     * absent from the production template, and refused by `deploy.sh`'s prod target. The
     * `NODE_ENV` refusal is read THROUGH it and is not weakened: a plain production container,
     * with no such key, is refused exactly as before.
     *
     * Each leg below opens only the doors it is not testing, so no assertion passes for another
     * refusal's reason.
     */
    const DOOR = { HMIS_SYNTHETIC_DATA_OK: "1" } as const;

    it("refuses without the explicit opt-in, and NAMES the database it would have written to", () => {
      expect(() => assertDemoDataAllowed({ ...DOOR }, "hmis_prod")).toThrow(/hmis_prod/);
      expect(() => assertDemoDataAllowed({ ...DOOR }, "hmis_prod")).toThrow(/ALLOW_DEMO_DATA=yes/);
      // The spelling is exact, and the door is OPEN here so the throw can only be about spelling.
      expect(() => assertDemoDataAllowed({ ...DOOR, ALLOW_DEMO_DATA: "1" }, "d")).toThrow(/ALLOW_DEMO_DATA=yes/);
      expect(() => assertDemoDataAllowed({ ...DOOR, ALLOW_DEMO_DATA: "true" }, "d")).toThrow(/ALLOW_DEMO_DATA=yes/);
    });

    /** The opt-in still does not override production. Only the environment door does. */
    it("refuses under NODE_ENV=production with the opt-in but WITHOUT the door", () => {
      expect(() => assertDemoDataAllowed(
        { NODE_ENV: "production", ALLOW_DEMO_DATA: "yes" }, "hmis",
      )).toThrow(/HMIS_SYNTHETIC_DATA_OK/);
    });

    /** …and refuses under production with the DOOR but without the opt-in: neither implies the other. */
    it("refuses under NODE_ENV=production with the door but WITHOUT the opt-in", () => {
      expect(() => assertDemoDataAllowed(
        { ...DOOR, NODE_ENV: "production" }, "hmis",
      )).toThrow(/ALLOW_DEMO_DATA=yes/);
    });

    it("allows exactly the one spelling, off production", () => {
      expect(() => assertDemoDataAllowed({ ...DOOR, ALLOW_DEMO_DATA: "yes" }, "hmis_dev")).not.toThrow();
    });

    it("allows UAT — the production IMAGE, with both the door and the opt-in", () => {
      // The case the whole change exists for, and the one the old guard made impossible.
      expect(() => assertDemoDataAllowed(
        { ...DOOR, NODE_ENV: "production", ALLOW_DEMO_DATA: "yes" }, "hmis_uat",
      )).not.toThrow();
    });
  });

  /**
   * ═══ IT MINTS NO CREDENTIALS, AND THE REFUSAL IS THE FEATURE ═══
   *
   * `seed-staff.ts` refused env vars AND a file on the box for credentials. A demo seed that created
   * its own users would be exactly the artefact that ruling rejected, committed to git for ever. So
   * with nobody holding the role, the correct behaviour is to STOP and say which screen makes one —
   * not to invent an account and carry on.
   */
  it("refuses, with an instruction, when no user holds a role it needs", async () => {
    /** Strip every `lab_technician` holder and the seed must stop rather than improvise. */
    await db.delete(roleAssignments).where(eq(roleAssignments.roleKey, "lab_technician"));

    await expect(seedLabDemo(db)).rejects.toThrow(/lab_technician/);
    await expect(seedLabDemo(db)).rejects.toThrow(/\/admin\/users/);
  });
});
