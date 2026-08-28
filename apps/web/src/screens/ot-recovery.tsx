import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  admitToRecovery, dischargeFromRecovery, fetchBillPreview, fetchRecoveryBoard, fetchScores,
  otErrorText, recordScore, settleBill, verifyEscort,
} from "../lib/ot-api";
import { Button } from "@/components/ui/button";
import type { WireSettlement } from "../lib/ot-api";

/** The Aldrete axes the PACU definition scores. Five axes, 0–2 each. */
const SCORE_AXES = ["activity", "respiration", "circulation", "consciousness", "saturation"] as const;

function rupees(paise: number): string {
  return (paise / 100).toFixed(2);
}

/**
 * PLAN 15 T8 — **RECOVERY: THE BAY BOARD, THE SCORES, THE ESCORT, AND THE BILL.**
 *
 * ═══ THE BOARD IS THE REGISTRY'S, SO A BAY CANNOT BE DOUBLE-BOOKED BY TWO SCREENS ═══
 *
 * Occupancy is the resource registry's fact and admission goes through its `assign`, which takes a
 * row lock. Two nurses admitting to bay 3 at the same moment do not both win — one gets
 * `bay_occupied`. The board here is a read of that state, refreshed after every write; it is not
 * where the decision is made, which is exactly why it is safe to render.
 *
 * ═══ DISCHARGE IS GATED TWICE AND THE SCREEN EXPLAINS THE SECOND GATE BEFORE IT BITES ═══
 *
 * A21: an escort verified at ADMISSION does not discharge anybody — the verification is repeated at
 * discharge, because the person who brought the patient in at 7 a.m. is often not the person
 * collecting them at 4 p.m., and a sedated patient must not leave with nobody. The hint says so
 * before the refusal arrives, and the refusal (`escort_required`) says it again.
 *
 * ═══ THE BILL IS PREVIEWED BEFORE IT IS ISSUED, AND THE CLAMP IS SHOWN ═══
 *
 * The implant line names which of the three bounds won — tariff, batch MRP, or the gazette ceiling.
 * A cashier who can see `mrp` on the line can answer the patient's question; a cashier shown only a
 * number cannot. `netPayable` and `held` are both shown so the cash to take is visible arithmetic
 * rather than a surprise at the counter.
 */
export function OtRecovery(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [encounterId, setEncounterId] = useState("");
  const [caseId, setCaseId] = useState("");
  const [bay, setBay] = useState("");
  const [scores, setScores] = useState<Record<string, string>>({});
  const [isbar, setIsbar] = useState("");
  const [cash, setCash] = useState("");
  const [settled, setSettled] = useState<WireSettlement | null>(null);
  const [readiness, setReadiness] = useState<boolean | null>(null);

  const [escortName, setEscortName] = useState("");
  const [escortRelation, setEscortRelation] = useState("");
  const [escortPhone, setEscortPhone] = useState("");
  const [escortIdType, setEscortIdType] = useState("aadhaar");
  const [escortIdLast4, setEscortIdLast4] = useState("");
  const [escortAge, setEscortAge] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const board = useQuery({ queryKey: ["ot", "board"], queryFn: fetchRecoveryBoard });
  const scoreRows = useQuery({
    queryKey: ["ot", "scores", encounterId],
    queryFn: () => fetchScores(encounterId),
    enabled: encounterId !== "",
  });
  const preview = useQuery({
    queryKey: ["ot", "bill-preview", encounterId],
    queryFn: () => fetchBillPreview(encounterId),
    enabled: encounterId !== "",
  });

  const run = async (fn: () => Promise<unknown>, keys: string[][]): Promise<void> => {
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(t("otRecovery.done"));
      for (const key of keys) await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError(otErrorText(e, t));
    }
  };

  const submitScore = async (): Promise<void> => {
    setError(null);
    setDone(null);
    try {
      const values: Record<string, number> = {};
      for (const axis of SCORE_AXES) values[axis] = Number(scores[axis] ?? 0);
      const res = await recordScore(encounterId, { caseId, values, occurredAt: new Date().toISOString() });
      setReadiness(res.readiness.ready);
      await qc.invalidateQueries({ queryKey: ["ot", "scores", encounterId] });
    } catch (e) {
      setError(otErrorText(e, t));
    }
  };

  const settle = async (): Promise<void> => {
    setError(null);
    setDone(null);
    try {
      const paise = cash.trim() === "" ? undefined : Math.round(Number(cash) * 100);
      const res = await settleBill(encounterId, paise === undefined ? {} : { cashTenderPaise: paise });
      setSettled(res);
      await qc.invalidateQueries({ queryKey: ["ot", "bill-preview", encounterId] });
    } catch (e) {
      setError(otErrorText(e, t));
    }
  };

  const field = (label: string, value: string, set: (v: string) => void, type = "text"): React.ReactElement => (
    <label className="flex flex-col text-sm">
      {label}
      <input type={type} className="rounded border px-2 py-1" value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );

  return (
    <div className="space-y-5 p-4">
      <h1 className="text-lg font-semibold">{t("otRecovery.title")}</h1>

      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p className="text-sm text-green-700">{done}</p>}

      <section className="space-y-2">
        <h2 className="font-semibold">{t("otRecovery.board")}</h2>
        <table className="text-sm">
          <thead>
            <tr className="text-left">
              <th className="pr-4">{t("otRecovery.bay")}</th>
              <th className="pr-4">{t("otRecovery.status")}</th>
              <th>{t("otRecovery.occupant")}</th>
            </tr>
          </thead>
          <tbody>
            {(board.data ?? []).map((b) => (
              <tr key={b.bayResourceId} className="border-t">
                <td className="pr-4">{b.code}</td>
                <td className="pr-4">{b.status}</td>
                <td>{b.patientDisplay ?? "\u2014"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="max-w-3xl space-y-2 border-t pt-4">
        <div className="grid grid-cols-3 gap-3">
          {field(t("otRecovery.encounterId"), encounterId, setEncounterId)}
          {field(t("otCockpit.caseId"), caseId, setCaseId)}
          {field(t("otRecovery.bay"), bay, setBay)}
        </div>
        <Button
          disabled={encounterId === "" || caseId === "" || bay === ""}
          onClick={() => void run(
            () => admitToRecovery(encounterId, { caseId, bayResourceId: bay.trim() }),
            [["ot", "board"]],
          )}
        >
          {t("otRecovery.admit")}
        </Button>
      </section>

      <section className="max-w-3xl space-y-2 border-t pt-4">
        <h2 className="font-semibold">{t("otRecovery.scores")}</h2>
        <div className="grid grid-cols-5 gap-2">
          {SCORE_AXES.map((axis) => (
            <label key={axis} className="flex flex-col text-xs">
              {axis}
              <input
                type="number" min={0} max={2} className="rounded border px-2 py-1"
                value={scores[axis] ?? ""}
                onChange={(e) => setScores((s) => ({ ...s, [axis]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        <Button disabled={encounterId === "" || caseId === ""} onClick={() => void submitScore()}>
          {t("otRecovery.recordScore")}
        </Button>
        {readiness !== null && (
          <p className={readiness ? "text-sm text-green-700" : "text-sm text-amber-700"}>
            {readiness ? t("otRecovery.ready") : t("otRecovery.notReady")}
          </p>
        )}
        <ul className="text-sm">
          {(scoreRows.data ?? []).map((s) => (
            <li key={s.id}>{s.occurredAt} — {t("otRecovery.total")} {s.total}</li>
          ))}
        </ul>
      </section>

      <section className="max-w-3xl space-y-2 border-t pt-4">
        <h2 className="font-semibold">{t("otRecovery.escort")}</h2>
        <p className="text-xs text-muted-foreground">{t("otRecovery.escortHint")}</p>
        <div className="grid grid-cols-3 gap-3">
          {field(t("otRecovery.escortName"), escortName, setEscortName)}
          {field(t("otRecovery.escortRelation"), escortRelation, setEscortRelation)}
          {field(t("otRecovery.escortPhone"), escortPhone, setEscortPhone)}
          {field(t("otRecovery.escortIdType"), escortIdType, setEscortIdType)}
          {field(t("otRecovery.escortIdLast4"), escortIdLast4, setEscortIdLast4)}
          {field(t("otRecovery.escortAge"), escortAge, setEscortAge, "number")}
        </div>
        <Button
          disabled={encounterId === "" || escortName === "" || escortPhone === ""}
          onClick={() => void run(() => verifyEscort(encounterId, {
            at: "discharge",
            escort: {
              name: escortName.trim(), relation: escortRelation.trim(), phone: escortPhone.trim(),
              idType: escortIdType.trim(), idLast4: escortIdLast4.trim(), ageYears: Number(escortAge),
            },
          }), [])}
        >
          {t("otRecovery.verifyEscort")}
        </Button>

        <div className="flex items-end gap-3 pt-2">
          {field(t("otRecovery.isbar"), isbar, setIsbar)}
          <Button
            disabled={encounterId === "" || caseId === "" || isbar === ""}
            onClick={() => void run(
              () => dischargeFromRecovery(encounterId, { caseId, isbarAcknowledgedBy: isbar.trim() }),
              [["ot", "board"], ["ot", "bill-preview", encounterId]],
            )}
          >
            {t("otRecovery.discharge")}
          </Button>
        </div>
      </section>

      <section className="max-w-3xl space-y-2 border-t pt-4">
        <h2 className="font-semibold">{t("otRecovery.bill")}</h2>
        <p className="text-xs text-muted-foreground">{t("otRecovery.billHint")}</p>
        {preview.data !== undefined && (
          <div className="space-y-1 text-sm">
            <p>{t("otRecovery.packageLines")}: {preview.data.packageLines.map((l) => l.serviceCode).join(", ")}</p>
            <ul>
              {preview.data.implantLines.map((l) => (
                <li key={l.implantId}>
                  {t("otRecovery.implantLines")}: {l.serviceCode} — ₹{rupees(l.capUnitPaise)}
                  {" "}({t("otRecovery.boundApplied")}: {l.boundApplied})
                </li>
              ))}
            </ul>
            <p className="font-semibold">
              {t("otRecovery.netPayable")}: ₹{rupees(preview.data.expectedNetPaise)}
              {" · "}
              {t("otRecovery.held")}: ₹{rupees(preview.data.heldPaise)}
            </p>
          </div>
        )}
        <div className="flex items-end gap-3">
          {field(t("otRecovery.cashTender"), cash, setCash, "number")}
          <Button disabled={encounterId === ""} onClick={() => void settle()}>
            {t("otRecovery.settle")}
          </Button>
        </div>
        {settled !== null && (
          <div className="text-sm text-green-700">
            <p>
              {t("otRecovery.settled", {
                invoiceNo: settled.invoiceNo,
                net: rupees(settled.netPayablePaise),
                allocated: rupees(settled.allocatedPaise),
              })}
            </p>
            {settled.refundPaise > 0 && <p>{t("otRecovery.refund", { amount: rupees(settled.refundPaise) })}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
