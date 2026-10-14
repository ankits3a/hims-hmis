import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { Logger } from "@nestjs/common";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissions, ipdBedStays, ipdChargeLines, ipdDepositAlerts } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { registerAdvanceRefundListener } from "../billing";
import { roundTotalToRupee } from "../tariff";
import { lockAdmission, openAdmissionOf } from "./admission-core";
import { depositAlertFired, depositAlertRearmed } from "./billdesk-events";
import { depositHeldPaise } from "./interim-bill";
import { computePayerSplit } from "./payer-bill";
import type { Actor, IpdBedClass, IpdIcuBurn, IpdPayerSplit } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E2.3 (#727) — THE DEPOSIT LADDER (spec SPEC-ipd-core §2 answer 3, §4.3; decision 0072 answer 3).
 *
 * Deposit used = the patient-payable running total (the payer split's patient column) ÷ the deposit still held (receipts
 * − advance refunds, `depositHeldPaise`). At 75 % the desk is told to ask for a top-up; at 90 % management too. Each
 * level fires ONCE while armed (one live `ipd_deposit_alerts` row per admission and level); usage back under the level
 * (a top-up, a reversal) re-arms it (DECIDED, #727). Evaluated after every posting and every receipt — the nightly run,
 * a deposit taken, a retried posting, a reversal — never on a timer of its own (no new interval job).
 *
 * CARE NEVER STOPS FOR MONEY: this file NOTIFIES and writes its own rows. Nothing in IPD reads them to refuse an act;
 * acceptance (v) pins it.
 *
 * NEVER A DOCTOR (decision 0058): recipients are named by role, and a holder of any clinical role is dropped even when
 * they also hold a desk role. `IPD_CLINICAL_ROLES` is a list, and `deposit-ladder.test.ts` derives the clinical roles from
 * the role model's titles (`scripts/seed-roles.ts`) and fails when one is missing from it.
 *
 * ONLY WHERE A DEPOSIT IS OWED (review 4): no deposit required (scheme ₹0, an emergency before stabilisation, a waiver or
 * any other exemption) → the ladder does not run. A cash downtime back-fill counts as owing one (the paper deposit).
 *
 * HYSTERESIS (review 6): a fired level re-arms only when usage falls below 70 % (top-up) / 85 % (escalation), so a stay
 * hovering at the line does not ring every night.
 */
export const IPD_DEPOSIT_LADDER = {
  /** Top-up alert: the desk (cashier, front-office supervisor) and the unit billing officer (billing manager). */
  topUpBp: 7_500,
  /** Management escalation: everyone the top-up reaches plus the duty manager and the owner (DECIDED, decision 0058 review 3). */
  escalateBp: 9_000,
  /** Re-arm below these (hysteresis). */
  topUpRearmBp: 7_000,
  escalateRearmBp: 8_500,
} as const;

export type DepositLevel = "top_up" | "escalate";
export const IPD_DEPOSIT_LEVELS: readonly DepositLevel[] = ["top_up", "escalate"];
const LEVEL_BP: Record<DepositLevel, number> = { top_up: IPD_DEPOSIT_LADDER.topUpBp, escalate: IPD_DEPOSIT_LADDER.escalateBp };
const REARM_BP: Record<DepositLevel, number> = { top_up: IPD_DEPOSIT_LADDER.topUpRearmBp, escalate: IPD_DEPOSIT_LADDER.escalateRearmBp };
const log = new Logger("ipd.deposit-ladder");

/** Who is told at each level. Role keys, not permissions: a notice is addressed to a person in a role. */
export const IPD_DEPOSIT_RECIPIENT_ROLES: Record<DepositLevel, readonly string[]> = {
  top_up: ["cashier", "front_office_supervisor", "billing_manager"],
  escalate: ["cashier", "front_office_supervisor", "billing_manager", "duty_manager", "owner"],
};

/**
 * Clinical roles: a holder never receives a money notice, whatever else they hold (decision 0058) — the medical
 * superintendent included. Kept whole by `deposit-ladder.test.ts`, which derives the clinical roles from the role model.
 */
export const IPD_CLINICAL_ROLES: readonly string[] = [
  "doctor", "resident", "intensivist", "consultant", "surgeon", "anaesthetist", "pathologist", "radiologist", "radiology_resident",
  "medical_superintendent", "antimicrobial_steward",
  // E4.1 (#733) — the ward nursing roles: a nurse is never sent a money notice either (decision 0058).
  "ward_nurse", "nursing_supervisor", "nursing_superintendent",
];

const SCHEME_PAYERS: ReadonlySet<string> = new Set(["pmjay", "state_scheme"]);

/** Review 4 — does this admission owe a deposit at all? No → the ladder is skipped. */
export function depositOwed(a: Pick<AdmissionRow, "payerKind" | "depositExemption" | "depositRequiredPaise" | "depositBasis">): boolean {
  if (a.payerKind !== null && SCHEME_PAYERS.has(a.payerKind)) return false;
  if (a.depositExemption !== null) return false;
  return (a.depositRequiredPaise ?? 0) > 0 || a.depositBasis === "downtime_backfill";
}

/** Usage stored for "payable with nothing held": shown as over 100 %, kept inside an integer column. */
const NO_DEPOSIT_USED_BP = 1_000_000;

/** States in which the ladder runs: in a bed and not yet ended. */
export const IPD_LADDER_STATES = ["admitted", "transferring", "fit_declared", "discharging"] as const;

const ICU_BURN_CLASSES: ReadonlySet<string> = new Set<IpdBedClass>(["icu", "hdu", "nicu", "picu"]);

export type DepositPosition = {
  patientPayablePaise: number;
  depositHeldPaise: number;
  /** Null when nothing is payable and nothing is held. */
  usedBp: number | null;
  /** Deposit held − the patient-payable total rounded to the rupee (the interim bill's `patientBalancePaise`). */
  balancePaise: number;
  /** The whole bill's net so far, rounded to the rupee (the daily totals message's "total so far"). */
  billTotalPaise: number;
  split: IpdPayerSplit;
};

export function usedBpOf(patientPayablePaise: number, depositHeld: number): number | null {
  const payable = Math.max(patientPayablePaise, 0);
  if (depositHeld <= 0) return payable > 0 ? NO_DEPOSIT_USED_BP : null;
  return Math.min(NO_DEPOSIT_USED_BP, Math.floor((payable * 10_000) / depositHeld));
}

/** The admission's money position now: the split computed on read, the deposit held, the usage. */
export async function depositPosition(db: Db | Tx, a: AdmissionRow): Promise<DepositPosition> {
  const lines = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, a.id));
  const split = await computePayerSplit(db, a, lines);
  const held = await depositHeldPaise(db, a);
  const patient = split.totals.patientPaise;
  const net = lines.reduce((s, l) => s + l.netPaise, 0);
  return {
    patientPayablePaise: patient,
    depositHeldPaise: held,
    usedBp: usedBpOf(patient, held),
    balancePaise: held - roundTotalToRupee(Math.max(patient, 0)).roundedPaise,
    billTotalPaise: roundTotalToRupee(Math.max(net, 0)).roundedPaise,
    split,
  };
}

/**
 * ICU BURN RATE (spec §2 answer 3, "recalculated daily"): for a stay whose current bed class is ICU, HDU, NICU or PICU,
 * the average patient-payable charge of the last three POSTED service days (fewer when the stay is younger), and the
 * whole days the deposit still held covers at that rate. Posted days change only when the nightly run posts, so the
 * figure is recomputed once a day by construction. Null for any other class or before the first posted day.
 */
export async function icuBurnOf(db: Db | Tx, a: AdmissionRow, pos: DepositPosition): Promise<IpdIcuBurn | null> {
  const open = (await db.select({ billedClass: ipdBedStays.billedClass }).from(ipdBedStays)
    .where(and(eq(ipdBedStays.admissionId, a.id), isNull(ipdBedStays.endedAt))).orderBy(desc(ipdBedStays.startedAt)).limit(1))[0];
  if (open === undefined || !ICU_BURN_CLASSES.has(open.billedClass)) return null;
  const dates = new Map<string, string>();
  for (const l of await db.select({ id: ipdChargeLines.id, serviceDate: ipdChargeLines.serviceDate }).from(ipdChargeLines)
    .where(eq(ipdChargeLines.admissionId, a.id))) dates.set(l.id, l.serviceDate);
  const byDay = new Map<string, number>();
  for (const s of pos.split.lines) {
    const d = dates.get(s.lineId);
    if (d !== undefined) byDay.set(d, (byDay.get(d) ?? 0) + s.patientPaise);
  }
  const last = [...byDay.keys()].sort().slice(-3);
  if (last.length === 0) return null;
  const perDay = Math.max(0, Math.round(last.reduce((s, d) => s + (byDay.get(d) ?? 0), 0) / last.length));
  const left = pos.depositHeldPaise - Math.max(pos.patientPayablePaise, 0);
  return { perDayPaise: perDay, days: last.length, daysLeft: perDay === 0 ? null : Math.max(0, Math.floor(left / perDay)) };
}

/** Users who hold any of the level's roles, minus every holder of a clinical role. Sorted, unique. */
export async function depositNoticeRecipients(tx: Tx, level: DepositLevel): Promise<string[]> {
  const want = new Set<string>();
  for (const r of IPD_DEPOSIT_RECIPIENT_ROLES[level]) for (const u of await usersHoldingRole(tx, r)) want.add(u);
  for (const r of IPD_CLINICAL_ROLES) for (const u of await usersHoldingRole(tx, r)) want.delete(u);
  return [...want].sort();
}

export type LadderOutcome = { admissionId: string; usedBp: number | null; fired: DepositLevel[]; rearmed: DepositLevel[]; notified: number };

const SYSTEM: Actor = { type: "system", id: "ipd-deposit-ladder" };

const pct = (bp: number): string => (bp >= NO_DEPOSIT_USED_BP ? "over 100" : String(Math.floor(bp / 100)));
const rupees = (paise: number): string => `Rs ${Math.round(paise / 100).toLocaleString("en-IN")}`;

/**
 * Evaluates one admission: under its lock, the position is computed and each level fired or re-armed, and the notices
 * are raised IN THE SAME TRANSACTION as the alert row (review 5) — both commit or neither. An admission not in a bed, or
 * owing no deposit, is left alone.
 */
export async function evaluateDepositLadder(db: Db, admissionId: string, now: Date): Promise<LadderOutcome> {
  const out: LadderOutcome = { admissionId, usedBp: null, fired: [], rearmed: [], notified: 0 };
  await withTx(db, async (tx) => {
    const a = await lockAdmission(tx, admissionId);
    if (a.admittedAt === null || !(IPD_LADDER_STATES as readonly string[]).includes(a.state)) return;
    if (!depositOwed(a)) return;
    const pos = await depositPosition(tx, a);
    out.usedBp = pos.usedBp;
    const live = await tx.select().from(ipdDepositAlerts)
      .where(and(eq(ipdDepositAlerts.admissionId, a.id), isNull(ipdDepositAlerts.rearmedAt)));
    for (const level of IPD_DEPOSIT_LEVELS) {
      const row = live.find((r) => r.level === level);
      const over = pos.usedBp !== null && pos.usedBp >= LEVEL_BP[level];
      const clear = pos.usedBp === null || pos.usedBp < REARM_BP[level];
      if (over && row === undefined) {
        const id = newId();
        await tx.insert(ipdDepositAlerts).values({
          id, admissionId: a.id, level, thresholdBp: LEVEL_BP[level], usedBp: pos.usedBp!,
          patientPayablePaise: Math.max(pos.patientPayablePaise, 0), depositHeldPaise: pos.depositHeldPaise, firedAt: now,
        });
        await appendEvent(tx, depositAlertFired.make({
          actor: SYSTEM, occurredAt: now, correlationId: a.id, patientId: a.patientId,
          payload: { admissionId: a.id, alertId: id, level, thresholdBp: LEVEL_BP[level], usedBp: pos.usedBp!, provenance: "system" },
        }));
        out.fired.push(level);
        const who = a.admissionNo ?? "An admission";
        const title = level === "escalate" ? "Deposit 90 % used — escalation" : "Deposit 75 % used — ask for a top-up";
        const body = `${who}: ${pct(pos.usedBp!)} % of the deposit used (${rupees(Math.max(pos.patientPayablePaise, 0))} of ` +
          `${rupees(pos.depositHeldPaise)} held). Care continues; collect a top-up at the bill desk.`;
        for (const userId of await depositNoticeRecipients(tx, level)) {
          const won = await raiseNoticeIn(tx, {
            userId, kind: "ipd.deposit_low", title, body, refType: "ipd_admission", refId: a.id, sourceKey: `ipd.deposit_alert:${id}`, at: now,
          });
          if (won) out.notified += 1;
        }
      } else if (clear && row !== undefined) {
        await tx.update(ipdDepositAlerts).set({ rearmedAt: now }).where(eq(ipdDepositAlerts.id, row.id));
        await appendEvent(tx, depositAlertRearmed.make({
          actor: SYSTEM, occurredAt: now, correlationId: a.id, patientId: a.patientId,
          payload: { admissionId: a.id, alertId: row.id, level, usedBp: pos.usedBp, provenance: "system" },
        }));
        out.rearmed.push(level);
      }
    }
  });
  return out;
}

/**
 * Review 8 — the ladder after an act that has ALREADY committed (a receipt, a retry, a reversal, a refund): a failure is
 * logged and swallowed, so the desk sees its act succeed; the nightly run evaluates every admission again.
 */
export async function evaluateDepositLadderSafely(db: Db, admissionId: string, now: Date, after: string): Promise<LadderOutcome | null> {
  try {
    return await evaluateDepositLadder(db, admissionId, now);
  } catch (e) {
    log.error(`deposit ladder failed after ${after} for admission ${admissionId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Evaluates every admission in a bed (the nightly run's second step). Infrastructure errors propagate. */
export async function evaluateAllDepositLadders(db: Db, now: Date): Promise<{ outcomes: LadderOutcome[]; failed: string[] }> {
  const rows = await db.select({ id: ipdAdmissions.id }).from(ipdAdmissions)
    .where(inArray(ipdAdmissions.state, [...IPD_LADDER_STATES])).orderBy(asc(ipdAdmissions.admittedAt));
  const outcomes: LadderOutcome[] = [];
  const failed: string[] = [];
  // Review 1: one admission's failure is logged and never skips the others.
  for (const r of rows) {
    try {
      outcomes.push(await evaluateDepositLadder(db, r.id, now));
    } catch (e) {
      failed.push(r.id);
      log.error(`deposit ladder failed for admission ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { outcomes, failed };
}

/**
 * Review 7 — an advance refund lowers the deposit held: billing tells IPD after the voucher commits
 * (`registerAdvanceRefundListener`), and the patient's open admission is put through the ladder. Registered by `IpdModule`.
 */
export function registerIpdAdvanceRefundListener(): () => void {
  return registerAdvanceRefundListener("ipd.deposit-ladder", async (db, { patientId, at }) => {
    const a = await openAdmissionOf(db, patientId);
    if (a !== undefined) await evaluateDepositLadderSafely(db, a.id, at, "advance refund");
  });
}
