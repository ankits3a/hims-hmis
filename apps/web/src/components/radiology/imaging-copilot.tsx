import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { AgentDock, logged } from "../agent-dock";
import { sayParams, useCopilot } from "../../lib/use-copilot";
import type { AgentLine } from "../agent-dock";
import type { CopilotProposal } from "../../lib/copilot-api";
import type { CopilotImagingLink, CopilotImagingList, CopilotImagingPick } from "@hmis/contracts";

/**
 * #1082 (IM5) — THE IMAGING STATIONS' COPILOT COLUMN.
 *
 * The same copilot every desk asks (`useCopilot`), docked as the station shell's `copilot` panel: with a
 * study in hand the shell folds the list to its one line and this takes the column (`station-shell.tsx`).
 * Desk, Rooms, Reading, Hand-over and HOD mount it; nothing else about those screens changes.
 *
 * ═══ THE STUDY IN HAND IS THE SUBJECT, THROUGH THE ONE MECHANISM THAT EXISTS ═══
 *
 * The ask route takes no subject from the screen: the server finds it only as a placeholder in the
 * question (`copilot.controller.ts`). So when a study is in hand and the question names no number, its
 * accession goes IN FRONT of the question — the masker makes it `<<P1>>`, the phrasebook takes the first
 * placeholder as the slot, and the tool is about this study. A question that already carries a number is
 * sent exactly as typed. The in-hand patient's name is handed over as a term, so the server masks it.
 *
 * ═══ WHAT IT RENDERS UNDER THE ANSWER ═══
 *
 * `imagingList` (several studies fit): one line each. `imagingPick` (an act): tap one option, then
 * Confirm — the one human tap `POST /copilot/confirm` needs; nothing is written before it. `imagingLink`
 * (a draft is ready): the way into the reading room for that study.
 */

/** A number long enough to be an identifier, in ASCII or Devanagari digits: the question names its own study. */
const NAMES_A_NUMBER = /\d{5,}|[०-९]{5,}/;

export function withSubject(question: string, subject: string | null | undefined): string {
  const q = question.trim();
  if (subject == null || subject === "" || NAMES_A_NUMBER.test(q)) return q;
  return `${subject} ${q}`;
}

const isKind = <K extends string>(p: unknown, kind: K): boolean =>
  typeof p === "object" && p !== null && (p as { kind?: unknown }).kind === kind;

export function ImagingCopilot({ subject, patientName }: {
  /** What is in hand, as the desk names it: the study's accession, or at the desk the patient's UHID. */
  subject?: string | null;
  /** The in-hand patient's name, masked by value on the server. */
  patientName?: string | null;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language as string | undefined) ?? "en";
  const router = useRouter({ warn: false });
  const [log, setLog] = useState<AgentLine[]>([]);
  const terms = useCallback((): string[] => (patientName == null || patientName === "" ? [] : [patientName]), [patientName]);
  const onNote = useCallback((text: string) => { setLog((l) => logged(l, text)); }, []);
  const copilot = useCopilot({ terms, onNote });
  const ask = (q: string): void => { copilot.ask(withSubject(q, subject)); };
  const [chosen, setChosen] = useState<number | null>(null);

  const payload = copilot.payload;
  const list = isKind(payload, "imagingList") ? payload as CopilotImagingList : null;
  const pick = isKind(payload, "imagingPick") && copilot.proposals !== null ? payload as CopilotImagingPick : null;
  const link = isKind(payload, "imagingLink") ? payload as CopilotImagingLink : null;

  const when = (at: string | undefined): string => (at === undefined ? "" : String(sayParams("copilot.answer.radBooked", { when: at }, t, lang).when));
  const optionLabel = (o: CopilotImagingPick["options"][number]): string => [
    o.accessionNo, o.study,
    o.machine === undefined ? null : `${o.machine} ${when(o.at)}`,
    o.outcome === undefined ? null : t(`radiology.results.outcome.${o.outcome}`, { defaultValue: o.outcome }),
    o.kind === undefined ? null : t(`copilot.rad.media.${o.kind}`, { defaultValue: o.kind }),
    o.reason === undefined ? null : `“${o.reason}”`,
  ].filter((x): x is string => x !== null && x !== "").join(" · ");
  const proposalAt = (i: number): CopilotProposal | undefined => (pick === null ? undefined : copilot.proposals?.[pick.options[i]!.proposal]);
  const btn: React.CSSProperties = { minHeight: 32, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--line, #8884)", background: "transparent", color: "inherit", fontSize: 12, cursor: "pointer", textAlign: "left" };

  const produced = (
    <>
      {list !== null && (
        <ul className="m-0 list-none space-y-1 p-0 text-xs" data-testid="imaging-copilot-list">
          {list.rows.map((r) => (
            <li key={r.accessionNo}>{r.accessionNo} · {r.study} · {t(`radiology.worklist.state.${r.state}`, { defaultValue: r.state })}</li>
          ))}
        </ul>
      )}
      {pick !== null && !copilot.busy && (
        <div data-testid="imaging-copilot-pick" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="tag">{t(`copilot.rad.pick.${pick.act}`)}</span>
          {chosen === null ? pick.options.map((o, i) => (
            <button key={`${o.accessionNo}-${String(i)}`} type="button" style={btn} data-testid={`imaging-copilot-option-${String(i)}`} onClick={() => setChosen(i)}>
              {optionLabel(o)}
            </button>
          )) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <b style={{ fontSize: 13 }}>{optionLabel(pick.options[chosen]!)}</b>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="agdo" data-testid="imaging-copilot-confirm" disabled={proposalAt(chosen) === undefined}
                  onClick={() => { const p = proposalAt(chosen); setChosen(null); if (p !== undefined) void copilot.confirm(p); }}>
                  {t("copilot.act.confirm")}
                </button>
                <button type="button" className="sec" onClick={() => setChosen(null)}>{t("copilot.act.cancel")}</button>
              </div>
            </div>
          )}
          <button type="button" className="sec" onClick={() => { setChosen(null); copilot.clearPayload(); }}>{t("copilot.act.dismiss")}</button>
        </div>
      )}
      {link !== null && (
        <a
          href={`/radiology/read?study=${link.studyId}`} className="text-sm font-medium underline underline-offset-2" data-testid="imaging-copilot-draft"
          onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: "/radiology/read", search: { study: link.studyId } } as never); }}
        >
          {t("copilot.rad.openDraft")}
        </a>
      )}
    </>
  );

  return (
    <div data-testid="radiology-copilot" style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <AgentDock
        variant="panel"
        answer={copilot.answer}
        log={log}
        onAsk={ask}
        placeholder={t("radiology.copilot.placeholder")}
        idle={t("radiology.copilot.idle")}
        panel={list === null && pick === null && link === null ? undefined : produced}
      />
    </div>
  );
}
