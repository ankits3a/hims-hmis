import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { MONO, Note } from "../ui";
import {
  FLOW_LEGS, dayMonthParts, findingVars, minutesShown,
  type FlowFinding, type FlowLeg, type FlowReport, type FlowStat,
} from "../owner/model";
import type { Call } from "../doctor/api";

/**
 * THE "WAIT" PAGE (owner 2026-10-09: "how much time … from registration desk to Vital desk and then …
 * from vitals to getting consulted … per department … day, week, month, custom … comparison").
 *
 * Three numbers (Avg minutes) with the like period before; departments ranked with the hospital's line;
 * a by-hour strip 08–20 for a chosen leg; weekdays; "To improve" — the nightly learning's findings, each
 * in a FIXED template filled with its numbers, with × and "Tried it"; and "Fixed" with the minutes won.
 *
 * Waits are drawn in neutral colours: a longer wait is not "up" in green or red. Red is only the border
 * of a finding's card. Every label is one line at 360 px; a try-line may wrap to two.
 */
type T = (key: string, vars?: Record<string, string | number>) => string;
export type WaitData = { main: FlowReport; hour: FlowReport | null; weekday: FlowReport | null };

const card = { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.xs } as const;
const BAR = "#9aa9a1";

/** "▲ 3 min" / "▼ 2 min" / "same" against the like period; null with nothing to compare. */
export function waitDelta(now: FlowStat, before: FlowStat | null | undefined, t: T): string | null {
  if (before == null || now.avg === null || before.avg === null) return null;
  const d = Math.round(now.avg) - Math.round(before.avg);
  return d === 0 ? t("owner.wait.same") : t(d > 0 ? "owner.wait.up" : "owner.wait.down", { n: Math.abs(d) });
}

/** A finding's fixed title and try-line, filled with its numbers. */
export function findingWords(f: FlowFinding, t: T): { title: string; vs: string; tryLine: string } {
  const v = findingVars(f);
  const vars = { ...v, day: v.dayKey === "" ? "" : t(v.dayKey) };
  return { title: t(`owner.wait.kind.${f.type}`, vars), vs: t("owner.wait.vsUsual", vars), tryLine: t(`owner.wait.try.${f.type}`, vars) };
}

const mins = (s: FlowStat): string => minutesShown(s.avg) ?? "—";

function Section({ title, right, children, testID }: { title: string; right?: string; children: React.ReactNode; testID?: string }) {
  return (
    <View testID={testID} style={card}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 8, paddingBottom: 2, gap: space.sm }}>
        <Text style={[type.tag, { color: color.faint, fontFamily: MONO, flex: 1 }]} numberOfLines={1}>{title}</Text>
        {right !== undefined && <Text style={{ fontSize: 12, color: color.dim }} numberOfLines={1}>{right}</Text>}
      </View>
      {children}
    </View>
  );
}

function Bar({ part, of }: { part: number | null; of: number }) {
  const pct = part === null || of <= 0 ? 0 : Math.max(2, Math.min(100, Math.round((part / of) * 100)));
  return (
    <View style={{ height: 5, borderRadius: 3, backgroundColor: color.wash, marginBottom: 8 }}>
      <View style={{ height: 5, borderRadius: 3, backgroundColor: BAR, width: `${pct}%` as `${number}%` }} />
    </View>
  );
}

function Line({ label, value, sub, testID, first, bold }: { label: string; value: string; sub?: string | null; testID?: string; first?: boolean; bold?: boolean }) {
  return (
    <View testID={testID} style={{ paddingVertical: 8, borderTopWidth: first === true ? 0 : 1, borderTopColor: color.line2 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
        <Text style={{ fontSize: 14, color: color.ink, flex: 1, fontWeight: bold === true ? "700" : "400" }} numberOfLines={1}>{label}</Text>
        <Text style={{ fontFamily: MONO, fontSize: 14, fontWeight: "700", color: color.ink }} numberOfLines={1}>{value}</Text>
      </View>
      {sub != null && <Text style={{ fontSize: 12, color: color.dim, marginTop: 1 }} numberOfLines={1}>{sub}</Text>}
    </View>
  );
}

function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={{ flex: 1, minHeight: 36, borderRadius: 999, borderWidth: 1, borderColor: on ? color.ink : color.line, backgroundColor: on ? color.ink : color.card, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }}>
      <Text style={{ fontSize: 12, fontWeight: "700", color: on ? "#f2faf6" : color.ink }} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const dayLabel = (day: string, t: T): string => { const p = dayMonthParts(day); return `${String(p.d)} ${t(p.monthKey)}`; };

export function WaitBody({ d, vs, t, call }: { d: WaitData; vs: string | null; t: T; call: Call }) {
  const r = d.main;
  const [leg, setLeg] = useState<FlowLeg>("deskToVitals");
  const [gone, setGone] = useState<string[]>([]);
  const [tried, setTried] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const act = async (f: FlowFinding, what: "dismiss" | "tried"): Promise<void> => {
    if (busy !== null) return;
    setBusy(f.id); setSaid(null);
    try {
      await call<{ ok: true }>("POST", `/opd/reports/flow/findings/${encodeURIComponent(f.id)}/${what}`);
      if (what === "dismiss") { setGone((g) => [...g, f.id]); setSaid(t("owner.wait.hidden")); }
      else setTried((x) => ({ ...x, [f.id]: r.to }));
    } catch { setSaid(t("owner.wait.notSaved")); } finally { setBusy(null); }
  };

  const depts = r.groups;
  const topDept = Math.max(r.hospital.deskToDoctor.avg ?? 0, ...depts.map((g) => g.cell.deskToDoctor.avg ?? 0), 1);
  const hours = d.hour?.groups ?? [];
  const topHour = Math.max(...hours.map((g) => g.cell[leg].avg ?? 0), 1);
  const days = d.weekday?.groups ?? [];
  const topDay = Math.max(...days.map((g) => g.cell.deskToDoctor.avg ?? 0), 1);
  const open = r.findings.filter((f) => !gone.includes(f.id));
  const dropped = Object.values(r.drops).reduce((n, x) => n + x, 0);

  return (
    <>
      <View testID="wait-head" style={[card, { paddingVertical: space.sm }]}>
        <Text style={{ fontSize: 12, color: color.dim, paddingTop: 4 }} numberOfLines={1}>{t("owner.wait.avg")}</Text>
        {FLOW_LEGS.map((l, i) => {
          const s = r.hospital[l];
          const delta = waitDelta(s, r.previous?.[l], t);
          return (
            <View key={l} testID={`wait-leg-${l}`} style={{ paddingVertical: 7, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: color.line2 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
                <Text style={{ fontSize: 15, color: color.ink, flex: 1, fontWeight: l === "deskToDoctor" ? "700" : "400" }} numberOfLines={1}>{t(`owner.wait.${l}`)}</Text>
                <Text testID={`wait-leg-value-${l}`} style={{ fontFamily: MONO, fontSize: 24, lineHeight: 30, fontWeight: "700", color: color.ink }} numberOfLines={1}>{mins(s)}</Text>
              </View>
              <Text testID={`wait-leg-sub-${l}`} style={{ fontSize: 12, color: color.dim }} numberOfLines={1}>
                {s.avg === null ? t("owner.wait.few") : [t("owner.wait.patients", { n: s.n }), vs === null ? null : delta === null ? t("owner.vs.none") : `${delta} · ${t(vs)}`].filter((x) => x !== null).join(" · ")}
              </Text>
            </View>
          );
        })}
      </View>

      {said !== null && <Note tone={said === t("owner.wait.hidden") ? "info" : "bad"} testID="wait-said">{said}</Note>}

      <Section title={t("owner.wait.toImprove")} right={open.length > 0 ? String(open.length) : undefined} testID="wait-improve">
        {!r.learning ? <Line first label={t("owner.wait.off")} value="" />
          : open.length === 0 ? <Line first label={t("owner.wait.nothing")} value="" />
          : open.map((f) => {
            const w = findingWords(f, t);
            const triedOn = tried[f.id] ?? f.triedOn;
            return (
              <View key={f.id} testID={`wait-finding-${f.id}`} style={{ borderWidth: 1.5, borderColor: color.red, borderRadius: radius.md, padding: space.sm, marginVertical: 6, gap: 2 }}>
                <Text testID={`wait-finding-title-${f.id}`} style={{ fontSize: 14.5, fontWeight: "700", color: color.ink }} numberOfLines={1}>{w.title}</Text>
                <Text style={{ fontSize: 12, color: color.dim }} numberOfLines={1}>{f.department ?? t("owner.wait.whole")}</Text>
                <Text testID={`wait-finding-vs-${f.id}`} style={{ fontFamily: MONO, fontSize: 13, fontWeight: "700", color: color.ink }} numberOfLines={1}>{w.vs}</Text>
                <Text testID={`wait-finding-try-${f.id}`} style={{ fontSize: 13, color: color.ink }} numberOfLines={2}>{w.tryLine}</Text>
                {triedOn !== null && (
                  <Text style={{ fontSize: 12, color: color.dim }} numberOfLines={1}>
                    {[t("owner.wait.triedOn", { day: dayLabel(triedOn, t) }), f.after === null ? null : t("owner.wait.since", { min: Math.round(f.after) })].filter((x) => x !== null).join(" · ")}
                  </Text>
                )}
                {r.mayAct && (
                  <View style={{ flexDirection: "row", gap: space.sm, marginTop: 4 }}>
                    <Pressable testID={`wait-dismiss-${f.id}`} accessibilityRole="button" accessibilityLabel={t("owner.wait.dismiss")} disabled={busy !== null} onPress={() => { void act(f, "dismiss"); }}
                      style={{ minHeight: 40, minWidth: 64, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, alignItems: "center", justifyContent: "center", opacity: busy === f.id ? 0.5 : 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: "700", color: color.dim }} numberOfLines={1}>{`× ${t("owner.wait.dismiss")}`}</Text>
                    </Pressable>
                    {triedOn === null && (
                      <Pressable testID={`wait-tried-${f.id}`} accessibilityRole="button" disabled={busy !== null} onPress={() => { void act(f, "tried"); }}
                        style={{ flex: 1, minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.green, alignItems: "center", justifyContent: "center", opacity: busy === f.id ? 0.5 : 1 }}>
                        <Text style={{ fontSize: 13, fontWeight: "700", color: color.green }} numberOfLines={1}>{t("owner.wait.tried")}</Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            );
          })}
      </Section>

      {r.fixed.length > 0 && (
        <Section title={t("owner.wait.fixed")} right={String(r.fixed.length)} testID="wait-fixed">
          {r.fixed.map((f, i) => (
            <Line key={f.id} first={i === 0} testID={`wait-fixed-${f.id}`} label={findingWords(f, t).title}
              value={f.before === null || f.after === null ? "—" : t("owner.wait.fixedBy", { n: Math.max(0, Math.round(f.before) - Math.round(f.after)) })}
              sub={[f.department ?? t("owner.wait.whole"), f.minutesWon === null ? null : t("owner.wait.won", { n: f.minutesWon })].filter((x) => x !== null).join(" · ")} />
          ))}
        </Section>
      )}

      <Section title={t("owner.wait.byDept")} testID="wait-departments">
        <View testID="wait-dept-hospital"><Line first bold label={t("owner.wait.hospital")} value={mins(r.hospital.deskToDoctor)} /><Bar part={r.hospital.deskToDoctor.avg} of={topDept} /></View>
        {depts.map((g) => (
          <View key={g.key} testID={`wait-dept-${g.key}`}>
            <Line label={g.name ?? "—"} value={mins(g.cell.deskToDoctor)}
              sub={g.cell.deskToDoctor.avg === null ? t("owner.wait.few") : `${t("owner.wait.deskToVitals")} ${mins(g.cell.deskToVitals)} · ${t("owner.wait.vitalsToDoctor")} ${mins(g.cell.vitalsToDoctor)}`} />
            <Bar part={g.cell.deskToDoctor.avg} of={topDept} />
          </View>
        ))}
      </Section>

      {d.hour !== null && (
        <Section title={t("owner.wait.byHour")} testID="wait-hours">
          <View style={{ flexDirection: "row", gap: 6, paddingVertical: 6 }}>
            {FLOW_LEGS.map((l) => <Chip key={l} testID={`wait-hour-leg-${l}`} label={t(`owner.wait.${l}`)} on={leg === l} onPress={() => setLeg(l)} />)}
          </View>
          <View testID="wait-hour-strip" style={{ flexDirection: "row", alignItems: "flex-end", height: 104, gap: 2, paddingTop: 4 }}>
            {hours.map((g) => {
              const avg = g.cell[leg].avg;
              const h = avg === null ? 0 : Math.max(4, Math.round((avg / topHour) * 64));
              return (
                <View key={g.key} testID={`wait-hour-${g.key}`} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end" }}>
                  <Text style={{ fontFamily: MONO, fontSize: 9.5, color: color.dim }} numberOfLines={1}>{minutesShown(avg) ?? "—"}</Text>
                  <View style={{ width: "70%", height: h, backgroundColor: BAR, borderRadius: 2, marginTop: 2 }} />
                  <Text style={{ fontFamily: MONO, fontSize: 9.5, color: color.faint, marginTop: 3 }} numberOfLines={1}>{g.key}</Text>
                </View>
              );
            })}
          </View>
        </Section>
      )}

      {d.weekday !== null && (
        <Section title={t("owner.wait.byWeekday")} right={t("owner.wait.deskToDoctor")} testID="wait-weekdays">
          {days.map((g, i) => (
            <View key={g.key} testID={`wait-weekday-${g.key}`}>
              <Line first={i === 0} label={t(`owner.wait.weekday.${g.key}`)} value={mins(g.cell.deskToDoctor)} sub={g.cell.deskToDoctor.n > 0 && g.cell.deskToDoctor.avg === null ? t("owner.wait.few") : null} />
              <Bar part={g.cell.deskToDoctor.avg} of={topDay} />
            </View>
          ))}
        </Section>
      )}

      {dropped > 0 && <Text testID="wait-dropped" style={{ fontSize: 12, color: color.faint }} numberOfLines={1}>{t("owner.wait.dropped", { n: dropped })}</Text>}
    </>
  );
}
