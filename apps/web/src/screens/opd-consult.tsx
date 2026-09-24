import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { discardRxDraft, fetchRxDraft, issueRxDraft } from "../lib/opd-api";
import { UnpaidMark } from "../components/unpaid-mark";
import { VisitTypeBadge, shownVisitType } from "../components/visit-type-badge";
import { SKIP_REASONS, isInteractionHit, opdErrorMessage, todayIst } from "../lib/opd-api";
import type {
  WireDoctor, WireEncounter, WireOpdConfig, WirePatientSummary, WirePrescription, WireQueueEntry,
  WireQueueEntryView, WireQueueView, WireRxPrint, WireTimelineItem, WireVitals,
  WireDrugDiseaseHit, WireDuplicateHit, WireInteractionHit, WireRxNotice, WireSkipReason,
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
import { useCopilot } from "../lib/use-copilot";
import { CopilotReport } from "../components/copilot-report";
import { AgentDock, logged } from "../components/agent-dock";
import {
  BellIcon, ConsultSidebar, CopilotPanel, ExamSection, HistoryBrowser, NewTabIcon, NotesSection, PatientBrief, ReferPanel, SavedClock,
  SectionHistory,
  StockAlternativeCard, StockTag, SummaryView, TreatmentSection, VitalsTab, WorkStrip, useDoctorStock, useSessionToggle,
  useViewportWidth, widthBand,
} from "./opd-consult-v2";
import "./opd-consult.css";
import { recallToken, releaseLease, takeLease } from "../lib/opd-api";
import type { WorkRow } from "./opd-consult-v2";
import { CopilotSuggestions, TermInput } from "./opd-consult-suggest";
import type { WireExamFinding } from "../lib/opd-api";
import type { AgentLine } from "../components/agent-dock";
import { DeskModal } from "../components/desk-modal";
import { DrugField } from "../components/drug-field";
import { SigPanel } from "../components/sig-panel";
import type { SigPatch } from "../components/sig-panel";
import { TagField, joinTags, splitTags } from "../components/tag-field";
import { useSnippets } from "../lib/use-snippets";
import { PLACEHOLDER_FORMS, PLACEHOLDERS, expandSnippet, keywordProblem, unknownTokensIn } from "../lib/snippets";
import type { SnippetContext } from "../lib/snippets";
import { ConsultScribe } from "../components/consult-scribe";
import { completeComplaint, fetchRegimen, recogniseComplaint, suggestSyndromes } from "../lib/cds-api";
import type { WireCard, WireRegimen, WireSyndromeHit } from "../lib/cds-api";
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

type VisitDetail = {
  encounter: WireEncounter;
  /* FD-32 — the owner's warning, from the same derivation the vitals bay uses. */
  feeUnpaid?: boolean;
  feeBypass?: { by: string; reason: string; at: string } | null;
  /** The patient's own words from the front desk, who typed them and when (2026-09-23, D15). */
  deskComplaint?: { text: string; by: string; at: string } | null;
  queueEntries: WireQueueEntry[];
  vitals: WireVitals[];
  prescriptions: WirePrescription[];
  /** The CODED diagnoses. `encounter.diagnosis` is the display string and carries no codes. */
  diagnoses: { text: string; icd10Code: string | null }[];
  patient: WirePatientSummary | null;
};
type PatientDetailRow = { uhid: string; name: string | null; alias: string | null; dob: string | null; administrativeGender: string };
/** `GET /opd/advice-templates` — the hospital's library, with this doctor's own on top. */
type WireAdviceTemplate = {
  id: string; title: string; keyword: string | null;
  textEn: string | null; textHi: string | null; mine: boolean;
};
/** `GET /opd/cds/complete/allergen` — a rule class, or a moiety out of the formulary. */
type WireAllergenHit = {
  term: string; kind: "class" | "moiety"; allergenClass: string | null; saltId: string | null; blocks: string[];
};
/** `GET /opd/cds/complete/diagnosis` — one row of the ICD-10 typeahead. */
type WireIcd10Hit = { code: string; description: string; chapterNo: number; codeMatch: boolean };
type AllergyRow = {
  id: string; substance: string; severity: "mild" | "moderate" | "severe" | null; status: string;
  /**
   * The PROVENANCE, and it was on the wire all along — `listAllergies` selects the whole row and
   * this type simply never declared these. Striking a contrast reaction radiology recorded from an
   * actual administration is a different act from striking your own mis-tap of thirty seconds ago,
   * and the confirmation says which one the doctor is about to do.
   */
  source: string; recordedAt: string; correctionReason: string | null;
};
/** `GET /patients/:id/documents` — metadata only; the bytes are their own request. */
type WireDocument = {
  id: string; encounterId: string | null; kind: string; mimeType: string;
  byteSize: number; note: string | null; capturedBy: string; capturedAt: string;
};
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

/** A row the doctor has written something into. Route, frequency and the checkbox carry defaults. */
function rowHasContent(l: RxFormInput["lines"][number]): boolean {
  return l.drug.trim() !== "" || l.dose.trim() !== "" || l.instructions.trim() !== ""
    || String(l.durationDays ?? "").trim() !== "";
}

/** The written rows as one comparable value; "" means the editor holds no prescription at all. */
function rowsKey(lines: RxFormInput["lines"]): string {
  const written = lines.filter(rowHasContent);
  return written.length === 0 ? "" : JSON.stringify(written);
}

// ─────────────────────────── PLAN 16a T6 — the check-suite wire shapes ───────────────────────────

type WirePrecheck = {
  allergyMatches: AllergyMatch[];
  interactions: WireInteractionHit[];
  duplicates: WireDuplicateHit[];
  notices: WireRxNotice[];
  /** P24. Optional: an older server sends nothing, and the screen then says nothing. */
  drugDisease?: WireDrugDiseaseHit[];
  unresolvedLineIndexes: number[];
  /** Formulary phase 3. Optional: an older server sends nothing, and the screen then says nothing. */
  unreviewedLineIndexes?: number[];
};
type WireCoverage = { coverage: number; noticeEnabled: boolean };



type NoteState = { chiefComplaint: string; diagnosis: string; icd10Code: string; advice: string };
const EMPTY_NOTE: NoteState = { chiefComplaint: "", diagnosis: "", icd10Code: "", advice: "" };

/**
 * CONSULT V2 (owner, 2026-09-23) — the sections the screen was missing, saved through the SAME note route.
 * They join the body only once the visit has any of them (loaded, or touched by the doctor): a visit that
 * never uses them sends exactly the body it always sent.
 */
type StockChoice = { offeredMedicineId: string; keptMedicineId: string; chosen: "swap" | "keep" };
type V2State = {
  examination: WireExamFinding[]; treatment: string[]; doctorNote: string; internalComment: string;
  diagnosisKind: "provisional" | "final" | null; rxStockChoices: StockChoice[];
};
const EMPTY_V2: V2State = { examination: [], treatment: [], doctorNote: "", internalComment: "", diagnosisKind: null, rxStockChoices: [] };
function v2BodyOf(v: V2State, on: boolean): Record<string, unknown> {
  if (!on) return {};
  return {
    examination: v.examination, treatment: v.treatment,
    doctorNote: orNull(v.doctorNote), internalComment: orNull(v.internalComment),
    diagnosisKind: v.diagnosisKind, rxStockChoices: v.rxStockChoices,
  };
}
/** The designed tabs (Consult.dc.html). Complaints, Diagnosis and Advice are the v1 note form, split. */
type TabId = "summary" | "vitals" | "complaints" | "exam" | "dx" | "inv" | "rx" | "treat" | "advice" | "notes";

/**
 * ═══ THE DIAGNOSIS GOES UP AS A LIST, AND THE CODES RIDE WITH THEIR OWN WORDS ═══
 *
 * `TagField` hands back one joined string, which is all a complaint ever needs. A diagnosis needs
 * the code too, so the screen keeps a term -> code map of every suggestion it has been SHOWN
 * (`icdByTerm`) and pairs them back up here.
 *
 * Matching on the text rather than on "which row was tapped" is deliberate and is the more correct
 * of the two: a doctor who types "Fever, unspecified" in full has named exactly the code a doctor
 * who tapped it named, and there is no reason the record should say otherwise. A tag the map does
 * not know is uncoded — which is the ordinary case for a doctor's own words, not a failure.
 *
 * `diagnosis` and `icd10Code` are NOT sent: the server derives both from this list, so there is one
 * statement of the fact rather than three that can disagree.
 */
function noteBodyOf(n: NoteState, icdByTerm: Map<string, string>): Record<string, unknown> {
  return {
    chiefComplaint: orNull(n.chiefComplaint),
    diagnoses: splitTags(n.diagnosis).map((text) => ({
      text, icd10Code: icdByTerm.get(text.toLowerCase()) ?? null,
    })),
    advice: orNull(n.advice),
  };
}

export function OpdConsult({ focusEncounterId }: { focusEncounterId?: string } = {}): React.ReactElement {
  const { t, i18n } = useTranslation();
  /** The viewport width decides the side columns' DEFAULTS and whether an open one is a drawer (<1024). */
  const vw = useViewportWidth();
  const queryClient = useQueryClient();
  /** PLAN 07d T1 — which of the three histories the tab is showing. Drives the lazy fetches below. */
  const [historyView, setHistoryView] = useState<"visits" | "rx" | "vitals" | "documents">("visits");
  /** The document the doctor has opened. Null until they ask — the bytes are a second PHI read. */
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);
  /** PLAN 07d T5 — the tests the doctor has advised this consultation. Saved with the note. */
  const [advisedTests, setAdvisedTests] = useState<WireAdvisedTest[]>([]);
  const [testQuery, setTestQuery] = useState("");
  const today = todayIst();

  const [active, setActive] = useState<Active | null>(null);
  const [tab, setTab] = useState<TabId>("complaints");
  /*
    ═══ THE CO-PILOT (owner, 2026-09-14) ═══
    *"when doctor starts to write chief complaints, he don't need to type much, just tap and select"*
    — so the suggestions live UNDER the complaint field, appear as it is typed, and decide nothing.
  */
  const [hits, setHits] = useState<WireSyndromeHit[]>([]);
  const [regimen, setRegimen] = useState<WireRegimen | null>(null);
  const [cdsError, setCdsError] = useState<string | null>(null);
  // THE SKIP DIALOG — open on the entry being skipped, because a reason belongs to one token.
  /*
    ═══ THE ALLERGY THE DOCTOR LEARNS IN THE ROOM (owner, 2026-09-14) ═══
    The panel could only ever SHOW allergies. A doctor who is told "penicillin gave him a rash"
    mid-consultation had nowhere to put it — and it is the one fact every guardrail on this screen
    reads. `patients.update` is already the doctor's grant, so this adds a field, not an authority.
  */
  const [allergyOpen, setAllergyOpen] = useState(false);
  const [allergyText, setAllergyText] = useState("");
  const [allergySeverity, setAllergySeverity] = useState<"mild" | "moderate" | "severe">("moderate");
  const [allergyError, setAllergyError] = useState<string | null>(null);
  /*
    ═══ THE PICKED ALLERGEN, AND THE WARNING WHEN NOTHING WAS PICKED ═══

    `allergyPick` is the coded allergen the doctor chose; it is CLEARED the moment they type again,
    exactly as the drug field clears `medicineId` — a code left behind after the words changed is a
    block recorded against a substance nobody named.

    `allergyKnown` is the server's answer about the TYPED text: false means the prescription guard
    will find no rule for it. The field says so and saves anyway. Free text is legal here and must
    stay so — "the red syrup gave him a rash" is worth recording — but a doctor who writes
    `pencilin` and is told nothing has no way to know the penicillin block will never fire.
  */
  /* The advice library. Fetched once per panel — it is the hospital's list, not the patient's. */
  const [adviceSaveOpen, setAdviceSaveOpen] = useState(false);
  const [adviceSaveTitle, setAdviceSaveTitle] = useState("");
  const [adviceSaveKeyword, setAdviceSaveKeyword] = useState("");
  const [adviceRefOpen, setAdviceRefOpen] = useState(false);
  const [adviceSaveError, setAdviceSaveError] = useState<string | null>(null);
  /* The allergy being struck, and the reason the correction requires (E-8). */
  const [allergyStriking, setAllergyStriking] = useState<AllergyRow | null>(null);
  const [allergyStrikeReason, setAllergyStrikeReason] = useState("");
  const [allergyStrikeError, setAllergyStrikeError] = useState<string | null>(null);
  const [showCorrectedAllergies, setShowCorrectedAllergies] = useState(false);
  const [allergyPick, setAllergyPick] = useState<WireAllergenHit | null>(null);
  const [allergyHits, setAllergyHits] = useState<WireAllergenHit[]>([]);
  const [allergyKnown, setAllergyKnown] = useState(true);
  const [skipping, setSkipping] = useState<WireQueueEntryView | null>(null);
  const [skipReason, setSkipReason] = useState<WireSkipReason>("absent");
  const [skipNote, setSkipNote] = useState("");
  /* OWNER RULING 2026-09-20 — the held token this doctor is deciding about, and the sentence for it. */
  const [openingUnpaid, setOpeningUnpaid] = useState<WireQueueEntryView | null>(null);
  const [unpaidReason, setUnpaidReason] = useState("");
  const [note, setNote] = useState<NoteState>(EMPTY_NOTE);
  /*
    Every ICD-10 row the diagnosis field has offered, by its description. A ref rather than state:
    nothing renders from it, and re-rendering the consult panel on every keystroke of a typeahead
    is exactly the cost the typeahead exists to avoid. It grows for the life of the panel and is
    cleared with it — a few hundred short strings at the very most.
  */
  const icdByTerm = useRef(new Map<string, string>());
  const [noteSaved, setNoteSaved] = useState(false);
  const [v2, setV2] = useState<V2State>(EMPTY_V2);
  /** True once this visit has any v2 section — loaded from the server or touched here. */
  const v2On = useRef(false);
  const editV2 = (patch: Partial<V2State>): void => { v2On.current = true; setV2((cur) => ({ ...cur, ...patch })); };
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [savedAsDraft, setSavedAsDraft] = useState(false);
  /*
    THE DEFAULTS FOLLOW THE WIDTH (owner, 2026-09-23 — "I want screen to be responsive"): ≥1440 both
    side columns open; 1200–1439 the copilot folds; below 1200 both fold (below 1024 an open one is a
    drawer). A doctor's own choice, once made, is remembered for the session and wins.
  */
  const band = widthBand(vw);
  const [leftOnBrief, setLeftOnBrief] = useSessionToggle("hmis.consult.left.brief", vw >= 1200, band);
  const [leftOnConsult, setLeftOnConsult] = useSessionToggle("hmis.consult.left.consult", vw >= 1440, band);
  const [rightOpen, setRightOpen] = useSessionToggle("hmis.consult.right", vw >= 1440, band);
  const rightOpenRef = useRef(rightOpen);
  useEffect(() => { rightOpenRef.current = rightOpen; }, [rightOpen]);
  const [agentAutoFocus, setAgentAutoFocus] = useState(false);
  /** D17 — this tab's own token; the lease says whether it may write. "none" = no lease service answered, so nothing is gated. */
  const tabToken = useRef<string>(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
  );
  const [lease, setLease] = useState<"none" | "mine" | "other">("none");
  const readOnly = lease === "other";
  const leaseBody = (): Record<string, string> => (lease === "mine" ? { leaseToken: tabToken.current } : {});
  /** Zero-stock lines the doctor has already answered (Use or Keep), keyed by the medicine written. */
  const [stockAnswered, setStockAnswered] = useState<Record<string, true>>({});
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
  /**
   * ═══ WHICH PRODUCT A PICKED LINE ACTUALLY HOLDS (P27) ═══
   *
   * The line stores `medicineId` and the drug's NAME, and shows only the name — so two lines
   * reading "Paracetamol" could be the 500 and the 650 and the screen would not say which. The
   * owner's reference UI prints the shorthand under the name for exactly this reason:
   * `[500 mg | Tablet | D0230]`.
   *
   * Kept beside the form rather than in it, because it is DISPLAY and nothing reads it back: the
   * prescription posts `medicineId`, and the server resolves the product from that. Keyed on the
   * field array's own row id, not the index, so removing a line does not slide one row's shorthand
   * onto another.
   *
   * Its lifetime is deliberately the same as `medicineId`'s: set on a pick, dropped the moment the
   * text is typed over, and gone when the panel resets — a reopened draft carries neither
   * (`medicineId: null` on that path), so neither is shown, which is the honest state.
   *
   * THE `resetPanel` CLEAR IS HOUSEKEEPING, AND NO TEST GUARDS IT — said here rather than implied
   * by a green suite. An assertion was written for it and then removed for being unfailable: the
   * panel UNMOUNTS on completion, so the shorthand is absent afterwards whether or not the state
   * was cleared. It cannot leak onto the next patient either, because `useFieldArray` mints new row
   * ids on reset and a stale entry keyed by an old one can never be read. The clear stops the map
   * growing across a session; it is not load-bearing, and claiming a test for it would be worse
   * than having none.
   */
  const [shorthand, setShorthand] = useState<Record<string, { strength: string | null; form: string; code: string | null }>>({});
  /**
   * Rows a regimen filled that NO catalogue product matched, by field-array row id. The line is
   * still legal free text; the cue says the checks cannot see it until the doctor picks. It goes
   * the moment a pick lands on that row, and with the panel.
   */
  const [needsPick, setNeedsPick] = useState<Record<string, true>>({});
  const [notices, setNotices] = useState<WireRxNotice[]>([]);
  const [noticesDismissed, setNoticesDismissed] = useState(false);
  /** P24 — soft drug-disease hits, shown beside the notices; the severe ones go to the dialog. */
  const [diseaseNotices, setDiseaseNotices] = useState<WireDrugDiseaseHit[]>([]);
  const [diseaseHits, setDiseaseHits] = useState<WireDrugDiseaseHit[]>([]);
  const [diseaseReasons, setDiseaseReasons] = useState<string[]>([]);
  /** Line indexes the formulary could not resolve — the coverage-gated hint reads this (DD5). */
  const [unresolvedLines, setUnresolvedLines] = useState<number[]>([]);
  /**
   * Formulary phase 3: lines the server checked only in part, because a component is one pharmacy
   * has not reviewed (no drug class, no interaction pairs). Not coverage-gated like the hint above:
   * it is not a guess about the formulary, it is the server saying what it could not see.
   */
  const [unreviewedLines, setUnreviewedLines] = useState<number[]>([]);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [rxPrint, setRxPrint] = useState<WireRxPrint | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [testsOrdered, setTestsOrdered] = useState(false);
  const [admissionAdvised, setAdmissionAdvised] = useState(false);
  const [referralTo, setReferralTo] = useState("");
  const [referralNote, setReferralNote] = useState("");
  const [referOpen, setReferOpen] = useState(false);
  const [referDone, setReferDone] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const lastSavedNote = useRef<string>(JSON.stringify(noteBodyOf(EMPTY_NOTE, new Map())));
  /** The PARSED lines of a refused submission — never `getValues()`, whose durationDays is a string (§3.19). */
  const pendingLines = useRef<RxLineValues[]>([]);
  /**
   * PRODUCTION 2026-09-23 — the rows as they stood when the last issue SUCCEEDED (null: nothing
   * issued this consultation). Complete compares the editor against it: a non-empty editor that
   * differs has not reached the pharmacy, and Complete must issue it rather than drop it.
   */
  const [issuedRowsKey, setIssuedRowsKey] = useState<string | null>(null);
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
  /*
   * PLAN 16a T6's whole-formulary fetch is GONE. It pulled every branded medicine, unpaginated, on
   * every consultation — safe only while the table was empty. After the owner's catalogue import
   * that is 103,383 rows and ~15 MB on every load of this screen: measured, not feared.
   *
   * TWO SEARCH ROUTES NOW EXIST AND THIS SCREEN USES ONE. `/formulary/suggest` (#186) reads the
   * NRCeS generic tier and deliberately fills the NAME only; `/formulary/medicines/search` reads
   * the imported catalogue — brands included — and fills the name AND the `medicineId` that the
   * interaction, duplicate and allergy checks need in order to say anything at all. The owner's
   * ruling of 2026-09-14 is one drug list feeding one safety layer, so the field is `DrugField`
   * over the second. `DrugCombobox` and its suite stay in the tree, unwired, until that
   * duplication is settled deliberately rather than by a rebase.
   *
   * Design law 1 still holds at the transport layer: if that request fails, the field is a plain
   * text box and free typing is legal.
   */
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
  /*
    ═══ THE ROWS THE RAIL NEVER RENDERED (owner report, 2026-09-13) ═══

    `inConsult` has been on this wire since the queue view existed and NOTHING read it. So a doctor
    who called the next token while somebody was still with them — the only way to move on, there
    being no park button — watched that patient disappear: the encounter was open, the token was
    live, the half-written note was on the server, and no screen in the building showed a way back
    to them. Both halves of the fix meet here. The list below renders these rows, and each one is a
    door back into the consultation.
  */
  const inConsult = view?.inConsult ?? [];
  /*
    THE TOKENS THAT FELL OUT. Three skips and a patient is `left` — and `left` was rendered by no
    screen in this application, so the owner's own afternoon produced a patient whose ENTRY said she
    had gone and whose VISIT said she was waiting, callable by nobody and findable by nobody. The
    rail carries them now, because the doctor who lost her is the one standing next to her.
  */
  const leftQueue = view?.left ?? [];
  /*
    ═══ THE TOKENS WITH THE CASHIER (OWNER RULING 2026-09-20) ═══

    *"It waits for bill to be paid until doctor opens the token from his dashboard manually.
    Currently the doctor have no screen to do it."* This is that screen. They are waiting, their
    vitals are charted, and their fee is unsettled — so the server keeps them out of `ordered`,
    `callNext` cannot reach them and the hall's board never announces them. The doctor sees them
    anyway, because the whole ruling is that THIS person decides, patient by patient.

    `?? []` is not defensive habit: a tab left open across the deploy that adds the field talks to a
    server that does not send it, and the right answer there is no group rather than a crash.
  */
  const heldForPayment = view?.heldForPayment ?? [];
  /*
    A ROW IS HELD ONLY IF THE SERVER SAID SO, IN WORDS. The field is typed `string | null`, and the
    one moment it is neither is the deploy window: a tab talking to the previous build gets a queue
    view with no `parkedAt` at all, and `!== null` would read every patient in consultation as
    parked — a wrong statement about where a patient is, on the screen that answers that question.
  */
  const parkedSince = (e: WireQueueEntryView): string | null => (typeof e.parkedAt === "string" ? e.parkedAt : null);

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
  /*
    THE ADVICE LIBRARY. No patient in the key and no patient in the request: a template is the
    doctor's words about a CONDITION, not about a person, so this is cached for the session rather
    than refetched per patient.
  */
  const adviceTemplates = useQuery({
    queryKey: ["opd", "advice-templates"],
    queryFn: () => api<{ items: WireAdviceTemplate[] }>("GET", "/opd/advice-templates"),
    staleTime: 5 * 60 * 1000,
  });

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

  /*
    ═══ THE SLIP THE DESK PHOTOGRAPHED ═══

    Owner, 2026-09-14: the desk outside the room photographs the paper prescription, and the doctor
    sees it here. The LIST is metadata only — what exists, when, and how big; opening one is a
    separate request because the bytes are a separate PHI read with its own access-log surface.
    Scrolling past a list of slips and reading a patient's prescription are different acts, and the
    log is kept to answer which one happened.
  */
  const documents = useQuery({
    queryKey: ["patient-documents", patientId ?? ""],
    queryFn: () => api<{ items: WireDocument[] }>("GET", `/patients/${patientId ?? ""}/documents`),
    enabled: patientId !== null && historyView === "documents",
  });
  const openDocument = useQuery({
    queryKey: ["patient-document", openDocumentId ?? ""],
    queryFn: () => api<{ mimeType: string; imageBase64: string }>("GET", `/patients/documents/${openDocumentId ?? ""}`),
    enabled: openDocumentId !== null,
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
  const correctedAllergies = (allergies.data?.items ?? []).filter((a) => a.status === "entered_in_error");
  const dob = patient.data?.patient.dob ?? null;
  const ageYears = dob !== null ? ageYearsAt(dob, new Date()) : null;
  const timelineItems = timeline.data?.items ?? [];

  // The note mirrors the encounter the server already holds; the visit query is its source of truth.
  useEffect(() => {
    if (encounter === null || loadedNoteFor.current === encounter.id) return;
    loadedNoteFor.current = encounter.id;
    /*
      ═══ THE DESK'S WORDS ARE A RECORDED FACT, NOT THE DOCTOR'S ENTRY (owner's walk, 2026-09-23) ═══

      Splitting the desk's sentence at commas put fragments like "ek hafte se. Subah zyada." into
      the complaint. The sentence is now shown verbatim above the field, and the complaints the
      hospital's vocabulary RECOGNISES in it are offered as dashed suggestions the doctor taps
      (`deskHeard`, below). Nothing is entered until the doctor taps; nothing unrecognised is offered.
    */
    const next: NoteState = {
      chiefComplaint: encounter.chiefComplaint ?? "",
      diagnosis: encounter.diagnosis ?? "",
      icd10Code: encounter.icd10Code ?? "",
      advice: encounter.advice ?? "",
    };
    /*
      REHYDRATE THE CODES BEFORE THE NOTE IS TOUCHED. `encounter.diagnosis` is the display string
      and carries no codes; the visit read returns the coded rows beside it precisely so that
      reopening a note and changing one word does not send back uncoded tags and replace the
      coding. Seeding the map here is the client half of that seam.
    */
    for (const d of visit.data?.diagnoses ?? []) {
      if (d.icd10Code !== null) icdByTerm.current.set(d.text.toLowerCase(), d.icd10Code);
    }
    setNote(next);
    const loadedV2: V2State = {
      examination: encounter.examination ?? [], treatment: encounter.treatment ?? [],
      doctorNote: encounter.doctorNote ?? "", internalComment: encounter.internalComment ?? "",
      diagnosisKind: encounter.diagnosisKind ?? null,
      rxStockChoices: Array.isArray(encounter.rxStockChoices)
        ? (encounter.rxStockChoices as StockChoice[]).map((c) => ({ offeredMedicineId: c.offeredMedicineId, keptMedicineId: c.keptMedicineId, chosen: c.chosen }))
        : [],
    };
    v2On.current = loadedV2.examination.length > 0 || loadedV2.treatment.length > 0 || loadedV2.doctorNote !== ""
      || loadedV2.internalComment !== "" || loadedV2.diagnosisKind !== null || loadedV2.rxStockChoices.length > 0;
    setV2(loadedV2);
    setStockAnswered(Object.fromEntries(loadedV2.rxStockChoices.map((c) => [c.chosen === "keep" ? c.keptMedicineId : c.offeredMedicineId, true as const])));
    lastSavedNote.current = JSON.stringify({ ...noteBodyOf(next, icdByTerm.current), ...v2BodyOf(loadedV2, v2On.current) });
  }, [encounter, visit.data]);

  const rxForm = useForm<RxFormInput, unknown, RxFormValues>({
    resolver: zodResolver(rxSchema),
    defaultValues: { lines: [EMPTY_LINE] },
  });
  const lines = useFieldArray({ control: rxForm.control, name: "lines" });
  /* The regimen fill's marks, applied to the rows `reset` just minted (see `fillFromRegimen`). */
  const pendingFillMarks = useRef<{ shorthand: { strength: string | null; form: string; code: string | null } | null; needsPick: boolean }[] | null>(null);
  useEffect(() => {
    const marks = pendingFillMarks.current;
    if (marks === null || lines.fields.length !== Math.max(marks.length, 1)) return;
    pendingFillMarks.current = null;
    const nextShorthand: Record<string, { strength: string | null; form: string; code: string | null }> = {};
    const nextNeedsPick: Record<string, true> = {};
    marks.forEach((m, i) => {
      const id = lines.fields[i]?.id;
      if (id === undefined) return;
      if (m.shorthand !== null) nextShorthand[id] = m.shorthand;
      if (m.needsPick) nextNeedsPick[id] = true;
    });
    setShorthand(nextShorthand);
    setNeedsPick(nextNeedsPick);
  }, [lines.fields]);
  /* The label follows what Complete will do: "Issue & complete" while written rows are un-issued. */
  const rxWaiting = (() => { const k = rowsKey(rxForm.watch("lines")); return k !== "" && k !== issuedRowsKey; })();

  // ——— CONSULT V2: stock beside each medicine, and the alternative at zero (D13, D14) ———
  const watchedLines = rxForm.watch("lines");
  /* the complaints the vocabulary recognises in the desk's sentence — offered, never entered */
  const deskText = visit.data?.deskComplaint?.text ?? "";
  const deskHeard = useQuery({
    queryKey: ["opd", "desk-heard", deskText], enabled: deskText.trim() !== "", staleTime: 60_000,
    queryFn: () => recogniseComplaint(deskText),
  });
  /** The Rx line being edited; every other FINISHED line (drug and days) shows as its card. */
  const [rxOpen, setRxOpen] = useState<number | null>(null);
  const rxFolded = (i: number): boolean => {
    const l = watchedLines[i];
    return rxOpen !== i && l !== undefined && l.drug.trim() !== "" && String(l.durationDays ?? "").trim() !== "";
  };
  const stockByMedicine = useDoctorStock(watchedLines.map((l) => l.medicineId ?? ""));
  const stockAlerts = watchedLines.flatMap((l, index) => {
    const id = l.medicineId ?? "";
    const st = id === "" ? undefined : stockByMedicine.get(id);
    return st !== undefined && st.available === 0 && stockAnswered[id] !== true ? [{ index, drug: l.drug, stock: st }] : [];
  });
  const recordChoice = (c: StockChoice): void => {
    const rest = v2.rxStockChoices.filter((x) => !(x.offeredMedicineId === c.offeredMedicineId && x.keptMedicineId === c.keptMedicineId));
    editV2({ rxStockChoices: [...rest, c] });
  };
  const pickAlternative = (index: number, writtenId: string, altId: string, label: string): void => {
    rxForm.setValue(`lines.${index}.medicineId`, altId, { shouldDirty: true });
    rxForm.setValue(`lines.${index}.drug`, label, { shouldDirty: true });
    setStockAnswered((a) => ({ ...a, [writtenId]: true }));
    recordChoice({ offeredMedicineId: altId, keptMedicineId: altId, chosen: "swap" });
  };
  const keepWritten = (st: { medicineId: string; alternatives: { medicineId: string }[] }): void => {
    setStockAnswered((a) => ({ ...a, [st.medicineId]: true }));
    const offered = st.alternatives[0]?.medicineId;
    if (offered !== undefined) recordChoice({ offeredMedicineId: offered, keptMedicineId: st.medicineId, chosen: "keep" });
  };

  // ——— CONSULT V2: "your work so far" — one line per section, visible on every tab ———
  const splitList = (x: string): string[] => splitTags(x);
  const workRows: WorkRow[] = [
    { id: "complaints", label: t("opdConsultV2.sec.complaints"), text: splitList(note.chiefComplaint).join(" · "), count: splitList(note.chiefComplaint).length },
    { id: "exam", label: t("opdConsultV2.sec.exam"), text: v2.examination.map((f) => f.text).join(" · "), count: v2.examination.length },
    {
      id: "dx", label: t("opdConsultV2.sec.dx"),
      text: splitList(note.diagnosis).length === 0 ? "" : `${v2.diagnosisKind === null ? "" : `${t(`opdConsultV2.kind.${v2.diagnosisKind}`)}: `}${splitList(note.diagnosis).join(" · ")}`,
      count: splitList(note.diagnosis).length,
    },
    { id: "inv", label: t("opdConsultV2.sec.inv"), text: advisedTests.map((x) => x.name).join(" · "), count: advisedTests.length },
    { id: "rx", label: t("opdConsultV2.sec.rx"), text: watchedLines.filter((l) => l.drug.trim() !== "").map((l) => `${l.drug.trim()} ${l.frequency}`).join(" · "), count: watchedLines.filter((l) => l.drug.trim() !== "").length },
    { id: "treat", label: t("opdConsultV2.sec.treat"), text: v2.treatment.join(" · "), count: v2.treatment.length },
    { id: "advice", label: t("opdConsultV2.sec.advice"), text: note.advice.trim(), count: note.advice.trim() === "" ? 0 : 1 },
    {
      id: "notes", label: t("opdConsultV2.sec.notes"),
      text: [v2.doctorNote.trim(), v2.internalComment.trim()].filter((x) => x !== "").join(" · "),
      count: [v2.doctorNote, v2.internalComment].filter((x) => x.trim() !== "").length,
    },
  ];
  const goToSection = (id: string): void => {
    const tabFor: Record<string, TabId> = { complaints: "complaints", dx: "dx", advice: "advice", inv: "inv", exam: "exam", rx: "rx", treat: "treat", notes: "notes" };
    setTab(tabFor[id] ?? "complaints");
    const anchorFor: Record<string, string> = { complaints: "note-chief", dx: "note-diagnosis", advice: "note-advice" };
    setTimeout(() => {
      const el = id === "inv" ? document.querySelector('[data-testid="advised-tests"]') : anchorFor[id] !== undefined ? document.getElementById(anchorFor[id]!) : null;
      if (el instanceof HTMLElement && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
  };
  const tabHas = (id: TabId): boolean => {
    const map: Partial<Record<TabId, string[]>> = { complaints: ["complaints"], dx: ["dx"], inv: ["inv"], advice: ["advice"], exam: ["exam"], rx: ["rx"], treat: ["treat"], notes: ["notes"] };
    const ids = map[id] ?? [];
    return workRows.some((r) => ids.includes(r.id) && r.count > 0);
  };

  /* F2 opens a minimised copilot and lands in its ask box; an open one is the dock's own F2. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "F2" || rightOpenRef.current) return;
      e.preventDefault();
      setAgentAutoFocus(true);
      setRightOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the setter is stable for the screen's life
  }, []);

  /*
    ═══ FD-30 — THE DOOR'S SLIP, AND THE TAP THAT ISSUES IT (OWNER RULING 2026-09-12) ═══

    Keyed on the encounter in hand, so a doctor moving down the bench never sees the previous
    patient's slip. `retry: false` because a visit with no draft is the ordinary case and a 404 is
    the ordinary answer — retrying it three times would put three requests behind every consult.
  */
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const draft = useQuery({
    queryKey: ["opd", "rx-draft", active?.encounterId ?? ""],
    queryFn: () => fetchRxDraft(active!.encounterId),
    enabled: active?.encounterId !== undefined,
    retry: false,
  });

  const issueTheDraft = async (): Promise<void> => {
    const encounterId = active?.encounterId;
    if (encounterId === undefined || draftBusy) return;
    setDraftBusy(true);
    setDraftError(null);
    try {
      await issueRxDraft(encounterId);
      await queryClient.invalidateQueries({ queryKey: ["opd", "rx-draft", encounterId] });
      await queryClient.invalidateQueries({ queryKey: ["opd", "rx-history"] });
    } catch (e) {
      /*
        A REFUSED TAP IS A CLINICAL ANSWER, and the draft is deliberately still there afterwards
        (`issueDraft` marks it issued only after the prescription exists). The doctor's next act is
        to load it into the editor, where the override dialogs are — which is what the message says.
      */
      const body = e instanceof ApiError ? (e.body as { message?: string } | null) : null;
      setDraftError(`${body?.message ?? (e instanceof Error ? e.message : String(e))} — ${t("opdConsult.draft.refusedHint")}`);
    } finally {
      setDraftBusy(false);
    }
  };

  const discardTheDraft = async (): Promise<void> => {
    const encounterId = active?.encounterId;
    if (encounterId === undefined || draftBusy) return;
    setDraftBusy(true);
    setDraftError(null);
    try {
      await discardRxDraft(encounterId);
      await queryClient.invalidateQueries({ queryKey: ["opd", "rx-draft", encounterId] });
    } catch (e) {
      setDraftError(String(e));
    } finally {
      setDraftBusy(false);
    }
  };

  /**
   * ONE READ PER PAUSE, NOT ONE PER KEYSTROKE. The route is a keyword match over eight syndromes
   * and costs nothing, but a request per character would still put the network in front of a
   * doctor's typing — 250 ms after they stop is invisible to a human and is one call.
   *
   * It sends the complaint and NOTHING about the patient: this read sees no PHI at all, which is
   * why it can be this eager in the first place.
   */
  useEffect(() => {
    const q = note.chiefComplaint.trim();
    if (q.length < 3) { setHits([]); return; }
    const timer = setTimeout(() => {
      void suggestSyndromes(q)
        .then((r) => { setHits(r.items); })
        .catch(() => { setHits([]); }); // an advisor that fails is silent, never an error the doctor must dismiss
    }, 250);
    return () => { clearTimeout(timer); };
  }, [note.chiefComplaint]);

  /** Tapping a syndrome asks the server to build it FOR THIS PATIENT — weight, age, allergies and all. */
  const openRegimen = async (key: string, pregnant?: boolean): Promise<void> => {
    if (active === null) return;
    setCdsError(null);
    try {
      setRegimen(await fetchRegimen(key, active.encounterId, pregnant));
    } catch (e) {
      setRegimen(null);
      setCdsError(opdErrorMessage(e));
    }
  };

  /**
   * ═══ 1-TAP: THE FORM IS FILLED, THE PRESCRIPTION IS NOT ISSUED ═══
   *
   * It writes the draft into the prescription form and moves the doctor to it. Nothing is sent:
   * `issuePrescription` still runs every allergy, interaction and duplicate check at issue time,
   * and a line the co-pilot refused to dose carries the REASON in its dose field rather than a
   * number — so a doctor who taps fill and issues without reading still cannot print a dose that
   * nobody stands behind.
   */
  /*
    ═══ A FILLED LINE CARRIES THE MEDICINE, AS A PICK DOES (production, 2026-09-23) ═══

    It used to fill `medicineId: null` on every line, so a regimen-filled prescription reached the
    pharmacy — and the issue-time allergy, interaction and duplicate checks — as free text none of
    them could resolve. The server now names the product per line and this carries its id, the
    shorthand a pick would show, and — for a line nothing matched — a quiet cue to pick one.

    The row ids those two maps are keyed on do not exist until `reset` has rendered, so the marks
    wait in a ref for the next `fields` and are applied there, keyed by id like every pick is.
  */
  const fillFromRegimen = (): void => {
    if (regimen === null) return;
    const lines = regimen.regimen.lines.map((l) => ({
      drug: l.rx.drug, dose: l.rx.dose, route: l.rx.route, frequency: l.rx.frequency,
      durationDays: l.rx.durationDays === null ? "" : String(l.rx.durationDays),
      instructions: l.rx.instructions, noSubstitution: l.rx.noSubstitution, medicineId: l.rx.medicineId ?? null,
    }));
    pendingFillMarks.current = regimen.regimen.lines.map((l) => ({
      shorthand: l.product == null || l.rx.medicineId == null ? null : { strength: l.product.strength, form: l.product.form, code: l.product.code },
      needsPick: l.needsPick === true,
    }));
    rxForm.reset({ lines: lines.length === 0 ? [EMPTY_LINE] : lines });
    setTab("rx");
  };

  /**
   * CONSULT V2 PR 3 — the copilot's suggestions in ONE element, mounted in the copilot column when it is
   * open and at the head of the Note or Rx tab when it is folded (owner, round 4). Never both.
   */
  const suggestionsFor = (variant: "pane" | "inline"): React.ReactElement | null => {
    if (active === null) return null;
    return (
      <CopilotSuggestions
        variant={variant} hits={hits}
        diagnoses={splitTags(note.diagnosis).map((text) => ({ text, icd10: icdByTerm.current.get(text.toLowerCase()) ?? null }))}
        onAddDx={(name, icd10) => {
          if (icd10 !== null) icdByTerm.current.set(name.toLowerCase(), icd10);
          setNote((n) => (splitTags(n.diagnosis).some((x) => x.toLowerCase() === name.toLowerCase()) ? n : { ...n, diagnosis: joinTags([...splitTags(n.diagnosis), name]) }));
        }}
        advised={advisedTests}
        onAddTest={(test) => { if (!advisedTests.some((a) => a.serviceId === test.serviceId)) void saveAdvised([...advisedTests, test]); }}
        regimen={regimen}
        onOpenRegimen={(key) => { if (regimen?.regimen.syndrome.key !== key) void openRegimen(key); }}
        onFillRx={fillFromRegimen}
      />
    );
  };

  const resetPanel = (): void => {
    setRxOpen(null);
    loadedNoteFor.current = null;
    /* The map is the PATIENT'S, not the screen's — carrying it to the next patient would attach one
       patient's ICD-10 code to another's identically-worded diagnosis. `resetPanel` has forgotten
       newly-added state before (the T6 allergy fields); this is the line that stops it happening. */
    icdByTerm.current = new Map();
    lastSavedNote.current = JSON.stringify(noteBodyOf(EMPTY_NOTE, new Map()));
    setNote(EMPTY_NOTE);
    setNoteSaved(false);
    v2On.current = false;
    setV2(EMPTY_V2);
    setSavedAt(null);
    setSavedAsDraft(false);
    setStockAnswered({});
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
    setShorthand({});
    setNeedsPick({});
    setNotices([]);
    setNoticesDismissed(false);
    setDiseaseNotices([]);
    setDiseaseHits([]);
    setDiseaseReasons([]);
    setUnresolvedLines([]);
    setUnreviewedLines([]);
    setFollowUp("");
    setTestsOrdered(false);
    setAdmissionAdvised(false);
    setReferralTo("");
    setReferralNote("");
    setTab("complaints");
    setHits([]);
    setRegimen(null);
    setCdsError(null);
    rxForm.reset({ lines: [EMPTY_LINE] });
    setIssuedRowsKey(null);
  };

  // ——— the queue actions ———

  const invalidateQueue = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["opd", "queue"] });
  };

  const recallOf = async (e: WireQueueEntryView): Promise<void> => {
    setQueueError(null);
    try {
      await recallToken(e.id);
      setAgentLog((l) => logged(l, t("opdConsultV2.recalledLog", { token: e.tokenNo }), "ok"));
      await invalidateQueue();
    } catch (err) {
      setQueueError(opdErrorMessage(err));
    }
  };

  const callNext = async (): Promise<void> => {
    if (view === null) return;
    setQueueError(null);
    try {
      await api("POST", `/opd/queues/${view.session.id}/call-next`);
      setBriefEntry(null);
      await invalidateQueue();
    } catch (e) {
      setQueueError(opdErrorMessage(e));
    }
  };

  /**
   * ═══ SKIP ASKS WHY, AND THAT IS THE WHOLE CHANGE HERE (owner, 2026-09-13) ═══
   *
   * *"doctors do not have any input box or pre-identified reason to select … it should be
   * auditable. right?"* The button no longer posts: it opens the dialog on the token in the chair,
   * and the post happens when a reason has been picked. The default is `absent` because that is
   * what a skip usually means — a default that is right most of the time is what keeps a reason
   * field from becoming a shrug — and every other reason is one click away.
   */
  /*
    THE ALLERGY TYPEAHEAD'S ONE REQUEST, DEBOUNCED. Same shape as `TagField`'s: a 120 ms pause, and
    a guard on `asked` so a slow answer to an old prefix cannot overwrite a newer one. Three
    characters is the floor — `pe` would return a fifth of the moiety table.
  */
  const allergyAsked = useRef("");
  useEffect(() => {
    const q = allergyText.trim();
    allergyAsked.current = q;
    if (!allergyOpen || q.length < 3) { setAllergyHits([]); setAllergyKnown(true); return; }
    let live = true;
    const timer = setTimeout(() => {
      void api<{ items: WireAllergenHit[]; known: boolean }>(
        "GET", `/opd/cds/complete/allergen?q=${encodeURIComponent(q)}`,
      )
        .then((r) => {
          if (!live || allergyAsked.current !== q) return;
          setAllergyHits(r.items);
          setAllergyKnown(r.known);
        })
        /* Design law 1 at the transport layer: a field whose suggester is down is a plain text box
           that still saves. It must NOT start warning about every allergy because a route is 500. */
        .catch(() => { if (live) { setAllergyHits([]); setAllergyKnown(true); } });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [allergyText, allergyOpen]);

  /**
   * ═══ TAPPING A TEMPLATE APPENDS; IT NEVER REPLACES ═══
   *
   * A doctor builds advice out of two or three of these plus a line of their own, so the text lands
   * at the end of what is already there. Replacing would throw away typing on a mis-tap, and this
   * box is the one the patient reads.
   *
   * The SCRIPT is the doctor's choice per template (owner ruling, 2026-09-14) — whichever button
   * they press is the string that goes in, and it goes in verbatim. Nothing translates at print
   * time: `rx-print.tsx` prints `encounter.advice` exactly as stored, so the script has to be in
   * the stored value or it never reaches the patient.
   */
  /**
   * ═══ WHAT A PLACEHOLDER RESOLVES AGAINST: THE PATIENT IN THE CHAIR ═══
   *
   * This is the whole reason a snippet is worth more here than in a generic tool. Raycast's
   * placeholders come from the machine — clipboard, date, uuid. These come from the record open on
   * the screen, so `{weight}` is the number the bay charted this morning and `{date+7}` is the
   * follow-up the doctor is about to say out loud.
   *
   * Everything here is ALREADY FETCHED for the panel. A snippet adds no request and no permission;
   * it reads what the doctor is already looking at.
   */
  const snippetContext: SnippetContext = {
    patient: patient.data === undefined ? null : {
      name: patient.data.patient.name,
      uhid: patient.data.patient.uhid,
      ageYears,
      sex: patient.data.patient.administrativeGender,
    },
    vitals: latestVitals === null ? null : {
      weightKg: latestVitals.weightKg, heightCm: latestVitals.heightCm,
      sbp: latestVitals.sbp, dbp: latestVitals.dbp, pulse: latestVitals.pulse,
      spo2: latestVitals.spo2, tempC: latestVitals.tempC,
    },
    note: { complaint: note.chiefComplaint, diagnosis: note.diagnosis },
    doctor: { name: me.data?.displayName ?? null },
    now: new Date(),
  };

  /**
   * Every snippet this doctor can TYPE. A template with both scripts is offered under its keyword
   * in English and under `keyword.hi` in Hindi — one stored keyword and a documented suffix, rather
   * than a second column or a guess about which script the doctor meant.
   */
  const typedSnippets = (adviceTemplates.data?.items ?? []).flatMap((tpl) => {
    if (tpl.keyword === null || tpl.keyword === "") return [];
    const out: { keyword: string; body: string }[] = [];
    if (tpl.textEn !== null) out.push({ keyword: tpl.keyword, body: tpl.textEn });
    if (tpl.textHi !== null) out.push({ keyword: `${tpl.keyword}.hi`, body: tpl.textHi });
    return out;
  });

  const adviceSnippets = useSnippets({
    value: note.advice,
    onChange: (next) => { setNote((n) => ({ ...n, advice: next })); },
    snippets: typedSnippets,
    context: snippetContext,
  });

  const appendAdvice = (body: string): void => {
    /*
      A TAPPED template goes through the same engine as a typed keyword, so `{name}` and `{date+7}`
      resolve either way. One path, so a template cannot behave differently depending on how the
      doctor reached for it — which is the kind of difference nobody discovers until a slip is wrong.
    */
    const { text } = expandSnippet(body, snippetContext);
    setNote((n) => ({ ...n, advice: n.advice.trim() === "" ? text : `${n.advice.trim()}\n${text}` }));
  };

  /**
   * Save what is in the box as one of MY templates. The script is decided by what was written, not
   * by a dropdown: Devanagari goes to the Hindi column and anything else to the English one. A
   * doctor who writes their advice in Hindi must not have it filed under an English button — the
   * first cut of this table had `text_en NOT NULL` and would have done exactly that.
   */
  const saveAdviceTemplate = async (): Promise<void> => {
    const title = adviceSaveTitle.trim();
    const text = note.advice.trim();
    if (title === "" || text === "") return;
    setAdviceSaveError(null);
    try {
      const devanagari = /[\u0900-\u097F]/.test(text);
      await api("POST", "/opd/advice-templates", {
        title,
        keyword: adviceSaveKeyword.trim() === "" ? null : adviceSaveKeyword.trim(),
        textEn: devanagari ? null : text,
        textHi: devanagari ? text : null,
      });
      setAdviceSaveTitle("");
      setAdviceSaveKeyword("");
      setAdviceSaveOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["opd", "advice-templates"] });
    } catch (e) {
      setAdviceSaveError(opdErrorMessage(e));
    }
  };

  /**
   * ═══ STRIKING A WRONG ALLERGY — A CORRECTION, NOT A DELETE ═══
   *
   * Owner, 2026-09-14: *"I added a wrong allergy to the patient. Now I cannot delete it."* The
   * route to fix it has existed since E-8 and is on `patient-detail.tsx` — it was simply not on the
   * screen where the mistake is MADE, so a doctor had to leave a consultation to undo a mis-tap.
   * That asymmetry arrived with "record an allergy in the room": the writer shipped and the
   * corrector did not.
   *
   * IT IS NOT A DELETE AND MUST NOT BECOME ONE. `patient-detail.tsx` already states the rule —
   * allergies are append-only with an entered-in-error correction. The row keeps who struck it,
   * when and why, and an allergy that was claimed and withdrawn is exactly what the next clinician
   * needs to see if the patient turns out to have reacted after all. A row that can vanish tells
   * them nothing at all.
   *
   * The doctor loses nothing by it: `activeAllergies` and the co-pilot's own read both filter on
   * `status === "active"`, so a struck allergy stops warning immediately — which is the whole of
   * what "delete" was being asked for.
   *
   * The REASON is mandatory server-side (E-8) and the button stays disabled without one. No new
   * permission: `patients.update` is the same grant that let the doctor add it.
   */
  const strikeAllergy = async (): Promise<void> => {
    const target = allergyStriking;
    const reason = allergyStrikeReason.trim();
    if (target === null || reason === "" || patientId === null) return;
    setAllergyStrikeError(null);
    try {
      await api("POST", `/patients/${patientId}/allergies/${target.id}/entered-in-error`, { reason });
      setAllergyStriking(null);
      setAllergyStrikeReason("");
      await queryClient.invalidateQueries({ queryKey: ["patient-allergies", patientId] });
      /*
        THE SAME SEAM `addAllergy` HAS. The co-pilot's danger cards are computed FROM the allergy
        list, so a strike that did not re-ask would leave a red card on screen naming an allergy
        the record no longer holds — and the doctor would be reading a warning about nothing while
        believing it current.
      */
      if (regimen !== null) await openRegimen(regimen.regimen.syndrome.key, regimen.facts.pregnant ?? undefined);
    } catch (e) {
      setAllergyStrikeError(opdErrorMessage(e));
    }
  };

  const addAllergy = async (): Promise<void> => {
    const substance = allergyText.trim();
    if (substance === "" || patientId === null) return;
    setAllergyError(null);
    try {
      /* `source: "consult"` is one of the three the route accepts, and it is the true one: this
         allergy was learnt at the consultation, not at registration and not at the bay. */
      /*
        THE CODE RIDES ONLY WHEN IT BELONGS TO THESE WORDS. `allergyPick` is cleared on every
        keystroke, so a doctor who picks "Penicillins / Beta-Lactams" and then edits the text saves
        free text — never the class they had stopped agreeing with.
      */
      const picked = allergyPick !== null && allergyPick.term.toLowerCase() === substance.toLowerCase()
        ? { saltId: allergyPick.saltId, allergenClass: allergyPick.allergenClass }
        : {};
      await api("POST", `/patients/${patientId}/allergies`, {
        substance, severity: allergySeverity, source: "consult", ...picked,
      });
      setAllergyText("");
      setAllergyPick(null);
      setAllergyHits([]);
      setAllergyKnown(true);
      setAllergyOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["patient-allergies", patientId] });
      /* The co-pilot's cards are computed FROM the allergy list, so a new allergy re-asks for them. */
      if (regimen !== null) await openRegimen(regimen.regimen.syndrome.key, regimen.facts.pregnant ?? undefined);
    } catch (e) {
      setAllergyError(opdErrorMessage(e));
    }
  };

  const skipCurrent = (): void => {
    if (current === null) return;
    setQueueError(null);
    setSkipReason("absent");
    setSkipNote("");
    setSkipping(current);
  };

  const confirmSkip = async (): Promise<void> => {
    if (skipping === null) return;
    setQueueError(null);
    try {
      await api("POST", `/opd/queues/entries/${skipping.id}/skip`, {
        reason: skipReason, note: skipNote.trim() === "" ? null : skipNote.trim(),
      });
      setSkipping(null);
      await invalidateQueue();
    } catch (e) {
      setQueueError(opdErrorMessage(e));
      setSkipping(null); // the refusal belongs on the rail, where the token is
    }
  };

  /**
   * THE WAY BACK FROM A MIS-CLICK. It restores the turn, not merely the row — the server writes back
   * the `eligible_at` the patient had — so a patient skipped by accident is in front of the walk-in
   * who arrived while the doctor was clicking, which is where they were.
   */
  const undoSkipOf = async (e: WireQueueEntryView): Promise<void> => {
    setQueueError(null);
    try {
      await api("POST", `/opd/queues/entries/${e.id}/undo-skip`);
      await invalidateQueue();
    } catch (err) {
      setQueueError(opdErrorMessage(err));
    }
  };

  /**
   * THE DOCTOR OPENS AN UNPAID TOKEN. One POST, and then the queue is re-read rather than patched
   * locally: the server decides what is held, and a rail that moved the row itself would be a
   * second opinion about the ledger. A refusal (`reason_required`, `not_your_patient`) lands on the
   * rail's own error line, where the token is.
   */
  const confirmOpenUnpaid = async (): Promise<void> => {
    const entry = openingUnpaid;
    if (entry === null) return;
    setQueueError(null);
    try {
      await api("POST", `/opd/visits/${entry.encounter.id}/consult/open-unpaid`, { reason: unpaidReason.trim() });
      setOpeningUnpaid(null);
      setUnpaidReason("");
      await invalidateQueue();
    } catch (e) {
      setOpeningUnpaid(null);
      setQueueError(opdErrorMessage(e));
    }
  };

  const startConsult = async (): Promise<void> => {
    if (current === null) return;
    setQueueError(null);
    try {
      const res = await api<{ encounter: WireEncounter }>("POST", `/opd/visits/${current.encounter.id}/consult/start`);
      resetPanel();
      setBriefEntry(null);
      setActive({ encounterId: res.encounter.id, patientId: res.encounter.patientId, summary: current.patient });
      await invalidateQueue();
    } catch (e) {
      setQueueError(opdErrorMessage(e));
    }
  };

  /**
   * PARK — *"the patient decide to stop and he gets outside for 15 minutes"* (owner, 2026-09-13).
   *
   * The panel is cleared because the chair is empty, and NOTHING ELSE MOVES: the encounter stays in
   * consultation on the server, so the note, the prescription lines and the advised tests the
   * doctor has already saved are exactly where they were when `openEntry` brings them back.
   * `resetPanel` is the same call `startConsult` makes, for the same reason — unsaved 16a state
   * belongs to the patient it was typed for (C7).
   */
  const parkActive = async (): Promise<void> => {
    if (active === null) return;
    setQueueError(null);
    try {
      await api("POST", `/opd/visits/${active.encounterId}/consult/park`);
      resetPanel();
      setActive(null);
      await invalidateQueue();
    } catch (e) {
      setQueueError(opdErrorMessage(e));
    }
  };

  /**
   * THE DOOR BACK IN, and it is ONE door for both kinds of row on purpose. A parked patient is
   * resumed on the server first (the hold is a fact, and clearing it is the server's act); a
   * patient who is merely in consultation — because the doctor called the next token without
   * parking, which is exactly how the report was filed — needs no write at all, only the panel.
   * A screen that offered two different buttons would be asking the doctor to know which of the two
   * states they are looking at before they can get back to their patient.
   */
  const openEntry = async (e: WireQueueEntryView): Promise<void> => {
    setQueueError(null);
    try {
      if (parkedSince(e) !== null) await api("POST", `/opd/visits/${e.encounter.id}/consult/resume`);
      resetPanel();
      setBriefEntry(null);
      setActive({ encounterId: e.encounter.id, patientId: e.encounter.patientId, summary: e.patient });
      await invalidateQueue();
    } catch (err) {
      setQueueError(opdErrorMessage(err));
    }
  };

  /*
    CONSULT V2 — `/opd/consult/:encounterId`, opened from a card's new-tab icon. A patient already in
    consultation (seated elsewhere, parked, or with a saved draft) opens here once the line has loaded;
    a patient who is only CALLED shows the brief as usual. D17 decides which tab may write.
  */
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (focusEncounterId === undefined || focusedOnce.current || view === null) return;
    const hit = inConsult.find((e) => e.encounterId === focusEncounterId);
    if (hit !== undefined && active?.encounterId !== focusEncounterId) {
      focusedOnce.current = true;
      setBriefEntry(hit); // the brief first, then Resume consultation (owner, 2026-09-23)
    } else if (current?.encounterId === focusEncounterId) {
      focusedOnce.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs until the focused patient is found, once
  }, [focusEncounterId, view]);

  /*
    THE BRIEF FOR A PATIENT OPENED FROM THE LINE (Resume, Open, the new-tab link) — and, after a
    reload, for the patient still in the chair. The owner's walk found "Nobody is in the chair" over a
    patient who was in consultation: the panel's state lived only in memory. A seated (not parked)
    patient is now brought back as a brief with Resume consultation under it, never an empty chair.
  */
  const [briefEntry, setBriefEntry] = useState<WireQueueEntryView | null>(null);
  /** The header's ⋯ menu — Save draft and Refer stay reachable where the header has no room (<900px). */
  const [moreOpen, setMoreOpen] = useState(false);
  const activeToken: number | null = active === null ? null
    : ([...inConsult, ...(current === null ? [] : [current])].find((e) => e.encounterId === active.encounterId)?.tokenNo ?? null);
  const seatedNow = inConsult.find((e) => parkedSince(e) === null) ?? null;
  const briefFor: WireQueueEntryView | null = briefEntry ?? current ?? seatedNow;

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

  /* D17 — take the lease when a patient opens here, renew it every 20 s, give it back when the tab lets go. */
  const activeEncounterId = active?.encounterId ?? null;
  useEffect(() => {
    if (activeEncounterId === null) { setLease("none"); return; }
    let stop = false;
    const token = tabToken.current;
    const beat = async (): Promise<void> => {
      try {
        const r = await takeLease(activeEncounterId, token);
        if (!stop) setLease(r.held ? "mine" : "other");
      } catch {
        if (!stop) setLease("none");
      }
    };
    void beat();
    const id = setInterval(() => { void beat(); }, 20_000);
    return () => {
      stop = true;
      clearInterval(id);
      void releaseLease(activeEncounterId, token).catch(() => undefined);
    };
  }, [activeEncounterId]);
  const takeOverEditing = async (): Promise<void> => {
    if (activeEncounterId === null) return;
    try {
      const r = await takeLease(activeEncounterId, tabToken.current, true);
      setLease(r.held ? "mine" : "other");
      if (r.held) await queryClient.invalidateQueries({ queryKey: ["opd", "visit", activeEncounterId] });
    } catch (e) {
      setNoteError(opdErrorMessage(e));
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
      await api("PUT", `/opd/visits/${active.encounterId}/consult/note`, { ...noteBodyOf(note, icdByTerm.current), ...v2BodyOf(v2, v2On.current), advisedTests: next, ...leaseBody() });
      setSavedAt(new Date());
    } catch (e) {
      setNoteError(opdErrorMessage(e));
    }
  };

  const saveNote = async (opts?: { force?: boolean; v2?: V2State }): Promise<void> => {
    if (active === null) return;
    if (readOnly) return; // D17: a read-only tab writes nothing
    const body = { ...noteBodyOf(note, icdByTerm.current), ...v2BodyOf(opts?.v2 ?? v2, v2On.current) };
    const key = JSON.stringify(body);
    if (key === lastSavedNote.current && opts?.force !== true) return;
    setNoteError(null);
    try {
      await api("PUT", `/opd/visits/${active.encounterId}/consult/note`, { ...body, ...leaseBody() });
      lastSavedNote.current = key;
      setNoteSaved(true);
      setSavedAt(new Date());
      setSavedAsDraft(opts?.force === true);
    } catch (e) {
      setNoteError(opdErrorMessage(e));
    }
  };

  /*
    CONSULT V2 — a chip or a toggle is not a blur, so the v2 sections autosave on their own short
    debounce through the same `saveNote` (which sends nothing when nothing changed). The note fields
    keep their blur contract untouched.
  */
  useEffect(() => {
    if (!v2On.current || active === null) return;
    const id = setTimeout(() => { void saveNote({ v2 }); }, 900);
    return () => { clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saving is keyed on the v2 sections only
  }, [v2]);

  // ——— the e-Rx ———

  const postRx = async (
    rxLines: RxLineValues[],
    overrides?: AllergyOverride[],
    interactionOverrides?: { lineIndex: number; reason: string; saltPair: [string, string] }[],
    duplicateOverrides?: { lineIndex: number; reason: string; moiety: string }[],
    drugDiseaseOverrides?: { lineIndex: number; reason: string; moiety: string; icd10Prefix: string }[],
  ): Promise<boolean> => {
    if (active === null) return false;
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
    if (drugDiseaseOverrides !== undefined) body.drugDiseaseOverrides = drugDiseaseOverrides;
    let exists = false;
    try {
      const issued = await api<{
        prescriptionId: string; version: number;
        notices?: WireRxNotice[];
        unreviewedLineIndexes?: number[];
      }>("POST", `/opd/visits/${active.encounterId}/prescriptions`, body);
      // The prescription EXISTS from here on; the print below is a courtesy that must not un-issue it.
      exists = true;
      setIssuedRowsKey(rowsKey(rxForm.getValues("lines")));
      setMatches(null);
      setReasons([]);
      setInteractionHits([]);
      setDuplicateHits([]);
      setDiseaseHits([]);
      setDiseaseReasons([]);
      setOverrideError(null);
      // Soft hits survive a successful issue: they are what the doctor should still know about.
      setNotices(issued.notices ?? []);
      // The issue's own answer: when no hard warning paused it, the pre-check's was never shown.
      setUnreviewedLines(issued.unreviewedLineIndexes ?? []);
      setNoticesDismissed(false);
      const print = await api<WireRxPrint>("GET", `/opd/prescriptions/${issued.prescriptionId}/print`);
      setRxPrint(print);
      await queryClient.invalidateQueries({ queryKey: ["opd", "visit"] });
      return true;
    } catch (e) {
      /* The POST succeeded and a later read (the print) failed: the prescription is issued, the
         pharmacy has it, and the failure is shown — but it is not a reason to call the issue failed. */
      if (exists) { setRxError(opdErrorMessage(e)); return true; }
      if (e instanceof ApiError) {
        const errBody = e.body as {
          code?: string;
          detail?: { matches?: AllergyMatch[]; hits?: WireRxNotice[]; diseaseHits?: WireDrugDiseaseHit[] };
        } | null;
        // The allergy hard-warning is a DOMAIN answer carrying the matched lines, not a failure.
        if (errBody?.code === "allergy_conflict" && Array.isArray(errBody.detail?.matches)) {
          setMatches(errBody.detail.matches);
          setReasons(errBody.detail.matches.map(() => ""));
          setOverrideError(null);
          return false;
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
          return false;
        }
        if (errBody?.code === "duplicate_salt_conflict" && Array.isArray(errBody.detail?.hits)) {
          const hits = errBody.detail.hits.filter((h): h is WireDuplicateHit => !isInteractionHit(h));
          setDuplicateHits(hits);
          setDuplicateReasons(hits.map(() => ""));
          setOverrideError(null);
          return false;
        }
        if (errBody?.code === "drug_disease_conflict" && Array.isArray(errBody.detail?.diseaseHits)) {
          const hits = errBody.detail.diseaseHits;
          setDiseaseHits(hits);
          setDiseaseReasons(hits.map(() => ""));
          setOverrideError(null);
          return false;
        }
        if (errBody?.code === "override_reason_required") {
          setOverrideError(opdErrorMessage(e));
          return false;
        }
      }
      setRxError(opdErrorMessage(e));
      return false;
    }
  };

  /** The Issue path, answering whether a prescription now exists. Issue and Complete share it. */
  const issueRx = async (values: RxFormValues): Promise<boolean> => {
    pendingLines.current = values.lines;
    if (active === null) return false;
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
      setUnreviewedLines(pre.unreviewedLineIndexes ?? []);
      const severe = pre.interactions.filter((h) => h.severity === "severe");
      const hardDuplicates = pre.duplicates.filter((h) => h.hard);
      // P24 — severe goes to the dialog; the rest sits with the notices, offer and all.
      const disease = pre.drugDisease ?? [];
      const severeDisease = disease.filter((h) => h.severity === "severe");
      setDiseaseNotices(disease.filter((h) => h.severity !== "severe"));
      if (pre.allergyMatches.length > 0 || severe.length > 0 || hardDuplicates.length > 0 || severeDisease.length > 0) {
        setMatches(pre.allergyMatches.length > 0 ? pre.allergyMatches : null);
        setReasons(pre.allergyMatches.map(() => ""));
        setInteractionHits(severe);
        setInteractionReasons(severe.map(() => ""));
        setDuplicateHits(hardDuplicates);
        setDuplicateReasons(hardDuplicates.map(() => ""));
        setDiseaseHits(severeDisease);
        setDiseaseReasons(severeDisease.map(() => ""));
        setOverrideError(null);
        return false;
      }
    } catch {
      // Deliberately swallowed — see the comment above. The server is the gate.
      // M5 — but the stale hint indexes go: pointing the amber "not in formulary" note at a row
      // whose line has since changed is worse than showing nothing.
      setUnresolvedLines([]);
      setUnreviewedLines([]);
    }
    return postRx(values.lines);
  };

  const submitRx = rxForm.handleSubmit(async (values) => {
    await issueRx(values);
  });

  /**
   * K48, extended by 16a T6: the re-post carries one array per KIND, each with a reason per hit,
   * mirroring the server's rule exactly. The three-character minimum is checked here so the doctor
   * is told in the dialog rather than by a round trip — and the server checks it again regardless.
   */
  /**
   * ═══ THE ONE-TAP SWITCH (P24 T7) ═══
   *
   * The offer has already been vetted by the server against THIS patient (D6), so what arrives here
   * is safe to put on a button. One tap rewrites the line and clears its `medicineId` — the id
   * named the drug being replaced, and leaving it would have the checks reason about the drug the
   * doctor just abandoned.
   *
   * It does NOT re-submit. The doctor sees the line change and decides; the next Issue re-runs
   * every check server-side anyway (design law 2). A switch that submitted on the doctor's behalf
   * would be the co-pilot flying the plane.
   */
  const applySwitch = (lineIndex: number, offer: { moiety: string; label: string }): void => {
    rxForm.setValue(`lines.${String(lineIndex)}.drug` as `lines.${number}.drug`, offer.label);
    rxForm.setValue(`lines.${String(lineIndex)}.medicineId` as `lines.${number}.medicineId`, null);
    setDiseaseHits([]);
    setDiseaseReasons([]);
    setDiseaseNotices([]);
    setOverrideError(null);
  };

  /** The dialog carries four kinds now; only the allergy-only case may call itself an allergy. */
  const allergyOnly = matches !== null
    && interactionHits.length === 0 && duplicateHits.length === 0 && diseaseHits.length === 0;

  const confirmOverride = async (): Promise<void> => {
    const allReasons = [
      ...(matches === null ? [] : reasons.slice(0, matches.length)),
      ...interactionReasons.slice(0, interactionHits.length),
      ...duplicateReasons.slice(0, duplicateHits.length),
      ...diseaseReasons.slice(0, diseaseHits.length),
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
    // P24 — the override names the MOIETY and the RULING, because N18 and N18.4 are two decisions.
    const drugDiseaseOverrides = diseaseHits.map((h, i) => ({
      lineIndex: h.lineIndex, reason: (diseaseReasons[i] ?? "").trim(),
      moiety: h.moiety, icd10Prefix: h.icd10Prefix,
    }));
    await postRx(
      pendingLines.current,
      overrides.length > 0 ? overrides : undefined,
      interactionOverrides.length > 0 ? interactionOverrides : undefined,
      duplicateOverrides.length > 0 ? duplicateOverrides : undefined,
      drugDiseaseOverrides.length > 0 ? drugDiseaseOverrides : undefined,
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

  /**
   * ═══ PRODUCTION 2026-09-23 — COMPLETE MUST NOT DROP A PRESCRIPTION NOBODY ISSUED ═══
   *
   * Encounter 01M36K6NZ7676HA11278QK9225: consultation.completed 46 seconds after it started and no
   * prescription.issued. The doctor typed medicines and pressed Complete; this function posted the
   * note and `resetPanel()` cleared the rows. The pharmacy queue never got a ticket.
   *
   * So a written, un-issued editor makes Complete "Issue & complete": it takes the Issue button's
   * own road — the pre-check, the server's allergy / interaction / duplicate / drug-disease checks,
   * the override dialog — and completes ONLY if a prescription now exists. A pause, a refusal or an
   * error leaves the visit open and every row where the doctor wrote it.
   */
  const rxUnissued = (): boolean => {
    const key = rowsKey(rxForm.getValues("lines"));
    return key !== "" && key !== issuedRowsKey;
  };

  const complete = async (): Promise<void> => {
    if (active === null) return;
    setCompleteError(null);
    if (rxUnissued()) {
      let issued = false;
      await rxForm.handleSubmit(async (values) => { issued = await issueRx(values); })();
      if (!issued) { setTab("rx"); return; }
    }
    const body: Record<string, unknown> = {
      note: {
        ...noteBodyOf(note, icdByTerm.current),
        ...v2BodyOf(v2, v2On.current),
        ...leaseBody(),
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
  const [agentLog, setAgentLog] = useState<AgentLine[]>([]);

  const agentState = useRef({ view, activeAllergies, latestVitals, advisedTests, restricted, patient: patient.data?.patient ?? null });
  agentState.current = { view, activeAllergies, latestVitals, advisedTests, restricted, patient: patient.data?.patient ?? null };

  /*
    ═══ FD-COPILOT — THE DOCK NOW HAS REACH, AND THE PARAGRAPH ABOVE STILL HOLDS ═══

    That header's rule — *"the dock reads, it never infers"* — is unchanged and is the reason this
    chain survives intact rather than being replaced. What changed is what happens to a question it
    cannot see: it used to end at `agent.cannot`, and now it goes to the copilot first, which can
    answer from the hospital's own readers under THIS doctor's own permissions.

    Nothing model-written reaches a prescriber by this route. The model, when one is configured,
    picks a TOOL NAME from a closed menu; the tool runs a real query; the sentence comes from the
    locale file. The five branches below still answer everything about the screen itself — the
    queue, the allergies on file, what Bay One charted, what the doctor has typed — and those are
    exactly the questions no server was asked.

    The doctor's own seat (the toggles, the pre-read, the pending pile) is the brainstorm at
    `docs/superpowers/brainstorms/2026-09-17-doctor-copilot/`. This is only its T2: reach.
  */
  const localAnswer = useCallback((question: string): string | null => {
    const q = question.toLowerCase();
    const st = agentState.current;
    const lines = rxForm.getValues("lines").filter((l) => l.drug.trim() !== "");

    return ((): string | null => {
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
        return lines.length === 0 ? t("opdConsult.agent.noRx") : t("opdConsult.agent.rxLines", { count: lines.length });
      }
      if (/test|lab|invest|jaanch|advis/.test(q)) {
        return st.advisedTests.length === 0
          ? t("opdConsult.agent.noAdvised")
          : t("opdConsult.agent.advised", { count: st.advisedTests.length });
      }
      return null;
    })();
  }, [rxForm, t]);

  const copilot = useCopilot({
    /*
      The patient in the room, masked BY VALUE before anything could leave. A doctor types the name
      of the person in front of them more readily than their UHID, and this screen knows it.
    */
    terms: () => {
      const p = agentState.current.patient;
      return [p?.name, p?.uhid].filter((x): x is string => typeof x === "string" && x !== "");
    },
    fallback: localAnswer,
    onNote: (text) => { setAgentLog((l) => logged(l, text)); },
  });

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

        A modal is modal for the keyboard too: everything this screen binds stands down while one is
        open, and the dialog handles its own Escape.

        ═══ CLOSE PASS 2, CRITICAL — AND THE STAND-DOWN MUST DISARM ═══

        The first version of this guard was a bare `return`, placed above `escArmed = false` — the
        line every non-Escape key reaches. That made the two-stage Escape's memory unclearable while
        a dialog was open, so arming it BEFORE one survived across it:

          Esc (arms) → CLICK Issue → the server refuses → type the override reason (every keystroke
          returned here) → Esc closes the dialog → Esc ONCE → the patient is released.

        Every step after the arming press is a click or a guarded keystroke, so nothing disarmed.
        Pass 1's own scenario was genuinely fixed and this is the same failure one press earlier —
        a fix aimed at an instance closing the instance.

        Disarming here is also the honest semantics: a doctor who has been typing into a dialog has
        given this screen no instruction about the patient, and an Escape the dialog consumed is not
        this screen's first press.
      */
      if (document.querySelector('[role="dialog"]') !== null) { escArmed = false; return; }

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
        if (escArmed && a.hasActive) { escArmed = false; setActive(null); setTab("complaints"); return; }
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

  /**
   * FOUR KINDS OF ROW, ONE LIST, in the order the doctor's attention travels: the token that has
   * been called, then the people already in consultation (in the chair, or held), then the queue.
   *
   * `called` keeps the green bar it has always had — the row a doctor finds with their peripheral
   * vision. A held row is GOLD rather than green or red: it is neither the patient in front of them
   * nor an alarm, it is a thing left half-done, and the palette already uses gold for exactly that.
   */
  const parkedMinutes = (iso: string): number => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));

  const queueRow = (e: WireQueueEntryView, mode: "called" | "seated" | "parked" | "waiting" | "left"): React.ReactElement => {
    const isCurrent = mode === "called";
    const isActive = active !== null && e.encounterId === active.encounterId;
    const held = mode === "parked" ? parkedMinutes(parkedSince(e) ?? new Date().toISOString()) : 0;
    // A skip counts as STANDING only while the token can still be given its turn back: once it is
    // called again the mark is history, and the server refuses the undo for the same reason.
    const skipMark = (mode === "waiting" || mode === "left") && typeof e.skipReason === "string" ? e.skipReason : null;
    /*
      THE BUTTON FOLLOWS RECOVERABILITY, NOT THE REASON. A token that fell out is recoverable
      whether or not it says why — the patient this was written for was skipped before the reason
      column existed, and keying the button to `skipMark` hid the way back from exactly her.
    */
    const recoverable = mode === "left" || skipMark !== null;
    return (
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
        ...(isCurrent || isActive
          ? { background: "var(--green-soft)", boxShadow: "inset 3px 0 0 var(--green)" }
          : mode === "parked"
            ? { background: "var(--gold-soft)", boxShadow: "inset 3px 0 0 var(--gold)" }
            : mode === "left"
              ? { opacity: 0.72 }
              : {}),
      }}
    >
      <span data-testid={`queue-position-${e.id}`} className="mo" style={{ fontSize: 10, color: "var(--faint)" }}>
        {e.position === null ? "—" : t("opdConsult.position", { n: e.position })}
      </span>
      <span data-testid={`queue-token-${e.id}`} className="mo" style={{ fontSize: 16, fontWeight: 700 }}>{e.tokenNo}</span>
      <span style={{ flexGrow: 1, minWidth: 0 }}>{patientLabel(e.patient)}</span>
      {/* the danger mark sits WITH the badges and says what it is (owner's walk: a lone ⚠ read as nothing) */}
      {(e.danger || e.encounter.dangerFlagged) && (
        <span data-testid={`queue-danger-${e.id}`} title={t("opdConsult.danger")} aria-label={t("opdConsult.danger")}
          className="mo" style={{ display: "inline-flex", alignItems: "center", height: 19, padding: "0 5px", borderRadius: 4, border: "1px solid var(--red-line)", background: "var(--red-soft)", color: "var(--red)", fontSize: 10, fontWeight: 700 }}>
          ⚠ {t("opdConsultV2.dangerShort")}
        </span>
      )}
      <VisitTypeBadge visitType={shownVisitType(e.encounter)} size="sm" testId={`queue-visit-type-${e.id}`} />
      {/*
        CONSULT V2 (owner, 2026-09-23) — the alarm says a called token again on the corridor board; the
        box-and-arrow opens this patient in a new browser tab (D17: only one tab edits at a time).
      */}
      {mode === "called" && (
        <button type="button" className="sec" data-testid={`queue-recall-${e.id}`} aria-label={t("opdConsultV2.recall", { token: e.tokenNo })}
          title={e.callCount > 1 ? t("opdConsultV2.recalledTimes", { n: e.callCount - 1 }) : t("opdConsultV2.recall", { token: e.tokenNo })}
          style={{ padding: "2px 6px", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}
          onClick={() => void recallOf(e)}>
          <BellIcon />{e.callCount > 1 ? <span className="mo">{e.callCount - 1}</span> : null}
        </button>
      )}
      {mode !== "left" && (
        <a href={`/opd/consult/${e.encounterId}`} target="_blank" rel="noopener noreferrer" data-testid={`queue-newtab-${e.id}`}
          aria-label={t("opdConsultV2.openNewTab")} title={t("opdConsultV2.openNewTab")}
          style={{ display: "inline-flex", alignItems: "center", padding: "2px 4px", color: "var(--dim)" }}>
          <NewTabIcon />
        </a>
      )}
      {e.queueClass !== null && <span className="tag">{t(`opd.queueClass.${e.queueClass}`)}</span>}
      {e.reEntry && <span className="pill" data-testid={`queue-reentry-${e.id}`}>{t("opdConsult.reEntry")}</span>}
      {mode === "parked" && (
        <span data-testid={`queue-parked-${e.id}`} className="pill" style={{ color: "var(--gold)", fontWeight: 600 }}>
          {held === 0 ? t("opdConsult.parkedJustNow") : t("opdConsult.parkedFor", { minutes: held })}
        </span>
      )}
      {mode === "seated" && isActive && <span data-testid={`queue-seated-${e.id}`} className="pill">{t("opdConsult.inChair")}</span>}
      {/*
        A SKIP THAT IS STILL STANDING SAYS SO, ON THE ROW. Before this a skipped patient went back
        among the waiting with their turn moved and NOTHING marked it — the doctor's own mis-click
        was invisible to them one second later, which is the half of the report that was not about
        `left` at all.
      */}
      {skipMark !== null && (
        <span data-testid={`queue-skipped-${e.id}`} className="pill" style={{ color: "var(--gold)", fontWeight: 600 }}>
          {t(`opdConsult.skipReason.${skipMark}`)}
        </span>
      )}
      {e.skipNote !== null && e.skipNote !== "" && (
        <span data-testid={`queue-skipnote-${e.id}`} style={{ fontSize: 11, color: "var(--faint)" }}>{e.skipNote}</span>
      )}
      {recoverable && (
        <button
          type="button" className="sec" data-testid={`queue-undoskip-${e.id}`}
          style={{ padding: "1px 9px", fontSize: 11.5 }}
          onClick={() => void undoSkipOf(e)}
        >
          {mode === "left" ? t("opdConsult.bringBack") : t("opdConsult.undoSkip")}
        </button>
      )}
      {/*
        THE WAY BACK, on the row itself. It is rendered for every patient in consultation who is
        not the one in the chair — parked or simply left behind by a call-next — because those are
        the two ways a doctor arrives at this screen looking for somebody they have already seen
        half of. A `waiting` row has no button: its way in is Call next, which is where the token
        order is decided.
      */}
      {(mode === "parked" || (mode === "seated" && !isActive)) && (
        <button
          type="button" className="sec" data-testid={`queue-open-${e.id}`}
          style={{ padding: "1px 9px", fontSize: 11.5 }}
          onClick={() => { setActive(null); setBriefEntry(e); }}
        >
          {mode === "parked" ? t("opdConsult.resume") : t("opdConsult.openPatient")}
        </button>
      )}
    </li>
    );
  };

  return (
    <div className="pp cx" data-testid="opd-consult" data-lang={i18n.language.startsWith("hi") ? "hi" : "en"}>
      {/*
        ═══ CONSULT V2 — THREE FULL-HEIGHT COLUMNS (owner, 2026-09-23) ═══
        The line on the left (the hospital's mark at its top, like a chat app's sidebar), the work in
        the centre, the copilot on the right. Both side columns fold to a 52 px strip; the left is open
        on the brief and folded in the consultation by default, and each remembers the doctor's choice
        for the browser session. The route is `fullViewport`, so the app's own header does not sit
        above this screen: the sidebar's mark is the way home.
      */}
      <ConsultSidebar
        open={active === null ? leftOnBrief : leftOnConsult}
        onToggle={active === null ? setLeftOnBrief : setLeftOnConsult}
        waiting={ordered.length}
        sessionStatus={view?.session.status ?? null}
        subtitle={view === null ? undefined : [view.doctor.displayName, view.doctor.specialty].filter((x) => x !== null && x !== "").join(" · ")}
      >
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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
            <button type="button" className="pri" style={{ height: 36, fontSize: 12.5 }} onClick={() => void callNext()}>{t("opdConsult.callNext")}</button>
            <button type="button" className="sec" style={{ height: 36, fontSize: 12.5 }} onClick={() => { skipCurrent(); }}>{t("opdConsult.skip")}</button>
            {/* Start consultation lives under the brief (owner, 2026-09-23); here only while another patient's panel is open. */}
            {active !== null && current !== null && current.encounterId !== active.encounterId && (
              <button type="button" className="sec grn" style={{ height: 36, fontSize: 12.5, gridColumn: "span 2" }} onClick={() => void startConsult()}>{t("opdConsult.start")}</button>
            )}
            {/*
              PARK sits with the other three because it answers the same question they do — what
              happens to the chair next — and because the alternative the owner was left with was
              Call next, which is how a half-seen patient went missing in the first place.
            */}
            <button type="button" className="sec" style={{ height: 36, fontSize: 12.5, gridColumn: "span 2", borderColor: "var(--gold-line)", background: "var(--gold-soft)", color: "#8a5a10", fontWeight: 600 }} onClick={() => void parkActive()}>{t("opdConsult.park")}</button>
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
          {view !== null && current === null && ordered.length === 0 && inConsult.length === 0 && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("opdConsult.emptyQueue")}</p>
          )}
          {inConsult.some((e) => parkedSince(e) !== null) && (
            <p data-testid="parked-hint" style={{ margin: 0, fontSize: 11, color: "var(--faint)" }}>{t("opdConsult.parkedHint")}</p>
          )}
          <ul data-testid="consult-queue" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {current !== null && queueRow(current, "called")}
            {inConsult.map((e) => queueRow(e, parkedSince(e) === null ? "seated" : "parked"))}
            {ordered.map((e) => queueRow(e, "waiting"))}
          </ul>
          {/*
            ═══ WAITING FOR THE BILL — THE GROUP THE OWNER ASKED FOR (2026-09-20) ═══

            Below the live queue and above the ones who left, because that is where they are in the
            day: ready, charted, and stopped by money. Each row carries the sentence that explains
            why it has no bill — the bay's or the front desk's own words — and one button, which is
            this doctor deciding to see them anyway.
          */}
          {heldForPayment.length > 0 && (
            <>
              <h2 className="tag" data-testid="held-queue-title" style={{ margin: "8px 0 0" }}>
                {t("opdConsult.heldQueue", { n: heldForPayment.length })}
              </h2>
              <p style={{ margin: 0, fontSize: 11, color: "var(--faint)" }}>{t("opdConsult.heldQueueHint")}</p>
              <ul data-testid="held-queue" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {heldForPayment.map((e) => (
                  <li
                    key={e.id} data-testid={`held-row-${e.id}`} className="drow"
                    style={{
                      display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, padding: "8px 10px", fontSize: 12.5,
                      background: "var(--gold-soft)", boxShadow: "inset 3px 0 0 var(--gold)",
                    }}
                  >
                    <span className="mo" style={{ fontSize: 16, fontWeight: 700 }}>{e.tokenNo}</span>
                    <span style={{ flexGrow: 1, minWidth: 0 }}>{patientLabel(e.patient)}</span>
                    {(e.danger || e.encounter.dangerFlagged) && (
                      <span data-testid={`held-danger-${e.id}`} aria-label={t("opdConsult.danger")} style={{ color: "var(--red)", fontWeight: 700 }}>⚠</span>
                    )}
                    <span className="pill rd" style={{ fontWeight: 700 }}>{t("opd.feeStatus.unsettled")}</span>
                    <button
                      type="button" data-testid={`open-unpaid-${e.id}`} className="sec"
                      style={{ padding: "3px 10px", fontSize: 12 }}
                      onClick={() => { setOpeningUnpaid(e); setUnpaidReason(""); }}
                    >
                      {t("opdConsult.openUnpaid")}
                    </button>
                    {typeof e.encounter.feeBypassReason === "string" && e.encounter.feeBypassReason !== "" && (
                      <span data-testid={`held-why-${e.id}`} style={{ flexBasis: "100%", fontSize: 11, color: "var(--dim)" }}>
                        {t("opdConsult.heldWhy", { reason: e.encounter.feeBypassReason })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {/*
            ═══ LEFT THE QUEUE — THE GROUP THAT DID NOT EXIST ═══

            Three skips and the token is `left`, which until now meant gone from every screen in the
            building while the VISIT stayed open. They sit below the live queue, dimmed, because
            they are not waiting for anything — and each carries the one button that matters, which
            puts the patient back where they were.
          */}
          {leftQueue.length > 0 && (
            <>
              <h2 className="tag" data-testid="left-queue-title" style={{ margin: "8px 0 0" }}>
                {t("opdConsult.leftQueue", { n: leftQueue.length })}
              </h2>
              <p style={{ margin: 0, fontSize: 11, color: "var(--faint)" }}>{t("opdConsult.leftQueueHint")}</p>
              <ul data-testid="left-queue" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {leftQueue.map((e) => queueRow(e, "left"))}
              </ul>
            </>
          )}
      </ConsultSidebar>

      <div data-testid="consult-centre" className="cx-centre">
        {/* ONE 52px header, as on Consult.dc.html. Keycaps are gone from the header; the bindings are unchanged. */}
        <header className="cx-head">
          <button type="button" className="cx-hbtn cx-mob" data-testid="mob-queue" aria-label={t("opdConsultV2.showLine")}
            onClick={() => { if (active === null) setLeftOnBrief(true); else setLeftOnConsult(true); }}>☰ {ordered.length}</button>
          {active !== null && (
            <button type="button" className="cx-hbtn cx-hide-sm" data-testid="back-to-line" style={{ border: 0, padding: "0 4px", color: "var(--green)", fontWeight: 500 }}
              onClick={() => { setActive(null); setTab("complaints"); }}>← {t("opdConsultV2.theLine")}</button>
          )}
          <h1 className="cx-title" style={{ margin: 0 }}>{t("opdConsult.title")}</h1>
          <span className="cx-who" data-testid="consult-who">
            {[me.data?.displayName ?? view?.doctor.displayName ?? null, view?.doctor.specialty ?? null].filter((x) => x !== null && x !== "").join(" · ")}
          </span>
          <span className="cx-grow" />
          {active !== null && (
            <>
              <span className="cx-saved cx-hide-sm"><SavedClock at={savedAt} draft={savedAsDraft} /></span>
              <button type="button" className="cx-hbtn cx-hide-md" data-testid="refer-open" onClick={() => { setReferDone(null); setReferOpen(true); }}>
                {t("opdConsultV2.refer.open")}
              </button>
              <button type="button" className="cx-hbtn" data-testid="history-open" onClick={() => { setHistoryOpen(true); }}>
                {t("opdConsultV2.history.button")}
              </button>
              <button type="button" className="cx-hbtn cx-hide-md" data-testid="save-draft" onClick={() => void saveNote({ force: true })}>
                {t("opdConsultV2.saveDraft")}
              </button>
              {/* Ctrl+Enter does this too — the Keymap's "commit, a chord because it is the irreversible one". */}
              <button type="button" className="cx-hbtn pri" data-testid="complete-consult" onClick={() => void complete()}>
                <span className="cx-full">{rxWaiting ? t("opdConsult.issueAndComplete") : t("opdConsult.complete")}</span>
                <span className="cx-short" aria-hidden="true">{t("opdConsultV2.completeShort")}</span>
              </button>
            </>
          )}
          {active !== null && (
            <div className="cx-more-wrap" style={{ position: "relative" }}>
              <button type="button" className="cx-hbtn cx-more" data-testid="header-more" aria-haspopup="menu" aria-expanded={moreOpen}
                aria-label={t("opdConsultV2.moreActions")} onClick={() => { setMoreOpen(!moreOpen); }}>⋯</button>
              {moreOpen && (
                <div role="menu" data-testid="header-more-menu" className="cx-more-menu">
                  <button type="button" role="menuitem" data-testid="more-save-draft" onClick={() => { setMoreOpen(false); void saveNote({ force: true }); }}>{t("opdConsultV2.saveDraft")}</button>
                  <button type="button" role="menuitem" data-testid="more-refer" onClick={() => { setMoreOpen(false); setReferDone(null); setReferOpen(true); }}>{t("opdConsultV2.refer.open")}</button>
                </div>
              )}
            </div>
          )}
          <button type="button" className="cx-hbtn cx-mob" data-testid="mob-copilot" aria-label={t("opdConsultV2.showCopilot")}
            onClick={() => { setRightOpen(true); }}>F2</button>
        </header>
        <p className="cx-desktop-note" data-testid="desktop-note" style={{ margin: 0 }}>{t("opdConsultV2.desktopNote")}</p>

        {/* (b) the patient panel */}
        <main className="cx-scroll" data-testid="consult-scroll">
          {/*
            THE BRIEF FIRST, ON EVERY WAY IN (owner, 2026-09-23): Call next, Resume and Open all land on
            what the desks recorded, with Start / Resume consultation under it. `briefEntry` is a patient
            opened from the line; `current` is the one just called.
          */}
          {active === null && briefFor !== null && (
            <div className="cx-brief">
              <PatientBrief
                encounterId={briefFor.encounter.id} patientId={briefFor.encounter.patientId}
                patientName={patientLabel(briefFor.patient)}
                startLabel={briefFor === current ? undefined : t("opdConsultV2.resumeConsult")}
                onStart={() => { if (briefFor === current) void startConsult(); else { const e = briefFor; setBriefEntry(null); void openEntry(e); } }}
              />
            </div>
          )}
          {active === null && briefFor === null && (
            <div className="cx-body"><div className="box" style={{ padding: "26px 22px", textAlign: "center" }}>
              <p style={{ margin: "0 0 5px", fontSize: 16, fontWeight: 700 }}>{t("opdConsult.noPatientTitle")}</p>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("opdConsult.noPatientBody")}</p>
              <p data-testid="pick-patient-hint" style={{ margin: "9px 0 0", fontSize: 11.5, color: "var(--faint)" }}>{t("opdConsult.pickPatientHint")}</p>
            </div></div>
          )}

          {active !== null && (
            <div data-testid="patient-panel" style={{ display: "flex", flexDirection: "column" }}>
              {/* D17 — another tab holds the pen: this one reads, and may take it over (audited). */}
              {readOnly && (
                <div data-testid="lease-readonly" role="status" className="box" style={{ margin: "10px 20px 0", padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}>
                  <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 600 }}>{t("opdConsultV2.lease.other")}</span>
                  <button type="button" className="pri" data-testid="lease-takeover" style={{ padding: "3px 12px", fontSize: 12.5 }} onClick={() => void takeOverEditing()}>
                    {t("opdConsultV2.lease.takeover")}
                  </button>
                </div>
              )}
              {/*
                D17's read-only tab disables the WORK (the strip's edits and every tab body) but not the
                tab bar: a doctor reading another tab's consultation must still be able to move around it.
              */}
              <div className="cx-pin" data-testid="consult-pin">
              <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              {/* THE PATIENT STRIP — one row, as on Consult.dc.html: the visit type first and large, so it cannot be missed. */}
              <header className="cx-strip" data-testid="patient-strip">
                {encounter !== null && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <VisitTypeBadge visitType={shownVisitType(encounter)} testId="panel-visit-type" size="xl" />
                  </div>
                )}
                {restricted ? (
                  <>
                    <p data-testid="restricted-banner" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--gold)" }}>{t("opdConsult.restricted")}</p>
                    <p data-testid="panel-uhid" className="mo" style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{active.summary?.uhid ?? "—"}</p>
                  </>
                ) : (
                  <>
                    <div style={{ minWidth: 0 }}>
                      <div className="cx-name">
                        <span data-testid="panel-patient-name">{patient.data?.patient.name ?? patient.data?.patient.alias ?? patientLabel(active.summary)}</span>
                        <small>
                          {" · "}<span data-testid="panel-patient-age">{t("opdConsult.age", { age: ageYears ?? "—" })} · {patient.data?.patient.administrativeGender ?? "—"}</span>
                          {activeToken !== null && <> · {t("opdConsultV2.token", { n: activeToken })}</>}
                          {" · "}<span data-testid="panel-uhid" className="mo" style={{ fontSize: 12 }}>{patient.data?.patient.uhid ?? active.summary?.uhid ?? "—"}</span>
                        </small>
                      </div>
                      {encounter !== null && (
                        <div className="cx-meaning" data-testid="panel-visit-meaning" style={{ color: encounter.visitType === "renewal" ? "#8a5a10" : encounter.visitType === "new" ? "var(--green)" : "var(--dim)", fontWeight: 600 }}>
                          {t(`opdConsultV2.vtShort.${["new", "revisit", "renewal", "referral"].includes(shownVisitType(encounter)) ? shownVisitType(encounter) : "new"}`)}
                        </div>
                      )}
                    </div>
                  </>
                )}
                {encounter !== null && encounter.dangerFlagged && (
                  <span className="pill rd" data-testid="panel-danger">{t("opdConsult.danger")}</span>
                )}

                {!restricted && (
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, flex: "1 1 240px", minWidth: 0 }}>
                    {/*
                    FD-32 / owner 2026-09-13 — beside the allergies, because both are things the
                    doctor must see BEFORE prescribing. The fee gate already refuses an unpaid
                    consult, so a patient who reaches this chair unpaid was waved through by the
                    front desk on purpose: the mark names the clerk's reason rather than accusing
                    the patient.
                  */}
                  <UnpaidMark unpaid={visit.data?.feeUnpaid ?? false} bypass={visit.data?.feeBypass ?? null} />
                    <h3 className="tag" style={{ margin: 0, color: "var(--red)" }}>{t("opdConsult.allergies")}</h3>
                    <div data-testid="allergy-chips" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5 }}>
                      {activeAllergies.length === 0 && (
                        <span style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdConsult.noAllergies")}</span>
                      )}
                      {/*
                        ═══ EVERY CHIP CAN BE STRUCK, AND STRIKING IS NOT DELETING ═══

                        The ✕ reads as "remove" to the doctor and behaves like it — the chip goes,
                        the warnings stop. What it actually posts is the E-8 entered-in-error
                        correction, so the row keeps who struck it, when and why. `patient-detail`
                        has had this since E-8; the consult screen is where the mistake is MADE.
                      */}
                      {activeAllergies.map((a) => (
                        <span key={a.id} data-testid={`allergy-chip-${a.id}`} className="cx-allergy">
                          {a.substance}
                          <button
                            type="button" data-testid={`allergy-strike-${a.id}`}
                            aria-label={t("opdConsult.allergyRemoveOne", { substance: a.substance })}
                            onClick={() => {
                              setAllergyStriking(a);
                              setAllergyStrikeReason("");
                              setAllergyStrikeError(null);
                            }}
                            style={{
                              border: "none", background: "none", cursor: "pointer", padding: 0,
                              lineHeight: 1, fontSize: 13, color: "inherit", opacity: 0.7,
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {!allergyOpen && (
                        <button
                          type="button" className="sec" data-testid="allergy-add"
                          style={{ height: 25, fontSize: 11.5, padding: "0 9px" }}
                          onClick={() => { setAllergyOpen(true); setAllergyError(null); }}
                        >
                          {t("opdConsult.addAllergy")}
                        </button>
                      )}
                    </div>
                    {allergyOpen && (
                      <div data-testid="allergy-form" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, flexBasis: "100%" }}>
                        {/*
                          ═══ AUTOCOMPLETE, AUTOCORRECT, AND A WARNING — BECAUSE A TYPO IS SILENT ═══

                          Owner, 2026-09-14, asked for autocomplete and autocorrect on the field the
                          doctor can already type into. It is more than convenience: the prescription
                          guard matches a recorded allergy on word tokens, so `pencilin` matches no
                          rule and the penicillin block never fires for that patient again.

                          Picking records the CLASS, which fires the rule by identity. Typing still
                          saves — free text is legal on this field and must stay so — but the line
                          under the box says when the guard will find nothing.
                        */}
                        <div style={{ position: "relative", width: 220 }}>
                          <input
                            id="allergy-substance" aria-label={t("opdConsult.allergySubstance")}
                            value={allergyText} autoComplete="off"
                            onChange={(e) => {
                              setAllergyText(e.target.value);
                              setAllergyPick(null); // the code belonged to the OLD words
                            }}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addAllergy(); } }}
                            className="in" style={{ width: "100%", height: 30, fontSize: 12.5 }}
                            placeholder={t("opdConsult.allergyPlaceholder")}
                          />
                          {allergyHits.length > 0 && (
                            <ul
                              data-testid="allergy-hits"
                              style={{
                                position: "absolute", zIndex: 5, top: 32, left: 0, right: 0, margin: 0,
                                padding: 0, listStyle: "none", background: "var(--paper)",
                                border: "1px solid var(--line)", borderRadius: 5, maxHeight: 180, overflowY: "auto",
                              }}
                            >
                              {allergyHits.map((h) => (
                                <li key={`${h.kind}-${h.term}`}>
                                  <button
                                    type="button" data-testid={`allergy-hit-${h.term}`}
                                    onMouseDown={(e) => { e.preventDefault(); }}
                                    onClick={() => {
                                      setAllergyText(h.term);
                                      setAllergyPick(h);
                                      setAllergyHits([]);
                                      setAllergyKnown(true);
                                    }}
                                    style={{
                                      display: "block", width: "100%", textAlign: "left", padding: "4px 7px",
                                      border: "none", background: "none", cursor: "pointer", fontSize: 12,
                                    }}
                                  >
                                    <span style={{ fontWeight: 600 }}>{h.term}</span>
                                    {h.blocks.length > 0 && (
                                      <span className="mo" style={{ display: "block", fontSize: 10.5, color: "var(--faint)" }}>
                                        {t("opdConsult.allergyBlocks", { list: h.blocks.slice(0, 4).join(", ") })}
                                      </span>
                                    )}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <select
                          aria-label={t("opdConsult.allergySeverity")} value={allergySeverity}
                          onChange={(e) => { setAllergySeverity(e.target.value as "mild" | "moderate" | "severe"); }}
                          className="in" style={{ width: 120, height: 30, fontSize: 12.5 }}
                        >
                          <option value="mild">{t("opdConsult.severity.mild")}</option>
                          <option value="moderate">{t("opdConsult.severity.moderate")}</option>
                          <option value="severe">{t("opdConsult.severity.severe")}</option>
                        </select>
                        <button type="button" className="sec grn" data-testid="allergy-save" style={{ height: 30, fontSize: 12 }} onClick={() => void addAllergy()}>
                          {t("opdConsult.allergySave")}
                        </button>
                        <button type="button" className="sec" style={{ height: 30, fontSize: 12 }} onClick={() => { setAllergyOpen(false); setAllergyText(""); setAllergyError(null); }}>
                          {t("opdConsult.cancel")}
                        </button>
                        <ErrorLine message={allergyError} />
                        {!allergyKnown && allergyText.trim() !== "" && (
                          <p data-testid="allergy-unknown" style={{ margin: 0, flexBasis: "100%", fontSize: 11.5, color: "var(--gold)" }}>
                            {t("opdConsult.allergyUnknown")}
                          </p>
                        )}
                      </div>
                    )}

                    {/*
                      ═══ THE CONFIRMATION SAYS WHAT IS BEING STRUCK AND WHERE IT CAME FROM ═══

                      A doctor undoing their own mis-tap of thirty seconds ago and a doctor striking
                      a contrast reaction radiology recorded from an actual administration are doing
                      two very different things, and only the provenance line tells them apart. Both
                      are allowed and both are audited — `patient-detail` has never restricted this
                      either — but the second one should not happen by accident.

                      The reason is mandatory (E-8) and the button is disabled without it. Typing
                      three words is cheap; a struck safety record with no stated reason is not.
                    */}
                    {allergyStriking !== null && (
                      <div
                        data-testid="allergy-strike-form" role="alertdialog" aria-label={t("opdConsult.allergyRemoveTitle", { substance: allergyStriking.substance })}
                        style={{
                          flexBasis: "100%", padding: "8px 10px", borderRadius: 6,
                          border: "1px solid var(--red)", background: "var(--red-soft)",
                          display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
                        }}
                      >
                        <p style={{ margin: 0, flexBasis: "100%", fontSize: 12.5, fontWeight: 600 }}>
                          {t("opdConsult.allergyRemoveTitle", { substance: allergyStriking.substance })}
                        </p>
                        <p data-testid="allergy-strike-provenance" style={{ margin: 0, flexBasis: "100%", fontSize: 11.5, color: "var(--dim)" }}>
                          {t("opdConsult.allergyRemoveProvenance", {
                            source: t(`opdConsult.allergySource.${allergyStriking.source}`, { defaultValue: allergyStriking.source }),
                            when: new Date(allergyStriking.recordedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }),
                          })}
                        </p>
                        <p style={{ margin: 0, flexBasis: "100%", fontSize: 11.5, color: "var(--dim)" }}>
                          {t("opdConsult.allergyRemoveKept")}
                        </p>
                        <input
                          id="allergy-strike-reason" aria-label={t("opdConsult.allergyRemoveReason")}
                          value={allergyStrikeReason} onChange={(e) => { setAllergyStrikeReason(e.target.value); }}
                          className="in" style={{ width: 260, height: 28, fontSize: 12 }}
                          placeholder={t("opdConsult.allergyRemoveReasonPlaceholder")}
                        />
                        <button
                          type="button" className="sec rd" data-testid="allergy-strike-confirm"
                          style={{ height: 28, fontSize: 11.5 }}
                          disabled={allergyStrikeReason.trim() === ""}
                          onClick={() => void strikeAllergy()}
                        >
                          {t("opdConsult.allergyRemoveConfirm")}
                        </button>
                        <button
                          type="button" className="sec" style={{ height: 28, fontSize: 11.5 }}
                          onClick={() => { setAllergyStriking(null); setAllergyStrikeReason(""); setAllergyStrikeError(null); }}
                        >
                          {t("opdConsult.cancel")}
                        </button>
                        <ErrorLine message={allergyStrikeError} />
                      </div>
                    )}

                    {/*
                      STRUCK ONES ARE HIDDEN, NOT GONE. Default-hidden keeps the chip row clean; the
                      toggle exists so a doctor can see that a correction happened — otherwise the
                      next person re-records the same wrong allergy, having no way to know it was
                      considered and withdrawn.
                    */}
                    {correctedAllergies.length > 0 && (
                      <div style={{ flexBasis: "100%" }}>
                        <button
                          type="button" data-testid="allergy-corrected-toggle"
                          onClick={() => { setShowCorrectedAllergies((v) => !v); }}
                          style={{ border: "none", background: "none", padding: 0, cursor: "pointer", fontSize: 11, color: "var(--faint)", textDecoration: "underline" }}
                        >
                          {t("opdConsult.allergyCorrectedToggle", { count: correctedAllergies.length })}
                        </button>
                        {showCorrectedAllergies && (
                          <ul data-testid="allergy-corrected" style={{ listStyle: "none", margin: "4px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                            {correctedAllergies.map((a) => (
                              <li key={a.id} data-testid={`allergy-corrected-${a.id}`} style={{ fontSize: 11.5, color: "var(--faint)" }}>
                                <s>{a.substance}</s>
                                {a.correctionReason !== null && <span> — {a.correctionReason}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                  {latestVitals === null && <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("opdConsult.noVitals")}</p>}
                  {latestVitals !== null && (() => {
                    const lv = latestVitals;
                    const cls = (warn: boolean, danger: boolean): string => (danger ? "danger" : warn ? "warn" : "");
                    const flagged = (vital: string): boolean => lv.dangerFlags.some((f) => f.vital.toLowerCase().includes(vital));
                    const bmi = lv.weightKg != null && lv.heightCm != null && lv.heightCm > 0 ? lv.weightKg / ((lv.heightCm / 100) ** 2) : null;
                    return (
                      <>
                        {/* Bay One's own numbers, in Bay One's mono; a click opens the Vitals tab (owner, 2026-09-23). */}
                        <button type="button" data-testid="panel-vitals" className="cx-vitals" title={t("opdConsultV2.vitals.open")} onClick={() => { setTab("vitals"); }}>
                          <span className={cls((lv.sbp ?? 0) >= 140 || (lv.dbp ?? 0) >= 90, flagged("bp") || flagged("sbp") || flagged("dbp"))}>BP {lv.sbp ?? "—"}/{lv.dbp ?? "—"}</span>
                          <span className={cls((lv.pulse ?? 80) > 100 || (lv.pulse ?? 80) < 50, flagged("pulse"))}>P {lv.pulse ?? "—"}</span>
                          <span className={cls((lv.spo2 ?? 99) < 95, flagged("spo2") || (lv.spo2 ?? 99) < 90)}>SpO₂ {lv.spo2 ?? "—"}%</span>
                          {lv.weightKg != null && <span>{lv.weightKg} kg</span>}
                          {bmi !== null && <span>BMI {bmi.toFixed(1)}</span>}
                          <span className="more">{t("opdConsultV2.vitals.more")}</span>
                        </button>
                        {lv.dangerFlags.map((f) => (
                          <p
                            key={f.vital}
                            role="alert"
                            data-testid={`vitals-danger-${f.vital}`}
                            className="mo"
                            style={{ margin: 0, padding: "3px 8px", borderRadius: 6, fontSize: 12, fontWeight: 700, color: "var(--red)", background: "var(--red-soft)" }}
                          >
                            {f.vital} {f.value} ({f.bound} {f.limit})
                          </p>
                        ))}
                      </>
                    );
                  })()}
                </div>
              </header>
              </fieldset>

              <div className="cx-work"><WorkStrip rows={workRows} onGo={goToSection} /></div>

              <div className="cx-tabs">
                <TabStrip
                  label={t("opdConsultV2.tabs.label")}
                  value={tab}
                  onChange={setTab}
                  options={[
                    ["summary", t("opdConsultV2.tabs.summary")],
                    ["vitals", t("opdConsultV2.tabs.vitals")],
                    ["complaints", t("opdConsultV2.tabs.complaints")],
                    ["exam", t("opdConsultV2.tabs.exam")],
                    ["dx", t("opdConsultV2.tabs.dx")],
                    ["inv", t("opdConsultV2.tabs.inv")],
                    ["rx", t("opdConsult.tabs.rx")],
                    ["treat", t("opdConsultV2.tabs.treat")],
                    ["advice", t("opdConsultV2.tabs.advice")],
                    ["notes", t("opdConsultV2.tabs.notes")],
                  ] as const}
                  marked={{ complaints: tabHas("complaints"), exam: tabHas("exam"), dx: tabHas("dx"), inv: tabHas("inv"), rx: tabHas("rx"), treat: tabHas("treat"), advice: tabHas("advice"), notes: tabHas("notes") }}
                />
              </div>
              {completeError !== null && <div style={{ padding: "6px 20px", background: "var(--card)" }}><ErrorLine message={completeError} /></div>}
              {referDone !== null && <div style={{ padding: "6px 20px", background: "var(--green-soft)" }}><span data-testid="refer-done" style={{ fontSize: 12, color: "var(--green)", fontWeight: 600 }}>{referDone}</span></div>}
              </div>

              <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <div className="cx-body">

                {!rightOpen && (tab === "complaints" || tab === "dx" || tab === "inv" || tab === "rx") && suggestionsFor("inline")}

                {tab === "summary" && (
                  <div role="tabpanel" id="tabpanel-summary" aria-labelledby="tab-summary"><SummaryView rows={workRows} onGo={goToSection} /></div>
                )}
                {tab === "vitals" && active !== null && (
                  <div role="tabpanel" id="tabpanel-vitals" aria-labelledby="tab-vitals">
                    <VitalsTab
                      key={active.encounterId} encounterId={active.encounterId} patientId={active.patientId}
                      today={vitalsRows as unknown as Parameters<typeof VitalsTab>[0]["today"]}
                      onChanged={() => { void queryClient.invalidateQueries({ queryKey: ["opd", "visit", active.encounterId] }); }}
                    />
                    <SectionHistory visits={timelineItems} currentEncounterId={active.encounterId} sections={["vitals"]} testId="history-foot-vitals" />
                  </div>
                )}
                {tab === "exam" && (
                  <div role="tabpanel" id="tabpanel-exam" aria-labelledby="tab-exam">
                    <ExamSection value={v2.examination} onChange={(next) => { editV2({ examination: next }); }} />
                    <SectionHistory visits={timelineItems} currentEncounterId={active.encounterId} sections={["exam"]} testId="history-foot-exam" />
                  </div>
                )}
                {tab === "treat" && (
                  <div role="tabpanel" id="tabpanel-treat" aria-labelledby="tab-treat">
                    <TreatmentSection value={v2.treatment} onChange={(next) => { editV2({ treatment: next }); }} />
                    <SectionHistory visits={timelineItems} currentEncounterId={active.encounterId} sections={["treat"]} testId="history-foot-treat" />
                  </div>
                )}
                {tab === "notes" && active !== null && (
                  <div role="tabpanel" id="tabpanel-notes" aria-labelledby="tab-notes">
                    <NotesSection
                      patientId={active.patientId} doctorNote={v2.doctorNote} internalComment={v2.internalComment}
                      onDoctorNote={(v) => { editV2({ doctorNote: v }); }} onInternalComment={(v) => { editV2({ internalComment: v }); }}
                      onBlur={() => void saveNote()}
                    />
                    <SectionHistory visits={timelineItems} currentEncounterId={active.encounterId} sections={["notes"]} testId="history-foot-notes" />
                  </div>
                )}

                {/* the note autosaves on blur — focusout bubbles, so one handler covers every field */}
                {(tab === "complaints" || tab === "dx" || tab === "advice") && (
                <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 9 }} onBlur={() => void saveNote()}>
                    {tab === "complaints" && (<>
                    {visit.data?.deskComplaint != null && (
                      <p data-testid="desk-complaint" style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>
                        {t("opdConsult.deskComplaint", {
                          text: visit.data.deskComplaint.text, by: visit.data.deskComplaint.by, at: fmtIst(visit.data.deskComplaint.at),
                        })}
                      </p>
                    )}
                    {(() => {
                      const have = new Set(splitTags(note.chiefComplaint).map((x) => x.toLowerCase()));
                      const offer = (deskHeard.data?.items ?? []).filter((h) => !have.has(h.label.toLowerCase()));
                      return offer.length === 0 ? null : (
                        <div data-testid="desk-heard" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdConsultV2.deskHeard")}</span>
                          {offer.map((h) => (
                            <button key={h.conceptKey} type="button" data-testid={`desk-heard-${h.conceptKey}`}
                              title={t("opdConsultV2.deskHeardFrom", { words: h.matched })}
                              onClick={() => { setNote((n) => ({ ...n, chiefComplaint: joinTags([...splitTags(n.chiefComplaint), h.label]) })); }}
                              style={{ height: 28, padding: "0 11px", borderRadius: 14, border: "1.5px dashed var(--green)", background: "var(--green-soft)", color: "var(--green)", fontSize: 12.5, cursor: "pointer" }}>
                              + {h.label}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                    <div style={{ position: "relative" }}>
                      {/*
                        THE SCRIBE IS A SMALL MIC IN THE CHIEF COMPLAINT'S HEADER ROW (owner, Consult
                        Engine boards). It still inserts a SUGGESTION into the field and never writes
                        past it; its transcript opens as a small card under the button.
                      */}
                      <div style={{ position: "absolute", top: -4, right: 0, zIndex: 3 }}>
                        <ConsultScribe compact onInsert={(text) => {
                          setNote((n) => ({ ...n, chiefComplaint: n.chiefComplaint.trim() === "" ? text : `${n.chiefComplaint.trim()} ${text}` }));
                        }} />
                      </div>
                      {/*
                        THE COMPLAINT IS TAGS NOW (owner, 2026-09-14), and the stored value is still
                        a plain comma-joined string — `opd_encounters.chief_complaint`, the printed
                        slip, the timeline and the MRD coder's screen all see exactly what they saw
                        before. `Enter` commits the doctor's own words verbatim; `→` accepts the
                        ghost; a tap takes the suggestion; `×` removes a tag.
                      */}
                      <TagField
                        id="note-chief"
                        label={t("opdConsult.chiefComplaint")}
                        value={note.chiefComplaint}
                        onChange={(next) => { setNote((n) => ({ ...n, chiefComplaint: next })); }}
                        suggest={async (q) => {
                          const r = await completeComplaint(q);
                          /*
                            THE HINT SAYS WHERE A SUGGESTION CAME FROM, which is how a doctor sees
                            the field learning rather than being told it does. A phrase they have
                            written before is marked with how often; one nobody has mapped yet shows
                            nothing, and is offered anyway — that is the point of counting use.
                          */
                          return {
                            items: r.items.map((i) => ({
                              term: i.term,
                              hint: i.mine > 0 ? t("opdConsult.complaintUsedByYou", { count: i.mine }) : null,
                            })),
                            ghost: r.ghost,
                          };
                        }}
                        placeholder={t("opdConsult.complaintPlaceholder")}
                        hint={t("opdConsult.complaintHint")}
                      />
                      {/*
                        THE SUGGESTIONS SIT UNDER THE FIELD THEY CAME FROM, and they are chips
                        rather than a dropdown: a dropdown steals the caret and a doctor mid-sentence
                        loses their place. Tapping decides nothing — it opens a card to be read.
                      */}
                      {hits.length > 0 && (
                        <div data-testid="cds-hits" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                          <span className="tag" style={{ alignSelf: "center" }}>{t("cds.suggests")}</span>
                          {hits.map((h) => (
                            <button
                              key={h.key} type="button" className="sec" data-testid={`cds-hit-${h.key}`}
                              style={{ padding: "3px 10px", fontSize: 12 }}
                              onClick={() => void openRegimen(h.key)}
                            >
                              {h.name}
                              <span className="mo" style={{ marginLeft: 6, fontSize: 10, color: "var(--faint)" }}>{h.icd10 ?? ""}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <ErrorLine message={cdsError} />
                      {regimen !== null && (
                        <div data-testid="cds-regimen" className="box" style={{ marginTop: 8, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 9 }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                            <strong style={{ fontSize: 13.5 }}>{regimen.regimen.syndrome.name}</strong>
                            <span className="pill" data-testid="cds-band">{t(`cds.band.${regimen.regimen.band}`)}</span>
                            {/*
                              THE FACTS THE DOSES WERE COMPUTED FROM, ON SCREEN. A millilitre with no
                              visible weight beside it is a number a doctor cannot check, and this is
                              the one screen where checking it matters.
                            */}
                            <span className="mo" data-testid="cds-facts" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                              {regimen.facts.weightKg === null ? t("cds.noWeight") : `${regimen.facts.weightKg} kg`}
                              {regimen.facts.ageYears === null ? "" : ` · ${regimen.facts.ageYears}y`}
                            </span>
                            <button type="button" className="sec" style={{ marginLeft: "auto", padding: "2px 9px", fontSize: 11.5 }} onClick={() => { setRegimen(null); }}>
                              {t("opdConsult.dismiss")}
                            </button>
                          </div>

                          {regimen.cards.map((c: WireCard, i) => (
                            <div
                              key={`${c.kind}-${String(i)}`} data-testid={`cds-card-${c.kind}`} role={c.severity === "red" ? "alert" : undefined}
                              style={{
                                padding: "7px 9px", borderRadius: 6, fontSize: 12,
                                background: c.severity === "red" ? "var(--red-soft)" : c.severity === "amber" ? "var(--gold-soft)" : "var(--paper-2, transparent)",
                                border: `1px solid ${c.severity === "red" ? "var(--red)" : c.severity === "amber" ? "var(--gold-line)" : "var(--line)"}`,
                              }}
                            >
                              <strong>{c.title}</strong>
                              <div style={{ color: "var(--dim)" }}>{c.detail}</div>
                              {c.kind === "pregnancy_unknown" && (
                                <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
                                  <button type="button" className="sec" data-testid="cds-pregnant-yes" style={{ padding: "2px 9px", fontSize: 11.5 }}
                                    onClick={() => void openRegimen(regimen.regimen.syndrome.key, true)}>{t("cds.pregnantYes")}</button>
                                  <button type="button" className="sec" data-testid="cds-pregnant-no" style={{ padding: "2px 9px", fontSize: 11.5 }}
                                    onClick={() => void openRegimen(regimen.regimen.syndrome.key, false)}>{t("cds.pregnantNo")}</button>
                                </div>
                              )}
                              {c.alternatives.length > 0 && (
                                <div className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>{t("cds.instead")}: {c.alternatives.join(", ")}</div>
                              )}
                            </div>
                          ))}

                          <ul data-testid="cds-lines" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                            {regimen.regimen.lines.map((l) => (
                              <li key={`${l.band}-${String(l.seq)}`} data-testid={`cds-line-${String(l.seq)}`} style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "baseline", fontSize: 12.5 }}>
                                <span style={{ fontWeight: 600 }}>{l.drugLabel}</span>
                                <span className="mo" data-testid={`cds-dose-${String(l.seq)}`} style={{ color: l.dose.state === "computed" ? "var(--green)" : "var(--gold)" }}>
                                  {l.rx.dose}
                                </span>
                                <span style={{ color: "var(--faint)", fontSize: 11.5 }}>{l.rx.frequency}{l.rx.durationDays === null ? "" : ` · ${l.rx.durationDays}d`}</span>
                                {l.substitutedFor !== undefined && <span className="pill rd" data-testid={`cds-swap-${String(l.seq)}`}>{t("cds.swapped")}</span>}
                              </li>
                            ))}
                          </ul>

                          <button type="button" className="pri" data-testid="cds-fill" style={{ alignSelf: "flex-start", padding: "4px 13px", fontSize: 12.5 }} onClick={() => { fillFromRegimen(); }}>
                            {t("cds.fill", { n: regimen.regimen.lines.length })}
                          </button>
                        </div>
                      )}
                    </div>
                    </>)}
                    {tab === "dx" && (<>
                    {/*
                      ═══ THE DIAGNOSIS IS TAGS, AND ITS CODE COMES FROM THE CATALOGUE ═══

                      Owner, 2026-09-14, chose SEVERAL tags over one value: an OPD note reads
                      "Acute URI · Type 2 DM · HTN", and a primary diagnosis with its comorbidities
                      beside it is what a coder, a claim and the next doctor all need.

                      The suggester is the ICD-10-CM tabular list the owner supplied — 74,044
                      assignable codes — and it completes what is TYPED, so it works whether or not
                      the co-pilot is on, exactly as the drug field does. What the co-pilot gates is
                      the syndrome chips above, which propose a diagnosis nobody typed.

                      The same keystroke contract as the complaint: Enter commits the doctor's own
                      words verbatim, the forward key accepts the completion, a tap chooses the row.
                      A doctor's own phrase is a legal diagnosis and always was.
                    */}
                    <TagField
                      id="note-diagnosis"
                      label={t("opdConsult.diagnosis")}
                      value={note.diagnosis}
                      onChange={(next) => { setNote((n) => ({ ...n, diagnosis: next })); }}
                      suggest={async (q) => {
                        const r = await api<{ items: WireIcd10Hit[] }>(
                          "GET", `/opd/cds/complete/diagnosis?q=${encodeURIComponent(q)}`,
                        );
                        /* Remember what was OFFERED, so the tag can be paired with its code on save. */
                        for (const i of r.items) icdByTerm.current.set(i.description.toLowerCase(), i.code);
                        /*
                          NO GHOST. The complaint field ghosts the remainder of a prefix match
                          because its vocabulary is seventy short words. A ghost of "Acute upper
                          respiratory infection, unspecified" behind three typed letters is a line
                          of text the doctor did not write, arriving under their cursor.
                        */
                        return { items: r.items.map((i) => ({ term: i.description, hint: i.code })), ghost: null };
                      }}
                      placeholder={t("opdConsult.diagnosisPlaceholder")}
                      hint={t("opdConsult.diagnosisHint")}
                    />
                    <div role="group" aria-label={t("opdConsultV2.kind.label")} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span className="tag">{t("opdConsultV2.kind.label")}</span>
                      {(["provisional", "final"] as const).map((k) => (
                        <button key={k} type="button" data-testid={`dx-kind-${k}`} aria-pressed={v2.diagnosisKind === k}
                          className={v2.diagnosisKind === k ? "pri" : "sec"} style={{ padding: "2px 10px", fontSize: 12 }}
                          onClick={() => { editV2({ diagnosisKind: v2.diagnosisKind === k ? null : k }); }}>
                          {t(`opdConsultV2.kind.${k}`)}
                        </button>
                      ))}
                    </div>
                    <div>
                      {/*
                        THE CODE FIELD STAYS, AND IS NOW A READING RATHER THAN A SECOND PLACE TO TYPE.

                        Owner ruling 1: sharpen the screen the doctor has, do not replace it — so the
                        field does not vanish. But a code typed here and a code carried by a tag are
                        two statements of one fact, and the day they disagree nothing would say which
                        is the diagnosis. A doctor who knows the code types it into the field ABOVE:
                        the typeahead matches codes as well as prose, so `J06.9` finds its own row.
                      */}
                      <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="note-icd10">{t("opdConsult.icd10Code")}</label>
                      <input
                        id="note-icd10" readOnly data-testid="note-icd10"
                        /*
                          THE FALLBACK IS FOR NOTES WRITTEN BEFORE THIS TABLE EXISTED. An encounter
                          coded by the old single input has `icd10Code` on the row and no diagnosis
                          rows at all, so the map yields nothing for its tags. Showing the stored
                          code is the honest rendering of that record; showing an empty box would
                          report a note as uncoded when it is not.
                        */
                        value={(() => {
                          const fromTags = splitTags(note.diagnosis)
                            .map((x) => icdByTerm.current.get(x.toLowerCase()))
                            .filter((c): c is string => c !== undefined);
                          return fromTags.length > 0 ? fromTags.join(" · ") : note.icd10Code;
                        })()}
                        className="in mo" style={{ width: "100%", height: 34, fontSize: 13, background: "var(--paper-2, transparent)", color: "var(--dim)" }}
                      />
                      <p style={{ margin: "4px 0 0", fontSize: 11.5, color: "var(--faint)" }}>{t("opdConsult.icd10Hint")}</p>
                    </div>
                    </>)}
                    {tab === "advice" && (
                    <div>
                      <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="note-advice">{t("opdConsult.advice")}</label>
                      {/* CONSULT V2 PR 3 — advice autocompletes too: a template by its title or its words, or the doctor's own line. */}
                      <div style={{ marginBottom: 6 }}>
                        <TermInput
                          id="advice-find" testId="advice-find" label={t("opdConsultV3.adviceFind")} placeholder={t("opdConsultV3.adviceFind")}
                          local={(adviceTemplates.data?.items ?? []).flatMap((tpl) => [tpl.title, ...(tpl.textEn === null ? [] : [tpl.textEn])])}
                          onAdd={(term) => {
                            const tpl = (adviceTemplates.data?.items ?? []).find((x) => x.title.toLowerCase() === term.toLowerCase());
                            appendAdvice(tpl === undefined ? term : (tpl.textEn ?? tpl.textHi ?? tpl.title));
                          }}
                        />
                      </div>
                      {/*
                        ═══ THE ADVICE BOX EXPANDS SNIPPETS AS THE DOCTOR TYPES ═══

                        Typing `;rest` replaces it in place with the template's text, placeholders
                        already resolved against THIS patient — the weight the bay charted, the
                        follow-up date seven days out. Tab then walks the blanks the snippet left.

                        Tab is intercepted only while blanks are outstanding, and the LAST Tab is
                        deliberately let through so the gesture ends by leaving the field. Escape
                        abandons the blanks and hands Tab straight back.
                      */}
                      <textarea
                        id="note-advice" rows={3}
                        ref={adviceSnippets.ref as React.RefObject<HTMLTextAreaElement>}
                        value={note.advice}
                        onChange={(e) => { adviceSnippets.onChangeValue(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
                        onKeyDown={adviceSnippets.onKeyDown}
                        onBlur={adviceSnippets.onBlur}
                        className="in" style={{ width: "100%", height: "auto", padding: "7px 9px", fontSize: 13 }}
                      />
                      {adviceSnippets.stops.length > 0 && (
                        <p data-testid="advice-stops" style={{ margin: "3px 0 0", fontSize: 11, color: "var(--gold)" }}>
                          {t("opdConsult.snippetStops", {
                            n: adviceSnippets.stops.length - adviceSnippets.stopIndex - 1,
                            label: adviceSnippets.stops[adviceSnippets.stopIndex]?.label ?? "",
                          })}
                        </p>
                      )}
                      {/*
                        ═══════════════════════════════════════════════════════════════════════════
                        THE ADVICE LIBRARY — AND THE ONLY FIELD ON THIS SCREEN THE PATIENT READS
                        ═══════════════════════════════════════════════════════════════════════════

                        Owner's own idea, 2026-09-14: *"a prefilled template saved as a module"*, in
                        a shared library with the doctor's own favourites on top.

                        TWO BUTTONS PER TEMPLATE, NOT ONE. Owner ruling: the doctor chooses the
                        language per template. Whichever they press is the string that is stored and
                        the string that prints — `rx-print.tsx` prints `encounter.advice` verbatim,
                        so a translated LABEL above English prose gives a patient who reads only
                        Devanagari nothing at all. The script has to be in the value.

                        Tapping APPENDS. A doctor builds advice from two or three of these plus a
                        line of their own, and replacing would throw away typing on a mis-tap.
                      */}
                      <div data-testid="advice-library" style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6, alignItems: "center" }}>
                        {(adviceTemplates.data?.items ?? []).map((tpl) => (
                          <span
                            key={tpl.id} data-testid={`advice-tpl-${tpl.id}`}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 4px 2px 8px",
                              border: `1px solid ${tpl.mine ? "var(--green)" : "var(--line)"}`, borderRadius: 999, fontSize: 11.5,
                            }}
                          >
                            <span style={{ color: "var(--dim)" }}>{tpl.title}</span>
                            {/* The keyword sits ON the chip, which is how a doctor learns it without being taught. */}
                            {tpl.keyword !== null && tpl.keyword !== "" && (
                              <span className="mo" data-testid={`advice-tpl-${tpl.id}-kw`} style={{ fontSize: 10, color: "var(--faint)" }}>{tpl.keyword}</span>
                            )}
                            {tpl.textEn !== null && (
                              <button
                                type="button" data-testid={`advice-tpl-${tpl.id}-en`}
                                onClick={() => { appendAdvice(tpl.textEn!); }}
                                className="sec" style={{ height: 21, padding: "0 7px", fontSize: 10.5 }}
                              >
                                EN
                              </button>
                            )}
                            {tpl.textHi !== null && (
                              <button
                                type="button" data-testid={`advice-tpl-${tpl.id}-hi`}
                                onClick={() => { appendAdvice(tpl.textHi!); }}
                                className="sec" style={{ height: 21, padding: "0 7px", fontSize: 10.5 }}
                              >
                                हिं
                              </button>
                            )}
                          </span>
                        ))}
                        {!adviceSaveOpen && note.advice.trim() !== "" && (
                          <button
                            type="button" className="sec" data-testid="advice-save-open"
                            style={{ height: 23, fontSize: 11 }}
                            onClick={() => { setAdviceSaveOpen(true); setAdviceSaveError(null); }}
                          >
                            {t("opdConsult.adviceSaveAsTemplate")}
                          </button>
                        )}
                      </div>
                      {adviceSaveOpen && (
                        <div data-testid="advice-save-form" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, alignItems: "center" }}>
                          <input
                            id="advice-title" aria-label={t("opdConsult.adviceTemplateTitle")}
                            value={adviceSaveTitle} onChange={(e) => { setAdviceSaveTitle(e.target.value); }}
                            className="in" style={{ width: 200, height: 28, fontSize: 12 }}
                            placeholder={t("opdConsult.adviceTemplateTitlePlaceholder")}
                          />
                          <input
                            id="advice-keyword" aria-label={t("opdConsult.adviceKeyword")}
                            value={adviceSaveKeyword} onChange={(e) => { setAdviceSaveKeyword(e.target.value); }}
                            className="in mo" style={{ width: 120, height: 28, fontSize: 12 }}
                            placeholder=";rest"
                          />
                          <button
                            type="button" className="sec grn" data-testid="advice-save" style={{ height: 28, fontSize: 11.5 }}
                            disabled={keywordProblem(adviceSaveKeyword) !== null}
                            onClick={() => void saveAdviceTemplate()}
                          >
                            {t("opdConsult.adviceSave")}
                          </button>
                          <button type="button" className="sec" style={{ height: 28, fontSize: 11.5 }} onClick={() => { setAdviceSaveOpen(false); setAdviceSaveTitle(""); setAdviceSaveError(null); }}>
                            {t("opdConsult.cancel")}
                          </button>
                          <ErrorLine message={adviceSaveError} />
                          {/*
                            THE KEYWORD RULE, SAID WHERE IT IS BROKEN. Expansion fires while the
                            doctor types, so a keyword that can occur inside a word would detonate in
                            the middle of ordinary prose. The server refuses it too; this is the half
                            that tells the person typing, before they have saved anything.
                          */}
                          {keywordProblem(adviceSaveKeyword) !== null && (
                            <p data-testid="advice-keyword-problem" style={{ margin: 0, flexBasis: "100%", fontSize: 11.5, color: "var(--gold)" }}>
                              {t(`opdConsult.adviceKeywordProblem.${keywordProblem(adviceSaveKeyword) ?? ""}`)}
                            </p>
                          )}
                          {unknownTokensIn(note.advice).length > 0 && (
                            <p data-testid="advice-unknown-tokens" style={{ margin: 0, flexBasis: "100%", fontSize: 11.5, color: "var(--gold)" }}>
                              {t("opdConsult.snippetUnknownTokens", { list: unknownTokensIn(note.advice).join(", ") })}
                            </p>
                          )}
                        </div>
                      )}

                      {/*
                        ═══ THE KEYWORD CHARACTER REFERENCE ═══

                        Rendered FROM `PLACEHOLDERS`, the same list the resolver runs, so the panel a
                        doctor reads and the engine that runs can never drift. Each row shows what it
                        would produce FOR THIS PATIENT right now — a reference that says "{weight}"
                        teaches less than one that says "{weight} → 62".
                      */}
                      <div style={{ marginTop: 5 }}>
                        <button
                          type="button" data-testid="snippet-ref-toggle"
                          onClick={() => { setAdviceRefOpen((v) => !v); }}
                          style={{ border: "none", background: "none", padding: 0, cursor: "pointer", fontSize: 11, color: "var(--faint)", textDecoration: "underline" }}
                        >
                          {t("opdConsult.snippetReference")}
                        </button>
                        {adviceRefOpen && (
                          <div data-testid="snippet-ref" style={{ marginTop: 4, border: "1px solid var(--line)", borderRadius: 5, padding: "6px 8px" }}>
                            <p style={{ margin: "0 0 5px", fontSize: 11, color: "var(--dim)" }}>{t("opdConsult.snippetReferenceHint")}</p>
                            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "2px 12px" }}>
                              {PLACEHOLDERS.map((ph) => {
                                const preview = ph.resolve(snippetContext);
                                return (
                                  <li key={ph.token} data-testid={`snippet-ref-${ph.token}`} style={{ fontSize: 11 }}>
                                    <span className="mo" style={{ fontWeight: 600 }}>{`{${ph.token}}`}</span>
                                    <span style={{ color: "var(--faint)" }}> — {ph.describe}</span>
                                    {preview !== null && <span className="mo" style={{ color: "var(--green)" }}> → {preview}</span>}
                                  </li>
                                );
                              })}
                              {PLACEHOLDER_FORMS.map((f) => (
                                <li key={f.token} style={{ fontSize: 11 }}>
                                  <span className="mo" style={{ fontWeight: 600 }}>{f.token}</span>
                                  <span style={{ color: "var(--faint)" }}> — {f.describe}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                    )}
                    {noteSaved && <p data-testid="note-saved" style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "var(--green)" }}>{t("opdConsult.noteSaved")}</p>}
                    <ErrorLine message={noteError} />
                  </div>
                </div>
                )}

                {(tab === "complaints" || tab === "dx" || tab === "advice") && active !== null && <SectionHistory visits={timelineItems} currentEncounterId={active.encounterId} sections={[tab]} testId={`history-foot-${tab}`} />}
                {tab === "rx" && (
                <div role="tabpanel" id="tabpanel-rx" aria-labelledby="tab-rx">
                  {/* The copilot folded away? Its stock suggestions come inline instead (owner, 2026-09-23). */}
                  {!rightOpen && stockAlerts.length > 0 && (
                    <div data-testid="inline-stock-alts" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12, padding: 10, borderRadius: 8, background: "var(--agent)" }}>
                      {stockAlerts.map((a) => (
                        <StockAlternativeCard
                          key={`inline-${String(a.index)}-${a.stock.medicineId}`} drug={a.drug} stock={a.stock}
                          onUse={(medicineId, label) => { pickAlternative(a.index, a.stock.medicineId, medicineId, label); }}
                          onKeep={() => { keepWritten(a.stock); }}
                        />
                      ))}
                    </div>
                  )}
                  {/*
                    ═══ FD-30 — THE SLIP THE DOOR TRANSCRIBED, WAITING FOR THIS DOCTOR'S TAP ═══

                    Owner ruling 2026-09-12: draft then confirm. It sits ABOVE the editor because on
                    a visit that has one it is the first thing to decide — issue it, edit it, or
                    throw it away — and below the editor it is a panel the doctor scrolls past after
                    already typing the same lines by hand.

                    TWO ROADS OUT, DELIBERATELY. "Issue" is the tap the ruling asks for and it is the
                    common case. "Load into the editor" exists because the tap can be REFUSED — an
                    allergy conflict, a severe interaction, a duplicate salt — and clearing one needs
                    the override dialogs this screen already owns. Duplicating those here would be a
                    second implementation of a clinical decision; handing the lines down to the
                    editor is the same doctor, the same checks, one panel lower.
                  */}
                  {draft.data?.draft != null && (
                    <div className="box" data-testid="rx-draft" style={{ marginBottom: 13, padding: 12, borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}>
                      <span className="tag">{t("opdConsult.draft.heading")}</span>
                      <ul style={{ margin: "7px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
                        {draft.data.draft.lines.map((l, i) => (
                          <li key={i} data-testid={`rx-draft-line-${String(i)}`}>
                            <strong>{l.drug}</strong>{l.dose === "" ? "" : ` · ${l.dose}`} · {l.route} · {l.frequency}
                            {l.durationDays === null ? "" : ` · ${String(l.durationDays)}d`}
                            {l.instructions === null || l.instructions === "" ? "" : ` — ${l.instructions}`}
                          </li>
                        ))}
                      </ul>
                      {draft.data.draft.note !== null && draft.data.draft.note !== "" && (
                        <p data-testid="rx-draft-note" style={{ margin: "7px 0 0", fontSize: 12 }}>{draft.data.draft.note}</p>
                      )}
                      <ErrorLine message={draftError} />
                      <div style={{ marginTop: 9, display: "flex", gap: 7, flexWrap: "wrap" }}>
                        <button type="button" className="pri" data-testid="rx-draft-issue" disabled={draftBusy} onClick={() => { void issueTheDraft(); }}>
                          {t("opdConsult.draft.issue")}
                        </button>
                        <button
                          type="button" className="sec" data-testid="rx-draft-load"
                          onClick={() => {
                            /* Into the editor exactly as typed, so the doctor edits and issues by the
                               ordinary road — every check and every override dialog unchanged. */
                            const d = draft.data?.draft;
                            if (d == null) return;
                            rxForm.reset({
                              lines: d.lines.map((l) => ({
                                drug: l.drug, dose: l.dose, route: l.route, frequency: l.frequency,
                                durationDays: l.durationDays === null ? "" : String(l.durationDays),
                                instructions: l.instructions ?? "", noSubstitution: l.noSubstitution, medicineId: null,
                              })),
                            });
                          }}
                        >
                          {t("opdConsult.draft.load")}
                        </button>
                        <button type="button" className="sec" data-testid="rx-draft-discard" disabled={draftBusy} onClick={() => { void discardTheDraft(); }}>
                          {t("opdConsult.draft.discard")}
                        </button>
                      </div>
                      <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--faint)" }}>{t("opdConsult.draft.who")}</p>
                    </div>
                  )}
                  <FormProvider {...rxForm}>
                    <FormKit onSubmit={submitRx}>
                      {lines.fields.map((f, i) => (
                        <div key={f.id} className={`cx-rxcard${(watchedLines[i]?.drug.trim() ?? "") === "" || String(watchedLines[i]?.durationDays ?? "").trim() === "" ? " writing" : ""}`}
                          data-testid={`rx-card-${String(i)}`} style={{ marginTop: 14 }}>
                        <StockTag stock={stockByMedicine.get(watchedLines[i]?.medicineId ?? "")} testId={`rx-stock-${String(i)}`} />
                        {(() => {
                          /*
                            THE LINE AS A CARD (the Consult Engine board): name, strength, the sig in one
                            line. A finished line folds to this card when the doctor moves to another;
                            its fields stay mounted (the form owns them) and a tap opens them again.
                          */
                          const l = watchedLines[i];
                          if (l === undefined || l.drug.trim() === "") return null;
                          const days = String(l.durationDays ?? "").trim();
                          return (
                            <button type="button" data-testid={`rx-card-head-${String(i)}`} onClick={() => { setRxOpen(rxFolded(i) ? i : null); /* folded → open it; open → Done folds it */ }}
                              aria-expanded={!rxFolded(i)}
                              style={{ display: "flex", width: "100%", alignItems: "baseline", gap: 10, border: 0, background: "transparent", padding: "0 90px 0 0", textAlign: "left", cursor: "pointer", color: "var(--ink)" }}>
                              <span className="mo" style={{ fontSize: 12, color: "var(--faint)" }}>{String(i + 1).padStart(2, "0")}</span>
                              <span style={{ fontWeight: 700, fontSize: 13.5 }}>{l.drug}</span>
                              {l.dose.trim() !== "" && <span style={{ fontSize: 12.5, color: "var(--dim)" }}>{l.dose}</span>}
                              <span className="mo" style={{ fontSize: 12.5 }}>{l.frequency}</span>
                              {days !== "" && <span style={{ fontSize: 12.5 }}>{t("opdConsultV2.rxDays", { n: days })}</span>}
                              {l.instructions.trim() !== "" && <span style={{ fontSize: 12, color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{l.instructions}</span>}
                              <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--green)", textDecoration: "underline", flexShrink: 0 }}>{rxFolded(i) ? t("opdConsultV2.rxEdit") : t("opdConsultV2.rxFold")}</span>
                            </button>
                          );
                        })()}
                        <div data-testid={`rx-fields-${String(i)}`} onFocusCapture={() => { if (rxOpen !== i) setRxOpen(i); }} style={rxFolded(i) ? { display: "none" } : { marginTop: watchedLines[i]?.drug.trim() ? 10 : 0 }}>
                        {/*
                          A LINE IS Drug · Dose · Route, then the sig panel — the ONLY control for
                          how often, food timing, days and the note (see components/sig-panel.tsx
                          for why the Frequency select and the Days and Instructions boxes went).
                        */}
                        {/*
                          ═══ THE LINE BEING WRITTEN IS A CARD TOO (the Consult Engine board, handoff item 2) ═══
                          The same columns a finished card reads in — number · medicine · dose · route ·
                          the substitution mark · remove — so writing a line and reading it back are one
                          shape. The labels stay in the DOM for screen readers and are hidden on screen;
                          the placeholders carry the prompt, as the board draws it. A line that is not yet
                          finished (no medicine, or no days) wears the board's dashed "add" border.
                        */}
                        <div data-testid={`rx-row-${String(i)}`} className="cx-rxedit" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                          {/* The number leads the row until the card's own head (which carries it) appears with the medicine. */}
                          <span className="mo" aria-hidden="true" style={{ flex: "0 0 26px", fontSize: 12, color: "var(--faint)" }}>
                            {(watchedLines[i]?.drug.trim() ?? "") === "" ? String(i + 1).padStart(2, "0") : ""}
                          </span>
                          <div style={{ flex: "2.2 1 220px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                            {/*
                              THE DRUG FIELD IS NOW A COMBOBOX over the CLINICAL DRUG tier —
                              molecule and strength, no brand. It replaces a plain TextField plus a
                              `<select>` that listed every branded medicine unpaginated and worked
                              only because `formulary_medicines` is empty; at the 93,905 rows the
                              national release carries, that control mounts 93,905 option nodes and
                              fetches a 38 MiB payload on every consultation.

                              C1's rule is kept and moved INSIDE the component: typing over a picked
                              name drops `medicineId`. A pick does not set one — see
                              `modules/formulary/suggest.ts` for why that is the safe choice while
                              the catalogue is uncurated.
                            */}
                            {/*
                              ═══ THE TYPEAHEAD REPLACED A `<select>` OF THE WHOLE CATALOGUE ═══

                              Owner, 2026-09-14: autocomplete must work whether or not the co-pilot
                              is on. It also HAD to replace the picker: after the catalogue import
                              that dropdown is 103,383 options and a 15 MB payload on every load of
                              this screen — measured, not feared.

                              Free typing is untouched and always legal (16a design law 1). Picking
                              a row fills the name AND the id, which is what turns a line into one
                              the interaction and duplicate checks can reason about; typing over it
                              clears the id again, exactly as the old field did.
                            */}
                            <label className="tag cx-sr" htmlFor={`rx-drug-${String(i)}`}>
                              {t("opdConsult.drug")}
                            </label>
                            <DrugField
                              inputId={`rx-drug-${String(i)}`}
                              value={rxForm.watch(`lines.${i}.drug`)}
                              placeholder={t("opdConsult.drugPlaceholder")}
                              onText={(text) => {
                                rxForm.setValue(`lines.${i}.drug`, text, { shouldDirty: true });
                                if (rxForm.getValues(`lines.${i}.medicineId`) !== null) {
                                  rxForm.setValue(`lines.${i}.medicineId`, null);
                                  /* The id and the shorthand go together: what is shown must not
                                     outlive the pick it describes. */
                                  setShorthand((m) => {
                                    const { [f.id]: dropped, ...rest } = m;
                                    return dropped === undefined ? m : rest;
                                  });
                                }
                              }}
                              onPick={(hit) => {
                                rxForm.setValue(`lines.${i}.drug`, hit.name, { shouldDirty: true });
                                rxForm.setValue(`lines.${i}.medicineId`, hit.id);
                                setShorthand((m) => ({ ...m, [f.id]: { strength: hit.strength, form: hit.form, code: hit.code } }));
                                setNeedsPick((m) => {
                                  const { [f.id]: dropped, ...rest } = m;
                                  return dropped === undefined ? m : rest;
                                });
                              }}
                            />
                            {/*
                              DD5 — the hint renders ONLY when the server says coverage is high
                              enough. Below the threshold it would fire on almost every line and
                              become wallpaper, which is worse than silence.
                            */}
                            {shorthand[f.id] !== undefined && (
                              <span
                                data-testid={`rx-shorthand-${String(i)}`}
                                className="mo"
                                style={{ fontSize: 10.5, color: "var(--faint)" }}
                              >
                                {`[${[
                                  shorthand[f.id]?.strength ?? null,
                                  shorthand[f.id]?.form ?? null,
                                  shorthand[f.id]?.code ?? null,
                                ].filter((x) => x !== null && x !== "").join(" | ")}]`}
                              </span>
                            )}
                            {needsPick[f.id] === true && (
                              <p data-testid={`rx-unmatched-${String(i)}`} style={{ margin: 0, fontSize: 11, color: "var(--gold)" }}>
                                {t("opdConsult.regimenUnmatched")}
                              </p>
                            )}
                            {noticeEnabled && unresolvedLines.includes(i) && (
                              <p data-testid={`rx-uncovered-${String(i)}`} style={{ margin: 0, fontSize: 11, color: "var(--gold)" }}>
                                {t("opdConsult.notInFormulary")}
                              </p>
                            )}
                          </div>
                          <div style={{ flex: ".7 1 128px", minWidth: 0 }}>
                            <TextField name={`lines.${String(i)}.dose`} label={t("opdConsult.dose")} placeholder={t("opdConsultV2.rxDosePlaceholder")} />
                          </div>
                          <div style={{ flex: "1 1 110px", minWidth: 0 }}>
                            <SelectField
                              name={`lines.${String(i)}.route`}
                              label={t("opdConsult.route")}
                              options={ROUTE_OPTIONS.map((r) => ({ value: r, label: t(`opdConsult.routeOption.${r}`) }))}
                            />
                          </div>
                          <div style={{ flex: "0 1 auto", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                            <CheckboxField name={`lines.${String(i)}.noSubstitution`} label={t("opdConsult.noSubstitution")} />
                            {lines.fields.length > 1 && (
                              <button type="button" className="sec" style={{ height: 28, padding: "0 11px", fontSize: 12 }} onClick={() => lines.remove(i)}>
                                {t("opdConsult.removeLine")}
                              </button>
                            )}
                          </div>
                        </div>
                        <SigPanel
                          lineIndex={i}
                          frequency={rxForm.watch(`lines.${i}.frequency`)}
                          instructions={rxForm.watch(`lines.${i}.instructions`)}
                          durationDays={String(rxForm.watch(`lines.${i}.durationDays`) ?? "")}
                          frequencyError={rxForm.formState.errors.lines?.[i]?.frequency?.message}
                          daysError={rxForm.formState.errors.lines?.[i]?.durationDays?.message}
                          onPatch={(patch: SigPatch) => {
                            /* Straight into the line's own fields — the panel stores nothing. */
                            /* Re-checked only once the doctor has tried to issue: an error must clear
                               as they fix it, but must not appear under a box they have just opened. */
                            const opts = { shouldDirty: true, shouldValidate: rxForm.formState.isSubmitted };
                            if (patch.frequency !== undefined) rxForm.setValue(`lines.${i}.frequency`, patch.frequency, opts);
                            if (patch.instructions !== undefined) rxForm.setValue(`lines.${i}.instructions`, patch.instructions, opts);
                            if (patch.durationDays !== undefined) rxForm.setValue(`lines.${i}.durationDays`, patch.durationDays, opts);
                          }}
                        />
                        </div>
                        </div>
                      ))}
                      <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
                        {/* The board's add row: a dashed card across the column, not a small grey button. */}
                        <button type="button" className="cx-rxadd" data-testid="rx-add" onClick={() => { setRxOpen(lines.fields.length); lines.append(EMPTY_LINE); }}>
                          <span aria-hidden="true">+ </span>{t("opdConsult.addLine")}
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
                  {(notices.length > 0 || diseaseNotices.length > 0 || unreviewedLines.length > 0) && !noticesDismissed && (
                    <div data-testid="rx-notices" className="box" style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 5, padding: "10px 12px", fontSize: 12.5, borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}>
                      {notices.map((hit, i) => (
                        <p key={`${String(hit.lineIndex)}-${String(i)}`} data-testid={`rx-notice-${String(i)}`} style={{ margin: 0 }}>
                          {isInteractionHit(hit)
                            ? t("opdConsult.noticeInteraction", { n: hit.lineIndex + 1, note: hit.note })
                            : hit.drugClass !== undefined
                              ? t("opdConsult.noticeDuplicateClass", {
                                n: hit.lineIndex + 1, moiety: hit.moiety, with: hit.with ?? "",
                                cls: t(`opdConsult.therapyClass_${hit.drugClass}`, { defaultValue: hit.drugClass }),
                              })
                              : t("opdConsult.noticeDuplicate", { n: hit.lineIndex + 1, moiety: hit.moiety })}
                          {" "}
                          <span style={{ color: "var(--dim)" }}>{againstLabel(hit)}</span>
                        </p>
                      ))}
                      {/*
                        FORMULARY PHASE 3 — the checks above could see these lines only in part. One
                        sentence for all of them rather than one per line: it is the same fact.
                      */}
                      {unreviewedLines.length > 0 && (
                        <p data-testid="rx-unreviewed" style={{ margin: 0 }}>
                          {t("opdConsult.partlyChecked", {
                            count: unreviewedLines.length,
                            lines: unreviewedLines.map((i) => String(i + 1)).join(", "),
                          })}
                        </p>
                      )}
                      <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("opdConsult.inSystemOnly")}</p>
                      {/*
                        P24 — a soft drug-disease hit: the book rated it moderate, OR it rests on a
                        diagnosis over a year old and was downgraded for that reason (`stale`). The
                        date is shown either way, because a doctor judging a 2019 code needs to see
                        that it is a 2019 code.
                      */}
                      {diseaseNotices.map((h, i) => (
                        <div key={`dxn-${String(h.lineIndex)}-${h.icd10Prefix}`} data-testid={`rx-disease-notice-${String(i)}`}>
                          <p style={{ margin: 0 }}>
                            {t("opdConsult.diseaseNotice", { n: h.lineIndex + 1, moiety: h.moiety, title: h.icd10Title, note: h.note })}{" "}
                            <span style={{ color: "var(--dim)" }}>
                              {h.stale
                                ? t("opdConsult.diseaseStale", { code: h.diagnosis.code, on: h.diagnosis.codedOn })
                                : t("opdConsult.diseaseCodedOn", { code: h.diagnosis.code, on: h.diagnosis.codedOn })}
                            </span>
                          </p>
                          {h.alternatives.length > 0 && (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4, alignItems: "center" }}>
                              <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("opdConsult.switchTo")}</span>
                              {h.alternatives.map((a) => (
                                <button
                                  key={a.moiety} type="button" className="sec"
                                  data-testid={`disease-notice-switch-${String(i)}-${a.moiety}`}
                                  style={{ padding: "2px 10px", fontSize: 11.5 }}
                                  onClick={() => { applySwitch(h.lineIndex, a); }}
                                >
                                  {a.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      <button type="button" className="sec" style={{ alignSelf: "flex-start", padding: "2px 10px", fontSize: 11.5 }} onClick={() => setNoticesDismissed(true)}>
                        {t("opdConsult.dismiss")}
                      </button>
                    </div>
                  )}
                  <ErrorLine message={rxError} />
                </div>
                )}

                {tab === "rx" && active !== null && <SectionHistory visits={timelineItems} currentEncounterId={active.encounterId} sections={["rx"]} testId="history-foot-rx" />}

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
              {active !== null && tab === "inv" && (
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
              {active !== null && tab === "inv" && (
                <LabResultsPanel visitNo={visit.data?.encounter.visitNo ?? null} />
              )}
              {tab === "inv" && active !== null && <SectionHistory visits={timelineItems} currentEncounterId={active.encounterId} sections={["inv"]} testId="history-foot-inv" />}

              {/* (c) follow-up, referral fields — the Advice & follow-up tab; Complete lives in the header */}
              {tab === "advice" && (
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
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button type="button" className="sec" data-testid="refer-open-advice" style={{ padding: "3px 12px", fontSize: 12.5 }} onClick={() => { setReferDone(null); setReferOpen(true); }}>
                    {t("opdConsultV2.refer.open")}
                  </button>
                </div>
              </div>
              )}
              </div>
              </fieldset>
            </div>
          )}
        </main>
      </div>

      {/* the allergy hard-warning: a reason per matched line, then the re-post carries them (K48) */}
      <DeskModal
        open={matches !== null || interactionHits.length > 0 || duplicateHits.length > 0 || diseaseHits.length > 0}
        /*
          THE TITLE MUST NAME WHAT IS ACTUALLY IN THE DIALOG. A browser walk at 400 px found this
          reading "Allergy conflict" over a drug-disease warning, above a hint that told the doctor
          the patient "is recorded as allergic to the substances below" — for a patient with no
          allergy at all. It has been imprecise since the interaction and duplicate kinds joined
          (P16a); the fourth kind is what made it visibly false. The allergy wording is kept for the
          allergy-only case, which is the commonest one and the one it was written for.
        */
        title={allergyOnly ? t("opdConsult.overrideTitle") : t("opdConsult.overrideTitleChecks")}
        titleId="override-title" testId="override-dialog"
        onClose={() => {
          setMatches(null);
          setReasons([]);
          setInteractionHits([]);
          setInteractionReasons([]);
          setDuplicateHits([]);
          setDuplicateReasons([]);
          setDiseaseHits([]);
          setDiseaseReasons([]);
          setOverrideError(null);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          <p style={{ margin: 0, fontSize: 12.5 }}>
            {allergyOnly ? t("opdConsult.overrideHint") : t("opdConsult.overrideHintChecks")}
          </p>
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
          {/*
            P24 — the fourth kind, in the same dialog and the same reason input as its three
            neighbours, plus the one thing the others cannot offer: a vetted alternative. The label
            names the DIAGNOSIS and the date it was coded, so the doctor is overriding a fact they
            can see rather than a verdict they cannot.
          */}
          {diseaseHits.map((h, i) => (
            <div key={`dx-${String(h.lineIndex)}-${h.icd10Prefix}`}>
              <label style={{ display: "block", marginBottom: 5, fontSize: 12.5, fontWeight: 600 }} htmlFor={`disease-reason-${String(i)}`}>
                {t("opdConsult.diseaseHit", { n: h.lineIndex + 1, moiety: h.moiety, title: h.icd10Title, note: h.note })}{" "}
                <span style={{ fontWeight: 400, color: "var(--dim)" }}>
                  {t("opdConsult.diseaseCodedOn", { code: h.diagnosis.code, on: h.diagnosis.codedOn })}
                </span>
              </label>
              <input
                id={`disease-reason-${String(i)}`}
                data-testid={`disease-reason-${String(i)}`}
                value={diseaseReasons[i] ?? ""}
                onChange={(e) => setDiseaseReasons((rs) => rs.map((r, j) => (j === i ? e.target.value : r)))}
                className="in" style={{ width: "100%", height: 34, fontSize: 13 }}
              />
              {h.alternatives.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("opdConsult.switchTo")}</span>
                  {h.alternatives.map((a) => (
                    <button
                      key={a.moiety} type="button" className="sec"
                      data-testid={`disease-switch-${String(i)}-${a.moiety}`}
                      style={{ padding: "2px 10px", fontSize: 11.5 }}
                      onClick={() => { applySwitch(h.lineIndex, a); }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {(interactionHits.length > 0 || duplicateHits.length > 0 || diseaseHits.length > 0) && (
            <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("opdConsult.inSystemOnly")}</p>
          )}
          <ErrorLine message={overrideError} />
          <button type="button" className="pri" style={{ alignSelf: "flex-start" }} onClick={() => void confirmOverride()}>{t("opdConsult.overrideConfirm")}</button>
        </div>
      </DeskModal>

      {/* THE ONLY `.print-doc` RENDER SITE ON THIS SCREEN — one nullable state, one mount. */}
      {/*
        ═══ SEEING A PATIENT BEFORE THE BILL — THE DOCTOR'S OWN SENTENCE (OWNER RULING 2026-09-20) ═══

        A reason, typed, mandatory — the same rule the front desk's waiver carries (FD-32) and for
        the same argument: "emergency" and "the chairman's guest" are different facts with different
        consequences, and only a sentence tells them apart. The button is disabled until there is
        one, and the server refuses an empty one too (`reason_required`), so the doctor learns it
        from the screen rather than from an error. The line about the bill is there because this
        dialog is the last moment anybody can believe the fee has been waived: it has not been.
      */}
      <DeskModal
        open={openingUnpaid !== null}
        title={t("opdConsult.openUnpaidTitle", { token: openingUnpaid?.tokenNo ?? "" })}
        titleId="open-unpaid-title" testId="open-unpaid-dialog" width={460}
        onClose={() => { setOpeningUnpaid(null); }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("opdConsult.openUnpaidHint")}</p>
          <div>
            <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="open-unpaid-reason">
              {t("opdConsult.openUnpaidReason")}
            </label>
            <input
              id="open-unpaid-reason" data-testid="open-unpaid-reason" value={unpaidReason}
              onChange={(ev) => { setUnpaidReason(ev.target.value); }}
              className="in" style={{ width: "100%", height: 34, fontSize: 13 }}
            />
          </div>
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--faint)" }}>{t("opdConsult.openUnpaidStillOwed")}</p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 7 }}>
            <button type="button" className="sec" style={{ padding: "4px 13px", fontSize: 12.5 }} onClick={() => { setOpeningUnpaid(null); }}>
              {t("opdConsult.cancel")}
            </button>
            <button
              type="button" className="pri" data-testid="open-unpaid-confirm"
              style={{ padding: "4px 13px", fontSize: 12.5 }}
              disabled={unpaidReason.trim().length < 3}
              onClick={() => void confirmOpenUnpaid()}
            >
              {t("opdConsult.openUnpaidConfirm")}
            </button>
          </div>
        </div>
      </DeskModal>

      {/*
        ═══ THE SKIP DIALOG — SIX BUTTONS AND A BOX, AND IT IS NOT OPTIONAL ═══

        A reason field a doctor can leave empty is a reason field that is always empty, so there is
        no "skip anyway": one of the six is always selected, `absent` to begin with, because that is
        what a skip usually means. `other` is the only one that demands the box, and the button
        stays disabled until it has something — the server refuses it too (`reason_required`), and
        the disabled button is only so the doctor learns that from the screen and not from an error.
      */}
      <DeskModal
        open={skipping !== null}
        title={t("opdConsult.skipTitle", { token: skipping?.tokenNo ?? "" })}
        titleId="skip-title" testId="skip-dialog" width={460}
        onClose={() => { setSkipping(null); }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("opdConsult.skipHint")}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {SKIP_REASONS.map((r) => (
              <button
                key={r} type="button" data-testid={`skip-reason-${r}`}
                aria-pressed={skipReason === r}
                className={skipReason === r ? "pri" : "sec"}
                style={{ padding: "4px 11px", fontSize: 12 }}
                onClick={() => { setSkipReason(r); }}
              >
                {t(`opdConsult.skipReason.${r}`)}
              </button>
            ))}
          </div>
          <div>
            <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor="skip-note">
              {skipReason === "other" ? t("opdConsult.skipNoteRequired") : t("opdConsult.skipNote")}
            </label>
            <input
              id="skip-note" value={skipNote} onChange={(ev) => { setSkipNote(ev.target.value); }}
              className="in" style={{ width: "100%", height: 34, fontSize: 13 }}
            />
          </div>
          {/*
            THE MIS-CLICK IS NAMED HERE, where a doctor reaching for a reason will read it — the one
            answer that is not a reason, because it must cost the patient nothing.
          */}
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--faint)" }}>{t("opdConsult.skipMistakeHint")}</p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 7 }}>
            <button type="button" className="sec" style={{ padding: "4px 13px", fontSize: 12.5 }} onClick={() => { setSkipping(null); }}>
              {t("opdConsult.cancel")}
            </button>
            <button
              type="button" className="pri" data-testid="skip-confirm"
              style={{ padding: "4px 13px", fontSize: 12.5 }}
              disabled={skipReason === "other" && skipNote.trim() === ""}
              onClick={() => void confirmSkip()}
            >
              {t("opdConsult.skip")}
            </button>
          </div>
        </div>
      </DeskModal>

      {/* ROUND 6 / D18 — the History browser: read-only, every visit opened is a logged visit read. */}
      <DeskModal
        open={historyOpen && active !== null} title={t("opdConsultV2.history.title")} titleId="history-title" testId="history-dialog" width={980}
        trapFocus centred closeLabel={t("opdConsultV2.history.close")}
        onClose={() => { setHistoryOpen(false); }}
      >
        {active !== null && <HistoryBrowser visits={timelineItems} currentEncounterId={active.encounterId} />}
        {/* the v1 History tab's views (visits, prescriptions, vitals trend, scanned documents) — kept, now inside the dialog */}
        {active !== null && (
                <div data-testid="history-v1" style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line2)" }}>
                  {/*
                    PLAN 07d T1 — THREE VIEWS OF THE SAME PATIENT, and the two new ones are the point
                    of the task. Visits is what existed; prescriptions and vitals are what a doctor
                    has been unable to see since this application shipped.
                  */}
                  <div style={{ marginBottom: 10, display: "flex", gap: 6 }} role="group" aria-label={t("opdConsult.historyView")}>
                    {(["visits", "rx", "vitals", "documents"] as const).map((v) => (
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

                  {/*
                    ═══ THE PAPER THE DESK PHOTOGRAPHED, WHERE THE DOCTOR LOOKS FOR IT ═══

                    Owner, 2026-09-14. The list is METADATA — a doctor scanning for "did they bring
                    the outside prescription" needs when and what, not four megabytes of JPEG for
                    every visit. Opening one is a deliberate second request, which is also what
                    keeps the access log honest about who actually read a prescription.
                  */}
                  {historyView === "documents" && (
                    <div data-testid="document-history" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
                      {documents.isPending && <p style={{ margin: 0, color: "var(--dim)" }}>{t("app.loading")}</p>}
                      {!documents.isPending && (documents.data?.items ?? []).length === 0 && (
                        <p data-testid="no-documents" style={{ margin: 0, color: "var(--dim)" }}>{t("opdConsult.noDocuments")}</p>
                      )}
                      {(documents.data?.items ?? []).map((d) => (
                        <div key={d.id} data-testid={`document-${d.id}`} style={{ borderBottom: "1px solid var(--line)", paddingBottom: 5 }}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "baseline" }}>
                            <span style={{ fontWeight: 600 }}>{t(`opdConsult.documentKind.${d.kind}`, { defaultValue: d.kind })}</span>
                            <span className="mo" style={{ fontSize: 11, color: "var(--faint)" }}>
                              {new Date(d.capturedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                            </span>
                            {d.note !== null && <span style={{ color: "var(--dim)" }}>{d.note}</span>}
                            <button
                              type="button" className="sec" data-testid={`document-open-${d.id}`}
                              style={{ marginLeft: "auto", height: 24, fontSize: 11 }}
                              onClick={() => { setOpenDocumentId(openDocumentId === d.id ? null : d.id); }}
                            >
                              {openDocumentId === d.id ? t("opdConsult.documentHide") : t("opdConsult.documentOpen")}
                            </button>
                          </div>
                          {openDocumentId === d.id && (
                            <div style={{ marginTop: 6 }}>
                              {openDocument.isPending && <p style={{ margin: 0, color: "var(--dim)" }}>{t("app.loading")}</p>}
                              {openDocument.isError && (
                                <p role="alert" data-testid={`document-error-${d.id}`} style={{ margin: 0, color: "var(--red)", fontWeight: 600 }}>
                                  {t("opdConsult.documentUnreadable")}
                                </p>
                              )}
                              {openDocument.data !== undefined && openDocument.data.mimeType !== "application/pdf" && (
                                <img
                                  data-testid={`document-image-${d.id}`}
                                  src={`data:${openDocument.data.mimeType};base64,${openDocument.data.imageBase64}`}
                                  alt={t("opdConsult.documentAlt")}
                                  style={{ maxWidth: "100%", border: "1px solid var(--line)", borderRadius: 4 }}
                                />
                              )}
                              {openDocument.data !== undefined && openDocument.data.mimeType === "application/pdf" && (
                                <a
                                  data-testid={`document-pdf-${d.id}`}
                                  href={`data:application/pdf;base64,${openDocument.data.imageBase64}`}
                                  target="_blank" rel="noreferrer"
                                  style={{ fontSize: 12, color: "var(--green)" }}
                                >
                                  {t("opdConsult.documentOpenPdf")}
                                </a>
                              )}
                            </div>
                          )}
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
      </DeskModal>

      {/* CONSULT V2 — refer: another department's doctor (a new visit in that line), or out with a letter. */}
      <DeskModal
        open={referOpen && active !== null} title={t("opdConsultV2.refer.title")} titleId="refer-title" testId="refer-dialog" width={480}
        onClose={() => { setReferOpen(false); }}
      >
        {active !== null && (
          <ReferPanel
            encounterId={active.encounterId}
            patientName={patient.data?.patient.name ?? patientLabel(active.summary)}
            doctorName={me.data?.displayName ?? ""}
            onInternal={(r) => {
              setReferralTo(r.where);
              setReferralNote(r.why);
              setReferDone(t("opdConsultV2.refer.doneInternal", { token: r.tokenNo, where: r.where }));
              setAgentLog((l) => logged(l, t("opdConsultV2.refer.doneInternal", { token: r.tokenNo, where: r.where }), "ok"));
              setReferOpen(false);
            }}
            onExternal={(to, note) => {
              setReferralTo(to);
              setReferralNote(note);
              setReferDone(t("opdConsultV2.refer.doneExternal", { to }));
            }}
          />
        )}
      </DeskModal>

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
      {/* <1024 an open side column is a drawer; the scrim closes it */}
      {vw < 1024 && ((active === null ? leftOnBrief : leftOnConsult) || rightOpen) && (
        <button type="button" className="cx-scrim" aria-label={t("opdConsultV2.closePanels")} data-testid="cx-scrim"
          onClick={() => { if (active === null) setLeftOnBrief(false); else setLeftOnConsult(false); setRightOpen(false); }} />
      )}
      <CopilotPanel
        open={rightOpen} onToggle={(next) => { setAgentAutoFocus(false); setRightOpen(next); }}
        alert={stockAlerts.length > 0}
        dock={(
          <AgentDock
            variant="panel" autoFocus={agentAutoFocus}
            answer={copilot.answer} log={agentLog} onAsk={copilot.ask}
            panel={copilot.report === null ? undefined : (
              <CopilotReport report={copilot.report} onDismiss={copilot.dismissReport} />
            )}
            cards={(() => {
              const sug = suggestionsFor("pane");
              const alts = stockAlerts.map((a) => (
                <StockAlternativeCard
                  key={`${String(a.index)}-${a.stock.medicineId}`} drug={a.drug} stock={a.stock}
                  onUse={(medicineId, label) => { pickAlternative(a.index, a.stock.medicineId, medicineId, label); }}
                  onKeep={() => { keepWritten(a.stock); }}
                />
              ));
              return sug === null && alts.length === 0 ? undefined : <>{sug}{alts}</>;
            })()}
            placeholder={t("opdConsult.askPlaceholder")} idle={t("opdConsult.agentIdle")}
          />
        )}
      />
    </div>
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
