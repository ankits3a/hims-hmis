import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../api";
import { doctorApi, type DoctorApi } from "../doctor/api";
import { PatientBrief, type BriefGroup } from "../doctor/brief";
import { ConsultScreen } from "./consult";
import {
  LONG_WAIT_MINUTES, SKIP_REASONS, ageSexOf, besideName, completionBody, followUpChoices, isUnpaid, longestWait, parkedSince, rowName,
  unissuedRxRows, visitKind, waitMinutes,
} from "../doctor/rules";
import type { WireFollowUpConfig, WireQueueDoctor, WireQueueEntryView, WireQueuePatient, WireQueueView, WireSkipReason } from "../doctor/rules";
import { useI18n } from "../i18n";
import { guardianWho } from "../vitals/guardian";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, Button, MONO, Note, Tag } from "../ui";
import { refusalText } from "../vitals/api";
import { istClock, todayIst } from "../vitals/rules";

/**
 * THE DOCTOR'S OPD LINE, ON A PHONE (plan M3; owner 2026-10-06; board `OpdDesk`). The web
 * consultation screen's line and its acts, on the same server routes and under the same guards —
 * `opd.queue.operate` for the call, `opd.consult` and `requireTreatingDoctor` for every act on a
 * visit. Nothing is decided on the phone:
 *
 *   the line        `GET /opd/queues` for MY doctor profile today, re-read every few seconds; the
 *                   order, who is callable, who is held for the bill and who fell out are the
 *                   server's lists, shown as sent
 *   call / recall   `call-next` takes the engine's head; the called token can be said again,
 *                   skipped WITH a reason, started
 *   the brief       ../doctor/brief.tsx — what the desks already entered about the patient
 *   start, park,    the consultation's state moves; a completion from the phone sends NO note, so
 *   resume,         what was saved on the computer is untouched, and it is refused here — and by
 *   complete        the server since M4 — while a prescription typed there is still unissued
 *
 * Writing the note and an e-prescription stays on the computer: its allergy, interaction and
 * duplicate checks, the coded diagnosis and the stock substitution are that screen's, and a phone
 * version needs its own board. A paper prescription is photographed at the slip desk (M2).
 */
export const QUEUE_POLL_MS = 5_000;
type T = ReturnType<typeof useI18n>["t"];
type Open = { encounterId: string; patientId: string; tokenNo: number; summary: WireQueuePatient | null };

const buzz = (kind: "ok" | "warn"): void => {
  void Haptics.notificationAsync(kind === "ok" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
};

function Row({ e, t, now, right, below, tone, onPress, testID }: {
  e: WireQueueEntryView; t: T; now: Date; right?: React.ReactNode; below?: React.ReactNode; tone?: "next" | "plain"; onPress: () => void; testID: string;
}) {
  const name = rowName(e.patient);
  const demo = ageSexOf(e.patient, now);
  const kind = visitKind(e);
  const marks: { text: string; fg: string }[] = [];
  if (e.encounter.dangerFlagged || e.danger) marks.push({ text: t("mobile.doctor.dangerRow"), fg: color.red });
  if (isUnpaid(e)) marks.push({ text: t("mobile.doctor.unpaidRow"), fg: color.red });
  // Owner 2026-10-07 — the guardian came with the reports; no vitals were taken. The web row's tag, in words.
  const absent = e.encounter.patientAbsent ?? null;
  if (absent !== null) marks.push({ text: t("patientAbsent.tag", { who: guardianWho(t, absent) }), fg: "#8a5a10" });
  return (
    <View testID={testID} style={[s.rowCard, tone === "next" && { backgroundColor: color.greenSoft, borderColor: color.greenLine }]}>
      <Pressable testID={`${testID}-open`} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}>
        <Text style={s.rowTok}>{e.tokenNo}</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.rowName} numberOfLines={1}>
            {name.text ?? t(name.sealed ? "mobile.doctor.sealed" : "mobile.doctor.noName")}
            {demo !== null && <Text style={s.rowDemo}> · {demo}</Text>}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 2 }}>
            <Text style={s.rowLine} numberOfLines={1}>{t(`opdConsultV2.vtShort.${kind}`)}</Text>
            {marks.map((m) => (
              // A mark is a bordered WORD, never colour alone.
              <Text key={m.text} style={[s.mark, { color: m.fg, borderColor: m.fg }]}>{m.text}</Text>
            ))}
          </View>
        </View>
        {right}
      </Pressable>
      {below !== undefined && <View style={s.rowBelow}>{below}</View>}
    </View>
  );
}

function Wait({ e, now, t }: { e: WireQueueEntryView; now: Date; t: T }) {
  const min = waitMinutes(e, now);
  const long = min >= LONG_WAIT_MINUTES;
  return <Text testID={`wait-${e.tokenNo}`} style={[s.wait, long && { color: color.red, fontWeight: "700" }]}>{t("mobile.doctor.wait", { min })}</Text>;
}

function Sheet({ title, children, onClose, testID }: { title: string; children: React.ReactNode; onClose: () => void; testID: string }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="close" />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]} testID={testID}>
        <Text style={[type.heading, { color: color.ink }]}>{title}</Text>
        {children}
      </View>
    </Modal>
  );
}

export function DoctorQueue() {
  const { t } = useI18n();
  const router = useRouter();
  const { call } = useSession();
  const api: DoctorApi = useMemo(() => doctorApi(call), [call]);
  const today = todayIst();

  const [me, setMe] = useState<WireQueueDoctor | null>(null);
  const [boot, setBoot] = useState<"loading" | "ready" | "not_a_doctor" | "offline">("loading");
  const [view, setView] = useState<WireQueueView | null>(null);
  const [read, setRead] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [unit, setUnit] = useState<string | null>(null);
  const [cfg, setCfg] = useState<WireFollowUpConfig | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [skipping, setSkipping] = useState<WireQueueEntryView | null>(null);
  const [skipReason, setSkipReason] = useState<WireSkipReason>("absent");
  const [skipNote, setSkipNote] = useState("");
  const [opening, setOpening] = useState<WireQueueEntryView | null>(null);
  const [unpaidReason, setUnpaidReason] = useState("");
  const [completing, setCompleting] = useState<Open | null>(null);
  const [followUp, setFollowUp] = useState<number | null>(null);
  const [testsOrdered, setTestsOrdered] = useState(false);
  /** The consultation in hand shows the consult screen; this holds the one visit whose history (the brief) was asked for instead. */
  const [historyOf, setHistoryOf] = useState<string | null>(null);

  const say = useCallback((text: string) => {
    setFlash(text);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 5_000);
  }, []);
  useEffect(() => () => { if (flashTimer.current !== null) clearTimeout(flashTimer.current); }, []);

  // ——— boot: am I a doctor? ———
  const loadMe = useCallback(async () => {
    setBoot("loading");
    try {
      const d = await api.me();
      setMe(d);
      setBoot("ready");
      // The label beside my own name, and the follow-up choices: both optional reads. A login that
      // may not read one gets the name alone / the default follow-up alone — never an error.
      api.doctorUnits(today).then((u) => setUnit(u.find((x) => x.userId === d.userId)?.short ?? null)).catch(() => undefined);
      api.config().then((c) => setCfg({ followUpDefaultDays: c.followUpDefaultDays, followUpExtensionDays: c.followUpExtensionDays })).catch(() => undefined);
    } catch (e) {
      // 404 is the ANSWER "this user has no doctor profile", not a transport error (web erratum E3).
      setBoot(e instanceof ApiError && e.status === 404 ? "not_a_doctor" : "offline");
    }
  }, [api, today]);
  useEffect(() => { void loadMe(); }, [loadMe]);

  // ——— the line, re-read while the app is in front; a failed read keeps the last list and its time ———
  const doctorId = me?.id ?? null;
  const refresh = useCallback(async (): Promise<void> => {
    if (doctorId === null) return;
    try {
      const q = await api.queue(doctorId, today);
      setView(q.session === null ? null : (q as WireQueueView));
      setRead(true); setAsOf(Date.now()); setStale(false);
    } catch {
      setStale(true);
    }
  }, [api, doctorId, today]);
  useEffect(() => {
    if (doctorId === null) return;
    void refresh();
    const id = setInterval(() => { if (AppState.currentState !== "background") void refresh(); }, QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [doctorId, refresh]);

  /** One act: the server's own sentence for a refusal, a plain line when the phone has no signal, and the line re-read either way. */
  const act = useCallback(async (name: string, run: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(name); setError(null);
    try {
      await run();
      buzz("ok");
      if (done !== undefined) say(done);
      await refresh();
      return true;
    } catch (e) {
      buzz("warn");
      setError(e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));
      void refresh();
      return false;
    } finally {
      setBusy(null);
    }
  }, [refresh, say, t]);

  const now = new Date(asOf ?? Date.now());
  const current = view?.current ?? null;
  const ordered = view?.ordered ?? [];
  const inConsult = view?.inConsult ?? [];
  const held = view?.heldForPayment ?? [];
  const left = view?.left ?? [];
  const session = view?.session ?? null;

  const groupOf = (encounterId: string): { entry: WireQueueEntryView | null; group: BriefGroup } => {
    if (current?.encounterId === encounterId) return { entry: current, group: "called" };
    const w = inConsult.find((e) => e.encounterId === encounterId);
    if (w !== undefined) return { entry: w, group: parkedSince(w) !== null ? "parked" : "with" };
    const o = ordered.find((e) => e.encounterId === encounterId);
    if (o !== undefined) return { entry: o, group: "line" };
    const h = held.find((e) => e.encounterId === encounterId);
    if (h !== undefined) return { entry: h, group: "held" };
    const l = left.find((e) => e.encounterId === encounterId);
    if (l !== undefined) return { entry: l, group: "left" };
    return { entry: null, group: "gone" };
  };
  const show = (e: WireQueueEntryView): void => {
    // What was said about the last patient is not carried onto this one's card.
    setError(null); setFlash(null);
    setOpen({ encounterId: e.encounterId, patientId: e.encounter.patientId, tokenNo: e.tokenNo, summary: e.patient });
  };

  // ——— the acts ———
  const callNext = (): void => {
    if (session === null) return;
    void (async () => {
      setBusy("call"); setError(null);
      try {
        const r = await api.callNext(session.id);
        buzz("ok");
        say(r.entry === null ? t("mobile.doctor.nobodyToCall") : t("mobile.doctor.calledNow", { token: r.entry.tokenNo }));
      } catch (e) {
        buzz("warn");
        setError(e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));
      } finally {
        await refresh();
        setBusy(null);
      }
    })();
  };
  const startOf = (e: Open): void => { void act("start", () => api.start(e.encounterId), t("mobile.doctor.started", { token: e.tokenNo })); };
  const askSkip = (e: WireQueueEntryView): void => { setError(null); setSkipReason("absent"); setSkipNote(""); setSkipping(e); };
  const confirmSkip = (): void => {
    const e = skipping;
    if (e === null) return;
    if (skipReason === "other" && skipNote.trim() === "") { setError(t("opdConsult.skipNoteRequired")); return; }
    void (async () => {
      const ok = await act("skip", () => api.skip(e.id, skipReason, skipNote.trim() === "" ? null : skipNote.trim()), t("mobile.doctor.skipped", { token: e.tokenNo }));
      setSkipping(null);
      if (ok && open?.encounterId === e.encounterId) setOpen(null);
    })();
  };
  const askOpenUnpaid = (e: WireQueueEntryView): void => { setError(null); setUnpaidReason(""); setOpening(e); };
  const confirmOpenUnpaid = (): void => {
    const e = opening;
    if (e === null) return;
    if (unpaidReason.trim() === "") { setError(t("mobile.doctor.reasonNeeded")); return; }
    void (async () => {
      await act("open-unpaid", () => api.openUnpaid(e.encounter.id, unpaidReason.trim()));
      setOpening(null);
    })();
  };
  /**
   * COMPLETE, FROM A PHONE. The visit is re-read first: rows typed in the computer's prescription
   * editor and never issued would be left behind by a completion that cannot issue them
   * (production 2026-09-23), so the phone refuses and says where to finish.
   */
  const askComplete = (e: Open): void => {
    void (async () => {
      setBusy("complete"); setError(null);
      try {
        const v = await api.visit(e.encounterId);
        const n = unissuedRxRows(v.encounter.rxDraft);
        if (n > 0) { buzz("warn"); setError(t("mobile.doctor.rxBlock", { count: n })); return; }
        setFollowUp(null); setTestsOrdered(false); setCompleting(e);
      } catch (err) {
        setError(err instanceof NetworkError ? t("mobile.network") : err instanceof ApiError ? refusalText(err.body, err.code) : String(err));
      } finally {
        setBusy(null);
      }
    })();
  };
  const confirmComplete = (): void => {
    const e = completing;
    if (e === null) return;
    void (async () => {
      const ok = await act("complete", () => api.complete(e.encounterId, completionBody(testsOrdered, followUp)), t("mobile.doctor.completed", { token: e.tokenNo }));
      setCompleting(null);
      if (ok) setOpen(null);
    })();
  };

  const back = (
    <Pressable onPress={() => (open !== null ? setOpen(null) : router.back())} accessibilityRole="button" hitSlop={8} testID="doctor-back"
      style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
      <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
    </Pressable>
  );

  // ——— the sheets (shared by the line and the brief) ———
  const sheets = (
    <>
      {skipping !== null && (
        <Sheet testID="skip-sheet" title={t("opdConsult.skipTitle", { token: skipping.tokenNo })} onClose={() => setSkipping(null)}>
          <Text style={s.sheetHint}>{t("opdConsult.skipHint")}</Text>
          <View style={{ gap: 6 }}>
            {SKIP_REASONS.map((r) => (
              <Pressable key={r} testID={`skip-reason-${r}`} accessibilityRole="radio" accessibilityState={{ selected: skipReason === r }} onPress={() => setSkipReason(r)}
                style={[s.choice, skipReason === r && s.choiceOn]}>
                <View style={[s.radio, skipReason === r && { borderColor: color.green }]}>{skipReason === r && <View style={s.radioDot} />}</View>
                <Text style={[s.choiceText, skipReason === r && { color: color.ink, fontWeight: "700" }]}>{t(`opdConsult.skipReason.${r}`)}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            testID="skip-note" value={skipNote} onChangeText={setSkipNote} maxLength={500}
            placeholder={t(skipReason === "other" ? "opdConsult.skipNoteRequired" : "opdConsult.skipNote")} placeholderTextColor={color.faint}
            style={s.input}
          />
          {error !== null && <Note tone="bad" testID="sheet-error">{error}</Note>}
          <Button testID="skip-go" label={t("mobile.doctor.skipGo", { token: skipping.tokenNo })} busy={busy === "skip"} onPress={confirmSkip} />
          <Button testID="skip-cancel" kind="secondary" label={t("mobile.doctor.cancel")} onPress={() => setSkipping(null)} />
        </Sheet>
      )}
      {opening !== null && (
        <Sheet testID="unpaid-sheet" title={t("opdConsult.openUnpaidTitle", { token: opening.tokenNo })} onClose={() => setOpening(null)}>
          <Text style={s.sheetHint}>{t("opdConsult.openUnpaidHint")}</Text>
          <Text style={[s.sheetHint, { color: color.red, fontWeight: "700" }]}>{t("opdConsult.openUnpaidStillOwed")}</Text>
          <TextInput
            testID="unpaid-reason" value={unpaidReason} onChangeText={setUnpaidReason} maxLength={500} autoFocus
            placeholder={t("opdConsult.openUnpaidReason")} placeholderTextColor={color.faint} style={s.input}
          />
          {error !== null && <Note tone="bad" testID="sheet-error">{error}</Note>}
          <Button testID="unpaid-go" label={t("opdConsult.openUnpaidConfirm")} busy={busy === "open-unpaid"} onPress={confirmOpenUnpaid} />
          <Button testID="unpaid-cancel" kind="secondary" label={t("mobile.doctor.cancel")} onPress={() => setOpening(null)} />
        </Sheet>
      )}
      {completing !== null && (
        <Sheet testID="complete-sheet" title={t("mobile.doctor.completeTitle", { token: completing.tokenNo })} onClose={() => setCompleting(null)}>
          <Text style={s.sheetHint}>{t("mobile.doctor.completeHint")}</Text>
          <Pressable testID="complete-tests" accessibilityRole="checkbox" accessibilityState={{ checked: testsOrdered }} onPress={() => setTestsOrdered((v) => !v)}
            style={[s.choice, testsOrdered && s.choiceOn]}>
            <View style={[s.check, testsOrdered && { backgroundColor: color.green, borderColor: color.green }]}>{testsOrdered && <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>✓</Text>}</View>
            <Text style={[s.choiceText, testsOrdered && { color: color.ink, fontWeight: "700" }]}>{t("opdConsult.testsOrdered")}</Text>
          </Pressable>
          {!testsOrdered && (
            <View>
              <Tag>{t("opdConsult.followUp")}</Tag>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.sm }}>
                {followUpChoices(cfg).map((c) => {
                  const on = followUp === c.send;
                  return (
                    <Pressable key={String(c.send)} testID={`follow-${c.send === null ? "default" : c.send}`} accessibilityRole="radio" accessibilityState={{ selected: on }}
                      onPress={() => setFollowUp(c.send)} style={[s.pill, on && s.pillOn]}>
                      <Text style={[s.pillText, on && { color: "#f2faf6" }]}>
                        {c.days === null ? t("mobile.doctor.followUpServerDefault") : c.isDefault ? t("opdConsult.followUpDefault", { days: c.days }) : t("mobile.doctor.followUpDays", { days: c.days })}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}
          {error !== null && <Note tone="bad" testID="sheet-error">{error}</Note>}
          <Button testID="complete-go" label={t("mobile.doctor.completeGo")} busy={busy === "complete"} onPress={confirmComplete} />
          <Button testID="complete-cancel" kind="secondary" label={t("mobile.doctor.cancel")} onPress={() => setCompleting(null)} />
        </Sheet>
      )}
    </>
  );
  const sheetOpen = skipping !== null || opening !== null || completing !== null;

  if (open !== null) {
    const { entry, group } = groupOf(open.encounterId);
    // In consultation: the consult screen (decision 0048). The brief stays one tap away as the patient's history.
    if (group === "with" && historyOf !== open.encounterId) {
      return (
        <View style={{ flex: 1, backgroundColor: color.paper }}>
          <Band right={back} />
          {error !== null && !sheetOpen && <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}><Note tone="bad" testID="consult-line-error">{error}</Note></View>}
          <ConsultScreen
            doctorApi={api} encounterId={open.encounterId} patientId={open.patientId} tokenNo={open.tokenNo} entry={entry} summary={entry?.patient ?? open.summary} cfg={cfg}
            onDone={(line) => { setError(null); setOpen(null); say(line); void refresh(); }}
            onPaper={() => askComplete(open)}
            onHistory={() => setHistoryOf(open.encounterId)}
            onPark={() => { void (async () => { if (await act("park", () => api.park(open.encounterId), t("mobile.doctor.parked", { token: open.tokenNo }))) setOpen(null); })(); }}
            parkBusy={busy !== null}
          />
          {sheets}
        </View>
      );
    }
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <Band right={back} />
        <PatientBrief
          api={api} entry={entry} group={group} encounterId={open.encounterId} patientId={open.patientId} summary={entry?.patient ?? open.summary} tokenNo={open.tokenNo}
          isHead={group === "line" && current === null && ordered[0]?.encounterId === open.encounterId}
          busy={busy} error={sheetOpen ? null : error} flash={flash}
          onBack={() => { setError(null); if (historyOf === open.encounterId) setHistoryOf(null); else setOpen(null); }}
          actions={{
            start: () => startOf(open),
            recall: () => { if (entry !== null) void act("recall", () => api.recall(entry.id), t("mobile.doctor.calledNow", { token: open.tokenNo })); },
            skip: () => { if (entry !== null) askSkip(entry); },
            openUnpaid: () => { if (entry !== null) askOpenUnpaid(entry); },
            undoSkip: () => { if (entry !== null) void act("undo", () => api.undoSkip(entry.id)); },
            park: () => { void (async () => { if (await act("park", () => api.park(open.encounterId), t("mobile.doctor.parked", { token: open.tokenNo }))) setOpen(null); })(); },
            resume: () => { void act("resume", () => api.resume(open.encounterId)); },
            complete: () => askComplete(open),
          }}
        />
        {sheets}
      </View>
    );
  }

  const label = me === null ? null : besideName({ unit, designation: me.designation ?? null });
  const longest = longestWait(ordered, now);
  const out = session?.status === "out";
  const closed = session?.status === "closed";
  const canCall = session !== null && !out && !closed && current === null && ordered.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={back} />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }}>
        <View>
          <Text style={[type.title, { color: color.ink }]}>{t("screen.consult.title")}</Text>
          {me !== null && (
            <Text testID="doctor-name" style={[type.small, { color: color.dim, marginTop: 2 }]}>
              {me.displayName}{label !== null ? ` · ${label}` : ""}
            </Text>
          )}
        </View>

        {boot === "loading" && <Text testID="doctor-loading" style={s.dim}>{t("mobile.doctor.loading")}</Text>}
        {boot === "not_a_doctor" && <Note tone="warn" testID="not-a-doctor">{t("opdConsult.notADoctor")}</Note>}
        {boot === "offline" && (
          <>
            <Note tone="bad" testID="doctor-offline">{t("mobile.network")}</Note>
            <Button testID="doctor-retry" kind="secondary" label={t("mobile.doctor.retry")} onPress={() => { void loadMe(); }} />
          </>
        )}
        {boot === "ready" && !read && !stale && <Text testID="doctor-loading" style={s.dim}>{t("mobile.doctor.loading")}</Text>}
        {boot === "ready" && stale && (
          <Note tone="warn" testID="line-stale">{asOf === null ? t("mobile.network") : t("mobile.doctor.stale", { time: istClock(new Date(asOf).toISOString()) })}</Note>
        )}
        {flash !== null && <Text testID="line-flash" style={s.flash}>{flash}</Text>}
        {error !== null && !sheetOpen && <Note tone="bad" testID="line-error">{error}</Note>}

        {boot === "ready" && read && view === null && (
          <View style={s.card} testID="no-session">
            <Text style={[type.heading, { color: color.ink }]}>{t("opdConsult.noSession")}</Text>
            <Text style={[s.dim, { marginTop: 4 }]}>{t("mobile.doctor.noSessionHint")}</Text>
          </View>
        )}

        {view !== null && session !== null && (
          <>
            <View style={s.stats} testID="line-stats">
              {([["statWaiting", view.counts.waiting, "waiting"], ["statWithMe", view.counts.inConsult + view.counts.called, "with"], ["statSeen", view.counts.done, "seen"]] as const).map(([k, n, id]) => (
                <View key={k} style={s.stat}>
                  <Text testID={`stat-${id}`} style={s.statNum}>{n}</Text>
                  <Text style={s.statKey}>{t(`mobile.doctor.${k}`)}</Text>
                </View>
              ))}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text testID="session-status" style={[s.chip, (out || closed) && { color: "#8a5a10", borderColor: color.goldLine, backgroundColor: color.goldSoft }]}>
                {t(`mobile.doctor.session.${session.status}`)}
              </Text>
              <View style={{ flex: 1 }} />
              {!closed && (
                <Pressable testID="session-toggle" accessibilityRole="button" disabled={busy !== null} hitSlop={6}
                  onPress={() => { void act("session", () => api.sessionStatus(session.id, out ? "in" : "out")); }}
                  style={s.linkBtn}>
                  <Text style={s.link}>{t(out ? "mobile.doctor.stepIn" : "mobile.doctor.stepOut")}</Text>
                </Pressable>
              )}
            </View>
            {(longest !== null || view.waitingVitals > 0) && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, marginTop: -4 }}>
                {longest !== null && <Text testID="line-longest" style={[s.meta, longest >= LONG_WAIT_MINUTES && { color: color.red, fontWeight: "700" }]}>{t("mobile.doctor.longest", { min: longest })}</Text>}
                {view.waitingVitals > 0 && <Text testID="line-vitals" style={s.meta}>{t("mobile.doctor.atVitals", { count: view.waitingVitals })}</Text>}
              </View>
            )}
            {out && <Note tone="warn" testID="out-hint">{t("mobile.doctor.outHint")}</Note>}
            {closed && <Note tone="warn" testID="closed-hint">{t("mobile.doctor.closedHint")}</Note>}

            {current !== null && (
              <View style={[s.card, { borderColor: color.green, borderWidth: 2 }]} testID="called-card">
                <Tag>{t("mobile.doctor.called", { token: current.tokenNo })}</Tag>
                <Pressable testID="called-open" accessibilityRole="button" onPress={() => show(current)} style={{ marginTop: space.sm }}>
                  <Text style={s.calledName} numberOfLines={2}>
                    {rowName(current.patient).text ?? t(rowName(current.patient).sealed ? "mobile.doctor.sealed" : "mobile.doctor.noName")}
                    {ageSexOf(current.patient, now) !== null && <Text style={s.rowDemo}> · {ageSexOf(current.patient, now)}</Text>}
                  </Text>
                  <Text style={s.rowLine}>
                    {t(`opdConsultV2.vtShort.${visitKind(current)}`)}
                    {current.calledAt !== null ? ` · ${t("mobile.doctor.calledAt", { time: istClock(current.calledAt) })}` : ""}
                    {current.callCount > 1 ? ` · ${t("opdConsultV2.recalledTimes", { n: current.callCount - 1 })}` : ""}
                  </Text>
                  {isUnpaid(current) && <Text style={[s.mark, { color: color.red, borderColor: color.red, alignSelf: "flex-start", marginTop: 6 }]}>{t("mobile.doctor.unpaidRow")}</Text>}
                </Pressable>
                <View style={{ gap: space.sm, marginTop: space.md }}>
                  <Button testID="called-start" label={t("opdConsult.start")} busy={busy === "start"} disabled={busy !== null}
                    onPress={() => { void (async () => { if (await act("start", () => api.start(current.encounter.id), t("mobile.doctor.started", { token: current.tokenNo }))) show(current); })(); }} />
                  <View style={{ flexDirection: "row", gap: space.sm }}>
                    <View style={{ flex: 1 }}><Button testID="called-recall" kind="secondary" label={t("mobile.doctor.recallShort")} busy={busy === "recall"} disabled={busy !== null}
                      onPress={() => { void act("recall", () => api.recall(current.id), t("mobile.doctor.calledNow", { token: current.tokenNo })); }} /></View>
                    <View style={{ width: 104 }}><Button testID="called-skip" kind="secondary" label={t("opdConsult.skip")} disabled={busy !== null} onPress={() => askSkip(current)} /></View>
                  </View>
                </View>
              </View>
            )}

            {inConsult.length > 0 && (
              <View testID="with-group">
                <Tag>{t("mobile.doctor.withYou")}</Tag>
                <View style={{ gap: space.sm, marginTop: space.sm }}>
                  {inConsult.map((e) => {
                    const p = parkedSince(e);
                    const min = p === null ? 0 : Math.max(0, Math.floor((now.getTime() - new Date(p).getTime()) / 60_000));
                    return (
                      <Row key={e.id} e={e} t={t} now={now} testID={`with-row-${e.tokenNo}`} onPress={() => show(e)}
                        right={<Text testID={`with-state-${e.tokenNo}`} style={[s.wait, p !== null && { color: "#8a5a10", fontWeight: "700" }]}>
                          {p === null ? t("mobile.doctor.inConsult") : min === 0 ? t("opdConsult.parkedJustNow") : t("opdConsult.parkedFor", { minutes: min })}
                        </Text>} />
                    );
                  })}
                </View>
              </View>
            )}

            <View>
              <Button testID="call-next" label={t("opdConsult.callNext")} busy={busy === "call"} disabled={!canCall || busy !== null} onPress={callNext} />
              {current !== null && <Text testID="call-hint" style={[s.meta, { marginTop: 6 }]}>{t("mobile.doctor.calledFirst", { token: current.tokenNo })}</Text>}
            </View>

            <View testID="line-group">
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
                <Tag>{t("mobile.doctor.line")}</Tag>
                <Text style={s.meta}>{t("mobile.doctor.lineCount", { count: ordered.length })}</Text>
              </View>
              <View style={{ gap: space.sm, marginTop: space.sm }}>
                {ordered.length === 0 && <Text testID="line-empty" style={s.dim}>{t("opdConsult.emptyQueue")}</Text>}
                {ordered.map((e, i) => (
                  <Row key={e.id} e={e} t={t} now={now} tone={i === 0 && current === null ? "next" : "plain"} testID={`line-row-${e.tokenNo}`} onPress={() => show(e)}
                    right={<Wait e={e} now={now} t={t} />} />
                ))}
              </View>
            </View>

            {held.length > 0 && (
              <View testID="held-group">
                <Tag>{t("opdConsult.heldQueue", { n: held.length })}</Tag>
                <Text style={[s.meta, { marginTop: 4 }]}>{t("opdConsult.heldQueueHint")}</Text>
                <View style={{ gap: space.sm, marginTop: space.sm }}>
                  {held.map((e) => (
                    <Row key={e.id} e={e} t={t} now={now} testID={`held-row-${e.tokenNo}`} onPress={() => show(e)}
                      right={<Wait e={e} now={now} t={t} />}
                      below={<>
                        {(e.encounter.feeBypassReason ?? null) !== null && <Text style={[s.meta, { flex: 1, minWidth: 160 }]}>{t("opdConsult.heldWhy", { reason: e.encounter.feeBypassReason ?? "" })}</Text>}
                        <Pressable testID={`held-open-${e.tokenNo}`} accessibilityRole="button" hitSlop={6} onPress={() => askOpenUnpaid(e)} style={s.linkBtn}>
                          <Text style={s.link}>{t("opdConsult.openUnpaid")}</Text>
                        </Pressable>
                      </>} />
                  ))}
                </View>
              </View>
            )}

            {left.length > 0 && (
              <View testID="left-group">
                <Tag>{t("opdConsult.leftQueue", { n: left.length })}</Tag>
                <Text style={[s.meta, { marginTop: 4 }]}>{t("opdConsult.leftQueueHint")}</Text>
                <View style={{ gap: space.sm, marginTop: space.sm }}>
                  {left.map((e) => (
                    <Row key={e.id} e={e} t={t} now={now} testID={`left-row-${e.tokenNo}`} onPress={() => show(e)}
                      below={<>
                        {(e.skipReason ?? null) !== null && <Text style={[s.meta, { flex: 1, minWidth: 160 }]}>{t(`opdConsult.skipReason.${e.skipReason ?? "other"}`)}</Text>}
                        <Pressable testID={`left-undo-${e.tokenNo}`} accessibilityRole="button" hitSlop={6} disabled={busy !== null}
                          onPress={() => { void act("undo", () => api.undoSkip(e.id)); }} style={s.linkBtn}>
                          <Text style={s.link}>{t("opdConsult.undoSkip")}</Text>
                        </Pressable>
                      </>} />
                  ))}
                </View>
              </View>
            )}

            {asOf !== null && !stale && <Text testID="line-asof" style={[s.meta, { textAlign: "right" }]}>{t("mobile.doctor.asOf", { time: istClock(new Date(asOf).toISOString()) })}</Text>}
          </>
        )}
      </ScrollView>
      {sheets}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg },
  dim: { ...type.body, color: color.dim },
  meta: { fontSize: 13, lineHeight: 19, color: color.dim },
  flash: { fontSize: 14.5, lineHeight: 20, fontWeight: "700", color: color.green },
  stats: { flexDirection: "row", gap: space.sm },
  stat: { flex: 1, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingVertical: 12, paddingHorizontal: 14 },
  statNum: { fontFamily: MONO, fontSize: 30, fontWeight: "700", color: color.ink },
  statKey: { fontSize: 12.5, color: color.dim, marginTop: 2 },
  chip: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase", color: color.green, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.greenSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, overflow: "hidden" },
  link: { color: color.green, fontSize: 14, fontWeight: "700" },
  linkBtn: { minHeight: 40, justifyContent: "center", paddingHorizontal: 4 },
  rowCard: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 16, paddingVertical: 10, paddingHorizontal: 14 },
  rowBelow: { borderTopWidth: 1, borderTopColor: color.line2, paddingHorizontal: 14, paddingVertical: 4, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.md },
  rowTok: { fontFamily: MONO, fontSize: 22, fontWeight: "700", color: color.ink, minWidth: 34 },
  rowName: { fontSize: 16, lineHeight: 21, fontWeight: "700", color: color.ink },
  rowDemo: { fontSize: 14, fontWeight: "500", color: color.dim },
  rowLine: { fontSize: 13, lineHeight: 18, color: color.dim },
  mark: { fontFamily: MONO, fontSize: 10.5, fontWeight: "700", letterSpacing: 0.8, borderWidth: 1.5, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden" },
  wait: { fontFamily: MONO, fontSize: 13, color: color.dim },
  calledName: { fontSize: 22, lineHeight: 27, fontWeight: "700", color: color.ink },
  scrim: { flex: 1, backgroundColor: "rgba(19,36,32,.45)" },
  sheet: { backgroundColor: color.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: space.lg, gap: space.md },
  sheetHint: { fontSize: 14, lineHeight: 20, color: color.dim },
  choice: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 },
  choiceOn: { borderColor: color.green, backgroundColor: color.greenSoft },
  choiceText: { flex: 1, fontSize: 15, lineHeight: 20, color: color.dim },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: color.faint, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.green },
  check: { width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: color.faint, alignItems: "center", justifyContent: "center" },
  input: { minHeight: TOUCH + 4, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: color.ink, backgroundColor: color.card },
  pill: { minHeight: 40, justifyContent: "center", paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.card },
  pillOn: { backgroundColor: color.green, borderColor: color.green },
  pillText: { fontSize: 14, fontWeight: "700", color: color.green },
});
