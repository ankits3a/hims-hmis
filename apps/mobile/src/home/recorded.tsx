import { Pressable, View } from "react-native";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { MONO } from "../ui";
import { onRecord, recordedPercent, recordingState } from "../../../../packages/contracts/src/recording";
import type { RecordingCounts, RecordingReport } from "../../../../packages/contracts/src/recording";

export type { RecordingCounts, RecordingReport };

/**
 * "RECORDED TODAY" on the home screen (owner, 2026-10-07: "Yes, show a daily count on the screens.").
 * Care is on paper; this card says how much of today's is on record. Every figure is the server's
 * (`/opd/reports/recording` — a desk sees the hospital's integers, a doctor their own); this file only
 * chooses WHICH sentence a person reads first, by what they do:
 *
 *   slip desk  — slips photographed of those consulted, typed, not recorded · "Scan a slip"
 *   scribe     — how many photographed papers wait to be typed (typing is on the computer)
 *   doctor     — their own patients: seen, prescribed on a screen, on paper (photographed)
 *   everyone else who is sent a count (front desk, supervisor, owner) — the hospital line;
 *   the owner also gets "See by doctor".
 *
 * The state is said in WORDS — the bar repeats it, it does not carry it.
 */
export type RecordedRole = "slips" | "scribe" | "doctor" | "hospital";

export function recordedRole(r: RecordingReport, seats: readonly string[], permissions: readonly string[]): RecordedRole {
  if (r.scope === "mine") return "doctor";
  if (permissions.includes("opd.prescription.transcribe") && !permissions.includes("opd.reports.read")) return "scribe";
  if (seats.includes("slips") && permissions.includes("opd.consult.paper") && !permissions.includes("opd.reports.read")) return "slips";
  return "hospital";
}

type T = (key: string, vars?: Record<string, string | number>) => string;

export function RecordedCard({ r, seats, permissions, t, onScan, onByDoctor }: {
  r: RecordingReport | null; seats: readonly string[]; permissions: readonly string[]; t: T;
  onScan: () => void; onByDoctor: () => void;
}) {
  if (r === null || r.scope === "none" || r.totals === null) return null;
  const role = recordedRole(r, seats, permissions);
  const c: RecordingCounts = r.totals;
  const state = recordingState(c);
  const pct = recordedPercent(c);
  const lead = state === "nothing_yet" ? t(role === "doctor" ? "recorded.nothingYetMine" : "recorded.nothingYet")
    : state === "all" ? t("recorded.all", { n: c.consulted })
    : t("recorded.missing", { n: c.notRecorded, of: c.consulted });
  const line = role === "slips" ? t("recorded.line.slips", { photographed: c.photographed, of: c.consulted, typed: c.typed, not: c.notRecorded })
    : role === "scribe" ? t("recorded.line.scribe", { n: c.toType, typed: c.typed })
    : role === "doctor" ? t("recorded.line.doctor", { seen: c.consulted, issued: c.issued, paper: c.onPaper, photographed: c.photographed })
    : t("recorded.line.hospital", { consulted: c.consulted, issued: c.issued, photographed: c.photographed, typed: c.typed });
  const leadColor = state === "all" ? color.green : state === "nothing_yet" ? color.dim : color.red;
  return (
    <View testID="home-recorded" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: 7 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Text style={{ fontSize: 13.5, fontWeight: "700", color: color.ink }}>{t(role === "doctor" ? "recorded.titleMine" : "recorded.title")}</Text>
        <Text style={{ fontFamily: MONO, fontSize: 11, color: color.faint }}>{t(role === "doctor" ? "recorded.scopeMine" : "recorded.scopeHospital")}</Text>
      </View>
      <Text testID="recorded-lead" style={{ fontSize: 14, fontWeight: "600", color: leadColor }}>{lead}</Text>
      {pct !== null && (
        <View testID="recorded-bar" accessible accessibilityRole="progressbar" accessibilityLabel={t("recorded.bar", { on: onRecord(c), of: c.consulted })} style={{ height: 6, borderRadius: 3, backgroundColor: color.wash, overflow: "hidden" }}>
          <View style={{ width: `${pct}%`, height: 6, backgroundColor: color.green, borderRadius: 3 }} />
        </View>
      )}
      <Text testID="recorded-line" style={[type.small, { color: color.dim }]}>{line}</Text>
      {role === "scribe" && <Text style={{ fontSize: 11.5, color: color.faint }}>{t("recorded.onComputer")}</Text>}
      {role === "slips" && (
        <Pressable testID="recorded-scan" accessibilityRole="button" onPress={onScan} style={{ alignSelf: "flex-start", minHeight: 40, justifyContent: "center", paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: color.green }}>
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13.5 }}>{t("recorded.scan")}</Text>
        </Pressable>
      )}
      {r.doctors !== null && (
        <Pressable testID="recorded-by-doctor" accessibilityRole="button" onPress={onByDoctor} style={{ alignSelf: "flex-start", minHeight: 40, justifyContent: "center", paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.line }}>
          <Text style={{ color: color.green, fontWeight: "700", fontSize: 13.5 }}>{t("recorded.byDoctor")}</Text>
        </Pressable>
      )}
    </View>
  );
}
