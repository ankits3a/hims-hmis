import { View } from "react-native";

/**
 * A QR code drawn from rows the SERVER encoded ('1' is a dark module) — the same encoder the
 * prescription sheet's code comes from. Plain Views, one per run of dark modules: the app carries no
 * QR library and fetches nothing to draw this. Two quiet modules on every side, on white, are what
 * a camera needs to find the square.
 */
export function QrRows({ rows, size, label, testID }: { rows: readonly string[]; size: number; label: string; testID?: string }) {
  const quiet = 2;
  const cell = Math.max(1, Math.floor(size / (rows.length + quiet * 2)));
  return (
    <View testID={testID} accessible accessibilityRole="image" accessibilityLabel={label}
      style={{ backgroundColor: "#ffffff", padding: cell * quiet, alignSelf: "center", borderRadius: 4 }}>
      {rows.map((row, y) => {
        const runs: { dark: boolean; n: number }[] = [];
        for (const ch of row) {
          const dark = ch === "1";
          const last = runs[runs.length - 1];
          if (last !== undefined && last.dark === dark) last.n += 1; else runs.push({ dark, n: 1 });
        }
        return (
          <View key={y} style={{ flexDirection: "row", height: cell }}>
            {runs.map((r, i) => <View key={i} style={{ width: r.n * cell, height: cell, backgroundColor: r.dark ? "#000000" : "#ffffff" }} />)}
          </View>
        );
      })}
    </View>
  );
}
