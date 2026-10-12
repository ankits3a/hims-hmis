import { useState } from "react";
import { useTranslation } from "react-i18next";
import { dayWords, sayParams } from "../lib/use-copilot";
import type { CopilotCoverDuty, CopilotCoverPick, CopilotLeavePick, CopilotReminderPick } from "@hmis/contracts";
import type { CopilotProposal } from "../lib/copilot-api";

/**
 * ═══ E2.2 — A LEAVE, OR A DUTY TO HAND ON, FROM THE CHAT: PICK ONE, SEE IT, CONFIRM ═══
 * (spec /opt/hmis-context/SPEC-copilot-leave-swap-2026-10-11.md, decision 0069)
 *
 * The ask wrote nothing. Each option is a signed proposal: a kind of leave for the days said, or a
 * person to cover the duty (or a swap they give back). Nothing is filed or asked until the person has
 * seen the confirm card and pressed Confirm; the server then reads everything again.
 *
 * E2.3 — a reminder is one option: the card opens on its confirm step, the person's words, when it
 * first rings and how it repeats.
 */
type Props = {
  pick: CopilotLeavePick | CopilotCoverPick | CopilotReminderPick;
  proposals: CopilotProposal[];
  busy: boolean;
  onConfirm: (proposal: CopilotProposal) => void;
  onDismiss: () => void;
};

export function CopilotActPicker({ pick, proposals, busy, onConfirm, onDismiss }: Props): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language as string | undefined) ?? "en";
  const [chosen, setChosen] = useState<number | null>(pick.kind === "reminderPick" || (pick.kind === "leavePick" && pick.options.length === 1) ? 0 : null);
  const day = (d: string): string => dayWords(new Date(`${d}T12:00:00+05:30`), lang);
  const duty = (d: CopilotCoverDuty): string => t(d.night ? "copilot.act.dutyNight" : "copilot.act.dutyDay", { day: day(d.istDate) });
  const days = (p: CopilotLeavePick): string => (p.from === p.to ? day(p.from) : t("copilot.act.days", { from: day(p.from), to: day(p.to), count: p.days }));

  const options: { proposal: number }[] = pick.kind === "reminderPick" ? [{ proposal: pick.proposal }] : pick.options;
  const labels: string[] = pick.kind === "reminderPick" ? [pick.text]
    : pick.kind === "leavePick"
    ? pick.options.map((o) => t(`myLeave.kind.${o.leave}`))
    : pick.options.map((o) => (o.give === null ? t("copilot.act.coverBy", { name: o.name }) : t("copilot.act.swapWith", { name: o.name, give: duty(o.give) })));
  const proposalAt = (i: number): CopilotProposal | undefined => proposals[options[i]!.proposal];
  const btn: React.CSSProperties = { minHeight: 32, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--line, #8884)", background: "transparent", color: "inherit", fontSize: 12, cursor: "pointer", textAlign: "left" };

  return (
    <div data-testid="copilot-act-pick" style={{ borderTop: "1px solid #24413631", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="tag">{pick.kind === "reminderPick" ? t("copilot.act.reminder") : pick.kind === "leavePick" ? t("copilot.act.leave") : t("copilot.act.cover", { duty: duty(pick.duty) })}</span>
      {chosen === null ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {labels.map((l, i) => (
            <button key={`${l}-${String(i)}`} type="button" style={btn} data-testid={`copilot-act-option-${String(i)}`} onClick={() => setChosen(i)}>{l}</button>
          ))}
        </div>
      ) : (
        <div data-testid="copilot-act-confirm" style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: 8, border: "1px solid var(--mint, #2a8)" }}>
          <span style={{ fontSize: 13 }}><b>{labels[chosen]}</b></span>
          <span style={{ fontSize: 13 }} data-testid="copilot-act-detail">{pick.kind === "reminderPick" ? `${String(sayParams("copilot.answer.reminderPick", { when: pick.at }, t, lang).when)} · ${t(`copilot.act.repeat_${pick.repeat}`)}`
            : pick.kind === "leavePick" ? days(pick) : `${duty(pick.duty)} · ${pick.duty.post}`}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="agdo" data-testid="copilot-act-confirm-go" disabled={busy || proposalAt(chosen) === undefined}
              onClick={() => { const p = proposalAt(chosen); if (p !== undefined) onConfirm(p); }}>
              {t("copilot.act.confirm")}
            </button>
            {(pick.kind === "coverPick" || (pick.kind === "leavePick" && pick.options.length > 1)) && (
              <button type="button" className="sec" disabled={busy} onClick={() => setChosen(null)} data-testid="copilot-act-back">{t("copilot.act.cancel")}</button>
            )}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="sec" data-testid="copilot-act-dismiss" onClick={onDismiss}>{t("copilot.act.dismiss")}</button>
      </div>
    </div>
  );
}
