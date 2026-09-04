import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { qaRecords, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { assignResource, changeResourceStatus, createResource } from "../../kernel/resources/registry";
import { RADIOLOGY_RESOURCE_KINDS, SCHEDULABLE_DEVICE_STATUSES } from "../radiology";
import { aerbManifest } from "./manifest";
import { qaRegister, recordQa } from "./qa";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18c T2 — the QA register, and the lockout that actually blocks.
 *
 * ═══ THE MUTANT THIS FILE IS BUILT AROUND ═══
 *
 * *"Record the failure and skip the status change."* The row looks right, the register prints, the
 * inspector is satisfied — **and the CT keeps taking bookings.** So no assertion here stops at "was
 * it recorded": every one of them reads the DEVICE afterwards, which is the only place the answer
 * to "may this machine scan on Monday" actually lives.
 *
 * The suite imports `RADIOLOGY_RESOURCE_KINDS` because a TEST may — it is the same direction the
 * running system uses (the controller collects the declarations from the installed registry) and a
 * test that invented its own `device` vocabulary would be proving something about a fixture. The
 * MODULE does not import it, which is what D1 is about; `index.ts` is the wall.
 */
describe("the QA register and the qa_blocked lockout (18c T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let rso: Actor;
  let outsider: Actor;
  let ct: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install(aerbManifest);
    await syncPermissions(db, registry);
    for (const role of ["radiation_safety_officer", "radiographer"]) await ensureRole(db, role);
    for (const p of aerbManifest.permissions) {
      await grantPermissionToRole(db, registry, "radiation_safety_officer", p);
    }
    await grantPermissionToRole(db, registry, "radiographer", "aerb.doses.read");
    ({ actor: rso } = await mkUser(db, "rso.bhat", ["radiation_safety_officer"]));
    ({ actor: outsider } = await mkUser(db, "tech.kumar", ["radiographer"]));
    const made = await withTx(db, (tx) => createResource(tx, rso, RADIOLOGY_RESOURCE_KINDS, {
      kind: "device", code: "CT-1", name: "CT machine", attributes: { modality: "ct" },
    }));
    ct = made.resourceId;
  });

  const record = (over: Partial<Parameters<typeof recordQa>[3]> = {}) =>
    withTx(db, (tx) => recordQa(tx, rso, RADIOLOGY_RESOURCE_KINDS, {
      deviceResourceId: ct, qaType: "AERB annual QA", result: "pass",
      performedBy: "S. Iyer, medical physicist", performedOn: "2026-06-15",
      agencyRef: "QA/2026/117", values: { kvpAccuracyPct: 2.1, hvlMm: 3.4 },
      nextDueOn: "2027-06-15", ...over,
    }));

  const deviceStatus = async (): Promise<string> => {
    const [row] = await db.select().from(resources).where(eq(resources.id, ct));
    return row!.status;
  };

  /* ═════════════ A FAILURE STOPS THE MACHINE, IN THE SAME TRANSACTION ═════════════ */

  it("a FAIL puts the device into qa_blocked and says so on the record", async () => {
    const out = await record({ result: "fail", remarks: "output repeatability out of tolerance" });
    expect(out.blocked).toBe(true);
    expect(await deviceStatus()).toBe("qa_blocked");
    const [row] = await db.select().from(qaRecords).where(eq(qaRecords.id, out.recordId));
    expect(row!.blockApplied).toBe(true);
    expect(row!.releasedAt).toBeNull();
  });

  /**
   * THE LOOP, END TO END, THROUGH THE VOCABULARY THE SCHEDULER READS. `qa_blocked` is absent from
   * `SCHEDULABLE_DEVICE_STATUSES`, so this is the assertion that the block reaches the diary —
   * without importing the scheduler, which would be testing radiology from here.
   */
  it("the blocked status is one the scheduler refuses, and a PASS returns the machine to available", async () => {
    await record({ result: "fail" });
    expect(RADIOLOGY_RESOURCE_KINDS[0]!.statuses).toContain("qa_blocked");
    expect(SCHEDULABLE_DEVICE_STATUSES).not.toContain(await deviceStatus());

    const pass = await record({ result: "pass", performedOn: "2026-06-20" });
    expect(await deviceStatus()).toBe("available");
    expect(SCHEDULABLE_DEVICE_STATUSES).toContain(await deviceStatus());
    expect(pass.releasedRecordId).not.toBeNull();
  });

  it("the releasing pass is written onto the failing record, both halves or neither", async () => {
    const fail = await record({ result: "fail" });
    const pass = await record({ result: "pass", performedOn: "2026-06-20" });
    const [row] = await db.select().from(qaRecords).where(eq(qaRecords.id, fail.recordId));
    expect(row!.releasedByRecordId).toBe(pass.recordId);
    expect(row!.releasedAt).not.toBeNull();
  });

  /**
   * A `conditional` result is NOT a pass and NOT a failure: the physicist signed it off with a
   * caveat. It records, and it moves nothing — a machine already blocked stays blocked.
   */
  it("a CONDITIONAL result records and moves nothing, in either direction", async () => {
    const c1 = await record({ result: "conditional" });
    expect(c1.blocked).toBe(false);
    expect(await deviceStatus()).toBe("available");

    await record({ result: "fail", performedOn: "2026-06-16" });
    const c2 = await record({ result: "conditional", performedOn: "2026-06-17" });
    expect(c2.releasedRecordId).toBeNull();
    expect(await deviceStatus()).toBe("qa_blocked");
  });

  /* ═════════════ WHAT A PASS MUST NOT CLEAR ═════════════ */

  /**
   * The sharpest of the mutants: a QA pass that returns a machine to service whatever it was doing
   * in. `down` is a broken tube and `maintenance` is an engineer's visit — both are somebody else's
   * status, and a passing phantom test does not mean the tube was replaced.
   */
  it.each(["down", "maintenance"])("a PASS does not release a machine that is %s — that is not this register's status", async (status) => {
    await withTx(db, (tx) => changeResourceStatus(tx, rso, RADIOLOGY_RESOURCE_KINDS, ct, status, { reason: "not QA" }));
    const out = await record({ result: "pass" });
    expect(out.releasedRecordId).toBeNull();
    expect(await deviceStatus()).toBe(status);
  });

  /**
   * A FAIL on a machine mid-examination REFUSES, and the record rolls back with it. Stopping a tube
   * with a patient on the table is a decision a person makes at the console — and a register that
   * recorded the failure while the kernel refused the status change would be a register saying the
   * machine was stopped when it was not.
   */
  it("a FAIL on an occupied machine refuses, and writes NO record at all", async () => {
    await withTx(db, (tx) => assignResource(tx, rso, RADIOLOGY_RESOURCE_KINDS, ct, {
      occupantType: "imaging_study", occupantRef: newId(),
    }));
    await expect(record({ result: "fail" })).rejects.toMatchObject({ code: "already_occupied" });
    expect(await db.select().from(qaRecords)).toHaveLength(0);
    expect(await deviceStatus()).toBe("in_use");
  });

  /* ═══ CLOSE REVIEW, CRITICAL — A PASS CANNOT BE OLDER THAN THE FAILURE IT WOULD CLEAR ═══ */

  /**
   * The register exists so an inspector can be shown the QA history, so back-entering old
   * certificates is the ordinary act — and it released a machine that had failed last week.
   */
  /**
   * PASS 2 rewrote this. Pass 1 REFUSED the stale pass, which meant the historical QA book could
   * not be entered at all while a machine was blocked — the act this register exists for. It now
   * records and releases nothing, and BOTH halves are the assertion.
   */
  it("back-entering LAST YEAR's certificate records it, and does NOT release a machine that failed last week", async () => {
    await record({ result: "fail", performedOn: "2026-06-15" });
    expect(await deviceStatus()).toBe("qa_blocked");

    const stale = await record({ result: "pass", performedOn: "2025-06-10", nextDueOn: "2026-06-10" });

    /** The history is enterable... */
    expect(await db.select().from(qaRecords)).toHaveLength(2);
    /** ...and the answer says plainly that it cleared nothing... */
    expect(stale.releasedRecordId).toBeNull();
    /** ...and the machine is still stopped. */
    expect(await deviceStatus()).toBe("qa_blocked");
    const [fail] = await db.select().from(qaRecords).where(eq(qaRecords.blockApplied, true));
    expect(fail!.releasedAt).toBeNull();
  });

  /**
   * The boundary of that rule. A machine failed in the morning, repaired and re-tested the same
   * afternoon, is released — `<` and not `<=`, which is the mutant this row exists for.
   */
  it("a pass on the SAME day as the failure DOES release — a machine re-tested that afternoon", async () => {
    await record({ result: "fail", performedOn: "2026-06-15" });
    await expect(record({ result: "pass", performedOn: "2026-06-15" })).resolves.toMatchObject({ blocked: false });
    expect(await deviceStatus()).toBe("available");
  });

  it("history entered on a machine that is NOT blocked records freely and releases nothing", async () => {
    await expect(record({ result: "pass", performedOn: "2019-04-01", nextDueOn: "2020-04-01" }))
      .resolves.toMatchObject({ blocked: false, releasedRecordId: null });
    expect(await deviceStatus()).toBe("available");
  });

  /** PASS 2 — the kind check landed in `fileLicence` only; a bed could carry a QA certificate. */
  it("refuses a QA record against a resource that is not a device", async () => {
    const bed = newId();
    await db.insert(resources).values({
      id: bed, kind: "bed", code: "B-1", name: "Bed 1", status: "available",
      attributes: {}, createdBy: "t", updatedBy: "t",
    });
    await expect(withTx(db, (tx) => recordQa(tx, rso, RADIOLOGY_RESOURCE_KINDS, {
      deviceResourceId: bed, qaType: "annual", result: "pass",
      performedBy: "x", performedOn: "2026-06-15",
    }))).rejects.toMatchObject({ code: "unknown_licence", detail: { kind: "bed" } });
    expect(await db.select().from(qaRecords)).toHaveLength(0);
  });

  /** PASS 2 — `2026-02-31` passed the shape check here too and died at the INSERT as a 500. */
  it("refuses a date that is well-formed but not a real day", async () => {
    await expect(record({ performedOn: "2026-02-31" }))
      .rejects.toMatchObject({ code: "invalid_validity" });
  });

  /** F52's rule: nothing bounded `performedOn` above, so a typo released on a test not yet done. */
  it("refuses a test performed in the future", async () => {
    await expect(record({ result: "pass", performedOn: "2099-01-01", nextDueOn: "2099-06-01" }))
      .rejects.toMatchObject({ code: "invalid_validity" });
  });

  /* ═════════════ THE REST OF THE REGISTER'S RULES ═════════════ */

  it("refuses a next-due date that falls before the test was performed", async () => {
    await expect(record({ performedOn: "2026-06-15", nextDueOn: "2026-06-14" }))
      .rejects.toMatchObject({ code: "invalid_validity" });
  });

  it("a radiographer holding only the dose read cannot record a QA result", async () => {
    await expect(withTx(db, (tx) => recordQa(tx, outsider, RADIOLOGY_RESOURCE_KINDS, {
      deviceResourceId: ct, qaType: "annual", result: "fail",
      performedBy: "someone", performedOn: "2026-06-15",
    }))).rejects.toMatchObject({ code: "not_appointed" });
    expect(await db.select().from(qaRecords)).toHaveLength(0);
    expect(await deviceStatus()).toBe("available");
  });

  it("the CHECK refuses a PASS row claiming it applied a block", async () => {
    await expect(db.insert(qaRecords).values({
      id: newId(), deviceResourceId: ct, qaType: "annual", result: "pass",
      performedBy: "x", performedOn: "2026-06-15", blockApplied: true, recordedBy: "t",
    })).rejects.toThrow(/aerb_qa_records_block_ck/);
  });

  it("the CHECK refuses half a release", async () => {
    await expect(db.insert(qaRecords).values({
      id: newId(), deviceResourceId: ct, qaType: "annual", result: "fail",
      performedBy: "x", performedOn: "2026-06-15", releasedAt: new Date(), recordedBy: "t",
    })).rejects.toThrow(/aerb_qa_records_release_ck/);
  });

  it("the register reads newest first and carries the machine's CURRENT status", async () => {
    await record({ result: "fail", performedOn: "2026-06-15" });
    await record({ result: "pass", performedOn: "2026-06-20" });
    const rows = await qaRegister(db);
    expect(rows.map((r) => r.performedOn)).toEqual(["2026-06-20", "2026-06-15"]);
    expect(rows[0]!.deviceCode).toBe("CT-1");
    /** Every row says `available`, because that is what the machine IS — and the failing row still
     *  says `blockApplied`, because that is what happened on the day. */
    expect(rows.every((r) => r.deviceStatus === "available")).toBe(true);
    expect(rows[1]!.blockApplied).toBe(true);
    expect(rows[1]!.releasedAt).not.toBeNull();
  });
});
