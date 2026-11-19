import { asc, eq, inArray } from "drizzle-orm";
import { resources, roleAssignments, storeIndentLines, items, storeIndents, storesPickingClaims, storesTicketDetails, transfers, users } from "../../kernel/db/schema";
import { chainOf, lastCustodianOf } from "./chain";
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

/** D22: a phone time and a server time further apart than this are both shown. */
const SKEW_MS = 5 * 60_000;

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

  const chain = await chainOf(db, indentId);
  const people = [...new Set([i.requestedBy, i.approvalBy, i.decidedBy, i.reviewedBy, transfer?.receivedBy ?? null, ...claims.map((c) => c.claimedBy),
    ...chain.handoffs.flatMap((h) => [h.fromUserId, h.toUserId]), ...chain.delivery.map((d) => d.receivedBy),
    ...chain.resolutions.flatMap((r) => [r.requestedBy, r.postedBy])]
    .filter((x): x is string => x !== null))];
  const names = new Map((await db.select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, people))).map((u) => [u.id, u.n] as const));
  const roles = new Map<string, string[]>();
  for (const r of await db.select({ u: roleAssignments.userId, k: roleAssignments.roleKey }).from(roleAssignments).where(inArray(roleAssignments.userId, people))) {
    roles.set(r.u, [...new Set([...(roles.get(r.u) ?? []), r.k])].sort());
  }
  const placeIds = [...new Set([i.fromResourceId, i.toResourceId, ...chain.resolutions.map((r) => r.toResourceId).filter((x): x is string => x !== null)])];
  const places = new Map((await db.select({ id: resources.id, code: resources.code, name: resources.name }).from(resources)
    .where(inArray(resources.id, placeIds))).map((p) => [p.id, p] as const));
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
  // S2b: the chain. A hand-off names the holder it came from; a scan whose phone time and server time differ by
  // more than 5 minutes carries both ("Synced late").
  const nameOf = (id: string): string => names.get(id) ?? id;
  for (const h of chain.handoffs) {
    const skew = h.phoneAt !== null && Math.abs(h.recordedAt.getTime() - h.phoneAt.getTime()) > SKEW_MS;
    const note = h.kind === "take_over" ? `from ${nameOf(h.fromUserId)} · ${h.reason ?? ""}` : `from ${nameOf(h.fromUserId)}`;
    add(h.kind as TimelineStepKind, h.toUserId, h.occurredAt, h.kind === "return_accepted" ? null : source, h.kind === "return_accepted" ? source : null, {
      note, ...(skew ? { phoneAt: h.phoneAt!.toISOString(), recordedAt: h.recordedAt.toISOString() } : {}),
    });
  }
  const delivered = chain.delivery[0];
  if (delivered !== undefined) {
    const sum = (k: "accepted" | "short" | "wrong" | "damaged"): number => chain.delivery.reduce((a, x) => a + x[k], 0);
    const short = sum("short");
    const back = sum("wrong") + sum("damaged");
    add(delivered.atCounter ? "collect" : "deliver", delivered.receivedBy, delivered.receivedAt, delivered.atCounter ? source : null, shelf, {
      note: [short > 0 ? `${String(short)} short` : null, back > 0 ? `${String(back)} sent back` : null].filter((x) => x !== null).join(" · ") || null,
      lines: lines.map((l) => ({ itemId: l.line.itemId, itemName: l.name, asked: l.line.qtyBase, approved: l.line.qtyApproved,
        issued: chain.delivery.filter((x) => x.lineIdx === l.line.lineIdx).reduce((a, x) => a + x.accepted, 0) })),
    });
  } else if (transfer?.receivedAt != null && transfer.status !== "returned") {
    add("receive", transfer.receivedBy, transfer.receivedAt, source, shelf);
  }
  const lastHand = transfer === undefined ? null : lastCustodianOf(transfer.issuedBy, chain);
  for (const r of chain.resolutions) {
    const to = r.toResourceId === null ? null : place(r.toResourceId);
    if (r.kind === "sent_back") continue; // one step for the lot, below
    if (r.kind === "undelivered") {
      if (chain.resolutions.indexOf(r) === chain.resolutions.findIndex((x) => x.kind === "undelivered")) add("return_undelivered", r.requestedBy, r.requestedAt, null, source);
      continue;
    }
    add(r.kind as TimelineStepKind, r.postedBy ?? r.requestedBy, r.postedAt ?? r.requestedAt, null, to, {
      note: [`${String(r.qty)}`, lastHand === null ? null : `with ${nameOf(lastHand)}`, r.status === "pending" ? "asked" : null, r.note].filter((x) => x !== null).join(" · "),
    });
  }
  const sentBack = chain.resolutions.filter((r) => r.kind === "sent_back");
  if (sentBack.length > 0) {
    add("send_back", sentBack[0]!.requestedBy, sentBack[0]!.requestedAt, shelf, source, { note: `${String(sentBack.reduce((a, r) => a + r.qty, 0))} sent back` });
  }

  const ordered = steps.map((s, idx) => ({ s, idx })).sort((a, b) => a.s.at.localeCompare(b.s.at) || a.idx - b.idx).map((x) => x.s);
  return {
    indentId, indentNo: i.indentNo,
    steps: ordered.map((s, k) => ({
      ...s, minutes: k === 0 ? null : Math.round((new Date(s.at).getTime() - new Date(ordered[k - 1]!.at).getTime()) / 60_000),
    })),
  };
}
