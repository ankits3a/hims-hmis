import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AST_PANELS, antibioticsFor, astName, fillPanel } from "../../../../packages/contracts/src/lab-ast";
import type { AstBlock, AstDraftRow } from "../../../../packages/contracts/src/lab-ast";
import { Text, TextInput } from "../text";
import { color, radius, space } from "../theme";
import { MONO } from "../ui";
import { ls, type T } from "./ui";

/**
 * OWNER 2026-10-12 — THE ANTIBIOTIC SENSITIVITY TABLE ON THE PHONE (the web's `AstEditor`). One line
 * per antibiotic at 390 px: name, S / I / R, a small MIC box, ×. A panel chip fills the table; "Add
 * antibiotic" offers the combined list or takes a typed name. The rules (panels, urine-only drugs,
 * blank rows dropped, S/I/R, a plain-number MIC) are `packages/contracts/src/lab-ast.ts`, the server's.
 */

const SEG_BG: Record<string, string> = { S: color.green, I: "#b7791f", R: color.red };

export function AstEditor({ testCode, testName, rows, onChange, t }: {
  testCode: string; testName: string; rows: AstDraftRow[]; onChange: (rows: AstDraftRow[]) => void; t: T;
}) {
  const [q, setQ] = useState("");
  const qq = q.trim().toLowerCase();
  const have = new Set(rows.map((r) => r.antibiotic.toLowerCase()));
  const offered = qq === "" ? [] : antibioticsFor(testCode)
    .filter((c) => !have.has(c.toLowerCase()) && (c.toLowerCase().includes(qq) || astName(c).toLowerCase().includes(qq))).slice(0, 5);
  const add = (name0: string): void => {
    const name = name0.trim().slice(0, 60);
    setQ("");
    if (name === "" || have.has(name.toLowerCase())) return;
    onChange([...rows, { antibiotic: name, result: "", mic: null }]);
  };
  const set = (i: number, patch: Partial<AstDraftRow>): void => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <View style={ls.card} testID={`qb-ast-${testCode}`}>
      <Text style={ls.cap} numberOfLines={1}>{t("quickLab.ast.title")} · {testName}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {AST_PANELS.map((p) => (
          <Pressable key={p.id} testID={`qb-ast-panel-${p.id}`} accessibilityRole="button" accessibilityLabel={p.label}
            onPress={() => onChange(fillPanel(rows, p.id, testCode))}
            style={{ minHeight: 36, paddingHorizontal: 10, justifyContent: "center", borderRadius: 999, borderWidth: 1, borderColor: color.line, backgroundColor: color.card }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: color.ink }} numberOfLines={1}>{t(`quickLab.ast.panels.${p.id}`)}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {rows.length === 0 && <Text style={ls.sub}>{t("quickLab.ast.empty")}</Text>}
      {rows.map((r, i) => (
        <View key={r.antibiotic} testID={`qb-ast-row-${r.antibiotic}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, borderTopWidth: 1, borderTopColor: color.line2, paddingTop: 6 }}>
          <Text style={{ flex: 1, minWidth: 0, fontSize: 14, color: color.ink }} numberOfLines={1}>{astName(r.antibiotic)}</Text>
          {(["S", "I", "R"] as const).map((x) => {
            const on = r.result === x;
            return (
              <Pressable key={x} testID={`qb-ast-${r.antibiotic}-${x}`} accessibilityRole="button" accessibilityState={{ selected: on }}
                accessibilityLabel={`${astName(r.antibiotic)} ${t(`quickLab.ast.${x}`)}`}
                onPress={() => set(i, { result: on ? "" : x })}
                style={{ width: 36, height: 36, borderRadius: radius.md, borderWidth: 1, borderColor: on ? SEG_BG[x] : color.line, backgroundColor: on ? SEG_BG[x] : color.card, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 14, fontWeight: "800", color: on ? "#fff" : color.dim }}>{x}</Text>
              </Pressable>
            );
          })}
          <TextInput testID={`qb-ast-mic-${r.antibiotic}`} accessibilityLabel={`${astName(r.antibiotic)} ${t("quickLab.ast.mic")}`}
            placeholder={t("quickLab.ast.mic")} keyboardType="decimal-pad" value={r.mic ?? ""}
            onChangeText={(v) => set(i, { mic: v === "" ? null : v })}
            style={{ width: 56, height: 36, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 6, fontFamily: MONO, fontSize: 13, color: color.ink, backgroundColor: color.card }} />
          <Pressable testID={`qb-ast-remove-${r.antibiotic}`} accessibilityRole="button" accessibilityLabel={t("quickLab.ast.remove", { name: astName(r.antibiotic) })}
            hitSlop={6} onPress={() => onChange(rows.filter((_, j) => j !== i))} style={{ width: 24, alignItems: "center" }}>
            <Text style={{ fontSize: 18, color: color.faint }}>×</Text>
          </Pressable>
        </View>
      ))}
      <TextInput testID={`qb-ast-add-${testCode}`} accessibilityLabel={t("quickLab.ast.add")} placeholder={t("quickLab.ast.add")} value={q}
        onChangeText={setQ} onSubmitEditing={() => add(offered[0] ?? q)} autoCapitalize="none"
        style={{ minHeight: 40, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 10, fontSize: 14, color: color.ink, backgroundColor: color.card }} />
      {qq !== "" && (
        <View style={{ gap: 2 }}>
          {offered.map((c) => (
            <Pressable key={c} testID={`qb-ast-offer-${c}`} accessibilityRole="button" onPress={() => add(c)} style={{ minHeight: 36, justifyContent: "center", paddingHorizontal: space.sm }}>
              <Text style={{ fontSize: 14, color: color.ink }} numberOfLines={1}>{astName(c)} <Text style={{ fontFamily: MONO, fontSize: 11, color: color.faint }}>{c}</Text></Text>
            </Pressable>
          ))}
          <Pressable testID={`qb-ast-free-${testCode}`} accessibilityRole="button" onPress={() => add(q)} style={{ minHeight: 36, justifyContent: "center", paddingHorizontal: space.sm }}>
            <Text style={{ fontSize: 14, fontStyle: "italic", color: color.dim }} numberOfLines={1}>{t("quickLab.ast.addFree", { name: q.trim() })}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** The read-only table in Quick Reports: Resistant rows in bold red; the MIC column only when a row has one. */
export function AstView({ block, title, t }: { block: AstBlock; title: string; t: T }) {
  const withMic = block.rows.some((r) => r.mic !== null);
  return (
    <View style={{ gap: 4 }} testID={`qr-ast-${block.serviceId}`}>
      <Text style={ls.cap} numberOfLines={1}>{t("quickLab.ast.title")} · {title}</Text>
      {block.rows.map((r) => {
        const res = r.result === "R";
        return (
          <View key={r.antibiotic} testID={`qr-ast-row-${r.antibiotic}`} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, borderTopWidth: 1, borderTopColor: color.line2, paddingTop: 4 }}>
            <Text style={{ flex: 1, minWidth: 0, fontSize: 14, color: res ? color.red : color.ink, fontWeight: res ? "700" : "400" }} numberOfLines={1}>{astName(r.antibiotic)}</Text>
            <Text style={{ fontSize: 13.5, color: res ? color.red : color.ink, fontWeight: res ? "700" : "400" }} numberOfLines={1}>{t(`quickLab.ast.${r.result}`)} ({r.result})</Text>
            {withMic && <Text style={{ width: 52, textAlign: "right", fontFamily: MONO, fontSize: 13, color: color.dim }} numberOfLines={1}>{r.mic ?? ""}</Text>}
          </View>
        );
      })}
      {withMic && <Text style={{ fontSize: 11, color: color.faint, textAlign: "right" }}>{t("quickLab.ast.micUnit")}</Text>}
    </View>
  );
}
