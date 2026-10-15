import {
  addDayIso, istDayOf, ownerRange, percentChange,
  type DayRange, type DrawerState, type OwnerAppointments, type OwnerLearning, type OwnerMoney, type OwnerPeriod, type OwnerPharmacy, type StaffToday,
} from "../../../../packages/contracts/src/owner-app";
import { onRecord } from "../../../../packages/contracts/src/recording";
import { minutesShown, type FlowReport } from "../../../../packages/contracts/src/flow";
import type { RecordingReport } from "../../../../packages/contracts/src/recording";

export * from "../../../../packages/contracts/src/owner-app";
export * from "../../../../packages/contracts/src/flow";

/**
 * THE OWNER'S HOME AS TILES (owner, 2026-10-09: "Home as seven tiles (drawn)" · "Medical Superintendent
 * too but Money page for owner alone"). Pure: what each tile says, worked out from one read per tile.
 *
 * WHO. The tile home is for a login that holds ALL of the hospital's figures, its long history, the
 * OPD report and the roster — together only the owner's and the Medical Superintendent's roles do
 * (a front-office supervisor reads the figures for a year and keeps the home it had). MONEY is one
 * permission more — the day book's (`billing.reports.read`) — which the Medical Superintendent's role
 * has never held. Nothing here is offered to a doctor or a cashier: `ownerTilesFor` gives them null.
 *
 * Words never live here: a label is an i18n KEY; a number is a string the server's integers made.
 */
export type OwnerTileKey = "money" | "opd" | "wait" | "recorded" | "appointments" | "pharmacy" | "staff" | "learning";
/** Owner 2026-10-09: "Wait" is the eighth — how long patients wait from the desk to the doctor, today. */
export const OWNER_TILE_ORDER: readonly OwnerTileKey[] = ["money", "opd", "wait", "recorded", "appointments", "pharmacy", "staff", "learning"];

/**
 * THE GRID STAYS EVEN: two columns; when the tiles are an odd number (the Medical Superintendent has no
 * Money) the last one, Learning, runs the full width. The owner's eight are four even rows.
 */
export function isWideTile(key: string, keys: readonly string[]): boolean {
  return key === "learning" && keys.length % 2 === 1;
}
const HOSPITAL_WIDE = ["staff.reports.read", "staff.reports.history.full", "opd.reports.read", "roster.read"] as const;
export const MONEY_PERMISSION = "billing.reports.read";

export function ownerTilesFor(permissions: readonly string[]): OwnerTileKey[] | null {
  if (!HOSPITAL_WIDE.every((p) => permissions.includes(p))) return null;
  return OWNER_TILE_ORDER.filter((k) => k !== "money" || permissions.includes(MONEY_PERMISSION));
}

/** One read per tile. `null` — the read failed; `undefined` — not asked (the tile is not this person's). */
export type OwnerReads = {
  money?: OwnerMoney | null;
  /** Visits opened today and on the same weekday last week. */
  opd?: { today: number; lastWeek: number } | null;
  recorded?: RecordingReport | null;
  appointments?: OwnerAppointments | null;
  pharmacy?: OwnerPharmacy | null;
  staff?: StaffToday | null;
  learning?: OwnerLearning | null;
  /** Today's waits (`/opd/reports/flow?period=today`). */
  wait?: FlowReport | null;
};

export type TileTone = "up" | "down" | "warn" | "plain";
/** `sub` is a ready comparison ("▲ 12%") or an i18n key with its parts — never both. */
export type OwnerTile = {
  key: OwnerTileKey; labelKey: string;
  /** "—" when the read failed. */
  value: string; failed: boolean;
  sub: { text: string } | { key: string; vars?: Record<string, string | number> } | null;
  tone: TileTone;
  wide: boolean;
};

/** "₹14,300"; from a lakh up "₹1.42 L", from a crore "₹1.2 Cr" — a tile holds seven characters. */
export function rupeesShort(paise: number): string {
  const r = Math.round(paise / 100);
  const a = Math.abs(r);
  const sign = r < 0 ? "−" : "";
  if (a >= 10_000_000) return `${sign}₹${(a / 10_000_000).toFixed(2).replace(/\.?0+$/, "")} Cr`;
  if (a >= 100_000) return `${sign}₹${(a / 100_000).toFixed(2).replace(/\.?0+$/, "")} L`;
  return `${sign}₹${a.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** "▲ 12%" / "▼ 4%" / "▲ 0%"; null with nothing to compare against. */
export function arrowPercent(now: number, before: number | null | undefined): { text: string; tone: TileTone } | null {
  const pct = percentChange(now, before);
  if (pct === null) return null;
  return { text: `${pct >= 0 ? "▲" : "▼"} ${String(Math.abs(pct))}%`, tone: pct >= 0 ? "up" : "down" };
}
/** "▲ 6" / "▼ 3" — a difference in heads, for a count small enough that a percent misleads. */
export function arrowCount(now: number, before: number | null | undefined): { text: string; tone: TileTone } | null {
  if (before === null || before === undefined) return null;
  const d = now - before;
  return { text: `${d >= 0 ? "▲" : "▼"} ${String(Math.abs(d))}`, tone: d >= 0 ? "up" : "down" };
}

const FAILED = "—";

export function buildOwnerTiles(keys: readonly OwnerTileKey[], r: OwnerReads): OwnerTile[] {
  return keys.map((key): OwnerTile => {
    const base = { key, labelKey: `owner.tile.${key}`, wide: isWideTile(key, keys) };
    const failed: OwnerTile = { ...base, value: FAILED, failed: true, sub: null, tone: "plain" };
    if (key === "money") {
      const m = r.money;
      if (m == null) return failed;
      const cmp = arrowPercent(m.collectedPaise, m.previous?.collectedPaise);
      return { ...base, value: rupeesShort(m.collectedPaise), failed: false, sub: cmp === null ? null : { text: cmp.text }, tone: cmp?.tone ?? "plain" };
    }
    if (key === "opd") {
      const o = r.opd;
      if (o == null) return failed;
      const cmp = arrowCount(o.today, o.lastWeek);
      return { ...base, value: String(o.today), failed: false, sub: cmp === null ? null : { text: cmp.text }, tone: cmp?.tone ?? "plain" };
    }
    if (key === "recorded") {
      const c = r.recorded?.totals;
      if (c == null) return failed;
      return {
        ...base, value: `${String(onRecord(c))} / ${String(c.consulted)}`, failed: false,
        sub: c.consulted === 0 ? { key: "owner.sub.noneYet" } : c.notRecorded > 0 ? { key: "owner.sub.missing", vars: { n: c.notRecorded } } : { key: "owner.sub.allIn" },
        tone: c.notRecorded > 0 ? "warn" : "plain",
      };
    }
    if (key === "appointments") {
      const a = r.appointments;
      if (a == null) return failed;
      if (a.needRebooking > 0) return { ...base, value: String(a.total), failed: false, sub: { key: "owner.sub.rebook", vars: { n: a.needRebooking } }, tone: "warn" };
      const cmp = arrowCount(a.total, a.previous?.total);
      return { ...base, value: String(a.total), failed: false, sub: cmp === null ? null : { text: cmp.text }, tone: cmp?.tone ?? "plain" };
    }
    if (key === "pharmacy") {
      const p = r.pharmacy;
      if (p == null) return failed;
      const value = p.salesPaise === null ? String(p.bills) : rupeesShort(p.salesPaise);
      if (p.stock !== null && p.stock.low > 0) return { ...base, value, failed: false, sub: { key: "owner.sub.lowStock", vars: { n: p.stock.low } }, tone: "warn" };
      const cmp = p.salesPaise === null ? arrowCount(p.bills, p.previous?.bills) : arrowPercent(p.salesPaise, p.previous?.salesPaise);
      return {
        ...base, value, failed: false,
        sub: cmp === null ? (p.salesPaise === null ? { key: "owner.sub.bills" } : null) : { text: cmp.text }, tone: cmp?.tone ?? "plain",
      };
    }
    if (key === "staff") {
      const s = r.staff;
      if (s == null) return failed;
      const sub = s.gaps.length > 0 ? { key: s.gaps.length === 1 ? "owner.sub.gap" : "owner.sub.gaps", vars: { n: s.gaps.length } }
        : s.onLeave.length > 0 ? { key: "owner.sub.onLeave", vars: { n: s.onLeave.length } } : { key: "owner.sub.onDuty" };
      return { ...base, value: String(s.onDuty), failed: false, sub, tone: s.gaps.length > 0 ? "warn" : "plain" };
    }
    if (key === "wait") {
      const w = r.wait;
      if (w == null) return failed;
      /* Desk → doctor Avg today, whole minutes; "—" under the floor. Waits are told in neutral colour. */
      const now = w.hospital.deskToDoctor.avg;
      const before = w.previous?.deskToDoctor.avg ?? null;
      const value = minutesShown(now) ?? "—";
      if (w.findings.length > 0) return { ...base, value, failed: false, sub: { key: "owner.sub.toFix", vars: { n: w.findings.length } }, tone: "plain" };
      if (now === null || before === null) return { ...base, value, failed: false, sub: null, tone: "plain" };
      const d = Math.round(now) - Math.round(before);
      return { ...base, value, failed: false, sub: { key: d >= 0 ? "owner.sub.waitUp" : "owner.sub.waitDown", vars: { n: Math.abs(d) } }, tone: "plain" };
    }
    const l = r.learning;
    if (l == null) return failed;
    return { ...base, value: String(l.nicknames.length), failed: false, sub: { key: l.on ? "owner.sub.nicknames" : "owner.sub.learningOff" }, tone: "plain" };
  });
}

/** What the phone keeps of the tiles across a closed app: a key and its number. No sub-line, no name. */
export type ColdOwnerTile = { key: OwnerTileKey; labelKey: string; value: string };
export function coldOwnerTiles(tiles: readonly OwnerTile[]): ColdOwnerTile[] {
  return tiles.map((t) => ({ key: t.key, labelKey: t.labelKey, value: t.value }));
}

/* ═══ a page's period ═══ */

export type PageRange = DayRange & { compare: DayRange | null };
export function pageRange(period: OwnerPeriod, nowMs: number, custom?: Partial<DayRange> | null): PageRange | null {
  return ownerRange(period, istDayOf(nowMs), custom);
}
/** `from=…&to=…` and, when there is one, `&cfrom=…&cto=…`. */
export function rangeQuery(r: PageRange, withCompare = true): string {
  return `from=${r.from}&to=${r.to}${withCompare && r.compare !== null ? `&cfrom=${r.compare.from}&cto=${r.compare.to}` : ""}`;
}
/** The words after the arrow, by period. Custom compares with nothing. */
export function compareKey(period: OwnerPeriod): string | null {
  return period === "custom" ? null : `owner.vs.${period}`;
}
export function tileDayQuery(nowMs: number): string {
  const today = istDayOf(nowMs);
  return `from=${today}&to=${today}&cfrom=${addDayIso(today, -7)}&cto=${addDayIso(today, -7)}`;
}

/** "open · not counted" / "counted · exact" / "counted · short ₹120" / "counted · excess ₹50". */
export function drawerWords(state: DrawerState, variancePaise: number | null): { key: string; vars?: Record<string, string> } {
  if (state === "open") return { key: "owner.money.drawer.open" };
  if (state === "exact") return { key: "owner.money.drawer.exact" };
  return { key: `owner.money.drawer.${state}`, vars: { amount: rupeesShort(Math.abs(variancePaise ?? 0)) } };
}

export const LIST_CAP = 12;
/** "10 Oct" from an IST day, without `Intl`. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;
export function dayMonthParts(day: string): { d: number; monthKey: string } {
  return { d: Number(day.slice(8, 10)), monthKey: `owner.month.${MONTHS[Number(day.slice(5, 7)) - 1] ?? "jan"}` };
}
