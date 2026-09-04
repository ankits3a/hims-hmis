import { isNull, lt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { phiAccessLog, retentionLegalHolds } from "../db/schema";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 07a T2 — WRITING THE PHI ACCESS LOG.
 *
 * The table's own header carries the why. This file carries the two behaviours that are easy to
 * get wrong and silent when you do.
 */

/** The surfaces that read a patient's record. Extended by each module that adds one. */
export type PhiSurface =
  | "patient.detail" | "patient.allergies"
  | "opd.timeline" | "opd.vitals" | "opd.prescriptions" | "opd.visit"
  /** PLAN 16c T3 — the dispensing counter's read of a dispense (its Rx lines): its own name, so the pharmacy's reads count apart from the consult's. */
  | "pharmacy.dispense"
  /**
   * FD-7 T2 — the front desk asking "has this patient been seen in THIS department, and by whom?"
   * before it routes a walk-in. Its own name rather than a reuse of `opd.visit`: this read answers
   * about a department the clerk named, without opening a visit, and a desk that runs it on every
   * arrival should be countable apart from the consult reads.
   */
  | "opd.continuity"
  /**
   * PLAN 07d T1 / DD5 — THE TWO CROSS-VISIT SURFACES, and they are their own names rather than a
   * reuse of `opd.vitals` / `opd.prescriptions`.
   *
   * Those two are ENCOUNTER-scoped: one visit, one consultation, the record the doctor is writing.
   * These are PATIENT-scoped and span the merge chain — a doctor opening them reads every
   * prescription this person has ever been issued, across departments and across doctors who have
   * left. That is a materially larger read and an audit log that could not tell the two apart would
   * answer "what did they actually see" wrong, which is the only question it exists for.
   */
  | "opd.rx_history" | "opd.vitals_history"
  /**
   * PLAN 17 T2 — **KERNEL EDIT 1 OF 4, and it is an APPEND to a union.**
   *
   * `orders.patient` is the ENVELOPE's own reader, and phase 0 §6A.8 left it owed in as many
   * words: *"The readers do NOT record PHI access … `listOrdersForPatient` returns a patient's
   * investigation list and display name and logs nothing … the honest fix is one `recordPhiAccess`
   * call inside `read.ts`, and it is left to the plan that mounts the first route because the
   * audit row wants a `purpose` this phase has no caller to supply."* Plan 17 is that plan: T8
   * mounts the first routes over these readers, so the debt is paid at the task that incurs it.
   *
   * `lab.results` and `lab.report` are the LAB's two reads, and they are two names rather than one
   * for the reason `opd.rx_history` is not `opd.prescriptions`: a worklist read of unverified
   * numbers by a technologist and a signed report handed to a counter are materially different
   * disclosures, and a log that could not tell them apart would answer "what did they actually
   * see" wrong — the only question it exists for.
   *
   * **18a appends `radiology.*` and rebases if it lands second** (phase document §6.10).
   */
  | "orders.patient" | "lab.results" | "lab.report"
  /**
   * VD-1 T4 — the vitals bay's opening read: the LAST reading for one patient, the derived band,
   * and what that reading would flag today. Its own name rather than a reuse of `opd.vitals` or
   * `opd.vitals_history`, for the reason `opd.rx_history` is not `opd.prescriptions`: `opd.vitals`
   * is encounter-scoped and `opd.vitals_history` is every reading this person has ever had, while
   * this is one row read to stage a bench. A log that could not tell the three apart would answer
   * "what did they actually see" wrong, which is the only question it exists for.
   */
  | "opd.vitals_prestage"
  /**
   * ═══ PLAN 18a T3 / DD11 — THE FOUR IMAGING SURFACES, AND THIS IS AN APPEND AND NOTHING ELSE ═══
   *
   * The line above predicted this edit in as many words: *"18a appends `radiology.*` and rebases if
   * it lands second."* It landed second. `orders.patient` was already here, written by Lane A along
   * with the `recordPhiAccess` calls inside `kernel/orders/read.ts` — so **this phase writes NO
   * second call** (spike S8, re-answered at T2's kickoff: the count went 0 → 5 in `39beff0`).
   * Appending only the names is the whole of DD11's kernel edit for this lane.
   *
   * They are FOUR names rather than one for the reason `opd.rx_history` is not `opd.prescriptions`:
   *
   *   · `imaging.worklist` — every patient with a pending scan, by name, on one screen. It is the
   *     largest PHI surface this module has, and a technologist opening the day's list is a
   *     materially different disclosure from a radiologist opening one study.
   *   · `imaging.study` — one study, its indication and its gates.
   *   · `imaging.report` — a signed finding, which is the disclosure a patient would most mind.
   *   · `pcpndt.form_f` — the statutory register, and the ONE surface in this system that reads a
   *     sealed patient's REAL name by design (DD14/J1). A read of it is a read of a pregnancy, and
   *     a log that could not name it separately could not answer for it separately.
   */
  | "imaging.worklist" | "imaging.study" | "imaging.report" | "pcpndt.form_f"
  /**
   * PLAN 18c T3 / D7 — **THE PATIENT DOSE REGISTER, and it is a surface of its own for the reason
   * `imaging.worklist` is.**
   *
   * The AERB registers are almost entirely about MACHINES — a licence, a QA report, a badge — and
   * none of those is patient data. This one is the exception: a dose register is a list of patients
   * and what was done to them, and reading a date range of it is a materially different disclosure
   * from opening one study. It is also the surface a radiologist touches through the cumulative
   * nudge, under `aerb.doses.read` rather than any `imaging.*` permission, so a log that folded it
   * into `imaging.study` could not answer for it separately.
   */
  | "aerb.dose_register"
  /**
   * FD-23 CLOSE REVIEW — **THE COLLECTION WORKLIST, AND IT IS AN APPEND AND NOTHING ELSE.**
   *
   * `GET /billing/worklist` answers "of today's visits, which still owe money?" and returns a
   * patient NAME, a UHID and a confidential flag for every one of them — deliberately, because a
   * confidential patient who owes money must still be billable. That makes it a PHI surface by the
   * same reasoning `imaging.worklist` is one: a cashier opening the day's list is a materially
   * different disclosure from opening one invoice, and it was the one read of this class in the
   * tree that recorded nothing at all. Its own name rather than a reuse of any `opd.*` surface —
   * this is the MONEY desk's read, under `billing.invoice.read`, and a log that folded it into a
   * consult read could not answer for it separately.
   */
  | "billing.collection_worklist";

/** How the reader was connected to this patient's care AT THE MOMENT OF THE READ. */
export type CareContext = "treating" | "serving" | "none";

/**
 * ═══ WHO ANSWERS "WAS THIS READER LOOKING AFTER THIS PATIENT?" ═══
 *
 * The kernel cannot: care relationships live in clinical modules, and `patients` cannot ask `opd`
 * because `opd` already imports `patients` and the cycle would be real. So modules REGISTER an
 * answer here and the kernel composes them — the same dependency inversion `registerConsultStartGuard`
 * and `registerEncounterResolver` already use in this tree, copied rather than re-invented.
 *
 * KEYED, so re-registering under the same key REPLACES. Jest shares one worker across testing
 * modules and an array would double-register, which is the bug that pattern exists to avoid.
 */
export type CareContextProvider = (
  db: Db, actor: Actor, patientId: string, now: Date,
) => Promise<CareContext>;

const careContextProviders = new Map<string, CareContextProvider>();

/** Registers (or replaces) the provider under `key` and returns the unregister function. */
export function registerCareContextProvider(key: string, provider: CareContextProvider): () => void {
  careContextProviders.set(key, provider);
  return () => {
    careContextProviders.delete(key);
  };
}

const CONTEXT_RANK: Record<CareContext, number> = { none: 0, serving: 1, treating: 2 };

/**
 * THE STRONGEST ANSWER WINS. A person may be a patient's treating doctor in OPD and merely part of
 * the desk serving them elsewhere; recording the weaker of the two would put a clinician on an
 * out-of-context review worklist for reading their own patient's chart. With no provider registered
 * the answer is `none`, which is honest — nothing in the system can vouch for this read.
 *
 * A provider that throws is treated as `none` rather than taking the read down with it: this whole
 * path runs inside a request that must not be disturbed (see `recordPhiAccess`).
 */
async function resolveCareContext(db: Db, actor: Actor, patientId: string, now: Date): Promise<CareContext> {
  let best: CareContext = "none";
  for (const provider of careContextProviders.values()) {
    try {
      const answer = await provider(db, actor, patientId, now);
      if (CONTEXT_RANK[answer] > CONTEXT_RANK[best]) best = answer;
    } catch {
      // a provider that cannot answer does not get to fail the read
    }
  }
  return best;
}

export type RecordPhiAccessInput = {
  actor: Actor;
  /** The CANONICAL patient id — callers resolve the merge chain before writing. */
  patientId: string;
  surface: PhiSurface;
  encounterId?: string | null;
  /** Omit to let the registered providers answer — which is what every call site should do. */
  context?: CareContext;
  sealed?: boolean;
  reason?: string | null;
  now?: Date;
};

/**
 * ═══ A LOGGING FAILURE MUST NEVER FAIL THE READ ═══
 *
 * This function does not throw. Ever. If the audit write fails, the clinician still sees the
 * chart, because the alternative — a full disk or a lock timeout on an audit table taking the
 * allergy list away from someone holding a syringe — is a worse outcome than a missing audit row,
 * and it is not a close call.
 *
 * The trade is stated rather than hidden: a broken log is invisible from here, which is why the
 * absence of rows is itself a monitored signal (a working day with zero `phi_access_log` writes
 * means the recorder is broken, not that nobody opened a chart) rather than something this
 * function tries to shout about from inside a request it must not disturb.
 */
export async function recordPhiAccess(db: Db, input: RecordPhiAccessInput): Promise<void> {
  const now = input.now ?? new Date();
  try {
    const context = input.context ?? await resolveCareContext(db, input.actor, input.patientId, now);
    await db.insert(phiAccessLog).values({
      id: newId(),
      actorId: input.actor.id,
      actorType: input.actor.type,
      patientId: input.patientId,
      surface: input.surface,
      encounterId: input.encounterId ?? null,
      context,
      sealed: input.sealed ?? false,
      reason: input.reason ?? null,
      at: now,
    });
  } catch {
    // Deliberately swallowed — see the header. The read is the priority.
  }
}

/** Default window. Longer than `search_audit`'s 90 days: a records-access enquiry arrives late. */
export const PHI_ACCESS_RETAIN_DAYS = 1095; // three years

/**
 * ═══ THIS PRUNE *IS* LEGAL-HOLD CLAMPED, AND THAT IS A DEPARTURE FROM ITS OWN PRECEDENT ═══
 *
 * `pruneSearchAudit` is deliberately NOT hold-aware, and its comment explains why: a search row
 * references no patient, only a query string, so a per-patient hold "has no answer this code could
 * compute" and a check there would read like protection while doing nothing.
 *
 * **This table is the opposite case.** Every row names a patient, so a hold on that patient has an
 * exact answer here — and the rows a legal hold exists to preserve are precisely the ones a
 * records-access enquiry asks for: who looked at this chart, and when. Pruning them under an
 * active hold would destroy the evidence the hold was raised to keep.
 *
 * A GLOBAL hold (`patient_id IS NULL`) suspends the prune entirely, matching the events sweep.
 */
export async function prunePhiAccessLog(
  db: Db,
  opts: { retainDays?: number; batchSize?: number; now?: Date } = {},
): Promise<number> {
  const retainDays = opts.retainDays ?? PHI_ACCESS_RETAIN_DAYS;
  const batchSize = opts.batchSize ?? 5000;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - retainDays * 24 * 60 * 60 * 1000);

  const holds = await db
    .select({ patientId: retentionLegalHolds.patientId })
    .from(retentionLegalHolds)
    .where(isNull(retentionLegalHolds.releasedAt));
  // A global hold holds everything: nothing is prunable while one is active.
  if (holds.some((h) => h.patientId === null)) return 0;
  const held = holds.map((h) => h.patientId).filter((p): p is string => p !== null);

  const deleted = await db
    .delete(phiAccessLog)
    .where(sql`${phiAccessLog.id} in (
      select id from ${phiAccessLog}
      where ${lt(phiAccessLog.at, cutoff)}
      ${held.length === 0 ? sql`` : sql`and ${phiAccessLog.patientId} not in ${held}`}
      limit ${batchSize}
    )`)
    .returning({ id: phiAccessLog.id });
  return deleted.length;
}
