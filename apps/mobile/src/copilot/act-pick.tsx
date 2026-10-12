import { useState } from "react";
import { Pressable, View } from "react-native";
import { useI18n } from "../i18n";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Button } from "../ui";
import { dayWords, sayParams, type CopilotProposal } from "./model";
import type { CopilotCoverDuty, CopilotCoverPick, CopilotLeavePick, CopilotReminderPick } from "../../../../packages/contracts/src/copilot";

/**
 * E2.2 — A LEAVE, OR A DUTY TO HAND ON, FROM THE CHAT ON THE PHONE: the web's `copilot-act-pick.tsx`,
 * same steps and words. Each option is a signed proposal; nothing is filed or asked until the confirm
 * card and Confirm (decision 0069).
 *
 * E2.3 — a reminder is one option: the card opens on its confirm step (words, when, how often).
 */
export function ActPick({ n, pick, proposals, busy, onConfirm, onDismiss }: {
  n: number;
  pick: CopilotLeavePick | CopilotCoverPick | CopilotReminderPick;
  proposals: CopilotProposal[];
  busy: boolean;
  onConfirm: (p: CopilotProposal) => void;
  onDismiss: () => void;
}) {
  const { t, lang } = useI18n();
  const [chosen, setChosen] = useState<number | null>(pick.kind === "reminderPick" || (pick.kind === "leavePick" && pick.options.length === 1) ? 0 : null);
  const id = (s: string) => `copilot-act-${s}-${String(n)}`;
  const day = (d: string): string => dayWords(new Date(`${d}T12:00:00+05:30`), lang);
  const duty = (d: CopilotCoverDuty): string => t(d.night ? "copilot.act.dutyNight" : "copilot.act.dutyDay", { day: day(d.istDate) });
  const options: { proposal: number }[] = pick.kind === "reminderPick" ? [{ proposal: pick.proposal }] : pick.options;
  const labels: string[] = pick.kind === "reminderPick" ? [pick.text] : pick.kind === "leavePick"
    ? pick.options.map((o) => t(`myLeave.kind.${o.leave}`))
    : pick.options.map((o) => (o.give === null ? t("copilot.act.coverBy", { name: o.name }) : t("copilot.act.swapWith", { name: o.name, give: duty(o.give) })));
  const what = pick.kind === "reminderPick"
    ? `${String(sayParams("copilot.answer.reminderPick", { when: pick.at }, t, lang).when)} · ${t(`copilot.act.repeat_${pick.repeat}`)}`
    : pick.kind === "leavePick"
    ? (pick.from === pick.to ? day(pick.from) : t("copilot.act.days", { from: day(pick.from), to: day(pick.to), count: pick.days }))
    : `${duty(pick.duty)} · ${pick.duty.post}`;
  const proposalAt = (i: number): CopilotProposal | undefined => proposals[options[i]!.proposal];
  const chip = { minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, justifyContent: "center" as const, borderRadius: radius.md, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.greenSoft };

  return (
    <View testID={id("pick")} style={{ gap: space.sm }}>
      <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{pick.kind === "reminderPick" ? t("copilot.act.reminder") : pick.kind === "leavePick" ? t("copilot.act.leave") : t("copilot.act.cover", { duty: duty(pick.duty) })}</Text>
      {chosen === null ? labels.map((l, i) => (
        <Pressable key={`${l}-${String(i)}`} testID={`${id("option")}-${String(i)}`} accessibilityRole="button" style={chip} onPress={() => setChosen(i)}>
          <Text numberOfLines={2} style={{ fontSize: 14.5, fontWeight: "700", color: color.ink }}>{l}</Text>
        </Pressable>
      )) : (
        <View testID={id("confirm")} style={{ gap: 6, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.card }}>
          <Text numberOfLines={2} style={[type.body, { color: color.ink, fontWeight: "700" }]}>{labels[chosen]}</Text>
          <Text testID={id("detail")} numberOfLines={2} style={[type.small, { color: color.dim }]}>{what}</Text>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button label={t("copilot.act.confirm")} busy={busy} disabled={proposalAt(chosen) === undefined} testID={id("confirm-go")}
              onPress={() => { const p = proposalAt(chosen); if (p !== undefined) onConfirm(p); }} />
            {(pick.kind === "coverPick" || (pick.kind === "leavePick" && pick.options.length > 1)) && (
              <Button kind="secondary" label={t("copilot.act.cancel")} disabled={busy} testID={id("back")} onPress={() => setChosen(null)} />
            )}
          </View>
        </View>
      )}
      <Button kind="secondary" label={t("copilot.act.dismiss")} testID={id("dismiss")} onPress={onDismiss} />
    </View>
  );
}
