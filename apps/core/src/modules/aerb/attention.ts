import { istDayString } from "../../kernel/approvals/cumulative";
import { badgeReads, badgeRegister } from "./badges";
import { qaDueList } from "./qa";
import { pregnancyDeclarations } from "./pregnancy";
import { incidentRegister } from "./incidents";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 18-S RS11 — **THE RSO'S ONE LIST ("Needs you").**
 *
 * The station's right-hand column (owner layout rule: ONE list, no filter tabs). Every row names the
 * thing, why it is here, and the view that fixes it. It is also the source list RS10's HOD
 * escalations read, so there is one answer to "what is wrong in radiation safety" and not two.
 *
 * Red: a machine blocked for QA, an incident whose AERB notification is overdue, a worker over a
 * statutory limit, a declared-pregnant worker at the foetal limit. Amber: everything else that waits
 * on the RSO — QA due within 30 days, an open incident, an investigation-level read, an active
 * pregnancy declaration (reassign or restrict her ionising work).
 */
export type AttentionView = "qa" | "incidents" | "badges" | "pregnancy";

export interface AttentionRow {
  key: string;
  severity: "red" | "amber";
  view: AttentionView;
  subject: string;
  detail: string;
  /** The row's own id in its register (device, incident, badge, declaration). */
  ref: string;
}

/** Investigation-level reads stay on the list for this many days after the report arrived. */
const RECENT_READ_DAYS = 90;

export async function attentionList(db: Db, actor: Actor, opts: { now?: Date } = {}): Promise<AttentionRow[]> {
  const now = opts.now ?? new Date();
  const asOf = istDayString(now);
  const rows: AttentionRow[] = [];

  for (const q of await qaDueList(db, { onDate: asOf })) {
    if (q.state === "ok") continue;
    const blocked = q.deviceStatus === "qa_blocked";
    rows.push({
      key: `qa:${q.deviceResourceId}:${q.qaType}`,
      severity: blocked || q.state === "overdue" || q.state === "failed" ? "red" : "amber",
      view: "qa",
      subject: `${q.deviceCode} — ${q.deviceName}`,
      detail: q.state === "failed"
        ? `${q.qaType} failed on ${q.lastPerformedOn}${blocked ? " · qa_blocked until a passing retest" : ""}`
        : q.state === "overdue"
          ? `${q.qaType} overdue since ${q.dueOn}${blocked ? " · qa_blocked until a passing QA" : " · blocks at the next hourly check"}`
          : `${q.qaType} due ${q.dueOn}`,
      ref: q.deviceResourceId,
    });
  }

  const incidents = await incidentRegister(db, actor, { now });
  for (const i of incidents.rows) {
    if (i.state === "closed") continue;
    rows.push({
      key: `incident:${i.id}`,
      severity: i.notifyOverdue ? "red" : "amber",
      view: "incidents",
      subject: `${i.incidentNo} · ${i.affectedLabel}`,
      detail: i.notifyOverdue
        ? "AERB notification overdue — record the date and reference"
        : i.notifyRequired && i.notifiedOn === null
          ? "notify AERB within 24 hours"
          : i.state === "open" ? "open — root cause and corrective actions" : "investigated — actions to close",
      ref: i.id,
    });
  }

  for (const b of await badgeRegister(db, { onDate: asOf })) {
    if (b.overAnnualLimit || b.overFiveYearLimit) {
      rows.push({
        key: `limit:${b.userId}`,
        severity: "red",
        view: "badges",
        subject: `${b.userName} · ${b.badgeNo}`,
        detail: b.overAnnualLimit
          ? `${b.worstYearMsv} mSv in ${b.worstYear ?? ""} — over the 30 mSv single-year limit; record an incident and notify AERB`
          : `${b.workerFiveYearMsv} mSv over five years — over the 100 mSv limit`,
        ref: b.badgeId,
      });
    }
  }
  const since = new Date(now.getTime() - RECENT_READ_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const r of await badgeReads(db)) {
    if (!r.investigationFlag || r.reportedOn < since) continue;
    rows.push({
      key: `read:${r.id}`,
      severity: "amber",
      view: "badges",
      subject: `${r.userName} · ${r.badgeNo}`,
      detail: `${r.hp10Msv} mSv for ${r.periodStart}..${r.periodEnd} — at or over the investigation level ${r.investigationLevelMsv ?? ""} mSv`,
      ref: r.badgeId,
    });
  }

  for (const d of await pregnancyDeclarations(db, { onDate: asOf, activeOnly: true })) {
    rows.push({
      key: `pregnancy:${d.id}`,
      severity: d.overFoetalLimit ? "red" : "amber",
      view: "pregnancy",
      subject: d.userName,
      detail: d.lapsed
        ? `expected date ${d.expectedOn} has passed — end the declaration`
        : d.overFoetalLimit
          ? `${d.foetalDoseMsv} mSv since ${d.declaredOn} — at the 1 mSv foetal limit; off ionising work`
          : `declared pregnant worker — reassign or restrict her ionising work (${d.foetalDoseMsv} of 1 mSv since ${d.declaredOn})`,
      ref: d.id,
    });
  }

  return rows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1));
}
