import { useEffect, useRef, useState } from "react";
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
import { fmtPaise } from "../lib/format";
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
  const [tab, setTab] = useState("note");
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

          {/*
            PLAN 07d T2 — QUEUE DEPTH, WHICH WAS FREE. `summaryByDoctor` has always returned
            `waitingCount`; the cockpit rendered the LIST and never the number, so a doctor deciding
            whether to take a tea break had to count rows. It is live on the same realtime topic the
            list already subscribes to.
          */}
          <div className="flex items-baseline gap-3 pt-2">
            <h2 className="text-sm font-semibold">{t("opdConsult.queue")}</h2>
            {view === null ? null : (
              <span data-testid="queue-depth" className="text-xs text-muted-foreground">
                {t("opdConsult.waitingCount", { waiting: ordered.length })}
              </span>
            )}
            {/*
              PLAN 07d T6 — THE DOCTOR'S OWN DAY, ONE CLICK AWAY. 07c built the brief and put it on
              `/my-day`; a doctor who has to navigate to it from the front door will not, mid-clinic.
            */}
            <Link to="/my-day" className="ml-auto text-xs underline">{t("opdConsult.myDay")}</Link>
          </div>
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
                      {t("opdConsult.age", { age: ageYears ?? "—" })} · {patient.data?.patient.administrativeGender ?? "—"}
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
                          <div className="space-y-1">
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
                              className="w-full rounded border px-2 py-1 text-sm"
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
                              <p data-testid={`rx-uncovered-${String(i)}`} className="text-xs text-amber-700">
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
                  {/*
                    PLAN 16a T6 / DD3 — SOFT hits. Moderate interactions, duplicates against a prior
                    prescription, duplicates across route classes. They are data: dismissible, never
                    a gate, and they carry the in-system-only honesty line (design law 10).
                  */}
                  {notices.length > 0 && !noticesDismissed && (
                    <div data-testid="rx-notices" className="mt-2 space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-sm">
                      {notices.map((hit, i) => (
                        <p key={`${String(hit.lineIndex)}-${String(i)}`} data-testid={`rx-notice-${String(i)}`}>
                          {isInteractionHit(hit)
                            ? t("opdConsult.noticeInteraction", { n: hit.lineIndex + 1, note: hit.note })
                            : t("opdConsult.noticeDuplicate", { n: hit.lineIndex + 1, moiety: hit.moiety })}
                          {" "}
                          <span className="text-neutral-600">{againstLabel(hit)}</span>
                        </p>
                      ))}
                      <p className="text-xs text-neutral-600">{t("opdConsult.inSystemOnly")}</p>
                      <Button type="button" size="sm" variant="outline" onClick={() => setNoticesDismissed(true)}>
                        {t("opdConsult.dismiss")}
                      </Button>
                    </div>
                  )}
                  <ErrorLine message={rxError} />
                </TabsContent>

                <TabsContent value="history">
                  {/*
                    PLAN 07d T1 — THREE VIEWS OF THE SAME PATIENT, and the two new ones are the point
                    of the task. Visits is what existed; prescriptions and vitals are what a doctor
                    has been unable to see since this application shipped.
                  */}
                  <div className="mb-2 flex gap-1" role="group" aria-label={t("opdConsult.historyView")}>
                    {(["visits", "rx", "vitals"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={v === historyView}
                        className={`rounded border px-2 py-0.5 text-xs ${v === historyView ? "bg-accent font-medium" : ""}`}
                        onClick={() => { setHistoryView(v); }}
                      >
                        {t(`opdConsult.history.${v}`)}
                      </button>
                    ))}
                  </div>

                  {historyView === "visits" && (
                    <ul data-testid="timeline" className="space-y-1 text-sm">
                      {timelineItems.length === 0 && <li className="text-neutral-500">{t("opdConsult.noHistory")}</li>}
                      {timelineItems.map((item) => (
                        <li key={item.encounterId} data-testid={`timeline-row-${item.encounterId}`}>
                          {item.serviceDate} · {item.departmentName ?? "—"} · {item.doctorName ?? "—"} · {item.diagnosis ?? "—"}
                        </li>
                      ))}
                    </ul>
                  )}

                  {historyView === "rx" && (
                    <div data-testid="rx-history" className="space-y-2 text-sm">
                      {rxHistory.isPending && <p className="text-neutral-500">{t("app.loading")}</p>}
                      {!rxHistory.isPending && (rxHistory.data?.items ?? []).length === 0 && (
                        <p className="text-neutral-500">{t("opdConsult.noRxHistory")}</p>
                      )}
                      {(rxHistory.data?.items ?? []).map((rx) => (
                        <div key={rx.prescriptionId} className="rounded border p-2">
                          <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
                            <span>{rx.serviceDate}</span>
                            <span>{rx.doctorName ?? "—"}</span>
                            {/*
                              A SUPERSEDED VERSION IS SHOWN AND LABELLED, never hidden. "What was
                              this patient actually given in March" may well be the superseded row,
                              and a history that showed only the live version would quietly rewrite
                              the past.
                            */}
                            {rx.status !== "active" && (
                              <span className="rounded border border-state-waiting px-1 text-state-waiting">
                                {t(`opdConsult.rxStatus.${rx.status}`)}
                              </span>
                            )}
                          </div>
                          <ul className="mt-1 space-y-0.5">
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
                    <div data-testid="vitals-history" className="space-y-1 text-sm">
                      {vitalsHistory.isPending && <p className="text-neutral-500">{t("app.loading")}</p>}
                      {!vitalsHistory.isPending && (vitalsHistory.data?.items ?? []).length === 0 && (
                        <p className="text-neutral-500">{t("opdConsult.noVitalsHistory")}</p>
                      )}
                      {/*
                        OLDEST FIRST, because this is read as a TREND and a trend read backwards is a
                        trend nobody sees. The server returns it in this order; the screen does not
                        re-sort it.
                      */}
                      {(vitalsHistory.data?.items ?? []).map((v) => (
                        <div key={v.vitalsId} className="flex flex-wrap gap-x-3 tabular-nums">
                          <span className="text-muted-foreground">{v.serviceDate}</span>
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
                            <span className="text-state-danger">{t("opdConsult.flagged")}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>

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
                <div data-testid="advised-tests" className="space-y-2 rounded border p-3">
                  <h2 className="text-sm font-medium">{t("opdConsult.advisedTests")}</h2>
                  <p className="text-xs text-muted-foreground">{t("opdConsult.advisedTestsNote")}</p>

                  <input
                    className="w-full rounded border px-2 py-1 text-sm"
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
                    <ul className="space-y-1 text-sm">
                      {serviceMatches.map((sv) => (
                        <li key={sv.serviceId}>
                          <button
                            type="button"
                            className="w-full rounded border px-2 py-1 text-left hover:bg-accent"
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
                    <p className="text-xs text-muted-foreground">{t("opdConsult.advisedTestsNoMatch")}</p>
                  )}

                  {advisedTests.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("opdConsult.advisedTestsEmpty")}</p>
                  ) : (
                    <ul data-testid="advised-chosen" className="space-y-1 text-sm">
                      {advisedTests.map((a) => (
                        <li key={a.serviceId} className="flex items-baseline gap-2">
                          <span>{a.name}</span>
                          <span className="tabular-nums text-muted-foreground">{fmtPaise(a.pricePaise)}</span>
                          <button
                            type="button"
                            className="ml-auto text-xs underline"
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
        open={matches !== null || interactionHits.length > 0 || duplicateHits.length > 0}
        onOpenChange={(open) => {
          if (!open) {
            setMatches(null);
            setReasons([]);
            setInteractionHits([]);
            setInteractionReasons([]);
            setDuplicateHits([]);
            setDuplicateReasons([]);
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
          {/*
            PLAN 16a T6 / DD3 — the two new kinds join the SAME dialog with the same reason input,
            because they are the same act: a clinician deciding to prescribe through a warning, and
            recording why. A separate dialog per kind would teach three different habits.
          */}
          {interactionHits.map((h, i) => (
            <div key={`ix-${String(h.lineIndex)}-${String(i)}`} className="space-y-1">
              <label className="block text-sm font-medium" htmlFor={`interaction-reason-${String(i)}`}>
                {t("opdConsult.interactionHit", { n: h.lineIndex + 1, note: h.note })}{" "}
                <span className="font-normal text-neutral-600">{againstLabel(h)}</span>
              </label>
              <input
                id={`interaction-reason-${String(i)}`}
                data-testid={`interaction-reason-${String(i)}`}
                value={interactionReasons[i] ?? ""}
                onChange={(e) => setInteractionReasons((rs) => rs.map((r, j) => (j === i ? e.target.value : r)))}
                className="w-full rounded border px-2 py-1"
              />
            </div>
          ))}
          {duplicateHits.map((h, i) => (
            <div key={`dup-${String(h.lineIndex)}-${String(i)}`} className="space-y-1">
              <label className="block text-sm font-medium" htmlFor={`duplicate-reason-${String(i)}`}>
                {t("opdConsult.duplicateHit", { n: h.lineIndex + 1, moiety: h.moiety })}{" "}
                <span className="font-normal text-neutral-600">{againstLabel(h)}</span>
              </label>
              <input
                id={`duplicate-reason-${String(i)}`}
                data-testid={`duplicate-reason-${String(i)}`}
                value={duplicateReasons[i] ?? ""}
                onChange={(e) => setDuplicateReasons((rs) => rs.map((r, j) => (j === i ? e.target.value : r)))}
                className="w-full rounded border px-2 py-1"
              />
            </div>
          ))}
          {(interactionHits.length > 0 || duplicateHits.length > 0) && (
            <p className="text-xs text-neutral-600">{t("opdConsult.inSystemOnly")}</p>
          )}
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
