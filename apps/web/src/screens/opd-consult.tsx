import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { opdErrorMessage, todayIst } from "../lib/opd-api";
import type {
  WireDoctor, WireEncounter, WireOpdConfig, WirePatientSummary, WirePrescription, WireQueueEntry,
  WireQueueEntryView, WireQueueView, WireRxPrint, WireTimelineItem, WireVitals,
} from "../lib/opd-api";
import { useRealtime } from "../lib/realtime";
import { RxPrint } from "../components/rx-print";
import { CheckboxField, FormKit, SelectField, TextField } from "../components/form-kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The consultation screen (D5 / Task 15) — the doctor's flagship: the live queue with call / skip /
 * start and the session status control, the patient panel, the autosaving note, the prescription
 * editor with the allergy-conflict override dialog, completion with the follow-up window, and the
 * printed e-Rx on the hospital letterhead.
 *
 * Four standing rules shape this file:
 *  · NO EXACT SUCCESS STATUS IS EVER BRANCHED ON. Every OPD POST here rides Nest's default 201
 *    (measured: twenty of the twenty-one OPD POSTs do — only /opd/prescriptions/verify is 200), so
 *    "success" means `api()` did not throw and nothing else. The plan's Task 15 text saying
 *    consult/complete returns 200 is superseded by its own erratum E5.
 *  · A 404 FROM `GET /opd/me/doctor` IS A DOMAIN ANSWER — "you are not a doctor" (erratum E3), not a
 *    transport failure: the screen renders an explanatory state, never retries and never crashes.
 *    The same holds for a 404 from `GET /patients/:id` (a hidden confidential record, §14 / D-37).
 *  · THE SERVER IS AUTHORITATIVE and the UI holds NO permission model: every action is rendered, and
 *    a refusal (403, 409 `call_conflict`, 409 `extension_cap_reached`, 409 `allergy_conflict`) is
 *    rendered inline where the doctor reads it, with the form state left exactly as it was.
 *  · Reads are BOTH polled (15 s) AND realtime-subscribed (D6): a push is a hint, so a missed frame
 *    costs seconds, never correctness.
 *
 * ONE `.print-doc` AT A TIME: `RxPrint` has exactly ONE render site in this file, guarded by the
 * single nullable `rxPrint` state, so two printable documents cannot be mounted together (the desk's
 * token slip lives on another screen, and there in a replaced view).
 */
const POLL_MS = 15_000;

const ROUTE_OPTIONS = ["oral", "iv", "im", "sc", "topical", "inhaled", "other"] as const;
const FREQUENCY_OPTIONS = ["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT", "other"] as const;

type VisitDetail = {
  encounter: WireEncounter;
  queueEntries: WireQueueEntry[];
  vitals: WireVitals[];
  prescriptions: WirePrescription[];
  patient: WirePatientSummary | null;
};
type PatientDetailRow = { uhid: string; name: string | null; alias: string | null; dob: string | null; sex: string };
type AllergyRow = { id: string; substance: string; severity: "mild" | "moderate" | "severe" | null; status: string };
type AllergyMatch = { lineIndex: number; substance: string };
type AllergyOverride = AllergyMatch & { reason: string };
type Active = { encounterId: string; patientId: string; summary: WirePatientSummary | null };
type SessionStatusInput = "in" | "out" | "closed";

/** Same UTC whole-years calculation as modules/opd/time.ts's ageYearsAt — a mirror, not the authority. */
function ageYearsAt(dobIso: string, at: Date): number {
  const dob = new Date(dobIso);
  const years = at.getUTCFullYear() - dob.getUTCFullYear();
  const notYet =
    at.getUTCMonth() < dob.getUTCMonth() || (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  return notYet ? years - 1 : years;
}

function patientLabel(p: { name: string | null; alias: string | null; restricted: boolean } | null | undefined): string {
  if (!p) return "—";
  return p.restricted ? (p.alias ?? "—") : (p.name ?? "—");
}

function orNull(s: string): string | null {
  return s.trim() === "" ? null : s.trim();
}

function ErrorLine({ message }: { message: string | null }): React.ReactElement | null {
  if (message === null) return null;
  return <p role="alert" className="text-sm text-red-600">{message}</p>;
}

/**
 * §3.19 — `register()` hands back a STRING for every control, so the coercion lives HERE, at the
 * resolver, and the body that reaches the wire already carries a number. Written as
 * `.transform().pipe()` rather than `z.preprocess` for the reason opd-admin.tsx and opd-vitals.tsx
 * both document (K41): `z.preprocess`'s `z.input` collapses to `unknown`, which does not typecheck
 * against `useForm`'s field-value shape, while this keeps `z.input` the honest string the DOM holds.
 */
const durationDaysField = z
  .string()
  .transform((v) => (v.trim() === "" ? null : Number(v)))
  .pipe(z.number().int().positive().nullable());

const rxSchema = z.object({
  lines: z
    .array(
      z.object({
        drug: z.string().min(1),
        dose: z.string().min(1),
        route: z.string().min(1),
        frequency: z.string().min(1),
        durationDays: durationDaysField,
        instructions: z.string(),
        noSubstitution: z.boolean(),
      }),
    )
    .min(1),
});
type RxFormInput = z.input<typeof rxSchema>;
type RxFormValues = z.output<typeof rxSchema>;
type RxLineValues = RxFormValues["lines"][number];

const EMPTY_LINE: RxFormInput["lines"][number] = {
  drug: "", dose: "", route: "oral", frequency: "OD", durationDays: "", instructions: "", noSubstitution: false,
};

type NoteState = { chiefComplaint: string; diagnosis: string; icd10Code: string; advice: string };
const EMPTY_NOTE: NoteState = { chiefComplaint: "", diagnosis: "", icd10Code: "", advice: "" };

function noteBodyOf(n: NoteState): Record<string, string | null> {
  return {
    chiefComplaint: orNull(n.chiefComplaint),
    diagnosis: orNull(n.diagnosis),
    icd10Code: orNull(n.icd10Code),
    advice: orNull(n.advice),
  };
}

export function OpdConsult(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const today = todayIst();

  const [active, setActive] = useState<Active | null>(null);
  const [tab, setTab] = useState("note");
  const [note, setNote] = useState<NoteState>(EMPTY_NOTE);
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [rxError, setRxError] = useState<string | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [matches, setMatches] = useState<AllergyMatch[] | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [rxPrint, setRxPrint] = useState<WireRxPrint | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [testsOrdered, setTestsOrdered] = useState(false);
  const [admissionAdvised, setAdmissionAdvised] = useState(false);
  const [referralTo, setReferralTo] = useState("");
  const [referralNote, setReferralNote] = useState("");

  const lastSavedNote = useRef<string>(JSON.stringify(noteBodyOf(EMPTY_NOTE)));
  /** The PARSED lines of a refused submission — never `getValues()`, whose durationDays is a string (§3.19). */
  const pendingLines = useRef<RxLineValues[]>([]);
  const loadedNoteFor = useRef<string | null>(null);

  // ——— boot: am I a doctor, and what is my queue today? ———

  const me = useQuery({
    queryKey: ["opd", "me", "doctor"],
    queryFn: () => api<WireDoctor>("GET", "/opd/me/doctor"),
    retry: false,
  });
  // erratum E3: 404 here is the ANSWER "this user has no doctor profile", not a transport error.
  const notADoctor = me.isError && me.error instanceof ApiError && me.error.status === 404;
  const doctorId = me.data?.id ?? "";

  const config = useQuery({ queryKey: ["opd", "config"], queryFn: () => api<WireOpdConfig>("GET", "/opd/config") });
  const queue = useQuery({
    queryKey: ["opd", "queue", doctorId, today],
    queryFn: () => api<WireQueueView | { session: null }>(
      "GET", `/opd/queues?doctorId=${doctorId}&serviceDate=${today}`,
    ),
    enabled: doctorId !== "",
    refetchInterval: POLL_MS,
  });

  const view: WireQueueView | null = queue.data !== undefined && queue.data.session !== null ? queue.data : null;
  const current = view?.current ?? null;
  const ordered = view?.ordered ?? [];

  // D6: a frame on my queue topic (or on the open encounter) is a HINT to re-read.
  const topics = doctorId === ""
    ? []
    : [`queue:${doctorId}:${today}`, ...(active === null ? [] : [`encounter:${active.encounterId}`])];
  useRealtime(topics, () => {
    void queryClient.invalidateQueries({ queryKey: ["opd", "queue"] });
    void queryClient.invalidateQueries({ queryKey: ["opd", "visit"] });
  });

  // ——— the patient panel ———

  const visit = useQuery({
    queryKey: ["opd", "visit", active?.encounterId ?? ""],
    queryFn: () => api<VisitDetail>("GET", `/opd/visits/${active?.encounterId ?? ""}`),
    enabled: active !== null,
    refetchInterval: POLL_MS,
  });
  const patientId = active?.patientId ?? null;
  const patient = useQuery({
    queryKey: ["patient", patientId ?? ""],
    queryFn: () => api<{ patient: PatientDetailRow }>("GET", `/patients/${patientId ?? ""}`),
    enabled: patientId !== null,
    retry: false,
  });
  // §14 / D-37: a hidden confidential record answers 404 — restricted mode, never a crash.
  const restricted = patient.isError && patient.error instanceof ApiError && patient.error.status === 404;
  const allergies = useQuery({
    queryKey: ["patient-allergies", patientId ?? ""],
    queryFn: () => api<{ items: AllergyRow[] }>("GET", `/patients/${patientId ?? ""}/allergies`),
    enabled: patientId !== null && !restricted,
  });
  const timeline = useQuery({
    queryKey: ["opd", "timeline", patientId ?? ""],
    queryFn: () => api<{ items: WireTimelineItem[] }>("GET", `/opd/patients/${patientId ?? ""}/timeline`),
    enabled: patientId !== null,
  });

  const encounter = visit.data?.encounter ?? null;
  const vitalsRows = visit.data?.vitals ?? [];
  const latestVitals: WireVitals | null = vitalsRows.length === 0 ? null : vitalsRows[vitalsRows.length - 1]!;
  const activeAllergies = (allergies.data?.items ?? []).filter((a) => a.status === "active");
  const dob = patient.data?.patient.dob ?? null;
  const ageYears = dob !== null ? ageYearsAt(dob, new Date()) : null;
  const timelineItems = timeline.data?.items ?? [];

  // The note mirrors the encounter the server already holds; the visit query is its source of truth.
  useEffect(() => {
    if (encounter === null || loadedNoteFor.current === encounter.id) return;
    loadedNoteFor.current = encounter.id;
    const next: NoteState = {
      chiefComplaint: encounter.chiefComplaint ?? "",
      diagnosis: encounter.diagnosis ?? "",
      icd10Code: encounter.icd10Code ?? "",
      advice: encounter.advice ?? "",
    };
    setNote(next);
    lastSavedNote.current = JSON.stringify(noteBodyOf(next));
  }, [encounter]);

  const rxForm = useForm<RxFormInput, unknown, RxFormValues>({
    resolver: zodResolver(rxSchema),
    defaultValues: { lines: [EMPTY_LINE] },
  });
  const lines = useFieldArray({ control: rxForm.control, name: "lines" });

  const resetPanel = (): void => {
    loadedNoteFor.current = null;
    lastSavedNote.current = JSON.stringify(noteBodyOf(EMPTY_NOTE));
    setNote(EMPTY_NOTE);
    setNoteSaved(false);
    setNoteError(null);
    setRxError(null);
    setCompleteError(null);
    setMatches(null);
    setReasons([]);
    setOverrideError(null);
    setFollowUp("");
    setTestsOrdered(false);
    setAdmissionAdvised(false);
    setReferralTo("");
    setReferralNote("");
    setTab("note");
    rxForm.reset({ lines: [EMPTY_LINE] });
  };

  // ——— the queue actions ———

  const invalidateQueue = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["opd", "queue"] });
  };

  const callNext = async (): Promise<void> => {
    if (view === null) return;
    setQueueError(null);
    try {
      await api("POST", `/opd/queues/${view.session.id}/call-next`);
      await invalidateQueue();
    } catch (e) {
      setQueueError(opdErrorMessage(e));
    }
  };

  const skipCurrent = async (): Promise<void> => {
    if (current === null) return;
    setQueueError(null);
    try {
      await api("POST", `/opd/queues/entries/${current.id}/skip`);
      await invalidateQueue();
    } catch (e) {
      setQueueError(opdErrorMessage(e));
    }
  };

  const startConsult = async (): Promise<void> => {
    if (current === null) return;
    setQueueError(null);
    try {
      const res = await api<{ encounter: WireEncounter }>("POST", `/opd/visits/${current.encounter.id}/consult/start`);
      resetPanel();
      setActive({ encounterId: res.encounter.id, patientId: res.encounter.patientId, summary: current.patient });
      await invalidateQueue();
    } catch (e) {
      setQueueError(opdErrorMessage(e));
    }
  };

  const setSessionStatus = async (status: SessionStatusInput): Promise<void> => {
    if (view === null) return;
    setQueueError(null);
    try {
      await api("POST", `/opd/queues/${view.session.id}/status`, { status });
      await invalidateQueue();
    } catch (e) {
      setQueueError(opdErrorMessage(e));
    }
  };

  // ——— the note: autosaved on blur, and only when it actually changed ———

  const saveNote = async (): Promise<void> => {
    if (active === null) return;
    const body = noteBodyOf(note);
    const key = JSON.stringify(body);
    if (key === lastSavedNote.current) return;
    setNoteError(null);
    try {
      await api("PUT", `/opd/visits/${active.encounterId}/consult/note`, body);
      lastSavedNote.current = key;
      setNoteSaved(true);
    } catch (e) {
      setNoteError(opdErrorMessage(e));
    }
  };

  // ——— the e-Rx ———

  const postRx = async (rxLines: RxLineValues[], overrides?: AllergyOverride[]): Promise<void> => {
    if (active === null) return;
    setRxError(null);
    const body: Record<string, unknown> = {
      lines: rxLines.map((l) => ({
        drug: l.drug.trim(),
        dose: l.dose.trim(),
        route: l.route,
        frequency: l.frequency,
        durationDays: l.durationDays,
        instructions: orNull(l.instructions),
        noSubstitution: l.noSubstitution,
      })),
    };
    if (overrides !== undefined) body.overrides = overrides;
    try {
      const issued = await api<{ prescriptionId: string; version: number }>(
        "POST", `/opd/visits/${active.encounterId}/prescriptions`, body,
      );
      setMatches(null);
      setReasons([]);
      setOverrideError(null);
      const print = await api<WireRxPrint>("GET", `/opd/prescriptions/${issued.prescriptionId}/print`);
      setRxPrint(print);
      await queryClient.invalidateQueries({ queryKey: ["opd", "visit"] });
    } catch (e) {
      if (e instanceof ApiError) {
        const errBody = e.body as { code?: string; detail?: { matches?: AllergyMatch[] } } | null;
        // The allergy hard-warning is a DOMAIN answer carrying the matched lines, not a failure.
        if (errBody?.code === "allergy_conflict" && Array.isArray(errBody.detail?.matches)) {
          setMatches(errBody.detail.matches);
          setReasons(errBody.detail.matches.map(() => ""));
          setOverrideError(null);
          return;
        }
        if (errBody?.code === "override_reason_required") {
          setOverrideError(opdErrorMessage(e));
          return;
        }
      }
      setRxError(opdErrorMessage(e));
    }
  };

  const submitRx = rxForm.handleSubmit(async (values) => {
    pendingLines.current = values.lines;
    await postRx(values.lines);
  });

  /** K48: the re-post carries `overrides` — one reason per matched line, mirroring the server's rule. */
  const confirmOverride = async (): Promise<void> => {
    if (matches === null) return;
    if (reasons.some((r) => r.trim().length < 3)) {
      setOverrideError(t("opdConsult.overrideReasonRequired"));
      return;
    }
    const overrides: AllergyOverride[] = matches.map((m, i) => ({
      lineIndex: m.lineIndex, substance: m.substance, reason: (reasons[i] ?? "").trim(),
    }));
    await postRx(pendingLines.current, overrides);
  };

  // ——— completion ———

  const complete = async (): Promise<void> => {
    if (active === null) return;
    setCompleteError(null);
    const body: Record<string, unknown> = {
      note: {
        ...noteBodyOf(note),
        admissionAdvised,
        referralTo: orNull(referralTo),
        referralNote: orNull(referralNote),
      },
      testsOrderedReturnToday: testsOrdered,
    };
    /**
     * K49 — the DEFAULT follow-up is OMITTED so the server's own `followUpDefaultDays` applies. The
     * key must be ABSENT from the body, not merely equal to 7: sending it explicitly would make this
     * screen the authority on a value the OPD config owns, and would silently disagree the day the
     * owner changes it. A chosen extension travels as a NUMBER (§3.19 — the select hands a string).
     */
    if (followUp !== "") body.followUpDays = Number(followUp);
    try {
      await api("POST", `/opd/visits/${active.encounterId}/consult/complete`, body);
      setActive(null);
      resetPanel();
      await invalidateQueue();
    } catch (e) {
      setCompleteError(opdErrorMessage(e));
    }
  };

  // ——— this screen's OWN shortcuts; lib/keyboard.tsx owns the global ones and is NOT touched ———

  const actions = useRef({ callNext, skipCurrent, startConsult, submitRx, complete, hasActive: active !== null });
  actions.current = { callNext, skipCurrent, startConsult, submitRx, complete, hasActive: active !== null };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey) return;
      const a = actions.current;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        void a.callNext();
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        void a.skipCurrent();
      } else if (e.key === "s" || e.key === "S") {
        // Inside a FormKit form Alt+S is already that form's own submit — never fire it twice.
        if (e.target instanceof HTMLElement && e.target.closest("form") !== null) return;
        e.preventDefault();
        void (a.hasActive ? a.submitRx() : a.startConsult());
      } else if (e.key === "Enter") {
        e.preventDefault();
        void a.complete();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // erratum E3 — the explanatory state: not a crash, not a retry, not a generic error page.
  if (notADoctor) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-xl font-semibold">{t("opdConsult.title")}</h1>
        <p data-testid="not-a-doctor" role="status" className="text-sm text-amber-700">
          {t("opdConsult.notADoctor")}
        </p>
      </div>
    );
  }

  const queueRow = (e: WireQueueEntryView, isCurrent: boolean): React.ReactElement => (
    <li
      key={e.id}
      data-testid={`queue-row-${e.id}`}
      aria-current={isCurrent ? "true" : undefined}
      className={`flex flex-wrap items-center gap-2 rounded border p-2 text-sm ${isCurrent ? "border-blue-500 bg-blue-50" : ""}`}
    >
      <span data-testid={`queue-position-${e.id}`} className="text-xs text-neutral-500">
        {e.position === null ? "—" : t("opdConsult.position", { n: e.position })}
      </span>
      <span data-testid={`queue-token-${e.id}`} className="text-lg font-semibold tabular-nums">{e.tokenNo}</span>
      <span>{patientLabel(e.patient)}</span>
      {e.queueClass !== null && <Badge variant="secondary">{t(`opd.queueClass.${e.queueClass}`)}</Badge>}
      {(e.danger || e.encounter.dangerFlagged) && (
        <span data-testid={`queue-danger-${e.id}`} aria-label={t("opdConsult.danger")} className="text-red-600">⚠</span>
      )}
      {e.reEntry && <Badge variant="outline" data-testid={`queue-reentry-${e.id}`}>{t("opdConsult.reEntry")}</Badge>}
    </li>
  );

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("opdConsult.title")}</h1>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* (a) the live queue and the session controls */}
        <aside className="space-y-3">
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="session-status">{t("opdConsult.sessionStatus")}</label>
            <select
              id="session-status"
              value={view?.session.status ?? "not_started"}
              disabled={view === null}
              onChange={(e) => void setSessionStatus(e.target.value as SessionStatusInput)}
              className="w-full rounded border px-2 py-1"
            >
              <option value="not_started" disabled>{t("opd.sessionStatus.not_started")}</option>
              <option value="in">{t("opd.sessionStatus.in")}</option>
              <option value="out">{t("opd.sessionStatus.out")}</option>
              <option value="closed">{t("opd.sessionStatus.closed")}</option>
            </select>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void callNext()}>{t("opdConsult.callNext")}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void skipCurrent()}>{t("opdConsult.skip")}</Button>
            <Button type="button" size="sm" onClick={() => void startConsult()}>{t("opdConsult.start")}</Button>
          </div>
          <ErrorLine message={queueError} />

          <h2 className="pt-2 text-sm font-semibold">{t("opdConsult.queue")}</h2>
          {view === null && queue.data !== undefined && (
            <p className="text-sm text-neutral-500">{t("opdConsult.noSession")}</p>
          )}
          {view !== null && current === null && ordered.length === 0 && (
            <p className="text-sm text-neutral-500">{t("opdConsult.emptyQueue")}</p>
          )}
          <ul data-testid="consult-queue" className="space-y-2">
            {current !== null && queueRow(current, true)}
            {ordered.map((e) => queueRow(e, false))}
          </ul>
        </aside>

        {/* (b) the patient panel */}
        <main className="space-y-4 lg:col-span-2">
          {active === null && <p className="text-sm text-neutral-500">{t("opdConsult.pickPatientHint")}</p>}

          {active !== null && (
            <div data-testid="patient-panel" className="space-y-4">
              <header className="space-y-1 rounded border p-3">
                {restricted ? (
                  <>
                    <p data-testid="restricted-banner" className="text-sm text-amber-700">{t("opdConsult.restricted")}</p>
                    <p data-testid="panel-uhid" className="font-mono text-xs text-neutral-600">{active.summary?.uhid ?? "—"}</p>
                  </>
                ) : (
                  <>
                    <h2 data-testid="panel-patient-name" className="text-lg font-semibold">
                      {patient.data?.patient.name ?? patient.data?.patient.alias ?? patientLabel(active.summary)}
                    </h2>
                    <p data-testid="panel-uhid" className="font-mono text-xs text-neutral-600">
                      {patient.data?.patient.uhid ?? active.summary?.uhid ?? "—"}
                    </p>
                    <p data-testid="panel-patient-age" className="text-sm text-neutral-600">
                      {t("opdConsult.age", { age: ageYears ?? "—" })} · {patient.data?.patient.sex ?? "—"}
                    </p>
                  </>
                )}
                {encounter !== null && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" data-testid="panel-visit-type">{t(`opd.visitType.${encounter.visitType}`)}</Badge>
                    {encounter.dangerFlagged && (
                      <span data-testid="panel-danger" className="text-sm text-red-700">{t("opdConsult.danger")}</span>
                    )}
                  </div>
                )}

                {!restricted && (
                  <div className="pt-2">
                    <h3 className="text-sm font-semibold">{t("opdConsult.allergies")}</h3>
                    <div data-testid="allergy-chips" className="flex flex-wrap gap-1">
                      {activeAllergies.length === 0 && (
                        <span className="text-sm text-neutral-500">{t("opdConsult.noAllergies")}</span>
                      )}
                      {activeAllergies.map((a) => (
                        <span
                          key={a.id}
                          data-testid={`allergy-chip-${a.id}`}
                          className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800"
                        >
                          {a.substance}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-2">
                  <h3 className="text-sm font-semibold">{t("opdConsult.vitals")}</h3>
                  {latestVitals === null && <p className="text-sm text-neutral-500">{t("opdConsult.noVitals")}</p>}
                  {latestVitals !== null && (
                    <>
                      <p data-testid="panel-vitals" className="text-sm">
                        BP {latestVitals.sbp ?? "—"}/{latestVitals.dbp ?? "—"} · P {latestVitals.pulse ?? "—"} · SpO₂ {latestVitals.spo2 ?? "—"}%
                      </p>
                      {latestVitals.dangerFlags.map((f) => (
                        <p
                          key={f.vital}
                          role="alert"
                          data-testid={`vitals-danger-${f.vital}`}
                          className="rounded bg-red-50 px-2 py-1 text-sm text-red-700"
                        >
                          {f.vital} {f.value} ({f.bound} {f.limit})
                        </p>
                      ))}
                    </>
                  )}
                </div>
              </header>

              <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                  <TabsTrigger value="note">{t("opdConsult.tabs.note")}</TabsTrigger>
                  <TabsTrigger value="rx">{t("opdConsult.tabs.rx")}</TabsTrigger>
                  <TabsTrigger value="history">{t("opdConsult.tabs.history")}</TabsTrigger>
                </TabsList>

                {/* the note autosaves on blur — focusout bubbles, so one handler covers every field */}
                <TabsContent value="note">
                  <div className="space-y-2" onBlur={() => void saveNote()}>
                    <label className="block text-sm font-medium" htmlFor="note-chief">{t("opdConsult.chiefComplaint")}</label>
                    <textarea
                      id="note-chief"
                      value={note.chiefComplaint}
                      onChange={(e) => setNote((n) => ({ ...n, chiefComplaint: e.target.value }))}
                      className="w-full rounded border px-2 py-1"
                    />
                    <label className="block text-sm font-medium" htmlFor="note-diagnosis">{t("opdConsult.diagnosis")}</label>
                    <textarea
                      id="note-diagnosis"
                      value={note.diagnosis}
                      onChange={(e) => setNote((n) => ({ ...n, diagnosis: e.target.value }))}
                      className="w-full rounded border px-2 py-1"
                    />
                    <label className="block text-sm font-medium" htmlFor="note-icd10">{t("opdConsult.icd10Code")}</label>
                    <input
                      id="note-icd10"
                      value={note.icd10Code}
                      onChange={(e) => setNote((n) => ({ ...n, icd10Code: e.target.value }))}
                      className="w-full rounded border px-2 py-1"
                    />
                    <label className="block text-sm font-medium" htmlFor="note-advice">{t("opdConsult.advice")}</label>
                    <textarea
                      id="note-advice"
                      value={note.advice}
                      onChange={(e) => setNote((n) => ({ ...n, advice: e.target.value }))}
                      className="w-full rounded border px-2 py-1"
                    />
                    {noteSaved && <p data-testid="note-saved" className="text-sm text-emerald-700">{t("opdConsult.noteSaved")}</p>}
                    <ErrorLine message={noteError} />
                  </div>
                </TabsContent>

                <TabsContent value="rx">
                  <FormProvider {...rxForm}>
                    <FormKit onSubmit={submitRx}>
                      {lines.fields.map((f, i) => (
                        <div key={f.id} data-testid={`rx-row-${String(i)}`} className="grid gap-2 md:grid-cols-3">
                          <TextField name={`lines.${String(i)}.drug`} label={t("opdConsult.drug")} />
                          <TextField name={`lines.${String(i)}.dose`} label={t("opdConsult.dose")} />
                          <SelectField
                            name={`lines.${String(i)}.route`}
                            label={t("opdConsult.route")}
                            options={ROUTE_OPTIONS.map((r) => ({ value: r, label: t(`opdConsult.routeOption.${r}`) }))}
                          />
                          <SelectField
                            name={`lines.${String(i)}.frequency`}
                            label={t("opdConsult.frequency")}
                            options={FREQUENCY_OPTIONS.map((r) => ({ value: r, label: t(`opdConsult.frequencyOption.${r}`) }))}
                          />
                          <TextField name={`lines.${String(i)}.durationDays`} label={t("opdConsult.durationDays")} type="number" />
                          <TextField name={`lines.${String(i)}.instructions`} label={t("opdConsult.instructions")} />
                          <CheckboxField name={`lines.${String(i)}.noSubstitution`} label={t("opdConsult.noSubstitution")} />
                          {lines.fields.length > 1 && (
                            <Button type="button" size="sm" variant="outline" onClick={() => lines.remove(i)}>
                              {t("opdConsult.removeLine")}
                            </Button>
                          )}
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => lines.append(EMPTY_LINE)}>
                          {t("opdConsult.addLine")}
                        </Button>
                        <Button type="submit">{t("opdConsult.issue")}</Button>
                      </div>
                    </FormKit>
                  </FormProvider>
                  <ErrorLine message={rxError} />
                </TabsContent>

                <TabsContent value="history">
                  <ul data-testid="timeline" className="space-y-1 text-sm">
                    {timelineItems.length === 0 && <li className="text-neutral-500">{t("opdConsult.noHistory")}</li>}
                    {timelineItems.map((item) => (
                      <li key={item.encounterId} data-testid={`timeline-row-${item.encounterId}`}>
                        {item.serviceDate} · {item.departmentName ?? "—"} · {item.doctorName ?? "—"} · {item.diagnosis ?? "—"}
                      </li>
                    ))}
                  </ul>
                </TabsContent>
              </Tabs>

              {/* (c) completion */}
              <div className="space-y-2 rounded border p-3">
                <label className="block text-sm font-medium" htmlFor="follow-up">{t("opdConsult.followUp")}</label>
                <select
                  id="follow-up"
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                  className="w-full rounded border px-2 py-1"
                >
                  <option value="">{t("opdConsult.followUpDefault", { days: config.data?.followUpDefaultDays ?? "—" })}</option>
                  {(config.data?.followUpExtensionDays ?? []).map((d) => (
                    <option key={d} value={String(d)}>{t("opdConsult.extension", { days: d })}</option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={testsOrdered} onChange={(e) => setTestsOrdered(e.target.checked)} />
                  {t("opdConsult.testsOrdered")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={admissionAdvised} onChange={(e) => setAdmissionAdvised(e.target.checked)} />
                  {t("opdConsult.admissionAdvised")}
                </label>
                <label className="block text-sm font-medium" htmlFor="referral-to">{t("opdConsult.referralTo")}</label>
                <input
                  id="referral-to"
                  value={referralTo}
                  onChange={(e) => setReferralTo(e.target.value)}
                  className="w-full rounded border px-2 py-1"
                />
                <label className="block text-sm font-medium" htmlFor="referral-note">{t("opdConsult.referralNote")}</label>
                <input
                  id="referral-note"
                  value={referralNote}
                  onChange={(e) => setReferralNote(e.target.value)}
                  className="w-full rounded border px-2 py-1"
                />
                <Button type="button" onClick={() => void complete()}>{t("opdConsult.complete")}</Button>
                <ErrorLine message={completeError} />
              </div>
            </div>
          )}
        </main>
      </div>

      <footer className="no-print border-t pt-2 text-xs text-neutral-500">{t("opdConsult.shortcuts")}</footer>

      {/* the allergy hard-warning: a reason per matched line, then the re-post carries them (K48) */}
      <Dialog
        open={matches !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMatches(null);
            setReasons([]);
            setOverrideError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader><DialogTitle>{t("opdConsult.overrideTitle")}</DialogTitle></DialogHeader>
          <p className="text-sm">{t("opdConsult.overrideHint")}</p>
          {(matches ?? []).map((m, i) => (
            <div key={`${String(m.lineIndex)}-${m.substance}`} className="space-y-1">
              <label className="block text-sm font-medium" htmlFor={`override-reason-${String(i)}`}>
                {t("opdConsult.overrideMatch", { n: m.lineIndex + 1, substance: m.substance })}
              </label>
              <input
                id={`override-reason-${String(i)}`}
                value={reasons[i] ?? ""}
                onChange={(e) => setReasons((rs) => rs.map((r, j) => (j === i ? e.target.value : r)))}
                className="w-full rounded border px-2 py-1"
              />
            </div>
          ))}
          <ErrorLine message={overrideError} />
          <Button type="button" onClick={() => void confirmOverride()}>{t("opdConsult.overrideConfirm")}</Button>
        </DialogContent>
      </Dialog>

      {/* THE ONLY `.print-doc` RENDER SITE ON THIS SCREEN — one nullable state, one mount. */}
      <Dialog open={rxPrint !== null} onOpenChange={(open) => { if (!open) setRxPrint(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("opdConsult.tabs.rx")}</DialogTitle></DialogHeader>
          {rxPrint !== null && <RxPrint data={rxPrint} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
