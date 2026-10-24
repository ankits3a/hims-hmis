import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { completeConsultApi, dietRefusal, fetchDietConsults, fetchMealRounds, minuteClock, setMealRoundApi } from "../lib/diet-api";
import type { DietConsultView, DietMealRoundView } from "@hmis/contracts";
import "./diet.css";

/**
 * ═══ E4.4 DIET (issue #736) — THE DIETICIAN'S CONSULT QUEUE ═══
 *
 * Oldest first, the wait in hours (red past 24 h — the NABH assessment window), the patient (alias when sealed), bed and
 * ward, why the consult was asked, and the diet in force. Complete with a note. Below it, the four meal rounds' cut-off
 * and serve times (IST), which the kitchen's lists are built by.
 */
const HOT_MIN = 24 * 60;

export function DietConsults(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["diet", "consults"], queryFn: fetchDietConsults, refetchInterval: 60_000 });
  return (
    <PaperScreen testId="diet-consults">
      <div className="dc-page">
        <h1>{t("diet.consults.title")}</h1>
        <section className="box dc-list" data-testid="dc-list">
          {q.data !== undefined && q.data.length === 0 && <div className="dk-empty">{t("diet.consults.empty")}</div>}
          {(q.data ?? []).map((c) => <ConsultRow key={c.id} c={c} />)}
        </section>
        <Rounds />
      </div>
    </PaperScreen>
  );
}

function ConsultRow({ c }: { c: DietConsultView }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const done = useMutation({
    mutationFn: () => completeConsultApi(c.id, note.trim()),
    onSuccess: () => { setErr(null); void qc.invalidateQueries({ queryKey: ["diet"] }); },
    onError: (e) => setErr(t(`diet.refusal.${dietRefusal(e) ?? "failed"}`, { defaultValue: t("diet.refusal.failed") })),
  });
  const hours = Math.floor(c.waitMinutes / 60);
  return (
    <div className={`dc-row${c.waitMinutes >= HOT_MIN ? " hot" : ""}`} data-testid={`dc-${c.id}`}>
      <div className="dc-who">
        <b data-testid="dc-name">{c.patient.name}</b>
        <span className="dk-dim">{[c.patient.uhid, c.bedCode ?? "", c.wardName ?? ""].filter((s) => s !== "").join(" · ")}</span>
      </div>
      <div className="dc-why">{c.reason}{c.order !== null && <span className="dk-dim"> · {t(`diet.code.${c.order.code}`)}</span>}</div>
      <div className="dc-wait" data-testid="dc-wait">{t("diet.consults.wait", { h: hours })}</div>
      <div className="dc-act">
        <input placeholder={t("diet.consults.note")} value={note} onChange={(e) => setNote(e.target.value)} data-testid="dc-note" />
        <button type="button" className="dk-btn" disabled={done.isPending || note.trim() === ""} onClick={() => done.mutate()} data-testid="dc-complete">{t("diet.consults.complete")}</button>
        {err !== null && <span className="dk-err">{err}</span>}
      </div>
    </div>
  );
}

const toMin = (s: string): number => { const [h, m] = s.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

function Rounds(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["diet", "rounds"], queryFn: fetchMealRounds });
  const [edit, setEdit] = useState<Record<string, { cutoff: string; serve: string }>>({});
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (r: DietMealRoundView) => setMealRoundApi(r),
    onSuccess: () => { setErr(null); setEdit({}); void qc.invalidateQueries({ queryKey: ["diet"] }); },
    onError: (e) => setErr(t(`diet.refusal.${dietRefusal(e) ?? "failed"}`, { defaultValue: t("diet.refusal.failed") })),
  });
  return (
    <section className="box dc-rounds" data-testid="dc-rounds">
      <header><b>{t("diet.consults.rounds")}</b>{err !== null && <span className="dk-err">{err}</span>}</header>
      {(q.data ?? []).map((r) => {
        const e = edit[r.meal] ?? { cutoff: minuteClock(r.cutoffMinute), serve: minuteClock(r.serveMinute) };
        const set = (k: "cutoff" | "serve", v: string): void => setEdit((x) => ({ ...x, [r.meal]: { ...e, [k]: v } }));
        return (
          <div key={r.meal} className="dc-round" data-testid={`dc-round-${r.meal}`}>
            <span className="m">{t(`diet.meal.${r.meal}`)}</span>
            <label>{t("diet.consults.cutoff")}<input type="time" value={e.cutoff} onChange={(ev) => set("cutoff", ev.target.value)} /></label>
            <label>{t("diet.consults.serveAt")}<input type="time" value={e.serve} onChange={(ev) => set("serve", ev.target.value)} /></label>
            <button type="button" className="dk-btn ghost" disabled={edit[r.meal] === undefined || save.isPending}
              onClick={() => save.mutate({ meal: r.meal, cutoffMinute: toMin(e.cutoff), serveMinute: toMin(e.serve) })}>{t("diet.consults.saveRound")}</button>
          </div>
        );
      })}
    </section>
  );
}
