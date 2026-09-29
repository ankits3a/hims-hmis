import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { approvals, imagingSafetyScreenings, imagingStudies, patients, users } from "../../kernel/db/schema";
import { requestApproval } from "../../kernel/approvals/requests";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { getApproval } from "../../kernel/approvals/worklist";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { withTx } from "../../kernel/db/client";
import { displayName } from "../patients";
import { findLockoutHits } from "../pcpndt";
import { IMAGING_GATE_OVERRIDE_APPROVAL_TYPE } from "./approval-types";
import { RadiologyError } from "./errors";
import {
  IMAGING_TERMINAL_GATE_STATES, NEVER_OVERRIDABLE_KINDS, evaluateReadiness, gateState, overrideGate,
  requireStudyGate,
} from "./gates";
import { clearanceOf } from "./read";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { ImagingGateKind } from "../../kernel/db/schema/radiology";

/**
 * PLAN 18-S RS5 T2 — **"ASK THE RADIOLOGIST": the prep bay's override request, on the kernel's
 * approvals spine.**
 *
 * The prep nurse satisfies gates with evidence and may not override one — the override lane is the
 * radiologist's alone (DD7; `open → overridden` names `radiologist`, and `radiology.gates.override`
 * is granted to nobody else). What the bay CAN do is ask. This file is that ask and its answer:
 *
 *   · **The request is a kernel approval** (`imaging_gate_override`, approver `radiologist`,
 *     urgent, 30 minutes). The spine already carries everything a "please override" needs — a
 *     requester, a subject (the gate), a note (why), an approver role, a closure SLA that climbs the
 *     ladder, `approval.requested` for the obligation spine, and the requester ≠ approver SoD. A
 *     radiology-local request row would have been a second queue with none of those.
 *   · **The subject is the GATE** (`imaging_gate` / gate id), so one pending request per gate is a
 *     question the approvals table answers, and a decision cannot be replayed onto another gate.
 *   · **The never-override kinds refuse the REQUEST itself** — `form_f` and `laterality_confirm`.
 *     Asking for what nobody may grant would put a request in the radiologist's queue whose only
 *     honest answer is "no", and the bay would learn that the refusal is negotiable.
 *   · **The decision calls the EXISTING `overrideGate`**, with the radiologist as the actor and the
 *     decision note as the reason — so the override is the same act, on the same edge, with the same
 *     event and the same lexical check, as a radiologist overriding at the console. Nothing here
 *     writes a gate.
 *
 * ═══ THE GRANT AND THE OVERRIDE ARE TWO TRANSACTIONS, AND WHICH ORDER IS WHY ═══
 *
 * `approveRequest` runs its own transaction (its SoD refusal must survive a rollback). So the
 * decision grants first and then overrides, and the override checks ON EXECUTE that the approval is
 * GRANTED, of this type, for this very gate (`definitions.ts`'s `publishWithApproval` pattern). If
 * the gate moved in between — the creatinine came back and the nurse satisfied it — the grant stands
 * and the gate is left as it is, and the answer says so. A grant made from the kernel's `/approvals`
 * inbox is APPLIED by the same route: deciding "grant" on an already-granted request runs the
 * override with the grant's own note.
 */

export const GATE_OVERRIDE_SUBJECT = "imaging_gate";

export type GateOverrideRequest = {
  approvalId: string;
  status: string;
  studyId: string;
  accessionNo: string;
  studyTypeCode: string;
  patientId: string;
  patientName: string;
  kind: string;
  gateState: string;
  note: string | null;
  requesterId: string;
  requesterName: string | null;
  requestedAt: Date;
};

/** The pending request on one gate, if any. */
async function pendingFor(exec: Db | Tx, gateId: string): Promise<{ id: string } | null> {
  const rows = await (exec as Db).select({ id: approvals.id }).from(approvals).where(and(
    eq(approvals.typeKey, IMAGING_GATE_OVERRIDE_APPROVAL_TYPE),
    eq(approvals.subjectType, GATE_OVERRIDE_SUBJECT),
    eq(approvals.subjectId, gateId),
    eq(approvals.status, "pending"),
  ));
  return rows[0] ?? null;
}

/**
 * The bay asks. Refuses a never-override kind, a gate that is not open, a blank note, and a second
 * request while one is pending. The gate row is locked first, so two nurses asking at once file one
 * request between them.
 */
export async function requestGateOverride(
  tx: Tx, actor: Actor, input: { studyId: string; kind: string; note: string },
): Promise<{ approvalId: string; kind: string }> {
  if (NEVER_OVERRIDABLE_KINDS.includes(input.kind as ImagingGateKind)) {
    throw new RadiologyError(
      "gate_not_overridable",
      input.kind === "form_f"
        ? "Form F is never overridden, so there is nothing to ask the radiologist for — the scan waits "
          + "for the registered sonologist's signed form (N2)"
        : "the side is never overridden, so there is nothing to ask the radiologist for — if the side "
          + "the patient states differs from the order, the ordering doctor corrects the order",
      { kind: input.kind },
    );
  }
  const note = input.note.trim();
  if (note === "") {
    throw new RadiologyError(
      "reason_required",
      "say why you are asking — the radiologist decides from what you write here",
      { kind: input.kind },
    );
  }
  const gate = await requireStudyGate(tx, input.studyId, input.kind);
  await tx.execute(sql`select id from imaging_safety_screenings where id = ${gate.id} for update`);
  const state = await gateState(tx, gate.id);
  if (state !== "open") {
    throw new RadiologyError(
      "gate_already_terminal", `the ${input.kind} gate is already ${state}`, { kind: input.kind, state },
    );
  }
  const already = await pendingFor(tx, gate.id);
  if (already) {
    throw new RadiologyError(
      "override_already_requested",
      "the radiologist has already been asked about this gate and has not answered yet",
      { approvalId: already.id, kind: input.kind },
    );
  }
  const study = (await (tx as unknown as Db).select({
    patientId: imagingStudies.patientId, encounterNo: imagingStudies.encounterNo,
  }).from(imagingStudies).where(eq(imagingStudies.id, input.studyId)))[0]!;
  const { approvalId } = await requestApproval(tx, actor, {
    typeKey: IMAGING_GATE_OVERRIDE_APPROVAL_TYPE,
    subject: { type: GATE_OVERRIDE_SUBJECT, id: gate.id },
    patientId: study.patientId,
    encounterId: study.encounterNo,
    requestNote: note,
  });
  return { approvalId, kind: input.kind };
}

/**
 * Pending override requests, oldest first — the radiologist's queue (and, for one study, the bay's
 * "asked" markers). Names through `displayName`; one PHI row per distinct patient.
 */
export async function gateOverrideRequests(
  db: Db, actor: Actor, opts: { studyId?: string; status?: "pending" | "all" } = {},
): Promise<GateOverrideRequest[]> {
  const clearance = await clearanceOf(db, actor);
  const rows = await db
    .select({
      approvalId: approvals.id, status: approvals.status, note: approvals.requestNote,
      requesterId: approvals.requesterId, requestedAt: approvals.requestedAt,
      gateId: imagingSafetyScreenings.id, kind: imagingSafetyScreenings.kind,
      studyId: imagingStudies.id, accessionNo: imagingStudies.accessionNo,
      studyTypeCode: imagingStudies.studyTypeCode, patientId: imagingStudies.patientId,
      encounterNo: imagingStudies.encounterNo,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
    })
    .from(approvals)
    .innerJoin(imagingSafetyScreenings, eq(imagingSafetyScreenings.id, approvals.subjectId))
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingSafetyScreenings.studyId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(and(
      eq(approvals.typeKey, IMAGING_GATE_OVERRIDE_APPROVAL_TYPE),
      eq(approvals.subjectType, GATE_OVERRIDE_SUBJECT),
      ...(opts.status === "all" ? [] : [eq(approvals.status, "pending")]),
      ...(opts.studyId === undefined ? [] : [eq(imagingStudies.id, opts.studyId)]),
    ))
    .orderBy(asc(approvals.requestedAt))
    .limit(200);

  const requesterIds = [...new Set(rows.map((r) => r.requesterId))];
  const named = requesterIds.length === 0 ? [] : await db.select({ id: users.id, fullName: users.fullName })
    .from(users).where(inArray(users.id, requesterIds));
  const nameOf = new Map(named.map((u) => [u.id, u.fullName] as const));

  const out: GateOverrideRequest[] = [];
  for (const r of rows) {
    out.push({
      approvalId: r.approvalId, status: r.status, studyId: r.studyId, accessionNo: r.accessionNo,
      studyTypeCode: r.studyTypeCode, patientId: r.patientId,
      patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, clearance.canSeeConfidential),
      kind: r.kind, gateState: await gateState(db, r.gateId), note: r.note,
      requesterId: r.requesterId, requesterName: nameOf.get(r.requesterId) ?? null, requestedAt: r.requestedAt,
    });
  }
  const reason = `imaging gate override requests, ${String(out.length)} rows`;
  for (const patientId of new Set(out.map((r) => r.patientId))) {
    await recordPhiAccess(db, { actor, patientId, surface: "imaging.worklist", reason });
  }
  return out;
}

export type GateOverrideDecision = {
  approvalId: string;
  verdict: "granted" | "rejected";
  /** Null when refused, or when the gate had already closed by the time the grant was applied. */
  override: { kind: string; state: string } | null;
  study: { state: string; open: string[] } | null;
  note: string | null;
};

/**
 * The radiologist decides. `grant` → the approval is granted (or already was) and the EXISTING
 * override runs with the reason; `refuse` → the approval is rejected and the gate stays open.
 * The reason is required either way (the approvals engine and `overrideGate` both demand it).
 */
export async function decideGateOverride(
  db: Db, actor: Actor, input: { approvalId: string; verdict: "grant" | "refuse"; reason: string },
): Promise<GateOverrideDecision> {
  const reason = input.reason.trim();
  if (reason === "") {
    throw new RadiologyError(
      "reason_required",
      "an override decision carries a reason — \"benefit outweighs risk\" is a judgement somebody has "
      + "to be willing to write down (P1)",
    );
  }
  const approval = await getApproval(db, input.approvalId);
  if (!approval || approval.typeKey !== IMAGING_GATE_OVERRIDE_APPROVAL_TYPE
    || approval.subjectType !== GATE_OVERRIDE_SUBJECT) {
    throw new RadiologyError(
      "unknown_override_request", `${input.approvalId} is not an imaging gate override request`,
      { approvalId: input.approvalId },
    );
  }

  if (input.verdict === "refuse") {
    if (approval.status !== "pending") {
      throw new RadiologyError(
        "already_resolved", `this request was already ${approval.status}`, { status: approval.status },
      );
    }
    await rejectRequest(db, actor, { approvalId: approval.id, note: reason });
    return { approvalId: approval.id, verdict: "rejected", override: null, study: null, note: null };
  }

  /**
   * The override's own lexical check, run BEFORE the grant commits: `overrideGate` refuses a reason
   * carrying a §5(2) term, and a grant committed first would leave an approval granted with that
   * reason on it and a gate still open.
   */
  const hits = findLockoutHits(reason, "coded");
  if (hits.length > 0) {
    throw new RadiologyError(
      "lexical_lockout",
      `this reason cannot be recorded: it contains ${hits.map((h) => `"${h.term}"`).join(", ")}`,
      { terms: hits.map((h) => h.term) },
    );
  }
  if (approval.status === "rejected") {
    throw new RadiologyError("already_resolved", "this request was already refused", { status: approval.status });
  }
  if (approval.status === "pending") {
    await approveRequest(db, actor, { approvalId: approval.id, note: reason });
  }

  return withTx(db, async (tx) => {
    /** On EXECUTE, never trusted from the caller: granted, this type, this gate. */
    const granted = await getApproval(tx as unknown as Db, approval.id);
    if (granted?.status !== "granted" || granted.subjectId !== approval.subjectId) {
      throw new RadiologyError("unknown_override_request", "the override request is not granted");
    }
    const gate = (await (tx as unknown as Db).select({ id: imagingSafetyScreenings.id, studyId: imagingSafetyScreenings.studyId })
      .from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, approval.subjectId)))[0];
    if (!gate) throw new RadiologyError("unknown_override_request", "the gate this request names is gone");
    const state = await gateState(tx, gate.id);
    if ((IMAGING_TERMINAL_GATE_STATES as readonly string[]).includes(state)) {
      return {
        approvalId: approval.id, verdict: "granted" as const, override: null,
        study: await evaluateReadiness(tx, gate.studyId),
        note: `the gate was already ${state} when the grant was applied — nothing to override`,
      };
    }
    const done = await overrideGate(tx, actor, gate.id, reason);
    const study = await evaluateReadiness(tx, gate.studyId);
    return { approvalId: approval.id, verdict: "granted" as const, override: done, study, note: null };
  });
}
