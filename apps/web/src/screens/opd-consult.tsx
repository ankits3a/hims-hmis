import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { isInteractionHit, opdErrorMessage, todayIst } from "../lib/opd-api";
import type {
  WireDoctor, WireEncounter, WireOpdConfig, WirePatientSummary, WirePrescription, WireQueueEntry,
  WireQueueEntryView, WireQueueView, WireRxPrint, WireTimelineItem, WireVitals,
  WireDuplicateHit, WireInteractionHit, WireRxNotice,
  WireRxHistoryItem, WireVitalsHistoryItem,
  WireAdvisedTest, WirePriceListRow,
} from "../lib/opd-api";
import { Link } from "@tanstack/react-router";
import { fmtIst, fmtPaise } from "../lib/format";
import { useRealtime } from "../lib/realtime";
import { RxPrint } from "../components/rx-print";
import { flagTone, provisionalResultsForEncounter, resultsForEncounter } from "../lib/lab-api";
import { CheckboxField, FormKit, SelectField, TextField } from "../components/form-kit";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
import { DeskModal } from "../components/desk-modal";
import { ConsultScribe } from "../components/consult-scribe";
import { TabStrip } from "../components/desk-fields";

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
type PatientDetailRow = { uhid: string; name: string | null; alias: string | null; dob: string | null; administrativeGender: string };
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
  return <p role="alert" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{message}</p>;
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
        /**
         * PLAN 16a T6 / DD9 — set by the formulary picker, cleared the moment the doctor types.
         * NULLABLE AND NEVER REQUIRED: design law 1 says a free-text line is a legal prescription
         * for ever, and the screen must not be the place that quietly stops being true.
         */
        medicineId: z.string().nullable(),
      }),
    )
    .min(1),
});
type RxFormInput = z.input<typeof rxSchema>;
type RxFormValues = z.output<typeof rxSchema>;
type RxLineValues = RxFormValues["lines"][number];

const EMPTY_LINE: RxFormInput["lines"][number] = {
  drug: "", dose: "", route: "oral", frequency: "OD", durationDays: "", instructions: "",
  noSubstitution: false, medicineId: null,
};

// ─────────────────────────── PLAN 16a T6 — the check-suite wire shapes ───────────────────────────

type WirePrecheck = {
  allergyMatches: AllergyMatch[];
  interactions: WireInteractionHit[];
  duplicates: WireDuplicateHit[];
  notices: WireRxNotice[];
  unresolvedLineIndexes: number[];
};
type WireMedicine = {
  id: string; brandName: string; routeClass: string;
  salts: { saltId: string; strength: string | null }[];
};
type WireCoverage = { coverage: number; noticeEnabled: boolean };



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
  /** PLAN 07d T1 — which of the three histories the tab is showing. Drives the lazy fetches below. */
  const [historyView, setHistoryView] = useState<"visits" | "rx" | "vitals">("visits");
  /** PLAN 07d T5 — the tests the doctor has advised this consultation. Saved with the note. */
  const [advisedTests, setAdvisedTests] = useState<WireAdvisedTest[]>([]);
  const [testQuery, setTestQuery] = useState("");
  const today = todayIst();

  const [active, setActive] = useState<Active | null>(null);
  const [tab, setTab] = useState<"note" | "rx" | "history">("note");
  const [note, setNote] = useState<NoteState>(EMPTY_NOTE);
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [rxError, setRxError] = useState<string | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [matches, setMatches] = useState<AllergyMatch[] | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  /** PLAN 16a T6 — the two new hard-warning kinds, each with its own reason per hit (DD3). */
  const [interactionHits, setInteractionHits] = useState<WireInteractionHit[]>([]);
  const [duplicateHits, setDuplicateHits] = useState<WireDuplicateHit[]>([]);
  const [interactionReasons, setInteractionReasons] = useState<string[]>([]);
  const [duplicateReasons, setDuplicateReasons] = useState<string[]>([]);
  /** Soft hits. They never gate anything and the panel is dismissible. */
  const [notices, setNotices] = useState<WireRxNotice[]>([]);
  const [noticesDismissed, setNoticesDismissed] = useState(false);
  /** Line indexes the formulary could not resolve — the coverage-gated hint reads this (DD5). */
  const [unresolvedLines, setUnresolvedLines] = useState<number[]>([]);
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
  /**
   * PLAN 16a T6 — the formulary, for the picker. A doctor holds `formulary.read` (DD10); if this
   * ever answers 403 the picker is simply empty and free typing is unaffected, which is design
   * law 1 holding at the transport layer too.
   */
  const formulary = useQuery({
    queryKey: ["formulary", "medicines"],
    queryFn: () => api<{ items: WireMedicine[] }>("GET", "/formulary/medicines?active=true"),
    retry: false,
  });
  const medicines = formulary.data?.items ?? [];
  /**
   * DD5 — the client NEVER re-derives the threshold. It reads `noticeEnabled` and nothing else, and
   * a 404 (T8 not deployed yet) means OFF, which is also the correct long-term degrade: silence
   * beats a hint that fires on every line while the formulary is still being filled.
   */
  const coverage = useQuery({
    queryKey: ["formulary", "coverage"],
    queryFn: () => api<WireCoverage>("GET", "/formulary/coverage"),
    retry: false,
  });
  const noticeEnabled = coverage.data?.noticeEnabled ?? false;
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
  /**
   * PLAN 07d T1 — THE TWO READS THE DOCTOR DID NOT HAVE.
   *
   * Before this, the history tab was one line per past visit — date, department, doctor, diagnosis —
   * and there was **no way to read a prior prescription at all**. The only cross-encounter
   * prescription query in the tree was private to `runRxChecks`, used for interaction checking and
   * never shown to anybody. A doctor who wanted to know what this patient was last given could not
   * find out from this system.
   *
   * Both are fetched LAZILY — `enabled` on the tab being open — because they are the largest PHI
   * reads the application makes, each writes an access-log row, and firing them on every consult
   * screen render would fill the DPDP register with reads nobody performed. A read that was never
   * looked at should not be recorded as one.
   */
  const rxHistory = useQuery({
    queryKey: ["opd", "rx-history", patientId ?? ""],
    queryFn: () => api<{ items: WireRxHistoryItem[] }>("GET", `/opd/patients/${patientId ?? ""}/prescriptions`),
    enabled: patientId !== null && historyView === "rx",
  });
  const vitalsHistory = useQuery({
    queryKey: ["opd", "vitals-history", patientId ?? ""],
    queryFn: () => api<{ items: WireVitalsHistoryItem[] }>("GET", `/opd/patients/${patientId ?? ""}/vitals`),
    enabled: patientId !== null && historyView === "vitals",
  });

  /**
   * PLAN 07d T5 / DD4 + spike S2 — THE PRICED SERVICE CATALOGUE, FLAT AND SEARCHABLE.
   *
   * S2 asked whether `services.category` could group this list. Measured: it is free text with no
   * CHECK, and a fresh database holds TWO service rows, both OPD consultation. The spike's own
   * ruling for that answer is that T5 ships behind a category vocabulary this phase does NOT invent
   * — the vocabulary belongs to tariff. So this is a flat search over active services, and the
   * finding is routed rather than patched here.
   *
   * `tariff.read` is the grant DD6 makes for exactly this (README, Plan 07d T5).
   */
  const services = useQuery({
    queryKey: ["tariff", "price-list"],
    queryFn: () => api<{ items: WirePriceListRow[] }>("GET", "/tariff/price-list"),
    enabled: active !== null,
  });
  const serviceMatches = (services.data?.items ?? [])
    .filter((sv) => testQuery.trim().length >= 2
      && (sv.name.toLowerCase().includes(testQuery.trim().toLowerCase())
        || sv.code.toLowerCase().includes(testQuery.trim().toLowerCase())))
    .filter((sv) => !advisedTests.some((a) => a.serviceId === sv.serviceId))
    .slice(0, 8);

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
    /**
     * C7 (independent review) — SEVEN PIECES OF 16a STATE OUTLIVED THE PATIENT THEY BELONGED TO.
     *
     * `resetPanel` cleared the shipped allergy state and none of what T6 added. Two consequences,
     * and the second is the one that matters: patient A's soft-notice panel rendered under patient
     * B's empty prescription form; and because the override dialog's `open` is
     * `matches !== null || interactionHits.length > 0 || duplicateHits.length > 0`, nulling
     * `matches` alone left the dialog OPEN across the patient change — where `confirmOverride`
     * would post patient A's overrides with patient B's lines, clearing any of B's hits that
     * happened to land on the same line index.
     */
    setInteractionHits([]);
    setDuplicateHits([]);
    setInteractionReasons([]);
    setDuplicateReasons([]);
    setNotices([]);
    setNoticesDismissed(false);
    setUnresolvedLines([]);
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

  /**
   * PLAN 07d T5 — advised tests are saved through the CONSULT NOTE, not a route of their own. That
   * is what makes them free of new authority: `saveConsultNote` already requires the encounter's
   * own treating doctor and an `in_consultation` state, so nobody else can write them and they
   * cannot be attached to a finished visit.
   */
  const saveAdvised = async (next: WireAdvisedTest[]): Promise<void> => {
    setAdvisedTests(next);
    if (active === null) return;
    setNoteError(null);
    try {
      await api("PUT", `/opd/visits/${active.encounterId}/consult/note`, { ...noteBodyOf(note), advisedTests: next });
    } catch (e) {
      setNoteError(opdErrorMessage(e));
    }
  };

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

  const postRx = async (
    rxLines: RxLineValues[],
    overrides?: AllergyOverride[],
    interactionOverrides?: { lineIndex: number; reason: string; saltPair: [string, string] }[],
    duplicateOverrides?: { lineIndex: number; reason: string; moiety: string }[],
  ): Promise<void> => {
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
        medicineId: l.medicineId,
      })),
    };
    if (overrides !== undefined) body.overrides = overrides;
    if (interactionOverrides !== undefined) body.interactionOverrides = interactionOverrides;
    if (duplicateOverrides !== undefined) body.duplicateOverrides = duplicateOverrides;
    try {
      const issued = await api<{
        prescriptionId: string; version: number;
        notices?: WireRxNotice[];
      }>("POST", `/opd/visits/${active.encounterId}/prescriptions`, body);
      setMatches(null);
      setReasons([]);
      setInteractionHits([]);
      setDuplicateHits([]);
      setOverrideError(null);
      // Soft hits survive a successful issue: they are what the doctor should still know about.
      setNotices(issued.notices ?? []);
      setNoticesDismissed(false);
      const print = await api<WireRxPrint>("GET", `/opd/prescriptions/${issued.prescriptionId}/print`);
      setRxPrint(print);
      await queryClient.invalidateQueries({ queryKey: ["opd", "visit"] });
    } catch (e) {
      if (e instanceof ApiError) {
        const errBody = e.body as {
          code?: string;
          detail?: { matches?: AllergyMatch[]; hits?: WireRxNotice[] };
        } | null;
        // The allergy hard-warning is a DOMAIN answer carrying the matched lines, not a failure.
        if (errBody?.code === "allergy_conflict" && Array.isArray(errBody.detail?.matches)) {
          setMatches(errBody.detail.matches);
          setReasons(errBody.detail.matches.map(() => ""));
          setOverrideError(null);
          return;
        }
        /**
         * PLAN 16a T6 / DD3 — the two new hard warnings arrive in `allergy_conflict`'s exact shape,
         * so they open the same dialog. THE SERVER IS THE GATE: the pre-check below usually opens
         * this dialog first, and these branches are what happens when it did not — a formulary
         * corrected between the pre-check and the submit, or a client that skipped the pre-check.
         */
        if (errBody?.code === "interaction_conflict" && Array.isArray(errBody.detail?.hits)) {
          const hits = errBody.detail.hits.filter(isInteractionHit);
          setInteractionHits(hits);
          setInteractionReasons(hits.map(() => ""));
          setOverrideError(null);
          return;
        }
        if (errBody?.code === "duplicate_salt_conflict" && Array.isArray(errBody.detail?.hits)) {
          const hits = errBody.detail.hits.filter((h): h is WireDuplicateHit => !isInteractionHit(h));
          setDuplicateHits(hits);
          setDuplicateReasons(hits.map(() => ""));
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
    if (active === null) return;
    /**
     * PLAN 16a T6 — the pre-check runs first so the doctor meets the warning before the refusal.
     * IT IS A COURTESY, NOT A GATE: the issue path re-runs every check server-side regardless
     * (design law 2), and `postRx` above still handles both conflict codes. If the pre-check
     * itself fails — a network blip, a 403 — the submit proceeds and the SERVER decides, because a
     * screen that refused to submit when its convenience call failed would be inventing a refusal.
     */
    try {
      const pre = await api<WirePrecheck>(
        "POST", `/opd/visits/${active.encounterId}/rx-precheck`,
        { lines: values.lines.map((l) => ({
          drug: l.drug.trim(), dose: l.dose.trim(), route: l.route, frequency: l.frequency,
          durationDays: l.durationDays, instructions: orNull(l.instructions),
          noSubstitution: l.noSubstitution, medicineId: l.medicineId,
        })) },
      );
      setNotices(pre.notices);
      setNoticesDismissed(false);
      setUnresolvedLines(pre.unresolvedLineIndexes);
      const severe = pre.interactions.filter((h) => h.severity === "severe");
      const hardDuplicates = pre.duplicates.filter((h) => h.hard);
      if (pre.allergyMatches.length > 0 || severe.length > 0 || hardDuplicates.length > 0) {
        setMatches(pre.allergyMatches.length > 0 ? pre.allergyMatches : null);
        setReasons(pre.allergyMatches.map(() => ""));
        setInteractionHits(severe);
        setInteractionReasons(severe.map(() => ""));
        setDuplicateHits(hardDuplicates);
        setDuplicateReasons(hardDuplicates.map(() => ""));
        setOverrideError(null);
        return;
      }
    } catch {
      // Deliberately swallowed — see the comment above. The server is the gate.
      // M5 — but the stale hint indexes go: pointing the amber "not in formulary" note at a row
      // whose line has since changed is worse than showing nothing.
      setUnresolvedLines([]);
    }
    await postRx(values.lines);
  });

  /**
   * K48, extended by 16a T6: the re-post carries one array per KIND, each with a reason per hit,
   * mirroring the server's rule exactly. The three-character minimum is checked here so the doctor
   * is told in the dialog rather than by a round trip — and the server checks it again regardless.
   */
  const confirmOverride = async (): Promise<void> => {
    const allReasons = [
      ...(matches === null ? [] : reasons.slice(0, matches.length)),
      ...interactionReasons.slice(0, interactionHits.length),
      ...duplicateReasons.slice(0, duplicateHits.length),
    ];
    if (allReasons.length === 0) return;
    if (allReasons.some((r) => r.trim().length < 3)) {
      setOverrideError(t("opdConsult.overrideReasonRequired"));
      return;
    }
    const overrides: AllergyOverride[] = (matches ?? []).map((m, i) => ({
      lineIndex: m.lineIndex, substance: m.substance, reason: (reasons[i] ?? "").trim(),
    }));
    // C5 — the override names the hit it clears, so it cannot silently clear a second one that
    // arrived between the pre-check and the submit.
    const interactionOverrides = interactionHits.map((h, i) => ({
      lineIndex: h.lineIndex, reason: (interactionReasons[i] ?? "").trim(), saltPair: h.saltPair,
    }));
    const duplicateOverrides = duplicateHits.map((h, i) => ({
      lineIndex: h.lineIndex, reason: (duplicateReasons[i] ?? "").trim(), moiety: h.moiety,
    }));
    await postRx(
      pendingLines.current,
      overrides.length > 0 ? overrides : undefined,
      interactionOverrides.length > 0 ? interactionOverrides : undefined,
      duplicateOverrides.length > 0 ? duplicateOverrides : undefined,
    );
  };

  /** "prescribed N days ago — may no longer be current" (spec §1.3), rendered only when assumed. */
  const againstLabel = (hit: WireRxNotice): string => {
    if (hit.against.scope === "in_rx") {
      return t("opdConsult.hitAgainstLine", { n: hit.against.lineIndex + 1 });
    }
    const days = Math.max(0, Math.round((Date.now() - new Date(hit.against.issuedAt).getTime()) / 86_400_000));
    return hit.against.assumedCurrent
      ? t("opdConsult.hitAgainstAssumed", { days })
      : t("opdConsult.hitAgainstPrior", { days });
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

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════════════
    THE CO-PILOT, AND WHY IT HAS NO MODEL BEHIND IT
    ═══════════════════════════════════════════════════════════════════════════════════════════════

    Every answer below is computed from state this screen already holds and already renders. That is
    not a limitation being worked around; it is the only version of this feature that is safe to put
    in front of a prescriber today. A language model that invented a plausible allergy, or rounded a
    blood pressure, would be believed — the dock sits inside a clinical screen, in the hospital's own
    colours, beside numbers a nurse actually measured.

    So the rule is: the dock reads, it never infers. Each answer names its source ("Bay One charted",
    "on file", "you have written"), and the honest refusal is a first-class reply rather than an
    apology — a doctor who asks something this screen cannot see is told so in one sentence, and can
    stop wondering whether the silence meant "no".
  */
  const [agentAnswer, setAgentAnswer] = useState<string | null>(null);
  const [agentLog, setAgentLog] = useState<AgentLine[]>([]);

  const agentState = useRef({ view, activeAllergies, latestVitals, advisedTests, restricted });
  agentState.current = { view, activeAllergies, latestVitals, advisedTests, restricted };

  const ask = useCallback((question: string): void => {
    const q = question.toLowerCase();
    const st = agentState.current;
    const lines = rxForm.getValues("lines").filter((l) => l.drug.trim() !== "");

    const answer = ((): string => {
      if (/queue|waiting|next|token|katar|line/.test(q)) {
        const v = st.view;
        if (v === null) return t("opdConsult.agent.noQueue");
        return t("opdConsult.agent.queueDepth", {
          waiting: v.ordered.length,
          done: v.counts.done,
          next: v.ordered[0]?.tokenNo ?? "—",
        });
      }
      if (/allerg/.test(q)) {
        /* A confidential record answers the band and not the history — the same rule the bay follows. */
        if (st.restricted) return t("opdConsult.agent.cannot");
        return st.activeAllergies.length === 0
          ? t("opdConsult.agent.noAllergies")
          : t("opdConsult.agent.allergies", { list: st.activeAllergies.map((a) => a.substance).join(", ") });
      }
      if (/vital|bp|pressure|pulse|spo2|oxygen|temp/.test(q)) {
        const v = st.latestVitals;
        if (v === null) return t("opdConsult.agent.noVitals");
        const flags = v.dangerFlags.length === 0
          ? t("opdConsult.agent.noDangerFlags")
          : t("opdConsult.agent.dangerFlags", { list: v.dangerFlags.map((f) => `${f.vital} ${String(f.value)}`).join(", ") });
        return t("opdConsult.agent.vitals", {
          bp: `${v.sbp ?? "—"}/${v.dbp ?? "—"}`, pulse: v.pulse ?? "—", spo2: v.spo2 ?? "—", flags,
        });
      }
      if (/rx|prescri|medicine|drug|dawa|line/.test(q)) {
        return lines.length === 0 ? t("opdConsult.agent.noRx") : t("opdConsult.agent.rxLines", { n: lines.length });
      }
      if (/test|lab|invest|jaanch|advis/.test(q)) {
        return st.advisedTests.length === 0
          ? t("opdConsult.agent.noAdvised")
          : t("opdConsult.agent.advised", { n: st.advisedTests.length });
      }
      return t("opdConsult.agent.cannot");
    })();

    setAgentAnswer(answer);
    setAgentLog((l) => logged(l, question));
  }, [rxForm, t]);

  // ——— this screen's OWN shortcuts; lib/keyboard.tsx owns the global ones and is NOT touched ———

  /**
   * ═══ THE SIGNED-OFF KEYMAP REPLACES THE ALT CHORDS, AND THAT IS THE INTENDED COST ═══
   *
   * This screen shipped with Alt+N / Alt+K / Alt+S / Alt+Enter. The keyboard artboard
   * (docs/design/2026-09-03-front-desk-three-seats/Keymap.dc.html) is signed off and contains none
   * of them — FD-5's ruling parked the Alt chords — so a second key system was alive beside the
   * artboard's. Four tests pinned the old chords and are rewritten in this same commit rather than
   * left to describe a keyboard the hospital no longer uses.
   *
   * WHAT THE MAP GIVES THIS SEAT, and every one of these is drawn as a keycap on the screen above:
   *
   *   Ctrl+Enter  COMMIT — complete the consultation. A chord because it is the irreversible one.
   *   Enter       "do the obvious next thing": call the next token when the chair is empty, start
   *               the consultation when somebody has been called. Never from inside a field, where
   *               Enter belongs to the field.
   *   Esc         once back to the queue, twice release the patient. "Nothing bleeds into the next
   *               person" — the Keymap's own words, and this screen had no Esc at all.
   *
   * F4 and F7 are NOT bound here and no keycap claims them: `lib/keyboard.tsx` owns them globally
   * (/counter and /opd/appointments) and they fire on this screen. A keycap for either would be a
   * key that navigates a doctor away mid-consultation, which is the artboard's "a keycap that lies"
   * exactly. F2 is the dock's and the dock binds it itself.
   */
  const actions = useRef({ callNext, skipCurrent, startConsult, submitRx, complete, hasActive: active !== null, hasCalled: current !== null });
  actions.current = { callNext, skipCurrent, startConsult, submitRx, complete, hasActive: active !== null, hasCalled: current !== null };
  useEffect(() => {
    /* Esc is two-stage, so it needs one bit of memory between presses. */
    let escArmed = false;
    const inField = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement
      && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);

    const onKey = (e: KeyboardEvent): void => {
      const a = actions.current;

      /*
        ═══ CLOSE PASS 1, CRITICAL — NO SCREEN CHORD FIRES WHILE A MODAL IS OPEN ═══

        This handler is on `window`, so it ran straight through the override dialog. A doctor who
        typed an override reason and pressed Ctrl+Enter — the chord this screen DRAWS ON ITS OWN
        KEYCAP ROW and the app-wide legend calls "confirm" — did not press the dialog's Confirm
        button. They completed the consultation: `POST /consult/complete`, then `resetPanel()`
        cleared `matches`, `interactionHits` and the whole prescription form. The visit closed, the
        e-Rx was never issued, and the three lines and the reason went with it. No error was shown,
        because nothing failed.

        A modal is modal for the keyboard too. The dialog owns Escape (it stops propagation itself);
        everything else this screen binds stands down while one is open.
      */
      if (document.querySelector('[role="dialog"]') !== null) return;

      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        escArmed = false;
        void a.complete();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        /*
          TWICE RELEASES. The first press is a retreat — leave the field, look at the queue. The
          second is a decision, and it is the one that must never happen by accident, which is why
          it takes two presses rather than a confirm dialog a doctor learns to dismiss.
        */
        if (escArmed && a.hasActive) { escArmed = false; setActive(null); setTab("note"); return; }
        escArmed = true;
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return;
      }
      escArmed = false;
      if (e.key === "Enter" && !inField(e.target)) {
        e.preventDefault();
        /* "The obvious next thing" depends on where the chair is, not on which key was pressed. */
        void (a.hasActive ? Promise.resolve() : a.hasCalled ? a.startConsult() : a.callNext());
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
      <PaperScreen testId="consult-not-doctor" style={{ padding: "20px 24px", gap: 12 }}>
        <ScreenTitle title={t("opdConsult.title")} route="/opd/consult" />
        <p data-testid="not-a-doctor" role="status" className="box" style={{ margin: 0, padding: "12px 14px", fontSize: 13, borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}>
          {t("opdConsult.notADoctor")}
        </p>
      </PaperScreen>
    );
  }

  const queueRow = (e: WireQueueEntryView, isCurrent: boolean): React.ReactElement => (
    <li
      key={e.id}
      data-testid={`queue-row-${e.id}`}
      aria-current={isCurrent ? "true" : undefined}
      className="drow"
      /*
        THE ROW IN THE CHAIR IS MARKED BY THE HOSPITAL GREEN AND A LEFT BAR, not by a blue tint.
        Blue belongs to no part of this palette, and the one row a doctor must be able to find
        while looking at a patient should differ from its neighbours by SHAPE as well as colour.
      */
      style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, padding: "8px 10px", fontSize: 12.5,
        ...(isCurrent
          ? { background: "var(--green-soft)", boxShadow: "inset 3px 0 0 var(--green)" }
          : {}),
      }}
    >
      <span data-testid={`queue-position-${e.id}`} className="mo" style={{ fontSize: 10, color: "var(--faint)" }}>
        {e.position === null ? "—" : t("opdConsult.position", { n: e.position })}
      </span>
      <span data-testid={`queue-token-${e.id}`} className="mo" style={{ fontSize: 16, fontWeight: 700 }}>{e.tokenNo}</span>
      <span style={{ flexGrow: 1, minWidth: 0 }}>{patientLabel(e.patient)}</span>
      {e.queueClass !== null && <span className="tag">{t(`opd.queueClass.${e.queueClass}`)}</span>}
      {(e.danger || e.encounter.dangerFlagged) && (
        <span data-testid={`queue-danger-${e.id}`} aria-label={t("opdConsult.danger")} style={{ color: "var(--red)", fontWeight: 700 }}>⚠</span>
      )}
      {e.reEntry && <span className="pill" data-testid={`queue-reentry-${e.id}`}>{t("opdConsult.reEntry")}</span>}
    </li>
  );

  return (
    <PaperScreen testId="opd-consult" style={{ padding: "16px 20px 0", gap: 13 }}>
      <ScreenTitle
        title={t("opdConsult.title")} route="/opd/consult" subtitle={me.data?.displayName ?? undefined}
        actions={
          /*
            THE KEYCAP LEGEND IS THE ARTBOARD'S OWN RULE MADE VISIBLE: "every keycap ON the screen
            shows what is actually bound." Three caps, three bindings, all in the effect below —
            F4 and F7 are deliberately absent because `lib/keyboard.tsx` owns them globally and a
            keycap for them here would navigate a doctor away mid-consultation.
          */
          <span style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 10.5, color: "var(--faint)" }}>
            <span><span className="kb">Ctrl</span><span className="kb">⏎</span> {t("opdConsult.keys.complete")}</span>
            <span><span className="kb">F2</span> {t("opdConsult.keys.agent")}</span>
            <span><span className="kb">Esc</span> {t("opdConsult.keys.back")}</span>
          </span>
        }
      />

      {/*
        THE RAIL IS 296px AND DOES NOT GROW. A doctor reads the queue with their peripheral vision
        while looking at a patient; a column that reflows with the window is a column they have to
        re-find. Below 1100px the two stack, because a `.pp` screen inherits no narrow story from
        `.d1` and a lobby terminal at 1024 would otherwise get a 300px-wide note field.
      */}
      <div style={{ flexGrow: 1, minHeight: 0, display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
        {/* (a) the live queue and the session controls */}
        <aside className="box" style={{ width: 296, flexGrow: 1, maxWidth: "100%", flexBasis: 296, padding: 13, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
          <div>
            <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="session-status">{t("opdConsult.sessionStatus")}</label>
            <select
              id="session-status"
              value={view?.session.status ?? "not_started"}
              disabled={view === null}
              onChange={(e) => void setSessionStatus(e.target.value as SessionStatusInput)}
              className="in"
              style={{ width: "100%", height: 34, fontSize: 12.5 }}
            >
              <option value="not_started" disabled>{t("opd.sessionStatus.not_started")}</option>
              <option value="in">{t("opd.sessionStatus.in")}</option>
              <option value="out">{t("opd.sessionStatus.out")}</option>
              <option value="closed">{t("opd.sessionStatus.closed")}</option>
            </select>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button type="button" className="pri" style={{ padding: "3px 11px", fontSize: 12 }} onClick={() => void callNext()}>{t("opdConsult.callNext")}</button>
            <button type="button" className="sec" style={{ padding: "3px 11px", fontSize: 12 }} onClick={() => void skipCurrent()}>{t("opdConsult.skip")}</button>
            <button type="button" className="sec grn" style={{ padding: "3px 11px", fontSize: 12 }} onClick={() => void startConsult()}>{t("opdConsult.start")}</button>
          </div>
          <ErrorLine message={queueError} />

          {/*
            PLAN 07d T2 — QUEUE DEPTH, WHICH WAS FREE. `summaryByDoctor` has always returned
            `waitingCount`; the cockpit rendered the LIST and never the number, so a doctor deciding
            whether to take a tea break had to count rows. It is live on the same realtime topic the
            list already subscribes to.
          */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 9, paddingTop: 4 }}>
            <h2 className="tag" style={{ margin: 0 }}>{t("opdConsult.queue")}</h2>
            {view === null ? null : (
              <span data-testid="queue-depth" className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                {t("opdConsult.waitingCount", { waiting: ordered.length })}
              </span>
            )}
            {/*
              PLAN 07d T6 — THE DOCTOR'S OWN DAY, ONE CLICK AWAY. 07c built the brief and put it on
              `/my-day`; a doctor who has to navigate to it from the front door will not, mid-clinic.
            */}
            <Link to="/my-day" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--green)" }}>{t("opdConsult.myDay")}</Link>
          </div>
          {view === null && queue.data !== undefined && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("opdConsult.noSession")}</p>
          )}
          {view !== null && current === null && ordered.length === 0 && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("opdConsult.emptyQueue")}</p>
          )}
          <ul data-testid="consult-queue" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {current !== null && queueRow(current, true)}
            {ordered.map((e) => queueRow(e, false))}
          </ul>
        </aside>

        {/* (b) the patient panel */}
        <main style={{ flexGrow: 999, flexBasis: 520, minWidth: 0, display: "flex", flexDirection: "column", gap: 13, overflowY: "auto", paddingBottom: 14 }}>
          {active === null && (
            <div className="box" style={{ padding: "26px 22px", textAlign: "center" }}>
              <p style={{ margin: "0 0 5px", fontSize: 16, fontWeight: 700 }}>{t("opdConsult.noPatientTitle")}</p>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("opdConsult.noPatientBody")}</p>
              <p data-testid="pick-patient-hint" style={{ margin: "9px 0 0", fontSize: 11.5, color: "var(--faint)" }}>{t("opdConsult.pickPatientHint")}</p>
            </div>
          )}

          {active !== null && (
            <div data-testid="patient-panel" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              <header className="box" style={{ padding: "13px 15px", display: "flex", flexDirection: "column", gap: 5 }}>
                {restricted ? (
                  <>
                    <p data-testid="restricted-banner" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--gold)" }}>{t("opdConsult.restricted")}</p>
                    <p data-testid="panel-uhid" className="mo" style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{active.summary?.uhid ?? "—"}</p>
                  </>
                ) : (
                  <>
                    <h2 data-testid="panel-patient-name" style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>
                      {patient.data?.patient.name ?? patient.data?.patient.alias ?? patientLabel(active.summary)}
                    </h2>
                    <p data-testid="panel-uhid" className="mo" style={{ margin: 0, fontSize: 11, color: "var(--faint)" }}>
                      {patient.data?.patient.uhid ?? active.summary?.uhid ?? "—"}
                    </p>
                    <p data-testid="panel-patient-age" style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>
                      {t("opdConsult.age", { age: ageYears ?? "—" })} · {patient.data?.patient.administrativeGender ?? "—"}
                    </p>
                  </>
                )}
                {encounter !== null && (
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, marginTop: 2 }}>
                    <span className="pill" data-testid="panel-visit-type">{t(`opd.visitType.${encounter.visitType}`)}</span>
                    {encounter.dangerFlagged && (
                      <span className="pill rd" data-testid="panel-danger">{t("opdConsult.danger")}</span>
                    )}
                  </div>
                )}

                {!restricted && (
                  <div style={{ paddingTop: 7 }}>
                    <h3 className="tag" style={{ margin: "0 0 5px" }}>{t("opdConsult.allergies")}</h3>
                    <div data-testid="allergy-chips" style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {activeAllergies.length === 0 && (
                        <span style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdConsult.noAllergies")}</span>
                      )}
                      {activeAllergies.map((a) => (
                        <span key={a.id} data-testid={`allergy-chip-${a.id}`} className="pill rd" style={{ fontWeight: 600 }}>
                          {a.substance}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ paddingTop: 7 }}>
                  <h3 className="tag" style={{ margin: "0 0 5px" }}>{t("opdConsult.vitals")}</h3>
                  {latestVitals === null && <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("opdConsult.noVitals")}</p>}
                  {latestVitals !== null && (
                    <>
                      {/* Bay One's own numbers, in Bay One's mono, so the two screens read as one record. */}
                      <p data-testid="panel-vitals" className="mo" style={{ margin: 0, fontSize: 13 }}>
                        BP {latestVitals.sbp ?? "—"}/{latestVitals.dbp ?? "—"} · P {latestVitals.pulse ?? "—"} · SpO₂ {latestVitals.spo2 ?? "—"}%
                      </p>
                      {latestVitals.dangerFlags.map((f) => (
                        <p
                          key={f.vital}
                          role="alert"
                          data-testid={`vitals-danger-${f.vital}`}
                          className="mo"
                          style={{ margin: "5px 0 0", padding: "4px 8px", borderRadius: 6, fontSize: 12, fontWeight: 700, color: "var(--red)", background: "var(--red-soft)" }}
                        >
                          {f.vital} {f.value} ({f.bound} {f.limit})
                        </p>
                      ))}
                    </>
                  )}
                </div>
              </header>

              <div className="box" style={{ padding: "13px 15px", display: "flex", flexDirection: "column", gap: 12 }}>
                <TabStrip
                  label={t("opdConsult.tabs.note")}
                  value={tab}
                  onChange={setTab}
                  options={[["note", t("opdConsult.tabs.note")], ["rx", t("opdConsult.tabs.rx")], ["history", t("opdConsult.tabs.history")]] as const}
                />

                {/* the note autosaves on blur — focusout bubbles, so one handler covers every field */}
                {tab === "note" && (
                <div role="tabpanel" id="tabpanel-note" aria-labelledby="tab-note">
                  <div style={{ display: "flex", flexDirection: "column", gap: 9 }} onBlur={() => void saveNote()}>
                    {/*
                      THE SCRIBE SITS ABOVE THE COMPLAINT because that is the field it fills, and
                      because a doctor who has just finished listening to a patient reaches for it
                      first. It inserts a SUGGESTION into the field below and never writes past it.
                    */}
                    <ConsultScribe onInsert={(text) => {
                      setNote((n) => ({ ...n, chiefComplaint: n.chiefComplaint.trim() === "" ? text : `${n.chiefComplaint.trim()} ${text}` }));
                    }} />
                    <div>
                      <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="note-chief">{t("opdConsult.chiefComplaint")}</label>
                      <textarea
                        id="note-chief" rows={2}
                        value={note.chiefComplaint}
                        onChange={(e) => setNote((n) => ({ ...n, chiefComplaint: e.target.value }))}
                        className="in" style={{ width: "100%", height: "auto", padding: "7px 9px", fontSize: 13 }}
                      />
                    </div>
                    <div>
                      <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="note-diagnosis">{t("opdConsult.diagnosis")}</label>
                      <textarea
                        id="note-diagnosis" rows={2}
                        value={note.diagnosis}
                        onChange={(e) => setNote((n) => ({ ...n, diagnosis: e.target.value }))}
                        className="in" style={{ width: "100%", height: "auto", padding: "7px 9px", fontSize: 13 }}
                      />
                    </div>
                    <div>
                      <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="note-icd10">{t("opdConsult.icd10Code")}</label>
                      <input
                        id="note-icd10"
                        value={note.icd10Code}
                        onChange={(e) => setNote((n) => ({ ...n, icd10Code: e.target.value }))}
                        className="in mo" style={{ width: "100%", height: 34, fontSize: 13 }}
                      />
                    </div>
                    <div>
                      <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="note-advice">{t("opdConsult.advice")}</label>
                      <textarea
                        id="note-advice" rows={2}
                        value={note.advice}
                        onChange={(e) => setNote((n) => ({ ...n, advice: e.target.value }))}
                        className="in" style={{ width: "100%", height: "auto", padding: "7px 9px", fontSize: 13 }}
                      />
                    </div>
                    {noteSaved && <p data-testid="note-saved" style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "var(--green)" }}>{t("opdConsult.noteSaved")}</p>}
                    <ErrorLine message={noteError} />
                  </div>
                </div>
                )}

                {tab === "rx" && (
                <div role="tabpanel" id="tabpanel-rx" aria-labelledby="tab-rx">
                  <FormProvider {...rxForm}>
                    <FormKit onSubmit={submitRx}>
                      {lines.fields.map((f, i) => (
                        <div key={f.id} data-testid={`rx-row-${String(i)}`} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 9, padding: "11px 0", borderTop: i === 0 ? "none" : "1px solid var(--line)" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            {/*
                              C1 (independent review) — TYPING OVER A PICKED NAME DROPS THE ID.
                              The schema comment claimed this ("cleared the moment the doctor
                              types") and nothing implemented it, so a line could read "Paracetamol
                              500" while carrying warfarin's id — and the server preferred the id.
                              The server now cross-checks the brand name too; this is the half that
                              keeps the two honest in the first place.
                            */}
                            <TextField
                              name={`lines.${String(i)}.drug`}
                              label={t("opdConsult.drug")}
                              onChange={() => {
                                if (rxForm.getValues(`lines.${i}.medicineId`) !== null) {
                                  rxForm.setValue(`lines.${i}.medicineId`, null);
                                }
                              }}
                            />
                            {/*
                              PLAN 16a T6 — the formulary picker. Free typing in the field above is
                              untouched and always legal (design law 1); picking fills the name AND
                              the id, which is what turns a line into a checked one.
                            */}
                            <select
                              data-testid={`rx-formulary-${String(i)}`}
                              aria-label={t("opdConsult.pickFromFormulary")}
                              value={rxForm.watch(`lines.${i}.medicineId`) ?? ""}
                              onChange={(e) => {
                                const picked = medicines.find((m) => m.id === e.target.value);
                                rxForm.setValue(`lines.${i}.medicineId`, picked?.id ?? null);
                                if (picked !== undefined) rxForm.setValue(`lines.${i}.drug`, picked.brandName);
                              }}
                              className="in" style={{ width: "100%", height: 32, fontSize: 12 }}
                            >
                              <option value="">{t("opdConsult.pickFromFormulary")}</option>
                              {medicines.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.salts.length > 0 ? `${m.brandName} — ${String(m.salts.length)}` : m.brandName}
                                </option>
                              ))}
                            </select>
                            {/*
                              DD5 — the hint renders ONLY when the server says coverage is high
                              enough. Below the threshold it would fire on almost every line and
                              become wallpaper, which is worse than silence.
                            */}
                            {noticeEnabled && unresolvedLines.includes(i) && (
                              <p data-testid={`rx-uncovered-${String(i)}`} style={{ margin: 0, fontSize: 11, color: "var(--gold)" }}>
                                {t("opdConsult.notInFormulary")}
                              </p>
                            )}
                          </div>
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
                            <button type="button" className="sec" style={{ padding: "3px 11px", fontSize: 12, alignSelf: "end" }} onClick={() => lines.remove(i)}>
                              {t("opdConsult.removeLine")}
                            </button>
                          )}
                        </div>
                      ))}
                      <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
                        <button type="button" className="sec" style={{ padding: "4px 12px", fontSize: 12.5 }} onClick={() => lines.append(EMPTY_LINE)}>
                          {t("opdConsult.addLine")}
                        </button>
                        <button type="submit" className="pri">{t("opdConsult.issue")}</button>
                      </div>
                    </FormKit>
                  </FormProvider>
                  {/*
                    PLAN 16a T6 / DD3 — SOFT hits. Moderate interactions, duplicates against a prior
                    prescription, duplicates across route classes. They are data: dismissible, never
                    a gate, and they carry the in-system-only honesty line (design law 10).
                  */}
                  {notices.length > 0 && !noticesDismissed && (
                    <div data-testid="rx-notices" className="box" style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 5, padding: "10px 12px", fontSize: 12.5, borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}>
                      {notices.map((hit, i) => (
                        <p key={`${String(hit.lineIndex)}-${String(i)}`} data-testid={`rx-notice-${String(i)}`} style={{ margin: 0 }}>
                          {isInteractionHit(hit)
                            ? t("opdConsult.noticeInteraction", { n: hit.lineIndex + 1, note: hit.note })
                            : t("opdConsult.noticeDuplicate", { n: hit.lineIndex + 1, moiety: hit.moiety })}
                          {" "}
                          <span style={{ color: "var(--dim)" }}>{againstLabel(hit)}</span>
                        </p>
                      ))}
                      <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("opdConsult.inSystemOnly")}</p>
                      <button type="button" className="sec" style={{ alignSelf: "flex-start", padding: "2px 10px", fontSize: 11.5 }} onClick={() => setNoticesDismissed(true)}>
                        {t("opdConsult.dismiss")}
                      </button>
                    </div>
                  )}
                  <ErrorLine message={rxError} />
                </div>
                )}

                {tab === "history" && (
                <div role="tabpanel" id="tabpanel-history" aria-labelledby="tab-history">
                  {/*
                    PLAN 07d T1 — THREE VIEWS OF THE SAME PATIENT, and the two new ones are the point
                    of the task. Visits is what existed; prescriptions and vitals are what a doctor
                    has been unable to see since this application shipped.
                  */}
                  <div style={{ marginBottom: 10, display: "flex", gap: 6 }} role="group" aria-label={t("opdConsult.historyView")}>
                    {(["visits", "rx", "vitals"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={v === historyView}
                        className={v === historyView ? "pill on" : "pill"}
                        onClick={() => { setHistoryView(v); }}
                      >
                        {t(`opdConsult.history.${v}`)}
                      </button>
                    ))}
                  </div>

                  {historyView === "visits" && (
                    <ul data-testid="timeline" style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12.5 }}>
                      {timelineItems.length === 0 && <li style={{ color: "var(--dim)" }}>{t("opdConsult.noHistory")}</li>}
                      {timelineItems.map((item) => (
                        <li key={item.encounterId} data-testid={`timeline-row-${item.encounterId}`} className="drow" style={{ padding: "6px 0" }}>
                          {item.serviceDate} · {item.departmentName ?? "—"} · {item.doctorName ?? "—"} · {item.diagnosis ?? "—"}
                        </li>
                      ))}
                    </ul>
                  )}

                  {historyView === "rx" && (
                    <div data-testid="rx-history" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5 }}>
                      {rxHistory.isPending && <p style={{ margin: 0, color: "var(--dim)" }}>{t("app.loading")}</p>}
                      {!rxHistory.isPending && (rxHistory.data?.items ?? []).length === 0 && (
                        <p style={{ margin: 0, color: "var(--dim)" }}>{t("opdConsult.noRxHistory")}</p>
                      )}
                      {(rxHistory.data?.items ?? []).map((rx) => (
                        <div key={rx.prescriptionId} className="box" style={{ padding: "9px 11px" }}>
                          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 7, fontSize: 10.5, color: "var(--faint)" }}>
                            <span>{rx.serviceDate}</span>
                            <span>{rx.doctorName ?? "—"}</span>
                            {/*
                              A SUPERSEDED VERSION IS SHOWN AND LABELLED, never hidden. "What was
                              this patient actually given in March" may well be the superseded row,
                              and a history that showed only the live version would quietly rewrite
                              the past.
                            */}
                            {rx.status !== "active" && (
                              <span className="pill gd">{t(`opdConsult.rxStatus.${rx.status}`)}</span>
                            )}
                          </div>
                          <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
                            {(Array.isArray(rx.lines) ? rx.lines : []).map((line, i) => (
                              <li key={`${rx.prescriptionId}-${String(i)}`}>
                                {line.drug}{line.dose === null ? "" : ` · ${line.dose}`}
                                {line.frequency === null ? "" : ` · ${line.frequency}`}
                                {line.durationDays === null ? "" : ` · ${t("opdConsult.forDays", { days: line.durationDays })}`}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}

                  {historyView === "vitals" && (
                    <div data-testid="vitals-history" style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12.5 }}>
                      {vitalsHistory.isPending && <p style={{ margin: 0, color: "var(--dim)" }}>{t("app.loading")}</p>}
                      {!vitalsHistory.isPending && (vitalsHistory.data?.items ?? []).length === 0 && (
                        <p style={{ margin: 0, color: "var(--dim)" }}>{t("opdConsult.noVitalsHistory")}</p>
                      )}
                      {/*
                        OLDEST FIRST, because this is read as a TREND and a trend read backwards is a
                        trend nobody sees. The server returns it in this order; the screen does not
                        re-sort it.
                      */}
                      {(vitalsHistory.data?.items ?? []).map((v) => (
                        <div key={v.vitalsId} className="mo" style={{ display: "flex", flexWrap: "wrap", columnGap: 12 }}>
                          <span style={{ color: "var(--faint)" }}>{v.serviceDate}</span>
                          {/*
                            SHORT labels, in this screen's own namespace. `opdVitals.field.*` are the
                            FORM labels ("SBP (mmHg)") and are correct there and wrong in a dense
                            trend row — and `opdVitals.bp` does not exist at all, which is what a
                            first draft of this block referenced and would have rendered as a raw key.
                          */}
                          <span>{t("opdConsult.vitalsBp")} {v.sbp ?? "—"}/{v.dbp ?? "—"}</span>
                          <span>{t("opdConsult.vitalsPulse")} {v.pulse ?? "—"}</span>
                          <span>{t("opdConsult.vitalsSpo2")} {v.spo2 ?? "—"}</span>
                          {Array.isArray(v.dangerFlags) && v.dangerFlags.length > 0 && (
                            <span style={{ color: "var(--red)", fontWeight: 700 }}>{t("opdConsult.flagged")}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                )}
              </div>

              {/*
                PLAN 07d T5 / DD4 — **ADVISED INVESTIGATIONS: A CATALOGUE AND A PRICE, NOT AN ORDER.**

                There is no lab or radiology module in this system — no order table, no result table,
                no accession — and this does not pretend otherwise. The doctor picks from the priced
                service catalogue and the selections print on the prescription as ADVICE. That is
                how an Indian hospital works before a LIMS lands, it answers the question the
                patient actually asks at the chair, and the selections become the demand signal that
                tells Plan 17 which tests to carry first.

                The screen SAYS all of that, in a sentence, where a doctor would otherwise assume a
                pipeline exists. A UI that implies an order somebody must then chase is worse than
                one that admits there is none.
              */}
              {active !== null && (
                <div data-testid="advised-tests" className="box" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 15px" }}>
                  <h2 className="tag" style={{ margin: 0 }}>{t("opdConsult.advisedTests")}</h2>
                  {/*
                    THE SENTENCE THAT KEEPS THIS PANEL HONEST. It creates no order, and a doctor who
                    assumed otherwise would leave a test nobody performs. DD4's ruling, on screen.
                  */}
                  <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("opdConsult.advisedTestsNote")}</p>

                  <input
                    className="in" style={{ width: "100%", height: 34, fontSize: 12.5 }}
                    placeholder={t("opdConsult.advisedTestsSearch")}
                    aria-label={t("opdConsult.advisedTestsSearch")}
                    value={testQuery}
                    onChange={(e) => { setTestQuery(e.target.value); }}
                  />

                  {/*
                    E-10 — an INACTIVE service never appears: the catalogue is the source, and a
                    hospital cannot advise a test it has withdrawn. `listPriceList` filters them out
                    server-side, so this list cannot show one even by accident.
                  */}
                  {serviceMatches.length > 0 && (
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
                      {serviceMatches.map((sv) => (
                        <li key={sv.serviceId}>
                          <button
                            type="button"
                            className="sec" style={{ width: "100%", justifyContent: "flex-start", textAlign: "left", padding: "4px 9px", fontSize: 12.5 }}
                            onClick={() => {
                              void saveAdvised([...advisedTests, {
                                serviceId: sv.serviceId, code: sv.code, name: sv.name, pricePaise: sv.pricePaise,
                              }]);
                              setTestQuery("");
                            }}
                          >
                            {sv.name} — {fmtPaise(sv.pricePaise)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* §1.3's promise: several panels are empty on day one, and each says why. */}
                  {testQuery.trim().length >= 2 && serviceMatches.length === 0 && (
                    <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("opdConsult.advisedTestsNoMatch")}</p>
                  )}

                  {advisedTests.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("opdConsult.advisedTestsEmpty")}</p>
                  ) : (
                    <ul data-testid="advised-chosen" style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12.5 }}>
                      {advisedTests.map((a) => (
                        <li key={a.serviceId} className="drow" style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "6px 0" }}>
                          <span>{a.name}</span>
                          <span className="mo" style={{ color: "var(--dim)" }}>{fmtPaise(a.pricePaise)}</span>
                          <button
                            type="button"
                            className="sec" style={{ marginLeft: "auto", padding: "1px 8px", fontSize: 11 }}
                            aria-label={t("opdConsult.advisedTestsRemove", { name: a.name })}
                            onClick={() => { void saveAdvised(advisedTests.filter((x) => x.serviceId !== a.serviceId)); }}
                          >
                            {t("opdConsult.remove")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/*
                ═══ PLAN 17b T8 / DD21 — **THE ONE LABORATORY PANEL IN THE WHOLE OF OPD** ═══

                Verified results for THIS visit, read straight from the laboratory's own reader. It
                is the only place this phase touches `modules/opd`, and it is a READ.

                **It is never held for money** (02 O-1). `listResultsForEncounter` does not consult
                the delivery interlock and this panel does not either: an unpaid self-pay patient's
                doctor sees every signed number. The interlock holds the printed DOCUMENT the
                patient takes away, at the counter, and hiding a verified result from the clinician
                who ordered it is the safety defect DD6 exists to avoid rather than to cause. The
                note under the heading says so, because a doctor who assumes otherwise stops looking.
              */}
              {active !== null && (
                <LabResultsPanel visitNo={visit.data?.encounter.visitNo ?? null} />
              )}

              {/* (c) completion */}
              <div className="box" style={{ display: "flex", flexDirection: "column", gap: 9, padding: "13px 15px" }}>
                <label className="tag" style={{ display: "block" }} htmlFor="follow-up">{t("opdConsult.followUp")}</label>
                <select
                  id="follow-up"
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                  className="in" style={{ width: "100%", height: 34, fontSize: 12.5 }}
                >
                  <option value="">{t("opdConsult.followUpDefault", { days: config.data?.followUpDefaultDays ?? "—" })}</option>
                  {(config.data?.followUpExtensionDays ?? []).map((d) => (
                    <option key={d} value={String(d)}>{t("opdConsult.extension", { days: d })}</option>
                  ))}
                </select>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <input type="checkbox" checked={testsOrdered} onChange={(e) => setTestsOrdered(e.target.checked)} />
                  {t("opdConsult.testsOrdered")}
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <input type="checkbox" checked={admissionAdvised} onChange={(e) => setAdmissionAdvised(e.target.checked)} />
                  {t("opdConsult.admissionAdvised")}
                </label>
                <div>
                  <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="referral-to">{t("opdConsult.referralTo")}</label>
                  <input
                    id="referral-to"
                    value={referralTo}
                    onChange={(e) => setReferralTo(e.target.value)}
                    className="in" style={{ width: "100%", height: 34, fontSize: 13 }}
                  />
                </div>
                <div>
                  <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="referral-note">{t("opdConsult.referralNote")}</label>
                  <input
                    id="referral-note"
                    value={referralNote}
                    onChange={(e) => setReferralNote(e.target.value)}
                    className="in" style={{ width: "100%", height: 34, fontSize: 13 }}
                  />
                </div>
                {/* Ctrl+Enter does this too — the Keymap's "commit, a chord because it is the irreversible one". */}
                <button type="button" className="pri" style={{ alignSelf: "flex-start" }} onClick={() => void complete()}>
                  {t("opdConsult.complete")}
                  {/*
                    `aria-hidden` ON THE KEYCAPS, and it is not cosmetic. Without it this button's
                    accessible name becomes "Complete consultation Ctrl ⏎" — which is what a screen
                    reader announces, and what `getByRole("button", { name: "Complete consultation" })`
                    stops finding. A keycap is a picture of a key, not part of the button's name.
                  */}
                  <span aria-hidden="true"><span className="kb" style={{ marginLeft: 6 }}>Ctrl</span><span className="kb">⏎</span></span>
                </button>
                <ErrorLine message={completeError} />
              </div>
            </div>
          )}
        </main>
      </div>

      {/* the allergy hard-warning: a reason per matched line, then the re-post carries them (K48) */}
      <DeskModal
        open={matches !== null || interactionHits.length > 0 || duplicateHits.length > 0}
        title={t("opdConsult.overrideTitle")} titleId="override-title" testId="override-dialog"
        onClose={() => {
          setMatches(null);
          setReasons([]);
          setInteractionHits([]);
          setInteractionReasons([]);
          setDuplicateHits([]);
          setDuplicateReasons([]);
          setOverrideError(null);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          <p style={{ margin: 0, fontSize: 12.5 }}>{t("opdConsult.overrideHint")}</p>
          {(matches ?? []).map((m, i) => (
            <div key={`${String(m.lineIndex)}-${m.substance}`}>
              <label style={{ display: "block", marginBottom: 5, fontSize: 12.5, fontWeight: 600 }} htmlFor={`override-reason-${String(i)}`}>
                {t("opdConsult.overrideMatch", { n: m.lineIndex + 1, substance: m.substance })}
              </label>
              <input
                id={`override-reason-${String(i)}`}
                value={reasons[i] ?? ""}
                onChange={(e) => setReasons((rs) => rs.map((r, j) => (j === i ? e.target.value : r)))}
                className="in" style={{ width: "100%", height: 34, fontSize: 13 }}
              />
            </div>
          ))}
          {/*
            PLAN 16a T6 / DD3 — the two new kinds join the SAME dialog with the same reason input,
            because they are the same act: a clinician deciding to prescribe through a warning, and
            recording why. A separate dialog per kind would teach three different habits.
          */}
          {interactionHits.map((h, i) => (
            <div key={`ix-${String(h.lineIndex)}-${String(i)}`}>
              <label style={{ display: "block", marginBottom: 5, fontSize: 12.5, fontWeight: 600 }} htmlFor={`interaction-reason-${String(i)}`}>
                {t("opdConsult.interactionHit", { n: h.lineIndex + 1, note: h.note })}{" "}
                <span style={{ fontWeight: 400, color: "var(--dim)" }}>{againstLabel(h)}</span>
              </label>
              <input
                id={`interaction-reason-${String(i)}`}
                data-testid={`interaction-reason-${String(i)}`}
                value={interactionReasons[i] ?? ""}
                onChange={(e) => setInteractionReasons((rs) => rs.map((r, j) => (j === i ? e.target.value : r)))}
                className="in" style={{ width: "100%", height: 34, fontSize: 13 }}
              />
            </div>
          ))}
          {duplicateHits.map((h, i) => (
            <div key={`dup-${String(h.lineIndex)}-${String(i)}`}>
              <label style={{ display: "block", marginBottom: 5, fontSize: 12.5, fontWeight: 600 }} htmlFor={`duplicate-reason-${String(i)}`}>
                {t("opdConsult.duplicateHit", { n: h.lineIndex + 1, moiety: h.moiety })}{" "}
                <span style={{ fontWeight: 400, color: "var(--dim)" }}>{againstLabel(h)}</span>
              </label>
              <input
                id={`duplicate-reason-${String(i)}`}
                data-testid={`duplicate-reason-${String(i)}`}
                value={duplicateReasons[i] ?? ""}
                onChange={(e) => setDuplicateReasons((rs) => rs.map((r, j) => (j === i ? e.target.value : r)))}
                className="in" style={{ width: "100%", height: 34, fontSize: 13 }}
              />
            </div>
          ))}
          {(interactionHits.length > 0 || duplicateHits.length > 0) && (
            <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("opdConsult.inSystemOnly")}</p>
          )}
          <ErrorLine message={overrideError} />
          <button type="button" className="pri" style={{ alignSelf: "flex-start" }} onClick={() => void confirmOverride()}>{t("opdConsult.overrideConfirm")}</button>
        </div>
      </DeskModal>

      {/* THE ONLY `.print-doc` RENDER SITE ON THIS SCREEN — one nullable state, one mount. */}
      <DeskModal
        open={rxPrint !== null} title={t("opdConsult.tabs.rx")} titleId="rx-print-title" testId="rx-print-dialog"
        width={780} onClose={() => { setRxPrint(null); }}
      >
        {rxPrint !== null && <RxPrint data={rxPrint} />}
      </DeskModal>

      {/*
        THE CO-PILOT. It reads THIS consultation and says so — the queue behind the patient, the
        allergies and vitals on file, the lines written but not yet issued, the tests advised. It
        answers from the screen's own state and never from a model, which is why every answer names
        where it came from and why "I cannot answer that from this screen" is a first-class reply
        rather than a failure.
      */}
      <AgentDock
        answer={agentAnswer} log={agentLog} onAsk={ask}
        placeholder={t("opdConsult.askPlaceholder")} idle={t("opdConsult.agentIdle")}
      />
    </PaperScreen>
  );
}

/**
 * DD21's ONE panel. A component rather than an inline block because it owns a query of its own and
 * the consult screen is already 1300 lines; it is defined here rather than in `components/` because
 * nothing else mounts it and a shared component with one caller is a file nobody can change safely.
 */
export function LabResultsPanel({ visitNo }: { visitNo: string | null }): React.ReactElement | null {
  const { t } = useTranslation();
  const results = useQuery({
    queryKey: ["lab", "encounter", visitNo ?? ""],
    queryFn: () => resultsForEncounter(visitNo!),
    enabled: visitNo !== null,
    /** A 403 here means this doctor holds no `lab.results.read`; the panel simply does not render. */
    retry: false,
  });
  /**
   * 17d T5 / D6 — THE UNSIGNED NUMBERS, ASKED FOR SEPARATELY (design board EdgeCases #18).
   *
   * A SECOND query against a SECOND route, never a flag on the one above. The doctor wanting values
   * before the pathologist signs is a constant request in an Indian hospital, and the honest answer
   * is to show them with the word on them — but a screen that merged the two lists would put an
   * unsigned number in front of a prescriber wearing a signed one's clothes, which is the exact
   * harm `listResultsForEncounter`'s verified-only contract exists to prevent.
   */
  const provisional = useQuery({
    queryKey: ["lab", "encounter", visitNo ?? "", "provisional"],
    queryFn: () => provisionalResultsForEncounter(visitNo!),
    enabled: visitNo !== null,
    retry: false,
  });
  if (visitNo === null) return null;
  const rows = results.data ?? [];
  return (
    <div data-testid="lab-results" className="box" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 15px" }}>
      <h2 className="tag" style={{ margin: 0 }}>{t("lab.consult.title")}</h2>
      <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("lab.consult.unpaidNote")}</p>
      {/*
        ═══ CLOSE REVIEW (web) C1 — A FAILED QUERY IS NOT A CLINICAL NEGATIVE ═══

        This panel used to render `results.data ?? []` and print "No verified laboratory results for
        this visit" whenever the request 401'd, 403'd or 500'd. That sentence is a CLINICAL CLAIM
        made to a prescriber, and the one thing it must never mean is "the network was unhappy".
        A doctor who reads it stops looking.
      */}
      {results.isError ? (
        <p role="alert" style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--red)" }}>{t("lab.consult.unavailable")}</p>
      ) : results.isPending ? (
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>{t("lab.consult.loading")}</p>
      ) : rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>{t("lab.consult.empty")}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12.5 }}>
          {rows.map((r) => (
            <li key={`${r.orderItemId}:${r.analyteCode}`} className="drow" style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "5px 0" }}>
              <span className="mo" style={{ color: "var(--faint)" }}>{r.orderableCode}</span>
              <span>{r.analyteName}</span>
              <span className="mo" style={flagTone(r.flag) === "critical" ? { fontWeight: 700, color: "var(--red)" } : undefined}>
                {r.value} {r.unit ?? ""}
              </span>
              {r.flag !== null && r.flag !== "N" && <span style={{ fontWeight: 700, color: flagTone(r.flag) === "critical" ? "var(--red)" : "var(--gold)" }}>{r.flag}</span>}
              <span className="mo" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faint)" }}>
                {r.refLow !== null && r.refHigh !== null ? `${r.refLow} – ${r.refHigh}` : (r.refText ?? "")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/*
        ═══ THE PROVISIONAL BLOCK — ITS OWN LIST, UNDER THE SIGNED ONE, EVERY ROW STAMPED ═══

        Below the verified results and never interleaved with them: a clinician scanning the panel
        must be able to tell at a glance which numbers a pathologist has stood behind. The stamp is
        on EVERY ROW rather than once on the heading, because a heading scrolls off and a row does
        not — and this is the panel somebody reads on a phone at 21:40.

        A failed query here renders NOTHING, not an empty state: "no provisional results" is a
        clinical claim, and C1's lesson (a failed query is not a clinical negative) applies to the
        unsigned list exactly as it does to the signed one.
      */}
      {!provisional.isError && (provisional.data ?? []).length > 0 && (
        <div data-testid="lab-results-provisional" style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid var(--line)", paddingTop: 9, marginTop: 3 }}>
          <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--gold)" }}>{t("lab.consult.provisionalTitle")}</p>
          <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("lab.consult.provisionalNote")}</p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12.5 }}>
            {(provisional.data ?? []).map((r) => (
              <li key={`prov:${r.orderItemId}:${r.analyteCode}`} className="drow" style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 7, padding: "5px 0" }}>
                {/*
                  THE STAMP IS OUTLINED AND NEVER FILLED — the design system's own rule, and here it
                  earns it twice: an unsigned number must be unmistakable on a phone screen at 21:40.
                */}
                <span className="stamp" style={{ fontSize: 9.5 }}>{t("lab.consult.provisionalStamp")}</span>
                <span className="mo" style={{ color: "var(--faint)" }}>{r.orderableCode}</span>
                <span>{r.analyteName}</span>
                <span className="mo" style={flagTone(r.flag) === "critical" ? { fontWeight: 700, color: "var(--red)" } : undefined}>
                  {r.value} {r.unit ?? ""}
                </span>
                {r.flag !== null && r.flag !== "N" && <span style={{ fontWeight: 700, color: flagTone(r.flag) === "critical" ? "var(--red)" : "var(--gold)" }}>{r.flag}</span>}
                <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                  {r.refLow !== null && r.refHigh !== null ? `${r.refLow} – ${r.refHigh}` : (r.refText ?? "")}
                </span>
                <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>{fmtIst(r.enteredAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
