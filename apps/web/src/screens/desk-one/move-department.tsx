import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchConsultTerms } from "../../lib/billing-api";
import { previewDepartmentMove } from "../../lib/opd-api";
import { useAuth } from "../../lib/auth";
import { SubmitButton } from "../../components/submit-button";
import { rs, tokenLabel } from "./model";
import { moveCollectPaise, moveFee, moveMoneyBlocks, moveMoneyLine } from "../../../../../packages/contracts/src/desk-counter";
import type { WireConsultTerms } from "../../lib/billing-api";
import type { WireMoveMoney, WireMoveTender, WireVisitType } from "../../lib/opd-api";
import type { DeptQueue } from "./model";

/** The visit being moved, as much of it as the panel shows. */
export type MovableVisit = {
  encounterId: string;
  departmentId: string | null;
  departmentName: string | null;
  doctorName: string | null;
  /** The department's token code and number, when a token was issued. */
  departmentCode: string | null;
  tokenNo: number | null;
};

/**
 * What one side of the move costs. The SERVER'S amount (`feePaise` on the preview — the same pricer
 * the money rule reads) wins whenever it is there, so the fee line and the money line can never state
 * two different amounts (coordinator review 2026-10-05: "₹300 → ₹300" above "costs ₹500 there").
 * The terms in force only name WHY it is free, or stand in for an older server with no amount.
 */
function feeOf(vt: WireVisitType, terms: WireConsultTerms | undefined, t: (k: string) => string, serverPaise?: number): string | null {
  const fee = moveFee(vt, terms, serverPaise);
  if (fee === null) return null;
  return fee.kind === "amount" ? rs(fee.paise) : t(fee.kind === "feesOff" ? "registrationCounter.move.feesOff" : "registrationCounter.move.free");
}

/**
 * ═══ OWNER 2026-10-05 — "WRONG DEPARTMENT — MOVE PATIENT", ONE PANEL WHEREVER THE VISIT IS OPENED ═══
 *
 * *"If by mistake the front desk set the patient to Orthopedics but it should be General Medicine,
 * how can they move that patient … making sure the OPD report also gets auto corrected."* And then:
 * *"how can I change the department after I click 'hand over'? … from the patient profile, or the
 * history on the left"* — so the panel is no longer Desk One's alone. It takes the visit and the
 * day's queues as props, and `onMove` is the caller's: Desk One rewrites the patient it holds, a
 * visit card elsewhere just calls the server.
 *
 * Reason-first, like the visit-type correction: from → to, the department, then the doctor (with the
 * unit or "Guest Faculty" beside the name), why, and what the visit will cost there BEFORE the write.
 *
 * THE MONEY (owner, "yes go ahead" to four rules, 2026-10-05): the preview says which rule applies —
 * a ₹0 bill is re-raised; a paid fee that costs the same moves with the visit; a different fee is the
 * billing counter's to settle in the same act (a higher one is collected here, with a tender); a bill
 * carrying anything else goes to the Billing office first. The server decides; this only says so.
 */
export function MoveDepartmentForm({
  visit, queues, doctorLabel, onMove, onClose,
}: {
  visit: MovableVisit;
  queues: DeptQueue[];
  doctorLabel: (doctor: { userId: string; designation?: string | null }) => string | null;
  /** Resolves to `null` when the move is done, or the refusal to show beside the button. */
  onMove: (input: { departmentId: string; doctorId: string; reason: string; tenders?: WireMoveTender[] }) => Promise<string | null>;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [deptId, setDeptId] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<WireMoveTender["mode"]>("cash");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mayOpenVisits = useAuth().can("opd.visits.open");
  const terms = useQuery({ queryKey: ["billing", "consult-terms"], queryFn: fetchConsultTerms, enabled: mayOpenVisits, staleTime: 60_000, retry: false });
  const preview = useQuery({
    queryKey: ["d1", "move-preview", visit.encounterId, deptId ?? ""],
    queryFn: () => previewDepartmentMove(visit.encounterId, deptId!),
    enabled: deptId !== null,
    retry: false,
  });

  const targets = queues.filter((q) => q.departmentId !== visit.departmentId);
  const dq = targets.find((q) => q.departmentId === deptId) ?? null;
  const vtName = (vt: WireVisitType) => t(`registrationCounter.move.vt.${vt}`);
  const p = preview.data;
  const money = p?.money;
  const maySettle = p?.maySettleDifference === true;
  const blocked = moveMoneyBlocks(money, maySettle);
  const collect = moveCollectPaise(money, maySettle);
  const feeLine = (vt: WireVisitType, serverPaise?: number) => {
    const fee = feeOf(vt, terms.data, t, serverPaise);
    return fee === null ? vtName(vt) : `${vtName(vt)} · ${fee}`;
  };

  const submit = async (): Promise<void> => {
    if (deptId === null || doctorId === null) { setError(t("registrationCounter.move.pickBoth")); return; }
    if (reason.trim() === "") { setError(t("registrationCounter.move.reasonRequired")); return; }
    if (collect > 0 && mode !== "cash" && ref.trim() === "") { setError(t("registrationCounter.move.money.refRequired")); return; }
    setError(null);
    const refused = await onMove({
      departmentId: deptId, doctorId, reason: reason.trim(),
      ...(collect > 0 ? { tenders: [{ mode, amountPaise: collect, ...(mode === "cash" ? {} : { refText: ref.trim() }) }] } : {}),
    });
    if (refused === null) onClose();
    else setError(refused);
  };

  return (
    <div className="box d1-move" data-testid="move-dept-panel" style={{ marginTop: 12, padding: "12px 14px", background: "var(--wash)" }}>
      <div style={{ fontSize: 12.5, fontWeight: 700 }}>{t("registrationCounter.move.title")}</div>
      <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 3, lineHeight: "16px" }}>
        {t("registrationCounter.move.explain")}
      </div>

      <div data-testid="move-dept-from" style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginTop: 10, fontSize: 12 }}>
        <span className="tag">{t("registrationCounter.move.from")}</span>
        <b>{visit.departmentName}</b>
        <span style={{ color: "var(--dim)" }}>
          {visit.doctorName}
          {visit.tokenNo === null ? "" : ` · ${tokenLabel(visit.departmentCode, visit.tokenNo)}`}
        </span>
      </div>

      <div className="tag" style={{ marginTop: 11 }}>{t("registrationCounter.move.toDept")}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 5 }}>
        {targets.map((q) => (
          <button
            key={q.departmentId}
            type="button"
            className="pill"
            data-testid={`move-dept-${q.departmentId}`}
            onClick={() => { setDeptId(q.departmentId); setDoctorId(q.doctors.length === 1 ? q.doctors[0]!.doctor.id : null); setError(null); }}
            style={{
              borderColor: deptId === q.departmentId ? "var(--green)" : "var(--line)",
              background: deptId === q.departmentId ? "var(--green)" : "var(--card)",
              color: deptId === q.departmentId ? "#fff" : "var(--ink)",
              fontWeight: deptId === q.departmentId ? 700 : 400,
            }}
          >
            {q.departmentName}
          </button>
        ))}
        {targets.length === 0 ? <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{t("registrationCounter.move.noTargets")}</span> : null}
      </div>

      {dq === null ? null : (
        <>
          <div className="tag" style={{ marginTop: 11 }}>{t("registrationCounter.move.toDoctor")}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 5 }}>
            {dq.doctors.map((doc) => {
              const tag = doctorLabel(doc.doctor);
              const on = doctorId === doc.doctor.id;
              return (
                <button
                  key={doc.doctor.id}
                  type="button"
                  className="pill"
                  data-testid={`move-doctor-${doc.doctor.id}`}
                  onClick={() => { setDoctorId(doc.doctor.id); setError(null); }}
                  style={{
                    borderColor: on ? "var(--green)" : "var(--line)",
                    background: on ? "var(--green)" : "var(--card)",
                    color: on ? "#fff" : "var(--ink)",
                    fontWeight: on ? 700 : 400,
                    textAlign: "left",
                    height: "auto",
                    padding: "5px 10px",
                    lineHeight: "15px",
                  }}
                >
                  {doc.doctor.displayName}
                  <span style={{ display: "block", fontSize: 10.5, fontWeight: 400, opacity: 0.85 }}>
                    {tag === null ? "" : `${tag} · `}{t("registrationCounter.move.waiting", { count: doc.waitingCount })}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {p === undefined || deptId === null ? null : (
        <div
          data-testid="move-dept-fee"
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 11, fontSize: 12, padding: "8px 10px", background: "var(--card)", border: "1px solid var(--line2)", borderRadius: 6 }}
        >
          <span style={{ color: "var(--dim)" }}>{t("registrationCounter.move.now")}</span>
          <b>{feeLine(p.from.visitType, p.from.feePaise)}</b>
          <span style={{ color: "var(--faint)" }}>→</span>
          <span style={{ color: "var(--dim)" }}>{t("registrationCounter.move.after", { dept: dq?.departmentName ?? "" })}</span>
          <b data-testid="move-dept-fee-after">{feeLine(p.to.visitType, p.to.feePaise)}</b>
        </div>
      )}

      {money === undefined || deptId === null ? null : (
        <MoneyLine money={money} maySettle={maySettle} />
      )}

      {collect === 0 ? null : (
        <div data-testid="move-dept-tender" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
          {(["cash", "upi", "card"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className="pill"
              data-testid={`move-tender-${m}`}
              aria-pressed={mode === m}
              onClick={() => { setMode(m); setError(null); }}
              style={{
                borderColor: mode === m ? "var(--green)" : "var(--line)",
                background: mode === m ? "var(--green)" : "var(--card)",
                color: mode === m ? "#fff" : "var(--ink)",
                fontWeight: mode === m ? 700 : 400,
              }}
            >
              {t(`registrationCounter.move.money.mode.${m}`)}
            </button>
          ))}
          {mode === "cash" ? null : (
            <input
              className="in"
              data-testid="move-tender-ref"
              style={{ flex: "1 1 160px", minWidth: 0, height: 30 }}
              placeholder={t("registrationCounter.move.money.refHint")}
              value={ref}
              onChange={(e) => { setRef(e.target.value); }}
            />
          )}
        </div>
      )}

      <input
        className="in"
        data-testid="move-dept-reason"
        style={{ marginTop: 10 }}
        placeholder={t("registrationCounter.move.reasonHint")}
        value={reason}
        onChange={(e) => { setReason(e.target.value); }}
      />
      <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 5, lineHeight: "14px" }}>{t("registrationCounter.move.slips")}</div>
      {error === null ? null : (
        <div role="alert" data-testid="move-dept-error" style={{ fontSize: 11, color: "var(--red)", marginTop: 6 }}>{error}</div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <SubmitButton plain className="pri" data-testid="move-dept-submit" disabled={blocked} onClick={submit}>
          {dq === null
            ? t("registrationCounter.move.submitBare")
            : collect > 0
              ? t("registrationCounter.move.money.submitCollect", { diff: rs(collect), dept: dq.departmentName })
              : t("registrationCounter.move.submit", { dept: dq.departmentName })}
        </SubmitButton>
        <button type="button" className="sec" data-testid="move-dept-cancel" onClick={onClose}>
          {t("registrationCounter.move.cancel")}
        </button>
      </div>
    </div>
  );
}

/** Which of the four money rules applies, in the words the clerk acts on. */
function MoneyLine({ money, maySettle }: { money: WireMoveMoney; maySettle: boolean }): React.ReactElement | null {
  const { t } = useTranslation();
  const line = moveMoneyLine(money, maySettle);
  if (line === null) return null;
  const text = t(line.key, line.vars);
  const tone = line.tone;
  return (
    <div
      role={tone === "stop" ? "alert" : "status"}
      data-testid="move-dept-money"
      data-kind={money.kind}
      style={{
        fontSize: 11.5, lineHeight: "16px", marginTop: 8, padding: "7px 10px", borderRadius: 6,
        color: tone === "stop" ? "var(--red)" : "var(--ink)",
        background: tone === "stop" ? "var(--red-soft)" : tone === "warn" ? "var(--gold-soft)" : "var(--card)",
        border: `1px solid ${tone === "stop" ? "var(--red-line)" : tone === "warn" ? "var(--gold-line)" : "var(--line2)"}`,
      }}
    >
      {text}
    </div>
  );
}
