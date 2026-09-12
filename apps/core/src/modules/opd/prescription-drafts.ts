import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { opdEncounters, opdPrescriptionDrafts } from "../../kernel/db/schema";
import { issuePrescription } from "./prescriptions";
import { getEncounter } from "./encounters";
import { OpdError } from "./errors";
import type { AppConfig } from "../../kernel/config";
import type { Db, Tx } from "../../kernel/db/client";
import type { RxLine } from "./fhir";
import type { IssuePrescriptionInput, IssuedPrescription, PrescriptionAuthority } from "./prescriptions";

/**
 * ═══ THE PAPER SLIP, TRANSCRIBED — AND WHY NOTHING HERE CAN PRESCRIBE ═══
 *
 * Owner, 2026-09-12: *"Sometimes doctors have so tight schedule that they fail to enter his
 * observation on the operating system. They just write manually by pen on the prescription slip."*
 * Ruling, same day: **draft then confirm, doctor taps to issue.**
 *
 * The ruling is the whole design and it was chosen over the alternative — a scribe issuing
 * attributed to the doctor — for one reason: it needs NO guard weakened. `requireTreatingDoctor`
 * (`consultation.ts`) refuses anyone without an `opd_doctors` profile, then refuses any doctor but
 * the encounter's own. That check is who-may-prescribe, which is law, and it is also the hook every
 * safety gate hangs off — allergy conflict, severe interaction, duplicate salt. A transcription
 * path that went around it would go around those too.
 *
 * So this module writes a DRAFT and hands it back. The only way a draft becomes a prescription is
 * `issueDraft` below, which calls the shipped `issuePrescription` **with the doctor as the actor**.
 * Every check runs, unchanged, at issue time. There is no second issue path and no flag that skips
 * one — the function this file calls is the same function the consultation screen calls.
 *
 * ═══ WHAT A DRAFT IS NOT ═══
 *
 * It is not a prescription in any state. Nothing downstream reads this table: the pharmacy queue
 * enqueues from `opd_prescriptions`, the FHIR bundle and the QR are built at issue, and the printed
 * sheet renders that row. A draft cannot be dispensed, printed, verified or scanned, and that is
 * structural rather than enforced by a status check somebody has to remember.
 */

export type DraftRow = {
  id: string;
  encounterId: string;
  patientId: string;
  lines: RxLine[];
  note: string | null;
  status: "pending" | "issued" | "discarded";
  draftedBy: string;
  draftedAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  issuedPrescriptionId: string | null;
};

export type SaveDraftInput = { lines: RxLine[]; note?: string | null };

function rowOf(r: typeof opdPrescriptionDrafts.$inferSelect): DraftRow {
  return {
    id: r.id, encounterId: r.encounterId, patientId: r.patientId,
    lines: r.lines as RxLine[], note: r.note,
    status: r.status as DraftRow["status"],
    draftedBy: r.draftedBy, draftedAt: r.draftedAt,
    resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt,
    issuedPrescriptionId: r.issuedPrescriptionId,
  };
}

/** The encounter's PENDING draft, or null. Issued and discarded rows stay for the audit trail. */
export async function getPendingDraft(db: Db | Tx, encounterId: string): Promise<DraftRow | null> {
  const rows = await db
    .select().from(opdPrescriptionDrafts)
    .where(and(eq(opdPrescriptionDrafts.encounterId, encounterId), eq(opdPrescriptionDrafts.status, "pending")));
  const row = rows[0];
  return row === undefined ? null : rowOf(row);
}

/**
 * Composes or replaces the encounter's pending draft.
 *
 * REPLACES rather than versions, deliberately: a draft is a working transcription of one piece of
 * paper, not a clinical record — the record is the prescription the doctor issues and the paper
 * itself. Keeping every keystroke's worth of superseded drafts would bury the one row that matters.
 *
 * The UPDATE-then-INSERT runs inside the transaction that holds the partial unique index, so two
 * scribes at one door cannot leave two pending slips for the doctor to choose between.
 */
export async function saveDraft(
  db: Db, actor: Actor, encounterId: string, input: SaveDraftInput, now: Date = new Date(),
): Promise<DraftRow> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a transcription is a user action");
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (input.lines.length === 0) {
    throw new OpdError("empty_prescription", "a draft with no lines is not a transcription of anything");
  }
  return withTx(db, async (tx) => {
    /* The encounter row is the serializer, exactly as `issuePrescription` uses it for versions. */
    await tx.select({ id: opdEncounters.id }).from(opdEncounters).where(eq(opdEncounters.id, encounter.id)).for("update");
    const existing = await tx
      .select({ id: opdPrescriptionDrafts.id }).from(opdPrescriptionDrafts)
      .where(and(eq(opdPrescriptionDrafts.encounterId, encounter.id), eq(opdPrescriptionDrafts.status, "pending")));
    const held = existing[0];
    if (held !== undefined) {
      const updated = await tx
        .update(opdPrescriptionDrafts)
        .set({ lines: input.lines, note: input.note ?? null, draftedBy: actor.id, draftedAt: now })
        .where(eq(opdPrescriptionDrafts.id, held.id))
        .returning();
      return rowOf(updated[0]!);
    }
    const inserted = await tx
      .insert(opdPrescriptionDrafts)
      .values({
        id: newId(), encounterId: encounter.id, patientId: encounter.patientId,
        lines: input.lines, note: input.note ?? null, status: "pending",
        draftedBy: actor.id, draftedAt: now,
      })
      .returning();
    return rowOf(inserted[0]!);
  });
}

/** The doctor (or the scribe who mis-keyed it) takes the slip off the doctor's list. */
export async function discardDraft(
  db: Db, actor: Actor, encounterId: string, now: Date = new Date(),
): Promise<DraftRow | null> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a transcription is a user action");
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const updated = await db
    .update(opdPrescriptionDrafts)
    .set({ status: "discarded", resolvedBy: actor.id, resolvedAt: now })
    .where(and(eq(opdPrescriptionDrafts.encounterId, encounter.id), eq(opdPrescriptionDrafts.status, "pending")))
    .returning();
  const row = updated[0];
  return row === undefined ? null : rowOf(row);
}

/**
 * ═══ THE TAP. THE DOCTOR IS THE ACTOR, AND THAT IS THE ENTIRE SECURITY ARGUMENT ═══
 *
 * `issuePrescription` is called with the caller's own actor. A scribe reaching this route is
 * refused by `requireTreatingDoctor` inside it — `not_a_doctor` — and a doctor who is not this
 * encounter's gets `not_your_patient`. Neither refusal is re-implemented here: a second copy of
 * "may this person prescribe" is how the two start disagreeing.
 *
 * The overrides ride the tap, not the draft. A scribe cannot pre-clear an allergy conflict, a
 * severe interaction or a duplicate salt, because clearing one is a clinical judgement with a
 * mandatory reason attached to the prescriber's name — so the warnings surface at the doctor's
 * screen, on the doctor's tap, and the reasons they type are recorded against them.
 *
 * The draft is marked issued AFTER the prescription exists. If the issue throws — an unresolved
 * allergy conflict is the common case — the draft stays pending and the doctor sees the same slip
 * with the warning beside it, which is the state they need in order to act on it.
 */
export async function issueDraft(
  db: Db, actor: Actor, cfg: AppConfig, encounterId: string,
  overrides: Omit<IssuePrescriptionInput, "lines"> = {},
  now: Date = new Date(),
  /**
   * FD-31 — WHICH OF THE TWO MODES RESOLVED THIS SLIP.
   *
   * `"doctor"` is FD-30's tap and the default: the treating doctor confirms and every guard holds
   * exactly as it did. `"paper_slip"` is the owner's second mode, for a hospital that cannot staff
   * an assistant — the OPD Order Desk sends a slip the doctor signed in pen, `issuePrescription`
   * takes the prescriber from the ENCOUNTER, and the control moves downstream to the pharmacist's
   * cross-confirmation before the bill.
   *
   * ONE FUNCTION FOR BOTH, deliberately. Two would drift, and the whole difference is an argument
   * `issuePrescription` interprets — including asserting the transcriber's own permission, which
   * no route can skip and no second copy of this function could be trusted to repeat.
   */
  authority: PrescriptionAuthority = "doctor",
): Promise<IssuedPrescription & { draftId: string }> {
  const draft = await getPendingDraft(db, encounterId);
  /* `unknown_draft` and not a bespoke code: `opdStatus` maps every `unknown_*` to 404 by rule, and
     "the pending draft is not there" is exactly a missing resource — the doctor's list moved on. */
  if (draft === null) throw new OpdError("unknown_draft", `no pending transcription for encounter ${encounterId}`);

  const issued = await issuePrescription(db, actor, cfg, encounterId, { ...overrides, lines: draft.lines }, now, authority);

  await db
    .update(opdPrescriptionDrafts)
    .set({ status: "issued", resolvedBy: actor.type === "user" ? actor.id : null, resolvedAt: now, issuedPrescriptionId: issued.prescriptionId })
    .where(eq(opdPrescriptionDrafts.id, draft.id));
  return { ...issued, draftId: draft.id };
}
