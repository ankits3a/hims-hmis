import { IPD_CLASS_CHANGE_HOUR_IST } from "@hmis/contracts";
import { asc, eq } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import { ipdClassChanges } from "../../kernel/db/schema";
import { istStartOf, nextIstDate } from "./charge-days";
import type { IpdBedClass } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { ChargeStay } from "./charge-days";

/**
 * E3.1 (#729) — A CLASS CHANGE WITHOUT A BED MOVE, as the running bill sees it (spec SPEC-ipd-core §4.4: "class
 * upgrade or downgrade on request: consent, effective next noon").
 *
 * The change is NOT written into `ipd_bed_stays` (that would need a stay that starts in the future, which every
 * "open stay" reader would misread). It is a row in `ipd_class_changes` naming the stay; the bill folds it into the
 * stay here, before the day rule, so a stay is split at `effective_from` and its later part bills at `to_class`. The
 * day rule then decides the noon day as it decides any move: the highest class held over an hour.
 *
 * DECIDED (E3.1, standard corporate-hospital practice):
 * - "Next noon" is the first 12:00 IST strictly after the consent: asked 09:00 → today 12:00; asked 13:00 → tomorrow.
 * - A change binds the stay (the bed) it was made on. A patient who moves before it takes effect leaves it behind;
 *   a later move bills the new bed's class — a new request needs a new consent.
 * - A newer change on the same stay supersedes an older one not yet in effect (the older row is marked superseded).
 */

/** The first 12:00 IST strictly after `at`. */
export function nextNoonIst(at: Date): Date {
  const today = istDayString(at);
  const noon = new Date(istStartOf(today).getTime() + IPD_CLASS_CHANGE_HOUR_IST * 3_600_000);
  return noon.getTime() > at.getTime() ? noon : new Date(istStartOf(nextIstDate(today)).getTime() + IPD_CLASS_CHANGE_HOUR_IST * 3_600_000);
}

export type StayClassChange = { stayId: string; toClass: IpdBedClass; effectiveFrom: Date };

/**
 * Pure: splits each stay at the instants its class changes take effect. A change outside the stay's span is ignored
 * (the patient left the bed first); one at or before the stay's start re-classes the whole stay. Extra fields on a
 * stay are kept on every part.
 */
export function applyClassChanges<S extends ChargeStay & { id: string }>(stays: readonly S[], changes: readonly StayClassChange[]): S[] {
  const out: S[] = [];
  for (const s of stays) {
    const mine = changes.filter((c) => c.stayId === s.id).sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    let current: S = s;
    for (const c of mine) {
      const at = c.effectiveFrom.getTime();
      if (current.endedAt !== null && at >= current.endedAt.getTime()) continue;
      if (at <= current.startedAt.getTime()) {
        current = { ...current, billedClass: c.toClass };
        continue;
      }
      out.push({ ...current, endedAt: new Date(at) });
      current = { ...current, startedAt: new Date(at), billedClass: c.toClass };
    }
    out.push(current);
  }
  return out;
}

/** The active class changes of one admission (superseded rows are not). */
export async function classChangesOf(db: Db | Tx, admissionId: string): Promise<StayClassChange[]> {
  const rows = await db.select().from(ipdClassChanges).where(eq(ipdClassChanges.admissionId, admissionId)).orderBy(asc(ipdClassChanges.effectiveFrom));
  return rows.filter((r) => r.status === "active").map((r) => ({ stayId: r.stayId, toClass: r.toClass as IpdBedClass, effectiveFrom: r.effectiveFrom }));
}
