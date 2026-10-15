import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Button, MONO, Note, KeyboardModal } from "../ui";
import { refusalText } from "../vitals/api";
import type { CounterApi, WireDoctorSummary, WireInvoiceRow, WireMoveResult, WirePrintJob } from "./api";
import { MoveDepartment } from "./move";
import { paperState, rs } from "./rules";
import type { CounterTimelineItem, DeptQueue, MoveConsultTerms } from "./rules";

/**
 * THE VISIT CARD ON THE PHONE (owner 2026-10-05: one card, the same everywhere; the web's
 * `desk-one/visit-card.tsx`). One visit from the patient's history: what it is, the paper it put on
 * the counter's printer (and "print again" — a reprint is a NEW server job, so who printed it again
 * stays answerable), the bills raised for it, and "Change department".
 *
 * Every block is its own permission on the server (`opd.paper.reprint`, `billing.invoice.read`,
 * `opd.visits.open`). A block this login may not read is simply absent — never an error on the card.
 */
const MOVABLE = new Set(["registered", "waiting"]);

export function VisitCard({ api, visit, today, mayMove, mayPaper, mayBills, queues, labelOf, terms, onMoved, onClose }: {
  api: CounterApi;
  visit: CounterTimelineItem;
  today: string;
  mayMove: boolean; mayPaper: boolean; mayBills: boolean;
  queues: DeptQueue<WireDoctorSummary>[];
  labelOf: (doctor: { userId: string; designation?: string | null }) => string | null;
  terms: MoveConsultTerms | undefined;
  onMoved: (result: WireMoveResult, to: { departmentName: string; doctor: WireDoctorSummary }) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [jobs, setJobs] = useState<WirePrintJob[] | null>(null);
  const [bills, setBills] = useState<WireInvoiceRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ tone: "info" | "bad"; text: string } | null>(null);
  const [moving, setMoving] = useState(false);

  const readPaper = useCallback(() => {
    if (!mayPaper) return;
    api.printJobs(visit.encounterId).then((r) => setJobs(r.jobs), () => undefined);
  }, [api, mayPaper, visit.encounterId]);
  useEffect(() => {
    readPaper();
    if (mayBills) api.invoices(visit.encounterId).then((r) => setBills(r.items), () => undefined);
  }, [api, mayBills, readPaper, visit.encounterId]);

  const again = async (job: WirePrintJob): Promise<void> => {
    setBusy(job.id); setSaid(null);
    try {
      const r = await api.reprint(job.id);
      // `{ id: null }` is the server's one answer for "no such job" and "not yours to print".
      setSaid(r.id === null ? { tone: "bad", text: t("mobile.counter.paper.refused") } : { tone: "info", text: t("mobile.counter.paper.sentAgain", { doc: t(`mobile.counter.doc.${job.document}`) }) });
      readPaper();
    } catch (e) {
      setSaid({ tone: "bad", text: e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const isToday = visit.serviceDate.slice(0, 10) === today;
  const movable = mayMove && isToday && MOVABLE.has(visit.status);
  const paper = paperState(jobs ?? []);
  const day = visit.serviceDate.slice(0, 10).split("-").reverse().join("-");

  return (
    <KeyboardModal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: color.paper }} testID="visit-card">
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: space.xxl, gap: space.lg }}>
          <View>
            <Text style={[type.tag, { color: color.dim, fontFamily: MONO }]}>{t("mobile.counter.card.title")}</Text>
            <Text style={[type.title, { color: color.ink, fontFamily: MONO }]} testID="visit-card-no">{visit.visitNo ?? "—"}</Text>
            <Text style={[type.body, { color: color.dim }]}>{[day, visit.departmentName, visit.doctorName].filter((x) => x !== null && x !== "").join(" · ")}</Text>
            <Text testID="visit-card-status" style={[s.status]}>{t(`mobile.counter.status.${visit.status}`)}</Text>
          </View>

          {movable ? (
            <Button testID="visit-card-move" kind="secondary" label={t("registrationCounter.move.open")} onPress={() => setMoving(true)} />
          ) : mayMove && isToday ? (
            // Once the doctor has seen the patient it is a referral, not a desk correction (owner 2026-10-05).
            <Note tone="info" testID="visit-card-nomove">{t("mobile.counter.card.noMove")}</Note>
          ) : null}

          {mayPaper && (
            <View style={s.block} testID="visit-card-paper">
              <Text style={s.blockTitle}>{t("mobile.counter.card.paper")}</Text>
              {jobs === null ? <Text style={s.dim}>{t("mobile.counter.reading")}</Text>
                : paper.current.length === 0 ? <Text style={s.dim}>{t("mobile.counter.card.noPaper")}</Text>
                : paper.current.map((j) => (
                  <View key={j.id} style={s.row} testID={`paper-${j.document}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={[type.body, { color: color.ink }]}>{t(`mobile.counter.doc.${j.document}`)}</Text>
                      <Text style={[type.small, { color: j.status === "failed" ? color.red : color.dim, fontWeight: j.status === "failed" ? "700" : "400" }]}>{t(`mobile.counter.paper.job.${j.status}`)}</Text>
                    </View>
                    <View style={{ width: 132 }}>
                      <Button testID={`reprint-${j.document}`} kind="secondary" busy={busy === j.id} label={t("mobile.counter.paper.again")} onPress={() => { void again(j); }} />
                    </View>
                  </View>
                ))}
              {said !== null && <View style={{ marginTop: space.sm }}><Note tone={said.tone} testID="visit-card-said">{said.text}</Note></View>}
              <Text style={[type.small, { color: color.faint }]}>{t("mobile.counter.paper.where")}</Text>
            </View>
          )}

          {mayBills && (
            <View style={s.block} testID="visit-card-bills">
              <Text style={s.blockTitle}>{t("mobile.counter.card.bills")}</Text>
              {bills === null ? <Text style={s.dim}>{t("mobile.counter.reading")}</Text>
                : bills.length === 0 ? <Text style={s.dim}>{t("mobile.counter.card.noBills")}</Text>
                : bills.map((b) => (
                  <View key={b.id} style={s.row}>
                    <Text style={[type.body, { color: color.ink, fontFamily: MONO, flex: 1 }]}>{b.invoiceNo}</Text>
                    <Text style={[type.body, { color: color.ink, fontWeight: "700" }]}>{rs(b.netPayablePaise)}</Text>
                  </View>
                ))}
            </View>
          )}
        </ScrollView>
        <View style={[s.bar, { paddingBottom: insets.bottom + space.md }]}>
          <Button testID="visit-card-close" kind="secondary" label={t("mobile.back")} onPress={onClose} />
        </View>
        {moving && (
          <MoveDepartment
            api={api} queues={queues} labelOf={labelOf} terms={terms}
            visit={{ encounterId: visit.encounterId, departmentId: visit.departmentId, departmentName: visit.departmentName, doctorName: visit.doctorName, tokenText: null }}
            onMoved={(r, to) => { setMoving(false); onMoved(r, to); }}
            onClose={() => setMoving(false)}
          />
        )}
      </View>
    </KeyboardModal>
  );
}

const s = StyleSheet.create({
  status: { ...type.tag, color: color.green, fontFamily: MONO, marginTop: 6 },
  block: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  blockTitle: { ...type.heading, color: color.ink },
  dim: { ...type.small, color: color.dim },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.line2 },
  bar: { paddingHorizontal: space.lg, paddingTop: space.md, backgroundColor: color.card, borderTopWidth: 1, borderTopColor: color.line },
});
