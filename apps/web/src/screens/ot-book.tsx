import { useState } from "react";
import { useTranslation } from "react-i18next";
import { bookCase, holdDeposit, otErrorText } from "../lib/ot-api";
import { Button } from "@/components/ui/button";

const PAYER_CLASSES = [
  "self_pay", "staff_dependant", "charity", "membership_prepaid",
  "insured_tpa", "corporate_credit", "govt_scheme", "fp_scheme",
] as const;

const ANAESTHESIA = ["local", "sedation", "regional", "spinal", "general"] as const;

/**
 * PLAN 15 T8 — **BOOKING A DAY-CARE CASE, AND THEN HOLDING THE DEPOSIT AGAINST IT.**
 *
 * ═══ TWO STEPS, IN THIS ORDER, BECAUSE THE HOLD NEEDS AN ENCOUNTER TO HOLD AGAINST ═══
 *
 * `bookCase` creates the case AND its day-care encounter; the deposit is then held against that
 * encounter id. The screen shows the second form only once the first has returned one, which is not
 * a validation rule but the plain shape of the data: there is nothing to hold against before then.
 *
 * ═══ THE DEPOSIT IS PER ENCOUNTER AND THE SCREEN SAYS SO ═══
 *
 * DD12: advances are per PATIENT, but the day-care deposit gate reads `ot_deposit_holds` for THIS
 * encounter. A patient with ₹50,000 sitting as an advance from an old visit has not paid for this
 * operation, and a coordinator who assumes otherwise sends an unfunded case to a theatre. The hint
 * under the form is that sentence, because the failure it prevents is silent.
 *
 * ═══ EVERY REFUSAL HERE IS THE SERVER'S ═══
 *
 * Day-care criteria, surgeon privilege, duplicate booking, the deposit shortfall — all of them are
 * decided by the OT module and rendered here as the sentence that came back. The form declines to
 * construct obviously-invalid states (an empty required field) and enforces nothing else.
 */
export function OtBook(): React.ReactElement {
  const { t } = useTranslation();

  const [patientId, setPatientId] = useState("");
  const [procedureClass, setProcedureClass] = useState("");
  const [procedureCode, setProcedureCode] = useState("");
  const [laterality, setLaterality] = useState("");
  const [surgeonId, setSurgeonId] = useState("");
  const [anaesthetistId, setAnaesthetistId] = useState("");
  const [listDate, setListDate] = useState("");
  const [theatre, setTheatre] = useState("");
  const [payerClass, setPayerClass] = useState<string>(PAYER_CLASSES[0]);
  const [anaesthesiaType, setAnaesthesiaType] = useState<string>(ANAESTHESIA[0]);
  const [estimatedMinutes, setEstimatedMinutes] = useState("45");

  const [booked, setBooked] = useState<{ caseId: string; encounterId: string; encounterNo: string } | null>(null);
  const [receiptId, setReceiptId] = useState("");
  const [amount, setAmount] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const book = async (): Promise<void> => {
    setError(null);
    setDone(null);
    try {
      const res = await bookCase({
        patientId: patientId.trim(),
        procedureClass: procedureClass.trim(),
        procedureCode: procedureCode.trim(),
        ...(laterality.trim() === "" ? {} : { laterality: laterality.trim() }),
        surgeonId: surgeonId.trim(),
        ...(anaesthetistId.trim() === "" ? {} : { anaesthetistId: anaesthetistId.trim() }),
        listDate, theatreResourceId: theatre.trim(),
        payerClass, anaesthesiaType,
        estimatedMinutes: Number(estimatedMinutes),
      });
      setBooked(res);
      setDone(t("otBook.booked", { encounterNo: res.encounterNo }));
    } catch (e) {
      setError(otErrorText(e, t));
    }
  };

  const hold = async (): Promise<void> => {
    setError(null);
    setDone(null);
    if (booked === null) return;
    try {
      // Rupees on the screen, integer paise on the wire — the one conversion, at the boundary.
      const paise = Math.round(Number(amount) * 100);
      await holdDeposit(booked.encounterId, { receiptId: receiptId.trim(), amountPaise: paise });
      setDone(t("otBook.held", { amount: (paise / 100).toFixed(2) }));
      setReceiptId(""); setAmount("");
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
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">{t("otBook.title")}</h1>

      <div className="grid max-w-3xl grid-cols-2 gap-3">
        {field(t("otBook.patientId"), patientId, setPatientId)}
        {field(t("otBook.procedureClass"), procedureClass, setProcedureClass)}
        {field(t("otBook.procedureCode"), procedureCode, setProcedureCode)}
        {field(t("otBook.laterality"), laterality, setLaterality)}
        {field(t("otBook.surgeon"), surgeonId, setSurgeonId)}
        {field(t("otBook.anaesthetist"), anaesthetistId, setAnaesthetistId)}
        {field(t("otBook.listDate"), listDate, setListDate, "date")}
        {field(t("otBook.theatre"), theatre, setTheatre)}
        <label className="flex flex-col text-sm">
          {t("otBook.payerClass")}
          <select className="rounded border px-2 py-1" value={payerClass} onChange={(e) => setPayerClass(e.target.value)}>
            {PAYER_CLASSES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          {t("otBook.anaesthesiaType")}
          <select className="rounded border px-2 py-1" value={anaesthesiaType} onChange={(e) => setAnaesthesiaType(e.target.value)}>
            {ANAESTHESIA.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        {field(t("otBook.estimatedMinutes"), estimatedMinutes, setEstimatedMinutes, "number")}
      </div>

      <Button
        onClick={() => void book()}
        disabled={patientId === "" || procedureClass === "" || procedureCode === "" || surgeonId === "" || listDate === "" || theatre === ""}
      >
        {t("otBook.book")}
      </Button>

      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p className="text-sm text-green-700">{done}</p>}

      {booked !== null && (
        <section className="max-w-3xl space-y-3 border-t pt-4">
          <h2 className="font-semibold">{t("otBook.depositTitle")}</h2>
          <p className="text-xs text-muted-foreground">{t("otBook.depositHint")}</p>
          <div className="grid grid-cols-2 gap-3">
            {field(t("otBook.receiptId"), receiptId, setReceiptId)}
            {field(t("otBook.amount"), amount, setAmount, "number")}
          </div>
          <Button onClick={() => void hold()} disabled={receiptId === "" || amount === ""}>
            {t("otBook.hold")}
          </Button>
        </section>
      )}
    </div>
  );
}
