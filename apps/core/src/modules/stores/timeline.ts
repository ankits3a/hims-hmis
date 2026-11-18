import { asc, eq, inArray } from "drizzle-orm";
import { resources, roleAssignments, storeIndentLines, items, storeIndents, storesPickingClaims, storesTicketDetails, transfers, users } from "../../kernel/db/schema";
import { STORES_AUDIT_READ, STORES_INDENTS_APPROVE, STORES_NIGHTSTORE_ISSUE, STORES_SHELF_READ, holds } from "./access";
import { StoresError } from "./errors";
import type { TicketTimeline, TimelineStep, TimelineStepKind } from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S2a (#1112, decision 13) — THE TICKET'S TIMELINE, derived from rows every time: the raise (or
 * re-raise), the HOD's answer ("for HOD" when the superintendent stood in), each picking claim, the issue,
 * the emergency review, the store's rejection or the requester's cancel, and the receipt. Each step names who
 * (name and role), from where to where, when, and the minutes since the step before. Nothing about a
 * ticket's lane is stored. S2b adds the custody hand-offs, shorts and returns from their own rows.
 *
 * Who may look: the department's shelf readers and approvers, the store's keepers, the night store's keepers
 * and the audit-pack readers.
 */
async function mayRead(db: Db | Tx, actor: Actor, departmentId: string): Promise<boolean> {
  return (await holds(db, actor, STORES_SHELF_READ, departmentId)) || (await holds(db, actor, STORES_INDENTS_APPROVE, departmentId))
    || (await holds(db, actor, "materials.stock.read")) || (await holds(db, actor, STORES_NIGHTSTORE_ISSUE)) || (await holds(db, actor, STORES_AUDIT_READ));
}

export async function ticketTimeline(db: Db, actor: Actor, indentId: string): Promise<TicketTimeline> {
  const [row] = await db.select({ indent: storeIndents, details: storesTicketDetails }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id)).where(eq(storeIndents.id, indentId));
  if (row === undefined) throw new StoresError("unknown_ticket", `ticket ${indentId} not found`, { indentId });
  if (!(await mayRead(db, actor, row.details.departmentId))) throw new StoresError("not_permitted", "not your department", { departmentId: row.details.departmentId });
  const { indent: i, details: d } = row;

  const lines = await db.select({ line: storeIndentLines, name: items.name }).from(storeIndentLines).innerJoin(items, eq(items.id, storeIndentLines.itemId))
    .where(eq(storeIndentLines.indentId, indentId)).orderBy(asc(storeIndentLines.lineIdx));
  const claims = await db.select().from(storesPickingClaims).where(eq(storesPickingClaims.indentId, indentId)).orderBy(asc(storesPickingClaims.claimedAt));
  const [transfer] = i.transferId === null ? [] : await db.select().from(transfers).where(eq(transfers.id, i.transferId));
  const [origin] = d.originIndentId === null ? [] : await db.select({ no: storeIndents.indentNo }).from(storeIndents).where(eq(storeIndents.id, d.originIndentId));

  const people = [...new Set([i.requestedBy, i.approvalBy, i.decidedBy, i.reviewedBy, transfer?.receivedBy ?? null, ...claims.map((c) => c.claimedBy)]
    .filter((x): x is string => x !== null))];
  const names = new Map((await db.select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, people))).map((u) => [u.id, u.n] as const));
  const roles = new Map<string, string[]>();
  for (const r of await db.select({ u: roleAssignments.userId, k: roleAssignments.roleKey }).from(roleAssignments).where(inArray(roleAssignments.userId, people))) {
    roles.set(r.u, [...new Set([...(roles.get(r.u) ?? []), r.k])].sort());
  }
  const places = new Map((await db.select({ id: resources.id, code: resources.code, name: resources.name }).from(resources)
    .where(inArray(resources.id, [i.fromResourceId, i.toResourceId]))).map((p) => [p.id, p] as const));
  const who = (id: string | null): TimelineStep["who"] => (id === null ? null : { id, name: names.get(id) ?? id, roles: roles.get(id) ?? [] });
  const place = (id: string): TimelineStep["from"] => places.get(id) ?? { id, code: "", name: id };
  const shelf = place(i.fromResourceId);
  const source = place(i.toResourceId);

  type Draft = Omit<TimelineStep, "minutes">;
  const steps: Draft[] = [];
  const add = (step: TimelineStepKind, by: string | null, at: Date, from: TimelineStep["from"], to: TimelineStep["to"], extra: Partial<Draft> = {}): void => {
    steps.push({ step, who: who(by), from, to, at: at.toISOString(), forHod: false, note: null, lines: [], ...extra });
  };
  add(d.originKind === "re_raise" ? "re_raise" : d.originKind === "re_ask" ? "re_ask" : "raise", i.requestedBy, i.requestedAt, shelf, source, {
    note: origin === undefined ? (d.emergencyReason ?? null) : origin.no,
    lines: lines.map((l) => ({ itemId: l.line.itemId, itemName: l.name, asked: l.line.qtyBase, approved: null, issued: null })),
  });
  if (i.approvalDecision !== null && i.approvalAt !== null) {
    add(i.approvalDecision === "approved" ? "approve" : "decline", i.approvalBy, i.approvalAt, null, null, {
      forHod: i.approvalForHod === true, note: i.approvalReason,
      lines: i.approvalDecision === "approved" ? lines.map((l) => ({ itemId: l.line.itemId, itemName: l.name, asked: l.line.qtyBase, approved: l.line.qtyApproved, issued: null })) : [],
    });
  }
  for (const c of claims) add("claim", c.claimedBy, c.claimedAt, source, null);
  if (i.status === "issued" && i.decidedAt !== null) {
    add("issue", i.decidedBy, i.decidedAt, source, shelf, {
      lines: lines.map((l) => ({ itemId: l.line.itemId, itemName: l.name, asked: l.line.qtyBase, approved: l.line.qtyApproved, issued: l.line.qtyIssued })),
    });
  }
  if (i.status === "rejected" && i.approvalDecision !== "declined" && i.decidedAt !== null) add("reject", i.decidedBy, i.decidedAt, source, null, { note: i.rejectReason });
  if (i.status === "cancelled" && i.decidedAt !== null) add("cancel", i.decidedBy, i.decidedAt, shelf, null, { note: i.cancelReason });
  if (i.reviewDecision !== null && i.reviewedAt !== null) add("review", i.reviewedBy, i.reviewedAt, null, null, { note: i.reviewNote ?? i.reviewDecision });
  if (transfer?.receivedAt != null) add("receive", transfer.receivedBy, transfer.receivedAt, source, shelf);

  const ordered = steps.map((s, idx) => ({ s, idx })).sort((a, b) => a.s.at.localeCompare(b.s.at) || a.idx - b.idx).map((x) => x.s);
  return {
    indentId, indentNo: i.indentNo,
    steps: ordered.map((s, k) => ({
      ...s, minutes: k === 0 ? null : Math.round((new Date(s.at).getTime() - new Date(ordered[k - 1]!.at).getTime()) / 60_000),
    })),
  };
}
