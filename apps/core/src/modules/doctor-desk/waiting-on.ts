import { ATTENTION_TAB_OF } from "@hmis/contracts";
import type { Actor, AttentionKind, WireAttentionRow } from "@hmis/contracts";
import { closedCriticalsForClinician, deltaResultsForClinician, openCriticalsForClinician } from "../lab";
import { actedKeys, OWED_ALERT_DAYS } from "./owed";
import { unreadReportsForClinician } from "../radiology";
import { closedVisitNos, openVisitsForDoctor } from "../opd";
import { getPatientSummaries } from "../patients";
import { patientOf } from "./scope";
import type { Db } from "../../kernel/db/client";

/**
 * DD-0.2 — `waitingOn`: WHAT IS WAITING ON THIS DOCTOR, as rows, each with the record it came from.
 *
 * Four sources, each read through its own module's `index.ts` and keyed on the doctor as the
 * RESPONSIBLE clinician (never the login that typed the order):
 *   (a) lab critical calls still open on my orders            → Critical
 *   (b) imaging: an unacknowledged critical finding            → Critical
 *       imaging: a released report nobody has opened yet      → Pending
 *   (c) my visits from earlier days still not completed        → Pending ("papers to sign")
 *   (d) a critical on a visit that is over                      → the same row, `goneHome: true`
 *   + lab results the lab's delta check flagged, last 24 h     → Clinical change (plan D-D)
 *
 * A row disappears when its source closes it (the call is closed, the report is opened, the visit is
 * completed) — there is no copy here to go stale. ONE SOURCE FAILING LOSES ITS OWN ROWS, never the
 * list: the same bargain as the morning card (`kernel/desk/waiting.ts`), because a Tower that blanks
 * on a radiology error tells a doctor nothing is waiting, which is the one wrong answer.
 */
export const DELTA_WINDOW_HOURS = 24;

type Raw = Omit<WireAttentionRow, "patient" | "tab"> & { patientId: string };

async function safely<T>(f: () => Promise<T[]>): Promise<T[]> {
  try { return await f(); } catch { return []; }
}

const RANK: Record<AttentionKind, number> = { lab_critical: 0, imaging_critical: 1, lab_delta: 2, imaging_unread: 3, visit_open: 4 };

export async function waitingOn(db: Db, actor: Actor, at: Date, istDate: string): Promise<WireAttentionRow[]> {
  const me = actor.id;
  const [openCrit, closedCrit, imaging, deltas, visits] = await Promise.all([
    safely(() => openCriticalsForClinician(db, [me])),
    safely(() => closedCriticalsForClinician(db, [me], new Date(at.getTime() - OWED_ALERT_DAYS * 86_400_000))),
    safely(() => unreadReportsForClinician(db, me)),
    safely(() => deltaResultsForClinician(db, [me], new Date(at.getTime() - DELTA_WINDOW_HOURS * 3_600_000))),
    safely(() => openVisitsForDoctor(db, me, istDate)),
  ]);
  // DD-1.3 (D3) — an open call is red; a call the lab closed with no act recorded stays, amber; an act removes both.
  const acted = await actedKeys(db, [...openCrit, ...closedCrit].map((c) => `lab_critical:${c.id}`)).catch(() => new Set<string>());
  const crit = [...openCrit.map((c) => ({ ...c, acked: false })), ...closedCrit.map((c) => ({ ...c, acked: true }))]
    .filter((c) => !acted.has(`lab_critical:${c.id}`));
  const gone = await closedVisitNos(db, [...crit.map((c) => c.encounterNo), ...imaging.filter((i) => i.critical).map((i) => i.encounterNo)]).catch(() => new Set<string>());

  const raw: Raw[] = [
    ...crit.map((c): Raw => ({
      key: `lab_critical:${c.id}`, kind: "lab_critical", patientId: c.patientId,
      params: { analyte: c.analyte, value: c.value ?? "", unit: c.unit ?? "" },
      at: c.at.toISOString(), goneHome: gone.has(c.encounterNo),
      source: { module: "lab", ref: c.resultId }, href: `/patients/${c.patientId}`,
      ...(c.acked ? { acked: true } : {}),
    })),
    ...imaging.map((i): Raw => ({
      key: `${i.critical ? "imaging_critical" : "imaging_unread"}:${i.reportId}`, kind: i.critical ? "imaging_critical" : "imaging_unread",
      patientId: i.patientId, params: { study: i.study }, at: i.at.toISOString(),
      goneHome: i.critical && gone.has(i.encounterNo),
      source: { module: "radiology", ref: i.reportId }, href: "/opd/consult",
    })),
    ...deltas.map((d): Raw => ({
      key: `lab_delta:${d.id}`, kind: "lab_delta", patientId: d.patientId,
      params: { analyte: d.analyte, value: d.value ?? "", unit: d.unit ?? "" },
      at: d.at.toISOString(), goneHome: false,
      source: { module: "lab", ref: d.resultId }, href: `/patients/${d.patientId}`,
    })),
    ...visits.map((v): Raw => ({
      key: `visit_open:${v.encounterId}`, kind: "visit_open", patientId: v.patientId,
      params: { date: v.serviceDate, visitNo: v.visitNo }, at: (v.startedAt ?? new Date(`${v.serviceDate}T09:00:00+05:30`)).toISOString(),
      goneHome: false, source: { module: "opd", ref: v.encounterId }, href: `/opd/consult/${v.encounterId}`,
    })),
  ];
  const summaries = await getPatientSummaries(db, actor, raw.map((r) => r.patientId));
  const byId = new Map(summaries.map((s) => [s.requestedId, s] as const));
  return raw
    .map(({ patientId, ...r }): WireAttentionRow => {
      return { ...r, tab: ATTENTION_TAB_OF[r.kind], patient: patientOf(byId.get(patientId), patientId) };
    })
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.at.localeCompare(b.at));
}
