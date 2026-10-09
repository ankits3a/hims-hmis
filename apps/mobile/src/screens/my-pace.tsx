import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { NetworkError } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, Button, Note } from "../ui";
import { PaceLines, type MyPace, type PacePeriod } from "../home/pace";
import { PACE_DEFAULT_PERIOD, PACE_PERIODS } from "../../../../packages/contracts/src/my-pace";

/**
 * "MY PACE" — the page behind the home card (owner 2026-10-09). Period chips, the three numbers with
 * their bars, how many consultations they are over, and one line when paper visits were left out.
 * Nothing else: no leaderboard, no per-day chart, no colleague. Neutral for the reason `home/pace.tsx`
 * gives — time per patient is not a quality score.
 */
export function MyPaceScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const { call } = useSession();
  const [period, setPeriod] = useState<PacePeriod>(PACE_DEFAULT_PERIOD);
  const [r, setR] = useState<MyPace | null>(null);
  const [failed, setFailed] = useState<"offline" | "refused" | null>(null);
  const load = useCallback(async (p: PacePeriod) => {
    try { setR(await call<MyPace>("GET", `/me/performance?period=${p}`)); setFailed(null); } catch (e) { setFailed(e instanceof NetworkError ? "offline" : "refused"); }
  }, [call]);
  useEffect(() => { void load(period); }, [load, period]);
  /* The answer on screen is the one for the chip that is lit — an older period's figures are not shown under a new chip. */
  const block = r !== null && r.period === period ? r.consultation : null;
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={<Button kind="secondary" label={t("pace.back")} onPress={() => router.back()} testID="pace-back" />} />
      <ScrollView testID="pace-scroll" contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <Text style={[type.title, { color: color.ink }]} numberOfLines={1}>{t("pace.title")}</Text>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          {PACE_PERIODS.map((p) => {
            const on = p === period;
            return (
              <Pressable key={p} testID={`pace-chip-${p}`} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setPeriod(p)}
                style={{ flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: on ? 2 : 1, borderColor: on ? color.ink : color.line, backgroundColor: on ? color.wash : color.card }}>
                <Text style={{ fontSize: 13.5, fontWeight: "700", color: on ? color.ink : color.dim }} numberOfLines={1}>{t(`pace.period.${p}`)}</Text>
              </Pressable>
            );
          })}
        </View>
        {failed !== null && <Note tone="warn" testID="pace-failed">{t(failed === "offline" ? "pace.offline" : "pace.refused")}</Note>}
        {failed !== null && <Button kind="secondary" label={t("pace.again")} onPress={() => { void load(period); }} testID="pace-again" />}
        {block !== null && (
          <View testID="pace-card" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: 7 }}>
            <Text style={{ fontSize: 11.5, color: color.dim }} numberOfLines={1}>{t("pace.sub")}</Text>
            <PaceLines block={block} t={t} />
            <View style={{ borderTopWidth: 1, borderTopColor: color.line2, paddingTop: 7, gap: 2 }}>
              <Text testID="pace-count" style={[type.small, { color: color.dim }]} numberOfLines={1}>{t("pace.count", { n: block.own.n })}</Text>
              {block.excluded.paper > 0 && <Text testID="pace-paper" style={[type.small, { color: color.dim }]} numberOfLines={1}>{t("pace.paper")}</Text>}
            </View>
          </View>
        )}
        {r !== null && r.period === period && r.consultation === null && failed === null && <Note tone="info" testID="pace-nothing">{t("pace.noMeasure")}</Note>}
      </ScrollView>
    </View>
  );
}
