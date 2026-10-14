import { desc, inArray } from "drizzle-orm";
import { users, workflowDefinitionApprovals, workflowDefinitions } from "../db/schema";
import { withTx } from "../db/client";
import { parseDefinition } from "./definition";
import { CHANGE_CLASS_POLICY } from "./definitions";
import { actorHoldsAnyRole } from "./roles";
import type { ChangeClass, WorkflowDefinition } from "./definition";
import type { Db } from "../db/client";

/**
 * GO-LIVE SCREENS — the read model behind `/admin/workflows`: every workflow definition with its state, the
 * approvals it holds, who drafted and activated it, a summary of its steps and how a draft differs from the version
 * in force. It also says which policy roles the VIEWER holds, so the screen offers only the approve buttons that
 * person could use. READ-ONLY: approving and activating stay `approveDefinition` / `activateDefinition`, whose
 * two-person, role and SoD checks are the authority. Nothing here decides who may act.
 */
export type BoardTransition = { from: string; to: string; roles: string[] };
export type BoardDefinition = {
  id: string; defKey: string; version: number; title: string; changeClass: string;
  status: "draft" | "active" | "retired";
  draftedBy: { id: string; name: string | null }; draftedAt: string;
  activatedBy: { id: string; name: string | null } | null; activatedAt: string | null;
  approvals: { approverId: string; approverName: string | null; roleKey: string; emergency: boolean; note: string; at: string }[];
  requiredRoles: string[];
  /** Policy roles nobody has approved yet (normal road). Empty → the owner may activate. */
  missingRoles: string[];
  steps: { initialState: string; states: { name: string; terminal: boolean }[]; transitions: BoardTransition[] };
  /** Versus the ACTIVE version of the same key; null when there is none or this IS the active one. */
  diff: { addedStates: string[]; removedStates: string[]; addedTransitions: BoardTransition[]; removedTransitions: BoardTransition[] } | null;
};
export type WorkflowBoard = { definitions: BoardDefinition[]; viewer: { policyRoles: string[] } };

const tKey = (t: { from: string; to: string }): string => `${t.from}→${t.to}`;

function steps(def: WorkflowDefinition): BoardDefinition["steps"] {
  return {
    initialState: def.initialState,
    states: def.states.map((s) => ({ name: s.name, terminal: s.terminal === true })),
    transitions: def.transitions.map((t) => ({ from: t.from, to: t.to, roles: [...t.roles] })),
  };
}

function diffOf(draft: BoardDefinition["steps"], active: BoardDefinition["steps"]): NonNullable<BoardDefinition["diff"]> {
  const ds = new Set(draft.states.map((s) => s.name));
  const as = new Set(active.states.map((s) => s.name));
  const dt = new Map(draft.transitions.map((t) => [tKey(t), t]));
  const at = new Map(active.transitions.map((t) => [tKey(t), t]));
  return {
    addedStates: [...ds].filter((s) => !as.has(s)),
    removedStates: [...as].filter((s) => !ds.has(s)),
    addedTransitions: [...dt.entries()].filter(([k]) => !at.has(k)).map(([, t]) => t),
    removedTransitions: [...at.entries()].filter(([k]) => !dt.has(k)).map(([, t]) => t),
  };
}

/** Drafts and active versions of every key, plus the latest retired one per key (history), newest first. */
export async function readWorkflowBoard(db: Db, viewerId: string): Promise<WorkflowBoard> {
  const rows = await db.select().from(workflowDefinitions).orderBy(workflowDefinitions.defKey, desc(workflowDefinitions.version));
  const keepRetired = new Set<string>();
  const kept = rows.filter((r) => {
    if (r.status !== "retired") return true;
    if (keepRetired.has(r.defKey)) return false;
    keepRetired.add(r.defKey);
    return true;
  });
  const ids = kept.map((r) => r.id);
  const approvals = ids.length === 0 ? [] : await db.select().from(workflowDefinitionApprovals)
    .where(inArray(workflowDefinitionApprovals.definitionId, ids));
  const people = [...new Set([...kept.map((r) => r.draftedBy), ...kept.map((r) => r.activatedBy ?? ""), ...approvals.map((a) => a.approverId)]
    .filter((x) => x !== ""))];
  const names = new Map((people.length === 0 ? [] : await db.select({ id: users.id, name: users.fullName }).from(users)
    .where(inArray(users.id, people))).map((u) => [u.id, u.name]));
  const activeSteps = new Map(kept.filter((r) => r.status === "active").map((r) => [r.defKey, steps(parseDefinition(r.definition))]));

  const definitions = kept.map((r): BoardDefinition => {
    const policy = CHANGE_CLASS_POLICY[r.changeClass as ChangeClass];
    const mine = approvals.filter((a) => a.definitionId === r.id);
    const got = new Set(mine.filter((a) => !a.emergency).map((a) => a.roleKey));
    const s = steps(parseDefinition(r.definition));
    const active = activeSteps.get(r.defKey);
    return {
      id: r.id, defKey: r.defKey, version: r.version, title: r.title, changeClass: r.changeClass,
      status: r.status as BoardDefinition["status"],
      draftedBy: { id: r.draftedBy, name: names.get(r.draftedBy) ?? null }, draftedAt: r.createdAt.toISOString(),
      activatedBy: r.activatedBy === null ? null : { id: r.activatedBy, name: names.get(r.activatedBy) ?? null },
      activatedAt: r.activatedAt?.toISOString() ?? null,
      approvals: mine.map((a) => ({
        approverId: a.approverId, approverName: names.get(a.approverId) ?? null, roleKey: a.roleKey,
        emergency: a.emergency, note: a.note, at: a.createdAt.toISOString(),
      })),
      requiredRoles: policy.requiredRoles,
      missingRoles: policy.requiredRoles.filter((x) => !got.has(x)),
      steps: s,
      diff: r.status === "draft" && active !== undefined ? diffOf(s, active) : null,
    };
  });

  const allPolicyRoles = [...new Set(Object.values(CHANGE_CLASS_POLICY).flatMap((p) => p.requiredRoles))];
  const policyRoles: string[] = [];
  await withTx(db, async (tx) => {
    for (const role of allPolicyRoles) if (await actorHoldsAnyRole(tx, viewerId, [role])) policyRoles.push(role);
  });
  return { definitions, viewer: { policyRoles } };
}
