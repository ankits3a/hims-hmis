import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n";
import { seatsFor } from "../seats";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, TOUCH } from "../theme";
import { MONO } from "../ui";
import type { Door } from "../vitals/rules";
import { scanApi, type ScanSource } from "./api";
import * as model from "./model";
import type { Offer, ScanAction, ScanCandidate, ScanOutcome, ScanPatient, ScanVisit } from "./model";

/**
 * THE ACTION CARD (board part "scan" frames D and E; part "gestures" frame A) — ONE component for
 * the two roads to it: a code scanned or typed from the header, and a press-and-hold on a patient
 * row. Both hand it the server's answer; it asks `scanPlan` (./model.ts) what to offer.
 *
 * The patient strip stays on top; under it the ONE large button is what this patient needs next
 * from this person, then the other things they may do, then at most two greyed lines naming what
 * the patient is waiting for from somebody else. A miss says why.
 */
type T = ReturnType<typeof useI18n>["t"];
export type Looked = { outcome: ScanOutcome; door: Door | null; cashOpen: boolean };

/** Where a chosen action goes: the screen that owns it, told which visit was scanned. */
export type Scanned = {
  encounterId: string | null; patientId: string; visitNo: string | null; tokenNo: number | null; act: ScanAction;
  /** "Scanned · MED-9 · waiting for vitals" — said once, in green, on the screen that opens (frame C). */
  banner: string | null;
};

export function scannedParams(action: ScanAction, visit: ScanVisit | null, patient: ScanPatient, t: T): Record<string, string> {
  const out: Record<string, string> = { key: model.SEAT_OF[action], act: action, pid: patient.id };
  if (visit !== null) {
    out.scan = visit.encounterId; out.vno = visit.visitNo;
    if (visit.tokenNo !== null) out.tno = String(visit.tokenNo);
    const st = model.stageWords(visit);
    out.said = t("mobile.scan.banner", { token: model.tokenOf(visit), state: t(st.key, st.vars) });
  }
  return out;
}

/** The route's params back into what a screen is handed. `null` when the screen was opened the ordinary way. */
export function scannedFrom(p: { act?: string | string[]; pid?: string | string[]; scan?: string | string[]; vno?: string | string[]; tno?: string | string[]; said?: string | string[] }): Scanned | null {
  const one = (v: string | string[] | undefined): string | null => (typeof v === "string" && v !== "" ? v : null);
  const act = one(p.act);
  const pid = one(p.pid);
  if (act === null || pid === null || !(model.SCAN_ACTIONS as readonly string[]).includes(act)) return null;
  const tno = one(p.tno);
  return { encounterId: one(p.scan), patientId: pid, visitNo: one(p.vno), tokenNo: tno !== null && /^\d+$/.test(tno) ? Number(tno) : null, act: act as ScanAction, banner: one(p.said) };
}

/** The one green line a scan leaves on the screen it opened. */
export function ScannedBanner({ text, onDismiss }: { text: string | null; onDismiss?: () => void }) {
  if (text === null) return null;
  return (
    <Pressable testID="scanned-banner" accessibilityRole="alert" onPress={onDismiss} style={s.banner}>
      <Text style={s.bannerText} numberOfLines={2}>{text}</Text>
    </Pressable>
  );
}

function Strip({ token, name, line }: { token: string; name: string; line: string }) {
  return (
    <View style={s.strip} testID="card-strip">
      <Text style={s.tok} testID="card-token">{token}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.name} numberOfLines={1} testID="card-name">{name}</Text>
        <Text style={s.line} numberOfLines={2} testID="card-state">{line}</Text>
      </View>
    </View>
  );
}

function Row({ label, sub, kind, onPress, testID }: { label: string; sub?: string; kind: "primary" | "plain" | "off"; onPress?: () => void; testID: string }) {
  const fg = kind === "primary" ? "#f2faf6" : kind === "off" ? color.faint : color.ink;
  const body = (
    <>
      <Text style={[s.btnText, { color: fg }]} numberOfLines={2}>
        {label}{sub !== undefined && <Text style={[s.btnSub, { color: kind === "primary" ? "#cfe9dd" : kind === "off" ? color.faint : color.dim }]}> · {sub}</Text>}
      </Text>
      {kind !== "off" && <Text style={[s.chev, { color: fg }]}>›</Text>}
    </>
  );
  // A greyed line is not a button: nothing to press, nothing for a screen reader to try.
  if (kind === "off") return <View testID={testID} accessibilityState={{ disabled: true }} style={[s.btn, s.btnOff]}>{body}</View>;
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => [s.btn, kind === "primary" ? s.btnPrimary : s.btnPlain, pressed && { opacity: 0.8 }]}>
      {body}
    </Pressable>
  );
}

export function ActionCard({ looked, seats, onAct, onPick, onNewVisit, onAgain, onClose }: {
  /** `null` while the lookup is on its way. */
  looked: Looked | null;
  seats: readonly ReturnType<typeof seatsFor>[number]["key"][];
  onAct: (action: ScanAction, visit: ScanVisit) => void;
  /** Two patients hold the token: the one that was picked. Never guessed. */
  onPick: (c: ScanCandidate) => void;
  onNewVisit: (patient: ScanPatient) => void;
  /** "Scan another" — absent when the card was opened by holding a row. */
  onAgain?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const now = useMemo(() => Date.now(), []);
  const say = (w: model.Words): string => t(w.key, w.vars);
  const o = looked?.outcome ?? null;

  let body: React.ReactNode;
  if (looked === null || o === null) {
    body = <View style={{ paddingVertical: space.xl, alignItems: "center" }} testID="card-loading"><ActivityIndicator color={color.green} /></View>;
  } else if (o.outcome === "visit") {
    const permitted = model.reachable(o.permitted, seats);
    const plan = model.scanPlan(o.visit, permitted, { cashOpen: looked.cashOpen });
    const offer = (x: Offer, kind: "primary" | "plain") => (
      <Row key={x.labelKey} testID={kind === "primary" ? "card-next" : `card-act-${x.action}`} kind={kind} label={t(x.labelKey)} sub={x.subKey === undefined ? undefined : t(x.subKey)}
        onPress={() => onAct(x.action, o.visit)} />
    );
    body = (
      <>
        <Strip token={model.tokenOf(o.visit)} name={model.nameOf(o.visit.patient) ?? t("mobile.scan.sealed")} line={model.stripWords(o.visit, permitted, now).map(say).join(" · ")} />
        {plan.next === null
          ? <Text style={s.nothing} testID="card-nothing">{t("mobile.scan.nothing")}</Text>
          : <>{offer(plan.next, "primary")}{plan.others.map((x) => offer(x, "plain"))}</>}
        {plan.greyed.map((g) => <Row key={g.labelKey} testID={`card-off-${g.action}`} kind="off" label={t(g.labelKey)} sub={t(g.reasonKey)} />)}
      </>
    );
  } else if (o.outcome === "ambiguous") {
    body = (
      <>
        <Text style={s.title} testID="card-pick-title">{t("mobile.scan.pick.title", { count: o.candidates.length })}</Text>
        <Text style={s.sub}>{t("mobile.scan.pick.body")}</Text>
        {o.candidates.map((c) => (
          <Pressable key={c.encounterId} testID={`card-pick-${c.encounterId}`} accessibilityRole="button" onPress={() => onPick(c)} style={({ pressed }) => [s.btn, s.btnPlain, pressed && { opacity: 0.8 }]}>
            <Text style={[s.tok, { fontSize: 15, minWidth: 64 }]}>{model.tokenOf(c)}</Text>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.btnText} numberOfLines={1}>{model.nameOf(c.patient) ?? t("mobile.scan.sealed")}</Text>
              <Text style={s.line} numberOfLines={1}>{[c.departmentName, c.visitNo].filter((x) => x !== null).join(" · ")}</Text>
            </View>
            <Text style={s.chev}>›</Text>
          </Pressable>
        ))}
      </>
    );
  } else {
    const miss = model.missView(o, looked.door);
    body = (
      <>
        <Text style={s.title} testID="card-miss-title">{say(miss.title)}</Text>
        {miss.body !== null && <Text style={s.sub} testID="card-miss-body">{say(miss.body)}</Text>}
        {miss.mayOpenVisit && miss.patient !== null && seats.includes("counter") && (
          <Row testID="card-new-visit" kind="primary" label={t("mobile.scan.act.newVisit")} onPress={() => onNewVisit(miss.patient!)} />
        )}
      </>
    );
  }

  const settled = looked !== null && o !== null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel={t("mobile.scan.close")} testID="card-scrim" />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]} testID="action-card">
        <View style={s.grab} />
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space.sm }} keyboardShouldPersistTaps="handled">
          {body}
          {settled && onAgain !== undefined && (o.outcome !== "visit") && <Row testID="card-again" kind="plain" label={t("mobile.scan.again")} onPress={onAgain} />}
          {settled && onAgain === undefined && o.outcome !== "visit" && o.outcome !== "ambiguous" && <Row testID="card-close" kind="plain" label={t("mobile.scan.close")} onPress={onClose} />}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** One lookup for a card: the server's answer, and whether this person's cash session is open (asked only when the fee could be theirs to take). */
export async function look(api: ReturnType<typeof scanApi>, source: ScanSource): Promise<Looked> {
  const { outcome, door } = await api.lookUp(source);
  const cashOpen = outcome.outcome === "visit" && outcome.visit.feeUnpaid && outcome.permitted.includes("collect") ? await api.cashOpen() : false;
  return { outcome, door, cashOpen };
}

/**
 * PRESS AND HOLD A PATIENT ROW (gestures frame A): the same card as a scan, for a visit the row
 * already names. `onLocal` lets the screen the row lives on do its own action in place (the
 * doctor's line starts its own patient); anything else opens the screen that owns it.
 */
export function HeldCard({ source, onClose, onLocal }: {
  source: ScanSource | null; onClose: () => void;
  onLocal?: (action: ScanAction, visit: ScanVisit) => boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { call, state } = useSession();
  const api = useMemo(() => scanApi(call), [call]);
  const seats = useMemo(() => (state.status === "signedIn" ? seatsFor(state.me.permissions).map((x) => x.key) : []), [state]);
  const [at, setAt] = useState<ScanSource | null>(source);
  const [looked, setLooked] = useState<Looked | null>(null);
  useEffect(() => { setAt(source); }, [source]);
  useEffect(() => {
    if (at === null) return;
    let live = true;
    setLooked(null);
    void look(api, at).then((l) => { if (live) setLooked(l); });
    return () => { live = false; };
  }, [api, at]);
  if (source === null || at === null) return null;
  return (
    <ActionCard
      looked={looked} seats={seats} onClose={onClose}
      onPick={(c) => setAt({ encounterId: c.encounterId })}
      onAct={(action, visit) => {
        onClose();
        if (onLocal?.(action, visit) === true) return;
        router.push({ pathname: "/seat/[key]", params: scannedParams(action, visit, visit.patient, t) });
      }}
      onNewVisit={(patient) => { onClose(); router.push({ pathname: "/seat/[key]", params: scannedParams("newVisit", null, patient, t) }); }}
    />
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(19,36,32,.45)" },
  sheet: { maxHeight: "86%", backgroundColor: color.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: space.lg, paddingTop: space.sm },
  grab: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: color.line, marginBottom: space.md },
  strip: { flexDirection: "row", alignItems: "center", gap: space.md, paddingBottom: space.sm },
  tok: { fontFamily: MONO, fontSize: 17, fontWeight: "800", color: color.green, backgroundColor: color.greenSoft, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 6, overflow: "hidden", textAlign: "center" },
  name: { fontSize: 17, lineHeight: 22, fontWeight: "700", color: color.ink },
  line: { fontSize: 13, lineHeight: 18, color: color.dim },
  title: { fontSize: 18, lineHeight: 24, fontWeight: "700", color: color.ink },
  sub: { fontSize: 14, lineHeight: 20, color: color.dim, marginBottom: space.xs },
  nothing: { fontSize: 15, lineHeight: 21, color: color.dim, paddingVertical: space.md },
  btn: { minHeight: TOUCH + 4, flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1 },
  btnPrimary: { backgroundColor: color.green, borderColor: color.green, minHeight: TOUCH + 10 },
  btnPlain: { backgroundColor: color.card, borderColor: color.line },
  btnOff: { backgroundColor: color.wash, borderColor: color.line2 },
  btnText: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: "700", color: color.ink },
  btnSub: { fontSize: 13, fontWeight: "500" },
  chev: { fontSize: 20, fontWeight: "700", color: color.dim },
  banner: { backgroundColor: color.greenSoft, borderWidth: 1, borderColor: color.greenLine, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 9 },
  bannerText: { fontSize: 14, lineHeight: 19, fontWeight: "700", color: color.green },
});
