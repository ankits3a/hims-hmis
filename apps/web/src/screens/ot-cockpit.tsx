import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "@tanstack/react-router";
import {
  CLOCK_STEPS, clockStep, fetchCaseGates, fetchImplants, otErrorText, recordCount, scanImplant,
} from "../lib/ot-api";
import { Button } from "@/components/ui/button";
import type { ClockStep } from "../lib/ot-api";

/** The label key for each clock step, so the button table and the locale file cannot drift apart. */
const STEP_LABEL: Record<ClockStep, string> = {
  "to-holding": "otCockpit.toHolding",
  "sign-in": "otCockpit.signIn",
  "time-out": "otCockpit.timeOut",
  incision: "otCockpit.incision",
  closure: "otCockpit.closure",
  "sign-out": "otCockpit.signOut",
  "wheel-out": "otCockpit.wheelOut",
};

/**
 * PLAN 15 T8 — **THE COCKPIT: ONE CASE, FROM HOLDING TO WHEEL-OUT.**
 *
 * ═══ SEVEN BUTTONS, NO ORDER ENFORCED HERE ═══
 *
 * The order is the workflow definition's, and the engine refuses an out-of-order move with
 * `bad_transition`. This screen deliberately renders all seven steps as live buttons rather than
 * greying out the ones it believes are not next: the client's idea of "next" is a second copy of
 * the state machine (§2.54), and in a theatre the copy that is wrong is the one on the screen the
 * nurse is looking at. Press the wrong one and the server says so, in a sentence.
 *
 * ═══ NO TIME IS EVER SENT ═══
 *
 * Every clock button posts an empty body. DD8's five timestamps are stamped by the server and can
 * never be rewritten (`0035`'s trigger). A browser clock four minutes out must not become the legal
 * record of an incision.
 *
 * ═══ THE IMPLANT LIST SHOWS `deploying` AS A WAITING STATE, NOT AN ERROR ═══
 *
 * A scanned implant is `deploying` until the materials worker writes its ledger entry, and sign-out
 * is refused for as long as any implant is in that state (A18). That is a normal few seconds, so
 * the screen names it as waiting rather than as a failure — and the hint says what it blocks, so a
 * refused sign-out is already explained before it happens.
 */
export function OtCockpit(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { caseId } = useParams({ from: "/authed/ot/cockpit/$caseId" });

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [round, setRound] = useState("final");
  const [itemType, setItemType] = useState("swab");
  const [expected, setExpected] = useState("");
  const [counted, setCounted] = useState("");
  const [scrubBy, setScrubBy] = useState("");
  const [circulatingBy, setCirculatingBy] = useState("");

  const [itemId, setItemId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [lotId, setLotId] = useState("");
  const [store, setStore] = useState("");
  const [serviceCode, setServiceCode] = useState("");
  const [serial, setSerial] = useState("");
  const [qtyBase, setQtyBase] = useState("1");

  const gates = useQuery({ queryKey: ["ot", "gates", caseId], queryFn: () => fetchCaseGates(caseId) });
  const implants = useQuery({ queryKey: ["ot", "implants", caseId], queryFn: () => fetchImplants(caseId) });

  const run = async (fn: () => Promise<unknown>, keys: string[][]): Promise<void> => {
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(t("otCockpit.done"));
      for (const key of keys) await qc.invalidateQueries({ queryKey: key });
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
      <h1 className="text-lg font-semibold">{t("otCockpit.title")}</h1>
      <p className="text-sm">{t("otCockpit.caseId")}: <span className="font-mono">{caseId}</span></p>

      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p className="text-sm text-green-700">{done}</p>}

      <section className="space-y-2">
        <h2 className="font-semibold">{t("otCockpit.clock")}</h2>
        <p className="text-xs text-muted-foreground">{t("otCockpit.clockHint")}</p>
        <div className="flex flex-wrap gap-2">
          {CLOCK_STEPS.map((step) => (
            <Button
              key={step} variant="secondary"
              onClick={() => void run(() => clockStep(caseId, step), [["ot", "gates", caseId]])}
            >
              {t(STEP_LABEL[step])}
            </Button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">{t("otList.gates")}</h2>
        <ul className="text-sm">
          {(gates.data ?? []).map((g) => (
            <li key={g.id}>
              <span className="font-mono">{g.kind}</span> — {g.state}
            </li>
          ))}
        </ul>
      </section>

      <section className="max-w-3xl space-y-2">
        <h2 className="font-semibold">{t("otCockpit.counts")}</h2>
        <div className="grid grid-cols-3 gap-3">
          {field(t("otCockpit.round"), round, setRound)}
          {field(t("otCockpit.itemType"), itemType, setItemType)}
          {field(t("otCockpit.expected"), expected, setExpected, "number")}
          {field(t("otCockpit.counted"), counted, setCounted, "number")}
          {field(t("otCockpit.scrubBy"), scrubBy, setScrubBy)}
          {field(t("otCockpit.circulatingBy"), circulatingBy, setCirculatingBy)}
        </div>
        <Button
          disabled={expected === "" || counted === "" || scrubBy === "" || circulatingBy === ""}
          onClick={() => void run(() => recordCount(caseId, {
            round, itemType, expected: Number(expected), counted: Number(counted),
            scrubBy: scrubBy.trim(), circulatingBy: circulatingBy.trim(),
          }), [["ot", "gates", caseId]])}
        >
          {t("otCockpit.record")}
        </Button>
      </section>

      <section className="max-w-3xl space-y-2">
        <h2 className="font-semibold">{t("otCockpit.implants")}</h2>
        <p className="text-xs text-muted-foreground">{t("otCockpit.implantHint")}</p>
        <ul className="text-sm">
          {(implants.data ?? []).map((im) => (
            <li key={im.id}>
              <span className="font-mono">{im.serial ?? im.serviceCode}</span>
              {" — "}
              {im.state === "deploying" ? t("otCockpit.deploying") : im.state}
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-3 gap-3">
          {field(t("otCockpit.itemId"), itemId, setItemId)}
          {field(t("otCockpit.batchId"), batchId, setBatchId)}
          {field(t("otCockpit.lotId"), lotId, setLotId)}
          {field(t("otCockpit.store"), store, setStore)}
          {field("serviceCode", serviceCode, setServiceCode)}
          {field(t("otCockpit.serial"), serial, setSerial)}
          {field(t("otCockpit.qtyBase"), qtyBase, setQtyBase, "number")}
        </div>
        <Button
          disabled={itemId === "" || batchId === "" || store === "" || serviceCode === ""}
          onClick={() => void run(() => scanImplant(caseId, {
            itemId: itemId.trim(), batchId: batchId.trim(),
            ...(lotId.trim() === "" ? {} : { lotId: lotId.trim() }),
            storeResourceId: store.trim(), serviceCode: serviceCode.trim(),
            qtyBase: Number(qtyBase),
            ...(serial.trim() === "" ? {} : { serial: serial.trim() }),
          }), [["ot", "implants", caseId]])}
        >
          {t("otCockpit.scan")}
        </Button>
      </section>
    </div>
  );
}
