import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ApiError } from "../api";
import { newIntentKey } from "../counter/api";
import { rs } from "../counter/rules";
import { useI18n } from "../i18n";
import { labRefusal } from "../lab/api";
import {
  counterApi, istToday, nextDays, receiptFor, weekdayOf,
  type CounterApi, type DeskOrderRequest, type WireBookingHours, type WireLabDaySlots, type Tender, type WireDeskFindHit, type WireDuplicateWarning, type WireLabDoctor, type WireOrderable,
  type WirePricedDraft, type WireRecentLabOrder, type WireWalkInReadiness,
} from "../lab/counter-api";
import { Done, ls, Screen, sexAge, type T } from "../lab/ui";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH } from "../theme";
import { Button, KeyboardScrollView, MONO, Note, ScanMark } from "../ui";
import { refusalText } from "../vitals/api";
import { Scanner } from "../vitals/scanner";

/**
 * THE QUICK COUNTER ON THE PHONE (owner 2026-10-12; the web's /lab/counter, `lab-desk.tsx` with
 * mode="counter"). One field finds the person: suggestions from two characters, 180 ms after the
 * last key (names only suggest — a tap selects); Enter or a scanned card opens the exact patient.
 * Then who they are, the doctor's advised tests and the last three tests; **New walk-in** chooses
 * tests; the bill takes cash, UPI (with its reference) or card for the SERVER's total — or, while
 * the lab fee is switched off, no bill and the order goes straight through. The order lands in
 * Quick Collect. The phone does not register a new patient, book a future visit or print.
 */
type Step = "find" | "patient" | "tests" | "bill" | "book";
type Line = { serviceId: string; code: string; nameEn: string; consentRequired: boolean };
const EXACT = ["token", "visit", "order", "uhid"];

export function QuickCounter() {
  const { t } = useI18n();
  const { call } = useSession();
  const api = useMemo(() => counterApi(call), [call]);
  const serviceDate = istToday();

  const [fee, setFee] = useState<{ labFree: boolean; walkIn?: WireWalkInReadiness } | null>(null);
  const [step, setStep] = useState<Step>("find");
  const [q, setQ] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [hits, setHits] = useState<WireDeskFindHit[] | null>(null);
  const [labDoctors, setLabDoctors] = useState<WireLabDoctor[]>([]);
  const [selected, setSelected] = useState<WireDeskFindHit | null>(null);
  const [recent, setRecent] = useState<WireRecentLabOrder[] | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [consents, setConsents] = useState<Record<string, string>>({});
  const [doctorId, setDoctorId] = useState("");
  const [warnings, setWarnings] = useState<WireDuplicateWarning[] | null>(null);
  const [acked, setAcked] = useState<string[]>([]);
  const [priced, setPriced] = useState<WirePricedDraft | null>(null);
  const [mode, setMode] = useState<Tender["mode"]>("cash");
  const [ref, setRef] = useState("");
  const [key, setKey] = useState(newIntentKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [testQ, setTestQ] = useState("");
  const [found, setFound] = useState<WireOrderable[]>([]);

  const fail = (e: unknown): void => {
    setError(e instanceof ApiError && !["lab_mode_off", "forbidden"].includes(e.code) && e.status !== 403 ? refusalText(e.body, e.code) : labRefusal(e, t));
  };

  useEffect(() => { api.feeState().then(setFee, () => undefined); }, [api]);

  /* ── suggestions while typing: 2+ characters, 180 ms after the last key ── */
  useEffect(() => {
    const typed = q.trim();
    if (!suggesting || typed.length < 2) return;
    let gone = false;
    const id = setTimeout(() => {
      api.find(typed, serviceDate, true).then((r) => { if (!gone) { setHits(r.hits); setLabDoctors(r.labDoctors); } }, () => undefined);
    }, 180);
    return () => { gone = true; clearTimeout(id); };
  }, [q, suggesting, api, serviceDate]);

  /* ── the test search, the same way ── */
  useEffect(() => {
    const typed = testQ.trim();
    if (typed.length < 2) { setFound([]); return; }
    let gone = false;
    const id = setTimeout(() => { api.search(typed).then((r) => { if (!gone) setFound(r); }, () => undefined); }, 180);
    return () => { gone = true; clearTimeout(id); };
  }, [testQ, api]);

  const resetOrder = (): void => {
    setLines([]); setConsents({}); setDoctorId(""); setWarnings(null); setAcked([]); setPriced(null);
    setMode("cash"); setRef(""); setTestQ(""); setFound([]); setError(null);
  };

  const choose = (hit: WireDeskFindHit): void => {
    setSuggesting(false); setSelected(hit); setNote(null); setSent(null); resetOrder();
    setRecent(null); setStep("patient");
    api.recent(hit.patient.id).then(setRecent, () => setRecent([]));
  };

  /** A suggestion carries no advised lines; it is re-asked by its visit number before it is used. */
  const pick = async (hit: WireDeskFindHit): Promise<void> => {
    try {
      if (hit.visit !== null && hit.visit.advisedLoaded === false) {
        const full = await api.find(hit.visit.encounterNo, serviceDate);
        setLabDoctors(full.labDoctors);
        choose(full.hits.find((h) => h.visit?.encounterId === hit.visit!.encounterId) ?? hit);
      } else choose(hit);
    } catch (e) { fail(e); }
  };

  const exact = async (raw: string): Promise<void> => {
    let typed = raw.trim();
    if (typed === "") return;
    setError(null); setNote(null); setSent(null);
    try {
      let onlyPatient: string | null = null;
      if (/^q1\./.test(typed)) {
        const v = await api.verifyQr(typed);
        if (!v.ok) { setNote(t("quickLab.collect.badCard")); return; }
        typed = v.patient.uhid; onlyPatient = v.patient.id;
      }
      const r = await api.find(typed, serviceDate);
      setSuggesting(false); setLabDoctors(r.labDoctors);
      const list = onlyPatient === null ? r.hits : r.hits.filter((h) => h.patient.id === onlyPatient);
      if (list.length === 0) { setHits([]); setNote(t("quickCounter.register")); return; }
      if (list.length === 1 && (onlyPatient !== null || EXACT.includes(list[0]!.matchedOn))) { choose(list[0]!); return; }
      setHits(list);
    } catch (e) { fail(e); }
  };

  const backToSearch = (): void => {
    setSelected(null); setHits(null); setQ(""); setSuggesting(false); resetOrder(); setStep("find");
  };

  const visit = selected?.visit ?? null;
  const walkInBlocked = visit === null && fee?.walkIn !== undefined && !fee.walkIn.ready;
  const needsDoctor = visit === null && labDoctors.length > 1 && doctorId === "";
  const missingConsent = lines.filter((l) => l.consentRequired && (consents[l.serviceId] ?? "").trim() === "");
  const unacked = (warnings ?? []).filter((w) => !acked.includes(w.duplicateOfItemId));
  const advisedPending = (visit?.advised ?? []).filter((a) => a.alreadyOrderedItemId === null && a.orderable !== null);
  const canGo = lines.length > 0 && missingConsent.length === 0 && !needsDoctor && !walkInBlocked && !busy;

  const place = async (receipt: DeskOrderRequest["receipt"]): Promise<void> => {
    if (selected === null) return;
    const body: DeskOrderRequest = {
      patientId: selected.patient.id, serviceDate, acknowledgedDuplicates: acked,
      items: lines.map((l) => (l.consentRequired ? { serviceId: l.serviceId, consent: { recordedBy: consents[l.serviceId]!.trim() } } : { serviceId: l.serviceId })),
      ...(visit !== null
        ? { encounterNo: visit.encounterNo, ...(visit.doctorUserId === null ? {} : { orderingClinicianId: visit.doctorUserId }) }
        : { walkIn: doctorId === "" ? {} : { doctorId } }),
      ...(receipt === undefined ? {} : { receipt }),
    };
    const order = await api.place(body, key);
    setKey(newIntentKey());
    backToSearch();
    setSent(t("quickCounter.sent", { name: selected.patient.display, order: order.orderNo }));
  };

  /** FREE: the duplicate check still runs; with nothing left to acknowledge the order goes through. */
  const sendFree = async (): Promise<void> => {
    if (selected === null) return;
    setBusy(true); setError(null);
    try {
      const w = await api.duplicates(selected.patient.id, lines.map((l) => l.serviceId));
      setWarnings(w);
      if (w.every((x) => acked.includes(x.duplicateOfItemId))) await place(undefined);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  /** CHARGED: Next asks the server the price and the duplicates together — "what am I placing?". */
  const next = async (): Promise<void> => {
    if (selected === null) return;
    setBusy(true); setError(null); setPriced(null);
    try {
      const ids = lines.map((l) => l.serviceId);
      const [w, p] = await Promise.all([api.duplicates(selected.patient.id, ids), api.preview(selected.patient.id, visit?.encounterNo ?? null, ids)]);
      setWarnings(w); setPriced(p); setStep("bill");
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const total = priced?.totals.netPayablePaise ?? 0;
  const needsRef = total > 0 && mode === "upi" && ref.trim() === "";
  const pay = async (): Promise<void> => {
    setBusy(true); setError(null);
    // The same key is kept on a failure: a resend is answered by the server, never charged twice.
    try { await place(receiptFor(total, mode, ref)); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const addLine = (o: WireOrderable): void => {
    setLines((prev) => (prev.some((l) => l.serviceId === o.serviceId) ? prev : [...prev, { serviceId: o.serviceId, code: o.code, nameEn: o.nameEn, consentRequired: o.consentRequired }]));
    setWarnings(null); setAcked([]); setPriced(null); setTestQ("");
  };
  const removeLine = (serviceId: string): void => {
    setLines((prev) => prev.filter((l) => l.serviceId !== serviceId));
    setWarnings(null); setAcked([]); setPriced(null);
  };

  /** The test chooser, shared by the walk-in and the future appointment: search, then each test with its parameters. */
  const picker = (
          <>
            <TextInput testID="qn-test-search" value={testQ} onChangeText={setTestQ} placeholder={t("quickCounter.searchTests")} placeholderTextColor={color.faint}
              autoCapitalize="characters" autoCorrect={false} style={cs.input} />
            {found.filter((o) => !lines.some((l) => l.serviceId === o.serviceId)).slice(0, 8).map((o) => (
              <Pressable key={o.serviceId} testID={`qn-add-${o.code}`} accessibilityRole="button" onPress={() => addLine(o)} style={({ pressed }) => [cs.found, pressed && { backgroundColor: color.wash }]}>
                <Text style={{ fontSize: 14.5, color: color.ink }} numberOfLines={1}><Text style={{ fontFamily: MONO, fontWeight: "700", color: color.green }}>{o.code}</Text>  {o.nameEn}</Text>
              </Pressable>
            ))}
            <Text style={ls.cap}>{t("quickCounter.chosen", { n: lines.length })}</Text>
            {lines.map((l) => (
              <View key={l.serviceId} testID={`qn-line-${l.code}`} style={[ls.card, { gap: 6 }]}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <Text style={{ flex: 1, fontSize: 14.5, color: color.ink }} numberOfLines={1}><Text style={{ fontFamily: MONO, fontWeight: "700" }}>{l.code}</Text>  {l.nameEn}</Text>
                  <Pressable testID={`qn-remove-${l.code}`} accessibilityRole="button" accessibilityLabel={`${t("quickCounter.remove")} ${l.code}`} hitSlop={8} onPress={() => removeLine(l.serviceId)} style={cs.x}>
                    <Text style={{ fontSize: 18, color: color.dim }}>×</Text>
                  </Pressable>
                </View>
                <LineParams api={api} serviceId={l.serviceId} code={l.code} t={t} />
                {l.consentRequired && (
                  <TextInput testID={`qn-consent-${l.code}`} value={consents[l.serviceId] ?? ""} onChangeText={(v) => setConsents((c) => ({ ...c, [l.serviceId]: v }))}
                    placeholder={t("quickCounter.consentBy")} placeholderTextColor={color.faint} style={[cs.input, { flex: 0 }]} />
                )}
              </View>
            ))}
          </>
  );

  const onBack = step === "find" ? undefined
    : step === "patient" ? backToSearch
    : step === "tests" || step === "book" ? () => { resetOrder(); setStep("patient"); }
    : () => setStep("tests");

  return (
    <Screen title={t("screen.qcounter.title")} onBack={onBack}>
      <KeyboardScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} keyboardShouldPersistTaps="handled" testID="qcounter">
        {sent !== null && <Done testID="qn-sent" text={sent} />}
        {error !== null && <Note tone="bad" testID="ql-error">{error}</Note>}

        {step === "find" && (
          <>
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
              <TextInput testID="qn-find" value={q} onChangeText={(v) => { setQ(v); setSuggesting(true); setNote(null); }}
                placeholder={t("quickCounter.find")} placeholderTextColor={color.faint} autoCorrect={false} returnKeyType="search"
                onSubmitEditing={() => { void exact(q); }} style={cs.input} />
              <Pressable testID="qn-scan" accessibilityRole="button" accessibilityLabel={t("quickLab.collect.scan")} onPress={() => setScanOpen(true)} style={cs.scan}>
                <ScanMark />
              </Pressable>
            </View>
            {note !== null && <Note tone="warn" testID="qn-register">{note}</Note>}
            {(hits ?? []).map((h) => (
              <Pressable key={`${h.patient.id}-${h.visit?.encounterId ?? "none"}`} testID={`qn-hit-${h.patient.id}`} accessibilityRole="button"
                onPress={() => { void pick(h); }} style={({ pressed }) => [ls.row, pressed && { backgroundColor: color.wash }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={ls.name} numberOfLines={1}>{h.patient.display}</Text>
                  <Text style={ls.ids} numberOfLines={1}>
                    {[sexAge(t, h.patient.administrativeGender, h.patient.dob), h.patient.uhid, h.visit === null ? null : h.visit.tokenNo === null ? h.visit.encounterNo : `T-${h.visit.tokenNo}`].filter((x) => x !== null).join(" · ")}
                  </Text>
                </View>
                <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
              </Pressable>
            ))}
          </>
        )}

        {selected !== null && step !== "find" && (
          <View testID="qn-patient" style={[ls.card, { borderColor: color.greenLine }]}>
            <Text style={ls.name} numberOfLines={1}>{selected.patient.display}</Text>
            <Text style={ls.ids} numberOfLines={1}>{sexAge(t, selected.patient.administrativeGender, selected.patient.dob)} · {selected.patient.uhid}</Text>
            <Text style={ls.sub} numberOfLines={1}>
              {visit === null ? t("quickCounter.noVisit") : [visit.tokenNo === null ? visit.encounterNo : `T-${visit.tokenNo}`, visit.doctorName].filter((x) => x !== null).join(" · ")}
            </Text>
          </View>
        )}

        {step === "patient" && selected !== null && (
          <>
            {advisedPending.length > 0 ? (
              <View testID="qn-advised" style={ls.card}>
                <Text style={ls.cap} numberOfLines={1}>{visit?.doctorName ? t("quickCounter.advisedBy", { doctor: visit.doctorName }) : t("quickCounter.advised")}</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>{advisedPending.map((a) => <Text key={a.serviceId} style={ls.chip}>{a.code}</Text>)}</View>
              </View>
            ) : (
              <Text style={ls.sub} testID="qn-no-advice">{t("quickCounter.noAdvice")}</Text>
            )}
            {fee?.labFree === true && <Text style={[ls.chip, { alignSelf: "flex-start" }]} testID="qn-free">{t("quickCounter.free")}</Text>}
            {walkInBlocked && fee?.walkIn?.problem != null && <Note tone="warn" testID="qn-blocked">{t(`quickCounter.blocked.${fee.walkIn.problem}`)}</Note>}
            {advisedPending.length > 0 && (
              <Button testID="qn-order-advised" label={t("quickCounter.orderAdvised", { n: advisedPending.length })} onPress={() => {
                resetOrder();
                setLines(advisedPending.map((a) => ({ serviceId: a.serviceId, code: a.code, nameEn: a.name, consentRequired: a.orderable?.consentRequired === true })));
                setStep("tests");
              }} />
            )}
            <Button testID="qn-walkin" kind={advisedPending.length > 0 ? "secondary" : "primary"} label={t("quickCounter.walkIn")} disabled={walkInBlocked}
              onPress={() => { resetOrder(); setStep("tests"); }} />
            <Button testID="qn-future" kind="secondary" label={t("quickCounter.future")} onPress={() => { resetOrder(); setStep("book"); }} />
            <View testID="qn-recent" style={ls.card}>
              <Text style={ls.cap}>{t("quickCounter.recent")}</Text>
              {recent !== null && recent.length === 0 && <Text style={ls.sub}>{t("quickCounter.noHistory")}</Text>}
              {(recent ?? []).slice(0, 3).map((o) => (
                <Text key={o.orderId} style={{ fontSize: 13.5, color: color.ink }} numberOfLines={1}>
                  <Text style={{ fontFamily: MONO, color: color.dim }}>{o.placedAt.slice(0, 10)}</Text>  {o.tests.map((x) => x.code).join(", ")}
                </Text>
              ))}
            </View>
          </>
        )}

        {step === "tests" && selected !== null && (
          <>
            {picker}
            {visit === null && labDoctors.length > 1 && (
              <View style={{ gap: 6 }}>
                <Text style={ls.cap}>{t("quickCounter.pathologist")}</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }} accessibilityRole="radiogroup">
                  {labDoctors.map((d) => {
                    const on = doctorId === d.id;
                    return (
                      <Pressable key={d.id} testID={`qn-doctor-${d.id}`} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => setDoctorId(d.id)}
                        style={[cs.seg, { flex: 0, paddingHorizontal: space.md }, on && cs.segOn]}>
                        <Text style={{ fontSize: 14, fontWeight: "700", color: on ? "#f2faf6" : color.ink }} numberOfLines={1}>{d.displayName}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}
            {walkInBlocked && fee?.walkIn?.problem != null && <Note tone="warn" testID="qn-blocked">{t(`quickCounter.blocked.${fee.walkIn.problem}`)}</Note>}
            <Warnings warnings={warnings} acked={acked} setAcked={setAcked} t={t} />
            {fee?.labFree === true ? (
              <Button testID="qn-send" label={t("quickCounter.send", { n: lines.length })} busy={busy} disabled={!canGo} onPress={() => { void sendFree(); }} />
            ) : (
              <Button testID="qn-next" label={t("quickCounter.next", { n: lines.length })} busy={busy} disabled={!canGo || fee === null} onPress={() => { void next(); }} />
            )}
          </>
        )}

        {step === "bill" && selected !== null && priced !== null && (
          <>
            <View style={ls.card}>
              {lines.map((l) => {
                const p = priced.lines.find((x) => x.serviceId === l.serviceId);
                return (
                  <View key={l.serviceId} style={{ flexDirection: "row", gap: space.sm }}>
                    <Text style={{ flex: 1, fontSize: 14, color: color.ink }} numberOfLines={1}>{l.code} · {l.nameEn}</Text>
                    <Text style={{ fontFamily: MONO, fontSize: 14, color: color.ink }}>{p === undefined ? "—" : rs(p.netPaise)}</Text>
                  </View>
                );
              })}
              <View style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: color.line2, paddingTop: space.sm }}>
                <Text style={{ flex: 1, fontSize: 15, fontWeight: "700", color: color.ink }}>{t("quickCounter.total")}</Text>
                <Text testID="qn-total" style={{ fontFamily: MONO, fontSize: 17, fontWeight: "700", color: color.ink }}>{rs(total)}</Text>
              </View>
            </View>
            <Warnings warnings={warnings} acked={acked} setAcked={setAcked} t={t} />
            {total > 0 && (
              <>
                <View style={{ flexDirection: "row", gap: space.sm }} accessibilityRole="radiogroup">
                  {(["cash", "upi", "card"] as const).map((m) => {
                    const on = mode === m;
                    return (
                      <Pressable key={m} testID={`qn-mode-${m}`} accessibilityRole="radio" accessibilityState={{ checked: on }} disabled={busy} onPress={() => setMode(m)} style={[cs.seg, on && cs.segOn]}>
                        <Text style={{ fontSize: 14, fontWeight: "700", color: on ? "#f2faf6" : color.ink }}>{t(`mobile.counter.telePay.mode.${m}`)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                {mode !== "cash" && (
                  <TextInput testID="qn-ref" value={ref} onChangeText={setRef} editable={!busy} autoCapitalize="characters" autoCorrect={false} maxLength={64}
                    placeholder={t(mode === "upi" ? "quickCounter.upiRef" : "quickCounter.cardRef")} placeholderTextColor={color.faint} style={[cs.input, { flex: 0, fontFamily: MONO }]} />
                )}
              </>
            )}
            <Button testID="qn-pay" busy={busy} disabled={busy || needsRef || unacked.length > 0}
              label={total > 0 ? t("quickCounter.collect", { amount: rs(total) }) : t("quickCounter.sendNoCharge")} onPress={() => { void pay(); }} />
          </>
        )}
        {step === "book" && selected !== null && (
          <BookPanel api={api} t={t} serviceDate={serviceDate} serviceIds={lines.map((l) => l.serviceId)} picker={picker} busy={busy}
            onBook={async (day, slot) => {
              setBusy(true); setError(null);
              try {
                await api.book({ patientId: selected.patient.id, serviceDate: day, slotStart: slot, serviceIds: lines.map((l) => l.serviceId) });
                const who = selected.patient.display;
                backToSearch();
                setSent(t("quickCounter.booked", { name: who, day: day.slice(5), slot }));
              } catch (e) { fail(e); } finally { setBusy(false); }
            }} />
        )}
      </KeyboardScrollView>
      <Scanner open={scanOpen} onClose={() => setScanOpen(false)} onRead={(data) => { setScanOpen(false); setQ(""); void exact(data); }} />
    </Screen>
  );
}

/** Tests already done lately: each is a question for the clerk, acknowledged before the order goes. */
function Warnings({ warnings, acked, setAcked, t }: { warnings: WireDuplicateWarning[] | null; acked: string[]; setAcked: (f: (a: string[]) => string[]) => void; t: T }) {
  if (warnings === null || warnings.length === 0) return null;
  return (
    <View testID="qn-dups" style={[ls.card, { borderColor: color.goldLine }]}>
      <Text style={ls.cap}>{t("quickCounter.duplicates")}</Text>
      {warnings.map((w) => {
        const on = acked.includes(w.duplicateOfItemId);
        return (
          <Pressable key={w.duplicateOfItemId} testID={`qn-ack-${w.duplicateOfItemId}`} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
            onPress={() => setAcked((a) => (on ? a.filter((x) => x !== w.duplicateOfItemId) : [...a, w.duplicateOfItemId]))}
            style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start", minHeight: 36 }}>
            <Text style={{ fontSize: 16, color: on ? color.green : color.dim }}>{on ? "☑" : "☐"}</Text>
            <Text style={{ flex: 1, fontSize: 13.5, color: color.ink }}>{w.reason}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const cs = StyleSheet.create({
  input: { flex: 1, minHeight: TOUCH, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 15, color: color.ink },
  scan: { width: TOUCH, height: TOUCH, borderRadius: radius.md, backgroundColor: color.agent, alignItems: "center", justifyContent: "center" },
  found: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.md, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md },
  x: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  seg: { flex: 1, minHeight: TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  chip: { minHeight: 40, paddingHorizontal: 10, paddingVertical: 4, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  segOn: { backgroundColor: color.green, borderColor: color.green },
});

/** A test's parameters, read-only: what the lab will report for it. The web orders tests, never a lone parameter. */
function LineParams({ api, serviceId, code, t }: { api: CounterApi; serviceId: string; code: string; t: T }) {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let gone = false;
    api.orderable(serviceId).then((d) => { if (!gone) setNames(d.analytes.map((a) => a.nameEn)); }, () => { if (!gone) setNames([]); });
    return () => { gone = true; };
  }, [api, serviceId]);
  if (names === null) return null;
  return (
    <Text testID={`qn-params-${code}`} style={{ fontSize: 12, color: color.dim }}>
      {names.length === 0 ? t("quickCounter.noParams") : names.join(" · ")}
    </Text>
  );
}

/**
 * FUTURE APPOINTMENT — the web counter's booking: a day (closed weekdays off), a slot with room, the
 * tests, **Book**. On that day the booking shows in the web counter's requests, as a web booking does.
 */
function BookPanel({ api, t, serviceDate, serviceIds, picker, onBook, busy }: {
  api: CounterApi; t: T; serviceDate: string; serviceIds: string[]; picker: React.ReactNode; busy: boolean;
  onBook: (day: string, slot: string) => Promise<void>;
}) {
  const [hours, setHours] = useState<WireBookingHours | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slots, setSlots] = useState<WireLabDaySlots | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  useEffect(() => {
    api.hours().then(setHours, () => setHours({ open: "", close: "", slotMinutes: 0, perSlot: 0, daysAhead: 30, closedWeekdays: [0] }));
  }, [api]);
  const closed = useMemo(() => hours?.closedWeekdays ?? [0], [hours]);
  const days = useMemo(() => nextDays(serviceDate, Math.min(14, (hours?.daysAhead ?? 30) + 1)), [serviceDate, hours?.daysAhead]);
  useEffect(() => {
    if (hours === null || day !== null) return;
    setDay(days.find((d) => d !== serviceDate && !closed.includes(weekdayOf(d))) ?? days[1] ?? null);
  }, [hours, day, days, serviceDate, closed]);
  useEffect(() => {
    if (day === null) return;
    let gone = false;
    setSlots(null); setSlot(null);
    api.slots(day).then((r) => { if (!gone) setSlots(r); }, () => undefined);
    return () => { gone = true; };
  }, [api, day]);
  return (
    <View style={{ gap: space.md }} testID="qn-book-panel">
      <Text style={ls.cap}>1 · {t("quickCounter.pickDay")}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {days.map((d) => {
          const off = closed.includes(weekdayOf(d));
          const on = d === day;
          return (
            <Pressable key={d} testID={`qn-day-${d}`} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: off }} disabled={off} onPress={() => setDay(d)}
              style={[cs.chip, on && cs.segOn, off && { opacity: 0.35 }]}>
              <Text style={{ fontFamily: MONO, fontSize: 12, fontWeight: "700", color: on ? "#f2faf6" : color.ink }}>{d === serviceDate ? t("quickCounter.today") : d.slice(5)}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={ls.cap}>2 · {t("quickCounter.pickSlot")}</Text>
      {slots?.closed != null && <Text style={ls.sub}>{t(`quickCounter.dayClosed.${slots.closed}`)}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {(slots?.slots ?? []).map((x) => {
          const off = x.past || x.free === 0;
          const on = slot === x.start;
          return (
            <Pressable key={x.start} testID={`qn-slot-${x.start}`} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: off }} disabled={off} onPress={() => setSlot(x.start)}
              style={[cs.chip, { minWidth: 72 }, on && cs.segOn, off && { opacity: 0.4 }]}>
              <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: "700", color: on ? "#f2faf6" : color.ink }}>{x.start}</Text>
              <Text style={{ fontSize: 10.5, color: on ? "#f2faf6" : color.dim }}>{x.free === 0 ? t("quickCounter.full") : t("quickCounter.left", { n: x.free })}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={ls.cap}>3 · {t("quickCounter.pickTests")}</Text>
      {picker}
      <Button testID="qn-book" busy={busy} disabled={busy || day === null || slot === null || serviceIds.length === 0}
        label={slot === null || day === null ? t("quickCounter.bookPickSlot") : t("quickCounter.book", { day: day.slice(5), slot })}
        onPress={() => { if (day !== null && slot !== null) void onBook(day, slot); }} />
    </View>
  );
}
