import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { orgDepartments, roleAssignments, users } from "../../kernel/db/schema";
import {
  STORES_BUDGET_MANAGE, STORES_BUYING_MANAGE, STORES_GRN_QC, STORES_INDENTS_APPROVE, STORES_MASTERS, STORES_PURCHASE_REQUEST, holds,
} from "./access";
import { departmentBudget } from "./budgets";
import { liveDelegatedDepartments } from "./delegations";
import { StoresError } from "./errors";
import { listShelves } from "./shelves";
import type { WireDepartmentBudget } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S5a (#1115) — WHAT THE `/stores/buy` SCREEN NEEDS TO KNOW ABOUT ITS READER: the departments they may ask for
 * (and their shelves), the departments they approve for (their own, or as a delegate), and which tabs they hold. Any
 * signed-in user may read it: it names departments and shelves only, no money and no stock.
 */
export type BuyContext = {
  departments: { id: string; code: string; name: string; canAsk: boolean; canApprove: boolean; ownHod: boolean; shelves: { id: string; name: string }[] }[];
  can: { buying: boolean; masters: boolean; budget: boolean; qc: boolean; bulk: boolean };
};

export async function buyContext(db: Db, actor: Actor, now: Date = new Date()): Promise<BuyContext> {
  const depts = await db.select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name }).from(orgDepartments)
    .where(eq(orgDepartments.active, true)).orderBy(asc(orgDepartments.name));
  const delegated = actor.type === "user" ? await liveDelegatedDepartments(db, actor.id, now) : new Set<string>();
  const shelves = await listShelves(db);
  const hospitalApprover = await holds(db, actor, STORES_INDENTS_APPROVE);
  const out: BuyContext["departments"] = [];
  for (const d of depts) {
    const canAsk = await holds(db, actor, STORES_PURCHASE_REQUEST, d.id);
    const approver = await holds(db, actor, STORES_INDENTS_APPROVE, d.id);
    const canApprove = approver || delegated.has(d.id);
    if (!canAsk && !canApprove) continue;
    // A hospital-scope stand-in approves everywhere; listing every department for it would be noise on a phone.
    if (!canAsk && approver && hospitalApprover && !delegated.has(d.id)) continue;
    out.push({
      ...d, canAsk, canApprove, ownHod: approver && !hospitalApprover,
      shelves: shelves.filter((s) => s.departmentId === d.id).map((s) => ({ id: s.id, name: s.name })),
    });
  }
  const masters = await holds(db, actor, STORES_MASTERS);
  return {
    departments: out,
    can: {
      buying: await holds(db, actor, STORES_BUYING_MANAGE), masters, budget: await holds(db, actor, STORES_BUDGET_MANAGE),
      qc: await holds(db, actor, STORES_GRN_QC), bulk: masters || (await isOwner(db, actor)),
    },
  };
}

async function isOwner(db: Db, actor: Actor): Promise<boolean> {
  if (actor.type !== "user") return false;
  const [r] = await db.select({ u: roleAssignments.userId }).from(roleAssignments)
    .where(and(eq(roleAssignments.userId, actor.id), eq(roleAssignments.roleKey, "owner"))).limit(1);
  return r !== undefined;
}

/** The people an HOD may hand the approval to: active users assigned any role AT the department, never the HOD. */
export async function delegationCandidates(db: Db, actor: Actor, departmentId: string): Promise<{ id: string; name: string }[]> {
  if (!(await holds(db, actor, STORES_INDENTS_APPROVE, departmentId))) {
    throw new StoresError("not_permitted", "only the department's HOD hands over its approval", { permission: STORES_INDENTS_APPROVE, departmentId });
  }
  if (actor.type !== "user") return [];
  const rows = await db.selectDistinct({ id: users.id, name: users.fullName }).from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(eq(roleAssignments.scopeType, "department"), eq(roleAssignments.scopeId, departmentId), eq(users.active, true), ne(users.id, actor.id)))
    .orderBy(asc(users.fullName));
  return rows;
}

/** Finance's month: every department with a shelf or a budget, its budget line. */
export async function budgetsForMonth(db: Db, actor: Actor, month: string): Promise<(WireDepartmentBudget & { code: string; name: string })[]> {
  if (!(await holds(db, actor, STORES_BUDGET_MANAGE))) throw new StoresError("not_permitted", "budgets are finance's", { permission: STORES_BUDGET_MANAGE });
  const shelfDepts = (await listShelves(db)).map((s) => s.departmentId).filter((x): x is string => x !== null);
  const ids = [...new Set(shelfDepts)];
  const depts = ids.length === 0 ? [] : await db.select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name }).from(orgDepartments)
    .where(inArray(orgDepartments.id, ids)).orderBy(asc(orgDepartments.name));
  return Promise.all(depts.map(async (d) => ({ ...(await departmentBudget(db, d.id, month)), code: d.code, name: d.name })));
}
