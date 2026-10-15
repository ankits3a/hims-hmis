import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NetworkError } from "../api";
import { useI18n } from "../i18n";
import { rosterApi, rosterRefusal, type RosterApi } from "../roster/api";
import {
  backupOf, clockNoteOf, flaggablePeople, hasNoTakeCycle, isDaytime, opdFallbackOf, shortUnit, takeTillOf,
} from "../roster/rules";
import type { WireBoardDepartment, WireBoardHole, WireBoardService, WireOnNowBoard, WireOpdSitting, WireRosterFlag } from "../roster/rules";
import { clockLine, hm, said, shortDay, shortWhen, weekdayLong, weekdayShort } from "../roster/words";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, Button, MONO, Note, Tag, KeyboardModal } from "../ui";

/**
 * WHO IS ON NOW, ON A PHONE (plan M5; owner 2026-10-06; board `docs/design/2026-09-20-roster/OnNow.dc.html`).
 * The hospital's unit board as casualty, the front desk and every ward read it on the web — the same
 * route (`GET /roster/on-now`), the same reading rules (`../roster/rules`, one file with the web) and
 * the web's own sentences. Per department: the unit on take and till when, who is in the building
 * (with a CALL button only where the server sent a number — D6: only people on duty now carry one),
 * the faculty on call, and who takes the overflow; then the hospital-wide services and the holes in
 * the next 24 hours.
 *
 * A department with no published duty roster SAYS SO, or — where only the OPD is live (owner
 * 2026-10-04) — shows who is sitting in its OPD. An empty card would look staffed.
 *
 * "This is wrong" (register I22) raises a flag for the duty manager; nobody's duty changes. What
 * stays on the computer: the board as it stood (an inspection's tool), declaring a holiday or
 * skeleton cover, and printing — the server prints the wall copy at 20:00 and 08:00 by itself.
 */
export const BOARD_POLL_MS = 60_000;
const AHEAD_MS = 8 * 3_600_000;
type T = ReturnType<typeof useI18n>["t"];

const buzz = (kind: "ok" | "warn"): void => {
  void Haptics.notificationAsync(kind === "ok" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
};

function clockNote(b: WireOnNowBoard, t: T): string {
  const note = clockNoteOf(b);
  if (note.key === "intro") return t("rosterOnNow.intro");
  const day = weekdayLong(note.take.startsAt, t);
  if (note.key === "noteLate") return t("rosterOnNow.noteLate", { day, time: hm(note.take.endsAt) });
  if (note.key === "noteNight") return t("rosterOnNow.noteNight", { day, time: hm(note.take.endsAt), next: weekdayLong(note.take.endsAt, t) });
  return t("rosterOnNow.noteDay", { day, time: hm(note.take.startsAt) });
}

function tillLine(d: WireBoardDepartment, b: WireOnNowBoard, t: T): string {
  const u = takeTillOf(d, b.at);
  if (u === null) return "";
  if (u.single) return t("rosterOnNow.singleUnit");
  const till = u.sameDay ? hm(u.endsAt) : `${weekdayShort(u.endsAt, t)} ${hm(u.endsAt)}`;
  return `${t("rosterOnNow.takeOf", { day: weekdayLong(u.startsAt, t) })} · ${t("rosterOnNow.tillShort", { time: till })}`;
}

function backupLine(d: WireBoardDepartment, b: WireOnNowBoard, t: T): string {
  const line = backupOf(d, b);
  if (line.key === "backup") return t("rosterOnNow.backup", { unit: line.unit });
  if (line.key === "coveredBy") return t("rosterOnNow.coveredBy", { dept: line.dept });
  return t(`rosterOnNow.${line.key}`);
}

function holeText(h: WireBoardHole, t: T): string {
  if (h.kind === "skeleton_short") {
    return t("rosterOnNow.hole.skeleton_short", { dept: h.departmentName, count: h.count ?? 0, from: hm(h.from), to: hm(h.to) });
  }
  return t(`rosterOnNow.hole.${h.kind}`, {
    dept: h.departmentName,
    position: h.positionKey === null ? "" : said(t, `rosterOnNow.position.${h.positionKey}`) ?? h.positionLabel ?? h.positionKey,
    name: h.name ?? "",
    from: hm(h.from),
    to: hm(h.to),
  });
}

function call(phone: string): void {
  void Linking.openURL(`tel:${phone}`).catch(() => undefined);
}

function Cap({ children }: { children: string }) {
  return <Text style={s.cap}>{children}</Text>;
}

/** Who is sitting in a department's OPD: name, then "in OPD till 16:00" / "from 14:00". */
function OpdList({ list, t }: { list: readonly WireOpdSitting[]; t: T }) {
  if (list.length === 0) return <Text style={s.dim}>{t("rosterOnNow.opdNobody")}</Text>;
  return (
    <View style={{ gap: 6 }}>
      {list.map((p) => (
        <View key={p.userId} testID={`opd-${p.userId}`}>
          <Text style={[s.name, !p.now && { color: color.dim, fontWeight: "500" }]}>{p.name}</Text>
          <Text style={s.small}>
            {p.designation === null || p.designation === "" ? "" : `${p.designation} · `}{p.now ? t("rosterOnNow.opdTill", { time: hm(p.till) }) : t("rosterOnNow.opdFrom", { time: hm(p.from) })}
          </Text>
        </View>
      ))}
    </View>
  );
}

function DepartmentCard({ d, b, t }: { d: WireBoardDepartment; b: WireOnNowBoard; t: T }) {
  const published = d.source === "published";
  const u = d.unitOnTake;
  const noCycle = hasNoTakeCycle(d, b);
  return (
    <View style={s.card} testID={`dept-${d.code}`}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
        <Text style={s.dept}>{d.name}</Text>
        {/* A mark is a bordered WORD, never colour alone. */}
        {d.skeleton && <Text style={[s.mark, { color: color.gold, borderColor: color.gold }]}>{t("rosterOnNow.skeleton")}</Text>}
      </View>

      <View style={s.block}>
        <Cap>{t("rosterOnNow.col.unit")}</Cap>
        {u === null
          ? <Text testID={`no-unit-${d.code}`} style={[s.unit, { color: color.red }]}>{noCycle ? t("rosterOnNow.noCycle") : t("rosterOnNow.noUnit")}</Text>
          : (
            <>
              <Text style={s.unit}>{shortUnit(u.name, d.name)}</Text>
              <Text style={s.small} testID={`till-${d.code}`}>{tillLine(d, b, t)}</Text>
            </>
          )}
      </View>

      {published ? (
        <>
          <View style={s.block}>
            <Cap>{t("rosterOnNow.col.building")}</Cap>
            {d.inTheBuilding.length === 0
              ? <Text style={[s.name, { color: color.red }]}>{t("rosterOnNow.nobodyIn")}</Text>
              : d.inTheBuilding.map((p) => (
                <View key={p.userId} style={s.person}>
                  <Text style={s.grade}>{said(t, `rosterOnNow.grade.${p.cadre}`) ?? p.cadre}</Text>
                  <Text style={[s.name, { flex: 1 }]}>{p.name}</Text>
                  {p.phone !== null && p.phone !== "" && (
                    <Pressable testID={`call-${p.userId}`} accessibilityRole="button" accessibilityLabel={t("rosterOnNow.call", { name: p.name })}
                      onPress={() => call(p.phone!)} style={({ pressed }) => [s.callBtn, pressed && { opacity: 0.7 }]}>
                      <Text style={s.callText}>{t("mobile.roster.callNumber")}</Text>
                    </Pressable>
                  )}
                </View>
              ))}
          </View>
          <View style={s.block}>
            <Cap>{t("rosterOnNow.col.faculty")}</Cap>
            {d.facultyOnCall.length === 0 ? <Text style={s.dim}>—</Text> : d.facultyOnCall.map((r, i) => (
              <Text key={r.userId ?? `vacant-${String(i)}`} style={[s.name, r.name === null && { color: color.red }]}>{r.name ?? t("rosterOnNow.vacant")}</Text>
            ))}
            {d.facultyOnCall.length > 0 && <Text style={s.small}>{isDaytime(b.at) ? t("rosterOnNow.facDay") : t("rosterOnNow.facNight")}</Text>}
          </View>
        </>
      ) : d.inOpd != null ? (
        /* 2026-10-04 (owner: only the OPD is live) — no duty roster: who is sitting in OPD, quietly. */
        <View style={s.block} testID={`in-opd-${d.code}`}>
          <Cap>{t("rosterOnNow.col.building")}</Cap>
          <OpdList list={d.inOpd} t={t} />
        </View>
      ) : (
        <View style={s.block}>
          <Note tone="warn" testID={`unpublished-${d.code}`}>
            {noCycle ? t("rosterOnNow.notPublishedNoCycle", { dept: d.name }) : t("rosterOnNow.notPublished")}
          </Note>
        </View>
      )}

      <View style={s.block}>
        <Cap>{t("rosterOnNow.col.backup")}</Cap>
        <Text style={s.small}>{backupLine(d, b, t)}</Text>
      </View>
    </View>
  );
}

function serviceNote(sv: WireBoardService, b: WireOnNowBoard, t: T): string {
  if (sv.source !== "published") return t("rosterOnNow.serviceNotPublished");
  if (sv.people.length === 0) return "";
  const dept = b.departments.find((d) => d.departmentId === sv.people[0]!.departmentId);
  return dept === undefined ? t("rosterOnNow.serviceOn") : dept.name;
}

/** "This is wrong": which department, which name, one line — a flag for the duty manager. */
function WrongSheet({ b, api, t, onClose, onSent }: { b: WireOnNowBoard; api: RosterApi; t: T; onClose: () => void; onSent: () => void }) {
  const insets = useSafeAreaInsets();
  const depts = b.departments.filter((d) => d.source === "published");
  const [deptId, setDeptId] = useState<string>(depts[0]?.departmentId ?? "");
  const d = depts.find((x) => x.departmentId === deptId);
  const people = d === undefined ? [] : flaggablePeople(d);
  const [who, setWho] = useState<string | null>(null);
  const shownWho = who !== null ? who : (people[0]?.userId ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await api.raiseFlag({ departmentId: deptId === "" ? null : deptId, userId: shownWho === "" ? null : shownWho, at: b.at, note: note.trim() });
      buzz("ok");
      onSent();
    } catch (e) {
      // Nothing is queued: the line stays typed, and the screen says it did not go.
      buzz("warn");
      setError(rosterRefusal(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <KeyboardModal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="close" />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]} testID="wrong-sheet">
        <Text style={[type.heading, { color: color.ink }]}>{t("rosterOnNow.wrong.title")}</Text>
        <Cap>{t("rosterOnNow.wrong.dept")}</Cap>
        <View style={s.pills}>
          {depts.map((x) => (
            <Pressable key={x.departmentId} testID={`wrong-dept-${x.code}`} accessibilityRole="button" onPress={() => { setDeptId(x.departmentId); setWho(null); }}
              style={[s.pill, x.departmentId === deptId && s.pillOn]}>
              <Text style={[s.pillText, x.departmentId === deptId && { color: "#f2faf6" }]}>{x.name}</Text>
            </Pressable>
          ))}
        </View>
        <Cap>{t("rosterOnNow.wrong.who")}</Cap>
        <View style={s.pills}>
          {[...people, { userId: "", name: t("rosterOnNow.wrong.nobodyNamed") }].map((p) => (
            <Pressable key={p.userId} testID={`wrong-who-${p.userId === "" ? "nobody" : p.userId}`} accessibilityRole="button" onPress={() => setWho(p.userId)}
              style={[s.pill, p.userId === shownWho && s.pillOn]}>
              <Text style={[s.pillText, p.userId === shownWho && { color: "#f2faf6" }]}>{p.name}</Text>
            </Pressable>
          ))}
        </View>
        <Cap>{t("rosterOnNow.wrong.what")}</Cap>
        <TextInput testID="wrong-note" value={note} onChangeText={setNote} maxLength={200} placeholder={t("rosterOnNow.wrong.placeholder")}
          placeholderTextColor={color.faint} style={s.input} accessibilityLabel={t("rosterOnNow.wrong.what")} />
        {error !== null && <Note tone="bad" testID="wrong-error">{error}</Note>}
        <Button testID="wrong-send" label={t("rosterOnNow.wrong.send")} busy={busy} disabled={note.trim() === ""} onPress={() => { void send(); }} />
        <Button kind="secondary" label={t("rosterOnNow.wrong.cancel")} onPress={onClose} />
        <Text style={s.small}>{t("rosterOnNow.wrong.hint")}</Text>
      </View>
    </KeyboardModal>
  );
}

function FlagRow({ f, b, api, t, onDone }: { f: WireRosterFlag; b: WireOnNowBoard; api: RosterApi; t: T; onDone: (error: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const dept = b.departments.find((d) => d.departmentId === f.departmentId)?.name ?? "";
  return (
    <View style={s.hole} testID={`flag-${f.flagId}`}>
      <Text style={s.holeWhen}>{t("rosterOnNow.flag.when", { day: shortDay(f.raisedAt, t), time: hm(f.raisedAt), by: f.raisedBy.name })}</Text>
      <Text style={s.holeText}>{f.user === null ? t("rosterOnNow.flag.textNobody", { dept, note: f.note }) : t("rosterOnNow.flag.text", { name: f.user.name, dept, note: f.note })}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.md }}>
        <Text style={s.small}>{t("rosterOnNow.flag.own")}</Text>
        {f.youMayResolve && (
          <Pressable testID={`flag-dealt-${f.flagId}`} accessibilityRole="button" disabled={busy} hitSlop={6} style={s.linkBtn}
            onPress={() => {
              setBusy(true);
              api.resolveFlag(f.flagId).then(() => { buzz("ok"); onDone(null); }).catch((e: unknown) => { buzz("warn"); onDone(rosterRefusal(e, t)); }).finally(() => setBusy(false));
            }}>
            <Text style={s.link}>{t("rosterOnNow.flag.dealt")}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function RosterOnNow() {
  const { t } = useI18n();
  const router = useRouter();
  const { call: signed } = useSession();
  const api: RosterApi = useMemo(() => rosterApi(signed), [signed]);

  const [board, setBoard] = useState<WireOnNowBoard | null>(null);
  const [ahead, setAhead] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A failed re-read keeps the last board and says how old it is; a refusal (403) is said, never retried silently.
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const b = await api.onNow(ahead ? new Date(Date.now() + AHEAD_MS).toISOString() : undefined);
      setBoard(b); setAsOf(Date.now()); setStale(false); setRefusal(null);
    } catch (e) {
      if (e instanceof NetworkError) setStale(true);
      else setRefusal(rosterRefusal(e, t));
    }
  }, [api, ahead, t]);
  useEffect(() => {
    setBoard(null); setAsOf(null); setStale(false);
    void refresh();
    const id = setInterval(() => { if (AppState.currentState !== "background") void refresh(); }, BOARD_POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const b = board;
  const fallback = b === null ? null : opdFallbackOf(b);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band
        right={
          <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={8} testID="back"
            style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
            <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} testID="roster-on-now">
        <View>
          <Text style={[type.title, { color: color.ink }]} testID="on-now-clock">{b === null ? t("rosterOnNow.title") : clockLine(b.at, t)}</Text>
          <Text style={[type.small, { color: color.dim, marginTop: 4 }]} testID="on-now-note">{b === null ? t("rosterOnNow.intro") : clockNote(b, t)}</Text>
        </View>

        <View style={s.seg} accessibilityRole="tablist" accessibilityLabel={t("rosterOnNow.when")}>
          {([false, true] as const).map((v) => (
            <Pressable key={String(v)} testID={v ? "when-ahead" : "when-now"} accessibilityRole="tab" accessibilityState={{ selected: ahead === v }}
              onPress={() => setAhead(v)} style={[s.segBtn, ahead === v && s.segOn]}>
              <Text style={[s.segText, ahead === v && { color: color.ink }]}>{t(v ? "rosterOnNow.ahead" : "rosterOnNow.now")}</Text>
            </Pressable>
          ))}
        </View>

        {refusal !== null && <Note tone="bad" testID="on-now-refusal">{refusal}</Note>}
        {stale && b !== null && asOf !== null && <Note tone="warn" testID="on-now-stale">{t("mobile.roster.stale", { time: hm(new Date(asOf).toISOString()) })}</Note>}
        {stale && b === null && (
          <View style={{ gap: space.md }}>
            <Note tone="warn" testID="on-now-offline">{t("mobile.roster.noSignal")}</Note>
            <Button kind="secondary" testID="on-now-retry" label={t("mobile.roster.retry")} onPress={() => { void refresh(); }} />
          </View>
        )}
        {b === null && !stale && refusal === null && <Text style={s.dim} testID="on-now-loading">{t("rosterOnNow.loading")}</Text>}
        {flash !== null && <Text style={s.flash} testID="on-now-flash">{flash}</Text>}
        {error !== null && <Note tone="bad" testID="on-now-error">{error}</Note>}

        {b !== null && (
          <>
            {!b.resolverEnabled && <Note tone="warn" testID="resolver-off">{t("rosterOnNow.resolverOff")}</Note>}
            {b.departments.map((d) => <DepartmentCard key={d.departmentId} d={d} b={b} t={t} />)}
            {/* 2026-10-04 (owner) — OPD doctors but no confirmed unit: a quiet card, never a hole. */}
            {(b.departmentsWithoutUnit ?? []).map((x) => (
              <View key={x.departmentId} style={[s.card, { backgroundColor: color.wash }]} testID={`dept-nounit-${x.code}`}>
                <Text style={s.dept}>{x.name}</Text>
                <Text style={[s.small, { marginTop: 2 }]}>{t("rosterOnNow.noUnitOpdOnly")}</Text>
                <View style={s.block}>
                  <Cap>{t("rosterOnNow.col.building")}</Cap>
                  <OpdList list={x.inOpd ?? []} t={t} />
                </View>
              </View>
            ))}
            {fallback !== null && <Text style={s.small} testID="on-now-opd-fallback">{t(`rosterOnNow.${fallback}`)}</Text>}
            <Text style={s.small}>{t("mobile.roster.onNowHint")}</Text>

            {b.services.length > 0 && (
              <View style={{ gap: space.sm }} testID="on-now-services">
                <Tag>{t("rosterOnNow.services")}</Tag>
                <View style={s.services}>
                  {b.services.map((sv) => {
                    const note = serviceNote(sv, b, t);
                    return (
                      <View key={sv.positionKey} style={s.service} testID={`service-${sv.positionKey}`}>
                        <Text style={s.small}>{said(t, `rosterOnNow.position.${sv.positionKey}`) ?? sv.positionLabel}</Text>
                        {sv.source === "published" && sv.people.length === 0
                          ? <Text style={[s.name, { color: color.red }]}>{t("rosterOnNow.nobodyOn")}</Text>
                          : sv.source === "published"
                            ? <Text style={s.name}>{sv.people.map((p) => p.name).join(", ")}</Text>
                            : <Text style={[s.name, { color: color.dim }]}>—</Text>}
                        {note !== "" && <Text style={s.small}>{note}</Text>}
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            <View style={[s.card, { borderColor: color.ink, borderWidth: 1.5 }]} testID="on-now-holes">
              <Text style={[type.heading, { color: color.ink }]}>{t("rosterOnNow.holes")}</Text>
              {(b.flags ?? []).map((f) => (
                <FlagRow key={f.flagId} f={f} b={b} api={api} t={t} onDone={(e) => { setError(e); void refresh(); }} />
              ))}
              {b.holes.length === 0
                ? ((b.flags ?? []).length === 0 && <Text style={[s.holeText, { color: color.green, marginTop: space.sm }]} testID="no-holes">{t("rosterOnNow.noHoles")}</Text>)
                : b.holes.map((h, i) => (
                  <View key={`${h.kind}-${h.departmentId}-${h.userId ?? ""}-${h.from}-${String(i)}`} style={s.hole} testID={`hole-${String(i)}`}>
                    <Text style={s.holeWhen}>{shortWhen(h.from, t)}</Text>
                    <Text style={s.holeText}>{holeText(h, t)}</Text>
                  </View>
                ))}
              {!ahead && (
                <View style={{ marginTop: space.md }}>
                  <Button kind="secondary" testID="wrong-open" label={t("rosterOnNow.wrong.button")} onPress={() => { setFlash(null); setError(null); setWrong(true); }} />
                </View>
              )}
            </View>

            <View style={s.card}>
              <Text style={[type.heading, { color: color.ink, fontSize: 15 }]}>{t("rosterOnNow.arrivingTitle")}</Text>
              <Text style={[s.small, { marginTop: 4 }]}>{t("rosterOnNow.arrivingText")}</Text>
            </View>

            {asOf !== null && !stale && <Text testID="on-now-asof" style={[s.small, { textAlign: "right" }]}>{t("mobile.roster.asOf", { time: hm(new Date(asOf).toISOString()) })}</Text>}
          </>
        )}
      </ScrollView>
      {wrong && b !== null && (
        <WrongSheet b={b} api={api} t={t} onClose={() => setWrong(false)}
          onSent={() => { setWrong(false); setFlash(t("mobile.roster.flagSent")); void refresh(); }} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg },
  block: { marginTop: space.md, gap: 2 },
  cap: { fontFamily: MONO, fontSize: 10.5, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: color.faint, marginBottom: 2 },
  dept: { fontSize: 18, lineHeight: 23, fontWeight: "700", color: color.ink },
  unit: { fontSize: 17, lineHeight: 22, fontWeight: "700", color: color.ink },
  name: { fontSize: 15.5, lineHeight: 21, fontWeight: "600", color: color.ink },
  small: { fontSize: 13, lineHeight: 18, color: color.dim },
  dim: { fontSize: 15, lineHeight: 21, color: color.dim },
  flash: { fontSize: 14.5, lineHeight: 20, fontWeight: "700", color: color.green },
  mark: { fontFamily: MONO, fontSize: 10.5, fontWeight: "700", letterSpacing: 0.8, borderWidth: 1.5, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden" },
  person: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TOUCH },
  grade: { fontFamily: MONO, fontSize: 11.5, fontWeight: "700", color: color.dim, minWidth: 30 },
  callBtn: { minHeight: 40, minWidth: 64, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.greenSoft, alignItems: "center", justifyContent: "center" },
  callText: { fontSize: 14, fontWeight: "700", color: color.green },
  seg: { flexDirection: "row", backgroundColor: color.wash, borderRadius: radius.md, padding: 3, gap: 3 },
  segBtn: { flex: 1, minHeight: 40, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  segOn: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line },
  segText: { fontSize: 14, fontWeight: "700", color: color.dim },
  services: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  service: { flexGrow: 1, flexBasis: "46%", backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: space.md, gap: 2 },
  hole: { marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.line2, gap: 2 },
  holeWhen: { fontFamily: MONO, fontSize: 11.5, fontWeight: "700", color: color.red },
  holeText: { fontSize: 14.5, lineHeight: 20, color: color.ink },
  link: { color: color.green, fontSize: 14, fontWeight: "700" },
  linkBtn: { minHeight: 40, justifyContent: "center", paddingHorizontal: 4 },
  scrim: { flex: 1, backgroundColor: "rgba(19,36,32,.45)" },
  sheet: { backgroundColor: color.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: space.lg, gap: space.sm },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.sm },
  pill: { minHeight: 40, justifyContent: "center", paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.card },
  pillOn: { backgroundColor: color.green, borderColor: color.green },
  pillText: { fontSize: 14, fontWeight: "700", color: color.green },
  input: { minHeight: TOUCH + 4, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: color.ink, backgroundColor: color.card, marginBottom: space.sm },
});
