import { Pressable, View } from "react-native";
import { Text } from "../text";
import { color, radius, space } from "../theme";
import { MONO } from "../ui";
import { paceShares, paceWholeMinutes } from "../../../../packages/contracts/src/my-pace";
import type { MyPace, PaceBlock, PacePeriod } from "../../../../packages/contracts/src/my-pace";

export type { MyPace, PaceBlock, PacePeriod };

/**
 * "MY PACE" (owner, 2026-10-09: "I also want each doctor to see their performance compared to other
 * doctor's average. Let the doctor see average time per consultation compared to average of the
 * department and average to the hospital.").
 *
 * NEUTRAL, ON PURPOSE. Time per patient is not a quality score: a longer consultation is not a worse
 * one and a shorter one is not a better one. So there is no red or green here, no "better"/"worse",
 * no arrow and no rank — a number, two averages and three bars on one scale, in the ink of the page.
 * `PACE_INK` is every colour a number or a bar may take; `my-pace.test.tsx` holds it to that.
 *
 * Every figure and every floor is the server's (`GET /me/performance`): a line it withheld arrives
 * with `enough: false` and is drawn as words ("Not enough yet") or a dash, never as a guess.
 */
export const PACE_INK = { own: color.ink, group: color.faint, track: color.wash, text: color.ink, quiet: color.dim } as const;

type T = (key: string, vars?: Record<string, string | number>) => string;

const LABEL_W = 76;

function Bar({ share, fill, testID }: { share: number | null; fill: string; testID: string }) {
  return (
    <View testID={testID} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: PACE_INK.track, overflow: "hidden" }}>
      {share !== null && <View testID={`${testID}-fill`} style={{ width: `${Math.round(share * 100)}%` as `${number}%`, height: 4, borderRadius: 2, backgroundColor: fill }} />}
    </View>
  );
}

/** The own number, big, and under it one short line and one thin bar per group — one shared scale. */
export function PaceLines({ block, t }: { block: PaceBlock; t: T }) {
  const groups = [
    ...(block.department === null ? [] : [{ key: "dept", g: block.department }]),
    { key: "hospital", g: block.all },
  ];
  const [ownShare, ...shares] = paceShares([block.own.meanMin, ...groups.map((x) => x.g.meanMin)]);
  const min = (m: number): string => t("pace.min", { n: paceWholeMinutes(m) });
  return (
    <View style={{ gap: 7 }}>
      <View style={{ gap: 5 }}>
        {block.own.meanMin === null
          ? <Text testID="pace-own" style={{ fontSize: 17, fontWeight: "700", color: PACE_INK.quiet }} numberOfLines={1}>{t("pace.notEnough")}</Text>
          : <Text testID="pace-own" style={{ fontFamily: MONO, fontSize: 28, fontWeight: "700", color: PACE_INK.text }} numberOfLines={1}>{min(block.own.meanMin)}</Text>}
        <View style={{ flexDirection: "row" }}><Bar testID="pace-bar-own" share={ownShare ?? null} fill={PACE_INK.own} /></View>
      </View>
      {groups.map((x, i) => (
        <View key={x.key} testID={`pace-row-${x.key}`} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ width: LABEL_W, fontSize: 13, color: PACE_INK.quiet }} numberOfLines={1}>{t(`pace.${x.key}`)}</Text>
          <Bar testID={`pace-bar-${x.key}`} share={shares[i] ?? null} fill={PACE_INK.group} />
          <Text testID={`pace-${x.key}`} style={{ minWidth: 64, textAlign: "right", fontFamily: MONO, fontSize: 13, fontWeight: "700", color: PACE_INK.text }} numberOfLines={1}>
            {x.g.meanMin === null ? t("pace.none") : min(x.g.meanMin)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The home card, under "My day". Drawn only for a login the server sent a measure; a tap opens the page. */
export function PaceCard({ pace, t, onOpen }: { pace: MyPace | null; t: T; onOpen: () => void }) {
  const block = pace?.consultation ?? null;
  if (pace === null || block === null) return null;
  return (
    <Pressable testID="home-pace" accessibilityRole="button" accessibilityLabel={t("pace.title")} onPress={onOpen}
      style={({ pressed }) => ({ backgroundColor: pressed ? color.wash : color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: 7 })}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Text style={{ fontSize: 13.5, fontWeight: "700", color: color.ink }} numberOfLines={1}>{t("pace.title")}</Text>
        <Text style={{ fontFamily: MONO, fontSize: 11, color: color.faint }} numberOfLines={1}>{`${t(`pace.period.${pace.period}`)}  ›`}</Text>
      </View>
      <Text style={{ fontSize: 11.5, color: color.dim }} numberOfLines={1}>{t("pace.sub")}</Text>
      <PaceLines block={block} t={t} />
    </Pressable>
  );
}
