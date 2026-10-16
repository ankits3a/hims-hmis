/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — EVERY SENTENCE THE DESK COPILOT CAN SAY, NAMED ONCE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A copilot tool answers with an i18n key, never prose — the server owns the arithmetic and the
 * LOCALE FILES own the words, so the clerk reads their own language and no generated text ever
 * reaches a counter. That leaves one gap, and this file exists to close it.
 *
 * ═══ THE GAP: `i18n-keys.test.ts` CANNOT SEE THESE ═══
 *
 * That test is the cheapest and best-aimed test in the repository — it scans every literal
 * `t("ns.key")` in the web source and checks it against `en.json`, because `lib/i18n.ts` sets no
 * `parseMissingKeyHandler`, so a missing key RENDERS ITSELF as visible text on the screen. Its own
 * header lists what that class has already cost this lane: FD-11's five look-defects, FD-2's five,
 * FD-24's photo buttons — green suites, wrong screen, found by a person looking at it.
 *
 * A copilot answer key is never a literal in the web source. It arrives in a response body and the
 * dock renders `t(answer.key)`, so the scanner sees `t(answer.key)` and can check nothing. Ship a
 * tool whose key nobody added to the locales and the clerk reads `copilot.answer.visitSeen` where a
 * sentence should be, with every suite green — exactly the defect that test was written to end,
 * arriving through the one door it cannot watch.
 *
 * So the set is declared HERE, in the package both sides already share: `apps/core` imports it so a
 * tool cannot invent a key, and the web's locale test asserts every member exists in `en.json` AND
 * `hi.json`. The scanner watches the literals; this watches the rest.
 */
export const COPILOT_ANSWER_KEYS = [
  /* ═══ The runner's own refusals — every one of them a sentence, never a stack trace ═══ */
  /** The asking user does not hold the permission this tool is gated on. */
  "copilot.answer.notPermitted",
  /** The tool needs a patient and the question named none. */
  "copilot.answer.needSubject",
  /** The tool threw. The clerk is told the desk could not answer, never what the database said. */
  "copilot.answer.failed",
  /** Neither the phrasebook nor the model recognised the question. */
  "copilot.answer.notUnderstood",
  /** #676 — the same, plus what the asker may ask: `can` is a comma list of intents the client says in words. */
  "copilot.answer.notUnderstoodCan",
  /** Routed to an intent no module has shipped a tool for yet. Honest rather than a 500. */
  "copilot.answer.noTool",
  /** E0.3 — the copilot (or this kind of tool) is halted by the owner, IT, the steward or the duty manager. */
  "copilot.answer.paused",

  /* ═══ E0.2 — propose → confirm → act: the confirm tap's own answers (a tool's success answer is its own) ═══ */
  /** A generic "done" for an act whose tool has no sentence of its own. */
  "copilot.answer.actDone",
  /** The proposal is older than its five minutes. */
  "copilot.answer.actExpired",
  /** The proposal is not genuine, not this person's, or names no act tool. */
  "copilot.answer.actInvalid",
  /** This proposal was already confirmed once; nothing more was written. */
  "copilot.answer.actAlreadyDone",
  /** Something changed between the proposal and the tap (the slot was taken). Nothing was written. */
  "copilot.answer.actStateChanged",

  /* ═══ my_day_report — the owner's "it should do it and give it to the user" ═══ */
  "copilot.answer.dayReport",
  /** The same report for a day that has not closed. Provisional is the server's, never the dock's. */
  "copilot.answer.dayReportProvisional",
  "copilot.answer.dayReportEmpty",

  /* ═══ visit_status — "kya U00110012 ko doctor ne dekh liya?" ═══ */
  /** Seen and finished. */
  "copilot.answer.visitSeen",
  /** With the doctor right now. */
  "copilot.answer.visitInConsult",
  /** Seen, and waiting on a test before the consultation can close. */
  "copilot.answer.visitAwaitingResults",
  /** Not yet seen — in the queue, token issued. */
  "copilot.answer.visitWaiting",
  /** Not yet seen — registered, not yet in a queue. */
  "copilot.answer.visitRegistered",
  /** The visit was abandoned. */
  "copilot.answer.visitAbandoned",
  /**
   * No such patient — OR one this clerk may not see. The two are deliberately one sentence, on the
   * same reasoning as `GET /opd/visits/by-number/:visitNo`, which answers `unknown_encounter` for a
   * sealed patient and for a missing one alike: a distinct "you may not see this" would confirm
   * that the person exists, which is the fact being protected.
   */
  "copilot.answer.visitUnknownPatient",
  /** The patient exists and has no visit on the day asked about. */
  "copilot.answer.visitNoneToday",
  /** A visit number that resolves to nothing, or a status outside the six. */
  "copilot.answer.visitUnknown",
  /**
   * THE UHID IS THE RIGHT SHAPE AND THE CHECK DIGIT SAYS IT WAS MISTYPED.
   *
   * Found by the e2e suite, which asked about an invented UHID and got told the VISIT was unknown.
   * A UHID is `<prefix><7-digit serial><Verhoeff check digit>` and `isValidUhid` validates the
   * digit — so a typo is DETECTABLE, and the first implementation threw that away: anything failing
   * the check fell through to the visit-number path and came back as "I could not find that visit",
   * about a patient. Telling a clerk the number is wrong is the entire reason the check digit is in
   * the number.
   */
  "copilot.answer.uhidCheckFailed",

  /* ═══ patient_dues (billing, E1.6) — the counter's own outstanding; dues only, never the advance (owner 2026-10-11) ═══ */
  /** "U00110012: ₹600.00 due · unpaid bills: 1 · oldest INV/26-27/000001 (2026-10-11)". */
  "copilot.answer.duesOwed",
  /** Nothing outstanding on any of the patient's bills. */
  "copilot.answer.duesNone",
  /** The question named a visit number or something else: a bill names a patient, so ask for the UHID. */
  "copilot.answer.duesNeedUhid",

  /* ═══ queue_depth ═══ */
  "copilot.answer.queueShortest",
  /** Nobody is holding a clinic today — a closed OPD, a Sunday, or every doctor on leave. */
  "copilot.answer.queueNoneOpen",

  /* ═══ stock_on_shelf (pharmacy, PD-7 C8) — "kitni amoxicillin bachi hai" ═══ */
  /** One medicine: how many can be sold, and the batch the next sale takes (FEFO) with its expiry. */
  "copilot.answer.stockOnShelf",
  /** On the shelf list, and nothing sellable — out, expired, recalled or all reserved. */
  "copilot.answer.stockEmpty",
  /** Several match; each with its count and next expiry, display-ready. */
  "copilot.answer.stockSeveral",
  /** Nothing on this shelf by that name, nor carrying a salt of that name. */
  "copilot.answer.stockNotFound",
  /** The question named no medicine ("ye batch…" with nothing on the screen to point at). */
  "copilot.answer.stockNeedName",

  /* ═══ paid_not_collected (pharmacy, PD-7 C8) — "kiska paisa pending hai" ═══ */
  "copilot.answer.uncollected",
  "copilot.answer.uncollectedNone",

  /*
    ═══ draft_short_book_entry (pharmacy, parity P1) — "Pan 40 khatam", "out of Pan 40" ═══
    A DRAFT, never a write: the answer's `payload` carries the draft and the desk shows it as a card
    the pharmacist confirms with one tap (which calls `POST /pharmacy/short-book`).
  */
  /** The draft is ready: "Note Pan 40 in the short book?" */
  "copilot.answer.shortBookDraft",
  /** That drug is already open in the short book — nothing to confirm. */
  "copilot.answer.shortBookAlready",
  /** The sentence named no drug ("khatam ho gaya"). */
  "copilot.answer.shortBookNeedName",

  /*
    ═══ draft_purchase_orders (pharmacy, parity P2) — "order karo", "make the orders" ═══
    A PLAN, never a write: the answer says how many orders the agent would draft, and its `payload`
    links to /pharmacy/office, where a person presses "make the drafts" and then reviews each one.
  */
  /** "3 orders, 11 lines ready to draft (2 items need a vendor) — open the office." */
  "copilot.answer.purchaseDraftPlan",
  /** Nothing is below its level and the short book is empty — nothing to order. */
  "copilot.answer.purchaseDraftNothing",

  /*
    ═══ draft_payment_run (pharmacy office, parity P3) — "payment run bana do", "pay the suppliers" ═══
    A PLAN, never a write: how many vendors and bills the agent would put on a run, and its `payload`
    links to /pharmacy/office, where a person makes the draft; the owner authorises it.
  */
  /** "4 vendors, 9 bills, ₹1,24,000 due by 2 Oct (1 vendor in bank-change cooling-off) — open the office." */
  "copilot.answer.paymentRunPlan",
  /** No accepted bill falls due within the week that a run does not already hold. */
  "copilot.answer.paymentRunNothing",

  /*
    ═══ draft_supplier_returns (pharmacy office, parity P4) — "expiry return bana do", "expired maal wapas bhejo" ═══
    A PLAN, never a write: how many vendors and batches the agent would put on returns, and what can
    only be destroyed; its `payload` links to /pharmacy/office?view=returns, where a person makes the
    drafts, the head approves each and somebody else dispatches it.
  */
  /** "3 vendors, 11 batches, ₹42,000 at cost can go back (2 batches past the window — destroy) — open the office." */
  "copilot.answer.returnPlan",
  /** Nothing expired within the window, near expiry or recalled that a return does not already hold. */
  "copilot.answer.returnNothing",

  /*
    ═══ find_duplicate_items (pharmacy office, P6 hygiene) — "duplicate items dikhao", "same medicine do baar" ═══
    A LIST, never a write: how many pairs of item-master rows look like one thing twice; its `payload`
    links to /pharmacy/office?view=items, where a person opens a pair and raises the merge.
  */
  /** "5 possible duplicates (3 the same medicine twice) — open the office." */
  "copilot.answer.duplicateItems",
  /** No two live items look like one thing twice. */
  "copilot.answer.duplicateItemsNothing",

  /*
    ═══ 20-U U9 — the roster: who is on, the unit on take, my duties, and a cover DRAFT ═══
    `rosterCoverDraft` is a DRAFT, never a write: its `payload` lists who can take the asker's duty,
    and the request is sent by the person's own tap (`POST /roster/covers`), as from My duties.
  */
  "copilot.answer.rosterNeedDept",
  "copilot.answer.rosterWhoIsOn",
  "copilot.answer.rosterWhoNoTake",
  "copilot.answer.rosterWhoUnpublished",
  "copilot.answer.rosterWhoService",
  "copilot.answer.rosterWhoServiceNobody",
  "copilot.answer.rosterWhoServiceUnpublished",
  "copilot.answer.rosterUnitOnTake",
  "copilot.answer.rosterUnitOnTakeNoBackup",
  "copilot.answer.rosterNoTake",
  "copilot.answer.rosterMyNext",
  "copilot.answer.rosterMyNextNight",
  "copilot.answer.rosterMyOnDay",
  "copilot.answer.rosterMyNone",
  "copilot.answer.rosterMyNoNight",
  "copilot.answer.rosterMyNoneOnDay",
  "copilot.answer.rosterCoverDraft",
  "copilot.answer.rosterCoverDraftDuty",
  "copilot.answer.rosterCoverAlready",
  "copilot.answer.rosterCoverNobody",
  "copilot.answer.rosterCoverNoDuty",
  "copilot.answer.rosterCoverNoDutyOn",

  /*
    ═══ E2.1 — book / move an appointment from chat (spec SPEC-copilot-appt-2026-10-11) ═══
    The ask answers with a pick (patients and three free times, each a signed proposal); the confirm
    answers with what was written, read back from the row. `when` is an ISO instant.
  */
  "copilot.answer.apptPick",
  "copilot.answer.apptPickTime",
  "copilot.answer.apptWhichPatient",
  "copilot.answer.apptNoPatient",
  "copilot.answer.apptWhichDoctor",
  "copilot.answer.apptDoctorUnclear",
  "copilot.answer.apptNoSlots",
  "copilot.answer.apptNoSlotsOn",
  "copilot.answer.apptNoneToMove",
  "copilot.answer.apptNoMobile",
  "copilot.answer.apptBooked",
  "copilot.answer.apptMoved",
  "copilot.answer.apptSlotTaken",
  "copilot.answer.apptDoctorOnLeave",
  "copilot.answer.apptPast",
  "copilot.answer.apptChanged",

  /*
    ═══ E2.2 — leave, and a duty cover or swap, from chat (spec SPEC-copilot-leave-swap-2026-10-11) ═══
    `from` / `to` are IST days; `kind` is CL | EL | ML | comp_off and the clients say it in words. A
    refusal's `why` is the decider's own text, read back to its person only — never stored by the copilot.
  */
  "copilot.answer.leavePick",
  "copilot.answer.leavePickDay",
  "copilot.answer.leavePickKind",
  "copilot.answer.leavePickKindDay",
  "copilot.answer.leaveWhichDays",
  "copilot.answer.leaveInPast",
  "copilot.answer.leaveOverlaps",
  "copilot.answer.leaveTooLong",
  "copilot.answer.leaveKindNotHere",
  "copilot.answer.leaveFiled",
  "copilot.answer.leaveNone",
  "copilot.answer.leaveStatusRequested",
  "copilot.answer.leaveStatusApproved",
  "copilot.answer.leaveStatusRefused",
  "copilot.answer.leaveStatusCancelled",
  "copilot.answer.coverAsked",
  "copilot.answer.swapAsked",
  "copilot.answer.coverRefused",

  /*
    ═══ E2.3 — a reminder from chat (spec SPEC-copilot-reminders-2026-10-12) ═══
    `when` is an ISO instant. The reminder's own words ride the pick payload only, never a param.
  */
  "copilot.answer.reminderPick",
  "copilot.answer.reminderWhatTime",
  "copilot.answer.reminderPast",
  "copilot.answer.reminderWhat",
  "copilot.answer.reminderTooLong",
  "copilot.answer.reminderLimit",
  "copilot.answer.reminderSet",
] as const;

export type CopilotAnswerKey = (typeof COPILOT_ANSWER_KEYS)[number];

/**
 * #866 — HOW EACH ANSWER'S PARAMS ARE SAID, declared beside the keys rather than guessed from their names.
 *
 * `board`: a day sent as its IST date (`2026-10-17`) is said as the boards say it ("Saturday 17 Oct"), an
 * ISO instant as "on Saturday 17 Oct at 22:00", `when: "now"` as "right now" and an empty name list as
 * "nobody". `leave`: the same, and a leave's `kind` code is said as My leave says it. A key that is not
 * here passes its params through untouched — another tool's `2028-01-31` (a batch's expiry) is a date
 * with a year and stays one.
 *
 * The phone reads this map (`apps/mobile/src/copilot/model.ts`), so a module that adds answer keys with
 * days in them names their voice here, in the same file as the keys, and both apps say them alike.
 */
export type CopilotAnswerVoice = "board" | "leave";
export const COPILOT_ANSWER_VOICE: Readonly<Partial<Record<CopilotAnswerKey, CopilotAnswerVoice>>> = {
  "copilot.answer.rosterNeedDept": "board",
  "copilot.answer.rosterWhoIsOn": "board",
  "copilot.answer.rosterWhoNoTake": "board",
  "copilot.answer.rosterWhoUnpublished": "board",
  "copilot.answer.rosterWhoService": "board",
  "copilot.answer.rosterWhoServiceNobody": "board",
  "copilot.answer.rosterWhoServiceUnpublished": "board",
  "copilot.answer.rosterUnitOnTake": "board",
  "copilot.answer.rosterUnitOnTakeNoBackup": "board",
  "copilot.answer.rosterNoTake": "board",
  "copilot.answer.rosterMyNext": "board",
  "copilot.answer.rosterMyNextNight": "board",
  "copilot.answer.rosterMyOnDay": "board",
  "copilot.answer.rosterMyNone": "board",
  "copilot.answer.rosterMyNoNight": "board",
  "copilot.answer.rosterMyNoneOnDay": "board",
  "copilot.answer.rosterCoverDraft": "board",
  "copilot.answer.rosterCoverDraftDuty": "board",
  "copilot.answer.rosterCoverAlready": "board",
  "copilot.answer.rosterCoverNobody": "board",
  "copilot.answer.rosterCoverNoDuty": "board",
  "copilot.answer.rosterCoverNoDutyOn": "board",
  "copilot.answer.apptPick": "board",
  "copilot.answer.apptPickTime": "board",
  "copilot.answer.apptWhichPatient": "board",
  "copilot.answer.apptNoPatient": "board",
  "copilot.answer.apptWhichDoctor": "board",
  "copilot.answer.apptDoctorUnclear": "board",
  "copilot.answer.apptNoSlots": "board",
  "copilot.answer.apptNoSlotsOn": "board",
  "copilot.answer.apptNoneToMove": "board",
  "copilot.answer.apptNoMobile": "board",
  "copilot.answer.apptBooked": "board",
  "copilot.answer.apptMoved": "board",
  "copilot.answer.apptSlotTaken": "board",
  "copilot.answer.apptDoctorOnLeave": "board",
  "copilot.answer.apptPast": "board",
  "copilot.answer.apptChanged": "board",
  "copilot.answer.leavePick": "leave",
  "copilot.answer.leavePickDay": "leave",
  "copilot.answer.leavePickKind": "leave",
  "copilot.answer.leavePickKindDay": "leave",
  "copilot.answer.leaveWhichDays": "leave",
  "copilot.answer.leaveInPast": "leave",
  "copilot.answer.leaveOverlaps": "leave",
  "copilot.answer.leaveTooLong": "leave",
  "copilot.answer.leaveKindNotHere": "leave",
  "copilot.answer.leaveFiled": "leave",
  "copilot.answer.leaveNone": "leave",
  "copilot.answer.leaveStatusRequested": "leave",
  "copilot.answer.leaveStatusApproved": "leave",
  "copilot.answer.leaveStatusRefused": "leave",
  "copilot.answer.leaveStatusCancelled": "leave",
  "copilot.answer.reminderPick": "board",
  "copilot.answer.reminderWhatTime": "board",
  "copilot.answer.reminderPast": "board",
  "copilot.answer.reminderWhat": "board",
  "copilot.answer.reminderTooLong": "board",
  "copilot.answer.reminderLimit": "board",
  "copilot.answer.reminderSet": "board",
};

/**
 * E2.1 — the pick an appointment ask hands back in `answer.payload`: one row per patient (book) or per
 * live appointment (move), each with up to three free times. `proposal` indexes the ask response's
 * `proposals` — the signed proposal that time confirms. `when`/`at`/`from` are ISO instants.
 */
export type CopilotApptRow = {
  patient: { name: string; uhid: string; ageSex: string; phoneLast4: string | null };
  doctor: string;
  mode: "in_person" | "tele";
  /** move: where the appointment is now. */
  from: string | null;
  fromDoctor?: string;
  /** A tele-call and no mobile on record: no times; the booking screen can take a number. */
  noMobile: boolean;
  times: { at: string; proposal: number }[];
};
/**
 * E2.2 — a leave to confirm: the days, and one option per kind (one when the kind was said). `proposal`
 * indexes the ask response's `proposals`. No reason is carried: the chat never takes one.
 */
export type CopilotLeavePick = {
  kind: "leavePick";
  from: string;
  to: string;
  days: number;
  options: { leave: "CL" | "EL" | "ML" | "comp_off"; proposal: number }[];
};

/**
 * E2.2 — a duty to hand on: the asker's duty, and per person who can take it a cover (`give` null) and
 * the swaps they could give back (one of THEIR duties of the same post). Instants are ISO.
 */
export type CopilotCoverDuty = { istDate: string; night: boolean; startsAt: string; endsAt: string };
export type CopilotCoverPick = {
  kind: "coverPick";
  duty: CopilotCoverDuty & { post: string };
  options: { name: string; grade: string; teamName: string; crossUnit: boolean; give: CopilotCoverDuty | null; proposal: number }[];
  /** People who could take it but are not offered here (more than the card holds). */
  more: number;
};

/**
 * E2.3 — a reminder to confirm: the person's own words, the first time it rings (ISO) and how it
 * repeats (`ReminderRepeat`: none | daily | mon_sat | weekly). One option, so `proposal` is 0.
 */
export type CopilotReminderPick = {
  kind: "reminderPick";
  text: string;
  at: string;
  repeat: "none" | "daily" | "mon_sat" | "weekly";
  proposal: number;
};

export type CopilotApptPick = {
  kind: "apptPick";
  action: "book" | "move";
  /** The patient came from a search (mobile or name): the clerk taps the patient before a time. */
  pickPatient: boolean;
  rows: CopilotApptRow[];
};
