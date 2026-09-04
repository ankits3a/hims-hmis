import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { aerbLicences, aerbPersons, events, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { aerbManifest } from "./manifest";
import {
  activeLicenceFor, appointPerson, appointedPerson, assertDeviceLicensed,
  changeLicenceStatus, endAppointment, fileLicence,
} from "./licences";
import { appointments, licenceRegister, unlicensedDevices } from "./read";
import { AerbError } from "./errors";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18c T1 — the AERB licence register, and the one question it exists to answer: **was this
 * machine licensed on the day of that scan?**
 *
 * The mutant this file is built around is *"compare against `valid_from` only"* — a licence that
 * lapsed last Friday still passes, and every test whose fixture licence never expires stays green
 * while an unlicensed CT scans patients. So the window is walked at BOTH edges, exactly as 18a's
 * A7 walks the PCPNDT registration's, and for the same reason: a hard block that is off by a day
 * either stops a legal examination or permits an illegal one.
 */
describe("the AERB licence register (18c T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let rso: Actor;
  let outsider: Actor;
  let ct: string;
  let usg: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  async function mkDevice(code: string, modality: string): Promise<string> {
    const id = newId();
    await db.insert(resources).values({
      id, kind: "device", code, name: `${code} machine`, status: "available",
      attributes: { modality }, createdBy: "t", updatedBy: "t",
    });
    return id;
  }

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install(aerbManifest);
    await syncPermissions(db, registry);
    for (const role of ["radiation_safety_officer", "radiographer"]) await ensureRole(db, role);
    for (const p of aerbManifest.permissions) {
      await grantPermissionToRole(db, registry, "radiation_safety_officer", p);
    }
    /** The negative: holds the DOSE read and nothing that files a document. */
    await grantPermissionToRole(db, registry, "radiographer", "aerb.doses.read");
    ({ actor: rso } = await mkUser(db, "rso.bhat", ["radiation_safety_officer"]));
    ({ actor: outsider } = await mkUser(db, "tech.kumar", ["radiographer"]));
    ct = await mkDevice("CT-1", "ct");
    usg = await mkDevice("USG-1", "usg");
  });

  const file = (deviceResourceId: string, validFrom: string, validTo: string, licenceNo = "AERB/CT/2026/1") =>
    withTx(db, (tx) => fileLicence(tx, rso, {
      deviceResourceId, licenceType: "licence", licenceNo,
      eloraRef: "ELORA-778", typeApprovalRef: "TA/CT/91", layoutApprovalRef: "LAY/2025/12",
      validFrom, validTo, rsoUserId: rso.id, remarks: null,
    }));

  /* ═══════════════════ THE VALIDITY WINDOW — the mutant's home ═══════════════════ */

  it("resolves a live licence inside its window", async () => {
    await file(ct, "2026-01-01", "2026-12-31");
    const found = await activeLicenceFor(db, ct, "2026-06-15");
    expect(found?.licenceNo).toBe("AERB/CT/2026/1");
  });

  /**
   * BOTH EDGES. The `2027-01-01` row is the one the "check `valid_from` only" mutant survives, and
   * it is the row that stands for a CT scanning on a licence that expired at midnight.
   */
  it.each([
    ["2025-12-31", false, "the day before it begins"],
    ["2026-01-01", true, "the first day (inclusive)"],
    ["2026-12-31", true, "the last day (inclusive)"],
    ["2027-01-01", false, "the day after it lapses"],
  ])("%s → licensed = %s (%s)", async (date, expected) => {
    await file(ct, "2026-01-01", "2026-12-31");
    expect(await activeLicenceFor(db, ct, date) !== null).toBe(expected);
  });

  it("assertDeviceLicensed refuses a lapsed licence by name, with the date in the detail", async () => {
    await file(ct, "2026-01-01", "2026-12-31");
    await expect(assertDeviceLicensed(db, ct, "2027-01-01")).rejects.toMatchObject({
      code: "device_not_licensed",
      detail: { deviceResourceId: ct, onDate: "2027-01-01" },
    });
  });

  it("assertDeviceLicensed refuses a machine nobody has ever filed for — the posture, not an oversight", async () => {
    await expect(assertDeviceLicensed(db, ct, "2026-06-15")).rejects.toBeInstanceOf(AerbError);
  });

  it("assertDeviceLicensed returns the licence so the caller does not read it twice", async () => {
    await file(ct, "2026-01-01", "2026-12-31");
    await expect(assertDeviceLicensed(db, ct, "2026-06-15")).resolves.toMatchObject({ licenceNo: "AERB/CT/2026/1" });
  });

  /* ═══════════════════ ONE ACTIVE LICENCE PER DEVICE ═══════════════════ */

  it("refuses a second active licence on one machine — a renewal retires the old row first", async () => {
    await file(ct, "2026-01-01", "2026-12-31");
    await expect(file(ct, "2027-01-01", "2027-12-31", "AERB/CT/2027/1"))
      .rejects.toMatchObject({ code: "licence_already_active" });
  });

  it("a renewal filed after the old row is surrendered leaves exactly one active licence", async () => {
    const { licenceId } = await file(ct, "2026-01-01", "2026-12-31");
    await withTx(db, (tx) => changeLicenceStatus(tx, rso, licenceId, "surrendered", {
      reason: "unit replaced", decommissionRef: "DECOM/2026/3",
    }));
    await file(ct, "2027-01-01", "2027-12-31", "AERB/CT/2027/1");
    const rows = await db.select().from(aerbLicences).where(eq(aerbLicences.deviceResourceId, ct));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
  });

  it("a SUSPENDED licence stops the machine, and restoring it works while nothing else is active", async () => {
    const { licenceId } = await file(ct, "2026-01-01", "2026-12-31");
    await withTx(db, (tx) => changeLicenceStatus(tx, rso, licenceId, "suspended", { reason: "QA condition breached" }));
    expect(await activeLicenceFor(db, ct, "2026-06-15")).toBeNull();
    await withTx(db, (tx) => changeLicenceStatus(tx, rso, licenceId, "active", { reason: "condition closed" }));
    expect(await activeLicenceFor(db, ct, "2026-06-15")).not.toBeNull();
  });

  /* ═══════════════════ SURRENDER IS TERMINAL, AND CARRIES ITS DATE ═══════════════════ */

  it("surrender writes the decommissioning date, and a surrendered licence cannot be revived", async () => {
    const { licenceId } = await file(ct, "2026-01-01", "2026-12-31");
    await withTx(db, (tx) => changeLicenceStatus(tx, rso, licenceId, "surrendered", { decommissionRef: "DECOM/1" }));
    const [row] = await db.select().from(aerbLicences).where(eq(aerbLicences.id, licenceId));
    expect(row!.decommissionedAt).not.toBeNull();
    expect(row!.decommissionRef).toBe("DECOM/1");
    await expect(withTx(db, (tx) => changeLicenceStatus(tx, rso, licenceId, "active")))
      .rejects.toMatchObject({ code: "already_surrendered" });
  });

  /**
   * The DATABASE half of the same rule — the CHECK, executed rather than read out of
   * `pg_constraint`. A `surrendered` row with no date is what "we retired it" looks like when
   * nobody wrote anything down.
   */
  it("the CHECK refuses a surrendered row with no decommissioning date", async () => {
    await expect(db.insert(aerbLicences).values({
      id: newId(), deviceResourceId: ct, licenceType: "licence", licenceNo: "AERB/X/1",
      validFrom: "2026-01-01", validTo: "2026-12-31", status: "surrendered", createdBy: "t",
    })).rejects.toThrow(/aerb_licences_decommission_ck/);
  });

  it("the CHECK refuses a validity window that ends before it begins", async () => {
    await expect(file(ct, "2026-12-31", "2026-01-01"))
      .rejects.toMatchObject({ code: "invalid_validity" });
  });

  /* ═══════════════════ WHO MAY FILE ═══════════════════ */

  it("a radiographer holding only the dose read cannot file a licence", async () => {
    await expect(withTx(db, (tx) => fileLicence(tx, outsider, {
      deviceResourceId: ct, licenceType: "licence", licenceNo: "AERB/CT/2026/9",
      validFrom: "2026-01-01", validTo: "2026-12-31",
    }))).rejects.toMatchObject({ code: "not_appointed", detail: { permission: "aerb.registers.manage" } });
    expect(await db.select().from(aerbLicences)).toHaveLength(0);
  });

  /* ═══════════════════ THE EVENT ═══════════════════ */

  it("filing appends aerb.licence_filed, and it names no patient", async () => {
    await file(ct, "2026-01-01", "2026-12-31");
    const [row] = await db.select().from(events).where(eq(events.name, "aerb.licence_filed"));
    expect(row).toBeDefined();
    expect(row!.payload).toMatchObject({ deviceResourceId: ct, licenceNo: "AERB/CT/2026/1", validTo: "2026-12-31" });
    expect(JSON.stringify(row!.payload)).not.toMatch(/patient/i);
  });

  /* ═══════════════════ THE APPOINTMENTS ═══════════════════ */

  it("appoints an RSO and finds them in post inside the window only", async () => {
    await withTx(db, (tx) => appointPerson(tx, rso, {
      userId: rso.id, personRole: "rso", approvalRef: "AERB/RSO/2026/17",
      qualification: "BSc Radiography, RSO Level-2", validFrom: "2026-01-01", validTo: "2028-12-31",
    }));
    expect((await appointedPerson(db, "rso", "2026-06-15"))?.approvalRef).toBe("AERB/RSO/2026/17");
    expect(await appointedPerson(db, "rso", "2029-01-01")).toBeNull();
    expect(await appointedPerson(db, "physicist", "2026-06-15")).toBeNull();
  });

  it("an open-ended appointment (no valid_to) runs until it is ended, and the row survives", async () => {
    const { personId } = await withTx(db, (tx) => appointPerson(tx, rso, {
      userId: rso.id, personRole: "physicist", qualification: "MSc Medical Physics", validFrom: "2026-01-01",
    }));
    expect(await appointedPerson(db, "physicist", "2030-06-15")).not.toBeNull();
    await withTx(db, (tx) => endAppointment(tx, rso, personId));
    expect(await appointedPerson(db, "physicist", "2026-06-15")).toBeNull();
    expect(await db.select().from(aerbPersons)).toHaveLength(1);
  });

  it("refuses two live appointments in one role for one person, and allows the two roles", async () => {
    await withTx(db, (tx) => appointPerson(tx, rso, {
      userId: rso.id, personRole: "rso", qualification: "RSO", validFrom: "2026-01-01",
    }));
    await expect(withTx(db, (tx) => appointPerson(tx, rso, {
      userId: rso.id, personRole: "rso", qualification: "RSO again", validFrom: "2026-06-01",
    }))).rejects.toThrow(/aerb_persons_user_role_active_ux/);
    await expect(withTx(db, (tx) => appointPerson(tx, rso, {
      userId: rso.id, personRole: "physicist", qualification: "also the physicist", validFrom: "2026-06-01",
    }))).resolves.toMatchObject({ personId: expect.any(String) });
  });

  /* ═══════════════════ THE REGISTER AS A BOOK, AND THE GAP ═══════════════════ */

  it("the register carries the machine's own label and the RSO's name, and hides retired rows by default", async () => {
    const { licenceId } = await file(ct, "2026-01-01", "2026-12-31");
    const live = await licenceRegister(db);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ deviceCode: "CT-1", modality: "ct", rsoName: "rso.bhat" });
    await withTx(db, (tx) => changeLicenceStatus(tx, rso, licenceId, "surrendered", { decommissionRef: "D/1" }));
    expect(await licenceRegister(db)).toHaveLength(0);
    expect(await licenceRegister(db, { includeInactive: true })).toHaveLength(1);
  });

  it("a licence with no RSO named still appears in the register — R1 is not a reason to lose the row", async () => {
    await withTx(db, (tx) => fileLicence(tx, rso, {
      deviceResourceId: ct, licenceType: "registration", licenceNo: "AERB/DR/2026/4",
      validFrom: "2026-01-01", validTo: "2026-12-31", rsoUserId: null,
    }));
    const rows = await licenceRegister(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rsoName).toBeNull();
  });

  /**
   * THE NEGATIVE SPACE (brainstorm §14): the register's value is the machine it cannot account
   * for. An ionising unit with no paper is listed; the ultrasound machine beside it is not, because
   * AERB licences neither ultrasound nor MRI and a gap list that cried about them would be ignored.
   */
  it("the gap list names the unlicensed CT and never the USG", async () => {
    const gaps = await unlicensedDevices(db, "2026-06-15");
    expect(gaps.map((g) => g.code)).toEqual(["CT-1"]);
    await file(ct, "2026-01-01", "2026-12-31");
    expect(await unlicensedDevices(db, "2026-06-15")).toHaveLength(0);
    /** And a lapsed licence puts the machine straight back into the gap. */
    expect((await unlicensedDevices(db, "2027-06-15")).map((g) => g.code)).toEqual(["CT-1"]);
    expect(usg).toBeDefined();
  });

  it("appointments() lists who is in post on a day", async () => {
    await withTx(db, (tx) => appointPerson(tx, rso, {
      userId: rso.id, personRole: "rso", qualification: "RSO", validFrom: "2026-01-01", validTo: "2026-12-31",
    }));
    expect((await appointments(db, { onDate: "2026-06-15" })).map((a) => a.userName)).toEqual(["rso.bhat"]);
    expect(await appointments(db, { onDate: "2027-06-15" })).toHaveLength(0);
  });
});
