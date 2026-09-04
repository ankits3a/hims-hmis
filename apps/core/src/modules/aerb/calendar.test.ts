import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { RADIOLOGY_RESOURCE_KINDS } from "../radiology";
import { aerbManifest } from "./manifest";
import { appointPerson, fileLicence } from "./licences";
import { recordQa } from "./qa";
import { issueBadge, recordBadgeRead } from "./badges";
import { DUE_WINDOW_DAYS, complianceCalendar } from "./calendar";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18c T5 — the compliance calendar.
 *
 * ═══ THE MUTANT THIS FILE IS BUILT AROUND ═══
 *
 * *"List every QA record that has a next-due date."* A machine tested annually has a record from
 * last year whose date passed months ago and a record from last week whose date is a year out — and
 * a calendar that listed both shows an inspector a machine that is overdue for a test it has
 * already had. **The latest record per device and test type is the one with a live date**, which is
 * the single hardest thing about this function and the reason it is not a `select ... where
 * next_due_on < today`.
 *
 * The second is the badge with no date at all: nothing was ever scheduled for it, so it is
 * invisible to every date-driven query, and it is the row that means a person's exposure is
 * unknown.
 */
describe("the compliance calendar (18c T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let rso: Actor;
  let ct: string;

  /** Every date in this suite is relative to one "today", so nothing depends on when it runs. */
  const TODAY = "2026-06-15";
  const daysFrom = (n: number): string =>
    new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install(aerbManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "radiation_safety_officer");
    for (const p of aerbManifest.permissions) {
      await grantPermissionToRole(db, registry, "radiation_safety_officer", p);
    }
    ({ actor: rso } = await mkUser(db, "rso.bhat", ["radiation_safety_officer"]));
    const made = await withTx(db, (tx) => createDevice(tx));
    ct = made;
  });

  async function createDevice(tx: Parameters<typeof recordQa>[0]): Promise<string> {
    const id = newId();
    await tx.insert(resources).values({
      id, kind: "device", code: "CT-1", name: "CT machine", status: "available",
      attributes: { modality: "ct" }, createdBy: "t", updatedBy: "t",
    });
    return id;
  }

  const licence = (validTo: string, licenceNo = "AERB/CT/2026/1") =>
    withTx(db, (tx) => fileLicence(tx, rso, {
      deviceResourceId: ct, licenceType: "licence", licenceNo,
      validFrom: "2020-01-01", validTo,
    }));

  const qa = (performedOn: string, nextDueOn: string, qaType = "AERB annual QA") =>
    withTx(db, (tx) => recordQa(tx, rso, RADIOLOGY_RESOURCE_KINDS, {
      deviceResourceId: ct, qaType, result: "pass",
      performedBy: "S. Iyer", performedOn, nextDueOn,
    }));

  const calendar = (includeOk = false) => complianceCalendar(db, { onDate: TODAY, includeOk });

  /* ═════════ THE THREE STATES, AT THEIR BOUNDARIES ═════════ */

  it.each([
    [daysFrom(-1), "overdue"],
    [daysFrom(0), "due"],
    [daysFrom(DUE_WINDOW_DAYS), "due"],
    [daysFrom(DUE_WINDOW_DAYS + 1), "ok"],
  ])("a licence expiring %s is %s", async (validTo, expected) => {
    await licence(validTo);
    const all = await calendar(true);
    expect(all.find((r) => r.kind === "licence")!.state).toBe(expected);
  });

  it("the working view hides what is fine, and the inspector's view shows everything", async () => {
    await licence(daysFrom(400));
    expect(await calendar(false)).toHaveLength(0);
    expect(await calendar(true)).toHaveLength(1);
  });

  /* ═════════ THE MUTANT: THE LATEST QA RECORD IS THE LIVE ONE ═════════ */

  /**
   * A machine tested annually carries LAST year's record with a date long past, and this year's
   * with a date a year out. A calendar that listed every record with a `next_due_on` would show an
   * inspector a machine overdue for a test it has already had — which is worse than no calendar.
   */
  it("shows only the LATEST QA record per device and test type", async () => {
    await qa("2025-06-01", daysFrom(-350)); // last year's, long past
    await qa("2026-06-01", daysFrom(365)); // this year's, comfortably ahead
    expect((await calendar(false)).filter((r) => r.kind === "qa")).toHaveLength(0);
    const all = await calendar(true);
    const qaRows = all.filter((r) => r.kind === "qa");
    expect(qaRows).toHaveLength(1);
    expect(qaRows[0]!.dueOn).toBe(daysFrom(365));
  });

  /**
   * ═══ CLOSE REVIEW — THE `next_due_on is not null` FILTER RAN BEFORE THE GROUPING ═══
   *
   * `next_due_on` is nullable and a FAILED test legitimately has none until the machine is
   * repaired. Filtering first removed that record from the candidate set, so LAST YEAR's pass
   * became "latest" and the calendar showed the machine overdue for a test it had a fortnight ago
   * — F23's "worse than no calendar", through the one door the mutant does not cover.
   */
  it("a FAILED test with no next date supersedes last year's pass rather than resurrecting it", async () => {
    await qa("2025-01-10", daysFrom(-350));
    await withTx(db, (tx) => recordQa(tx, rso, RADIOLOGY_RESOURCE_KINDS, {
      deviceResourceId: ct, qaType: "AERB annual QA", result: "fail",
      performedBy: "S. Iyer", performedOn: daysFrom(-14),
    }));
    /** The machine is stopped — which is the QA tab's row — and the calendar chases nothing. */
    expect((await calendar(true)).filter((r) => r.kind === "qa")).toHaveLength(0);
  });

  /** A retest the same day after a repair: the row entered LAST wins, not whichever the read found. */
  it("breaks a same-day tie on when the record was entered", async () => {
    await qa(daysFrom(-1), daysFrom(2), "AERB annual QA");
    await qa(daysFrom(-1), daysFrom(200), "AERB annual QA");
    const rows = (await calendar(true)).filter((r) => r.kind === "qa");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dueOn).toBe(daysFrom(200));
  });

  /** Two DIFFERENT tests on one machine are two rows: a daily KV check is not the annual QA. */
  it("keeps different test types apart on the same machine", async () => {
    await qa("2026-06-01", daysFrom(-5), "AERB annual QA");
    await qa("2026-06-14", daysFrom(1), "daily kV check");
    const rows = (await calendar(true)).filter((r) => r.kind === "qa");
    expect(rows.map((r) => r.detail).sort()).toEqual(["AERB annual QA", "daily kV check"]);
    expect(rows.find((r) => r.detail === "AERB annual QA")!.state).toBe("overdue");
  });

  /* ═════════ THE BADGE WITH NO DATE AT ALL ═════════ */

  /**
   * Nothing was ever scheduled for it, so no date-driven query can find it — and it is the row that
   * means a person is wearing a dosimeter nobody has read.
   */
  it("carries the badge nobody is reading, which has no due date to be late against", async () => {
    const { actor: tech, id: techId } = await mkUser(db, "rt.singh", ["radiation_safety_officer"]);
    void tech;
    await withTx(db, (tx) => issueBadge(tx, rso, {
      userId: techId, badgeNo: "TLD-001", issuedOn: daysFrom(-200),
    }));
    const rows = (await calendar(false)).filter((r) => r.kind === "badge");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBe("TLD-001");
    expect(rows[0]!.dueOn).toBeNull();
    expect(rows[0]!.state).toBe("overdue");
    expect(rows[0]!.daysOverdue).toBe(200);
  });

  it("a badge read recently is not on the calendar at all", async () => {
    const { id: techId } = await mkUser(db, "rt.devi", ["radiation_safety_officer"]);
    const { badgeId } = await withTx(db, (tx) => issueBadge(tx, rso, {
      userId: techId, badgeNo: "TLD-002", issuedOn: daysFrom(-200),
    }));
    await withTx(db, (tx) => recordBadgeRead(tx, rso, {
      badgeId, periodStart: daysFrom(-100), periodEnd: daysFrom(-10),
      hp10Msv: 1.1, reportedOn: daysFrom(-5),
    }));
    expect((await calendar(false)).filter((r) => r.kind === "badge")).toHaveLength(0);
  });

  /* ═════════ THE APPOINTMENT ═════════ */

  it("an RSO approval about to lapse is on the calendar; an open-ended one never is", async () => {
    await withTx(db, (tx) => appointPerson(tx, rso, {
      userId: rso.id, personRole: "rso", qualification: "RSO Level-2",
      validFrom: "2024-01-01", validTo: daysFrom(10),
    }));
    const rows = (await calendar(false)).filter((r) => r.kind === "appointment");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("due");
    expect(rows[0]!.subject).toBe("rso.bhat");

    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install(aerbManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "radiation_safety_officer");
    for (const p of aerbManifest.permissions) {
      await grantPermissionToRole(db, registry, "radiation_safety_officer", p);
    }
    const { actor: rso2 } = await mkUser(db, "rso.two", ["radiation_safety_officer"]);
    await withTx(db, (tx) => appointPerson(tx, rso2, {
      userId: rso2.id, personRole: "physicist", qualification: "MSc", validFrom: "2024-01-01",
    }));
    expect((await calendar(true)).filter((r) => r.kind === "appointment")).toHaveLength(0);
  });

  /* ═════════ THE WHOLE FILE, IN THE ORDER THE CONVERSATION GOES ═════════ */

  it("sorts the latest breach first — the order an inspector asks in", async () => {
    await licence(daysFrom(-90));
    await qa("2026-01-01", daysFrom(-10));
    await withTx(db, (tx) => appointPerson(tx, rso, {
      userId: rso.id, personRole: "rso", qualification: "RSO",
      validFrom: "2024-01-01", validTo: daysFrom(5),
    }));
    const rows = await calendar(false);
    expect(rows.map((r) => r.kind)).toEqual(["licence", "qa", "appointment"]);
    expect(rows[0]!.daysOverdue).toBe(90);
    expect(rows[2]!.state).toBe("due");
  });

  /**
   * D4 RESTATED, and it is the assertion that stops the calendar quietly becoming a second lockout:
   * an overdue QA does NOT touch the machine. The only automatic block in this phase is a FAILED
   * test, because a physicist measured something and said so.
   */
  it("an OVERDUE QA leaves the machine available — the calendar tells the RSO, it does not block", async () => {
    await qa("2025-01-01", daysFrom(-200));
    expect((await calendar(false)).filter((r) => r.state === "overdue")).toHaveLength(1);
    const [device] = await db.select().from(resources);
    expect(device!.status).toBe("available");
  });
});
