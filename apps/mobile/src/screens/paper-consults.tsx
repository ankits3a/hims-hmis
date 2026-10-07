import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ApiError, NetworkError } from "../api";
import { doctorApi, type WireDocument } from "../doctor/api";
import { PaperViewer } from "../doctor/brief";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, Button, MONO, Note } from "../ui";

/**
 * MY PAPER CONSULTATIONS, ON THE PHONE (app home round 2, decision 0043 — owner ruling 2026-10-06
 * built the list on the computer; round 1's card could only say "open the computer").
 *
 * What the desk filed or typed from this doctor's paper today, held lines FIRST. Three acts, each
 * the web list's own route and the server's own rule:
 *   · "Looks right" — the optional look (`/confirm`). Refused by the server while a line is held.
 *   · "Ask the desk to re-check" — sends it back with a reason (`/recheck`).
 *   · A HELD medicine is DECIDED: give it with the doctor's reason, or do not give it. That is the
 *     web's "Correct it" (`/correct`) with the typed lines kept exactly as they stand — the phone
 *     adds no medicine and retypes none. The server re-runs every check on what is sent.
 * Nothing is queued: an act that does not reach the server says nothing was changed.
 */
type Line = { drug: string; dose: string; route: string; frequency: string; durationDays: number | null; instructions: string | null; noSubstitution: boolean; medicineId?: string | null };
type HeldAlert = { kind: string; hard: boolean; text: string };
type Row = {
  encounterId: string; visitNo: string; tokenNo: number | null;
  patient: { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };
  completedVia: string | null; evidenceKind: string | null; paperCompletedByName: string | null; paperCompletedAt: string | null;
  documents: { id: string; encounterId: string; kind: string; capturedAt: string }[];
  prescription: { lines: Line[]; transcribedByName: string | null } | null;
  held: { lines: Line[]; alerts: HeldAlert[][]; note: string | null } | null;
  advisedTests: { serviceId: string; name: string }[];
  confirmedAt: string | null;
  recheck?: { reason: string; doneAt: string | null; doneByName: string | null; doneNote: string | null } | null;
};
type Choice = "give" | "drop" | null;

const lineText = (l: Line): string => [l.drug, l.dose, l.frequency, l.durationDays === null ? null : `× ${String(l.durationDays)}d`].filter((x) => x !== null && x !== "").join(" · ");
const nameOf = (r: Row): string => (r.patient.restricted || r.patient.name === null ? (r.patient.alias ?? r.patient.uhid) : r.patient.name);
const enc = encodeURIComponent;

export function PaperConsultsScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const { call } = useSession();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState<"offline" | "refused" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ tone: "info" | "bad"; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [choice, setChoice] = useState<Choice[]>([]);
  const [why, setWhy] = useState<string[]>([]);
  const [viewing, setViewing] = useState<WireDocument | null>(null);

  const load = useCallback(async () => {
    try {
      const got = await call<{ items: Row[] }>("GET", "/opd/paper/consults?scope=mine");
      setRows(got.items); setFailed(null);
    } catch (e) { setFailed(e instanceof NetworkError ? "offline" : "refused"); }
  }, [call]);
  useEffect(() => { void load(); }, [load]);

  const show = (r: Row | null): void => {
    setOpen(r?.encounterId ?? null); setAsking(false); setReason(""); setSaid(null);
    setChoice((r?.held?.lines ?? []).map(() => null)); setWhy((r?.held?.lines ?? []).map(() => ""));
  };
  async function send(path: string, body: unknown, done: string): Promise<void> {
    setBusy(true); setSaid(null);
    try {
      await call("POST", path, body);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setAsking(false); setReason("");
      await load();
      setSaid({ tone: "info", text: t(done) });
    } catch (e) {
      setSaid({ tone: "bad", text: e instanceof NetworkError ? t("mobile.paper.notSent") : e instanceof ApiError && e.message !== "" ? e.message : t("mobile.paper.refused") });
    } finally { setBusy(false); }
  }
  const decide = (r: Row): void => {
    const held = r.held?.lines ?? [];
    if (held.some((_, i) => choice[i] === null || choice[i] === undefined)) { setSaid({ tone: "bad", text: t("mobile.paper.chooseEach") }); return; }
    if (held.some((_, i) => choice[i] === "give" && (why[i] ?? "").trim().length < 3)) { setSaid({ tone: "bad", text: t("mobile.paper.reasonEach") }); return; }
    const typed = r.prescription?.lines ?? [];
    const given = held.map((l, i) => ({ l, i })).filter((x) => choice[x.i] === "give");
    void send(`/opd/paper/visits/${enc(r.encounterId)}/correct`, {
      lines: [...typed, ...given.map((x) => x.l)],
      reasons: given.map((x, k) => ({ lineIndex: typed.length + k, reason: (why[x.i] ?? "").trim() })),
    }, "mobile.paper.decided");
  };

  const pill = (text: string, tone: "red" | "gold" | "green" | "dim", testID?: string) => {
    const c = tone === "red" ? [color.redSoft, color.red] : tone === "gold" ? [color.goldSoft, "#8a5a10"] : tone === "green" ? [color.greenSoft, color.green] : [color.wash, color.dim];
    return <View style={{ backgroundColor: c[0], borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}><Text testID={testID} style={{ fontSize: 11.5, fontWeight: "700", color: c[1] }}>{text}</Text></View>;
  };
  const card = { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: space.sm } as const;
  const api = doctorApi(call);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={
        <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={8} testID="back" style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
          <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
        </Pressable>
      } />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} keyboardShouldPersistTaps="handled" testID="paper-list">
        <Text style={[type.title, { color: color.ink }]}>{t("mobile.paper.title")}</Text>
        <Text style={[type.small, { color: color.dim }]}>{t("mobile.paper.sub")}</Text>
        {failed !== null && <Note tone="warn" testID="paper-failed">{t(failed === "offline" ? "mobile.paper.offline" : "mobile.paper.cannotRead")}</Note>}
        {rows !== null && rows.length === 0 && <Note tone="info" testID="paper-empty">{t("mobile.paper.empty")}</Note>}
        {(rows ?? []).map((r) => {
          const isOpen = open === r.encounterId;
          const typedBy = r.prescription?.transcribedByName ?? null;
          return (
            <View key={r.encounterId} testID={`paper-${r.visitNo}`} style={[card, r.held !== null && { borderLeftWidth: 4, borderLeftColor: color.red }]}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: isOpen }} testID={`paper-open-${r.visitNo}`} onPress={() => show(isOpen ? null : r)} style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
                  {r.tokenNo !== null && <Text style={{ fontFamily: MONO, fontWeight: "700", fontSize: 16, color: color.ink }}>{`#${String(r.tokenNo)}`}</Text>}
                  <Text style={{ flex: 1, fontSize: 15.5, fontWeight: "700", color: color.ink }} numberOfLines={1}>{nameOf(r)}</Text>
                  <Text style={{ color: color.faint, fontSize: 18 }}>{isOpen ? "▴" : "▾"}</Text>
                </View>
                <Text style={{ fontFamily: MONO, fontSize: 11.5, color: color.faint }}>{`${r.patient.uhid} · ${r.visitNo}`}</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {r.held !== null && pill(t("mobile.paper.pillHeld", { n: r.held.lines.length }), "red", "paper-pill-held")}
                  {r.recheck != null && r.recheck.doneAt === null && pill(t("mobile.paper.pillSentBack"), "gold", "paper-pill-sent-back")}
                  {r.recheck != null && r.recheck.doneAt !== null && pill(t("mobile.paper.pillRechecked"), "green")}
                  {r.held === null && r.confirmedAt === null && pill(t("mobile.paper.pillUnseen"), "dim")}
                  {r.confirmedAt !== null && pill(t("mobile.paper.pillSeen"), "green", "paper-pill-seen")}
                </View>
              </Pressable>

              {isOpen && (
                <View style={{ gap: space.sm }} testID="paper-open">
                  {r.documents.length > 0 && (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {r.documents.map((d, i) => (
                        <Pressable key={d.id} testID={`paper-page-${String(i + 1)}`} accessibilityRole="button"
                          onPress={() => setViewing({ id: d.id, encounterId: d.encounterId, kind: d.kind, mimeType: "image/jpeg", byteSize: 0, note: null, capturedAt: d.capturedAt })}
                          style={{ minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.greenLine, justifyContent: "center" }}>
                          <Text style={{ color: color.green, fontWeight: "700", fontSize: 13 }}>{t("mobile.paper.seeSlip", { n: i + 1 })}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                  {r.recheck != null && (
                    <View style={{ backgroundColor: color.goldSoft, borderRadius: radius.md, padding: space.md, gap: 2 }} testID="paper-recheck-state">
                      <Text style={{ fontWeight: "700", color: color.ink, fontSize: 13.5 }}>{t(r.recheck.doneAt === null ? "mobile.paper.sentBackTitle" : "mobile.paper.recheckedTitle", { name: r.recheck.doneByName ?? "—" })}</Text>
                      <Text style={[type.small, { color: color.dim }]}>{t("mobile.paper.youAsked", { reason: r.recheck.reason })}</Text>
                      {r.recheck.doneAt !== null && r.recheck.doneNote !== null && <Text style={[type.small, { color: color.dim }]}>{t("mobile.paper.deskSays", { note: r.recheck.doneNote })}</Text>}
                    </View>
                  )}

                  {r.held !== null && (
                    <View style={{ gap: space.sm }} testID="paper-held">
                      <Text style={{ fontWeight: "700", color: color.red, fontSize: 13.5 }}>{t("mobile.paper.heldTitle", { n: r.held.lines.length })}</Text>
                      {r.held.lines.map((l, i) => (
                        <View key={i} style={{ borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: space.md, gap: 6 }}>
                          <Text style={{ fontWeight: "700", color: color.ink }}>{lineText(l)}</Text>
                          {(r.held!.alerts[i] ?? []).map((a, k) => <Text key={k} style={[type.small, { color: color.red }]}>{a.text}</Text>)}
                          <View style={{ flexDirection: "row", gap: 6 }}>
                            {(["give", "drop"] as const).map((c) => (
                              <Pressable key={c} testID={`held-${String(i)}-${c}`} accessibilityRole="button" accessibilityState={{ selected: choice[i] === c }}
                                onPress={() => setChoice((prev) => prev.map((x, j) => (j === i ? c : x)))}
                                style={{ flex: 1, minHeight: 44, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center",
                                  borderColor: choice[i] === c ? (c === "give" ? color.green : color.red) : color.line, backgroundColor: choice[i] === c ? (c === "give" ? color.greenSoft : color.redSoft) : color.card }}>
                                <Text style={{ fontWeight: "700", fontSize: 13, color: choice[i] === c ? (c === "give" ? color.green : color.red) : color.ink }}>{t(c === "give" ? "mobile.paper.give" : "mobile.paper.drop")}</Text>
                              </Pressable>
                            ))}
                          </View>
                          {choice[i] === "give" && (
                            <TextInput testID={`held-${String(i)}-why`} value={why[i] ?? ""} onChangeText={(v) => setWhy((prev) => prev.map((x, j) => (j === i ? v : x)))}
                              placeholder={t("mobile.paper.whyPlaceholder")} placeholderTextColor={color.faint} accessibilityLabel={t("mobile.paper.whyPlaceholder")} maxLength={500}
                              style={{ borderWidth: 1, borderColor: color.goldLine, borderRadius: radius.md, padding: space.md, color: color.ink, backgroundColor: color.paper, fontSize: 15 }} />
                          )}
                        </View>
                      ))}
                      <Button testID="held-save" label={t("mobile.paper.saveDecision")} busy={busy} disabled={busy} onPress={() => decide(r)} />
                    </View>
                  )}

                  <View style={{ gap: 2 }}>
                    <Text style={[type.tag, { color: color.faint, fontFamily: MONO }]}>{t("mobile.paper.medicines")}</Text>
                    {r.prescription === null || r.prescription.lines.length === 0
                      ? <Text style={[type.small, { color: color.dim }]}>{t("mobile.paper.noMedicines")}</Text>
                      : r.prescription.lines.map((l, i) => <Text key={i} style={{ fontSize: 14, color: color.ink }}>{`${String(i + 1)}. ${lineText(l)}`}</Text>)}
                    {typedBy !== null && <Text testID="paper-typed-by" style={[type.small, { color: color.dim }]}>{t("mobile.paper.typedBy", { name: typedBy })}</Text>}
                  </View>
                  {r.advisedTests.length > 0 && (
                    <View style={{ gap: 2 }}>
                      <Text style={[type.tag, { color: color.faint, fontFamily: MONO }]}>{t("mobile.paper.tests")}</Text>
                      {r.advisedTests.map((x) => <Text key={x.serviceId} style={{ fontSize: 14, color: color.ink }}>{x.name}</Text>)}
                    </View>
                  )}

                  {said !== null && <Note tone={said.tone} testID="paper-said">{said.text}</Note>}
                  {asking ? (
                    <View style={{ gap: space.sm }} testID="paper-ask">
                      <TextInput testID="paper-ask-reason" value={reason} onChangeText={setReason} multiline maxLength={500}
                        placeholder={t("mobile.paper.askPlaceholder")} placeholderTextColor={color.faint} accessibilityLabel={t("mobile.paper.askPlaceholder")}
                        style={{ borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: space.md, minHeight: 64, color: color.ink, backgroundColor: color.paper, fontSize: 15 }} />
                      <View style={{ flexDirection: "row", gap: space.sm }}>
                        <View style={{ flex: 1 }}><Button testID="paper-ask-cancel" kind="secondary" label={t("mobile.paper.cancel")} disabled={busy} onPress={() => setAsking(false)} /></View>
                        <View style={{ flex: 1.6 }}><Button testID="paper-ask-send" label={t("mobile.paper.askSend")} busy={busy} disabled={busy || reason.trim().length < 3}
                          onPress={() => { void send(`/opd/paper/visits/${enc(r.encounterId)}/recheck`, { reason: reason.trim() }, "mobile.paper.asked"); }} /></View>
                      </View>
                    </View>
                  ) : (
                    <View style={{ flexDirection: "row", gap: space.sm }}>
                      <View style={{ flex: 1 }}><Button testID="paper-ask-open" kind="secondary" label={t("mobile.paper.ask")} disabled={busy} onPress={() => { setAsking(true); setSaid(null); }} /></View>
                      <View style={{ flex: 1 }}><Button testID="paper-looks-right" label={t(r.confirmedAt !== null ? "mobile.paper.looked" : "mobile.paper.looksRight")} busy={busy}
                        disabled={busy || r.held !== null || r.confirmedAt !== null}
                        onPress={() => { void send(`/opd/paper/visits/${enc(r.encounterId)}/confirm`, {}, "mobile.paper.confirmed"); }} /></View>
                    </View>
                  )}
                  {r.held !== null && <Text style={[type.small, { color: color.faint }]}>{t("mobile.paper.heldFirst")}</Text>}
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
      {viewing !== null && <PaperViewer api={api} doc={viewing} onClose={() => setViewing(null)} t={t} />}
    </View>
  );
}
