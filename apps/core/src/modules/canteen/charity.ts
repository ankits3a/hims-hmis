import { eq } from "drizzle-orm";
import { newId, requestCharityInput } from "@hmis/contracts";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import { approvals, canteenCharityGrants, canteenSales } from "../../kernel/db/schema";
import { canteenAdmissionFacts } from "../ipd";
import { CANTEEN_CHARITY_APPROVAL, CANTEEN_CHARITY_SUBJECT } from "./approval-types";
import { CanteenRefusal } from "./errors";
import { requireAny } from "./guard";
import { CANTEEN_FINANCE, CANTEEN_MANAGE, CANTEEN_SELL, CANTEEN_VIEW } from "./names";
import { parse } from "./setup";
import type { Actor, CanteenCharityGrant, CanteenCharityKind } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { Opts } from "./setup";

/**
 * D5 — THE FAMILY WHO CANNOT PAY. The counter (or the manager) asks; the grant row and its approval request are written
 * together; nothing is served on it until finance grants the approval (`draftSale` reads the approval's status at every
 * sale). The grant covers `meals` meals, each at most `mealLimitPaise` at the public list, until `validUntil` (IST).
 * A free grant is paid by mode `charity`; a subsidised one prices cash or UPI from the subsidised list.
 */
export async function requestCharity(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ grantId: string; approvalId: string }> {
  await requireAny(db, actor, CANTEEN_SELL, CANTEEN_MANAGE);
  const input = parse(requestCharityInput, raw);
  const at = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const a = await canteenAdmissionFacts(tx, input.admissionId);
    if (a === null) throw new CanteenRefusal("not_found", { admissionId: input.admissionId });
    if (a.closed !== null) throw new CanteenRefusal(a.closed);
    if (!(await getApprovalType(tx, CANTEEN_CHARITY_APPROVAL))) throw new CanteenRefusal("charity_not_approved", { reason: "approval_type_missing" });
    const grantId = newId();
    const { approvalId } = await requestApproval(tx, actor, {
      typeKey: CANTEEN_CHARITY_APPROVAL, subject: { type: CANTEEN_CHARITY_SUBJECT, id: grantId }, patientId: a.patientId,
      amountPaise: input.meals * input.mealLimitPaise, requestNote: `${input.kind === "free" ? "Free" : "Subsidised"} family meals ×${String(input.meals)}: ${input.note}`,
    });
    await tx.insert(canteenCharityGrants).values({
      id: grantId, approvalId, admissionId: a.admissionId, patientId: a.patientId, kind: input.kind, meals: input.meals,
      mealLimitPaise: input.mealLimitPaise, validUntil: input.validUntil, note: input.note, requestedBy: actor.id, requestedAt: at,
    });
    return { grantId, approvalId };
  });
}

export async function charityGrant(db: Db, actor: Actor, grantId: string): Promise<CanteenCharityGrant> {
  await requireAny(db, actor, CANTEEN_SELL, CANTEEN_MANAGE, CANTEEN_FINANCE, CANTEEN_VIEW);
  const g = (await db.select().from(canteenCharityGrants).where(eq(canteenCharityGrants.id, grantId)))[0];
  if (g === undefined) throw new CanteenRefusal("not_found", { grantId });
  const status = (await db.select({ s: approvals.status }).from(approvals).where(eq(approvals.id, g.approvalId)))[0]?.s;
  const used = (await db.select({ id: canteenSales.id, state: canteenSales.state }).from(canteenSales).where(eq(canteenSales.grantId, g.id)))
    .filter((s) => s.state !== "cancelled").length;
  return {
    grantId: g.id, approvalId: g.approvalId, admissionId: g.admissionId, kind: g.kind as CanteenCharityKind, meals: g.meals, mealsUsed: used,
    mealLimitPaise: g.mealLimitPaise, validUntil: g.validUntil, status: status === "granted" ? "granted" : status === "rejected" ? "rejected" : "pending",
  };
}
