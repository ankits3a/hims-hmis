import { useState } from "react";
import { useTranslation } from "react-i18next";
import { flagTone } from "../lib/lab-api";
import { Button } from "@/components/ui/button";
import type { WireAnalyteRow } from "../lib/lab-api";
import type { ReactElement } from "react";

/**
 * 17-E T7 / D18 — **WHICH RUN THE REPORT CARRIES.** One component, used by the bench and by the
 * verify seat.
 *
 * ═══ WHY BOTH SEATS, AND WHY ONE COMPONENT ═══
 *
 * The choice is guarded by `lab.results.enter`, which `lab_technician` AND `pathologist` both hold
 * (`seed-roles.ts`) — and the refusal it resolves, `rerun_unchosen`, is raised by `assertReportable`
 * at the moment of the SIGNATURE. So the seat most likely to meet an unchosen pair is the one that
 * cannot proceed past it, and a screen that showed the pathologist the refusal without the control
 * would be the original defect moved one seat over: at 02:00 with nobody at the bench, the answer
 * would again be to curl.
 *
 * It is one component and not a copy in each screen because the two would drift, and what they
 * would drift about is which measurement a report carries.
 *
 * ═══ THE REASON IS THE POINT, NOT A FIELD ═══
 *
 * `chooseReportedResult` refuses `rerun_choice_reason_required` on a blank or whitespace reason, and
 * the phase doc's sentence for why is the one worth keeping in mind here: *a choice without a reason
 * is the auto-supersession this rule exists to remove.* The button is therefore inert until a run is
 * picked AND a reason is typed — not to replace the server's check, but so the technologist is not
 * sent a refusal they can already see coming.
 *
 * ═══ STATE LIVES HERE, AND DIES WITH THE PAIR ═══
 *
 * The pick and the reason are this component's own. When the choice lands, the worklist refetches,
 * the analyte stops carrying `rerunChoice`, this unmounts, and the half-typed reason goes with it —
 * which is the behaviour a per-cell map in the parent had to be written to imitate.
 */
export function RerunChoicePair({
  runs,
  name,
  analyteLabel,
  onChoose,
  pending = false,
}: {
  runs: WireAnalyteRow["rerunChoice"];
  /** Radio-group name. Must be unique per analyte on the page, or two pairs share one selection. */
  name: string;
  /** Spoken in the reason field's label, so a screen reader hears WHICH analyte is being decided. */
  analyteLabel: string;
  onChoose: (v: { resultId: string; reason: string }) => void;
  pending?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [pick, setPick] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const ready = pick !== null && why.trim() !== "";

  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
      <div className="flex flex-col gap-0.5">
        {runs.map((c) => {
          const tone = flagTone(c.flag);
          const which = c.isRerun ? t("lab.bench.rerunRepeat") : t("lab.bench.rerunFirst");
          return (
            <label key={c.resultId} className="flex items-center gap-2">
              <input
                type="radio"
                name={name}
                checked={pick === c.resultId}
                onChange={() => setPick(c.resultId)}
                aria-label={t("lab.bench.rerunPick", { run: which, value: c.value })}
              />
              {/*
                THE RUN'S OWN FLAG TONE. `analyte.flag` is null while two runs are live — there is no
                reportable value to flag — so a critical second run would read as an ordinary number
                on the one row most likely to need a telephone call. Each run carries its own.
              */}
              <span
                className={`tabular-nums ${tone === "critical" ? "font-bold" : tone === "abnormal" ? "font-semibold" : ""}`}
                style={tone === "critical" ? { color: "var(--state-danger)" } : undefined}
              >{c.value}</span>
              <span className="text-xs text-muted-foreground">
                {which}
                {c.flag !== null && ` · ${c.flag}`}
                {c.deltaFlag && ` · ${t("lab.bench.rerunDelta")}`}
              </span>
            </label>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="w-64 rounded border border-input px-2 py-0.5"
          placeholder={t("lab.bench.rerunReasonHint")}
          aria-label={`${analyteLabel} — ${t("lab.bench.rerunReason")}`}
          value={why}
          onChange={(e) => setWhy(e.target.value)}
        />
        <Button
          type="button" size="sm" variant="outline"
          disabled={!ready || pending}
          onClick={() => { if (ready) onChoose({ resultId: pick, reason: why.trim() }); }}
        >{t("lab.bench.rerunChoose")}</Button>
      </div>
    </div>
  );
}
