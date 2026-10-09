import { Pressable, View } from "react-native";
import { Text } from "../text";
import { color, radius, space } from "../theme";
import { MONO } from "../ui";
import type { OwnerTile, OwnerTileKey, TileTone } from "./model";

/**
 * THE TILES (owner 2026-10-09, board frame 1): two columns, one number each, one short line under it.
 * Every line is ONE line at 360 px — a label, a number, a sub-line of at most fourteen characters.
 * Eight tiles are four even rows; with seven (no Money tile) the last, Learning, runs the full width (`isWideTile`).
 * A tile whose read failed shows "—" and still opens its page.
 */
type T = (key: string, vars?: Record<string, string | number>) => string;
const TONE: Record<TileTone, string> = { up: color.green, down: color.red, warn: "#8a5a10", plain: color.dim };

export function subText(tile: Pick<OwnerTile, "sub">, t: T): string | null {
  if (tile.sub === null) return null;
  return "text" in tile.sub ? tile.sub.text : t(tile.sub.key, tile.sub.vars);
}

function Tile({ tile, t, onOpen }: { tile: OwnerTile; t: T; onOpen?: (key: OwnerTileKey) => void }) {
  const sub = subText(tile, t);
  return (
    <Pressable testID={`owner-tile-${tile.key}`} accessibilityRole="button" disabled={onOpen === undefined}
      accessibilityLabel={[t(tile.labelKey), tile.failed ? t("owner.notLoaded") : tile.value, sub].filter((x) => x !== null).join(", ")}
      onPress={() => onOpen?.(tile.key)}
      style={({ pressed }) => ({
        flex: 1, flexBasis: 0, minWidth: 0, minHeight: 84, backgroundColor: pressed ? color.wash : color.card, borderWidth: 1, borderColor: color.line,
        borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 10, justifyContent: "space-between",
      })}>
      <Text style={{ fontSize: 12, color: color.dim }} numberOfLines={1}>{t(tile.labelKey)}</Text>
      <Text testID={`owner-tile-value-${tile.key}`} numberOfLines={1} adjustsFontSizeToFit
        style={{ fontFamily: MONO, fontWeight: "700", fontSize: 22, lineHeight: 28, color: tile.failed ? color.faint : color.ink }}>{tile.value}</Text>
      <Text testID={`owner-tile-sub-${tile.key}`} numberOfLines={1} style={{ fontSize: 12, fontWeight: "600", color: TONE[tile.tone] }}>{sub ?? " "}</Text>
    </Pressable>
  );
}

export function OwnerTiles({ tiles, t, onOpen }: { tiles: readonly OwnerTile[]; t: T; onOpen?: (key: OwnerTileKey) => void }) {
  const narrow = tiles.filter((x) => !x.wide);
  const rows: OwnerTile[][] = [];
  for (let i = 0; i < narrow.length; i += 2) rows.push(narrow.slice(i, i + 2));
  return (
    <View testID="owner-tiles" style={{ gap: space.sm }}>
      {rows.map((row) => (
        <View key={row[0]!.key} style={{ flexDirection: "row", gap: space.sm }}>
          {/* A plain, unpadded cell holds each tile, so a lone tile is exactly as wide as a paired one. */}
          {row.map((tile) => <View key={tile.key} style={{ flex: 1, flexBasis: 0, minWidth: 0, flexDirection: "row" }}><Tile tile={tile} t={t} onOpen={onOpen} /></View>)}
          {row.length === 1 && <View style={{ flex: 1, flexBasis: 0, minWidth: 0 }} />}
        </View>
      ))}
      {tiles.filter((x) => x.wide).map((tile) => (
        <View key={tile.key} style={{ flexDirection: "row" }}><Tile tile={tile} t={t} onOpen={onOpen} /></View>
      ))}
    </View>
  );
}
