import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { todayIst } from "../lib/opd-api";
import { rosterErrorText } from "../lib/roster-api";
import { SELF_LEAVE_KINDS, cancelLeave, decideLeave, fetchLeaveToDecide, fetchMyLeave, fileLeave } from "../lib/leave-api";
import type { SelfLeaveKind, WireLeaveToDecide, WireMyLeave } from "../lib/leave-api";

/**
 * ═══ E2.2 (decision 0069) — MY LEAVE ═══
 * (spec /opt/hmis-context/SPEC-copilot-leave-swap-2026-10-11.md)
 *
 * Every member of staff: ask for leave (CL, EL, ML, comp off), see where each request stands and why
 * a refused one was refused, take back one not yet begun. A department's head (whoever may publish
 * its roster) also sees TO DECIDE: Approve, or Refuse with a reason the person will read. The page
 * has no nav row of its own (everybody holds it, so it is linked from the desk's close band and the
 * Waiting-for-me lines, like `/me/reach`).
 */

type T = (k: string, o?: Record<string, unknown>) => string;

const fmtDay = (d: string, lang: string): string =>
  new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
    .format(new Date(`${d}T12:00:00Z`));
export const leaveDays = (l: { from: string; to: string; days: number }, t: T, lang: string): string =>
  l.from === l.to
    ? t("myLeave.oneDay", { day: fmtDay(l.from, lang) })
    : t("myLeave.span", { from: fmtDay(l.from, lang), to: fmtDay(l.to, lang), count: l.days });
export const kindLabel = (k: string, t: T): string => t(`myLeave.kind.${k}`, { defaultValue: k });

export function MyLeave(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language as string | undefined) ?? "en";
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ["leave", "mine"], queryFn: fetchMyLeave });
  const toDecide = useQuery({ queryKey: ["leave", "to-decide"], queryFn: fetchLeaveToDecide });
  const [error, setError] = useState<string | null>(null);
  const refresh = (): void => { setError(null); void qc.invalidateQueries({ queryKey: ["leave"] }); };
  const cancel = useMutation({ mutationFn: cancelLeave, onSuccess: refresh, onError: (e) => setError(rosterErrorText(e, t)) });

  return (
    <div className="page" data-testid="my-leave" style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 760 }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>{t("myLeave.title")}</h1>
      {error !== null && <p role="alert" className="ro-alert" data-testid="my-leave-error">{error}</p>}

      {(toDecide.data ?? []).length > 0 && (
        <section className="box" data-testid="leave-to-decide" style={{ display: "flex", flexDirection: "column", gap: 10, padding: "13px 15px" }}>
          <h2 className="tag" style={{ margin: 0 }}>{t("myLeave.toDecide")}</h2>
          {toDecide.data!.map((r) => <DecideRow key={r.id} r={r} lang={lang} onDone={refresh} onError={(e) => setError(rosterErrorText(e, t))} />)}
        </section>
      )}

      <AskForm onFiled={refresh} onError={(e) => setError(rosterErrorText(e, t))} />

      <section className="box" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 15px" }}>
        <h2 className="tag" style={{ margin: 0 }}>{t("myLeave.mine")}</h2>
        {mine.isPending && <span className="dim">{t("myLeave.loading")}</span>}
        {mine.data !== undefined && mine.data.length === 0 && <span className="dim" data-testid="my-leave-none">{t("myLeave.none")}</span>}
        {(mine.data ?? []).map((l) => <MineRow key={l.id} l={l} lang={lang} busy={cancel.isPending} onCancel={() => cancel.mutate(l.id)} />)}
      </section>
    </div>
  );
}

function MineRow({ l, lang, busy, onCancel }: { l: WireMyLeave; lang: string; busy: boolean; onCancel: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const tone = l.status === "approved" ? "gd" : l.status === "rejected" ? "bd" : "";
  return (
    <div data-testid={`my-leave-${l.id}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid var(--line, #0001)" }}>
      <b>{kindLabel(l.kind, t)}</b>
      <span>{leaveDays(l, t, lang)}</span>
      <span className={`pill ${tone}`} data-testid="my-leave-status">{t(`myLeave.status.${l.status}`)}</span>
      {l.canCancel && <button type="button" className="sec" disabled={busy} onClick={onCancel} data-testid="my-leave-cancel">{t("myLeave.cancel")}</button>}
      {l.refusal !== null && (
        <span style={{ flexBasis: "100%", fontSize: 13 }} data-testid="my-leave-refusal">
          {t("myLeave.refusedBecause", { who: l.decidedBy ?? "", why: l.refusal })}
        </span>
      )}
    </div>
  );
}

function AskForm({ onFiled, onError }: { onFiled: () => void; onError: (e: unknown) => void }): React.ReactElement {
  const { t } = useTranslation();
  const today = todayIst(new Date());
  const [kind, setKind] = useState<SelfLeaveKind>("CL");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  const file = useMutation({
    mutationFn: () => fileLeave({ kind, from, to: to < from ? from : to, ...(reason.trim() === "" ? {} : { reason: reason.trim() }) }),
    onSuccess: () => { setReason(""); setDone(true); onFiled(); },
    onError,
  });
  return (
    <form
      className="box" data-testid="leave-ask"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10, padding: "13px 15px" }}
      onSubmit={(e) => { e.preventDefault(); setDone(false); file.mutate(); }}
    >
      <h2 className="tag" style={{ margin: 0, flexBasis: "100%" }}>{t("myLeave.ask")}</h2>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>{t("myLeave.kindLabel")}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as SelfLeaveKind)} data-testid="leave-kind">
          {SELF_LEAVE_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k, t)}</option>)}
        </select>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>{t("myLeave.from")}</span>
        <input type="date" value={from} min={today} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} data-testid="leave-from" />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>{t("myLeave.to")}</span>
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} data-testid="leave-to" />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 220px" }}>
        <span>{t("myLeave.reason")}</span>
        <input type="text" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("myLeave.reasonHint")} data-testid="leave-reason" />
      </label>
      <button type="submit" className="agdo" disabled={file.isPending} data-testid="leave-send">{t("myLeave.send")}</button>
      {done && <span className="dim" data-testid="leave-sent" style={{ flexBasis: "100%" }}>{t("myLeave.sent")}</span>}
    </form>
  );
}

function DecideRow({ r, lang, onDone, onError }: { r: WireLeaveToDecide; lang: string; onDone: () => void; onError: (e: unknown) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [refusing, setRefusing] = useState(false);
  const [note, setNote] = useState("");
  const decide = useMutation({ mutationFn: (v: { approve: boolean; note?: string }) => decideLeave(r.id, v.approve, v.note), onSuccess: onDone, onError });
  return (
    <div data-testid={`decide-${r.id}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid var(--line, #0001)" }}>
      <b>{r.name}</b>
      {r.department !== null && <span className="dim">{r.department}</span>}
      <span>{kindLabel(r.kind, t)} · {leaveDays(r, t, lang)}</span>
      {r.reason !== null && <span style={{ flexBasis: "100%", fontSize: 13 }}>{t("myLeave.theirReason", { why: r.reason })}</span>}
      {!refusing ? (
        <span style={{ display: "flex", gap: 8 }}>
          <button type="button" className="agdo" disabled={decide.isPending} onClick={() => decide.mutate({ approve: true })} data-testid="decide-approve">{t("myLeave.approve")}</button>
          <button type="button" className="sec" disabled={decide.isPending} onClick={() => setRefusing(true)} data-testid="decide-refuse">{t("myLeave.refuse")}</button>
        </span>
      ) : (
        <span style={{ display: "flex", flexWrap: "wrap", gap: 8, flexBasis: "100%" }}>
          <input type="text" maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("myLeave.refuseWhy")} data-testid="decide-note" style={{ flex: "1 1 220px" }} />
          <button type="button" className="agdo" disabled={decide.isPending || note.trim() === ""} onClick={() => decide.mutate({ approve: false, note: note.trim() })} data-testid="decide-refuse-send">{t("myLeave.refuseSend")}</button>
          <button type="button" className="sec" onClick={() => { setRefusing(false); setNote(""); }}>{t("myLeave.back")}</button>
        </span>
      )}
    </div>
  );
}
