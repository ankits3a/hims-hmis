import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { NetworkError } from "../api";
import {
  ALL_READ, attendanceApi, type MarkView, type QueueRequest, type RequestTab, type SyncState, type TeamToday, type TodayList,
} from "../attendance/api";
import { managerDay, reasonKey, sortToday, todayCounts, todayPlace, type TodayPerson } from "../attendance/rules";
import { BackBand, Chips, Counts, ToneTag, dayLabel, type T } from "../attendance/views";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, MONO, Note } from "../ui";

export type ManageTab = "today" | "team" | "requests";
const hhmmIst = (iso: string): string => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

const MARK_TONE = { inside: "green", outside: "red", not_shared: "grey", doubtful: "warn" } as const;

/** What the right-hand side of a "today" row says: the first-in time, or where they are instead — and, beside it, today's newest app mark (decision 0061). */
function PlaceText({ t, p, testID, appMark = null }: { t: T; p: TodayPerson; testID: string; appMark?: MarkView | null }) {
  const place = todayPlace(p);
  const late = managerDay(p.status ?? "", p.firstIn !== null).late;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {place === "in"
        ? <Text testID={testID} numberOfLines={1} style={{ fontFamily: MONO, fontSize: 14, fontWeight: "700", color: color.ink }}>{p.firstIn ?? "✓"}</Text>
        : <Text testID={testID} numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "700", color: place === "not_in" ? color.red : color.dim }}>
            {t(place === "not_in" ? "attendance.manage.notIn" : place === "leave" ? "attendance.word.leave" : "attendance.word.off")}
          </Text>}
      {late && <ToneTag label={t("attendance.manage.late")} tone="amber" />}
      {appMark !== null && <View testID={`${testID}-mark`}><ToneTag label={t(`attendance.mark.tag.${appMark.place}`)} tone={MARK_TONE[appMark.place]} /></View>}
    </View>
  );
}

function Row({ name, sub, right, onPress, testID }: { name: string; sub: string; right: React.ReactNode; onPress?: () => void; testID: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" disabled={onPress === undefined} onPress={onPress}
      style={({ pressed }) => ({ minHeight: TOUCH + 8, flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.line2, backgroundColor: pressed ? color.wash : "transparent" })}>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: "600", color: color.ink }}>{name}</Text>
        <Text numberOfLines={1} style={{ fontSize: 12, color: color.faint }}>{sub}</Text>
      </View>
      {right}
    </Pressable>
  );
}

/**
 * ═══ STAFF ATTENDANCE FOR THOSE WHO MAY SEE IT (board frames 4 and 6) ═══
 *
 * WHO SEES WHAT IS THE SERVER'S: a holder of `attendance.all.read` (owner, Medical Superintendent,
 * the Attendance Committee) gets Today — everyone on the machine, with or without a login here — and
 * the meeting Requests; somebody who leads a team gets My team, their own people only. A person
 * with neither is never shown this screen and it asks nothing for them.
 *
 * Managers see times and "Late" (the owner's ruling: the words-only rule is for a person's own
 * screens). "Not in" leads the list.
 */
export function AttendanceManage({ lead = false, tab: startTab }: { lead?: boolean; tab?: ManageTab }) {
  const { t } = useI18n();
  const router = useRouter();
  const { state, call } = useSession();
  const all = state.status === "signedIn" && state.me.permissions.hospital.includes(ALL_READ);
  const tabs = useMemo<ManageTab[]>(() => [...(all ? (["today"] as const) : []), ...(lead || !all ? (["team"] as const) : []), ...(all ? (["requests"] as const) : [])], [all, lead]);
  const [tab, setTab] = useState<ManageTab>(startTab !== undefined && tabs.includes(startTab) ? startTab : tabs[0]!);
  if (state.status !== "signedIn") return null;
  const openPerson = (pin: string, name: string): void => { router.push({ pathname: "/attendance-person", params: { pin, name } }); };
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <BackBand t={t} onBack={() => router.back()} Band={Band} />
      <ScrollView testID="attendance-manage" keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }}>
        <Text numberOfLines={1} style={[type.title, { color: color.ink }]}>{t(tabs.length === 1 && tab === "team" ? "attendance.manage.team" : "attendance.title")}</Text>
        {tabs.length > 1 && <Chips testID="att-tab" value={tab} onChange={setTab} items={tabs.map((k) => ({ key: k, label: t(`attendance.manage.${k}`) }))} />}
        {tab === "today" && <TodayTab t={t} call={call} onPerson={openPerson} />}
        {tab === "team" && <TeamTab t={t} call={call} onPerson={openPerson} />}
        {tab === "requests" && <RequestsTab t={t} call={call} />}
      </ScrollView>
    </View>
  );
}

type Call = ReturnType<typeof useSession>["call"];

function TodayTab({ t, call, onPerson }: { t: T; call: Call; onPerson: (pin: string, name: string) => void }) {
  const [list, setList] = useState<TodayList | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [failed, setFailed] = useState<"offline" | "refused" | null>(null);
  const [dept, setDept] = useState<string>("");
  const [q, setQ] = useState("");
  useEffect(() => {
    let gone = false;
    void attendanceApi(call).today().then((r) => { if (!gone) { setList(r); setFailed(null); } }, (e: unknown) => { if (!gone) setFailed(e instanceof NetworkError ? "offline" : "refused"); });
    void attendanceApi(call).syncState().then((r) => { if (!gone) setSync(r); }, () => undefined);
    return () => { gone = true; };
  }, [call]);
  const depts = useMemo(() => [...new Set((list?.people ?? []).map((p) => p.dept ?? ""))].sort(), [list]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sortToday((list?.people ?? []).filter((p) => (dept === "" || (p.dept ?? "") === dept.slice(1)) && (needle === "" || p.name.toLowerCase().includes(needle))));
  }, [list, dept, q]);
  const counts = todayCounts(shown);
  const asOf = sync?.stages.today?.lastOkAt ?? null;
  const connected = list?.configured !== false && sync?.configured !== false;
  return (
    <View style={{ gap: space.md }}>
      {failed !== null && <Note tone="warn" testID="att-failed">{t(failed === "offline" ? "attendance.offline" : "attendance.cannotRead")}</Note>}
      {!connected && <Note tone="warn" testID="att-not-connected">{t("attendance.manage.notConnected")}</Note>}
      {connected && asOf !== null && <Text testID="att-as-of" numberOfLines={1} style={{ fontFamily: MONO, fontSize: 11.5, color: color.faint }}>{t("attendance.manage.asOf", { time: hhmmIst(asOf) })}</Text>}
      {list !== null && (
        <>
          <Counts items={[
            { key: "in", label: t("attendance.manage.countIn"), value: String(counts.in), tone: "green" },
            { key: "notIn", label: t("attendance.manage.countNotIn"), value: String(counts.notIn), tone: "red" },
            { key: "late", label: t("attendance.manage.countLate"), value: String(counts.late), tone: "amber" },
            { key: "leave", label: t("attendance.manage.countLeave"), value: String(counts.leave), tone: "blue" },
          ]} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            {["", ...depts.map((d) => `=${d}`)].map((d) => {
              const on = d === dept;
              return (
                <Pressable key={d} testID={`att-dept-${d === "" ? "all" : d.slice(1) === "" ? "none" : d.slice(1)}`} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setDept(d)}
                  style={{ minHeight: 36, paddingHorizontal: space.md, borderRadius: 999, borderWidth: 1, borderColor: on ? color.green : color.line, backgroundColor: on ? color.green : color.card, justifyContent: "center" }}>
                  <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "700", color: on ? "#f2faf6" : color.ink }}>{d === "" ? t("attendance.manage.all") : d.slice(1) === "" ? t("attendance.manage.noDept") : d.slice(1)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <TextInput testID="att-search" value={q} onChangeText={setQ} placeholder={t("attendance.manage.search")} placeholderTextColor={color.faint} autoCorrect={false} accessibilityLabel={t("attendance.manage.search")}
            style={{ minHeight: TOUCH, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 15, color: color.ink }} />
          <View testID="att-today-list" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingHorizontal: space.md }}>
            {shown.length === 0 && <Text numberOfLines={1} style={[type.small, { color: color.dim, paddingVertical: space.md }]}>{t("attendance.manage.nobody")}</Text>}
            {shown.map((p) => (
              <Row key={p.pin} testID={`att-person-${p.pin}`} name={p.name} onPress={() => onPerson(p.pin, p.name)}
                sub={[p.dept ?? p.post ?? "", p.hasLogin ? null : t("attendance.manage.noLogin")].filter((x) => x !== null && x !== "").join(" · ")}
                right={<PlaceText t={t} p={p} testID={`att-place-${p.pin}`} appMark={p.appMark ?? null} />} />
            ))}
          </View>
        </>
      )}
    </View>
  );
}

function TeamTab({ t, call, onPerson }: { t: T; call: Call; onPerson: (pin: string, name: string) => void }) {
  const [team, setTeam] = useState<TeamToday | null>(null);
  const [failed, setFailed] = useState<"offline" | "refused" | null>(null);
  useEffect(() => {
    let gone = false;
    void attendanceApi(call).teamToday().then((r) => { if (!gone) { setTeam(r); setFailed(null); } }, (e: unknown) => { if (!gone) setFailed(e instanceof NetworkError ? "offline" : "refused"); });
    return () => { gone = true; };
  }, [call]);
  const blank: TodayPerson = { status: null, firstIn: null, lastOut: null, onDuty: false };
  const rows = sortToday((team?.members ?? []).map((m) => ({ ...blank, ...(m.today ?? {}), name: m.name, userId: m.userId, linked: m.linked, pin: m.pin, appMark: m.appMark ?? null })));
  const counts = todayCounts(rows.filter((r) => r.linked));
  return (
    <View style={{ gap: space.md }}>
      {failed !== null && <Note tone="warn" testID="att-failed">{t(failed === "offline" ? "attendance.offline" : "attendance.cannotRead")}</Note>}
      {team !== null && (
        <>
          <Counts items={[
            { key: "in", label: t("attendance.manage.countIn"), value: t("attendance.of", { n: counts.in, of: rows.length }), tone: "green" },
            { key: "late", label: t("attendance.manage.countLate"), value: String(counts.late), tone: "amber" },
          ]} />
          <View testID="att-team-list" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingHorizontal: space.md }}>
            {rows.length === 0 && <Text numberOfLines={1} style={[type.small, { color: color.dim, paddingVertical: space.md }]}>{t("attendance.manage.noTeam")}</Text>}
            {rows.map((m) => (
              <Row key={m.userId} testID={`att-member-${m.userId}`} name={m.name} sub={m.linked ? "" : t("attendance.manage.notLinked")}
                onPress={m.pin === null ? undefined : () => onPerson(m.pin!, m.name)}
                right={m.linked ? <PlaceText t={t} p={m} testID={`att-place-${m.userId}`} appMark={m.appMark} /> : <Text numberOfLines={1} style={{ fontSize: 13, color: color.faint }}>—</Text>} />
            ))}
          </View>
        </>
      )}
    </View>
  );
}

function RequestsTab({ t, call }: { t: T; call: Call }) {
  const [status, setStatus] = useState<RequestTab>("open");
  const [items, setItems] = useState<QueueRequest[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setItems((await attendanceApi(call).requests(status)).requests); setFailed(null); }
    catch (e) { setFailed(t(e instanceof NetworkError ? "attendance.offline" : "attendance.cannotRead")); }
  }, [call, status, t]);
  useEffect(() => { setItems(null); void load(); }, [load]);
  const act = async (id: string, what: "seen" | "close"): Promise<void> => {
    setBusy(id); setFailed(null);
    try {
      if (what === "seen") await attendanceApi(call).markSeen(id); else await attendanceApi(call).close(id, note);
      setClosing(null); setNote("");
      await load();
    } catch { setFailed(t("attendance.requests.failed")); } finally { setBusy(null); }
  };
  const age = (r: QueueRequest): string => (r.ageHours >= 48 ? t("attendance.requests.ageDays", { n: Math.floor(r.ageHours / 24) }) : t("attendance.requests.ageHours", { n: r.ageHours }));
  const small = (label: string, onPress: () => void, id: string, primary = false, off = false) => (
    <Pressable testID={id} accessibilityRole="button" disabled={off} onPress={onPress}
      style={{ minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: primary ? color.green : color.line, backgroundColor: primary ? color.green : color.card, justifyContent: "center", opacity: off ? 0.5 : 1 }}>
      <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "700", color: primary ? "#f2faf6" : color.ink }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: space.md }}>
      <Chips testID="att-req" value={status} onChange={setStatus} items={(["open", "seen", "closed"] as const).map((k) => ({ key: k, label: t(`attendance.requests.${k}`) }))} />
      {failed !== null && <Note tone="warn" testID="att-req-failed">{failed}</Note>}
      {items !== null && items.length === 0 && <Note tone="info" testID="att-req-none">{t("attendance.requests.none")}</Note>}
      {(items ?? []).map((r) => (
        <View key={r.id} testID={`att-request-${r.id}`} style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, fontWeight: "700", color: color.ink }}>{r.name}</Text>
            <Text numberOfLines={1} style={{ fontFamily: MONO, fontSize: 11.5, color: color.faint }}>{age(r)}</Text>
          </View>
          <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{[dayLabel(t, r.date), t(reasonKey(r.reasonCode))].join(" · ")}</Text>
          {r.note !== null && <Text style={[type.small, { color: color.ink }]}>{r.note}</Text>}
          {r.closeNote !== null && <Text testID={`att-request-close-note-${r.id}`} style={[type.small, { color: color.dim }]}>{r.closeNote}</Text>}
          {status !== "closed" && closing !== r.id && (
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {status === "open" && small(t("attendance.requests.markSeen"), () => { void act(r.id, "seen"); }, `att-request-seen-${r.id}`, false, busy !== null)}
              {small(t("attendance.requests.close"), () => { setClosing(r.id); setNote(""); }, `att-request-close-${r.id}`, false, busy !== null)}
            </View>
          )}
          {closing === r.id && (
            <View style={{ gap: space.sm }}>
              <TextInput testID="att-request-note" value={note} onChangeText={setNote} maxLength={200} placeholder={t("attendance.requests.note")} placeholderTextColor={color.faint} accessibilityLabel={t("attendance.requests.note")}
                style={{ minHeight: TOUCH, backgroundColor: color.paper, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 15, color: color.ink }} />
              <View style={{ flexDirection: "row", gap: space.sm }}>
                {small(t("attendance.requests.confirmClose"), () => { void act(r.id, "close"); }, "att-request-close-confirm", true, busy !== null)}
                {small(t("attendance.requests.cancel"), () => { setClosing(null); }, "att-request-close-cancel")}
              </View>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}
