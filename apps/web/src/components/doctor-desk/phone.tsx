import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { AskBar } from "./frame";
import { ACT_CHOICES, ACT_NOTE_MAX } from "../../../../../packages/contracts/src/doctor-desk";
import type { ActChoice } from "../../../../../packages/contracts/src/doctor-desk";
import { deskErrorText, fetchCopilotToggles, recordAct } from "../../lib/doctor-desk-api";
import type { CopilotToggles } from "../../lib/doctor-desk-api";
import "./phone.css";

/**
 * ═══ DD-1.4 / 1.5 — THE PHONE BOARDS' SHELL (`Main.dc.html`, `Professor.dc.html`), as web views ═══
 *
 * Phone for the round, desktop for OPD (owner R1). The boards are 390 px wide: a header line, the
 * doctor's name and role, the cards, and a dock at the foot holding the copilot's status line and the
 * ask bar. The dock is LIGHT (owner R13, 2026-09-25: no dark slabs) with an ink edge. Wider than a
 * phone, the column stays phone-width and centred — the desktop has the Tower and the Unit board.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

export type PhoneTab = "now" | "opd" | "unit";
/** Bottom tabs Now · OPD · Unit. Beds is ABSENT until DD-IPD (plan DD-1.5: "Beds tab absent, not empty"). */
const TABS: readonly { key: PhoneTab; to: string }[] = [
  { key: "now", to: "/doctor-desk/now" },
  { key: "opd", to: "/doctor-desk/opd" },
  { key: "unit", to: "/doctor-desk/unit" },
];

export function PhoneShell({ testId, title, sub, clock, tab, dock, children }: {
  testId: string; title: string; sub: string | null; clock: string;
  /** The bottom tab bar, with this tab current; omitted on the Professor's board (it has none). */
  tab?: PhoneTab;
  dock: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  return (
    <div className="ddp" data-testid={testId}>
      <div className="ddp-col">
        <div className="ddp-scroll">
          <div className="ddp-top">
            <a href="/" className="ddp-brand" onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: "/" }); }}>DOCTOR DESK</a>
            <span className="ddp-clock">{clock}</span>
          </div>
          <div className="ddp-hello">
            <h1 className="ddp-h1">{title}</h1>
            {sub !== null && <div className="ddp-sub">{sub}</div>}
          </div>
          {children}
        </div>
        <div className="ddp-foot">
        <div className="ddp-dock">{dock}</div>
        {tab !== undefined && (
          <nav className="ddp-tabs" aria-label={t("doctorDesk.phone.tabs")}>
            {TABS.map((x) => (
              <a
                key={x.key} href={x.to} className={`ddp-tab${x.key === tab ? " ddp-tab-on" : ""}`} data-testid={`ddp-tab-${x.key}`}
                aria-current={x.key === tab ? "page" : undefined}
                onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: x.to }); }}
              >{t(`doctorDesk.phone.tab.${x.key}`)}</a>
            ))}
          </nav>
        )}
        </div>
      </div>
    </div>
  );
}

/** "COPILOT · ASK-ONLY · DRAFTING OFF" — decision 0006's two toggles as #861 stores them. */
export function copilotStatus(s: CopilotToggles, t: T): string {
  return [t("doctorDesk.copilot.word"), s.proactive ? t("doctorDesk.copilot.proactive") : t("doctorDesk.copilot.askOnly"), s.draftProse ? t("doctorDesk.copilot.draftOn") : t("doctorDesk.copilot.draftOff")].join(" · ");
}

export function useCopilotToggles(): CopilotToggles | null {
  const q = useQuery({ queryKey: ["opd", "consult", "copilot-settings"], queryFn: fetchCopilotToggles, staleTime: 60_000, retry: false });
  return q.data ?? null;
}

/** The dock: the status line (absent when the toggles cannot be read), an optional proactive line, the ask bar. */
export function PhoneDock({ id, placeholder, toggles, proactiveLine }: {
  id: string; placeholder: string; toggles: CopilotToggles | null; proactiveLine?: string | null;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {toggles !== null && (
        <div className="ddp-cop" data-testid="ddp-copilot">
          <span className="ddp-cop-dot" aria-hidden="true" />
          <span className="ddp-cop-t">{copilotStatus(toggles, t)}</span>
        </div>
      )}
      {proactiveLine !== undefined && proactiveLine !== null && <div className="ddp-cop-line" data-testid="ddp-proactive">{proactiveLine}</div>}
      <AskBar id={id} placeholder={placeholder} fallback={() => null} terms={() => []} />
    </>
  );
}

/**
 * DD-1.3 (D3) — "What did you do?" The loop closes on the act, not the tap. Five choices; Other asks
 * for a few words. One act per critical — the server refuses a second (`already_acted`).
 */
export function ActPicker({ rowKey, onDone }: { rowKey: string; onDone?: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [other, setOther] = useState(false);
  const [note, setNote] = useState("");
  const [done, setDone] = useState<{ choice: ActChoice; minutes: number } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (c: ActChoice) => recordAct(rowKey, c, c === "other" ? note.trim() : null),
    onSuccess: (r, c) => {
      setDone({ choice: c, minutes: r.minutes });
      setRefusal(null);
      void qc.invalidateQueries({ queryKey: ["doctor-desk"] });
      onDone?.();
    },
    onError: (e) => setRefusal(deskErrorText(e, t)),
  });
  if (done !== null) {
    return <div className="ddp-acted" data-testid={`dd-acted-${rowKey}`}>{t("doctorDesk.act.recorded", { what: t(`doctorDesk.act.choice.${done.choice}`), n: done.minutes })}</div>;
  }
  return (
    <div className="ddp-act" data-testid={`dd-act-${rowKey}`}>
      <div className="ddp-act-q">{t("doctorDesk.act.question")} <span className="ddp-dim">{t("doctorDesk.act.why")}</span></div>
      <div className="ddp-act-btns">
        {ACT_CHOICES.map((c) => (
          <button
            key={c} type="button" className={`ddp-btn${c === "other" && other ? " ddp-btn-on" : ""}`} data-testid={`dd-act-${rowKey}-${c}`}
            disabled={act.isPending}
            onClick={() => { if (c === "other") { setOther(true); return; } act.mutate(c); }}
          >{t(`doctorDesk.act.choice.${c}`)}</button>
        ))}
      </div>
      {other && (
        <div className="ddp-act-other">
          <label className="ddp-sr" htmlFor={`act-note-${rowKey}`}>{t("doctorDesk.act.otherLabel")}</label>
          <input
            id={`act-note-${rowKey}`} className="ddp-input" data-testid={`dd-act-${rowKey}-note`} value={note} maxLength={ACT_NOTE_MAX}
            placeholder={t("doctorDesk.act.otherLabel")} onChange={(e) => setNote(e.target.value)}
          />
          <button type="button" className="ddp-btn ddp-btn-ink" data-testid={`dd-act-${rowKey}-save`} disabled={act.isPending || note.trim().length < 3} onClick={() => act.mutate("other")}>
            {t("doctorDesk.act.save")}
          </button>
        </div>
      )}
      {refusal !== null && <p role="alert" className="dd-alert">{refusal}</p>}
    </div>
  );
}
