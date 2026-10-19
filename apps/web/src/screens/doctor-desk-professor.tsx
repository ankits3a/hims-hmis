import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { PhoneDock, PhoneShell, useCopilotToggles } from "../components/doctor-desk/phone";
import { fmtIst } from "../lib/format";
import { deskErrorText, fetchProfessor, nudgeRow, rateWork } from "../lib/doctor-desk-api";
import type { WireProfessor, WireRateItem, WorkRating } from "../lib/doctor-desk-api";
import { decideCover, fetchCoverRequests } from "../lib/roster-api";
import { isKnownKind } from "./approval-kinds";
import { RATING_REASON_MAX, WORK_RATINGS } from "../../../../packages/contracts/src/doctor-desk";
import { clockText, patientName } from "./doctor-desk-tower";
import { clockLine, subLine } from "./doctor-desk-now";

/**
 * ═══ DD-1.4 — THE PROFESSOR PHONE (`Professor.dc.html`), its non-ward parts ═══
 *
 * Owner R2: the Professor glances and countersigns, and must be able to ACT from it.
 *   · Needs your signature — duty swaps and covers he may decide (the roster's own `decideCover`
 *     route, the same as the desktop's), and approvals waiting for him (the approvals worklist; the
 *     verdict needs its note, so the row opens the inbox card). The server sends only an ALLOWLIST of
 *     non-money kinds, as id + kind + time (decision 0058; review F1).
 *   · Owed by your unit + Nudge, oldest first; the rest on the Unit board.
 *   · Handled without you — criticals in the unit somebody else acted on.
 *   · Rate work — "Goes to her PG logbook, not to a league table" (D5).
 *   · The copilot's status line; its proactive line ONLY when the doctor turned proactive on (R11).
 * ABSENT until DD-IPD: the pulse of beds, the discharge summary countersign. No money anywhere.
 */
export function DoctorDeskProfessor(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const q = useQuery({ queryKey: ["doctor-desk", "professor"], queryFn: fetchProfessor, refetchInterval: 60_000 });
  const toggles = useCopilotToggles();
  const p = q.data;
  const proactive = p === undefined || toggles === null || !toggles.proactive ? null
    : p.past > 0 ? t("doctorDesk.prof.proactivePast", { count: p.past }) : t("doctorDesk.prof.proactiveNone");
  return (
    <PhoneShell
      testId="doctor-desk-professor" title={p?.you.name ?? ""} sub={p === undefined ? null : subLine(p, t)}
      clock={p === undefined ? "" : clockLine(p.at, i18n.language)}
      dock={<PhoneDock id="ask-prof" placeholder={t("doctorDesk.prof.askPlaceholder")} toggles={toggles} proactiveLine={proactive} />}
    >
      {q.isPending && <p className="ddp-dim">{t("doctorDesk.loading")}</p>}
      {q.isError && <p role="alert" className="dd-alert">{deskErrorText(q.error, t)}</p>}
      <Signatures asks={p?.asks ?? []} />
      {p !== undefined && <Owed p={p} />}
      {p !== undefined && <Handled p={p} />}
      {p !== undefined && <RateWork items={p.toRate} />}
    </PhoneShell>
  );
}

function Signatures({ asks }: { asks: WireProfessor["asks"] }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const router = useRouter({ warn: false });
  const covers = useQuery({ queryKey: ["roster", "covers"], queryFn: () => fetchCoverRequests(), retry: false });
  const [refusal, setRefusal] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean }) => decideCover(v.id, v.approve),
    onSuccess: () => { setRefusal(null); void qc.invalidateQueries({ queryKey: ["roster", "covers"] }); },
    onError: (e) => setRefusal(deskErrorText(e, t)),
  });
  const swaps = (covers.data ?? []).filter((c) => c.youMay.approve && c.status === "accepted");
  // The asks are the SERVER's (`GET /doctor-desk/professor`): an allowlist of non-money kinds, id + kind +
  // time only (review F1). The phone never reads the approvals worklist itself.
  const n = swaps.length + asks.length;
  return (
    <>
      <div className="ddp-head"><h2 className="ddp-h2">{t("doctorDesk.prof.sign")}</h2><span className="ddp-mono" data-testid="ddp-sign-n">{n}</span></div>
      {refusal !== null && <p role="alert" className="dd-alert">{refusal}</p>}
      <div className="ddp-list" data-testid="ddp-sign">
        {n === 0 && <div className="ddp-empty">{t("doctorDesk.prof.signNone")}</div>}
        {swaps.map((c) => (
          <div key={c.requestId} className="ddp-li" data-testid={`ddp-swap-${c.requestId}`}>
            <div className="ddp-li-main">
              <span className="ddp-li-t">{t(`doctorDesk.prof.${c.kind}`, { day: c.duty.istDate })}</span>
              <span className="ddp-li-s">{`${c.owner.name} ↔ ${c.counterpart.name}`}{c.check !== null && c.check.severity === "warn" ? ` · ${t("doctorDesk.prof.warn")}` : ""}</span>
            </div>
            <div className="ddp-li-side">
              <button type="button" className="ddp-btn ddp-btn-acc" data-testid={`ddp-swap-${c.requestId}-yes`} disabled={decide.isPending} onClick={() => decide.mutate({ id: c.requestId, approve: true })}>{t("doctorDesk.prof.approve")}</button>
              <button type="button" className="ddp-btn" data-testid={`ddp-swap-${c.requestId}-no`} disabled={decide.isPending} onClick={() => decide.mutate({ id: c.requestId, approve: false })}>{t("doctorDesk.prof.refuse")}</button>
            </div>
          </div>
        ))}
        {asks.map((a) => (
          <div key={a.id} className="ddp-li" data-testid={`ddp-ask-${a.id}`}>
            <div className="ddp-li-main">
              <span className="ddp-li-t">{isKnownKind(a.typeKey) ? t(`inbox.kinds.${a.typeKey}.label`) : t("inbox.unknownKind.label")}</span>
              <span className="ddp-li-s">{t("doctorDesk.prof.askedAt", { at: fmtIst(a.requestedAt) })}</span>
            </div>
            <a
              href={`/approvals?focus=${encodeURIComponent(a.id)}`} className="ddp-btn ddp-btn-acc" style={{ display: "inline-flex", alignItems: "center" }}
              onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: "/approvals", search: { focus: a.id } as never }); }}
            >{t("doctorDesk.prof.open")}</a>
          </div>
        ))}
      </div>
    </>
  );
}

function Owed({ p }: { p: WireProfessor }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const router = useRouter({ warn: false });
  const [refusal, setRefusal] = useState<string | null>(null);
  const push = useMutation({
    mutationFn: (key: string) => nudgeRow(key),
    onSuccess: () => { setRefusal(null); void qc.invalidateQueries({ queryKey: ["doctor-desk"] }); },
    onError: (e) => setRefusal(deskErrorText(e, t)),
  });
  if (p.unit === null) return <></>;
  return (
    <>
      <div className="ddp-head"><h2 className="ddp-h2">{t("doctorDesk.prof.owed")}</h2><span className="ddp-mono">{t("doctorDesk.unit.oldestFirst")}</span></div>
      {refusal !== null && <p role="alert" className="dd-alert">{refusal}</p>}
      <div className="ddp-list" data-testid="ddp-owed">
        {p.owed.length === 0 && <div className="ddp-empty">{t("doctorDesk.clocks.none", { unit: p.unit.short })}</div>}
        {p.owed.map((o) => {
          const c = clockText(o, p.at, t);
          const mine = o.holder.userId === p.you.userId;
          return (
            <div key={o.key} className="ddp-li" data-testid={`ddp-owed-${o.key}`}>
              <div className="ddp-li-main">
                <span className="ddp-li-t">{t(`doctorDesk.owed.${o.what}`, { defaultValue: t("doctorDesk.owed.other") })}{o.acked === true ? ` · ${t("doctorDesk.unit.acked")}` : ""}</span>
                <span className="ddp-li-s">{mine ? t("doctorDesk.clocks.you") : t("doctorDesk.prof.with", { name: o.holder.name })}</span>
              </div>
              <div className="ddp-li-side">
                <span className={c.over ? "ddp-red ddp-mono" : "ddp-mono"}>{c.text}</span>
                {!mine && (
                  <button
                    type="button" className={`ddp-btn${o.nudgedByMe ? " ddp-btn-done" : ""}`} data-testid={`ddp-nudge-${o.key}`}
                    disabled={o.nudgedByMe || push.isPending} onClick={() => push.mutate(o.key)}
                  >{o.nudgedByMe ? t("doctorDesk.clocks.nudged") : t("doctorDesk.clocks.nudge")}</button>
                )}
              </div>
            </div>
          );
        })}
        <a
          href="/doctor-desk/unit" className="ddp-link" data-testid="ddp-unit-link"
          onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: "/doctor-desk/unit" }); }}
        >{t("doctorDesk.prof.openBoard", { count: p.owedTotal })}</a>
      </div>
    </>
  );
}

function Handled({ p }: { p: WireProfessor }): React.ReactElement {
  const { t } = useTranslation();
  if (p.unit === null) return <></>;
  return (
    <section className="ddp-card" data-testid="ddp-handled">
      <div className="ddp-eyebrow">{t("doctorDesk.prof.handled")}</div>
      {p.handled.length === 0 && <div className="ddp-dim">{t("doctorDesk.prof.handledNone")}</div>}
      {p.handled.map((h) => (
        <div key={h.key} style={{ fontSize: 13 }} data-testid={`ddp-handled-${h.key}`}>
          {t("doctorDesk.prof.handledLine", {
            what: `${h.analyte} ${h.value}`.trim(), who: patientName(h.patient, t), by: h.by.name, n: h.minutes,
            act: t(`doctorDesk.act.choice.${h.choice}`), at: fmtIst(h.actedAt),
          })}
        </div>
      ))}
    </section>
  );
}

function RateWork({ items }: { items: WireRateItem[] }): React.ReactElement {
  const { t } = useTranslation();
  if (items.length === 0) return <></>;
  return (
    <>
      <div className="ddp-head"><h2 className="ddp-h2">{t("doctorDesk.rate.title")}</h2></div>
      <div className="ddp-dim" style={{ fontSize: 12.5 }}>{t("doctorDesk.rate.note")}</div>
      {items.map((i) => <RateCard key={i.workId} item={i} />)}
    </>
  );
}

function RateCard({ item }: { item: WireRateItem }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [pick, setPick] = useState<WorkRating | null>(null);
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (r: WorkRating) => rateWork(item.workId, r, reason.trim() === "" ? null : reason.trim()),
    onSuccess: () => { setRefusal(null); void qc.invalidateQueries({ queryKey: ["doctor-desk", "professor"] }); },
    onError: (e) => setRefusal(deskErrorText(e, t)),
  });
  const given = item.mine;
  return (
    <section className="ddp-card" data-testid={`ddp-rate-${item.workId}`}>
      <div className="ddp-eyebrow">{t("doctorDesk.rate.opdVisit")}</div>
      <div className="ddp-li-t">{t("doctorDesk.rate.question", { name: item.resident.name })}</div>
      <div className="ddp-li-s">{`${item.visitNo} · ${patientName(item.patient, t)}${item.completedAt === null ? "" : ` · ${fmtIst(item.completedAt)}`}`}</div>
      {given !== null ? (
        <div className="ddp-acted" data-testid={`ddp-rated-${item.workId}`}>{t("doctorDesk.rate.given", { rating: t(`doctorDesk.rate.r.${given}`) })}</div>
      ) : (
        <>
          <div className="ddp-rates">
            {WORK_RATINGS.map((r) => (
              <button
                key={r} type="button" className={`ddp-btn${pick === r ? " ddp-btn-on" : ""}`} data-testid={`ddp-rate-${item.workId}-${r}`}
                disabled={save.isPending}
                onClick={() => { setPick(r); if (r !== "needs_rework") save.mutate(r); }}
              >{t(`doctorDesk.rate.label.${r}`)}</button>
            ))}
          </div>
          {pick === "needs_rework" && (
            <div className="ddp-act-other">
              <label className="ddp-sr" htmlFor={`why-${item.workId}`}>{t("doctorDesk.rate.why")}</label>
              <input id={`why-${item.workId}`} className="ddp-input" maxLength={RATING_REASON_MAX} value={reason} placeholder={t("doctorDesk.rate.why")} data-testid={`ddp-rate-${item.workId}-why`} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="ddp-btn ddp-btn-ink" disabled={reason.trim().length < 3 || save.isPending} data-testid={`ddp-rate-${item.workId}-save`} onClick={() => save.mutate("needs_rework")}>{t("doctorDesk.act.save")}</button>
            </div>
          )}
        </>
      )}
      {refusal !== null && <p role="alert" className="dd-alert">{refusal}</p>}
    </section>
  );
}
