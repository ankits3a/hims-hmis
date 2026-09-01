import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  pcpndtRegisteredMachines, pcpndtRegisteredPersons, pcpndtRegistrations,
} from "../../kernel/db/schema/pcpndt";
import { PcpndtError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18a T6 / §19 — **THE FACILITY REGISTRATION, ITS MACHINES AND ITS PEOPLE.**
 *
 * ═══ THIS FILE SEEDS NOTHING, AND THAT IS THE POSTURE (§4A) ═══
 *
 * A registration number, its validity dates and the in-charge come off a CERTIFICATE the hospital
 * holds. They are law, not configuration. So there is a runbook route and no seed, and until a human
 * enters the real registration **every applicable scan is refused** — which is the correct behaviour
 * of a hospital that has not filed, rather than a placeholder that lets an unregistered ultrasound
 * proceed. The same argument `study_types` makes one module over, with a criminal statute behind it.
 *
 * ═══ MEMBERSHIP, NEVER EXISTENCE — A2's WHOLE POINT ═══
 *
 * The natural shortcut is to ask *"is this doctor a registered person?"* and *"is this machine a
 * registered machine?"* as two independent questions. **That is A2's mutant**, and what it lets
 * through is the doctor registered at the satellite clinic scanning on the main site's machine —
 * two `active` rows, two true answers, and one scan performed by a person the Act does not permit
 * on that machine. Every check below is therefore about ONE registration: the machine's.
 *
 * ═══ THE VALIDITY WINDOW IS A HARD BLOCK (A7, O-7) ═══
 *
 * A registration whose `valid_to` has passed makes `activeRegistrationFor` return **null**, and
 * every machine on it is unregistered from that morning. There is no grace period and no
 * filed-renewal lift — that is 18a-ii's, and it needs no column change to add. A7's mutant ignores
 * `valid_to`, and N7 is what it costs: scanning on a lapsed registration is the offence the
 * renewal deadline exists to prevent.
 *
 * **The date is the CALLER's IST calendar day, never derived here.** `kernel/orders/place.ts` sets
 * that rule — *"resolved by the caller with `istDate` and never derived here … a kernel seam that
 * re-derived it would be a second place that knows about the offset"* — and it applies with extra
 * force in this module, which by DD1 must not import a department in order to know what day it is.
 */

const MANAGE = "pcpndt.registrations.manage";

export type RegistrationRow = typeof pcpndtRegistrations.$inferSelect;
export type RegisteredMachineRow = typeof pcpndtRegisteredMachines.$inferSelect;
export type RegisteredPersonRow = typeof pcpndtRegisteredPersons.$inferSelect;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertIstDate(value: string, field: string): void {
  if (!DATE_RE.test(value)) {
    throw new PcpndtError(
      "unknown_registration",
      `${field} must be an IST calendar date (YYYY-MM-DD), got "${value}"`,
      { field },
    );
  }
}

async function assertMayManage(exec: Db | Tx, actor: Actor): Promise<void> {
  if (actor.type !== "user") {
    throw new PcpndtError(
      "no_active_registration",
      "only a signed-in user may change the PCPNDT register — this is a statutory record",
    );
  }
  if (!(await hasPermission(exec as Db, actor.id, MANAGE, "hospital"))) {
    throw new PcpndtError(
      "no_active_registration",
      `${actor.id} does not hold ${MANAGE}`,
      { permission: MANAGE },
    );
  }
}

/**
 * Records the §19 certificate. `registration_no` is UNIQUE, so filing the same certificate twice is
 * a database refusal rather than two registrations one reader picks between.
 */
export async function createRegistration(
  tx: Tx,
  actor: Actor,
  input: {
    site: string; registrationNo: string; validFrom: string; validTo: string;
    inchargeUserId?: string | null;
  },
): Promise<{ registrationId: string }> {
  await assertMayManage(tx, actor);
  assertIstDate(input.validFrom, "validFrom");
  assertIstDate(input.validTo, "validTo");
  if (input.validTo < input.validFrom) {
    throw new PcpndtError(
      "unknown_registration",
      `the validity window ends (${input.validTo}) before it begins (${input.validFrom}) — that is a typo on a legal document`,
    );
  }
  const registrationId = newId();
  await tx.insert(pcpndtRegistrations).values({
    id: registrationId,
    site: input.site,
    registrationNo: input.registrationNo,
    validFrom: input.validFrom,
    validTo: input.validTo,
    inchargeUserId: input.inchargeUserId ?? null,
    createdBy: actor.id,
  });
  return { registrationId };
}

/** Form B's machine list. `pcpndt_registered_machines_device_active_ux` holds one ACTIVE row per device. */
export async function addMachine(
  tx: Tx,
  actor: Actor,
  input: {
    registrationId: string; deviceResourceId: string;
    make: string; model: string; serial: string; formBRef?: string | null;
  },
): Promise<{ machineId: string }> {
  await assertMayManage(tx, actor);
  await requireRegistration(tx, input.registrationId);
  const machineId = newId();
  await tx.insert(pcpndtRegisteredMachines).values({
    id: machineId,
    registrationId: input.registrationId,
    deviceResourceId: input.deviceResourceId,
    make: input.make,
    model: input.model,
    serial: input.serial,
    formBRef: input.formBRef ?? null,
    createdBy: actor.id,
  });
  return { machineId };
}

/**
 * E1/N2 — the 02:00 suspected ectopic with the sonologist at home. **The ED doctor is a registered
 * person or the scan does not happen**, and the corporate answer is to register every doctor who
 * may ever scan (O-13) rather than to build a bypass. This is that registration.
 */
export async function addPerson(
  tx: Tx,
  actor: Actor,
  input: { registrationId: string; userId: string; qualification: string; councilRegNo?: string | null },
): Promise<{ personId: string }> {
  await assertMayManage(tx, actor);
  await requireRegistration(tx, input.registrationId);
  const personId = newId();
  await tx.insert(pcpndtRegisteredPersons).values({
    id: personId,
    registrationId: input.registrationId,
    userId: input.userId,
    qualification: input.qualification,
    councilRegNo: input.councilRegNo ?? null,
    createdBy: actor.id,
  });
  return { personId };
}

async function requireRegistration(exec: Db | Tx, registrationId: string): Promise<RegistrationRow> {
  const rows = await (exec as Db).select().from(pcpndtRegistrations)
    .where(eq(pcpndtRegistrations.id, registrationId));
  const found = rows[0];
  if (!found) {
    throw new PcpndtError("unknown_registration", `no registration ${registrationId}`, { registrationId });
  }
  return found;
}

/**
 * ═══ DEACTIVATION IS A FLAG, NEVER A DELETE ═══
 *
 * A machine sold, a doctor who left, a registration surrendered — all of them are FACTS about a
 * period, and an inspector asking *"who was registered on this machine in March"* must still get an
 * answer in June. `active = false` and `status` are what change; no row ever leaves this register.
 */
/**
 * ═══ F62 (CLOSE REVIEW) — A DEREGISTRATION THAT DEREGISTERS NOBODY IS NOT A SUCCESS ═══
 *
 * Both of these issued a bare `UPDATE … WHERE id = ?` with no existence check and no row-count
 * check, and the controller answered `{active:false}` unconditionally — while `deactivateRegistration`
 * eleven lines below DID call `requireRegistration`. The asymmetry inside one file is the tell.
 *
 * The harm is not hypothetical. `read.ts` returns `{ id, userId, qualification }` for a registered
 * person, so the console shows two ids for one row. A PCPNDT in-charge deregistering a struck-off
 * sonologist by the USER id instead of the REGISTRATION-ROW id got `200 {"active":false}`, recorded
 * the deregistration as done — and the doctor stayed `active`, so `assertPersonRegistered` kept
 * passing and he kept signing Form Fs. The `RETURNING` below makes the refusal the database's.
 */
export async function deactivateMachine(tx: Tx, actor: Actor, machineId: string): Promise<void> {
  await assertMayManage(tx, actor);
  const rows = await tx.update(pcpndtRegisteredMachines).set({ active: false })
    .where(eq(pcpndtRegisteredMachines.id, machineId))
    .returning({ id: pcpndtRegisteredMachines.id });
  if (rows.length === 0) {
    throw new PcpndtError(
      "unknown_registration",
      `no registered machine ${machineId} — nothing was deregistered, and a deregistration that `
      + "deregisters nobody must not report success",
      { machineId },
    );
  }
}

export async function deactivatePerson(tx: Tx, actor: Actor, personId: string): Promise<void> {
  await assertMayManage(tx, actor);
  const rows = await tx.update(pcpndtRegisteredPersons).set({ active: false })
    .where(eq(pcpndtRegisteredPersons.id, personId))
    .returning({ id: pcpndtRegisteredPersons.id });
  if (rows.length === 0) {
    throw new PcpndtError(
      "unknown_registration",
      `no registered person ${personId} — nothing was deregistered. If you were given a USER id, `
      + "the register's own row id is the one this route takes",
      { personId },
    );
  }
}

/** `suspended` and `cancelled` are both non-`active`, so both stop every machine on the registration. */
export async function deactivateRegistration(
  tx: Tx, actor: Actor, registrationId: string, status: "suspended" | "cancelled",
): Promise<void> {
  await assertMayManage(tx, actor);
  await requireRegistration(tx, registrationId);
  await tx.update(pcpndtRegistrations).set({ status })
    .where(eq(pcpndtRegistrations.id, registrationId));
}

/**
 * ═══ A7 — THE ONE READER THAT DECIDES WHETHER A MACHINE MAY SCAN ═══
 *
 * A device is registered iff there is an ACTIVE machine row on it, whose registration is `active`
 * AND whose validity window contains `onDate`. All four conditions in one query, because four
 * separate reads are four chances for a caller to check three of them.
 *
 * Returns the REGISTRATION, not a boolean, because every caller needs it: `assertPersonRegistered`
 * needs its id to ask the membership question (A2), and `openFormF` needs the machine row to mint a
 * serial against.
 */
export async function activeRegistrationFor(
  exec: Db | Tx,
  deviceResourceId: string,
  onDate: string,
): Promise<{ registration: RegistrationRow; machine: RegisteredMachineRow } | null> {
  assertIstDate(onDate, "onDate");
  const rows = await (exec as Db)
    .select({ registration: pcpndtRegistrations, machine: pcpndtRegisteredMachines })
    .from(pcpndtRegisteredMachines)
    .innerJoin(pcpndtRegistrations, eq(pcpndtRegistrations.id, pcpndtRegisteredMachines.registrationId))
    .where(and(
      eq(pcpndtRegisteredMachines.deviceResourceId, deviceResourceId),
      eq(pcpndtRegisteredMachines.active, true),
      eq(pcpndtRegistrations.status, "active"),
      /**
       * A7. Compared as DATES in the database rather than as strings in Node: `valid_from` and
       * `valid_to` are `date` columns, and a string comparison would be correct only for as long as
       * every caller happened to pass a zero-padded ISO day.
       */
      sql`${pcpndtRegistrations.validFrom} <= ${onDate}::date`,
      sql`${pcpndtRegistrations.validTo} >= ${onDate}::date`,
    ))
    .limit(1);
  return rows[0] ?? null;
}

/** Every person on a registration, for the console and for the membership check. */
export async function registeredPersons(
  exec: Db | Tx, registrationId: string,
): Promise<RegisteredPersonRow[]> {
  return await (exec as Db).select().from(pcpndtRegisteredPersons)
    .where(and(
      eq(pcpndtRegisteredPersons.registrationId, registrationId),
      eq(pcpndtRegisteredPersons.active, true),
    ));
}
