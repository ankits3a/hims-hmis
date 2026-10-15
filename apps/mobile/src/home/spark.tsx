import { View } from "react-native";
import { color } from "../theme";
import { sparkPoints, type DayPoint } from "./rules";

/**
 * The 30-day line, drawn with plain Views (a rotated bar per segment) — no SVG module, so the home
 * screen needs nothing native that the build does not already carry. One point per WORKING day.
 */
export function Spark({ series, width, height, testID }: { series: readonly DayPoint[]; width: number; height: number; testID?: string }) {
  const pts = sparkPoints(series, width, height);
  if (pts.length === 0) return <View testID={testID} style={{ width, height }} />;
  const last = pts[pts.length - 1]!;
  return (
    <View testID={testID} accessibilityRole="image" style={{ width, height }}>
      {pts.slice(1).map((p, i) => {
        const a = pts[i]!;
        const dx = p.x - a.x, dy = p.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        return (
          <View key={i} style={{
            position: "absolute", left: (a.x + p.x) / 2 - len / 2, top: (a.y + p.y) / 2 - 1, width: len, height: 2, borderRadius: 1,
            backgroundColor: color.green, transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
          }} />
        );
      })}
      <View style={{ position: "absolute", left: last.x - 4, top: last.y - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: color.green }} />
    </View>
  );
}
