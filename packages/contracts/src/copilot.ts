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
  /** Routed to an intent no module has shipped a tool for yet. Honest rather than a 500. */
  "copilot.answer.noTool",

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
] as const;

export type CopilotAnswerKey = (typeof COPILOT_ANSWER_KEYS)[number];
