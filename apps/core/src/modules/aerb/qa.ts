import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { changeResourceStatus } from "../../kernel/resources/registry";
import { istDayString } from "../../kernel/approvals/cumulative";
import { QA_RESULTS, qaRecords } from "../../kernel/db/schema/aerb";
import { resources } from "../../kernel/db/schema/resources";
import { AerbError } from "./errors";
import type { ResourceKindDecl } from "../../kernel/resources/kinds";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { QaResult } from "../../kernel/db/schema/aerb";

/**
 * PLAN 18c T2 — **THE QUALITY-ASSURANCE REGISTER, AND THE LOCKOUT THAT ACTUALLY BLOCKS.**
 *
 * ═══ THE STATUS 18a DECLARED AND NOTHING COULD SET ═══
 *
 * `qa_blocked` has been in the `device` kind's vocabulary since 18a, honoured by the scheduler
 * (`SCHEDULABLE_DEVICE_STATUSES`) and at acquisition — and **written by nothing in the tree.** 18a
 * said so in as many words: *"the workflow that puts a device INTO it is 18c's."* This is it, and
 * it is one function rather than a workflow because the act is one person's: the RSO records what
 * the physicist measured, and a failed measurement stops the machine in the same transaction.
 *
 * ═══ WHY THE KIND DECLARATIONS ARE A PARAMETER ═══
 *
 * `changeResourceStatus` takes them, deliberately — `registry.ts`'s header says why that is *"a
 * parameter and not a global"*. This module cannot import `RADIOLOGY_RESOURCE_KINDS`, because the
 * dependency runs radiology → aerb (D1) and importing back would make a cycle out of a statute.
 * So the CALLER passes them, and the controller resolves them from the installed `ModuleRegistry`
 * through the kernel's own `collectResourceKinds` — one source of truth, no second copy of the
 * `device` vocabulary anywhere.
 *
 * ═══ AN OVERDUE QA IS NOT A BLOCK (D4) ═══
 *
 * The tempting symmetry is "a failure blocks, so an expiry blocks too". It is wrong here. A licence
 * expiry stops the machine because the LAW says the machine may not operate; an overdue QA means a
 * test is late, and a system that stops a CT at midnight because a physicist's visit slipped by a
 * day sends a trauma patient to another hospital. Overdue is a calendar row (T5) and a line on the
 * inspector's print. The RSO blocks; the calendar tells them to.
 */

const MANAGE = "aerb.registers.manage";

export type QaRecordRow = typeof qaRecords.$inferSelect;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PASS 2 — `2026-02-31` passed the shape check here too and died at the INSERT as a raw 22008. */
function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

async function assertMayManage(exec: Db | Tx, actor: Actor): Promise<void> {
  if (actor.type !== "user") {
    throw new AerbError(
      "not_appointed",
      "a QA result is recorded by a person — a system actor cannot stop or release a machine",
    );
  }
  if (!(await hasPermission(exec as Db, actor.id, MANAGE, "hospital"))) {
    throw new AerbError("not_appointed", `${actor.id} does not hold ${MANAGE}`, { permission: MANAGE });
  }
}

export interface RecordQaInput {
  deviceResourceId: string;
  qaType: string;
  result: QaResult;
  performedBy: string;
  performedOn: string;
  agencyRef?: string | null;
  values?: Record<string, unknown>;
  nextDueOn?: string | null;
  remarks?: string | null;
}

export interface RecordQaOutcome {
  recordId: string;
  /** TRUE when this record drove the machine into `qa_blocked`. */
  blocked: boolean;
  /** The failing record this pass released, if it released one. */
  releasedRecordId: string | null;
}

/**
 * Records a QA result and moves the machine if the result says to.
 *
 * **The write and the status change are ONE transaction.** A register that recorded a failure and
 * left the machine bookable would be a register describing a hospital that is not this one — and
 * the mutant that proves the point is exactly "record the fail, skip the status change": the row
 * looks right, the inspector is satisfied, and the CT keeps taking bookings.
 */
export async function recordQa(
  tx: Tx, actor: Actor, kinds: readonly ResourceKindDecl[], input: RecordQaInput,
  opts: { now?: Date } = {},
): Promise<RecordQaOutcome> {
  await assertMayManage(tx, actor);
  if (!isRealDate(input.performedOn)) {
    throw new AerbError("invalid_validity", `performedOn must be a real date (YYYY-MM-DD), got "${input.performedOn}"`);
  }
  /**
   * CLOSE REVIEW — F52's rule, which this file was not following: nothing bounded `performedOn`
   * above, so a typo of `2027-06-15` was accepted and (before the guard below) released a blocked
   * machine on a test that has not happened. The server's own IST day is the bound.
   */
  const today = istDayString(opts.now ?? new Date());
  if (input.performedOn > today) {
    throw new AerbError(
      "invalid_validity",
      `performedOn ${input.performedOn} is in the future (today is ${today}) — a quality-assurance `
      + "result is a measurement that has been taken",
      { performedOn: input.performedOn, today },
    );
  }
  if (input.nextDueOn != null) {
    if (!isRealDate(input.nextDueOn)) {
      throw new AerbError("invalid_validity", `nextDueOn must be a real date (YYYY-MM-DD), got "${input.nextDueOn}"`);
    }
    if (input.nextDueOn < input.performedOn) {
      throw new AerbError(
        "invalid_validity",
        `nextDueOn ${input.nextDueOn} is before the test was performed on ${input.performedOn}`,
      );
    }
  }
  if (!(QA_RESULTS as readonly string[]).includes(input.result)) {
    throw new AerbError("invalid_validity", `"${input.result}" is not a QA result`);
  }

  const deviceRows = await tx.select({ id: resources.id, kind: resources.kind, status: resources.status })
    .from(resources).where(eq(resources.id, input.deviceResourceId));
  const device = deviceRows[0];
  /**
   * PASS 2 — pass 1's finding named "neither `fileLicence` nor `recordQa`", and only the first was
   * fixed. A `pass` against a bed's resource id was written and rendered by `qaRegister` in the
   * inspector's file as a machine with a QA certificate. Only the `fail` path was incidentally
   * protected, because `changeResourceStatus` rejects `qa_blocked` for a kind whose vocabulary
   * lacks it — which is the shape of a guard that holds by accident.
   */
  if (!device || device.kind !== "device") {
    throw new AerbError(
      "unknown_licence",
      `${input.deviceResourceId} is not a device resource — a QA record is about a machine`,
      { deviceResourceId: input.deviceResourceId, kind: device?.kind ?? null },
    );
  }

  const recordId = newId();
  const blocked = input.result === "fail";

  await tx.insert(qaRecords).values({
    id: recordId,
    deviceResourceId: input.deviceResourceId,
    qaType: input.qaType,
    result: input.result,
    performedBy: input.performedBy,
    performedOn: input.performedOn,
    agencyRef: input.agencyRef ?? null,
    values: input.values ?? {},
    nextDueOn: input.nextDueOn ?? null,
    blockApplied: blocked,
    remarks: input.remarks ?? null,
    recordedBy: actor.id,
  });

  if (blocked) {
    /**
     * The kernel refuses this while the machine is OCCUPIED (`already_occupied`) — a scan is in
     * progress on it. That refusal is deliberately NOT caught: the whole insert rolls back, and the
     * RSO is told the machine is mid-examination rather than the register recording a block that
     * never happened. Stopping a tube with a patient on the table is a decision a person makes at
     * the console, not one a register makes behind their back.
     */
    await changeResourceStatus(tx, actor, kinds, input.deviceResourceId, "qa_blocked", {
      reason: `QA ${input.qaType} failed on ${input.performedOn}`,
    });
    return { recordId, blocked: true, releasedRecordId: null };
  }

  /**
   * A PASS releases a machine this register stopped — and only one this register stopped. A device
   * sitting in `down` (a broken tube) or `maintenance` (an engineer's visit) is somebody else's
   * status and a QA pass must not clear it: that is the mutant that turns a passing phantom test
   * into a machine returned to service with its tube still broken.
   */
  if (input.result === "pass" && device.status === "qa_blocked") {
    const openFail = await tx.select({ id: qaRecords.id, performedOn: qaRecords.performedOn })
      .from(qaRecords)
      .where(and(
        eq(qaRecords.deviceResourceId, input.deviceResourceId),
        eq(qaRecords.blockApplied, true),
        isNull(qaRecords.releasedAt),
      ))
      .orderBy(desc(qaRecords.performedOn));

    /**
     * ═══ CLOSE REVIEW, CRITICAL — A PASS MUST BE NEWER THAN THE FAILURE IT CLEARS ═══
     *
     * The release condition used to be `result === 'pass' && status === 'qa_blocked'` and NOTHING
     * ELSE. `performedOn` was validated for shape and against `nextDueOn`, never against the
     * failure it was about to close out — so the ordinary act this register exists to support,
     * **back-entering the historical QA book for an inspector**, released a machine:
     *
     *   1. the annual QA fails on 2026-06-15; the CT is `qa_blocked` and off the diary. Correct.
     *   2. the RSO types up last year's certificate — `result: 'pass', performedOn: '2025-06-10'`.
     *   3. the device is `qa_blocked`, so it goes back to `available`, and the 2026 failure row is
     *      stamped `releasedByRecordId = <the 2025 record>`. **A CT whose output repeatability was
     *      out of tolerance last week is back on the diary, cleared by a certificate from last
     *      year, and the register positively asserts that it was.**
     *
     * A QA pass is the ONLY exit from `qa_blocked` in the whole tree, so the release condition IS
     * the control. It now carries a date. A pass that is not newer than the open failure records
     * normally and releases nothing — the history is enterable, and it cannot clear a machine.
     */
    /**
     * ═══ PASS 2 — THIS RECORDS AND DOES NOT RELEASE; IT USED TO REFUSE ═══
     *
     * Pass 1 threw here, and pass 2 caught the contradiction: the paragraph above promised the
     * history would still be enterable, and a throw meant that **while a machine was `qa_blocked`
     * its historical QA book could not be entered at all** — which is the very act the CRITICAL's
     * own narrative calls the ordinary use of this register.
     *
     * Recording without releasing keeps both properties. The row lands, the inspector's book is
     * complete, and the machine stays stopped; the answer says `releasedRecordId: null`, so nothing
     * tells the RSO a clearance happened. Fail-safe in the direction that matters.
     */
    const blocking = openFail[0];
    if (blocking !== undefined && input.performedOn < blocking.performedOn) {
      return { recordId, blocked: false, releasedRecordId: null };
    }

    const at = new Date();
    await changeResourceStatus(tx, actor, kinds, input.deviceResourceId, "available", {
      reason: `QA ${input.qaType} passed on ${input.performedOn}`, at,
    });
    for (const f of openFail) {
      await tx.update(qaRecords)
        .set({ releasedByRecordId: recordId, releasedAt: at })
        .where(eq(qaRecords.id, f.id));
    }
    return { recordId, blocked: false, releasedRecordId: openFail[0]?.id ?? null };
  }

  return { recordId, blocked: false, releasedRecordId: null };
}

export interface QaRegisterRow {
  id: string;
  deviceResourceId: string;
  deviceCode: string;
  deviceName: string;
  deviceStatus: string;
  qaType: string;
  result: string;
  performedBy: string;
  performedOn: string;
  agencyRef: string | null;
  nextDueOn: string | null;
  blockApplied: boolean;
  releasedAt: string | null;
  remarks: string | null;
}

/** The QA book, newest first, with the machine's CURRENT status beside each record. */
export async function qaRegister(
  db: Db, opts: { deviceResourceId?: string } = {},
): Promise<QaRegisterRow[]> {
  const rows = await db.select({
    id: qaRecords.id,
    deviceResourceId: qaRecords.deviceResourceId,
    deviceCode: resources.code,
    deviceName: resources.name,
    deviceStatus: resources.status,
    qaType: qaRecords.qaType,
    result: qaRecords.result,
    performedBy: qaRecords.performedBy,
    performedOn: qaRecords.performedOn,
    agencyRef: qaRecords.agencyRef,
    nextDueOn: qaRecords.nextDueOn,
    blockApplied: qaRecords.blockApplied,
    releasedAt: qaRecords.releasedAt,
    remarks: qaRecords.remarks,
  })
    .from(qaRecords)
    .innerJoin(resources, eq(resources.id, qaRecords.deviceResourceId))
    .where(opts.deviceResourceId === undefined ? sql`true` : eq(qaRecords.deviceResourceId, opts.deviceResourceId))
    .orderBy(desc(qaRecords.performedOn), desc(qaRecords.recordedAt));

  return rows.map((r) => ({ ...r, releasedAt: r.releasedAt?.toISOString() ?? null }));
}
