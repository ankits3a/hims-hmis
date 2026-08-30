// The notification template registry (Plan 10, D8). Versioned, typed, code — not data — because
// the enforcement IS the type: `render: Record<"hi" | "en", ...>` means a template missing a
// language does not compile. The starter catalog carries only the five templates with LIVE
// producers today (T5's consumer). Copy is short, factual, bilingual, and params-interpolated —
// no doctor-name or patient-name lookups (GC12: this module imports no module's tables, only
// `@hmis/contracts`) and no patient identity in the staff/owner bodies at all (GC5, N10's class).
// The hospital's own name is not yet chosen (roadmap item #5 — see apps/web/src/locales/*.json),
// so the copy below refers to "the hospital" / "अस्पताल" generically rather than inventing one.

export type NotificationTemplate = {
  key: string; // grammar: snake_case, audience-prefixed
  version: number; // bumped on any render change
  class: "transactional" | "promotional";
  audience: "patient" | "staff" | "owner";
  urgency: "routine" | "urgent";
  channels?: ("whatsapp" | "sms")[]; // default ["whatsapp", "sms"]
  waApprovalStatus: "not_submitted" | "pending" | "approved" | "rejected"; // data for §19, later
  expiresAt(params: Record<string, unknown>, occurredAt: Date): Date; // D5 — anchored on MEANING, never elapsed time
  render: Record<"hi" | "en", (params: Record<string, unknown>) => string>; // both, or no compile
};

const HOUR_MS = 60 * 60 * 1000;
const IST_TIME_ZONE = "Asia/Kolkata";

// params is Record<string, unknown> by D8's own type — these read a field defensively rather than
// asserting a cast, since a template's only contract with its caller is the producing event's
// payload shape, not a runtime guarantee this file can check.
function paramStr(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : String(value);
}

// serviceDate is an ISO calendar date ("YYYY-MM-DD", opd/events.ts's `isoDate`) — anchor it at
// IST midnight so the formatted day never shifts across the UTC boundary.
function formatServiceDate(params: Record<string, unknown>): string {
  const d = new Date(`${paramStr(params, "serviceDate")}T00:00:00+05:30`);
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: IST_TIME_ZONE }).format(d);
}

// slotStart is a full ISO instant (opd/events.ts's `iso`) — format the clock time a patient reads.
function formatSlotTime(params: Record<string, unknown>): string {
  const d = new Date(paramStr(params, "slotStart"));
  return new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: IST_TIME_ZONE }).format(d);
}

const expiresAtSlotStart = (params: Record<string, unknown>): Date => new Date(paramStr(params, "slotStart"));

export const notificationTemplates: Record<string, NotificationTemplate> = {
  // Producer: patient.registered (modules/patients/events.ts). D8: patient/routine, dies 24h
  // after registration — a welcome nobody read in a day is stale, not late.
  patient_welcome: {
    key: "patient_welcome",
    version: 1,
    class: "transactional",
    audience: "patient",
    urgency: "routine",
    waApprovalStatus: "not_submitted",
    expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 24 * HOUR_MS),
    render: {
      en: (params) =>
        `Welcome to the hospital. Your UHID is ${paramStr(params, "uhid")}. Please keep this number safe — you will need it for every future visit.`,
      hi: (params) =>
        `अस्पताल में आपका स्वागत है। आपका UHID ${paramStr(params, "uhid")} है। कृपया इसे सुरक्षित रखें — आगे की हर विज़िट में यह नंबर चाहिए होगा।`,
    },
  },

  // Producer: appointment.booked (modules/opd/events.ts). D8: patient/routine, dies at slotStart
  // — a confirmation for an appointment already past has nothing left to confirm.
  appointment_confirmed: {
    key: "appointment_confirmed",
    version: 1,
    class: "transactional",
    audience: "patient",
    urgency: "routine",
    waApprovalStatus: "not_submitted",
    expiresAt: (params) => expiresAtSlotStart(params),
    render: {
      en: (params) => `Your appointment is confirmed for ${formatServiceDate(params)} at ${formatSlotTime(params)}.`,
      hi: (params) => `आपकी अपॉइंटमेंट ${formatServiceDate(params)} को ${formatSlotTime(params)} बजे के लिए पक्की है।`,
    },
  },

  // Producer: appointment.booked, scheduled slotStart − 24h (D13). D8: patient/routine, dies at
  // slotStart — same anchor as the confirmation, same reasoning (D5).
  appointment_reminder: {
    key: "appointment_reminder",
    version: 1,
    class: "transactional",
    audience: "patient",
    urgency: "routine",
    waApprovalStatus: "not_submitted",
    expiresAt: (params) => expiresAtSlotStart(params),
    render: {
      en: (params) =>
        `Reminder: your appointment is on ${formatServiceDate(params)} at ${formatSlotTime(params)}. Please arrive 15 minutes early.`,
      hi: (params) =>
        `याद दिलाना: आपकी अपॉइंटमेंट ${formatServiceDate(params)} को ${formatSlotTime(params)} बजे है। कृपया 15 मिनट पहले पहुँचें।`,
    },
  },

  // Producer: escalation.triggered, per resolvedUserId (kernel/workflow/events.ts, D13). D8:
  // staff/urgent, dies 4h after the escalation fired — a stale escalation message is misleading,
  // not merely late. GC5/N10: no patient identity anywhere in this body — defKey/state/rung/role
  // are the ENTIRE params, exactly the producing event's structural fields.
  staff_escalation: {
    key: "staff_escalation",
    version: 1,
    class: "transactional",
    audience: "staff",
    urgency: "urgent",
    waApprovalStatus: "not_submitted",
    expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 4 * HOUR_MS),
    render: {
      en: (params) =>
        `Escalation: "${paramStr(params, "defKey")}" is at state "${paramStr(params, "state")}" (rung ${paramStr(params, "rung")}, role ${paramStr(params, "role")}). Please review.`,
      hi: (params) =>
        `एस्केलेशन: "${paramStr(params, "defKey")}" "${paramStr(params, "state")}" स्थिति में है (चरण ${paramStr(params, "rung")}, भूमिका ${paramStr(params, "role")})। कृपया समीक्षा करें।`,
    },
  },

  // Producer: escalation.triggered when fallbackExhausted, per owner-role holder (D13, fix 11's
  // owner-SMS half). D8: owner/urgent, dies 4h after the escalation fired. D6/fix 11: this
  // template narrows its own ladder to SMS only — the owner matrix is real-time and an SMS is the
  // channel fix 11 names, not a WhatsApp-first default. Same GC5/N10 body rule as the staff copy.
  owner_escalation_sms: {
    key: "owner_escalation_sms",
    version: 1,
    class: "transactional",
    audience: "owner",
    urgency: "urgent",
    channels: ["sms"],
    waApprovalStatus: "not_submitted",
    expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 4 * HOUR_MS),
    render: {
      en: (params) =>
        `URGENT: "${paramStr(params, "defKey")}" escalation exhausted at rung ${paramStr(params, "rung")} (state "${paramStr(params, "state")}", role ${paramStr(params, "role")}). Please act.`,
      hi: (params) =>
        `अत्यावश्यक: "${paramStr(params, "defKey")}" एस्केलेशन चरण ${paramStr(params, "rung")} पर समाप्त (स्थिति "${paramStr(params, "state")}", भूमिका ${paramStr(params, "role")})। कृपया कार्रवाई करें।`,
    },
  },

  /**
   * ═══ PLAN 17 §9.2 F3 / 17b T7 — **THE FOURTH KERNEL EDIT OF THE LAB'S BUILD, AND THE ONLY ONE
   * THIS PHASE MAKES.** ═══
   *
   * Producer: `lab.report_published` and `lab.report_amended` (modules/lab/reports.ts). The phase
   * document imagined `modules/lab/notify-templates.ts`; spike S7 found that this registry is a
   * CLOSED literal with no registration function, so a module cannot register a template and the
   * append lands here. Disclosed rather than absorbed: Plan 17 said three kernel edits and the true
   * number is four.
   *
   * ═══ TOKEN-ONLY: NO RESULT VALUE, NO ANALYTE NAME, NOT EVEN THE TEST (02 J3 / R-020) ═══
   *
   * The body says a report is ready and where to collect it, and that is the whole of it. There is
   * no patient-facing deep link before 22c-F, so there is nothing to link to — and a WhatsApp
   * message carrying a haemoglobin, or even the word "HIV", lands on a lock screen that a family
   * shares (E46). `orderNo` is the counter's own reference and is what a patient reads out at the
   * window; it names no test.
   *
   * D5 — it dies **72 hours** after publication. A report is collected at a counter and a notice
   * older than three days is a notice the patient has either acted on or forgotten; re-sending it
   * a week later would be a message about a document already in their hand.
   */
  patient_lab_report_ready: {
    key: "patient_lab_report_ready",
    version: 1,
    class: "transactional",
    audience: "patient",
    urgency: "routine",
    waApprovalStatus: "not_submitted",
    expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 72 * HOUR_MS),
    render: {
      en: (params) =>
        `Your laboratory report for ${paramStr(params, "orderNo")} is ready. Please collect it from the hospital reception. Bring this message and a photo ID.`,
      hi: (params) =>
        `${paramStr(params, "orderNo")} की आपकी प्रयोगशाला रिपोर्ट तैयार है। कृपया इसे अस्पताल के रिसेप्शन से प्राप्त करें। यह संदेश और एक फोटो पहचान पत्र साथ लाएँ।`,
    },
  },
};

export function templateByKey(key: string): NotificationTemplate {
  const template = notificationTemplates[key];
  if (!template) {
    throw new Error(`no notification template registered for key "${key}"`);
  }
  return template;
}
