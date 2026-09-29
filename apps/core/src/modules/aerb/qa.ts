import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { changeResourceStatus } from "../../kernel/resources/registry";
import { istDayString } from "../../kernel/approvals/cumulative";
import { QA_RESULTS, qaRecords } from "../../kernel/db/schema/aerb";
import { resources } from "../../kernel/db/schema/resources";
import { AerbError } from "./errors";
import { requireManage } from "./access";
import type { ResourceKindDecl } from "../../kernel/resources/kinds";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { QaResult } from "../../kernel/db/schema/aerb";
import { QA_DEFAULT_INTERVAL_YEARS } from "./limits";
import { withTx } from "../../kernel/db/client";

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
 * ═══ AN OVERDUE QA IS NOT A BLOCK (D4) — REVERSED BY 18-S RS11 T3 ═══
 *
 * 18c argued that an overdue QA is a late test, not a lawful stop. 18-S RS11 (owner ruling 5, the
 * brief's T3) reverses it: a machine whose QA is past due — the record's `nextDueOn`, or
 * performed + 2 years when the record names none (`QA_DEFAULT_INTERVAL_YEARS`) — is put into
 * `qa_blocked` by `sweepOverdueQa`, through the SAME writer a failed QA uses
 * (`changeResourceStatus`), and only a passing QA lifts it. DECIDED: a machine operated without its
 * periodic QA is outside its licence conditions; the calendar has shown the due date for 30 days
 * before the block. The sweep touches only an `available` machine: a machine with a patient on the
 * table is never stopped mid-scan, and `down` / `maintenance` are somebody else's statuses (the
 * sweep catches the machine the next hour it is free).
 */


export type QaRecordRow = typeof qaRecords.$inferSelect;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PASS 2 — `2026-02-31` passed the shape check here too and died at the INSERT as a raw 22008. */
function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

/**
 * T6 — the DECISION is `access.ts`'s and is made in exactly one place; this file keeps only the
 * sentence a machine gets when it tries to write the QA register.
 */
async function assertMayManage(exec: Db | Tx, actor: Actor): Promise<void> {
  await requireManage(exec, actor, 
    "a QA result is recorded by a person — a system actor cannot stop or release a machine",
  );
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
  /** 18-S RS11 — tests still past due on this machine, when a pass could not release it. */
  stillOverdue?: string[];
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
    /**
     * 18-S RS11 T3 — a pass of ONE test does not clear a machine whose OTHER tests are overdue: the
     * overdue block is lifted only when nothing on the machine is past due any more.
     */
    const stillOverdue = await overdueQaFor(tx, input.deviceResourceId, today);
    if (stillOverdue.length > 0) {
      return { recordId, blocked: false, releasedRecordId: null, stillOverdue: stillOverdue.map((o) => o.qaType) };
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

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/*  18-S RS11 T3 — QA DUE, OVERDUE, AND THE SWEEP THAT BLOCKS                                     */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** The system actor the overdue sweep writes as — named, so the status history says who. */
export const QA_SWEEP_ACTOR: Actor = { type: "system", id: "aerb-qa-overdue-sweep" };

/** Days before the due date a test shows as "due" (the calendar's window). */
const QA_DUE_WINDOW_DAYS = 30;

function addYears(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  // 29 Feb + 2 years → 28 Feb (clamped), never 1 Mar.
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return `${String(y + years).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export type QaDueState = "ok" | "due" | "overdue" | "failed";

export interface QaDueRow {
  deviceResourceId: string;
  deviceCode: string;
  deviceName: string;
  deviceStatus: string;
  qaType: string;
  /** The record the due date is counted from (the latest pass / conditional; a failure if none). */
  lastRecordId: string;
  lastPerformedOn: string;
  lastResult: string;
  dueOn: string;
  /** TRUE when the due date is the 2-year default because the record named none. */
  defaultInterval: boolean;
  state: QaDueState;
  daysOverdue: number;
}

/**
 * One row per machine × test: when it is next due. The due date counts from the latest test that
 * did NOT fail — its `nextDueOn`, or performed + 2 years. A test with only failures on file is
 * `failed` (the failure already blocked the machine) and due from the first failure.
 */
export async function qaDueList(db: Db | Tx, opts: { onDate?: string; deviceResourceId?: string } = {}): Promise<QaDueRow[]> {
  const asOf = opts.onDate ?? istDayString(new Date());
  const rows = await (db as Db).select({
    id: qaRecords.id,
    deviceResourceId: qaRecords.deviceResourceId,
    qaType: qaRecords.qaType,
    result: qaRecords.result,
    performedOn: qaRecords.performedOn,
    nextDueOn: qaRecords.nextDueOn,
    recordedAt: qaRecords.recordedAt,
    code: resources.code,
    name: resources.name,
    status: resources.status,
  })
    .from(qaRecords)
    .innerJoin(resources, eq(resources.id, qaRecords.deviceResourceId))
    .where(opts.deviceResourceId === undefined
      ? sql`${resources.status} <> 'retired'`
      : eq(qaRecords.deviceResourceId, opts.deviceResourceId));

  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.deviceResourceId}\u0000${r.qaType}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
  }
  const out: QaDueRow[] = [];
  const dayMs = 86_400_000;
  for (const group of byKey.values()) {
    const newestFirst = [...group].sort((a, b) => (a.performedOn === b.performedOn
      ? b.recordedAt.getTime() - a.recordedAt.getTime()
      : a.performedOn < b.performedOn ? 1 : -1));
    const good = newestFirst.find((r) => r.result !== "fail");
    const last = good ?? newestFirst[newestFirst.length - 1]!;
    const defaultInterval = good !== undefined && good.nextDueOn === null;
    const dueOn = good === undefined
      ? last.performedOn
      : good.nextDueOn ?? addYears(good.performedOn, QA_DEFAULT_INTERVAL_YEARS);
    const daysOverdue = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueOn}T00:00:00Z`)) / dayMs);
    const state: QaDueState = good === undefined ? "failed"
      : daysOverdue > 0 ? "overdue" : daysOverdue >= -QA_DUE_WINDOW_DAYS ? "due" : "ok";
    out.push({
      deviceResourceId: last.deviceResourceId, deviceCode: last.code, deviceName: last.name, deviceStatus: last.status,
      qaType: last.qaType, lastRecordId: last.id, lastPerformedOn: last.performedOn, lastResult: last.result,
      dueOn, defaultInterval, state, daysOverdue,
    });
  }
  const rank: Record<QaDueState, number> = { failed: 0, overdue: 1, due: 2, ok: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || b.daysOverdue - a.daysOverdue || a.deviceCode.localeCompare(b.deviceCode));
}

/** The tests past due on one machine today (a `failed` test is the failure's block, not this one). */
export async function overdueQaFor(exec: Db | Tx, deviceResourceId: string, asOf: string): Promise<QaDueRow[]> {
  return (await qaDueList(exec, { onDate: asOf, deviceResourceId })).filter((r) => r.state === "overdue");
}

export interface QaSweepResult {
  blocked: { deviceResourceId: string; deviceCode: string; qaTypes: string[] }[];
  /** Overdue, but not `available` (on the table, down, maintenance) — caught on a later run. */
  skipped: { deviceResourceId: string; deviceCode: string; status: string }[];
}

/**
 * The worker's sweep (hourly). Every AVAILABLE machine with a test past due goes to `qa_blocked`
 * through `changeResourceStatus` — the writer a failed QA uses — one transaction per machine, so one
 * refusal (a patient put on the table between the read and the write) stops only that machine's
 * write. Idempotent: a machine already `qa_blocked` is not listed again.
 */
export async function sweepOverdueQa(
  db: Db, kinds: readonly ResourceKindDecl[], now: Date = new Date(),
): Promise<QaSweepResult> {
  const asOf = istDayString(now);
  const overdue = (await qaDueList(db, { onDate: asOf })).filter((r) => r.state === "overdue");
  const byDevice = new Map<string, QaDueRow[]>();
  for (const r of overdue) (byDevice.get(r.deviceResourceId) ?? byDevice.set(r.deviceResourceId, []).get(r.deviceResourceId)!).push(r);
  const result: QaSweepResult = { blocked: [], skipped: [] };
  for (const [deviceResourceId, tests] of byDevice) {
    const first = tests[0]!;
    if (first.deviceStatus === "qa_blocked") continue;
    if (first.deviceStatus !== "available") {
      result.skipped.push({ deviceResourceId, deviceCode: first.deviceCode, status: first.deviceStatus });
      continue;
    }
    try {
      await withTx(db, (tx) => changeResourceStatus(tx, QA_SWEEP_ACTOR, kinds, deviceResourceId, "qa_blocked", {
        reason: `QA overdue: ${tests.map((t) => `${t.qaType} (due ${t.dueOn})`).join(", ")}`,
        at: now,
      }));
      result.blocked.push({ deviceResourceId, deviceCode: first.deviceCode, qaTypes: tests.map((t) => t.qaType) });
    } catch {
      result.skipped.push({ deviceResourceId, deviceCode: first.deviceCode, status: "busy" });
    }
  }
  return result;
}
