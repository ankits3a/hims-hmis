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

export type Form = {
  name: string;
  phone: string;
  age: string;
  sex: "" | "male" | "female" | "other";
  address: string;
};

export const EMPTY_FORM: Form = { name: "", phone: "", age: "", sex: "", address: "" };

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
  amend: (patch: { phone?: string; addressLine?: string }) => Promise<void>;
  setLane: (lane: Lane) => Promise<void>;
  /** Leaves the desk for `/billing/session` — the float is counted, so it is not an inline act. */
  openDrawer: () => void;
  clearDesk: () => void;
  ask: (question: string) => void;
  goto: (stage: Stage) => void;
};

const DeskContext = createContext<DeskApi | null>(null);
export const DeskProvider = DeskContext.Provider;

export function useDesk(): DeskApi {
  const ctx = useContext(DeskContext);
  if (ctx === null) throw new Error("useDesk outside DeskProvider");
  return ctx;
}
