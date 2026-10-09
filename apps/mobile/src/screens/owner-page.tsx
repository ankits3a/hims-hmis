import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useI18n } from "../i18n";
import { seatsFor } from "../seats";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, Button, MONO, Note } from "../ui";
import { rosterApi } from "../roster/api";
import { onRecord, recordedPercent } from "../../../../packages/contracts/src/recording";
import type { RecordingCounts, RecordingReport } from "../../../../packages/contracts/src/recording";
import type { WireOnNowBoard } from "../roster/rules";
import {
  arrowCount, arrowPercent, compareKey, dayMonthParts, drawerWords, istDayOf, LIST_CAP, MONEY_PERMISSION, OWNER_PERIODS, pageRange,
  rangeProblem, rangeQuery, rupeesShort,
  type LearningNickname, type OwnerAppointments, type OwnerLearning, type OwnerMoney, type OwnerPeriod, type OwnerPharmacy, type OwnerTileKey,
  type PageRange, type StaffToday, type TileTone,
} from "../owner/model";

/**
 * A PAGE BEHIND ONE OF THE OWNER'S TILES (owner 2026-10-09, board frames 2–7). One screen, seven
 * bodies. Money, OPD, Recorded, Appointments and Pharmacy carry Today | Week | Month | Custom and a
 * comparison under the headline; Staff is today's and Learning is this week's, as the board drew them.
 *
 * Every line is one line at 360 px: a label on the left, a figure on the right. Lists stop at twelve
 * with "See all". A read that failed says so and offers to try again — never a zero in its place.
 * The clock is handed in (`now`), so a test never depends on the day it runs.
 */
type T = (key: string, vars?: Record<string, string | number>) => string;
const WITH_PERIOD: readonly OwnerTileKey[] = ["money", "opd", "recorded", "appointments", "pharmacy"];
const TONE: Record<TileTone, string> = { up: color.green, down: color.red, warn: "#8a5a10", plain: color.dim };
const VISITS = "opd.visitsOpened";
type StaffRange = { rows: { key: Record<string, string | undefined>; measures: Record<string, number> }[] };
type OpdData = { departments: { name: string; value: number }[]; total: number; before: number | null; onNow: WireOnNowBoard | null };
type RecordedData = { now: RecordingReport; before: RecordingReport | null };
type Data =
  | { page: "money"; d: OwnerMoney } | { page: "opd"; d: OpdData } | { page: "recorded"; d: RecordedData }
  | { page: "appointments"; d: OwnerAppointments } | { page: "pharmacy"; d: OwnerPharmacy }
  | { page: "staff"; d: StaffToday } | { page: "learning"; d: OwnerLearning };

const card = { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.xs } as const;
const hhmm = (iso: string): string => new Date(new Date(iso).getTime() + 5.5 * 3_600_000).toISOString().slice(11, 16);

function Row({ label, value, sub, tone = "plain", testID, first, onPress }: {
  label: string; value?: string; sub?: string | null; tone?: TileTone; testID?: string; first?: boolean; onPress?: () => void;
}) {
  const body = (
    <View testID={onPress === undefined ? testID : undefined} style={{ paddingVertical: 9, borderTopWidth: first === true ? 0 : 1, borderTopColor: color.line2 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
        <Text style={{ fontSize: 14, color: color.ink, flex: 1 }} numberOfLines={1}>{label}</Text>
        {value !== undefined && <Text style={{ fontFamily: MONO, fontSize: 14, fontWeight: "700", color: color.ink }} numberOfLines={1}>{value}</Text>}
        {onPress !== undefined && <Text style={{ color: color.faint, fontSize: 16 }}>›</Text>}
      </View>
      {sub != null && sub !== "" && <Text style={{ fontSize: 12, color: TONE[tone], marginTop: 1 }} numberOfLines={1}>{sub}</Text>}
    </View>
  );
  return onPress === undefined ? body : <Pressable testID={testID} accessibilityRole="button" onPress={onPress}>{body}</Pressable>;
}

function Bar({ part, of, red }: { part: number; of: number; red?: boolean }) {
  const pct = of <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((part / of) * 100)));
  return (
    <View style={{ height: 5, borderRadius: 3, backgroundColor: color.wash, marginBottom: 8 }}>
      <View style={{ height: 5, borderRadius: 3, backgroundColor: red === true ? color.red : color.green, width: `${pct}%` as `${number}%` }} />
    </View>
  );
}

function Section({ title, right, children, testID }: { title?: string; right?: string; children: ReactNode; testID?: string }) {
  return (
    <View testID={testID} style={card}>
      {title !== undefined && (
        <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 8, paddingBottom: 2 }}>
          <Text style={[type.tag, { color: color.faint, fontFamily: MONO }]} numberOfLines={1}>{title}</Text>
          {right !== undefined && <Text style={{ fontSize: 12, color: color.dim }} numberOfLines={1}>{right}</Text>}
        </View>
      )}
      {children}
    </View>
  );
}

/** The first twelve, then "See all (n)". */
function Capped<X>({ items, render, t, testID }: { items: readonly X[]; render: (x: X, i: number) => ReactNode; t: T; testID: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, LIST_CAP);
  return (
    <>
      {shown.map(render)}
      {items.length > LIST_CAP && (
        <Pressable testID={`${testID}-all`} accessibilityRole="button" onPress={() => setAll((v) => !v)} style={{ minHeight: 40, justifyContent: "center", borderTopWidth: 1, borderTopColor: color.line2 }}>
          <Text style={{ color: color.green, fontSize: 13, fontWeight: "700" }} numberOfLines={1}>{all ? t("home.fewer") : t("home.all", { n: items.length })}</Text>
        </Pressable>
      )}
    </>
  );
}

/** The headline: a label, one figure, and the comparison under it. */
function Head({ label, value, compare, vs, t }: { label: string; value: string; compare: { text: string; tone: TileTone } | null; vs: string | null; t: T }) {
  return (
    <View testID="owner-head" style={[card, { paddingVertical: space.md }]}>
      <Text style={{ fontSize: 13, color: color.dim }} numberOfLines={1}>{label}</Text>
      <Text testID="owner-head-value" style={{ fontFamily: MONO, fontSize: 30, lineHeight: 36, fontWeight: "700", color: color.ink }} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {vs !== null && (
        <Text testID="owner-compare" style={{ fontSize: 12.5, fontWeight: "600", color: compare === null ? color.faint : TONE[compare.tone] }} numberOfLines={1}>
          {compare === null ? t("owner.vs.none") : `${compare.text} · ${t(vs)}`}
        </Text>
      )}
    </View>
  );
}

const dayLabel = (day: string, t: T): string => { const p = dayMonthParts(day); return `${String(p.d)} ${t(p.monthKey)}`; };

export function OwnerPage({ page, now = Date.now }: { page: OwnerTileKey; now?: () => number }) {
  const { t } = useI18n();
  const router = useRouter();
  const { state, call } = useSession();
  const permissions = useMemo(() => (state.status === "signedIn" ? state.me.permissions.hospital : []), [state]);
  const hasOnNow = state.status === "signedIn" && seatsFor(state.me.permissions).some((s) => s.key === "onNow");
  const periodic = WITH_PERIOD.includes(page);
  const [period, setPeriod] = useState<OwnerPeriod>("today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  /* The range in force: a custom period shows nothing until two good dates are applied. */
  const range: PageRange | null = useMemo(() => pageRange(period, now(), custom), [period, custom, now]);

  const load = useCallback(async () => {
    if (periodic && range === null) { setData(null); setFailed(false); return; }
    const r = range ?? pageRange("today", now())!;
    try {
      let next: Data;
      if (page === "money") next = { page, d: await call<OwnerMoney>("GET", `/billing/reports/owner-money?${rangeQuery(r)}`) };
      else if (page === "appointments") next = { page, d: await call<OwnerAppointments>("GET", `/opd/reports/appointments-summary?${rangeQuery(r)}`) };
      else if (page === "pharmacy") next = { page, d: await call<OwnerPharmacy>("GET", `/pharmacy/office/reports/owner-summary?${rangeQuery(r)}`) };
      else if (page === "staff") next = { page, d: await call<StaffToday>("GET", "/roster/staff-today") };
      else if (page === "learning") next = { page, d: await call<OwnerLearning>("GET", "/opd/reports/learning") };
      else if (page === "recorded") {
        const [cur, before] = await Promise.all([
          call<RecordingReport>("GET", `/opd/reports/recording?${rangeQuery(r, false)}`),
          r.compare === null ? null : call<RecordingReport>("GET", `/opd/reports/recording?from=${r.compare.from}&to=${r.compare.to}`).catch(() => null),
        ]);
        next = { page, d: { now: cur, before } };
      } else {
        const [byDept, names, before, onNow] = await Promise.all([
          call<StaffRange>("GET", `/staff/range?${rangeQuery(r, false)}&groupBy=departmentId`),
          call<{ items?: { id: string; name: string }[] } | { id: string; name: string }[]>("GET", "/opd/departments").catch(() => null),
          r.compare === null ? null : call<StaffRange>("GET", `/staff/range?from=${r.compare.from}&to=${r.compare.to}&groupBy=day`).catch(() => null),
          rosterApi(call).onNow().catch(() => null),
        ]);
        const list = names === null ? [] : Array.isArray(names) ? names : (names.items ?? []);
        const nameOf = new Map(list.map((x) => [x.id, x.name] as const));
        const departments = byDept.rows.map((row) => ({ name: nameOf.get(row.key.departmentId ?? "") ?? row.key.departmentId ?? "—", value: row.measures[VISITS] ?? 0 }))
          .filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
        next = { page: "opd", d: {
          departments, total: departments.reduce((n, x) => n + x.value, 0),
          before: before === null ? null : before.rows.reduce((n, row) => n + (row.measures[VISITS] ?? 0), 0), onNow,
        } };
      }
      setData(next); setFailed(false);
    } catch {
      setData(null); setFailed(true);
    }
  }, [page, periodic, range, call, now]);
  useEffect(() => { void load(); }, [load]);

  const applyCustom = (): void => {
    const problem = rangeProblem(from.trim(), to.trim(), istDayOf(now()));
    if (problem !== null) { setCustomError(t(`owner.custom.${problem}`)); return; }
    setCustomError(null);
    setCustom({ from: from.trim(), to: to.trim() });
  };

  const nickname = async (n: LearningNickname, act: "undo" | "restore"): Promise<void> => {
    if (busy !== null) return;
    setBusy(n.id); setSaid(null);
    try {
      await call<{ ok: true }>("POST", `/opd/consult/nicknames/${encodeURIComponent(n.id)}/${act}`);
      setData((cur) => (cur === null || cur.page !== "learning" ? cur : {
        page: "learning", d: { ...cur.d, nicknames: cur.d.nicknames.map((x) => (x.id !== n.id ? x : act === "undo"
          ? { ...x, state: "removed" as const, removedBy: "owner" as const } : { ...x, state: "suggested" as const, removedBy: null })) },
      }));
    } catch { setSaid(t("owner.learning.notSaved")); } finally { setBusy(null); }
  };

  const vs = periodic ? compareKey(period) : null;
  const title = t(page === "staff" ? "owner.staff.title" : page === "learning" ? "owner.learning.title" : `owner.tile.${page}`);

  const body = (): ReactNode => {
    if (data === null || data.page !== page) return null;
    if (data.page === "money") {
      const m = data.d;
      const top = Math.max(m.byMode.cash, m.byMode.upi, m.byMode.card, 1);
      const mo = arrowPercent(m.month.now.collectedPaise, m.month.before.collectedPaise);
      const lastMonth = t(dayMonthParts(m.month.before.from).monthKey);
      return (
        <>
          <Head label={t("owner.money.collected")} value={rupeesShort(m.collectedPaise)} compare={arrowPercent(m.collectedPaise, m.previous?.collectedPaise)} vs={vs} t={t} />
          <Section testID="owner-money-month">
            <Row first label={t("owner.money.month")} value={rupeesShort(m.month.now.collectedPaise)} tone={mo?.tone ?? "plain"}
              sub={mo === null ? t("owner.money.lastMonthWas", { month: lastMonth, amount: rupeesShort(m.month.before.collectedPaise) }) : `${mo.text} ${t("owner.money.vsMonth", { month: lastMonth })}`} />
          </Section>
          <Section testID="owner-money-split">
            {(["cash", "upi", "card"] as const).map((k, i) => (
              <View key={k}><Row first={i === 0} label={t(`owner.money.${k}`)} value={rupeesShort(m.byMode[k])} testID={`owner-money-${k}`} /><Bar part={m.byMode[k]} of={top} /></View>
            ))}
          </Section>
          {m.cashiers.length > 0 && (
            <Section title={t("owner.money.cashiers")} testID="owner-money-cashiers">
              <Capped items={m.cashiers} t={t} testID="owner-cashiers" render={(c, i) => {
                const w = drawerWords(c.state, c.variancePaise);
                const words = t(w.key, w.vars);
                return (
                  <Row key={`${c.name}:${c.openedDay}:${String(i)}`} testID={`owner-cashier-${String(i)}`} first={i === 0} label={c.name} value={rupeesShort(c.collectedPaise)}
                    tone={c.state === "short" || c.state === "excess" ? "down" : c.state === "open" ? "warn" : "plain"}
                    sub={m.from === m.to ? words : `${dayLabel(c.openedDay, t)} · ${words}`} />
                );
              }} />
            </Section>
          )}
          <Section testID="owner-money-rest">
            <Row first label={t("owner.money.refunds")} value={rupeesShort(m.refunds.amountPaise)} sub={m.refunds.count > 0 ? t("owner.money.paid", { n: m.refunds.count }) : null} />
            <Row label={t("owner.money.discounts")} value={rupeesShort(m.discountsPaise)} />
            <Row label={t("owner.money.letThrough")} value={String(m.letThroughUnpaid)} tone="warn" testID="owner-money-let-through" />
          </Section>
        </>
      );
    }
    if (data.page === "recorded") {
      const r = data.d.now;
      const c: RecordingCounts | null = r.totals;
      if (c === null) return <Note tone="info" testID="owner-empty">{t("owner.recorded.none")}</Note>;
      const before = data.d.before?.totals ?? null;
      return (
        <>
          <Head label={t("owner.recorded.head")} value={t("owner.recorded.of", { on: onRecord(c), of: c.consulted })} compare={before === null ? null : arrowPercent(onRecord(c), onRecord(before))} vs={vs} t={t} />
          {r.doctors !== null && r.doctors.length > 0 && (
            <Section title={t("owner.byDoctor")} testID="owner-recorded-doctors">
              <Capped items={r.doctors} t={t} testID="owner-doctors" render={(d, i) => {
                const pct = recordedPercent(d);
                return (
                  <View key={d.id} testID={`owner-recorded-doctor-${d.id}`}>
                    <Row first={i === 0} label={d.name} value={`${String(onRecord(d))} / ${String(d.consulted)}`} tone="down" sub={d.notRecorded > 0 ? t("owner.recorded.notRecorded", { n: d.notRecorded }) : null} />
                    <Bar part={onRecord(d)} of={d.consulted} red={pct !== null && pct < 75} />
                  </View>
                );
              }} />
            </Section>
          )}
          <Section testID="owner-recorded-how">
            <Row first label={t("owner.recorded.onScreen")} value={String(c.issued)} />
            <Row label={t("owner.recorded.typed")} value={String(c.typed)} />
            <Row label={t("owner.recorded.photoOnly")} value={String(c.toType)} />
            <Row label={t("owner.recorded.missing")} value={String(c.notRecorded)} tone="down" />
          </Section>
        </>
      );
    }
    if (data.page === "appointments") {
      const a = data.d;
      return (
        <>
          <Head label={t("owner.appointments.head")} value={String(a.total)} compare={period === "today" ? arrowCount(a.total, a.previous?.total) : arrowPercent(a.total, a.previous?.total)} vs={vs} t={t} />
          <Section testID="owner-appointments-status">
            <Row first label={t("owner.appointments.came")} value={String(a.came)} testID="owner-appt-came" />
            <Row label={t("owner.appointments.toCome")} value={String(a.toCome)} />
            <Row label={t("owner.appointments.missed")} value={String(a.missed)} />
            <Row label={t("owner.appointments.rebook")} value={String(a.needRebooking)} tone="warn" />
            <Row label={t("owner.appointments.cancelled")} value={String(a.cancelled)} />
          </Section>
          {a.doctors.length > 0 && (
            <Section title={t("owner.byDoctor")} testID="owner-appointments-doctors">
              <Capped items={a.doctors} t={t} testID="owner-doctors" render={(d, i) => (
                <Row key={d.id} first={i === 0} label={d.name} value={String(d.total)} sub={t("owner.appointments.cameOf", { n: d.came })} />
              )} />
            </Section>
          )}
        </>
      );
    }
    if (data.page === "pharmacy") {
      const p = data.d;
      const money = p.salesPaise !== null;
      const amount = (paise: number | null, bills: number): string => (paise === null ? String(bills) : rupeesShort(paise));
      return (
        <>
          {money
            ? <Head label={t("owner.pharmacy.sales")} value={rupeesShort(p.salesPaise!)} compare={arrowPercent(p.salesPaise!, p.previous?.salesPaise)} vs={vs} t={t} />
            : <Head label={t("owner.pharmacy.bills")} value={String(p.bills)} compare={arrowCount(p.bills, p.previous?.bills)} vs={vs} t={t} />}
          <Section testID="owner-pharmacy-sales">
            {money && <Row first label={t("owner.pharmacy.bills")} value={String(p.bills)} sub={p.bills > 0 ? t("owner.pharmacy.each", { amount: rupeesShort(Math.round(p.salesPaise! / p.bills)) }) : null} />}
            {p.split.map((s, i) => <Row key={s.key} first={!money && i === 0} label={t(`owner.pharmacy.split.${s.key}`)} value={amount(s.salesPaise, s.bills)} sub={money ? t("owner.pharmacy.billsN", { n: s.bills }) : null} />)}
            {money && p.refundsPaise !== null && p.refundsPaise > 0 && <Row label={t("owner.money.refunds")} value={rupeesShort(p.refundsPaise)} />}
            {p.prescriptions.reached > 0 && (
              <Row first={!money && p.split.length === 0} label={t("owner.pharmacy.served")} value={`${String(p.prescriptions.served)} / ${String(p.prescriptions.reached)}`} testID="owner-pharmacy-served" />
            )}
            {!money && p.split.length === 0 && p.prescriptions.reached === 0 && <Row first label={t("owner.pharmacy.bills")} value="0" />}
          </Section>
          {p.stock !== null && (
            <Section title={t("owner.pharmacy.stock")} right={t("owner.pharmacy.now")} testID="owner-pharmacy-stock">
              <Row first label={t("owner.pharmacy.low")} value={String(p.stock.low)} tone="warn" />
              <Row label={t("owner.pharmacy.expiring")} value={String(p.stock.expiring60)} />
              <Row label={t("owner.pharmacy.asked")} value={String(p.stock.askedOut)} sub={p.stock.askedNames.length > 0 ? p.stock.askedNames.join(", ") : null} />
            </Section>
          )}
        </>
      );
    }
    if (data.page === "staff") {
      const s = data.d;
      const toBoard = hasOnNow ? () => router.push({ pathname: "/seat/[key]", params: { key: "onNow" } }) : undefined;
      return (
        <>
          <Head label={t("owner.staff.onDuty")} value={String(s.onDuty)} compare={null} vs={null} t={t} />
          <Section title={t("owner.staff.onLeave")} right={String(s.onLeave.length)} testID="owner-staff-leave">
            {s.onLeave.length === 0 ? <Row first label={t("owner.staff.nobody")} />
              : <Capped items={s.onLeave} t={t} testID="owner-leave" render={(p, i) => <Row key={p.userId} first={i === 0} label={p.name} />} />}
          </Section>
          <Section title={t("owner.staff.gaps")} right={String(s.gaps.length)} testID="owner-staff-gaps">
            {s.gaps.length === 0 ? <Row first label={t("owner.staff.noGaps")} />
              : <Capped items={s.gaps} t={t} testID="owner-gaps" render={(g, i) => (
                <Row key={`${g.department}:${g.from}:${String(i)}`} first={i === 0} label={g.department} value={hhmm(g.from)} tone="warn" sub={g.what} onPress={toBoard} testID={`owner-gap-${String(i)}`} />
              )} />}
          </Section>
          <Section title={t("owner.staff.waiting")} testID="owner-staff-waiting">
            <Row first label={t("owner.staff.cover")} value={String(s.waiting.cover)} onPress={s.waiting.cover > 0 ? toBoard : undefined} testID="owner-staff-cover"
              sub={s.waiting.coverLines.length > 0 ? `${s.waiting.coverLines[0]!.department} · ${dayLabel(s.waiting.coverLines[0]!.day, t)}` : null} />
            <Row label={t("owner.staff.leaveAsked")} value={String(s.waiting.leave)} />
          </Section>
          <Text style={{ fontSize: 12, color: color.faint }} numberOfLines={1}>{t("owner.staff.noAttendance")}</Text>
        </>
      );
    }
    if (data.page === "learning") {
      const l = data.d;
      const pct = l.tapped === null ? null : Math.round((l.tapped.accepted / l.tapped.acted) * 100);
      return (
        <>
          <Note tone={l.on ? "info" : "warn"} testID="owner-learning-on">{t(l.on ? "owner.learning.on" : "owner.learning.off")}</Note>
          {said !== null && <Note tone="bad" testID="owner-said">{said}</Note>}
          <Section title={t("owner.learning.nicknames")} right={String(l.nicknames.length)} testID="owner-learning-list">
            {l.nicknames.length === 0 ? <Row first label={t("owner.learning.none")} />
              : <Capped items={l.nicknames} t={t} testID="owner-nicknames" render={(n, i) => {
                const removed = n.state === "removed";
                const what = removed ? t(n.removedBy === "doctors" ? "owner.learning.crossedOff" : "owner.learning.removed")
                  : [n.medicine, n.state === "trusted" ? t("owner.learning.trusted") : t(n.doctors === 1 ? "owner.learning.doctor" : "owner.learning.doctors", { n: n.doctors })].filter((x) => x !== null && x !== "").join(" · ");
                return (
                  <View key={n.id} testID={`owner-nickname-${n.id}`} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 7, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: color.line2 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: "600", color: removed ? color.faint : color.ink, textDecorationLine: removed ? "line-through" : "none" }} numberOfLines={1}>{`“${n.nickname}”`}</Text>
                      <Text testID={`owner-nickname-what-${n.id}`} style={{ fontSize: 12, color: color.dim }} numberOfLines={1}>{what}</Text>
                    </View>
                    {l.mayUndo && (
                      <Pressable testID={`owner-nickname-act-${n.id}`} accessibilityRole="button" disabled={busy !== null} onPress={() => { void nickname(n, removed ? "restore" : "undo"); }}
                        style={{ minHeight: 40, minWidth: 76, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, alignItems: "center", justifyContent: "center", opacity: busy === n.id ? 0.5 : 1 }}>
                        <Text style={{ fontSize: 13, fontWeight: "700", color: removed ? color.green : color.red }} numberOfLines={1}>{t(removed ? "owner.learning.putBack" : "owner.learning.undo")}</Text>
                      </Pressable>
                    )}
                  </View>
                );
              }} />}
          </Section>
          <Section testID="owner-learning-numbers">
            {pct !== null && <Row first label={t("owner.learning.tapped")} value={`${String(pct)}%`} testID="owner-learning-tapped" />}
            <Row first={pct === null} label={t("owner.learning.misses")} value={String(l.misses)} />
          </Section>
        </>
      );
    }
    const o = data.d;
    const duty = (o.onNow?.departments ?? []).map((d) => ({
      line: d.unitOnTake === null ? d.name : `${d.name} · ${d.unitOnTake.name}`,
      who: d.inTheBuilding[0]?.name ?? d.inOpd?.find((p) => p.now)?.name ?? null,
    }));
    return (
      <>
        <Head label={t("owner.opd.head")} value={String(o.total)} compare={period === "today" ? arrowCount(o.total, o.before) : arrowPercent(o.total, o.before)} vs={vs} t={t} />
        <Section title={t("owner.opd.byDept")} testID="owner-opd-departments">
          {o.departments.length === 0 ? <Row first label={t("owner.opd.none")} />
            : <Capped items={o.departments} t={t} testID="owner-depts" render={(d, i) => (
              <View key={d.name}><Row first={i === 0} label={d.name} value={String(d.value)} /><Bar part={d.value} of={o.departments[0]!.value} /></View>
            )} />}
        </Section>
        {duty.length > 0 && (
          <Section title={t("home.owner.onDuty")} testID="owner-opd-duty">
            <Capped items={duty} t={t} testID="owner-duty" render={(d, i) => <Row key={d.line} first={i === 0} label={d.line} sub={d.who ?? t("home.owner.nobody")} />} />
          </Section>
        )}
      </>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={<Button kind="secondary" label={t("recorded.back")} onPress={() => router.back()} testID="owner-back" />} />
      <ScrollView testID="owner-scroll" contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl }} keyboardShouldPersistTaps="handled">
        <Text testID="owner-title" style={[type.title, { color: color.ink }]} numberOfLines={1}>{title}</Text>
        {periodic && (
          <View testID="owner-periods" style={{ flexDirection: "row", gap: 6 }}>
            {OWNER_PERIODS.map((p) => {
              const on = p === period;
              return (
                <Pressable key={p} testID={`owner-period-${p}`} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => { setPeriod(p); setCustomError(null); }}
                  style={{ flex: 1, minHeight: 40, borderRadius: 999, borderWidth: 1, borderColor: on ? color.green : color.line, backgroundColor: on ? color.green : color.card, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 13, fontWeight: "700", color: on ? "#f2faf6" : color.ink }} numberOfLines={1}>{t(`owner.period.${p}`)}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {periodic && period === "custom" && (
          <View testID="owner-custom" style={[card, { paddingVertical: space.md, gap: space.sm }]}>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {([["from", from, setFrom], ["to", to, setTo]] as const).map(([k, v, set]) => (
                <View key={k} style={{ flex: 1, gap: 4 }}>
                  <Text style={{ fontSize: 12, color: color.dim }} numberOfLines={1}>{t(`owner.custom.${k}`)}</Text>
                  <TextInput testID={`owner-custom-${k}`} value={v} onChangeText={set} placeholder={t("owner.custom.hint")} placeholderTextColor={color.faint}
                    autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" maxLength={10} accessibilityLabel={t(`owner.custom.${k}`)}
                    style={{ minHeight: TOUCH, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: space.md, fontFamily: MONO, fontSize: 15, color: color.ink, backgroundColor: color.card }} />
                </View>
              ))}
            </View>
            {customError !== null && <Note tone="bad" testID="owner-custom-error">{customError}</Note>}
            <Button testID="owner-custom-apply" label={t("owner.custom.show")} onPress={applyCustom} />
          </View>
        )}
        {periodic && range !== null && (
          <Text testID="owner-range" style={{ fontFamily: MONO, fontSize: 11.5, color: color.faint }} numberOfLines={1}>
            {range.from === range.to ? dayLabel(range.from, t) : `${dayLabel(range.from, t)} – ${dayLabel(range.to, t)}`}
          </Text>
        )}
        {failed && <Note tone="warn" testID="owner-failed">{t("owner.notLoaded")}</Note>}
        {failed && <Button kind="secondary" label={t("recorded.again")} onPress={() => { void load(); }} testID="owner-again" />}
        {page === "money" && !permissions.includes(MONEY_PERMISSION) ? null : body()}
      </ScrollView>
    </View>
  );
}

