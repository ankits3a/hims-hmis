import { createContext, useContext } from "react";
import type { WirePatientHit } from "../../lib/patients-api";
import type { WireDepartment, WireDoctorSummary, WireSlot } from "../../lib/opd-api";
import type { WireFeeQuote, WireIssueInvoiceResult, TenderMode } from "../../lib/billing-api";
import type { WireRecognition } from "../../lib/membership-api";
import type { BillLine, DeptQueue, Lane, LogLine, Stage } from "./model";

/**
 * ═══ THE PERSON IN HAND ═══
 *
 * §3 of the artifact: *"the left column IS the patient session … It empties only on Esc; that is
 * why nothing is ever lost between pages."* This is that session, and the fields are exactly what
 * the desk needs to say a sentence about the person — never the patient row wholesale. A restricted
 * row shows its alias and the desk shows what the server allowed it to show.
 */
export type Person = {
  id: string;
  uhid: string;
  name: string;
  phone: string | null;
  gender: string;
  dob: string | null;
  hasAddress: boolean;
  /** True the moment this desk allocated the UHID — the dossier says "first visit" rather than a date. */
  justRegistered: boolean;
};

/** The visit this desk opened. `tokenNo === null` is the held/deferred lane, never an error. */
export type Visit = {
  encounterId: string;
  patientId: string;
  visitNo: string;
  departmentId: string;
  departmentName: string;
  doctorId: string;
  doctorName: string;
  roomCode: string | null;
  /** How many were already waiting when the position was taken, and the wait that implied. */
  ahead: number;
  waitMinutes: number;
  tokenNo: number | null;
  joining: boolean;
  joinError: string | null;
};

/** A slot held for a later day. It never displaces today's session — the artifact's own rule. */
export type FutureHold = {
  appointmentId: string;
  doctorName: string;
  departmentName: string;
  slotStart: string;
};

export type Overlay = "palette" | "flow" | "queues" | "edit" | "schema" | null;

/**
 * FD-12 — one entitlement the patient produced at the desk. Kept as STRINGS like the rest of this
 * form: a half-typed policy number is a normal intermediate state at a counter, and a form that
 * refuses to hold one makes the clerk fight it.
 */
export type CoverageDraft = {
  kind: "pmjay" | "insurance" | "tpa" | "corporate" | "cghs" | "esic" | "other";
  payerName: string;
  tpaName: string;
  policyNumber: string;
  cardNumber: string;
  beneficiaryId: string;
  employeeId: string;
  planClass: string;
  validFrom: string;
  validTo: string;
  verificationStatus: "self_declared" | "card_seen" | "verified";
};

export const EMPTY_COVERAGE: CoverageDraft = {
  kind: "pmjay", payerName: "", tpaName: "", policyNumber: "", cardNumber: "",
  beneficiaryId: "", employeeId: "", planClass: "", validFrom: "", validTo: "",
  verificationStatus: "self_declared",
};

/**
 * ═══ FD-12 — THE FORM GREW, AND THE FOUR FIELDS DID NOT MOVE ═══
 *
 * Owner ruling 2026-09-04: the four-field form "lacks many fields" beside a competitor's. Every
 * field below the first four is OPTIONAL and every one of them is behind a fold, because the two
 * demands are both real and they are opposite: a queue of walk-ins needs a name and a sex, and a
 * planned admission needs the whole record. A form that answers only one of them is wrong twice.
 *
 * `guardianName`/`guardianRelationship` are the exception that is not optional — see `StageRegister`.
 * The server has always refused a known minor without a guardian, so a paediatric walk-in could not
 * be registered from this desk at all until these existed.
 */
export type Form = {
  // the four that were always here, and still the only ones the fast path fills
  name: string;
  phone: string;
  age: string;
  sex: "" | "male" | "female" | "other";
  address: string;
  // identity
  title: string;
  fatherHusbandName: string;
  dob: string;
  /** "age" | "dob" — which one the clerk is entering. The server refuses both together. */
  ageMode: "age" | "dob";
  maritalStatus: string;
  bloodGroup: string;
  altPhone: string;
  language: "" | "hi" | "en";
  // where they live
  area: string;
  district: string;
  stateName: string;
  pincode: string;
  // ABHA
  abhaNumber: string;
  abhaAddress: string;
  // documents
  nationality: string;
  nationalIdType: string;
  nationalIdNumber: string;
  // who sent them
  referredBySource: string;
  referredByName: string;
  referredByPhone: string;
  referredBySpeciality: string;
  // the rest of the record
  religion: string;
  occupation: string;
  monthlyIncome: string;
  legacyUhid: string;
  isConfidential: boolean;
  promotionalOptIn: boolean;
  // the guardian — REQUIRED for a minor, which is why it is not merely another optional block
  guardianName: string;
  guardianRelationship: "" | "father" | "mother" | "spouse" | "sibling" | "legal_guardian" | "other";
  guardianPhone: string;
  guardianIdType: string;
  guardianIdNumber: string;
  // how it gets paid for
  coverages: CoverageDraft[];
};

export const EMPTY_FORM: Form = {
  name: "", phone: "", age: "", sex: "", address: "",
  title: "", fatherHusbandName: "", dob: "", ageMode: "age", maritalStatus: "", bloodGroup: "",
  altPhone: "", language: "",
  area: "", district: "", stateName: "", pincode: "",
  abhaNumber: "", abhaAddress: "",
  nationality: "", nationalIdType: "", nationalIdNumber: "",
  referredBySource: "", referredByName: "", referredByPhone: "", referredBySpeciality: "",
  religion: "", occupation: "", monthlyIncome: "", legacyUhid: "",
  isConfidential: false, promotionalOptIn: false,
  guardianName: "", guardianRelationship: "", guardianPhone: "",
  guardianIdType: "", guardianIdNumber: "",
  coverages: [],
};

export type Session = {
  stage: Stage;
  /** The find box. Kept on the session so Esc is the only thing that clears it. */
  query: string;
  person: Person | null;
  /** The enrolment form is open — a new walk-in, before the UHID exists. */
  enrolling: boolean;
  form: Form;
  /** The near matches `POST /patients` refused on, rendered as a warning the clerk may override. */
  duplicates: WirePatientHit[] | null;
  /**
   * FD-14 — the patient's face, as a data URL. Held HERE and not posted immediately, because during
   * enrolment there is no patient to post it against: `PUT /patients/:id/photo` needs a UHID and the
   * UHID is what registration is on its way to allocating. `enrol` uploads it the instant one exists.
   */
  photo: string | null;
  complaint: string;
  /** The server's department ranking for `complaint`, and whether a model or the table produced it. */
  triage: { departmentIds: string[]; source: "model" | "keywords" } | null;
  triageBusy: boolean;
  tab: "now" | "future";
  visit: Visit | null;
  future: FutureHold | null;
  /** Coupon codes the clerk presented. They travel with the quote AND the invoice or the money disagrees. */
  coupons: string[];
  attributionCode: string;
  issued: WireIssueInvoiceResult | null;
  tender: TenderMode | null;
  /**
   * A NON-CASH TENDER IS TWO ACTS, NOT ONE, AND THE SERVER IS WHY.
   *
   * `invoices.ts:761` refuses any tender other than cash whose `refText` is blank —
   * `tender_ref_required`, "a upi tender needs a settlement reference" — because the reconciliation
   * upload matches a bank statement row to a receipt BY that reference (`recon.ts:159`). So UPI and
   * CARD arm first and settle second; CASH is still one key, which is the artifact's "one key
   * settles" for the tender it was drawn for. Measured against the running server, not assumed: the
   * first version of this screen sent no reference and every UPI collection was refused.
   */
  armedTender: TenderMode | null;
  tenderRef: string;
  /** Rupees this desk has taken since the screen was opened — the drawer, as this session moved it. */
  takenPaise: number;
  log: LogLine[];
  /** What is in flight, named, so a button can say what it is waiting for rather than just spin. */
  busy: string | null;
  error: string | null;
  overlay: Overlay;
  drawer: boolean;
  answer: string | null;
  /** Wall-clock ms the person arrived at the desk — the "2 min at desk" figure on the done stage. */
  startedAt: number | null;
};

export function emptySession(): Session {
  return {
    stage: "find", query: "", person: null, enrolling: false, form: EMPTY_FORM, duplicates: null,
    photo: null,
    complaint: "", triage: null, triageBusy: false, tab: "now", visit: null, future: null,
    coupons: [], attributionCode: "", issued: null, tender: null, armedTender: null, tenderRef: "", takenPaise: 0,
    log: [], busy: null, error: null, overlay: null, drawer: false, answer: null, startedAt: null,
  };
}

/**
 * ═══ WHAT THE STAGES ARE ALLOWED TO DO ═══
 *
 * Every server write this screen performs is named here and implemented once, in the shell. A stage
 * component cannot reach `api()`: that is the property that makes the log total (§5 — everything
 * the desk does lands in it) and it is why RC-3's CRITICALs are structurally harder to write here —
 * the assembly's decisions are functions with names rather than JSX conditions.
 */
export type DeskApi = {
  s: Session;
  patch: (next: Partial<Session>) => void;
  lane: Lane;
  /** Server reads the whole screen shares. Undefined while loading, never invented. */
  departments: WireDepartment[];
  summaries: WireDoctorSummary[];
  /** The board, grouped by department and ordered by the shortest open line. */
  queues: DeptQueue[];
  quote: WireFeeQuote | null;
  /** The live bill, folded off the server's own priced draft — never re-added on the client. */
  bill: { lines: BillLine[]; totalPaise: number; free: boolean };
  /** Today, as an IST calendar date. One value for every read on the screen. */
  serviceDate: string;
  quoteError: string | null;
  recognition: WireRecognition | null;
  cashSession: { open: boolean; floatPaise: number } | null;
  dayStats: { label: string; value: string }[];
  clerkName: string;
  waiting: number;
  canSetFlow: boolean;
  /** FD-14 — what this patient already owes, before today's figure is quoted. 0 when clear. */
  duesPaise: number;
  duesCount: number;

  /** THE MONEY IS TAKEN — settled, credit-extended, or a free visit with nothing to collect. */
  moneyTaken: boolean;

  note: (text: string, kind?: LogLine["kind"]) => void;
  hold: (person: Person) => void;
  startEnrolment: () => void;
  enrol: (acknowledgeDuplicates?: boolean) => Promise<void>;
  runTriage: (text: string) => void;
  assign: (departmentId: string, doctorId: string | null) => Promise<void>;
  unassign: () => void;
  holdFutureSlot: (doctorId: string, slot: WireSlot, departmentName: string, doctorName: string) => Promise<void>;
  presentCoupon: (code: string) => void;
  presentSlip: (code: string) => void;
  /** `ref` is REQUIRED by the server for anything but cash; the bill stage arms and then calls. */
  settle: (via: TenderMode | "free", ref?: string) => Promise<void>;
  /** FD-15 — the corrections a counter actually makes, age above all. Class I changes carry a reason. */
  amend: (patch: {
    /* FD-23 close review — `null` REMOVES the number; `""` is not a value the server's
       `phoneField.nullable().optional()` accepts, and sending it 400'd the whole amendment. */
    phone?: string | null; addressLine?: string;
    name?: string; sex?: "male" | "female" | "other"; dob?: string; dobEstimated?: boolean;
    administrativeGender?: "male" | "female" | "other";
    reasonClass?: string;
  }) => Promise<void>;
  /**
   * FD-15 — send the patient back to the appointment stage with the current seating ABANDONED on
   * the server. Refused once money has been taken: that is a credit note, not a desk correction.
   */
  changeDoctor: (reason: string) => Promise<void>;
  /**
   * FD-18 — correct a misread visit type (the owner's billing override). Not a discount: the fee
   * quote re-derives from the corrected type, so a revisit is free because it IS a revisit.
   */
  reclassify: (visitType: "new" | "revisit" | "renewal", reason: string) => Promise<void>;
  setLane: (lane: Lane) => Promise<void>;
  /** Leaves the desk for `/billing/session` — the float is counted, so it is not an inline act. */
  openDrawer: () => void;
  clearDesk: () => void;
  ask: (question: string) => void;
  goto: (stage: Stage) => void;
  /**
   * FD-14 — set or clear the held face. When a patient is already in hand it uploads immediately;
   * during enrolment it only holds, because there is no UHID to upload against yet.
   */
  setPhoto: (dataUrl: string | null) => void;
};

const DeskContext = createContext<DeskApi | null>(null);
export const DeskProvider = DeskContext.Provider;

export function useDesk(): DeskApi {
  const ctx = useContext(DeskContext);
  if (ctx === null) throw new Error("useDesk outside DeskProvider");
  return ctx;
}

/**
 * ═══ FD-12 — HOW OLD IS THIS PERSON, from whichever of the two boxes the clerk used ═══
 *
 * One function because the answer drives something that must not be got twice-differently: whether
 * the guardian block is required. Returns null when the clerk has told us nothing, and null is NOT
 * treated as a minor — the server takes the same position (its rule "binds only on data it has"),
 * and a desk that demanded a guardian for every unknown age would be unusable for the adults who
 * cannot recall a birth year.
 */
export function formAgeYears(f: Pick<Form, "age" | "dob" | "ageMode">): number | null {
  if (f.ageMode === "age") {
    const n = Number.parseInt(f.age, 10);
    return Number.isFinite(n) && n >= 0 && n <= 130 ? n : null;
  }
  const d = new Date(f.dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - d.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < d.getUTCDate())) years -= 1;
  return years >= 0 && years <= 130 ? years : null;
}

/** MAJORITY_AGE_YEARS on the server. A known minor needs a guardian; an unknown age does not. */
export const MAJORITY_AGE = 18;

export function formNeedsGuardian(f: Pick<Form, "age" | "dob" | "ageMode">): boolean {
  const years = formAgeYears(f);
  return years !== null && years < MAJORITY_AGE;
}
