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
  /**
   * PLAN 07c T4 — WHERE THE ROWS BEHIND THIS FIGURE ARE, as an app path.
   *
   * A number with nothing behind it is decoration, and DD1's whole argument for composing a desk
   * from permissions is that the desk is a place you LAUNCH from. "12 waiting" that cannot be
   * opened tells a clerk something they will now go and find somewhere else — which is the three
   * route changes per patient this plan series exists to remove. A stat may legitimately have no
   * drill (a ratio, a session count), and `null` says so rather than a dead link saying it badly.
   */
  href?: string | null;
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
  /**
   * PLAN 07c T4 / DD11 — THE REALTIME TOPICS THAT MAKE THIS CARD STALE, declared by the module
   * that owns the card because the kernel cannot know them.
   *
   * The desk is a "now" surface at a counter, and a home screen that shows a number frozen at the
   * moment it was opened is worse than one that shows nothing: nobody distrusts it. The module
   * already knows which topics its own events land on — OPD's are `queue:<doctorId>:<date>` — so
   * it names them here and the client subscribes to the union and refetches.
   *
   * A topic named here must be one the CALLER may subscribe to. That is not a check this seam
   * makes: the gateway refuses a topic whose space the caller lacks the permission for, and the
   * card's own `permission` is what already decided whether this provider ran at all. A provider
   * naming a topic outside its own space would produce a `forbidden_topic` frame and a card that
   * never refreshes — visible in the browser console, and the reason a provider should name only
   * topics from the space its own module declares.
   */
  topics?: string[];
};

export type DeskProviderCtx = {
  db: Db;
  /**
   * WHOSE DAY THIS IS. Every provider filters its own tables on `actor.id` — `opened_by`,
   * `received_by`, `recorded_by` — so this is the SUBJECT of the report, not necessarily the
   * person asking for it.
   */
  actor: Actor;
  /**
   * PLAN 07c T9 / DD14 — WHO IS LOOKING, which is the same person for every self-scoped call and a
   * DIFFERENT one for a supervisor's drill.
   *
   * ═══ WHY THESE CANNOT BE ONE FIELD, AND THE LEAK THAT PROVES IT ═══
   *
   * A provider that lists patients reads them through `getPatientSummaries(db, actor, ids)`, and
   * that actor is what decides whether a confidential, VIP or staff-as-patient row comes back as a
   * name or as an alias. For a self-scoped report the two roles coincide and the question never
   * arises.
   *
   * For a supervisor's drill they come apart: the ROWS belong to the clerk (so the filter must use
   * the clerk's id) and the VISIBILITY belongs to the supervisor (so the aliasing must use the
   * supervisor's permissions). Collapse them into one field and the supervisor inherits the CLERK's
   * confidentiality clearance — a supervisor who may not open a sealed record would read that
   * patient's real name off a drill, because the clerk who registered them could. That is a leak
   * created by a convenience, and it is invisible in every test where one person plays both roles.
   *
   * So: filter on `actor`, alias on `reader`. `loadDesk`, `loadReport` and `liveFactsFor` set them
   * equal; only the staff drill sets them apart.
   */
  reader: Actor;
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
  /**
   * PLAN 07c T8 — THIS MODULE'S CONTRIBUTION TO ONE PERSON'S DAY, AS NAMED NUMBERS.
   *
   * The card is a picture of now and the report is a list of rows; FACTS are the same day reduced
   * to counters that can be SUMMED ACROSS DAYS. That is what a five-period brief needs and what
   * neither of the other two shapes can give: you cannot add up six months of card renderings.
   *
   * ═══ WHY A BAG OF NAMED NUMBERS AND NOT A TABLE OF COLUMNS ═══
   *
   * The obvious design is a `user_day_facts` table with a column per counter. It is also the design
   * that makes every new module a MIGRATION and a schema review: pharmacy dispensing, lab
   * collections, theatre cases. Worse, it puts the kernel in the position of knowing what a
   * "consult" is. A module returns `{ "opd.visitsOpened": 46 }` and the rollup stores the bag; the
   * kernel adds numbers and never learns what they mean.
   *
   * ═══ THE CONTRACT, AND IT IS NARROW ON PURPOSE ═══
   *
   * - Keys are `<module>.<fact>` and STABLE — they are stored, so renaming one orphans the history
   *   that was written under the old name. A key is a schema decision wearing a string's clothes.
   * - Values are finite, non-negative integers. Money is PAISE, never rupees and never a float:
   *   the rollup sums them and a float sum of six months of money is a rounding argument nobody
   *   can win. `rollupUserDay` refuses anything else rather than storing it.
   * - The same `(actor, date)` must always produce the same bag. A fact derived from "now" rather
   *   than from the day would make yesterday's rollup and today's re-roll disagree, which is A5's
   *   whole subject.
   */
  facts?(ctx: DeskProviderCtx): Promise<Record<string, number>>;
};

export class DeskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DeskError";
  }
}
