/**
 * "IS TODAY BEING RECORDED?" — the wire shape and the two readings every screen makes of it (owner,
 * 2026-10-07: "Yes, show a daily count on the screens."). Pure TypeScript with no imports, like
 * `app-home.ts`: the web reads it by path and so does the phone, outside the pnpm workspace.
 *
 * The server (`apps/core/src/modules/opd/recording.ts`) owns what each figure counts. In one line:
 * a consultation is ON RECORD when its slip was photographed, its paper was typed by the desk, or the
 * doctor issued the prescription in the system; `notRecorded` is a consultation with none of the three.
 */
export type RecordingCounts = {
  opened: number; consulted: number; onScreen: number; onPaper: number; photographed: number;
  typed: number; issued: number; issuedLines: number; toType: number; notRecorded: number; stillOpen: number;
};
export type RecordingRow = RecordingCounts & { id: string; name: string };
export type RecordingDay = RecordingCounts & { date: string };
export type RecordingReport = {
  from: string; to: string; period: "day" | "week" | "month"; anchor: string;
  scope: "hospital" | "mine" | "none";
  totals: RecordingCounts | null;
  mine: RecordingCounts | null;
  days: RecordingDay[];
  departments: RecordingRow[] | null;
  doctors: RecordingRow[] | null;
};

/** Consultations whose prescription is on some record. */
export function onRecord(c: RecordingCounts): number {
  return Math.max(0, c.consulted - c.notRecorded);
}

/** 0–100, whole. Nothing consulted yet is not 0% — it is "nothing to record", which the caller says in words. */
export function recordedPercent(c: RecordingCounts): number | null {
  return c.consulted === 0 ? null : Math.round((onRecord(c) / c.consulted) * 100);
}

/** The word a card leads with — never colour alone. */
export type RecordingState = "nothing_yet" | "all" | "some" | "none";
export function recordingState(c: RecordingCounts): RecordingState {
  if (c.consulted === 0) return "nothing_yet";
  if (c.notRecorded === 0) return "all";
  return c.notRecorded === c.consulted ? "none" : "some";
}
