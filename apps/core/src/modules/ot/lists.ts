import { and, asc, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { otCases, otLists } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { transition } from "../../kernel/workflow/instances";
import { OtError } from "./errors";
import { listPublished, surgeonLateFlagged } from "./events";
import { caseGates, evaluateReadiness } from "./gates";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T4 — **THE LIST: the coordination artifact, published the evening before.**
 *
 * ═══ A PUBLISH IS A NEW VERSION, NEVER AN EDIT (C2) ═══
 *
 * `ot_lists` is versioned per (date, theatre) and the previous version is `superseded`. That is what
 * makes the printed sheet in a nurse's hand answerable — "which list are you holding?" has a number
 * on it — and it is why the downtime pack (DD19) can be printed from a DRAFT: a list that could be
 * edited in place would have no version to print.
 *
 * ═══ F18/F24g — A LIST ITEM WITHOUT AN ANAESTHETIST IS REFUSED ═══
 *
 * The adversarial pass found that `usersHoldingRole("anaesthetist")` is a LIST, not an assignment:
 * nothing in the tree says WHICH anaesthetist is doing WHICH case. §11.16-A's sign-in requires an
 * assigned anaesthetist, so the assignment has to be made somewhere, and the list is that somewhere
 * — the Sunday list published without one is F24's own edge case, and it is refused at publish
 * rather than discovered at 08:00 in the holding bay.
 */

export type OtListRow = typeof otLists.$inferSelect;

export type ListItem = {
  caseId: string;
  seq: number;
  procedureClass: string;
  procedureCode: string;
  laterality: string | null;
  surgeonId: string;
  anaesthetistId: string | null;
  state: string;
  gates: { kind: string; state: string }[];
};

/** The day's list for a theatre, with each case's gate chips (the `/ot/list` screen's whole data). */
export async function listForDay(
  exec: Db | Tx, listDate: string, theatreResourceId: string,
): Promise<ListItem[]> {
  const rows = (await exec.execute(sql`
    select c.id as "caseId", c.seq as "seq", c.procedure_class as "procedureClass",
           c.procedure_code as "procedureCode", c.laterality as "laterality",
           c.surgeon_id as "surgeonId", c.anaesthetist_id as "anaesthetistId",
           w.current_state as "state"
      from ot_cases c
      join workflow_instances w on w.id = c.workflow_instance_id
     where c.list_date = ${listDate} and c.theatre_resource_id = ${theatreResourceId}
     order by c.seq asc
  `)).rows as Omit<ListItem, "gates">[];
  const items: ListItem[] = [];
  for (const row of rows) {
    items.push({ ...row, gates: (await caseGates(exec, row.caseId)).map((g) => ({ kind: g.kind, state: g.state })) });
  }
  return items;
}

/**
 * Publishes the day's list. Every case on it moves `booked → listed`, and readiness is evaluated
 * immediately afterwards — a case whose gates were all satisfied before publication reaches `ready`
 * in the same call rather than waiting for somebody to touch a gate again.
 */
export async function publishList(
  db: Db, actor: Actor, input: { listDate: string; theatreResourceId: string },
): Promise<{ listId: string; version: number; caseCount: number; readyCaseIds: string[] }> {
  return db.transaction(async (tx) => {
    const cases = await tx.select().from(otCases)
      .where(and(eq(otCases.listDate, input.listDate), eq(otCases.theatreResourceId, input.theatreResourceId)))
      .orderBy(asc(otCases.seq));

    if (cases.length === 0) {
      throw new OtError("list_not_publishable", `no cases on ${input.listDate} for this theatre`);
    }

    /**
     * F18/F24g — EVERY case needs a named anaesthetist USER before the list is published. Checked
     * across the whole list before anything is written, so the coordinator is told about all of them
     * at once rather than one refusal per re-publish.
     */
    const live = cases.filter((c) => c.cancellationReason === null);
    const unassigned = live.filter((c) => c.anaesthetistId === null).map((c) => c.id);
    if (unassigned.length > 0) {
      throw new OtError(
        "list_not_publishable",
        `${String(unassigned.length)} case(s) have no assigned anaesthetist — a list item without one cannot be signed in (F18)`,
        { caseIds: unassigned },
      );
    }

    const latest = await tx.select({ version: otLists.version }).from(otLists)
      .where(and(eq(otLists.listDate, input.listDate), eq(otLists.theatreResourceId, input.theatreResourceId)))
      .orderBy(sql`version desc`).limit(1);
    const version = (latest[0]?.version ?? 0) + 1;

    await tx.update(otLists).set({ status: "superseded" })
      .where(and(
        eq(otLists.listDate, input.listDate),
        eq(otLists.theatreResourceId, input.theatreResourceId),
        eq(otLists.status, "published"),
      ));

    const listId = newId();
    await tx.insert(otLists).values({
      id: listId, listDate: input.listDate, theatreResourceId: input.theatreResourceId,
      version, status: "published", publishedAt: new Date(), publishedBy: actor.id, createdBy: actor.id,
    });

    // `booked → listed` for every live case, then readiness. A case already past `booked` — a
    // re-publish after one case has been wheeled in — is left where it is rather than refused.
    const readyCaseIds: string[] = [];
    for (const kase of live) {
      const stateRows = (await tx.execute(sql`
        select current_state as "state" from workflow_instances where id = ${kase.workflowInstanceId}
      `)).rows as { state: string }[];
      if (stateRows[0]!.state === "booked") {
        await transition(tx, kase.workflowInstanceId, "listed", actor);
      }
      const evaluated = await evaluateReadiness(tx, kase.id);
      if (evaluated.state === "ready") readyCaseIds.push(kase.id);
    }

    await appendEvent(tx, listPublished.make({
      actor,
      payload: {
        listId, listDate: input.listDate, theatreResourceId: input.theatreResourceId,
        version, caseCount: live.length,
      },
    }));
    return { listId, version, caseCount: live.length, readyCaseIds };
  });
}

/**
 * Re-sequences a published list. The whole order is rewritten in ONE transaction, which is why
 * `ot_cases.seq` carries no unique index: a non-deferrable unique would refuse the intermediate
 * state of any swap (schema/ot.ts says so at the column).
 *
 * A re-sequence does NOT publish a new version — the order within a published list is operational,
 * and versioning every swap would make the printed sheet's version number meaningless.
 */
export async function resequence(
  db: Db, actor: Actor, input: { listDate: string; theatreResourceId: string; caseIdsInOrder: string[] },
): Promise<{ resequenced: number }> {
  return db.transaction(async (tx) => {
    const cases = await tx.select().from(otCases)
      .where(and(eq(otCases.listDate, input.listDate), eq(otCases.theatreResourceId, input.theatreResourceId)));
    const known = new Set(cases.map((c) => c.id));
    const asked = new Set(input.caseIdsInOrder);
    if (asked.size !== input.caseIdsInOrder.length) {
      throw new OtError("list_not_publishable", "a case appears twice in the requested order");
    }
    // The order must name EVERY case on the list. A partial order would leave the unnamed cases at
    // their old sequence numbers, silently colliding with the new ones.
    for (const id of input.caseIdsInOrder) {
      if (!known.has(id)) throw new OtError("unknown_case", `case ${id} is not on this list`);
    }
    if (asked.size !== known.size) {
      throw new OtError(
        "list_not_publishable",
        `the order names ${String(asked.size)} of ${String(known.size)} cases — a re-sequence rewrites the whole list`,
      );
    }
    for (const [index, caseId] of input.caseIdsInOrder.entries()) {
      await tx.update(otCases).set({ seq: index + 1, updatedBy: actor.id, updatedAt: new Date() })
        .where(eq(otCases.id, caseId));
    }
    return { resequenced: input.caseIdsInOrder.length };
  });
}

/**
 * DD19 — the per-case downtime pack's DATA (T8 renders it). Printed WITH the list, from a draft or a
 * published version, because C1's whole scenario is that the server is down when it is wanted.
 */
export async function printPack(
  exec: Db | Tx, caseId: string,
): Promise<{
  caseId: string; procedureCode: string; laterality: string | null; listDate: string; seq: number;
  surgeonId: string; anaesthetistId: string | null; gates: { kind: string; state: string }[];
  sheets: string[];
}> {
  const rows = await exec.select().from(otCases).where(eq(otCases.id, caseId));
  const kase = rows[0];
  if (!kase) throw new OtError("unknown_case", `unknown case ${caseId}`);
  return {
    caseId, procedureCode: kase.procedureCode, laterality: kase.laterality,
    listDate: kase.listDate, seq: kase.seq, surgeonId: kase.surgeonId, anaesthetistId: kase.anaesthetistId,
    gates: (await caseGates(exec, caseId)).map((g) => ({ kind: g.kind, state: g.state })),
    // doc 15 §6.2 — the four sheets a case needs when the screen is dark.
    sheets: ["who_checklist", "count_sheet", "implant_sticker_sheet", "specimen_label"],
  };
}

/** F1 — the two rungs. A surgeon 15 minutes past the slot is flagged; 30 minutes is the second rung.
 *  The no-show CANCEL at +60 is a human act with an attribution, not a job (R-3.12). */
export const SURGEON_LATE_RUNGS_MINUTES = [15, 30] as const;

/**
 * F1's scheduler job. It flags; it never cancels.
 *
 * **A JOB, not a `setTimeout`** — the plan says so in as many words, and the reason is the one
 * `scheduler.ts` exists for: a timeout dies with the process and leaves no lock, so two workers
 * would both fire it and a restart would fire neither.
 *
 * It reads the NPO gate's `plannedStart` as the slot, because that is the only place in this phase
 * where a case's intended start time is recorded (finding T4-a). A case with no NPO gate — a
 * local-anaesthesia class — is not flagged, which is honest rather than clever: nothing in this
 * phase knows when that case was meant to start.
 */
export async function flagLateSurgeons(db: Db, now: Date = new Date()): Promise<number> {
  const rows = (await db.execute(sql`
    select c.id as "caseId", c.surgeon_id as "surgeonId", c.patient_id as "patientId",
           c.encounter_id as "encounterId", g.evidence as "evidence"
      from ot_cases c
      join workflow_instances w on w.id = c.workflow_instance_id
      join ot_case_gates g on g.case_id = c.id and g.kind = 'npo'
     where w.current_state in ('ready', 'listed')
       and g.evidence is not null
  `)).rows as {
    caseId: string; surgeonId: string; patientId: string; encounterId: string;
    evidence: { plannedStart?: string } | null;
  }[];

  let flagged = 0;
  for (const row of rows) {
    const plannedStart = row.evidence?.plannedStart;
    if (plannedStart === undefined) continue;
    const minutesLate = Math.floor((now.getTime() - new Date(plannedStart).getTime()) / 60_000);
    // The HIGHEST rung reached, once — not one event per rung per sweep. A job that ran every
    // minute and emitted at every rung would put thirty identical rows in the digest.
    const rung = [...SURGEON_LATE_RUNGS_MINUTES].reverse().find((m) => minutesLate >= m);
    if (rung === undefined) continue;
    const already = (await db.execute(sql`
      select 1 from events
       where name = 'surgeon.late_flagged'
         and payload->>'caseId' = ${row.caseId}
         and (payload->>'minutesLate')::int >= ${rung}
       limit 1
    `)).rows;
    if (already.length > 0) continue;
    await db.transaction(async (tx) => {
      await appendEvent(tx, surgeonLateFlagged.make({
        actor: { type: "system", id: "ot.surgeon-late" },
        patientId: row.patientId, encounterId: row.encounterId,
        payload: { caseId: row.caseId, surgeonId: row.surgeonId, minutesLate: rung },
      }));
    });
    flagged += 1;
  }
  return flagged;
}
