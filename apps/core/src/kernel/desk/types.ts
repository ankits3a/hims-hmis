import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 07c T1 — THE DESK: WHAT A PERSON IS FOR TODAY, NOT WHICH MODULE THEY ARE IN.
 *
 * `/` redirected every authenticated user — doctor, cashier, administrator alike — to the patient
 * registration desk. There was no home, and role decided only which menu links were hidden. This is
 * the seam that replaces it, and it is deliberately the manifest's THIRD use of a shape it already
 * has: `search` and `resourceKinds` are both declared per module and collected at boot with a
 * refusal on a permission no manifest declares. A fourth pattern would be a fourth thing to learn.
 *
 * ═══ CARDS ARE COMPOSED FROM PERMISSIONS, NEVER SELECTED BY ROLE ═══
 *
 * Roles combine — the counter clerk this work began with holds registration, appointments and
 * billing at once. A role-selected dashboard needs designing again for every combination and is
 * still wrong for the fourth, so the desk renders the UNION of what the caller may do. It is the
 * same projection `NAV.filter(can)` already applies to the navigation, moved one level in.
 *
 * ═══ A PROVIDER OWNS ITS OWN ALIASING ═══
 *
 * `DeskRow.title` is DATA — usually a patient's name — not a translation key, and the desk is a
 * surface a visitor reads over somebody's shoulder. A provider that puts identity in a row is
 * responsible for putting the ALIAS there for a restricted patient, exactly as every queue and desk
 * surface already does through `getPatientSummaries`. The kernel cannot do it for them: it does not
 * know which field of which row is a name.
 */
export type DeskBand = "now" | "today";

/** One figure. `compare` is the baseline it means nothing without — see the card's own doc. */
export type DeskStat = {
  key: string;
  /** Pre-formatted for display. The server owns the arithmetic; the client owns the layout. */
  value: string;
  /** "median 41", "prior ₹2.61L" — omitted when no honest baseline exists yet (07c DD8). */
  compare?: string | null;
  tone?: "up" | "down" | "flat";
};

/** One thing that needs a person. Rows are the work; stats are the pulse. */
export type DeskRow = {
  id: string;
  /** A token number, a counter number, "!" for a signal — short enough to sit in a gutter. */
  badge?: string | null;
  /** DATA, and the provider aliases it for a restricted patient (see the header). */
  title: string;
  subtitle: string;
  /** What this row's action is called. The client renders it; the server names it. */
  action?: string | null;
  /** Where the action goes, as an app path. Null when the row is informational. */
  href?: string | null;
  severity?: "hot" | "warn" | null;
};

export type DeskCard = {
  /** Stable `<module>.<card>` key. Appears in the response and in the client's ordering. */
  key: string;
  band: DeskBand;
  /** An i18n KEY, unlike the rows — a card's heading is chrome, not data. */
  titleKey: string;
  rows?: DeskRow[];
  stats?: DeskStat[];
};

export type DeskProviderCtx = {
  db: Db;
  actor: Actor;
  /** The IST day the desk is being read for. Today, unless the caller asked for another. */
  date: string;
  now: Date;
};

/**
 * PLAN 07c T2 — one section of a person's daily report.
 *
 * Everything is a STRING, and that is a decision rather than laziness: the CSV is strings, the
 * printed slip is strings, and the screen renders strings. Formatting money or a duration in three
 * places is three places to round it differently, so the SERVER owns the arithmetic AND its
 * presentation, exactly as `DeskStat.value` already does.
 */
export type ReportSection = {
  key: string;
  /** An i18n key — a section heading is chrome (see `DeskCard.titleKey`). */
  titleKey: string;
  /** Column headings, as i18n keys. */
  columnKeys: string[];
  /** The rows. A provider that puts a patient's name here aliases it (see this file's header). */
  rows: string[][];
  /** A totals row, aligned to `columnKeys`, or omitted where a total means nothing. */
  totals?: string[];
};

export type DeskProvider = {
  key: string;
  /** Must be a string some manifest declares — `collectDeskProviders` refuses anything else. */
  permission: string;
  load(ctx: DeskProviderCtx): Promise<DeskCard[]>;
  /**
   * PLAN 07c T2 — this provider's contribution to the person's DAILY REPORT, if it has one.
   *
   * It rides the SAME declaration as the card rather than a parallel registry, because a report is
   * the same facts at a different grain: the card says "46 visits", the report lists them. A second
   * seam would be a second thing to register, a second thing to gate, and a second place for the two
   * to disagree about which permission guards the module.
   */
  report?(ctx: DeskProviderCtx): Promise<ReportSection[]>;
};

export class DeskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DeskError";
  }
}
