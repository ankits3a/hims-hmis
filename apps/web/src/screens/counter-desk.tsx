import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { listDepartments, opdErrorMessage, todayIst, walkIn } from "../lib/opd-api";
import type {
  WireDepartment, WireDoctorSummary, WireDuplicateCandidate, WireWalkInResult,
} from "../lib/opd-api";
import { fetchFeeQuote, issueInvoice, billingErrorMessage } from "../lib/billing-api";
import type { WireFeeQuote, WireIssueInvoiceResult, WireTender } from "../lib/billing-api";
import { usePatientInHand } from "../lib/patient-in-hand";
import { PatientPicker } from "../components/patient-picker";
import type { PatientPickerHit } from "../components/patient-picker";
import { TenderEditor } from "../components/tender-editor";
import { CounterSlip } from "../components/counter-slip";
import type { QrCardData } from "../components/qr-card";
import { SubmitButton } from "../components/submit-button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * PLAN 07b T3 — THE COUNTER: ONE SCREEN, ONE WALK-IN.
 *
 * The measured cost of the simplest walk-in — a returning patient, self-pay, cash — was THREE route
 * changes, THREE searches for the same person and a hand-typed visit id, because the app's unit of
 * work was a module screen and the counter's is one human from hello to goodbye. This screen is that
 * unit: find them once, open the visit, take the money, hand them on. Nothing here is a new
 * capability; every call it makes already existed.
 *
 * ═══ IT ENDS AT PAYMENT (owner ruling R-1) ═══
 *
 * Vitals are recorded by dedicated staff, so this screen NEVER moves the encounter past
 * `waiting_vitals`. It has no vitals control and makes no vitals call — the handoff is a sentence
 * telling the patient where to go next. A counter that could record vitals would quietly become the
 * place vitals get recorded badly.
 *
 * ═══ IT NAMES WHICH OF THE THREE LAWFUL EXITS APPLIED (DD2) ═══
 *
 * Owner ruling R-2 is that nobody passes the counter unbilled, and the system has exactly three ways
 * to satisfy that: a settled invoice, a credit-extended invoice with a reason, or a FREE REVISIT
 * with no invoice at all (`feeServiceFor` returns null inside the follow-up window; the fee gate
 * passes it). All three are correct and they look nothing alike to the patient, so the screen says
 * which one happened rather than leaving the clerk to infer it from an empty total.
 */
type Phase = "find" | "opened" | "done";

function newIdemKey(): string {
  return `walkin-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

export function CounterDesk(): React.ReactElement {
  const { t } = useTranslation();
  const { inHand, takePatient, takeEncounter, release } = usePatientInHand();
  const today = todayIst();

  const [phase, setPhase] = useState<Phase>("find");
  const [picked, setPicked] = useState<PatientPickerHit | null>(null);
  const [registering, setRegistering] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newSex, setNewSex] = useState("unknown");
  const [departmentId, setDepartmentId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [duplicates, setDuplicates] = useState<WireDuplicateCandidate[] | null>(null);
  const [opened, setOpened] = useState<WireWalkInResult | null>(null);
  const [quote, setQuote] = useState<WireFeeQuote | null>(null);
  const [tenders, setTenders] = useState<WireTender[]>([]);
  const [issued, setIssued] = useState<WireIssueInvoiceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<QrCardData | null>(null);
  /**
   * The invoice DRAFT id, stable for this walk-in. It is not an idempotency key: `SubmitButton`
   * mints one of those per ATTEMPT and hands it to the handler, which is the convention every other
   * write lane in this app follows. A failed claim is DELETED server-side (`idempotency.ts`), so a
   * corrected retry — the "register anyway" path after a duplicate warning, with a different body —
   * is safe under either scheme; following the house convention keeps one idiom rather than two.
   */
  const [draftId, setDraftId] = useState(newIdemKey);

  /**
   * PLAN 07b T4 / DD5 — THE DRAWER IS THE COUNTER'S PRECONDITION, NOT BILLING'S.
   *
   * `issueInvoice` refuses without an open cashier session, and owner ruling R-2 is that nobody
   * passes this counter unbilled. Put together, a clerk with a closed drawer cannot FINISH a
   * walk-in — but nothing stopped them STARTING one, so they discovered it at the payment step
   * having already registered the patient and opened the visit. That half-done walk-in was caused
   * purely by the order the checks happened in, which is why this one happens on mount.
   */
  const drawer = useQuery({
    queryKey: ["billing", "sessions", "current"],
    queryFn: () => api<{ session: { id: string; status: "open" | "closing" | "closed" } | null }>(
      "GET", "/billing/sessions/current",
    ),
  });
  const session = drawer.data?.session ?? null;
  const drawerOpen = session?.status === "open";
  const drawerLocked = session?.status === "closing";

  const departments = useQuery({ queryKey: ["opd", "departments"], queryFn: listDepartments });
  const board = useQuery({
    queryKey: ["opd", "queues", "summary", departmentId, today],
    queryFn: () => api<{ items: WireDoctorSummary[] }>(
      "GET", `/opd/queues/summary?departmentId=${departmentId}&serviceDate=${today}`,
    ),
    enabled: departmentId !== "",
  });

  const departmentItems: WireDepartment[] = departments.data?.items ?? [];
  const doctors = board.data?.items ?? [];

  const readyToOpen = drawerOpen && departmentId !== "" && doctorId !== ""
    && (picked !== null || (registering && newName.trim() !== ""));

  const reset = (): void => {
    setPhase("find"); setPicked(null); setRegistering(false);
    setNewName(""); setNewPhone(""); setNewSex("unknown");
    setDoctorId(""); setDuplicates(null); setOpened(null); setQuote(null);
    setTenders([]); setIssued(null); setError(null); setQr(null);
    setDraftId(newIdemKey());
    release();
  };

  async function openVisit(acknowledgeDuplicates: boolean, idemKey: string): Promise<void> {
    setError(null); setDuplicates(null);
    try {
      const result = await walkIn({
        patient: picked !== null
          ? { existingId: picked.id }
          : { register: { name: newName.trim(), sex: newSex, ...(newPhone.trim() === "" ? {} : { phone: newPhone.trim() }) } },
        departmentId, doctorId,
        ...(acknowledgeDuplicates ? { acknowledgedDuplicates: true } : {}),
      }, idemKey);
      setOpened(result);
      takePatient(result.patientId);
      takeEncounter(result.encounter.id);
      setPhase("opened");
      setQr(await api<QrCardData>("GET", `/patients/${result.patientId}/qr`));
      setQuote(await fetchFeeQuote(result.encounter.id));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const detail = (e.body as { detail?: { candidates?: WireDuplicateCandidate[] } } | undefined)?.detail;
        if (detail?.candidates !== undefined) { setDuplicates(detail.candidates); return; }
      }
      setError(opdErrorMessage(e));
    }
  }

  async function settle(idemKey: string): Promise<void> {
    if (opened === null || quote === null || quote.draft === null) return;
    setError(null);
    try {
      setIssued(await issueInvoice({
        draftId,
        patientId: opened.patientId,
        encounterId: opened.encounter.id,
        lines: quote.draft.lines.map((l) => ({ lineId: l.lineId, serviceId: l.serviceId, qty: l.qty })),
        receipt: { tenders },
      }, idemKey));
      setPhase("done");
    } catch (e) {
      setError(billingErrorMessage(e));
    }
  }

  /** DD2's three exits, named. `null` until the visit is open. */
  const exit: "free" | "settled" | "credit" | null =
    opened === null ? null
      : quote?.free === true ? "free"
        : issued === null ? null
          : issued.creditExtended ? "credit" : "settled";

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("counter.title")}</h1>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {!drawer.isPending && !drawerOpen && (
        <div
          data-testid="drawer-blocker"
          className={`rounded border p-3 text-sm ${drawerLocked ? "border-red-500 bg-red-50" : "border-amber-500 bg-amber-50"}`}
        >
          {drawerLocked
            ? (
              /*
               * O-1, ROUTED TO THE OWNER AND STILL OPEN. A paise mismatch at close moves the session
               * to `closing` and locks this cashier out of ALL counter work until a billing manager
               * grants a variance approval. With ONE person on the counter (ruling R-4) that closes
               * registration and visit-opening too — the hospital's front door, not just the till.
               * The control is correct and stays; the screen says plainly what is needed and who by,
               * rather than answering `no_open_session` and letting the clerk read it as a bug.
               */
              <p data-testid="drawer-locked">{t("counter.drawerLocked")}</p>
            )
            : (
              <div className="space-y-2">
                <p data-testid="drawer-closed">{t("counter.drawerClosed")}</p>
                <Button
                  variant="outline" data-testid="open-drawer"
                  onClick={() => { window.location.assign("/billing/session"); }}
                >
                  {t("counter.openDrawer")}
                </Button>
              </div>
            )}
        </div>
      )}

      {phase === "find" && (
        <section className="space-y-3" data-testid="band-find">
          <h2 className="text-sm font-semibold">{t("counter.whoIsHere")}</h2>
          {!registering && (
            <>
              <PatientPicker autoFocus onPick={(hit) => { setPicked(hit); }} />
              {picked !== null && (
                <p data-testid="picked" className="text-sm">
                  {picked.name ?? "—"} · {picked.uhid}
                </p>
              )}
              <Button variant="outline" data-testid="register-new" onClick={() => { setRegistering(true); setPicked(null); }}>
                {t("counter.registerNew")}
              </Button>
            </>
          )}
          {registering && (
            <div className="space-y-2" data-testid="inline-register">
              <input
                aria-label={t("counter.name")} data-testid="new-name" className="w-full rounded border px-3 py-2"
                value={newName} onChange={(e) => { setNewName(e.target.value); }}
              />
              <input
                aria-label={t("counter.phone")} data-testid="new-phone" className="w-full rounded border px-3 py-2"
                value={newPhone} onChange={(e) => { setNewPhone(e.target.value); }}
              />
              <select
                aria-label={t("counter.sex")} data-testid="new-sex" className="w-full rounded border px-3 py-2"
                value={newSex} onChange={(e) => { setNewSex(e.target.value); }}
              >
                <option value="unknown">{t("counter.sexUnknown")}</option>
                <option value="female">{t("counter.sexFemale")}</option>
                <option value="male">{t("counter.sexMale")}</option>
              </select>
              <Button variant="ghost" onClick={() => { setRegistering(false); }}>{t("counter.backToSearch")}</Button>
            </div>
          )}

          <h2 className="text-sm font-semibold">{t("counter.whichDoctor")}</h2>
          <select
            aria-label={t("counter.department")} data-testid="department" className="w-full rounded border px-3 py-2"
            value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setDoctorId(""); }}
          >
            <option value="">{t("counter.pickDepartment")}</option>
            {departmentItems.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {departmentId !== "" && (
            <select
              aria-label={t("counter.doctor")} data-testid="doctor" className="w-full rounded border px-3 py-2"
              value={doctorId} onChange={(e) => { setDoctorId(e.target.value); }}
            >
              <option value="">{t("counter.pickDoctor")}</option>
              {doctors.map((s) => (
                <option key={s.doctor.id} value={s.doctor.id}>
                  {s.doctor.displayName} · {t("counter.waiting", { n: s.waitingCount })}
                </option>
              ))}
            </select>
          )}

          {duplicates !== null && (
            <div data-testid="duplicate-warning" className="rounded border border-amber-500 bg-amber-50 p-3 text-sm">
              <p className="font-medium">{t("counter.duplicateWarning", { n: duplicates.length })}</p>
              <ul className="mt-1 list-disc pl-5">
                {duplicates.map((c) => <li key={c.id}>{c.name ?? "—"} · {c.uhid}</li>)}
              </ul>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="outline" data-testid="use-existing"
                  onClick={() => { setDuplicates(null); setRegistering(false); }}
                >
                  {t("counter.useExisting")}
                </Button>
                <SubmitButton data-testid="register-anyway" onClick={(k) => openVisit(true, k)}>
                  {t("counter.registerAnyway")}
                </SubmitButton>
              </div>
            </div>
          )}

          <SubmitButton data-testid="open-visit" disabled={!readyToOpen} onClick={(k) => openVisit(false, k)}>
            {t("counter.openVisit")}
          </SubmitButton>
        </section>
      )}

      {phase !== "find" && opened !== null && (
        <section className="space-y-3" data-testid="band-settle">
          <p className="text-sm">
            <Badge data-testid="token">{t("counter.token", { n: opened.tokenNo })}</Badge>{" "}
            <span data-testid="visit-no">{opened.encounter.visitNo}</span>
            {opened.registered && <span data-testid="registered-badge"> · {t("counter.registered")}</span>}
          </p>

          {quote?.free === true && (
            <p data-testid="exit-free" className="text-sm font-medium text-emerald-700">{t("counter.exitFree")}</p>
          )}

          {quote?.free === false && issued === null && quote.draft !== null && (
            <div className="space-y-2" data-testid="collect">
              <p className="text-sm">{t("counter.payable", { amount: quote.draft.totals.netPayablePaise / 100 })}</p>
              <TenderEditor payablePaise={quote.draft.totals.netPayablePaise} onChange={setTenders} />
              <SubmitButton data-testid="settle" onClick={settle}>{t("counter.settle")}</SubmitButton>
            </div>
          )}

          {issued !== null && (
            <p
              data-testid={issued.creditExtended ? "exit-credit" : "exit-settled"}
              className="text-sm font-medium text-emerald-700"
            >
              {issued.creditExtended ? t("counter.exitCredit") : t("counter.exitSettled")}
            </p>
          )}

          {exit !== null && (
            <div className="space-y-2" data-testid="handoff">
              <p className="no-print text-sm">{t("counter.sendToVitals")}</p>
              {/*
                PLAN 07b T9 — ONE document, not two. `.print-doc` is positioned `fixed` at the
                origin, so a token slip and an invoice mounted as siblings would overprint each
                other rather than making two pages. The token and the fee are sections of one node.
              */}
              {qr !== null && (
                <CounterSlip
                  tokenNo={opened.tokenNo}
                  visitNo={opened.encounter.visitNo}
                  serviceDate={today}
                  doctorName={doctors.find((d) => d.doctor.id === doctorId)?.doctor.displayName ?? ""}
                  departmentName={departmentItems.find((d) => d.id === departmentId)?.name ?? ""}
                  roomCode={doctors.find((d) => d.doctor.id === doctorId)?.roomCode ?? null}
                  patient={{ uhid: qr.uhid, name: qr.name }}
                  qrPayload={qr.payload}
                  fee={issued === null ? null : {
                    invoiceNo: issued.invoiceNo,
                    paidPaise: issued.allocatedPaise,
                    creditExtended: issued.creditExtended,
                  }}
                />
              )}
              <div className="no-print flex gap-2">
                <Button onClick={() => { window.print(); }}>{t("counter.print")}</Button>
                <Button variant="outline" data-testid="next-patient" onClick={reset}>{t("counter.nextPatient")}</Button>
              </div>
            </div>
          )}
        </section>
      )}

      {inHand !== null && phase === "find" && (
        <p className="text-xs text-neutral-500" data-testid="in-hand-hint">{t("counter.inHandHint")}</p>
      )}
    </div>
  );
}
