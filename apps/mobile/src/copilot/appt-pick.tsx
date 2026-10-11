import { useState } from "react";
import { Pressable, View } from "react-native";
import { useI18n } from "../i18n";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Button } from "../ui";
import { dayWords, type CopilotProposal } from "./model";
import type { CopilotApptPick } from "../../../../packages/contracts/src/copilot";

/**
 * E2.1 — AN APPOINTMENT FROM THE CHAT, ON THE PHONE: the web's `copilot-appt-pick.tsx`, same steps.
 * A patient found by mobile or name is tapped first; each time is a signed proposal for that one
 * patient; nothing is booked until the confirm card (name, UHID, doctor, day, time, mode) and Confirm.
 */
export function ApptPick({ n, pick, proposals, busy, onConfirm, onDismiss }: {
  n: number;
  pick: CopilotApptPick;
  proposals: CopilotProposal[];
  busy: boolean;
  onConfirm: (p: CopilotProposal) => void;
  onDismiss: () => void;
}) {
  const { t, lang } = useI18n();
  const [row, setRow] = useState<number | null>(pick.pickPatient ? null : 0);
  const [time, setTime] = useState<{ at: string; proposal: number } | null>(null);
  const chosen = row === null ? null : pick.rows[row] ?? null;
  const when = (iso: string): string => {
    const at = new Date(iso);
    const ist = new Date(at.getTime() + 330 * 60_000);
    return `${dayWords(at, lang)} · ${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
  };
  const mode = (m: "in_person" | "tele"): string => t(m === "tele" ? "copilot.act.tele" : "copilot.act.inPerson");
  const id = (s: string) => `copilot-appt-${s}-${String(n)}`;
  const chip = { minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, justifyContent: "center" as const, borderRadius: radius.md, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.greenSoft };

  return (
    <View testID={id("pick")} style={{ gap: space.sm }}>
      {chosen === null ? (
        <>
          <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{t("copilot.act.pickPatient")}</Text>
          {pick.rows.map((r, i) => (
            <Pressable key={`${r.patient.uhid}-${String(i)}`} testID={`${id("patient")}-${String(i)}`} accessibilityRole="button" style={chip} onPress={() => { setRow(i); setTime(null); }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: color.ink }} numberOfLines={1}>{r.patient.name} · {r.patient.ageSex}</Text>
              <Text style={[type.small, { color: color.dim }]} numberOfLines={1}>
                {r.patient.uhid}{r.patient.phoneLast4 === null ? "" : ` · ••${r.patient.phoneLast4}`}{r.from === null ? "" : ` · ${when(r.from)}`}
              </Text>
            </Pressable>
          ))}
        </>
      ) : time === null ? (
        <>
          <Text numberOfLines={2} style={[type.small, { color: color.ink }]}>{chosen.patient.name} · {chosen.patient.uhid} · {chosen.doctor} · {mode(chosen.mode)}</Text>
          {chosen.noMobile
            ? <Text testID={id("nomobile")} numberOfLines={1} style={[type.small, { color: color.red }]}>{t("copilot.act.noMobile")}</Text>
            : chosen.times.length === 0
              ? <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{t("copilot.act.noTimes")}</Text>
              : (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                  {chosen.times.map((x) => (
                    <Pressable key={x.at} testID={`${id("time")}-${String(x.proposal)}`} accessibilityRole="button" style={chip} onPress={() => { setTime(x); }}>
                      <Text style={{ fontSize: 14, fontWeight: "700", color: color.green }} numberOfLines={1}>{when(x.at)}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
        </>
      ) : (
        <View testID={id("confirm")} style={{ gap: 6, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.card }}>
          <Text numberOfLines={1} style={[type.small, { color: color.green, fontWeight: "700" }]}>{t(pick.action === "move" ? "copilot.act.move" : "copilot.act.book")}</Text>
          <Text numberOfLines={1} style={[type.body, { color: color.ink, fontWeight: "700" }]}>{chosen.patient.name} · {chosen.patient.ageSex}</Text>
          <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{chosen.patient.uhid}</Text>
          <Text numberOfLines={2} style={[type.body, { color: color.ink }]}>{chosen.doctor} · {when(time.at)} · {mode(chosen.mode)}</Text>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button label={t("copilot.act.confirm")} busy={busy} disabled={proposals[time.proposal] === undefined} testID={id("confirm-go")}
              onPress={() => { const p = proposals[time.proposal]; if (p !== undefined) onConfirm(p); }} />
            <Button kind="secondary" label={t("copilot.act.cancel")} disabled={busy} testID={id("confirm-cancel")} onPress={() => { setTime(null); }} />
          </View>
        </View>
      )}
      {time === null && (
        <View style={{ flexDirection: "row", gap: space.sm }}>
          {pick.pickPatient && chosen !== null && <Button kind="secondary" label={t("copilot.act.pickPatient")} onPress={() => { setRow(null); }} />}
          <Button kind="secondary" label={t("copilot.act.cancel")} testID={id("dismiss")} onPress={onDismiss} />
        </View>
      )}
    </View>
  );
}
