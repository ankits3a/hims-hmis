import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkDevice, setupPcpndtFixture } from "../../../test/helpers/pcpndt";
import { pcpndtRegistrations } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import {
  activeRegistrationFor, addMachine, addPerson, createRegistration, deactivateMachine, deactivatePerson, deactivateRegistration, readRegister, registeredPersons,
} from "./registrations";
import type { PcpndtFixture } from "../../../test/helpers/pcpndt";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T6 — Assertion Book row **A7**, plus the register's own rules.
 *
 * A7 is the validity window, and its mutant is *"ignore `valid_to`"* → N7: the hospital keeps
 * scanning on a registration that lapsed at midnight, which is the offence the renewal deadline
 * exists to prevent. The window is walked at BOTH edges rather than at one, because a hard block
 * that is off by a day is a hard block that stops a legal scan or permits an illegal one.
 */
describe("the PCPNDT registration, its machines and its people (18a T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PcpndtFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupPcpndtFixture(db);
  });

  const on = (date: string) => activeRegistrationFor(db, fx.deviceResourceId, date);

  /* ═══════════════════════ A7 — THE VALIDITY WINDOW ═══════════════════════ */

  /* ────────── `readRegister` — the door `pcpndt.registrations.read` never had ────────── */

  /**
   * The permission was declared at 18a T6, granted to `radiologist` and `pcpndt_incharge`, and
   * guarded NOTHING until 2026-09-07 — it appeared in the manifest and in no route. The five writes
   * could populate a register that nothing could read back, so a hospital following the go-live
   * runbook had no way to confirm what it had entered.
   */
  it("reads the whole book — the registration with its machines and its people assembled", async () => {
    const book = await readRegister(db);

    expect(book).toHaveLength(1);
    expect(book[0]!.registration.registrationNo).toBe("PNDT/MH/2026/0001");
    expect(book[0]!.machines.map((m) => m.serial)).toEqual(["SN-99001"]);
    expect(book[0]!.persons.map((p) => p.userId)).toEqual([fx.sonologist.id]);
  });

  /**
   * ═══ WITHDRAWN ROWS ARE IN THE BOOK, AND THAT IS THE DECISION ═══
   *
   * `active` is a withdrawal flag rather than a delete — the schema says *"a machine sold last year
   * still has its serial series and its forms."* A reader that returned only live rows would answer
   * "what is registered today", which `activeRegistrationFor` already answers, and would silently
   * lose the historical half an inspection asks for. **The flag is returned so the caller decides.**
   *
   * This is the assertion that fails if someone later "tidies" the reader with an `active = true`
   * filter, which is the natural mistake precisely because every other loader in this file has one.
   */
  it("includes a WITHDRAWN machine, with its flag — the register is historical, not a live view", async () => {
    await withTx(db, (tx) => deactivateMachine(tx, fx.incharge, fx.machineId));

    const book = await readRegister(db);

    expect(book[0]!.machines.map((m) => [m.serial, m.active])).toEqual([["SN-99001", false]]);
    /** And the live view still says what it always said — the two readers disagree on purpose. */
    expect(await activeRegistrationFor(db, fx.deviceResourceId, "2026-06-01")).toBeNull();
  });

  /** No register at all is an empty book, not a throw — the state every fresh deployment is in. */
  it("returns an empty book on a database with no register", async () => {
    await truncateAll(db);
    expect(await readRegister(db)).toEqual([]);
  });

  it("A7: a device on a live registration resolves inside the window", async () => {
    const found = await on("2026-06-15");
    expect(found?.registration.registrationNo).toBe("PNDT/MH/2026/0001");
    expect(found?.machine.id).toBe(fx.machineId);
  });

  /**
   * A7's mutant ignores `valid_to`. The three rows below are the boundary walked: the last legal
   * day resolves, the first day after does NOT, and the day before the window opens does not either.
   */
  it.each([
    ["2025-12-31", false, "the day before it begins"],
    ["2026-01-01", true, "the first day (inclusive)"],
    ["2027-12-31", true, "the last day (inclusive)"],
    ["2028-01-01", false, "the day after it lapses — N7"],
  ])("A7: %s → registered = %s (%s)", async (date, expected) => {
    expect(await on(date) !== null).toBe(expected);
  });

  it("A7: a LAPSED registration makes every machine on it unregistered, not merely the registration", async () => {
    await truncateAll(db);
    fx = await setupPcpndtFixture(db, { validFrom: "2020-01-01", validTo: "2021-01-01" });
    expect(await activeRegistrationFor(db, fx.deviceResourceId, "2026-06-15")).toBeNull();
  });

  /** `suspended` and `cancelled` both stop the machine — a status check that named only one would leak. */
  it.each(["suspended", "cancelled"] as const)("a %s registration stops its machines", async (status) => {
    await withTx(db, (tx) => deactivateRegistration(tx, fx.incharge, fx.registrationId, status));
    expect(await on("2026-06-15")).toBeNull();
    const [row] = await db.select().from(pcpndtRegistrations).where(eq(pcpndtRegistrations.id, fx.registrationId));
    expect(row!.status).toBe(status);
  });

  it("a deactivated MACHINE is unregistered while its registration stays live for the others", async () => {
    const second = await mkDevice(db, "USG-3");
    await withTx(db, (tx) => addMachine(tx, fx.incharge, {
      registrationId: fx.registrationId, deviceResourceId: second, make: "Philips", model: "Affiniti", serial: "SN-2",
    }));
    await withTx(db, (tx) => deactivateMachine(tx, fx.incharge, fx.machineId));

    expect(await on("2026-06-15")).toBeNull();
    expect(await activeRegistrationFor(db, second, "2026-06-15")).not.toBeNull();
  });

  it("a device on NO registration resolves to null", async () => {
    expect(await activeRegistrationFor(db, fx.unregisteredDeviceId, "2026-06-15")).toBeNull();
  });

  /* ═══════════════════════ the register's own rules ═══════════════════════ */

  it("refuses a validity window that ends before it begins — a typo on a legal document", async () => {
    await expect(withTx(db, (tx) => createRegistration(tx, fx.incharge, {
      site: "Satellite", registrationNo: "PNDT/MH/2026/9", validFrom: "2026-06-01", validTo: "2026-05-01",
    }))).rejects.toThrow(/ends .* before it begins/);
  });

  it("refuses a caller without `pcpndt.registrations.manage` — the sonologist files no certificates", async () => {
    await expect(withTx(db, (tx) => createRegistration(tx, fx.sonologist, {
      site: "Satellite", registrationNo: "PNDT/MH/2026/8", validFrom: "2026-01-01", validTo: "2027-01-01",
    }))).rejects.toMatchObject({ code: "no_active_registration" });
  });

  it("refuses a machine or a person on a registration that does not exist", async () => {
    await expect(withTx(db, (tx) => addMachine(tx, fx.incharge, {
      registrationId: "01NOPE0000000000000000000", deviceResourceId: fx.unregisteredDeviceId,
      make: "x", model: "y", serial: "z",
    }))).rejects.toMatchObject({ code: "unknown_registration" });
    await expect(withTx(db, (tx) => addPerson(tx, fx.incharge, {
      registrationId: "01NOPE0000000000000000000", userId: fx.sonologist.id, qualification: "MD",
    }))).rejects.toMatchObject({ code: "unknown_registration" });
  });

  /**
   * `pcpndt_registered_machines_device_active_ux` — one ACTIVE registration per device. Without it a
   * machine could sit on two and `activeRegistrationFor` would return whichever was read first,
   * which is §2.54's mechanism with a criminal statute on the other end.
   */
  it("a device cannot sit on two ACTIVE registrations at once (the partial unique)", async () => {
    const { registrationId: second } = await withTx(db, (tx) => createRegistration(tx, fx.incharge, {
      site: "Satellite", registrationNo: "PNDT/MH/2026/0002", validFrom: "2026-01-01", validTo: "2027-12-31",
    }));
    await expect(withTx(db, (tx) => addMachine(tx, fx.incharge, {
      registrationId: second, deviceResourceId: fx.deviceResourceId, make: "GE", model: "x", serial: "y",
    }))).rejects.toThrow(/pcpndt_registered_machines_device_active_ux|duplicate key/);
  });

  /** …and it releases once the first is deactivated: a machine sold on is registrable by the buyer. */
  it("the device unique RELEASES when the first machine row is deactivated", async () => {
    await withTx(db, (tx) => deactivateMachine(tx, fx.incharge, fx.machineId));
    const { registrationId: second } = await withTx(db, (tx) => createRegistration(tx, fx.incharge, {
      site: "Satellite", registrationNo: "PNDT/MH/2026/0003", validFrom: "2026-01-01", validTo: "2027-12-31",
    }));
    const { machineId } = await withTx(db, (tx) => addMachine(tx, fx.incharge, {
      registrationId: second, deviceResourceId: fx.deviceResourceId, make: "GE", model: "x", serial: "y",
    }));
    expect((await on("2026-06-15"))?.machine.id).toBe(machineId);
  });

  it("deactivation is a FLAG and never a delete — an inspector asking about March gets March", async () => {
    await withTx(db, (tx) => deactivatePerson(tx, fx.incharge, fx.personId));
    expect(await registeredPersons(db, fx.registrationId)).toEqual([]);
    /** The row is still there, inactive, with its history. */
    const all = await db.select().from(pcpndtRegistrations).where(eq(pcpndtRegistrations.id, fx.registrationId));
    expect(all).toHaveLength(1);
  });

  it("refuses a date that is not an IST calendar day rather than guessing", async () => {
    await expect(activeRegistrationFor(db, fx.deviceResourceId, "15/06/2026")).rejects.toThrow(/YYYY-MM-DD/);
  });
});
