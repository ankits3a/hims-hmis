import { ALL_MANIFESTS } from "../modules/manifests";
import { installedCopilotIntents, strongCue, weakCue } from "./intents";
import type { CollectedCopilotIntent, CopilotIntentMenu, Cue, ModuleCopilotIntent } from "./intents";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — THE DETERMINISTIC FLOOR
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `modules/opd/triage.ts` established the shape this follows, and its comment states the rule:
 * *"It is the fallback AND the floor — if the model is unavailable the desk still routes."* The
 * copilot inherits both halves. Almost every question a counter asks is one of a dozen sentences,
 * so the floor answers them instantly, for nothing, and the model is reached only for the tail.
 * That is what makes the whole thing cheap: spend is proportional to novelty, not to traffic.
 *
 * ═══ WHY THIS SCORES INSTEAD OF BRANCHING ═══
 *
 * Ten screens already do this with `q.toLowerCase()` and a first-match-wins `if/else`. That shape
 * cannot express "this token is weak evidence for two intents", and shipped code pays for it:
 * Desk One files `kitna` under the queue branch and `paisa`/`kitna` under the fee branch, so
 * "kitna paisa baaki hai" — plainly a money question — answers about the queue, because the queue
 * branch happens to be written first. The consult screen has the identical defect with `line`.
 *
 * So every intent is SCORED and the winner must beat the runner-up by a margin. A question whose
 * evidence is genuinely split returns null, and null is routed to the model. Admitting a miss costs
 * one cheap model call; guessing costs a clerk's trust the first time it is confidently wrong.
 */

/**
 * The intents whose words the KERNEL still holds (the tables below). #598 opened the seam: a module may
 * declare its own in `ModuleManifest.copilotIntents` (`intents.ts`) — `roster.ask_cover` was the first to
 * move — and the rest move with their modules, one at a time.
 */
export type KernelCopilotIntent = "visit_status" | "queue_depth" | "patient_dues" | "my_day_report" | "stock_on_shelf" | "paid_not_collected" | "draft_short_book_entry" | "draft_purchase_orders" | "draft_payment_run" | "draft_supplier_returns" | "find_duplicate_items"
  | "roster.who_is_on" | "roster.unit_on_take" | "roster.my_duties"
  | "appointment_book" | "appointment_move"
  | "roster.leave_apply" | "roster.leave_status"
  | "reminders.create";

/** The tools a question can be routed to: the kernel's, and any a module declares (`<module>.<name>`). */
export type CopilotIntent = KernelCopilotIntent | ModuleCopilotIntent;

export type IntentMatch = {
  intent: CopilotIntent;
  /** The placeholder this question was about, or null when it named no patient. */
  slot: string | null;
  /** Which cues fired. The seat SAYS why it answered — `triage.ts`'s `source` rule, one level finer. */
  cues: string[];
  score: number;
};


/**
 * STRONG cues name the intent almost by themselves. WEAK cues are the shared connective tissue of
 * counter Hindi — `kitna`, `kaun`, `hai` — which mean nothing alone and tip a balance when a strong
 * cue is already present. Getting this split right is the entire difference from the ten chains.
 *
 * A cue containing a SPACE outranks both, and that fell out of a failing test rather than a guess.
 * "is <<P1>> still waiting" is a question about one patient, but `still waiting` contains `wait`,
 * which is the queue's strongest single token — scored equally the two intents tie and the margin
 * rule refuses to answer. A phrase is strictly more evidence than any word inside it, so it scores
 * higher, and the tie disappears.
 */
const S = strongCue;
const W = weakCue;

/**
 * Cues are matched as SUBSTRINGS, which is deliberate for Hindi: `dekh` has to catch "dekha",
 * "dekh liya" and "dekhliya", and a word-boundary match would need every inflection spelled out.
 * The cost is that a cue must be long enough not to appear inside an unrelated word — hence `bakay`
 * rather than `baki`, and no cue shorter than three characters.
 */
const CUES: Record<KernelCopilotIntent, Cue[]> = {
  /** "Has this person been seen yet / where are they?" — the owner's first example. */
  visit_status: [
    S("been seen"), S("seen by"), S("dekh"), S("देख"), S("mil gaya"), S("mila"),
    S("still waiting"), S("consult"), S("doctor ne"), S("डॉक्टर"),
    /*
      2026-09-19 — "मरीज <<P1>> अभी भी इंतज़ार में है क्या" answered the QUEUE: `इंतज़ार` is the
      queue's strong cue and this intent had no Hindi "STILL waiting" to set against it. The phrase
      outweighs the word inside it, as `still waiting` already does in English; a bare "kitna
      intezaar hai", with no "still", stays the queue's.
    */
    S("अभी भी इंतज़ार"), S("abhi bhi intezaar"), S("abhi bhi intezar"), S("ab bhi intezaar"),
    S("number aaya"), S("number aa gaya"),
    W("doctor"), W("status"), W("andar"), W("bulaya"),
  ],
  /** "How long / which line?" — what a clerk asks on behalf of somebody in front of them. */
  queue_depth: [
    S("wait"), S("queue"), S("line"), S("bhid"), S("भीड़"), S("intezaar"), S("इंतज़ार"),
    S("kitni der"), S("how long"), S("katar"), S("क़तार"),
    /* #672 — "how much TIME will it take" is the queue's; `डॉक्टर` alone was answering it as one patient's visit. */
    S("kitna samay"), S("कितना समय"), S("samay lagega"), S("समय लगेगा"), S("kitna time"), S("time lagega"),
    W("kam"), W("chhoti"), W("shortest"), W("kaun si"), W("kitna"),
  ],
  /** "What does this person owe?" */
  patient_dues: [
    S("paisa"), S("paise"), S("bakay"), S("baaki"), S("बकाया"), S("due"), S("dues"),
    S("owe"), S("outstanding"), S("balance"), S("पैसा"),
    /* #672 — the Devanagari `बाकी` was missing, so "<<P1>> का कितना भुगतान बाकी है" went to the supplier payment run. */
    S("बाकी"), S("बाक़ी"),
    W("kitna"), W("कितना"), W("bill"), W("amount"),
  ],
  /** "Give me my day." — the owner's second example, and the one that must DO something. */
  my_day_report: [
    S("day report"), S("din ki report"), S("meri report"), S("my day"), S("report nikaal"),
    S("today's figures"), S("aaj ki report"), S("aaj ka hisaab"), S("दिन की रिपोर्ट"),
    S("kitne register"), S("day's figures"), S("end of day"),
    W("report"), W("aaj"), W("today"), W("figures"), W("summary"),
  ],
  /**
   * PD-7 C8 — "kitni amoxicillin bachi hai", "Pan 40 kab expire hoga": a medicine BY NAME on the
   * pharmacy shelf. The name itself is not a cue (it is the tool's subject, read from the question).
   * Left out on purpose, each for a question it would have stolen: `bache` (also children, and
   * patients still waiting), `available` ("is the doctor available"), `how many` / `how much`
   * ("how many are waiting", "how much does he owe"), bare `left` ("patients left to see").
   */
  stock_on_shelf: [
    S("stock"), S("in stock"), S("bachi"), S("bacha"), S("on the shelf"), S("shelf"), S("is left"), S("are left"),
    S("expire"), S("expiry"), S("kab expire"), S("स्टॉक"), S("बची"), S("बचा"), S("एक्सपायर"),
    W("kitni"), W("dawai"), W("medicine"), W("strip"), W("goli"), W("दवा"),
  ],
  /**
   * PD-7 C8 — "kiska paisa pending hai" at the pharmacy: paid, and the medicines not yet collected
   * (E25 — a paid ticket can stand uncollected). `pending` alone is weak on purpose: "<<P1>> ka
   * paisa pending hai" is a question about ONE patient's dues and must stay `patient_dues`.
   */
  paid_not_collected: [
    S("not collected"), S("uncollected"), S("collect nahi"), S("nahi le gaye"), S("le nahi gaye"),
    S("nahi liya"), S("liya nahi"), S("paid but"), S("pickup"), S("kiska paisa pending"), S("waiting to collect"),
    /*
      2026-09-19 — "kaun paisa dekar dawai lene nahi aaya" answered DUES: `paisa` scored 3 and
      nothing here matched, because the counter says the patient did not COME to take it as often
      as that they did not take it. "Paid, then" is its own phrase; with a named patient it ties
      `paisa` + the placeholder, and the tie goes to the model rather than to either guess.
    */
    S("lene nahi aaya"), S("lene nahi aaye"), S("lene nahi aayi"), S("nahi aaya lene"),
    S("paisa dekar"), S("paise dekar"), S("pay karke"),
    S("दवा नहीं ली"), S("लेने नहीं आया"), S("पैसे दे दिए"),
    /*
      #672 — "paid, but did not PICK IT UP / did not take it": `paise` (dues) and `bhugtan` (the
      supplier payment run) each answered alone because none of these was a cue. "Paid, but the
      medicine…" is weak on purpose (`par dawa`, `lekin dawa`): it tips a balance, never decides one.
    */
    S("nahi uthayi"), S("nahin uthayi"), S("nahi uthaya"), S("nahin uthaya"), S("nahi li"), S("nahin li"),
    S("paise de diye"), S("paisa de diya"), S("bhugtan ho gaya"), S("counter par padi"), S("counter pe padi"),
    W("pending"), W("collect"), W("le gaye"), W("par dawa"), W("lekin dawa"),
  ],
  /**
   * PARITY P1 (2026-09-24) — "Pan 40 khatam", "out of Pan 40": the counter says a drug is short,
   * and the agent DRAFTS a short-book line for the pharmacist to confirm. `out of stock` outweighs
   * the shelf's `stock` (a phrase outranks the word inside it); `nahi bacha` is left out, because
   * against the shelf's `bacha` it would tie inside the margin and send a plain stock question to
   * the model.
   */
  draft_short_book_entry: [
    S("khatam"), S("khatm"), S("khtm"), S("खत्म"), S("ख़त्म"), S("out of"), S("out of stock"), S("ran out"),
    S("short book"), S("shortbook"), S("shortage"), S("short hai"), S("short ho"),
    /* #672 — "X nahi bachi, note kar lo" asks for the line to be WRITTEN; `bachi` alone was answering it from the shelf. */
    S("note kar"),
    W("likh"), W("note"), W("finished"),
  ],
  /**
   * PARITY P2 (2026-09-24) — "order karo", "make the orders": the agent DRAFTS purchase orders from
   * the reorder list and the short book. Phrases only, plus the bare `order` as a weak word: the tool
   * writes nothing (it answers with a card linking to the office, where a person makes the drafts).
   */
  draft_purchase_orders: [
    S("order karo"), S("order kar do"), S("order bana"), S("orders bana"), S("purchase order"), S("make the orders"),
    S("make orders"), S("draft the orders"), S("draft orders"), S("draft purchase"), S("po bana"), S("ऑर्डर कर"), S("ऑर्डर बना"),
    W("order"), W("orders"), W("ऑर्डर"),
  ],
  /**
   * PARITY P3 (2026-09-25) — "payment run bana do", "pay the suppliers": the agent DRAFTS a payment run
   * from the bills falling due. Phrases only — "due" and "paisa" are a patient's dues and stay there.
   * The tool writes nothing: its card opens the office, where a person makes the draft, the owner
   * authorises it and somebody else records it paid.
   */
  draft_payment_run: [
    S("payment run"), S("pay the suppliers"), S("pay suppliers"), S("pay the vendors"), S("pay vendors"), S("supplier payment"),
    S("vendor payment"), S("payment bana"), S("payment karo"), S("payment kar do"), S("bills to pay"), S("bhugtan"), S("भुगतान"),
    /* #672 — a distributor's money is a payment run, not a patient's dues (`paisa`). */
    S("run bana"), S("distributor ka paisa"), S("supplier ka paisa"), S("vendor ka paisa"),
  ],
  /**
   * PARITY P4 (2026-09-25) — "expiry return bana do", "expired maal wapas bhejo": the agent DRAFTS
   * returns to the suppliers from the expiry list. Phrases, so a plain "kab expire hoga" stays the
   * shelf's (`stock_on_shelf` holds `expire` / `expiry`), and "दवा वापस" outweighs the shelf's
   * `एक्सपायर` + `दवा`. The tool writes nothing: its card opens the office, where a person makes the
   * drafts, the head approves each and somebody else dispatches it.
   */
  draft_supplier_returns: [
    S("supplier return"), S("purchase return"), S("return to supplier"), S("return to the supplier"), S("return bana"), S("returns bana"),
    S("expiry return"), S("expired maal"), S("wapas bhej"), S("vapas bhej"), S("debit note"), S("वापस भेज"), S("दवा वापस"),
    /*
      #672 — "expired medicines are to be RETURNED / sent back to the company": `expire` + `dawai`
      answered from the shelf, because `lautana` and "back to the supplier" were cues nowhere. The
      receiving party (`company ko`, `distributor ko`) is weak: "supplier ko payment karo" must not tie.
    */
    S("lautan"), S("लौटान"), S("return kar"), S("back to the supplier"), S("back to supplier"), S("send back"), S("expired stock"),
    W("wapas"), W("vapas"), W("वापस"), W("company ko"), W("कंपनी को"), W("distributor ko"), W("supplier ko"), W("सप्लायर को"),
  ],
  /**
   * PHARMACY P6 (hygiene, 2026-09-26) — "duplicate items dikhao", "same medicine do baar bana hai": the
   * agent LISTS the item-master rows that look like one thing twice. Read-only: its card opens the
   * office's items side, where a person opens a pair, raises the merge and the superintendent approves it.
   */
  find_duplicate_items: [
    S("duplicate item"), S("duplicate items"), S("duplicate medicine"), S("duplicate entries"), S("duplicate entry"), S("merge items"),
    S("merge item"), S("item merge"), S("do baar"), S("twice in the item"), S("same medicine twice"), S("डुप्लिकेट"), S("दो बार"),
    W("duplicate"), W("duplicates"), W("merge"),
  ],
  /**
   * 20-U U9 (2026-10-04) — THE ROSTER'S FOUR. "ortho mein abhi on call kaun hai?" — who is on, for a
   * department or a service, now or at the time named. `kaun`, `abhi`, `duty` are weak: alone they
   * are every counter question ("doctor kaun hai abhi" stays unanswered rather than guessed).
   */
  "roster.who_is_on": [
    S("on call"), S("oncall"), S("on-call"), S("on duty"), S("duty pe"), S("duty par"), S("who is on"), S("kaun hai duty"),
    S("ऑन कॉल"), S("ड्यूटी पर"),
    W("kaun"), W("abhi"), W("duty"), W("ड्यूटी"), W("कौन"),
  ],
  /**
   * "kal raat surgery ka unit kaun sa hai?" — which UNIT is on take. The phrase `unit kaun` outweighs
   * the board's weak `kaun`; a bare `unit` or `take` alone is not enough to answer.
   */
  "roster.unit_on_take": [
    S("unit kaun"), S("kaun sa unit"), S("kaunsa unit"), S("konsa unit"), S("which unit"), S("on take"), S("take pe"),
    S("take par"), S("admitting unit"), S("यूनिट कौन"), S("कौन सा यूनिट"),
    W("unit"), W("take"), W("यूनिट"),
  ],
  /**
   * "mera agla night kab hai?" — the reader's OWN duties. `meri duty` beats the board's `duty`, and
   * `मेरी ड्यूटी` beats its `ड्यूटी` by the margin, so "my duty" is never read as "who is on".
   */
  "roster.my_duties": [
    S("meri duty"), S("mera duty"), S("my duty"), S("my duties"), S("my next"), S("mera agla"), S("meri agli"),
    S("agla night"), S("agli night"), S("next night"), S("my night"), S("meri night"), S("mera night"), S("मेरी ड्यूटी"),
    S("मेरा अगला"), S("मेरी अगली"),
    /* #672 — "am I on call" is the asker's own duty; the board's `on call` alone was answering it as "who is on". */
    S("am i on"), S("do i have duty"), S("am i working"),
    W("mera"), W("meri"), W("मेरी"), W("मेरा"), W("kab"), W("agla"), W("agli"), W("night"),
  ],
  /* "roster.ask_cover" — somebody to take MY duty — is the roster's own declaration now (#598, `modules/roster/copilot-intents.ts`). */
  /*
    E2.1 — BOOK OR MOVE AN APPOINTMENT (act tools behind propose → confirm). "Appointment" alone is a
    booking: "Dr Singh kal 10 baje U00110012 ka appointment" has no verb at all. A move verb outweighs
    it (NOT_CUES below), so "appointment shift karo" is a move and never a second booking. These are
    the floor ONLY (`FLOOR_ONLY_INTENTS`): a booking question names a patient, and no model is offered it.
  */
  appointment_book: [
    S("appoint"), S("apoint"), S("apointment"), S("appt"), S("अपॉइंट"), S("अपोइंट"), S("book"), S("बुक"),
    S("time de do"), S("time dena"), S("slot de"), S("milwa do"),
    W("slot"), W("doctor se"),
  ],
  appointment_move: [
    S("move"), S("shift kar"), S("pe shift"), S("par shift"), S("ko shift"), S("shift the"), S("shift appointment"), S("reschedul"), S("badal"), S("badl"), S("postpone"), S("prepone"),
    S("aage kar"), S("aage badha"), S("peeche kar"), S("piche kar"), S("khiska"), S("बदल"), S("शिफ्ट"), S("खिसका"),
    S("date change"), S("time change"), S("change the appointment"), S("change appointment"),
  ],
  /*
    E2.2 — MY LEAVE (decision 0069). Asking for it ("kal CL chahiye", "20 se 22 oct chhutti") and asking
    what became of it ("meri leave ka kya hua"). Floor ONLY (`FLOOR_ONLY_INTENTS`): what a person types
    beside a leave may be why, so no model is offered these. Short kind codes are phrases ("cl chahiye"):
    the floor matches substrings, and a bare `cl` is inside "clinic".
  */
  "roster.leave_apply": [
    S("leave chahiye"), S("leave chahie"), S("leave lena"), S("leave leni"), S("leave le"), S("leave apply"), S("apply leave"),
    S("apply for leave"), S("leave de do"), S("leave do"), S("chutti chahiye"), S("chhutti chahiye"), S("chutti lena"), S("chhutti lena"),
    S("chutti le"), S("chhutti le"), S("chutti de"), S("chhutti de"), S("छुट्टी चाहिए"), S("छुट्टी ले"), S("छुट्टी दे"),
    S("casual leave"), S("earned leave"), S("medical leave"), S("sick leave"), S("comp off"), S("compoff"),
    S("cl chahiye"), S("el chahiye"), S("ml chahiye"), S("cl lena"), S("el lena"), S("ml lena"), S("cl le"), S("el le"), S("ml le"),
    S("cl apply"), S("el apply"), S("ml apply"), S("need leave"), S("want leave"), S("take leave"), S("i need a leave"),
    W("leave"), W("chutti"), W("chhutti"), W("छुट्टी"),
  ],
  "roster.leave_status": [
    S("leave ka kya"), S("chutti ka kya"), S("chhutti ka kya"), S("छुट्टी का क्या"), S("leave status"), S("status of my leave"),
    S("leave approve hui"), S("leave approve hua"), S("leave mili"), S("chutti mili"), S("chhutti mili"), S("छुट्टी मिली"),
    S("leave mil gayi"), S("chutti mil gayi"), S("chhutti mil gayi"), S("leave sanction"), S("my leave"), S("meri leave"), S("meri chutti"),
    S("meri chhutti"), S("मेरी छुट्टी"), S("leave approved"), S("was my leave"), S("is my leave"),
    W("leave"), W("chutti"), W("chhutti"), W("छुट्टी"),
  ],
  /*
    E2.3 — A REMINDER (#593). "remind me at 4 to see bed 12", "kal 9 baje yaad dilana". Floor ONLY: the
    words of a reminder are the person's own and may name a patient. The asking word and the phrase
    around it both score, so the rest of the sentence ("see bed 12", "apply leave") cannot outvote it.
  */
  "reminders.create": [
    S("remind me"), S("remind"), S("reminder laga"), S("reminder set"), S("set a reminder"), S("set reminder"), S("reminder"),
    S("yaad dila"), S("yaad kara"), W("yaad"), S("याद दिला"), S("याद करा"), W("याद"),
  ],
};

/**
 * ═══ #672 — NEGATIVE CUES: WORDS THAT SAY "NOT THIS ONE" ═══
 *
 * Measured on the frozen eval set (E0.4, 2026-10-11): 12 of its 17 misses were this floor answering
 * confidently with the wrong tool before the chooser was ever asked, and the chooser had the right
 * answer for every one of them. Some of those cannot be fixed by adding a cue for the right intent,
 * because the right intent's words are too common to be safe cues — "printer mein paper khatam" is
 * not a short-book line, and no cue says "printer" means anything. So a word may also COUNT AGAINST
 * an intent. A drafting verb ("list bana do") or a supplier says a question is not about the shelf;
 * equipment says `khatam` is not a medicine running out. The usual outcome is that the floor
 * abstains and the chooser answers — admitting a miss is still cheaper than a confident wrong.
 */
const NOT_WEIGHT = 3;
const NOT_CUES: Partial<Record<KernelCopilotIntent, string[]>> = {
  stock_on_shelf: ["bana do", "list bana", "return", "lautan", "लौटा", "supplier", "सप्लायर", "distributor"],
  draft_short_book_entry: ["printer", "paper", "toner", "cartridge"],
  /* E2.1 — "short book" is the pharmacy's register, and a move is never a second booking. */
  appointment_book: ["short book", "shortbook", "kitni", "kitne", "how many", "maine", "i booked", "did i book", "move", "shift", "reschedul", "badal", "badl", "postpone", "prepone",
    "aage kar", "peeche kar", "piche kar", "khiska", "बदल", "शिफ्ट", "खिसका", "date change", "time change", "change the appointment", "change appointment"],
  /* A duty swap is the roster's, and "doctor badal do" at the counter moves a VISIT today — never an appointment act. */
  appointment_move: ["duty", "ड्यूटी", "night", "rota", "doctor badal", "doctor change", "department badal"],
  /*
    E2.2 — asking what became of a leave is not asking for one; and "is Dr Sharma on leave" (somebody
    ELSE's leave, the OPD's question) is neither.
  */
  "roster.leave_apply": ["kya hua", "status", "leave mili", "chutti mili", "chhutti mili", "mil gayi", "approve hui", "approve hua", "approved", "sanction", "kab tak", "pending",
    "on leave", "par hai", "pe hai", "par hain", "pe hain", "kaun", "who", "क्या हुआ", "मिली"],
  "roster.leave_status": ["chahiye", "chahie", "lena", "leni", "apply", "de do", "चाहिए", "need", "want", "take leave",
    "on leave", "par hai", "pe hai", "kaun", "who"],
};

/**
 * E2.3 — the words that ask for a reminder count AGAINST every other intent: "remind me at 4 to check
 * the stock", "yaad dilana leave apply karna" are a reminder about a thing, never the thing itself.
 */
const REMINDER_ASKS = ["remind", "yaad dila", "yaad kara", "याद दिला", "याद करा"];

const PLACEHOLDER_RE = /<<P\d+>>/;

/** The lowest score that may answer at all, and the margin the winner must beat the runner-up by. */
const MIN_SCORE = 3;
const MIN_MARGIN = 2;

/**
 * ═══ `\p{M}` IS LOAD-BEARING, AND LEAVING IT OUT SHREDDED EVERY HINDI WORD ═══
 *
 * The first draft of this kept `\p{L}` and `\p{N}` and dropped everything else. In Devanagari the
 * vowel signs and the virama are Unicode MARKS, not letters — so `डॉक्टर` (ड + ◌ॉ + क + ◌् + ट + र)
 * normalised to `ड क टर`, and every Devanagari cue in the table below silently matched nothing.
 * The Hindi tests failed and the romanised ones passed, which is exactly the shape of bug that
 * ships when a feature is only ever typed in by its author.
 *
 * ═══ AND NFC, FOR THE SAME REASON ONE LEVEL DOWN (2026-09-19) ═══
 *
 * `ज़` is one code point on some keyboards (U+095B) and two on others (ज + nukta); so are `ड़`, `फ़`
 * and the rest. The table's `इंतज़ार` is the two-point form, and a question typed with the one-point
 * form matched nothing. NFC maps both spellings to one sequence, on both sides of the comparison.
 */
function normalise(question: string): string {
  return question
    .normalize("NFC")
    .toLowerCase()
    /*
      Punctuation to spaces rather than removed: "dekh-liya" and "dekh liya" must normalise the
      same way, and deleting the separator would fuse tokens instead of splitting them. The
      placeholder's own angle brackets are preserved — it is matched before this runs.
    */
    .replace(/[^\p{L}\p{M}\p{N}<>\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cues are normalised through the SAME function as the question, at module load.
 *
 * Also found by a failing test: `today's figures` never matched, because the question's apostrophe
 * became a space and the cue's did not. Any table matched against normalised text has to be
 * normalised by the same code, or the two drift the first time a cue contains punctuation.
 */
function normaliseCues(intent: string, positive: readonly Cue[], not: readonly string[]): Cue[] {
  /*
    #672 — ONE CUE COUNTS ONCE. `on call` and `on-call` normalise to the same token, so "am I on
    call" scored the board's `on call` twice (8) and nothing the asker's own duty had could reach it.
  */
  const seen = new Set<string>();
  const cues: Cue[] = [];
  for (const cue of positive) {
    const token = normalise(cue.token);
    if (seen.has(token)) continue;
    seen.add(token);
    cues.push({ token, weight: cue.weight });
  }
  for (const n of not) cues.push({ token: normalise(n), weight: -NOT_WEIGHT });
  if (intent !== "reminders.create") for (const n of REMINDER_ASKS) cues.push({ token: normalise(n), weight: -NOT_WEIGHT });
  return cues;
}

const NORMALISED_CUES: Record<KernelCopilotIntent, Cue[]> = Object.fromEntries(
  (Object.keys(CUES) as KernelCopilotIntent[]).map((intent) => [intent, normaliseCues(intent, CUES[intent], NOT_CUES[intent] ?? [])]),
) as Record<KernelCopilotIntent, Cue[]>;

/**
 * ═══ #598 — THE MODULES' OWN INTENTS, MERGED AFTER THE KERNEL'S ═══
 *
 * The set `CopilotController` installed at boot from the injected registry; until one is installed,
 * the declarations read straight off `ALL_MANIFESTS` (the same list in production) — so a unit test or
 * the eval recorder that calls `matchIntent` directly routes a module's intent exactly as the API does.
 * Unchecked here: the boot refusals are `collectCopilotIntents`', and the API never runs without them.
 */
let fromManifests: readonly CollectedCopilotIntent[] | null = null;
export function moduleCopilotIntents(): readonly CollectedCopilotIntent[] {
  const live = installedCopilotIntents();
  if (live !== null) return live;
  fromManifests ??= ALL_MANIFESTS.flatMap((m) =>
    Object.entries(m.copilotIntents ?? {}).map(([intent, decl]) => ({ intent: intent as ModuleCopilotIntent, module: m.key, decl })),
  );
  return fromManifests;
}

type Book = { modules: readonly CollectedCopilotIntent[]; cues: [CopilotIntent, Cue[]][]; words: string[] };
let book: Book | null = null;

/** Every intent's normalised cues, kernel first and in table order, then the modules' in registry order. */
function currentBook(): Book {
  const modules = moduleCopilotIntents();
  if (book?.modules === modules) return book;
  const cues: [CopilotIntent, Cue[]][] = [
    ...(Object.keys(NORMALISED_CUES) as KernelCopilotIntent[]).map((i): [CopilotIntent, Cue[]] => [i, NORMALISED_CUES[i]]),
    ...modules.map((m): [CopilotIntent, Cue[]] => [m.intent, normaliseCues(m.intent, m.decl.cues, m.decl.notCues ?? [])]),
  ];
  const words = new Set<string>();
  for (const [, list] of cues) {
    for (const cue of list) if (cue.weight > 0) for (const w of cue.token.split(" ")) if (w !== "") words.add(w);
  }
  book = { modules, cues, words: [...words] };
  return book;
}

/** A cue token as the floor compares it — for the boot check that refuses a cue two intents claim. */
export function normaliseCue(token: string): string {
  return normalise(token);
}

/** The kernel-held intents' POSITIVE cue tokens, normalised, for the same boot check. */
export function kernelCueTokens(): Map<KernelCopilotIntent, Set<string>> {
  return new Map((Object.keys(NORMALISED_CUES) as KernelCopilotIntent[]).map((i) => [
    i, new Set(NORMALISED_CUES[i].filter((c) => c.weight > 0).map((c) => c.token)),
  ]));
}

/**
 * Route a MASKED question to one tool, or return null and let the model try.
 *
 * Takes the masked form so the floor and the model see the same string, and so that the presence of
 * a placeholder is itself usable evidence — a question carrying one is about a specific patient.
 */
export function matchIntent(question: string): IntentMatch | null {
  const slotHit = PLACEHOLDER_RE.exec(question);
  const slot = slotHit === null ? null : slotHit[0];
  const text = normalise(question);
  if (text === "" || text.replace(PLACEHOLDER_RE, "").trim() === "") return null;

  const scored = currentBook().cues.map(([intent, list]) => {
    const cues: string[] = [];
    let score = 0;
    for (const cue of list) {
      if (!text.includes(cue.token)) continue;
      cues.push(cue.weight < 0 ? `not:${cue.token}` : cue.token);
      score += cue.weight;
    }
    /*
      A NAMED PATIENT IS EVIDENCE FOR THE PATIENT-SCOPED INTENTS, and it is worth one weak cue
      rather than a strong one. "<<P1>> ka kitna paisa baaki hai" should not need the nudge — the
      money cues carry it — but "<<P1>> ka number aaya kya" has only weak cues of its own, and a
      question that names somebody is more likely to be about them than about the room.
    */
    if (slot !== null && (intent === "visit_status" || intent === "patient_dues")) score += 1;
    return { intent, slot, cues, score };
  }).sort((a, b) => b.score - a.score);

  const [best, runnerUp] = scored;
  if (best === undefined || best.score < MIN_SCORE) return null;
  if (runnerUp !== undefined && best.score - runnerUp.score < MIN_MARGIN) return null;
  return best;
}

/**
 * The tool names, for the model's menu. Derived from the same object the floor scores, so the two
 * halves can never disagree about what exists — a menu maintained by hand would drift the first
 * time a tool was added.
 */
export function intentNames(): CopilotIntent[] {
  return [...kernelIntentNames(), ...moduleCopilotIntents().map((m) => m.intent)];
}

/** #598 — only the intents whose words the kernel itself holds. */
export function kernelIntentNames(): KernelCopilotIntent[] {
  return Object.keys(CUES) as KernelCopilotIntent[];
}

/**
 * E2.1 — INTENTS THE FLOOR ALONE MAY ROUTE. Booking and moving an appointment name a patient, often
 * by a name the day's mask does not know (a future booking), so they are never offered on a model's
 * menu: a question the floor does not recognise as a booking is "not understood", never guessed into
 * one. Keeping them off the menu also keeps the menu — and the eval set's recordings — unchanged.
 */
export const FLOOR_ONLY_INTENTS = ["appointment_book", "appointment_move", "roster.leave_apply", "roster.leave_status", "reminders.create"] as const satisfies readonly CopilotIntent[];
export type ModelIntent = Exclude<KernelCopilotIntent, (typeof FLOOR_ONLY_INTENTS)[number]>;

/**
 * The menu a model is offered: every kernel intent except the floor-only ones, then every module intent
 * that declares a `menu` (one without is floor-only by construction).
 */
export function modelIntentNames(): (ModelIntent | ModuleCopilotIntent)[] {
  return [
    ...kernelIntentNames().filter((i): i is ModelIntent => !(FLOOR_ONLY_INTENTS as readonly string[]).includes(i)),
    ...moduleMenus().map((m) => m.intent),
  ];
}

/** #598 — the module intents a model may be offered, in registry order, each with its menu entry. */
export function moduleMenus(): { intent: ModuleCopilotIntent; menu: CopilotIntentMenu }[] {
  return moduleCopilotIntents().flatMap((m) => m.decl.menu === undefined ? [] : [{ intent: m.intent, menu: m.decl.menu }]);
}

/** #598 — the module intents the "I did not understand" help offers, after the kernel's own. */
export function moduleHelpIntents(): ModuleCopilotIntent[] {
  return moduleCopilotIntents().filter((m) => m.decl.help === true).map((m) => m.intent);
}

/**
 * E0.6 — every single word the cues are made of, normalised. `names.ts` never masks one of these on
 * its own (a patient part that equals "bill" or "kab" would otherwise eat the cue that routes the
 * question), and never treats a near-spelling of one as a name.
 */
export function cueWords(): string[] {
  /* The same array until the installed set changes, so `names.ts` can cache what it derives by identity. */
  return currentBook().words;
}
