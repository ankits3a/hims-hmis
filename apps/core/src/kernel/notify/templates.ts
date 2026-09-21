import type { NotifyChannel } from "./adapters";
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
  channels?: NotifyChannel[]; // default ["whatsapp", "sms"] — a staff template narrows to ["web_push"]
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

  /**
   * ═══ PLAN 18a T2 — THE IMAGING REPORT NOTICE, AND IT CARRIES THE ORDER NUMBER AND NOTHING ELSE ═══
   *
   * The lab's twin above is the template this is modelled on, deliberately down to the omissions.
   *
   * **It names no study, no modality and no body part.** "Your CT head report is ready" on a lock
   * screen tells whoever is holding the phone that this person had a head scan, and a message a
   * husband reads is the exact disclosure DD11's alias rules exist to prevent. An obstetric
   * ultrasound makes that concrete in the worst way: in a PCPNDT context a notice naming the study
   * is a notice about a pregnancy, sent to a household. So the notice is a TOKEN — an order number
   * and an instruction to come to a counter — and the report itself is handed over in person
   * against an ID.
   *
   * `transactional`, so it is not subject to the marketing consent gate: a person who asked for a
   * scan is expecting to hear that it is ready, and D3's quiet-hours rule does not apply to a
   * document they are waiting for.
   *
   * 72 hours, the lab's number and for the lab's reason: a report is collected at a counter, and a
   * notice older than three days is one the patient has either acted on or forgotten.
   */
  imaging_report_ready: {
    key: "imaging_report_ready",
    version: 1,
    class: "transactional",
    audience: "patient",
    urgency: "routine",
    waApprovalStatus: "not_submitted",
    expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 72 * HOUR_MS),
    render: {
      en: (params) =>
        `Your imaging report for ${paramStr(params, "orderNo")} is ready. Please collect it from the hospital reception. Bring this message and a photo ID.`,
      hi: (params) =>
        `${paramStr(params, "orderNo")} की आपकी इमेजिंग रिपोर्ट तैयार है। कृपया इसे अस्पताल के रिसेप्शन से प्राप्त करें। यह संदेश और एक फोटो पहचान पत्र साथ लाएँ।`,
    },
  },

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * PHASE O T4 — THE THREE STAFF RELAY TEMPLATES, AND WHAT THEY MAY NOT SAY
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `runReachLadder` relays an unread staff ALERT onto a louder channel. What it relays is the
   * spine's own four words and nothing else — **kind, lane, remaining minutes, link** (O10,
   * R10). Not the patient. Not a staff member's health fact. Not a rupee amount, not even as a
   * number the reader could infer one from: an amount travels as a BAND or not at all, and
   * these three carry neither.
   *
   * The reason is that these bodies leave the hospital. A push notification sits on a lock
   * screen in a shared house; a WhatsApp message sits in a chat backup; an SMS sits with a
   * telecom operator. The in-app alert the relay points at is where the detail lives, behind a
   * permission-checked route — which is what the `link` is for.
   *
   * `paramStr` is the only way any of them reads a param, so a caller that passes an object
   * gets `[object Object]` in the body rather than a leak. The params are exactly four and
   * `templates.test.ts` asserts the bodies against a params object carrying a patient's name to
   * prove the omission is real rather than incidental.
   */

  // Producer: `runReachLadder` for an alert in the `now` lane. URGENT, so quiet hours never
  // defer it (D7) and the night supervisor's exemption is not even consulted.
  staff_alert_relay_now: {
    key: "staff_alert_relay_now",
    version: 1,
    class: "transactional",
    audience: "staff",
    // THE FULL STAFF LADDER, IN ITS CANONICAL ORDER, AND THE ROW'S `rung` PICKS ONE OF THEM.
    // `runReachLadder` chooses the channel from the PERSON's ladder and then sets `rung` to
    // that channel's index here, so the pump sends on the channel the relay decided rather
    // than re-deriving one from `DEFAULT_CHANNELS` (which is the patient ladder and has no
    // browser rung at all).
    channels: ["web_push", "whatsapp", "sms"],
    urgency: "urgent",
    waApprovalStatus: "not_submitted",
    // Two hours. A "now" obligation that nobody has read in two hours is not going to be
    // answered by this message; it is the role ladder's problem by then.
    expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 2 * HOUR_MS),
    render: {
      en: (params) =>
        `${paramStr(params, "kind")} · now · ${paramStr(params, "remainingMinutes")} min left. Open: ${paramStr(params, "link")}`,
      hi: (params) =>
        `${paramStr(params, "kind")} · अभी · ${paramStr(params, "remainingMinutes")} मिनट शेष। खोलें: ${paramStr(params, "link")}`,
    },
  },

  // Producer: `runReachLadder` for the `today` and `can_wait` lanes. ROUTINE, so quiet hours
  // DO defer it — that is the whole difference between this template and the one above, and it
  // is why they are two templates rather than one with a variable word.
  staff_alert_relay_later: {
    key: "staff_alert_relay_later",
    version: 1,
    class: "transactional",
    audience: "staff",
    // THE FULL STAFF LADDER, IN ITS CANONICAL ORDER, AND THE ROW'S `rung` PICKS ONE OF THEM.
    // `runReachLadder` chooses the channel from the PERSON's ladder and then sets `rung` to
    // that channel's index here, so the pump sends on the channel the relay decided rather
    // than re-deriving one from `DEFAULT_CHANNELS` (which is the patient ladder and has no
    // browser rung at all).
    channels: ["web_push", "whatsapp", "sms"],
    urgency: "routine",
    waApprovalStatus: "not_submitted",
    expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 24 * HOUR_MS),
    render: {
      en: (params) =>
        `${paramStr(params, "kind")} · ${paramStr(params, "lane")} · ${paramStr(params, "remainingMinutes")} min left. Open: ${paramStr(params, "link")}`,
      hi: (params) =>
        `${paramStr(params, "kind")} · ${paramStr(params, "lane")} · ${paramStr(params, "remainingMinutes")} मिनट शेष। खोलें: ${paramStr(params, "link")}`,
    },
  },

  // Producer: `runReachLadder` when a person has spent their hourly interrupt budget (R9). ONE
  // message saying how many things are waiting, instead of the seventh, eighth and ninth.
  // It carries a COUNT and no kinds: five obligations listed by kind is five leaks, not one.
  staff_alert_digest: {
    key: "staff_alert_digest",
    version: 1,
    class: "transactional",
    audience: "staff",
    // THE FULL STAFF LADDER, IN ITS CANONICAL ORDER, AND THE ROW'S `rung` PICKS ONE OF THEM.
    // `runReachLadder` chooses the channel from the PERSON's ladder and then sets `rung` to
    // that channel's index here, so the pump sends on the channel the relay decided rather
    // than re-deriving one from `DEFAULT_CHANNELS` (which is the patient ladder and has no
    // browser rung at all).
    channels: ["web_push", "whatsapp", "sms"],
    urgency: "routine",
    waApprovalStatus: "not_submitted",
    expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 12 * HOUR_MS),
    render: {
      en: (params) =>
        `${paramStr(params, "kind")} things are waiting for you. Open: ${paramStr(params, "link")}`,
      hi: (params) =>
        `${paramStr(params, "kind")} काम आपकी प्रतीक्षा में हैं। खोलें: ${paramStr(params, "link")}`,
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
