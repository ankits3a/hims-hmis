import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { aerbLicences, aerbPersons } from "../../kernel/db/schema/aerb";
import { resources } from "../../kernel/db/schema/resources";
import { AERB_LICENCE_TYPES, AERB_PERSON_ROLES } from "../../kernel/db/schema/aerb";
import { AerbError } from "./errors";
import { aerbLicenceFiled, aerbLicenceStatusChanged } from "./events";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { AerbLicenceType, AerbPersonRole } from "../../kernel/db/schema/aerb";

/**
 * PLAN 18c T1 — **THE EQUIPMENT LICENCE REGISTER, AND THE MACHINE THAT MAY NOT EMIT WITHOUT ONE.**
 *
 * ═══ THIS FILE SEEDS NOTHING, AND THAT IS THE POSTURE ═══
 *
 * A licence number, its eLORA reference and its validity dates come off a document AERB issued.
 * They are law, not configuration. So there is a route and no seed, and until a human files the
 * real licence **every ionising study on that machine is refused** — the correct behaviour of a
 * hospital that has not filed, rather than a placeholder that lets an unlicensed CT scan a patient
 * because the row was convenient to invent. `pcpndt/registrations.ts` states the same posture for
 * the same reason one statute over.
 *
 * ═══ THE VALIDITY WINDOW IS A HARD BLOCK, AND THE DATE IS THE CALLER'S ═══
 *
 * A licence whose `valid_to` has passed makes `activeLicenceFor` return **null**, and the machine
 * is unlicensed from that morning. No grace period: a renewal that has not arrived is a machine
 * that stops, which is what the renewal deadline exists to make true.
 *
 * **The date is the CALLER's IST calendar day, never derived here** — `kernel/orders/place.ts` sets
 * that rule and it binds with extra force in a module that by D1 must not import a department in
 * order to learn what day it is.
 *
 * ═══ WHY THE GATE IS `ionising`, NOT "is it a CT" ═══
 *
 * AERB licences equipment that emits ionising radiation. An ultrasound machine and an MRI scanner
 * hold no AERB licence and never will, so a gate keyed on the DEVICE would have to carry a list of
 * modalities and would refuse the wrong ones the day somebody adds a new one. The caller passes the
 * study's own snapshotted `ionising` flag (`imaging_studies.ionising`, set at creation so a
 * republished definition cannot retroactively make an acquired study illegal) and this file asks
 * only about the licence.
 */

const MANAGE = "aerb.registers.manage";

export type AerbLicenceRow = typeof aerbLicences.$inferSelect;
export type AerbPersonRow = typeof aerbPersons.$inferSelect;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * CLOSE REVIEW — the shape check alone let `2026-02-31` through: it passed the regex, passed the
 * `validTo >= validFrom` string compare, and failed at the INSERT with a Postgres date error no
 * mapper knows. So the one input class most likely to be a typo bypassed the 422 that exists to
 * name it. A date is now checked for being a real day as well as a well-formed one.
 */
function assertIstDate(value: string, field: string): void {
  if (!DATE_RE.test(value)) {
    throw new AerbError(
      "invalid_validity",
      `${field} must be an IST calendar date (YYYY-MM-DD), got "${value}"`,
      { field },
    );
  }
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
    throw new AerbError(
      "invalid_validity",
      `${field} "${value}" is not a real date`,
      { field },
    );
  }
}

async function assertMayManage(exec: Db | Tx, actor: Actor): Promise<void> {
  if (actor.type !== "user") {
    throw new AerbError(
      "not_appointed",
      "only a signed-in user may change the AERB register — this is a statutory record",
    );
  }
  if (!(await hasPermission(exec as Db, actor.id, MANAGE, "hospital"))) {
    throw new AerbError("not_appointed", `${actor.id} does not hold ${MANAGE}`, { permission: MANAGE });
  }
}

export interface FileLicenceInput {
  deviceResourceId: string;
  licenceType: AerbLicenceType;
  licenceNo: string;
  eloraRef?: string | null;
  typeApprovalRef?: string | null;
  layoutApprovalRef?: string | null;
  validFrom: string;
  validTo: string;
  rsoUserId?: string | null;
  remarks?: string | null;
}

/**
 * Files the certificate. The unique index does the work that matters: **one ACTIVE licence per
 * device**, so a renewal is "suspend or surrender the old row, then file the new one" and never two
 * live rows a reader picks between. The pre-read below exists to turn that into a NAMED refusal
 * rather than a constraint violation the controller would have to guess at — the constraint is
 * still what makes it true under concurrency.
 */
export async function fileLicence(
  tx: Tx, actor: Actor, input: FileLicenceInput,
): Promise<{ licenceId: string }> {
  await assertMayManage(tx, actor);
  assertIstDate(input.validFrom, "validFrom");
  assertIstDate(input.validTo, "validTo");
  if (input.validTo < input.validFrom) {
    throw new AerbError(
      "invalid_validity",
      `validTo ${input.validTo} is before validFrom ${input.validFrom} — a licence cannot expire before it is issued`,
      { validFrom: input.validFrom, validTo: input.validTo },
    );
  }
  if (!(AERB_LICENCE_TYPES as readonly string[]).includes(input.licenceType)) {
    throw new AerbError("invalid_validity", `"${input.licenceType}" is not an AERB licence type`);
  }

  /**
   * CLOSE REVIEW — the licence must point at a MACHINE. Nothing checked the kind, so a bed's or an
   * OPD room's resource id filed an AERB licence against it and rendered in the inspector's file as
   * a licensed machine, while `unlicensedDevices` (which does filter `kind = 'device'`) disagreed
   * about what a machine is.
   *
   * PASS 2 — the row is taken `FOR UPDATE`. It is the one row that always exists for this device,
   * so locking it serialises two concurrent files and makes the overlap check below race-free,
   * which a pre-read alone could never be (and which no partial unique index can express).
   */
  const deviceRows = await tx.select({ kind: resources.kind })
    .from(resources).where(eq(resources.id, input.deviceResourceId)).for("update");
  const device = deviceRows[0];
  if (device === undefined || device.kind !== "device") {
    throw new AerbError(
      "unknown_licence",
      `${input.deviceResourceId} is not a device resource — an AERB licence names a machine`,
      { deviceResourceId: input.deviceResourceId, kind: device?.kind ?? null },
    );
  }

  /**
   * ═══ PASS 2, CRITICAL — A RENEWAL IS THE NEXT WINDOW, NOT A SURRENDER ═══
   *
   * Pass 1 built a renewal that surrendered the outgoing certificate the instant the incoming one
   * was filed, so entering the 2027 licence in November left the CT with nothing in force for the
   * rest of 2026 — every ionising study refused from the day the paperwork arrived, with no way
   * back because `surrendered` is terminal. It stopped the machine it was written to keep running.
   *
   * What a hospital has is a SEQUENCE of certificates with non-overlapping validity. So the 2027
   * licence is simply filed, both rows are `active`, and `activeLicenceFor` — which has always
   * asked the DATE question — returns the 2026 one on 20 November and the 2027 one on 2 January.
   * What is refused is an OVERLAP, because two certificates covering one day is the ambiguity the
   * old index was really about.
   */
  const others = await tx.select({
    id: aerbLicences.id, licenceNo: aerbLicences.licenceNo,
    validFrom: aerbLicences.validFrom, validTo: aerbLicences.validTo,
  })
    .from(aerbLicences)
    .where(and(
      eq(aerbLicences.deviceResourceId, input.deviceResourceId),
      ne(aerbLicences.status, "surrendered"),
    ));
  const overlap = others.find((o) => o.validFrom <= input.validTo && input.validFrom <= o.validTo);
  if (overlap !== undefined) {
    throw new AerbError(
      "licence_already_active",
      `device ${input.deviceResourceId} already carries licence ${overlap.licenceNo} covering `
      + `${overlap.validFrom}..${overlap.validTo}, which overlaps ${input.validFrom}..${input.validTo}. `
      + "Two certificates cannot cover the same day; a RENEWAL simply starts where the last one ends "
      + "and may be filed the day it arrives",
      {
        deviceResourceId: input.deviceResourceId,
        conflictingLicenceId: overlap.id,
        conflictingWindow: `${overlap.validFrom}..${overlap.validTo}`,
      },
    );
  }

  const licenceId = newId();
  try {
    await tx.insert(aerbLicences).values({
      id: licenceId,
      deviceResourceId: input.deviceResourceId,
      licenceType: input.licenceType,
      licenceNo: input.licenceNo,
      eloraRef: input.eloraRef ?? null,
      typeApprovalRef: input.typeApprovalRef ?? null,
      layoutApprovalRef: input.layoutApprovalRef ?? null,
      validFrom: input.validFrom,
      validTo: input.validTo,
      rsoUserId: input.rsoUserId ?? null,
      remarks: input.remarks ?? null,
      status: "active",
      createdBy: actor.id,
    });
  } catch (e) {
    /**
     * CLOSE REVIEW — the pre-reads above take no row lock, so two simultaneous files on one device
     * both see no active row and one loses at the index. `errors.ts` promises a 409 for exactly
     * that ("a lost race on the counter, not a malformed request") and what came back was a raw
     * 23505 with an index name in it.
     */
    if ((e as { code?: unknown }).code === "23505") {
      throw new AerbError(
        "licence_already_active",
        `licence ${input.licenceNo} or device ${input.deviceResourceId} was filed by somebody else `
        + "while this was being recorded",
        { deviceResourceId: input.deviceResourceId, licenceNo: input.licenceNo },
      );
    }
    throw e;
  }

  await appendEvent(tx, aerbLicenceFiled.make({
    payload: {
      licenceId,
      deviceResourceId: input.deviceResourceId,
      licenceType: input.licenceType,
      licenceNo: input.licenceNo,
      validFrom: input.validFrom,
      validTo: input.validTo,
    },
    actor,
    correlationId: input.deviceResourceId,
  }));

  return { licenceId };
}

/**
 * Suspends, restores or surrenders. **`surrendered` is terminal** and takes the decommissioning
 * date with it, because AERB requires the decommissioning itself to be documented and a status
 * somebody set on a Tuesday with nothing to show is not a record. The CHECK in the schema is the
 * half that makes that unavoidable; this is the half that gives it a message.
 */
export async function changeLicenceStatus(
  tx: Tx, actor: Actor, licenceId: string,
  to: "active" | "suspended" | "surrendered",
  opts: { reason?: string | null; decommissionRef?: string | null; at?: Date } = {},
): Promise<void> {
  await assertMayManage(tx, actor);
  const rows = await tx.select().from(aerbLicences).where(eq(aerbLicences.id, licenceId));
  const licence = rows[0];
  if (!licence) throw new AerbError("unknown_licence", `no AERB licence ${licenceId}`, { licenceId });
  if (licence.status === "surrendered") {
    throw new AerbError(
      "already_surrendered",
      `licence ${licence.licenceNo} was surrendered on ${licence.decommissionedAt?.toISOString() ?? "?"} — `
      + "a surrendered licence is terminal; a machine returning to service is a NEW licence",
      { licenceId },
    );
  }
  if (licence.status === to) return;

  /**
   * Restoring to `active` must not create an OVERLAP, and must not collide with another live
   * certificate carrying the same number.
   *
   * PASS 2 — the old check was "does this device have any active licence", which is no longer the
   * invariant, and it did not look at the number at all: since `licence_no`'s uniqueness became
   * partial, restoring a suspended licence whose number had meanwhile been filed on another machine
   * hit `aerb_licences_no_active_ux` as a raw 23505 and reached the RSO as a 500.
   */
  if (to === "active") {
    const clash = await tx.select({
      id: aerbLicences.id, licenceNo: aerbLicences.licenceNo,
      deviceResourceId: aerbLicences.deviceResourceId,
      validFrom: aerbLicences.validFrom, validTo: aerbLicences.validTo,
    })
      .from(aerbLicences)
      .where(and(
        eq(aerbLicences.status, "active"),
        ne(aerbLicences.id, licenceId),
        or(
          eq(aerbLicences.deviceResourceId, licence.deviceResourceId),
          eq(aerbLicences.licenceNo, licence.licenceNo),
        ),
      ));
    const blocking = clash.find((c) =>
      c.licenceNo === licence.licenceNo
      || (c.validFrom <= licence.validTo && licence.validFrom <= c.validTo));
    if (blocking !== undefined) {
      throw new AerbError(
        "licence_already_active",
        blocking.licenceNo === licence.licenceNo
          ? `licence number ${licence.licenceNo} is live on device ${blocking.deviceResourceId}`
          : `device ${licence.deviceResourceId} already carries licence ${blocking.licenceNo} covering `
            + `${blocking.validFrom}..${blocking.validTo}`,
        { deviceResourceId: licence.deviceResourceId, conflictingLicenceId: blocking.id },
      );
    }
  }

  const at = opts.at ?? new Date();
  await tx.update(aerbLicences).set({
    status: to,
    decommissionedAt: to === "surrendered" ? at : null,
    decommissionRef: to === "surrendered" ? (opts.decommissionRef ?? null) : null,
    updatedBy: actor.id,
    updatedAt: at,
  }).where(eq(aerbLicences.id, licenceId));

  await appendEvent(tx, aerbLicenceStatusChanged.make({
    payload: {
      licenceId,
      deviceResourceId: licence.deviceResourceId,
      from: licence.status,
      to,
      reason: opts.reason ?? null,
    },
    actor,
    correlationId: licence.deviceResourceId,
    occurredAt: at,
  }));
}

/**
 * The register's one question: **is this machine licensed on this day?** `null` means no, for every
 * reason that counts as no — never filed, suspended, surrendered, expired, or not yet in force.
 */
export async function activeLicenceFor(
  exec: Db | Tx, deviceResourceId: string, onDate: string,
): Promise<AerbLicenceRow | null> {
  assertIstDate(onDate, "onDate");
  const rows = await (exec as Db).select()
    .from(aerbLicences)
    .where(and(
      eq(aerbLicences.deviceResourceId, deviceResourceId),
      eq(aerbLicences.status, "active"),
      sql`${aerbLicences.validFrom} <= ${onDate}`,
      sql`${aerbLicences.validTo} >= ${onDate}`,
    ));
  return rows[0] ?? null;
}

/**
 * D3 — **an ionising study may not be acquired on a machine AERB has not licensed.** Returns the
 * licence so the caller does not read it twice, exactly as `assertMachineRegistered` does one
 * statute over.
 *
 * The mutant this shape exists to kill is the one that checks `valid_from` alone and lets a lapsed
 * licence through — which is the offence a renewal deadline exists to prevent, and it is invisible
 * to any test whose fixture licence never expires.
 */
export async function assertDeviceLicensed(
  exec: Db | Tx, deviceResourceId: string, onDate: string,
): Promise<{ licenceId: string; licenceNo: string }> {
  const licence = await activeLicenceFor(exec, deviceResourceId, onDate);
  if (!licence) {
    throw new AerbError(
      "device_not_licensed",
      `device ${deviceResourceId} carries no active AERB licence covering ${onDate} — equipment that `
      + "emits ionising radiation may not be operated without one",
      { deviceResourceId, onDate },
    );
  }
  return { licenceId: licence.id, licenceNo: licence.licenceNo };
}

export interface AppointPersonInput {
  userId: string;
  personRole: AerbPersonRole;
  approvalRef?: string | null;
  qualification: string;
  validFrom: string;
  validTo?: string | null;
}

/** Appoints the RSO or the medical physicist. O-13 names the humans; this records the appointment. */
export async function appointPerson(
  tx: Tx, actor: Actor, input: AppointPersonInput,
): Promise<{ personId: string }> {
  await assertMayManage(tx, actor);
  assertIstDate(input.validFrom, "validFrom");
  if (input.validTo != null) {
    assertIstDate(input.validTo, "validTo");
    if (input.validTo < input.validFrom) {
      throw new AerbError("invalid_validity", `validTo ${input.validTo} is before validFrom ${input.validFrom}`);
    }
  }
  if (!(AERB_PERSON_ROLES as readonly string[]).includes(input.personRole)) {
    throw new AerbError("invalid_validity", `"${input.personRole}" is not an AERB appointment role`);
  }

  const personId = newId();
  await tx.insert(aerbPersons).values({
    id: personId,
    userId: input.userId,
    personRole: input.personRole,
    approvalRef: input.approvalRef ?? null,
    qualification: input.qualification,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    active: true,
    createdBy: actor.id,
  });
  return { personId };
}

/** Ends an appointment. The row stays: who was RSO in 2026 is a question an inspector asks. */
export async function endAppointment(tx: Tx, actor: Actor, personId: string): Promise<void> {
  await assertMayManage(tx, actor);
  const rows = await tx.select({ id: aerbPersons.id }).from(aerbPersons).where(eq(aerbPersons.id, personId));
  if (!rows[0]) throw new AerbError("unknown_person", `no AERB appointment ${personId}`, { personId });
  await tx.update(aerbPersons).set({ active: false }).where(eq(aerbPersons.id, personId));
}

/**
 * Is there somebody in post in this role on this day? T2's QA records and T4's badge reads both ask
 * it, and both accept `null` today — the register works before the RSO is named (R1), it simply
 * shows the gap. A phase that turns this into a refusal must say so in its own document.
 */
export async function appointedPerson(
  exec: Db | Tx, personRole: AerbPersonRole, onDate: string,
): Promise<AerbPersonRow | null> {
  assertIstDate(onDate, "onDate");
  const rows = await (exec as Db).select()
    .from(aerbPersons)
    .where(and(
      eq(aerbPersons.personRole, personRole),
      eq(aerbPersons.active, true),
      sql`${aerbPersons.validFrom} <= ${onDate}`,
      or(isNull(aerbPersons.validTo), sql`${aerbPersons.validTo} >= ${onDate}`),
    ));
  return rows[0] ?? null;
}
