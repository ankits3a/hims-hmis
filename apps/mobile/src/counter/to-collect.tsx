import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Button, MONO, Note, KeyboardModal } from "../ui";
import type { CounterApi } from "./api";
import { isGone, toCollectAct, toCollectAmount } from "../../../../packages/contracts/src/to-collect";
import type { WireToCollectRow } from "../../../../packages/contracts/src/to-collect";

/**
 * "TO COLLECT", ON THE DESK'S PHONE (owner 2026-10-09: *"'To collect' list for desk, with
 * money-off-doctor release: yes."*). The visits this hospital's desks let through unpaid, until the
 * fee is settled — the list the web desk and the billing counter draw, from the same read and in
 * the server's order (seen-and-gone first).
 *
 * Collect follows the phone's own rule (`toCollectAct`, the scan card's): it is offered to a login
 * that may issue a bill AND has a cash session open; anybody else reads "at the billing counter".
 * A desk screen only: nothing on the doctor's line, page or consultation opens this.
 */
export function ToCollectList({ api, held, mayOpenSession, onCollect, onClose }: {
  api: CounterApi; held: readonly string[];
  /** The login may hold a drawer at all (`billing.session.own`); without it nobody asks about one. */
  mayOpenSession: boolean;
  onCollect: (row: WireToCollectRow) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<WireToCollectRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [cashOpen, setCashOpen] = useState(false);

  const read = useCallback(() => {
    setFailed(false);
    api.toCollect().then((r) => setRows(r.items), () => setFailed(true));
    if (mayOpenSession && held.includes("billing.invoice.issue")) api.cashSession().then((r) => setCashOpen(r.session !== null), () => setCashOpen(false));
  }, [api, held, mayOpenSession]);
  useEffect(() => { read(); }, [read]);

  const act = toCollectAct(held, cashOpen);
  return (
    <KeyboardModal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: color.paper }} testID="to-collect-list">
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: space.xxl, gap: space.md }}>
          <Text style={[type.heading, { color: color.ink }]} testID="to-collect-title">{t("toCollect.count", { n: rows?.length ?? 0 })}</Text>
          {failed && (
            <View style={{ gap: space.sm }}>
              <Note tone="warn" testID="to-collect-failed">{t("mobile.counter.appt.readFailed")}</Note>
              <Button testID="to-collect-retry" kind="secondary" label={t("mobile.vitals.retry")} onPress={read} />
            </View>
          )}
          {rows === null && !failed && <Text style={s.dim}>{t("mobile.counter.reading")}</Text>}
          {rows !== null && rows.length === 0 && <Note tone="info" testID="to-collect-none">{t("toCollect.none")}</Note>}
          {(rows ?? []).map((r) => (
            <View key={r.encounterId} style={[s.card, isGone(r) && { borderColor: color.goldLine }]} testID={`to-collect-row-${r.encounterId}`}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <Text style={s.token}>{r.tokenNo ?? "—"}</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[type.body, { color: color.ink, fontWeight: "700" }]} numberOfLines={1}>{r.patientName}</Text>
                  <Text testID={`to-collect-state-${r.encounterId}`} numberOfLines={1} style={[type.small, { color: isGone(r) ? "#8a5a10" : color.dim, fontWeight: isGone(r) ? "700" : "400" }]}>
                    {t(`toCollect.state.${r.state}`)}
                  </Text>
                </View>
                <Text style={s.amount} testID={`to-collect-amount-${r.encounterId}`}>{toCollectAmount(r.amountDuePaise)}</Text>
              </View>
              <Text style={s.dim} numberOfLines={2}>{t("toCollect.why", { by: r.letThroughBy, mins: r.minutesSince, reason: r.reason })}</Text>
              {act === "collect"
                ? <Button testID={`to-collect-go-${r.encounterId}`} label={t("toCollect.collect")} onPress={() => onCollect(r)} />
                : <Text style={s.counter} numberOfLines={1} testID={`to-collect-counter-${r.encounterId}`}>{t("toCollect.atCounter")}</Text>}
            </View>
          ))}
          <Button testID="to-collect-close" kind="secondary" label={t("mobile.doctor.cancel")} onPress={onClose} />
        </ScrollView>
      </View>
    </KeyboardModal>
  );
}

const s = StyleSheet.create({
  dim: { ...type.small, color: color.dim },
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  token: { fontFamily: MONO, fontSize: 22, fontWeight: "700", color: color.ink, minWidth: 34 },
  amount: { fontFamily: MONO, fontSize: 17, fontWeight: "700", color: color.ink },
  counter: { ...type.small, color: color.dim, fontWeight: "700" },
});
