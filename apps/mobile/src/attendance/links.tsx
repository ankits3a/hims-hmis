import { useEffect, useState } from "react";
import { View } from "react-native";
import { useI18n, type Lang } from "../i18n";
import { Text } from "../text";
import { color, radius, space } from "../theme";
import { attendanceApi, type LinkCounts } from "./api";
import { TONE } from "./views";

/**
 * #928 (follow-up to #634) — THE LINK COUNT, AS THE WEB'S `/attendance/links` SHOWS IT: how many of the
 * machine's active people are linked to an HMIS login, how many are not, how many need a person to
 * decide, and how many logins are somebody's attendance record. Numbers only — the server's reply also
 * carries the first page of unlinked names, which this neither draws nor keeps; no mobile or Aadhaar
 * is in it at all. For holders of `attendance.all.read` (the Today tab). A failed read draws nothing.
 */

/**
 * The web's own sentences (`attendanceLinks.heading`, `attendanceLinks.count.*` in apps/web/src/locales),
 * word for word — a test holds them equal. Kept beside the code until they move into locales/*.json.
 */
export const LINK_WORDS: Record<Lang, Record<"heading" | "linked" | "pct" | "unlinked" | "attention" | "logins", string>> = {
  en: {
    heading: "Attendance links",
    linked: "{{linked}} of {{active}} linked",
    pct: "{{pct}}%",
    unlinked: "Not linked: {{n}}",
    attention: "Need a person: {{n}}",
    logins: "Logins linked: {{linked}} of {{active}}",
  },
  hi: {
    heading: "उपस्थिति लिंक",
    linked: "{{active}} में से {{linked}} लिंक",
    pct: "{{pct}}%",
    unlinked: "लिंक नहीं: {{n}}",
    attention: "व्यक्ति चाहिए: {{n}}",
    logins: "लिंक लॉगिन: {{active}} में से {{linked}}",
  },
};

const fill = (text: string, vars: Record<string, string | number>): string => text.replace(/\{\{(\w+)\}\}/g, (_, v: string) => String(vars[v] ?? ""));
const n = (v: number): string => v.toLocaleString("en-IN");

export function LinkCount({ call }: { call: Parameters<typeof attendanceApi>[0] }) {
  const { lang } = useI18n();
  const w = LINK_WORDS[lang];
  const [counts, setCounts] = useState<LinkCounts | null>(null);
  useEffect(() => {
    let gone = false;
    void attendanceApi(call).linkCounts().then((c) => { if (!gone) setCounts(c); }, () => undefined);
    return () => { gone = true; };
  }, [call]);
  if (counts === null) return null;
  const pct = counts.active === 0 ? 0 : Math.round((counts.linked / counts.active) * 100);
  const attention = counts.needsAttention > 0;
  return (
    <View testID="att-links" accessibilityLabel={w.heading} style={{ gap: 6, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: space.md }}>
      <Text numberOfLines={1} style={{ fontSize: 11.5, fontWeight: "700", color: color.dim }}>{w.heading}</Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
        <Text testID="att-links-linked" numberOfLines={1} style={{ flexShrink: 1, fontSize: 17, fontWeight: "700", color: color.ink }}>{fill(w.linked, { linked: n(counts.linked), active: n(counts.active) })}</Text>
        <Text testID="att-links-pct" numberOfLines={1} style={{ fontSize: 12.5, color: color.dim }}>{fill(w.pct, { pct })}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: color.line2, overflow: "hidden" }}>
        <View style={{ width: `${pct}%`, height: "100%", backgroundColor: color.green }} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.md, rowGap: 2 }}>
        <Text testID="att-links-unlinked" style={{ fontSize: 12.5, color: color.ink }}>{fill(w.unlinked, { n: n(counts.unlinked) })}</Text>
        <Text testID="att-links-attention" style={{ fontSize: 12.5, color: attention ? TONE.warn.fg : color.ink, fontWeight: attention ? "700" : "400" }}>{fill(w.attention, { n: n(counts.needsAttention) })}</Text>
        <Text testID="att-links-logins" style={{ fontSize: 12.5, color: color.ink }}>{fill(w.logins, { linked: n(counts.loginsLinked), active: n(counts.loginsActive) })}</Text>
      </View>
    </View>
  );
}
