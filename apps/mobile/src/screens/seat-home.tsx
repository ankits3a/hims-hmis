import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Pressable, RefreshControl, ScrollView, View } from "react-native";
import * as Haptics from "expo-haptics";
import { Text } from "../text";
import { useRouter } from "expo-router";
import { useI18n } from "../i18n";
import { useNotifications } from "../notifications";
import { seatsFor } from "../seats";
import { useSession } from "../session";
import { color, radius, space, TOUCH, type } from "../theme";
import { APP_VERSION, APP_VERSION_CODE } from "../config";
import { Band, Button, MONO, Note, Tag } from "../ui";
import { checkForUpdate, type UpdateAnswer } from "../update";
import { loadHome, type HeaderFacts, type OwnerHome } from "../home/load";
import { buildOwnerTiles, coldOwnerTiles, type OwnerTile } from "../owner/model";
import { OwnerTiles } from "../owner/tiles";
import { coldOf, homeCache, seenRequests, type ColdHome } from "../home/cache";
import { onHomeFocus, takeHomeFocus } from "../home/focus";
import { headerOf } from "../home/profile";
import { buildHome, rupees, type HomeAction, type HomeModel, type NeedCard, type Sources, type WireApproval } from "../home/model";
import { ApprovalSheet, CoverSheet, clockText } from "../home/sheets";
import { Spark } from "../home/spark";
import { RecordedCard, type RecordingReport } from "../home/recorded";
import { PaceCard, type MyPace } from "../home/pace";
import { rosterApi } from "../roster/api";
import { clockWords, type NeedKind, type Tone } from "../home/rules";

/** Refreshed while the app is in front: every 30 s, and whenever it comes back to the front. */
const REFRESH_MS = 30_000;
/** The last home this phone drew, kept while the app is open — shown with "as of" when the network drops. */
let lastHome: { sources: Sources; at: number; user: string; header: HeaderFacts; unread: number | null; recording?: RecordingReport | null; owner?: OwnerHome | null; pace?: MyPace | null } | null = null;
export function _forgetHomeForTests(): void { lastHome = null; void homeCache.clear(); }

const TONE: Record<Tone, { edge: string; bg: string; fg: string }> = {
  red: { edge: color.red, bg: color.redSoft, fg: color.red },
  amber: { edge: color.gold, bg: color.goldSoft, fg: "#8a5a10" },
  neutral: { edge: color.faint, bg: color.wash, fg: color.dim },
};
const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

/**
 * APP HOME — "My day" (owner 2026-10-07, decision 0042; board: the app-home board). Top to bottom:
 * what NEEDS YOU NOW with its clock, how MY DAY is going, the LAST 30 DAYS, then MY WORK — every
 * screen this person's role allows, which is the list this screen used to be and nothing is removed.
 */
/**
 * A cashier's Collected before the drawer is counted (blind count, decision 0042): no amount — the
 * words on one line and the receipt count small under them, so the tile reads like its neighbours.
 */
function LockedTile({ t, n, testID }: { t: (key: string, vars?: Record<string, string | number>) => string; n: string | number | undefined; testID?: string }) {
  return (
    <View testID={testID} accessible accessibilityLabel={`${t("home.tile.afterCount")} · ${t("home.tile.receiptsCount", { n: n ?? 0 })}`}>
      <Text style={{ fontSize: 13, lineHeight: 16, fontWeight: "700", color: color.ink }} numberOfLines={2}>{t("home.tile.afterCount")}</Text>
      <Text style={{ fontFamily: MONO, fontSize: 11, color: color.faint, marginTop: 1 }} numberOfLines={1}>{t("home.tile.receiptsCount", { n: n ?? 0 })}</Text>
    </View>
  );
}

export function SeatHome() {
  const { t } = useI18n();
  const router = useRouter();
  const { state, logout, fetcher, call } = useSession();
  const signedIn = state.status === "signedIn";
  const me = signedIn ? state.me : null;
  const user = signedIn ? state.me.actor.id : "";
  const permissions = useMemo(() => me?.permissions.hospital ?? [], [me]);
  const seatKeys = useMemo(() => (me === null ? [] : seatsFor(me.permissions).map((s) => s.key)), [me]);
  const [home, setHome] = useState<{ sources: Sources; at: number; header: HeaderFacts; unread: number | null; recording?: RecordingReport | null; owner?: OwnerHome | null; pace?: MyPace | null } | null>(() => (lastHome !== null && lastHome.user === user ? lastHome : null));
  /** What this phone last drew before it was closed — counts only, shown when nothing can be read (`home/cache.ts`). */
  const [cold, setCold] = useState<ColdHome | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  const [focus, setFocus] = useState<NeedKind | null>(null);
  const [cover, setCover] = useState<{ requestId: string; accept: boolean; who: string } | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [open30, setOpen30] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [sheet, setSheet] = useState<WireApproval | null>(null);
  const [said, setSaid] = useState<{ tone: "info" | "bad"; text: string } | null>(null);
  const [busyCover, setBusyCover] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async (byHand = false) => {
    if (!signedIn) return;
    if (byHand) setRefreshing(true);
    const now = Date.now();
    const loaded = await loadHome(call, permissions, seatKeys, now);
    if (!alive.current) return;
    if (loaded.reached) {
      lastHome = { sources: loaded.sources, at: now, user, header: loaded.header, unread: loaded.unread, recording: loaded.recording, owner: loaded.owner, pace: loaded.pace };
      setHome(lastHome); setOnline(true);
      /* The owner's tiles are kept as a key and a number each — no sub-line, no name (`coldOwnerTiles`). */
      void homeCache.save(coldOf(user, now, buildHome({ ...loaded.sources, nowMs: now }), loaded.owner === null ? null : coldOwnerTiles(buildOwnerTiles(loaded.owner.keys, loaded.owner.reads))));
    } else {
      setOnline(false);
    }
    if (byHand) setRefreshing(false);
  }, [signedIn, call, permissions, seatKeys, user]);
  useEffect(() => {
    if (user === "") return;
    let gone = false;
    void homeCache.load(user).then((c) => { if (!gone) setCold(c); });
    void seenRequests.load().then((ids) => { if (!gone) setSeen(ids); });
    const take = (): void => { const k = takeHomeFocus(); if (k !== null) setFocus(k); };
    take();
    const off = onHomeFocus(take);
    return () => { gone = true; off(); };
  }, [user]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => { if (AppState.currentState === "active") void refresh(); }, REFRESH_MS);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void refresh(); });
    return () => { alive.current = false; clearInterval(timer); sub.remove(); };
  }, [refresh]);
  const model: HomeModel | null = useMemo(() => (home === null ? null : buildHome({ ...home.sources, seenRequests: seen, nowMs: online ? Date.now() : home.at })), [home, online, seen]);
  /* The owner's and the Medical Superintendent's home: tiles in place of the blocks under "Needs you now" (owner 2026-10-09). */
  const ownerTiles: OwnerTile[] | null = useMemo(() => (home?.owner == null ? null : buildOwnerTiles(home.owner.keys, home.owner.reads)), [home]);
  /* A notification about approvals, and exactly one waiting: its sheet opens — the tap said which. */
  useEffect(() => {
    if (focus !== "approval" || home === null) return;
    const waiting = home.sources.approvals ?? [];
    if (waiting.length === 1 && permissions.includes("approvals.requests.decide")) { setSheet(waiting[0]!); setFocus(null); }
  }, [focus, home, permissions]);

  const act = useCallback(async (a: HomeAction) => {
    setSaid(null);
    if (a.type === "seat") { router.push({ pathname: "/seat/[key]", params: { key: a.key } }); return; }
    if (a.type === "paper") { router.push("/paper"); return; }
    if (a.type === "say") { setSaid({ tone: "info", text: t(a.key) }); return; }
    if (a.type === "seen") { setSeen(await seenRequests.add(a.id, seen)); return; }
    if (a.type === "approval") { setSheet(home?.sources.approvals?.find((x) => x.id === a.id) ?? null); return; }
    if (!online) { setSaid({ tone: "bad", text: t("home.offline.noApproval") }); return; }
    /* Yes or no, the answer opens its sheet: a "no" needs a reason the colleague will read (decision 0043). */
    const asked = home?.sources.duties?.requests.find((r) => r.requestId === a.requestId);
    setCoverError(null);
    setCover({ requestId: a.requestId, accept: a.accept, who: asked?.requestedBy.name ?? "" });
  }, [router, t, home, online, seen]);
  const sendCover = useCallback(async (note: string) => {
    if (cover === null) return;
    setBusyCover(cover.requestId); setCoverError(null);
    try {
      await rosterApi(call).answerCover(cover.requestId, cover.accept, note);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setSaid({ tone: "info", text: t(cover.accept ? "home.cover.accepted" : "home.cover.declined") });
      setCover(null);
      await refresh();
    } catch {
      setCoverError(t("home.cover.failed"));
    } finally { setBusyCover(null); }
  }, [cover, call, t, refresh]);

  const push = useNotifications();
  /*
    THE UPDATE OFFER (no app store, owner 2026-10-05). Asked once when this screen opens, quietly:
    "unknown" — no signal, or the feed is not served — shows nothing at all. Asked again by hand
    from the row at the foot, and THAT answer is always said, whichever it is.
  */
  const [update, setUpdate] = useState<UpdateAnswer | null>(null);
  const [asked, setAsked] = useState<"no" | "checking" | "yes">("no");
  const [later, setLater] = useState(false);
  useEffect(() => {
    let gone = false;
    void checkForUpdate(fetcher).then((a) => { if (!gone) setUpdate(a); });
    return () => { gone = true; };
  }, [fetcher]);
  const checkNow = useCallback(async () => {
    setAsked("checking");
    setUpdate(await checkForUpdate(fetcher));
    setLater(false);
    setAsked("yes");
  }, [fetcher]);
  if (state.status !== "signedIn") return null;
  const seats = seatsFor(state.me.permissions);
  const who = headerOf(state.me.profile, state.username, home?.header ?? null, t);
  const needs = model === null ? [] : showAll ? model.allNeeds : model.needs;
  const badgeOf = (key: string) => model?.work.find((w) => w.key === key) ?? null;

  const needCard = (n: NeedCard) => {
    const tone = TONE[n.tone];
    const what = n.titleVars?.what;
    const titleVars = typeof what === "string" && what.startsWith("home.kind.") ? { ...n.titleVars, what: t(what, { amount: String(n.titleVars?.amount ?? "") }).replace(/\s{2,}/g, " ").trim() } : n.titleVars;
    const lit = focus === n.kind;
    return (
      <View key={n.id} testID={`need-${n.kind}`} accessibilityLabel={n.id} accessibilityState={{ selected: lit }}
        style={{ backgroundColor: color.card, borderWidth: lit ? 2 : 1, borderColor: lit ? color.green : color.line, borderLeftWidth: 4, borderLeftColor: tone.edge, borderRadius: radius.lg, padding: space.md, flexDirection: "row", gap: space.md, alignItems: "center" }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: color.ink, fontSize: 15, fontWeight: "600" }}>
            {n.count !== null && <Text style={{ fontFamily: MONO, fontSize: 20, fontWeight: "700" }}>{`${String(n.count)} `}</Text>}
            {t(n.titleKey, titleVars).trim()}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            {(n.subKey !== null || (n.subText ?? null) !== null) && (
              <Text style={[type.small, { color: color.dim }]}>{[n.subKey === null ? null : t(n.subKey, n.subVars), n.subText ?? null].filter((x) => x !== null && x !== "").join(" · ")}</Text>
            )}
            {n.clock !== null && (
              <View style={{ backgroundColor: tone.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                <Text testID={`need-clock-${n.kind}`} style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: "700", color: tone.fg }}>{clockText(t, n.clock)}</Text>
              </View>
            )}
          </View>
        </View>
        <View style={{ gap: 6 }}>
          {n.actions.map((a) => (
            <Pressable key={a.labelKey} testID={`need-act-${n.kind}-${a.labelKey.split(".").pop() ?? ""}`} accessibilityRole="button"
              disabled={a.action.type === "cover" && busyCover !== null}
              onPress={() => { void act(a.action); }}
              style={({ pressed }) => ({ minHeight: 40, minWidth: 72, paddingHorizontal: space.md, borderRadius: radius.md, alignItems: "center", justifyContent: "center", borderWidth: 1,
                borderColor: a.primary ? color.green : color.line, backgroundColor: a.primary ? color.green : color.card, opacity: pressed ? 0.85 : 1 })}>
              <Text style={{ fontSize: 13, fontWeight: "700", color: a.primary ? "#f2faf6" : color.ink }}>{t(a.labelKey)}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  };
  const label = (key: string, right?: React.ReactNode) => (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: space.md, marginBottom: 6 }}>
      <Text style={[type.tag, { color: color.faint, fontFamily: MONO }]}>{t(key)}</Text>
      {right}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band
        right={
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {/* The bell, as on the board: what the server has told this person, with how many they have not read. */}
            <Pressable onPress={() => router.push("/alerts")} accessibilityRole="button" accessibilityLabel={t("home.bell.label", { n: home?.unread ?? 0 })} hitSlop={8} testID="home-bell"
              style={{ minHeight: 32, minWidth: 40, paddingHorizontal: 8, justifyContent: "center", alignItems: "center" }}>
              <Text style={{ fontSize: 16 }}>🔔</Text>
              {(home?.unread ?? 0) > 0 && (
                <View style={{ position: "absolute", top: 0, right: 0, backgroundColor: color.red, borderRadius: 9, minWidth: 18, paddingHorizontal: 4, alignItems: "center" }}>
                  <Text testID="home-bell-count" style={{ color: "#fff", fontFamily: MONO, fontSize: 10.5, fontWeight: "700" }}>{(home?.unread ?? 0) > 99 ? "99+" : String(home?.unread ?? 0)}</Text>
                </View>
              )}
            </Pressable>
            <Pressable onPress={() => { void homeCache.clear(); void logout(); }} accessibilityRole="button" hitSlop={8} testID="logout"
              style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
              <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("app.logout")}</Text>
            </Pressable>
          </View>
        }
      />
      <ScrollView testID="home-scroll" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(true); }} tintColor={color.green} />}>
        {update?.kind === "update" && !later && (
          <View testID="update-offer" style={{ backgroundColor: color.card, borderWidth: 2, borderColor: color.green, borderRadius: radius.lg, padding: space.lg, marginBottom: space.lg, gap: space.sm }}>
            <Text style={[type.heading, { color: color.ink }]}>{t("mobile.update.title")}</Text>
            <Text style={[type.small, { color: color.dim }]}>{t("mobile.update.body", { version: update.latest.versionName, current: APP_VERSION })}</Text>
            {update.latest.notes !== undefined && <Text testID="update-notes" style={[type.body, { color: color.ink }]}>{update.latest.notes}</Text>}
            <Text style={[type.small, { color: color.faint }]}>{t("mobile.update.howTo")}</Text>
            <Button testID="update-get" label={t("mobile.update.get")} onPress={() => { void Linking.openURL(update.url).catch(() => undefined); }} />
            <Button testID="update-later" kind="secondary" label={t("mobile.update.later")} onPress={() => setLater(true)} />
          </View>
        )}
        {/*
          M6b — THE ONE TIME NOTIFICATIONS ARE OFFERED UNINVITED: once, here, after sign-in, when they
          could be on and the person has never been asked. It says what a notification will and will
          not contain BEFORE the phone's own prompt can open; "Not now" is remembered.
        */}
        {push.offer && (
          <View testID="push-offer" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.greenLine, borderRadius: radius.lg, padding: space.lg, marginBottom: space.lg, gap: space.sm }}>
            <Text style={[type.heading, { color: color.ink }]}>{t("mobile.push.offerTitle")}</Text>
            <Text style={[type.small, { color: color.dim }]}>{t("mobile.push.promise")}</Text>
            <Button testID="push-offer-on" busy={push.busy} label={t("mobile.push.turnOn")} onPress={() => { void push.enable(); }} />
            <Button testID="push-offer-later" kind="secondary" label={t("mobile.push.notNow")} onPress={push.dismissOffer} />
          </View>
        )}
        {push.problem !== null && !push.offer && push.status !== "on" && <Note tone="warn" testID="push-home-problem">{t(push.problem)}</Note>}
        <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md }}>
          <Text testID="home-name" style={[type.title, { color: color.ink, flex: 1 }]} numberOfLines={1}>{who.name}</Text>
          {home !== null && <Text testID="home-as-of" style={{ fontFamily: MONO, fontSize: 11, color: color.faint }}>{online ? hhmm(home.at) : t("home.asOf", { time: hhmm(home.at) })}</Text>}
          {home === null && cold !== null && !online && <Text testID="home-as-of" style={{ fontFamily: MONO, fontSize: 11, color: color.faint }}>{t("home.asOf", { time: hhmm(cold.at) })}</Text>}
        </View>
        {/* What they are here as — a department and unit, a desk, the hospital. The username stays reachable on the Account screen. */}
        <Text style={[type.small, { color: color.dim }]} testID="signed-in-as">
          {who.line ?? t("mobile.signedInAs", { name: state.username || state.me.actor.id })}
        </Text>
        {!online && <View style={{ marginTop: space.sm }}><Note tone="warn" testID="home-offline">{t(home === null && cold === null ? "home.offline.nothing" : "home.offline.banner")}</Note></View>}
        {/* Cold and offline: the last numbers this phone drew, counts only, and nothing to tap. */}
        {model === null && cold !== null && !online && (
          <View testID="home-cold" style={{ gap: space.sm }}>
            {label("home.now")}
            {cold.cards.length === 0 ? (
              <View style={{ backgroundColor: color.card, borderWidth: 1, borderStyle: "dashed", borderColor: color.line, borderRadius: radius.lg, padding: space.lg, alignItems: "center" }}>
                <Text style={{ color: color.ink, fontSize: 15, fontWeight: "700" }}>{t("home.calm")}</Text>
              </View>
            ) : cold.cards.map((c, i) => (
              <View key={`${c.kind}:${String(i)}`} testID={`cold-${c.kind}`} style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderLeftWidth: 4, borderLeftColor: TONE[c.tone].edge, borderRadius: radius.lg, padding: space.md, gap: 4 }}>
                <Text style={{ color: color.ink, fontSize: 15, fontWeight: "600" }}>
                  {c.count !== null && <Text style={{ fontFamily: MONO, fontSize: 20, fontWeight: "700" }}>{`${String(c.count)} `}</Text>}
                  {t(c.titleKey, { name: "", amount: "", what: "" }).replace(/\s*·\s*$/, "").trim()}
                </Text>
                <Text style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: "700", color: TONE[c.tone].fg }}>{clockText(t, clockWords(cold.at, c.sinceMs, c.dueMs))}</Text>
              </View>
            ))}
            {cold.tiles.length > 3 && label("owner.today")}
            {cold.tiles.length > 3 && (
              <OwnerTiles t={t} tiles={cold.tiles.map((c) => ({ key: c.key as OwnerTile["key"], labelKey: c.labelKey, value: c.value ?? "—", failed: c.value === "—", sub: null, tone: "plain", wide: c.key === "learning" }))} />
            )}
            {cold.tiles.length > 0 && cold.tiles.length <= 3 && label("home.day")}
            {cold.tiles.length > 0 && cold.tiles.length <= 3 && (
              <View style={{ flexDirection: "row", gap: space.sm }}>
                {cold.tiles.map((tile) => (
                  <View key={tile.key} style={{ flex: 1, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: space.md }}>
                    {tile.value === null
                      ? <LockedTile t={t} n={tile.lockVars?.n} />
                      : <Text style={{ fontFamily: MONO, fontWeight: "700", fontSize: tile.value.length > 5 ? 16 : 22, color: color.ink }} numberOfLines={1}>{tile.value}</Text>}
                    <Text style={{ fontSize: 11.5, color: color.dim, marginTop: 2 }}>{t(tile.labelKey)}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
        {said !== null && <View style={{ marginTop: space.sm }}><Note tone={said.tone} testID="home-said">{said.text}</Note></View>}

        {model !== null && (
          <View testID="home" style={{ gap: space.sm }}>
            {label("home.now", model.needsHidden > 0 || showAll ? (
              <Pressable testID="needs-all" accessibilityRole="button" hitSlop={8} onPress={() => setShowAll((v) => !v)}>
                <Text style={{ color: color.green, fontSize: 12.5, fontWeight: "700" }}>{showAll ? t("home.fewer") : t("home.all", { n: model.needsTotal })}</Text>
              </Pressable>
            ) : undefined)}
            {model.needsTotal === 0 ? (
              <View testID="home-calm" style={{ backgroundColor: color.card, borderWidth: 1, borderStyle: "dashed", borderColor: color.line, borderRadius: radius.lg, padding: space.lg, alignItems: "center" }}>
                <Text style={{ color: color.ink, fontSize: 15, fontWeight: "700" }}>{t("home.calm")}</Text>
                <Text style={[type.small, { color: color.dim }]}>{t("home.calmHint")}</Text>
              </View>
            ) : needs.map(needCard)}

            {ownerTiles !== null && label("owner.today")}
            {ownerTiles !== null && (
              <OwnerTiles tiles={ownerTiles} t={t} onOpen={(key) => router.push({ pathname: "/owner/[page]", params: { page: key } })} />
            )}

            {ownerTiles === null && model.tiles.length > 0 && label("home.day")}
            {ownerTiles === null && model.tiles.length > 0 && (
              <View style={{ flexDirection: "row", gap: space.sm }}>
                {model.tiles.map((tile) => (
                  <View key={tile.key} testID={`tile-${tile.key}`} style={{ flex: 1, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: space.md }}>
                    {tile.value === null
                      ? <LockedTile t={t} n={tile.lockVars?.n} testID="tile-locked" />
                      : <Text style={{ fontFamily: MONO, fontWeight: "700", fontSize: tile.value.length > 5 ? 16 : 22, color: color.ink }} numberOfLines={1} adjustsFontSizeToFit>{tile.value}</Text>}
                    <Text style={{ fontSize: 11.5, color: color.dim, marginTop: 2 }}>{t(tile.labelKey)}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* My pace, under "My day" — a doctor only; the owner's home is untouched (no measure is sent to it). */}
            <PaceCard pace={home?.pace ?? null} t={t} onOpen={() => router.push("/pace")} />

            {ownerTiles === null && (
              <RecordedCard
                r={home?.recording ?? null} seats={seatKeys} permissions={permissions} t={t}
                onScan={() => router.push({ pathname: "/seat/[key]", params: { key: "slips" } })}
                onByDoctor={() => router.push("/recording")}
              />
            )}

            {ownerTiles === null && model.hospital !== null && model.hospital.byDepartment.length > 0 && (
              <View testID="home-departments" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 }}>
                  <Text style={{ fontSize: 13.5, fontWeight: "700", color: color.ink }}>{t("home.owner.byDept")}</Text>
                  <Text style={[type.small, { color: color.dim }]}>{String(model.hospital.byDepartment.reduce((n, d) => n + d.value, 0))}</Text>
                </View>
                {model.hospital.byDepartment.slice(0, 8).map((d) => (
                  <View key={d.name} style={{ paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.line2 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ fontSize: 13, color: color.ink }}>{d.name}</Text>
                      <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: "700", color: color.ink }}>{String(d.value)}</Text>
                    </View>
                    <View style={{ height: 5, borderRadius: 3, backgroundColor: color.wash, marginTop: 4 }}>
                      <View style={{ height: 5, borderRadius: 3, backgroundColor: color.green, width: `${Math.round((d.value / model.hospital!.byDepartment[0]!.value) * 100)}%` as `${number}%` }} />
                    </View>
                  </View>
                ))}
              </View>
            )}
            {ownerTiles === null && model.onDuty.length > 0 && (
              <View testID="home-on-duty" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm }}>
                <Text style={{ fontSize: 13.5, fontWeight: "700", color: color.ink, paddingVertical: 6 }}>{t("home.owner.onDuty")}</Text>
                {model.onDuty.map((d) => (
                  <View key={d.line} style={{ paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.line2 }}>
                    <Text style={{ fontSize: 13, color: color.ink }}>{d.line}</Text>
                    <Text style={{ fontSize: 11.5, color: color.faint }}>{d.who ?? t("home.owner.nobody")}</Text>
                  </View>
                ))}
              </View>
            )}
            {model.team.length > 0 && (
              <View testID="home-team" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 }}>
                  <Text style={{ fontSize: 13.5, fontWeight: "700", color: color.ink }}>{t("home.team.title")}</Text>
                  <Text style={[type.small, { color: color.dim }]}>{t("home.team.people", { n: model.team.length })}</Text>
                </View>
                {model.team.map((m) => (
                  <View key={m.userId} testID={`team-${m.userId}`} style={{ paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.line2 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ fontSize: 13, color: color.ink }}>{m.name}</Text>
                      <Text style={{ fontFamily: MONO, fontSize: 12.5, color: color.dim }}>{m.fact === null ? t("home.team.nothing") : t("home.team.line", { what: t(`home.team.unit.${m.fact.replace(".", "_")}`), today: m.primary, month: m.month })}</Text>
                    </View>
                    <View style={{ height: 5, borderRadius: 3, backgroundColor: color.wash, marginTop: 4 }}>
                      <View style={{ height: 5, borderRadius: 3, backgroundColor: color.green, width: `${Math.round(m.ratio * 100)}%` as `${number}%` }} />
                    </View>
                  </View>
                ))}
                <Text style={{ fontSize: 11.5, color: color.faint, paddingVertical: 6 }}>{t("home.team.bars")}</Text>
              </View>
            )}

            {ownerTiles === null && model.analytics !== null && (
              <View testID="home-30" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md }}>
                <Pressable testID="home-30-toggle" accessibilityRole="button" onPress={() => setOpen30((v) => !v)} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 32 }}>
                  <Text style={{ fontSize: 13.5, fontWeight: "700", color: color.ink }}>
                    {t(model.analytics.titleKey)}
                    {model.analytics.pct !== null && <Text style={{ color: model.analytics.pct >= 0 ? color.green : color.red }}>{`  ${model.analytics.pct >= 0 ? "▲" : "▼"} ${String(Math.abs(model.analytics.pct))}%`}</Text>}
                  </Text>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: color.green }}>{t(open30 ? "home.d30.close" : "home.d30.open")}</Text>
                </Pressable>
                <Spark testID="home-spark" series={model.analytics.series} width={300} height={open30 ? 86 : 40} />
                {open30 && (
                  <View testID="home-30-open">
                    {[
                      ["home.d30.week", model.analytics.week],
                      ["home.d30.usual", model.analytics.usual],
                      ["home.d30.best", model.analytics.best === null ? null : `${model.analytics.money ? rupees(model.analytics.best.value) : String(model.analytics.best.value)} · ${model.analytics.best.day.slice(8)}/${model.analytics.best.day.slice(5, 7)}`],
                      ["home.d30.total", model.analytics.total],
                    ].filter((r) => r[1] !== null).map((r) => (
                      <View key={r[0]} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.line2 }}>
                        <Text style={[type.small, { color: color.dim }]}>{t(r[0]!)}</Text>
                        <Text style={{ fontSize: 13, fontWeight: "700", color: color.ink }}>{r[1]}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>
        )}

        {label("home.work")}
        {seats.length === 0 && <Note tone="info" testID="no-seats">{t("mobile.none")}</Note>}
        {seats.map((seat) => (
          <Pressable
            key={seat.key}
            testID={`seat-${seat.key}`}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/seat/[key]", params: { key: seat.key } })}
            style={({ pressed }) => ({
              minHeight: TOUCH + 24,
              backgroundColor: pressed ? color.wash : color.card,
              borderWidth: 1,
              borderColor: color.line,
              borderRadius: radius.lg,
              padding: space.lg,
              marginBottom: space.md,
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
            })}
          >
            <View style={{ width: 8, alignSelf: "stretch", borderRadius: 4, backgroundColor: color.green }} />
            <View style={{ flex: 1 }}>
              <Text style={[type.heading, { color: color.ink }]}>{t(`screen.${seat.key}.title`)}</Text>
              {(() => { const b = badgeOf(seat.key); return b === null || b.badgeKey === null
                ? <Text style={[type.small, { color: color.dim, marginTop: 2 }]}>{t(`screen.${seat.key}.hint`)}</Text>
                : <Text testID={`seat-badge-${seat.key}`} style={[type.small, { color: b.live ? color.green : color.dim, fontWeight: b.live ? "700" : "400", marginTop: 2 }]}>{t(b.badgeKey, b.badgeVars)}</Text>; })()}
            </View>
            <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
          </Pressable>
        ))}
        <Pressable testID="account-open" accessibilityRole="button" onPress={() => router.push("/account")}
          style={({ pressed }) => ({ minHeight: TOUCH, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, backgroundColor: pressed ? color.wash : color.card })}>
          <Text style={[type.body, { color: color.ink, fontWeight: "600", flex: 1 }]}>{t("mobile.account.open")}</Text>
          <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
        </Pressable>
        <View style={{ marginTop: space.md, gap: 6 }}>
          <Tag tone="faint">{`HMIS ${t("login.product")}`}</Tag>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.md }}>
            <Text testID="app-version" style={[type.small, { color: color.faint, fontFamily: MONO }]}>{t("mobile.update.version", { version: APP_VERSION, code: APP_VERSION_CODE })}</Text>
            <Pressable testID="update-check" accessibilityRole="button" hitSlop={8} disabled={asked === "checking"} onPress={() => { void checkNow(); }}
              style={{ minHeight: 36, justifyContent: "center" }}>
              <Text style={{ color: color.green, fontSize: 13, fontWeight: "700" }}>{t(asked === "checking" ? "mobile.update.checking" : "mobile.update.check")}</Text>
            </Pressable>
          </View>
          {asked === "yes" && update?.kind === "latest" && <Text testID="update-latest" style={[type.small, { color: color.dim }]}>{t("mobile.update.latest", { version: APP_VERSION })}</Text>}
          {asked === "yes" && update?.kind === "unknown" && <Text testID="update-unknown" style={[type.small, { color: color.dim }]}>{t("mobile.update.failed")}</Text>}
        </View>
      </ScrollView>
      {cover !== null && (
        <CoverSheet who={cover.who} accept={cover.accept} online={online} busy={busyCover !== null} error={coverError}
          onClose={() => { if (busyCover === null) setCover(null); }} onSend={(note) => { void sendCover(note); }} />
      )}
      {sheet !== null && home !== null && (
        <ApprovalSheet approval={sheet} call={call} online={online} nowMs={Date.now()} onClose={() => setSheet(null)}
          onDone={(verdict) => {
            setSheet(null);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
            setSaid({ tone: "info", text: t(verdict === "approved" ? "home.sheet.approved" : "home.sheet.declined") });
            void refresh();
          }} />
      )}
    </View>
  );
}
