import { View } from "react-native";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";

/**
 * #674 — THE DAY REPORT ON THE PHONE, as compact sections (DECIDED: compact sections, not a link out).
 *
 * The same payload the web dock draws as a table (`apps/web/src/components/copilot-report.tsx`): every
 * cell is already a string the server formatted, so nothing here does arithmetic. A 390 px screen cannot
 * hold six columns, so each section is its title, its column heads on one line, then each row on one
 * line with its cells joined by " · " — the table's order, read across. A long section shows its first
 * {@link ROWS_SHOWN} rows and says how many more are on the computer (My day / the CSV).
 */
export type CopilotDayReport = {
  date: string;
  provisional: boolean;
  sections: { key: string; titleKey: string; columnKeys: string[]; rows: string[][]; totals?: string[] }[];
};

export const ROWS_SHOWN = 8;

type Tr = (key: string, vars?: Record<string, string | number>) => string;

export function isDayReport(p: unknown): p is CopilotDayReport {
  if (typeof p !== "object" || p === null) return false;
  const r = p as Partial<CopilotDayReport>;
  return typeof r.date === "string" && Array.isArray(r.sections);
}

/**
 * A cell is data, a key, or a code — ported from the web's My day `cellText`: a `report.` key is
 * translated, a status/type/outcome code is worded from `report.value.*`, a name is left as it came.
 */
const CODED = new Set(["report.col.type", "report.col.status", "report.col.outcome"]);
export function cellText(t: Tr, columnKey: string | undefined, cell: string): string {
  if (columnKey === "report.col.patient") return cell;
  if (cell.startsWith("report.")) return t(cell);
  if (columnKey !== undefined && CODED.has(columnKey) && cell !== "") {
    const w = t(`report.value.${cell}`);
    return w === `report.value.${cell}` ? cell : w;
  }
  return cell;
}

export function DayReport({ n, report, t }: { n: number; report: CopilotDayReport; t: Tr }) {
  const id = `copilot-report-${String(n)}`;
  const line = [type.small, { color: color.ink }];
  return (
    <View testID={id} style={{ borderTopWidth: 1, borderColor: color.line, paddingTop: space.sm, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text testID={`${id}-title`} numberOfLines={1} style={[type.small, { flex: 1, color: color.ink, fontWeight: "700" }]}>{t("copilot.report.title", { date: report.date })}</Text>
        {report.provisional && (
          <Text testID={`${id}-provisional`} numberOfLines={1}
            style={{ fontSize: 12, fontWeight: "700", color: color.dim, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 6 }}>
            {t("copilot.report.provisional")}
          </Text>
        )}
      </View>
      {report.sections.map((section, si) => {
        const sid = `${id}-s${String(si)}`;
        const shown = section.rows.slice(0, ROWS_SHOWN);
        const more = section.rows.length - shown.length;
        return (
          <View key={section.key} testID={sid} style={{ gap: 2 }}>
            <Text testID={`${sid}-title`} numberOfLines={1} style={[type.tag, { color: color.faint }]}>{t(section.titleKey)}</Text>
            {section.rows.length === 0
              ? <Text testID={`${sid}-empty`} numberOfLines={1} style={[type.small, { color: color.dim }]}>{t("copilot.report.emptySection")}</Text>
              : (
                <>
                  <Text testID={`${sid}-head`} numberOfLines={1} style={[type.small, { color: color.dim }]}>{section.columnKeys.map((c) => t(c)).join(" · ")}</Text>
                  {shown.map((row, ri) => (
                    <Text key={`${section.key}-${String(ri)}`} testID={`${sid}-r${String(ri)}`} numberOfLines={1} style={line}>
                      {row.map((cell, j) => cellText(t, section.columnKeys[j], cell)).join(" · ")}
                    </Text>
                  ))}
                  {more > 0 && <Text testID={`${sid}-more`} numberOfLines={1} style={[type.small, { color: color.dim }]}>{t("copilotPhone.more", { n: more })}</Text>}
                </>
              )}
            {section.totals !== undefined && (
              <Text testID={`${sid}-total`} numberOfLines={1} style={[type.small, { color: color.ink, fontWeight: "700" }]}>
                {section.totals.map((cell, j) => cellText(t, section.columnKeys[j], cell)).join(" · ")}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
