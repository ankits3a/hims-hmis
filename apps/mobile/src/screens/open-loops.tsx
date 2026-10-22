import { useEffect } from "react";
import { ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Text } from "../text";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { color, radius, space, type } from "../theme";
import { Band, Button } from "../ui";
import { appTargetOf } from "../../../../packages/contracts/src/waiting";
import { WaitingRow, openWaiting, useWaiting } from "../waiting/card";
import { viewerOf } from "../results/api";

/**
 * E1.4 (decision 0064) — OPEN LOOPS: every line of `GET /me/waiting`, the same list the web's My day
 * draws. A line with a phone screen opens it; lab reports back and imaging reports open the read-only
 * results viewer (#681) — a critical still says it is acknowledged on the computer; the rest (the
 * bench, the reading room, lab criticals) says where, in a few words. `?kind=` marks the tapped line.
 */
export function OpenLoopsScreen({ nowMs = Date.now }: { nowMs?: () => number }) {
  const { t } = useI18n();
  const router = useRouter();
  const { call } = useSession();
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  const { lines, reload } = useWaiting(call, true);
  useEffect(() => { void reload(); }, [reload]);
  const now = nowMs();
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={<Button kind="secondary" label={t("openLoops.back")} onPress={() => router.back()} testID="loops-back" />} />
      <ScrollView testID="loops" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.sm }}>
        <Text style={[type.title, { color: color.ink }]} numberOfLines={1}>{t("openLoops.loops")}</Text>
        {lines !== null && lines.length === 0 && <Text testID="loops-none" style={[type.small, { color: color.dim }]} numberOfLines={1}>{t("openLoops.nothing")}</Text>}
        {lines !== null && lines.map((l) => {
          const here = appTargetOf(l.kind).type === "loops";
          const viewer = here ? viewerOf(l.kind) : null;
          /* #681 — a report line opens the viewer; a critical keeps its "on computer" words (acknowledged there). */
          const where = here && (viewer === null || l.kind === "radiology.criticalsMine") ? t(`openLoops.where.${l.kind}`) : null;
          const press = viewer !== null ? () => router.push({ pathname: "/results", params: { kind: viewer } })
            : here ? undefined : () => openWaiting(router.push, l.kind);
          return (
            <View key={l.kind} style={{ backgroundColor: color.card, borderWidth: kind === l.kind ? 2 : 1, borderColor: kind === l.kind ? color.ink : color.line, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.xs }}>
              <WaitingRow t={t} line={l} nowMs={now}
                where={where} onPress={press} />
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
