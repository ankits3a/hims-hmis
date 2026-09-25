import { matchIntent } from "./phrasebook";

/**
 * FD-COPILOT T2 — THE FLOOR, AND THE BUG IT IS WRITTEN AGAINST.
 *
 * Ten screens each grew their own `question.toLowerCase()` + `if/else` chain, first-match-wins,
 * with no shared vocabulary and no test of the matching anywhere. That shape has a specific defect
 * and both of these are real, in shipped code:
 *
 *   - Desk One lists `kitna` under the QUEUE branch and `paisa`/`kitna` under the FEE branch.
 *     "kitna paisa baaki hai" is a money question that answers about the queue, because the queue
 *     branch is written first.
 *   - The consult screen lists `line` under QUEUE and again under PRESCRIPTIONS. Same defect.
 *
 * First-match-wins cannot express "this word is weak evidence for two things". So the floor here
 * SCORES every intent and then requires the winner to beat the runner-up by a margin. A question
 * whose evidence is genuinely split does not guess — it misses, and a miss is routed to the model,
 * which is the cheap correct outcome rather than a wrong answer delivered confidently.
 */
describe("matchIntent — the owner's own examples", () => {
  it("answers the English form", () => {
    expect(matchIntent("has <<P1>> been seen by doctor?")?.intent).toBe("visit_status");
  });

  it("answers the Hinglish form", () => {
    expect(matchIntent("kya <<P1>> ko doctor ne dekh liya?")?.intent).toBe("visit_status");
  });

  it("answers the Devanagari form", () => {
    expect(matchIntent("क्या <<P1>> को डॉक्टर ने देख लिया")?.intent).toBe("visit_status");
  });

  it("generates the day report", () => {
    expect(matchIntent("generate the day report")?.intent).toBe("my_day_report");
  });

  it("generates the day report asked for in Hinglish", () => {
    expect(matchIntent("aaj ki meri report nikaal do")?.intent).toBe("my_day_report");
  });
});

describe("matchIntent — the rest of the counter's language", () => {
  it.each([
    ["<<P1>> doctor se mil gaya kya", "visit_status"],
    ["is <<P1>> still waiting", "visit_status"],
    ["<<P1>> ka number aaya kya", "visit_status"],
    ["kis line mein kam wait hai", "queue_depth"],
    ["kitna wait hai", "queue_depth"],
    ["how long is the queue", "queue_depth"],
    ["kaun si line chhoti hai", "queue_depth"],
    ["<<P1>> ka kitna paisa baaki hai", "patient_dues"],
    ["does <<P1>> owe anything", "patient_dues"],
    ["<<P1>> ka bakaya kitna hai", "patient_dues"],
    ["my day report", "my_day_report"],
    ["aaj maine kitne register kiye", "my_day_report"],
    ["today's figures", "my_day_report"],
  ])("routes %s", (question: string, intent: string) => {
    expect(matchIntent(question)?.intent).toBe(intent);
  });
});

/**
 * ═══ THE MARGIN RULE — THE PART THAT IS ACTUALLY NEW ═══
 *
 * These are the cases the ten shipped chains get wrong. Each one has evidence for more than one
 * intent, and the right behaviour is either to weigh it correctly or to admit the miss.
 */
describe("matchIntent — ambiguity is admitted, not guessed", () => {
  it("weighs the money question as money even though kitna also cues the queue", () => {
    // Desk One answers this one about the queue. It is a money question.
    expect(matchIntent("kitna paisa baaki hai")?.intent).toBe("patient_dues");
  });

  it("misses on a bare kitna rather than picking whichever branch is written first", () => {
    expect(matchIntent("kitna")).toBeNull();
  });

  it("misses on an empty question", () => {
    expect(matchIntent("")).toBeNull();
    expect(matchIntent("   ")).toBeNull();
  });

  it("misses on something the desk has no tool for", () => {
    expect(matchIntent("what is the weather in mumbai")).toBeNull();
  });

  it("misses on a question that is only a placeholder", () => {
    // "<<P1>>" alone says a patient and nothing about what is being asked.
    expect(matchIntent("<<P1>>")).toBeNull();
  });
});

describe("matchIntent — what it reports about itself", () => {
  it("names the cues it matched, so an answer can say why it said that", () => {
    const hit = matchIntent("kya <<P1>> ko doctor ne dekh liya?");
    expect(hit?.cues).toEqual(expect.arrayContaining(["dekh"]));
  });

  it("carries the placeholder the question was about", () => {
    expect(matchIntent("has <<P1>> been seen by doctor?")?.slot).toBe("<<P1>>");
  });

  it("carries no slot when the question names no patient", () => {
    expect(matchIntent("kitna wait hai")?.slot).toBeNull();
  });

  it("is case and punctuation insensitive", () => {
    expect(matchIntent("HAS <<P1>> BEEN SEEN BY DOCTOR???")?.intent).toBe("visit_status");
  });
});

/**
 * PD-7 C8 — THE PHARMACY'S QUESTIONS. Each phrasing below is one a pharmacist says at the counter;
 * the second block is the set of questions the new cues must NOT steal from the intents that had
 * them first — which is how each ambiguous word was kept out of the table.
 */
describe("matchIntent — the pharmacy counter", () => {
  it.each([
    ["kitni amoxicillin bachi hai", "stock_on_shelf"],
    ["Mox 500 ka stock kitna hai", "stock_on_shelf"],
    ["how much crocin is left", "stock_on_shelf"],
    ["is pan 40 in stock", "stock_on_shelf"],
    ["pan 40 kab expire hoga", "stock_on_shelf"],
    ["कितनी पैरासिटामोल बची है", "stock_on_shelf"],
    ["kiska paisa pending hai", "paid_not_collected"],
    ["who has paid but not collected", "paid_not_collected"],
    ["kaun dawai le nahi gaye", "paid_not_collected"],
    /* PARITY P1 — "out of X" drafts a short-book line; the pharmacist confirms it on the desk. */
    ["Pan 40 khatam", "draft_short_book_entry"],
    ["pan 40 khatam ho gaya", "draft_short_book_entry"],
    ["out of Pan 40", "draft_short_book_entry"],
    ["Dolo 650 out of stock hai", "draft_short_book_entry"],
    ["short book mein Montair LC likh do", "draft_short_book_entry"],
    ["पैन 40 खत्म", "draft_short_book_entry"],
    /* PARITY P2 — "order karo" drafts purchase orders; a person makes and sends them in the office. */
    ["order karo", "draft_purchase_orders"],
    ["make the orders", "draft_purchase_orders"],
    ["purchase order bana do", "draft_purchase_orders"],
    ["draft orders for the week", "draft_purchase_orders"],
    ["ऑर्डर कर दो", "draft_purchase_orders"],
    /* PARITY P3 — "payment run bana do" drafts a payment run; a person makes it, the owner authorises it. */
    ["payment run bana do", "draft_payment_run"],
    ["pay the suppliers", "draft_payment_run"],
    ["supplier payment karo", "draft_payment_run"],
    ["भुगतान की सूची बनाओ", "draft_payment_run"],
    /* PARITY P4 — "expiry return bana do" drafts the returns; a person makes them, the head approves each. */
    ["expiry return bana do", "draft_supplier_returns"],
    ["expired maal supplier ko wapas bhejo", "draft_supplier_returns"],
    ["make the supplier returns", "draft_supplier_returns"],
    ["एक्सपायर दवा वापस भेजो", "draft_supplier_returns"],
  ])("routes %s", (question: string, intent: string) => {
    expect(matchIntent(question)?.intent).toBe(intent);
  });

  it.each([
    ["<<P1>> ka paisa pending hai", "patient_dues"],
    ["how many are waiting", "queue_depth"],
    ["how much does <<P1>> owe", "patient_dues"],
  ])("leaves %s where it was", (question: string, intent: string) => {
    expect(matchIntent(question)?.intent).toBe(intent);
  });

  it("does not answer 'is the doctor available' with a shelf", () => {
    expect(matchIntent("is the doctor available")?.intent).not.toBe("stock_on_shelf");
  });
});

/**
 * ═══ 2026-09-19 — THE TWO WRONG ANSWERS IN 82, BOTH FROM THIS FLOOR ═══
 *
 * Measured end to end through the router with live models (PR #250): every question that reached a
 * model was answered right, and the only two wrong answers were confident floor matches — a strong
 * cue for one intent and nothing at all for the right one, so the margin rule had nothing to weigh.
 */
describe("matchIntent — the two collisions the 82-question run found", () => {
  it("'is this patient STILL waiting' in Devanagari is about the patient, not the queue", () => {
    // Was queue_depth: `इंतज़ार` (3) against the placeholder's lone +1.
    expect(matchIntent("मरीज <<P1>> अभी भी इंतज़ार में है क्या")?.intent).toBe("visit_status");
    expect(matchIntent("<<P1>> abhi bhi intezaar kar raha hai")?.intent).toBe("visit_status");
  });

  it("…while waiting with no patient named stays the queue", () => {
    expect(matchIntent("abhi kitna intezaar hai")?.intent).toBe("queue_depth");
    expect(matchIntent("कितना इंतज़ार है")?.intent).toBe("queue_depth");
  });

  it("'who paid and did not come for the medicine' is the pharmacy's uncollected list, not dues", () => {
    // Was patient_dues: `paisa` (3) against nothing — `lene nahi aaya` was not a cue anywhere.
    expect(matchIntent("kaun paisa dekar dawai lene nahi aaya")?.intent).toBe("paid_not_collected");
    expect(matchIntent("जिन्होंने पैसे दे दिए पर दवा नहीं ली")?.intent).toBe("paid_not_collected");
  });

  it("…while one named patient's money stays dues", () => {
    expect(matchIntent("<<P1>> ka kitna paisa baaki hai")?.intent).toBe("patient_dues");
    expect(matchIntent("<<P1>> ka paisa pending hai")?.intent).toBe("patient_dues");
  });
});

/*
  ═══ THE SAME LETTER, TWO WAYS OF TYPING IT ═══

  `ज़` is one code point on some keyboards (U+095B) and two on others (ज U+091C + nukta U+093C). The
  table's `इंतज़ार` is the two-point form; a clerk whose keyboard emits the one-point form matched
  nothing and never knew. Unicode's NFC maps both to the same sequence, so both sides are normalised
  through it.
*/
it("a nukta letter typed either way is the same letter", () => {
  const precomposed = "कितना इंतज़ार है";
  expect([...precomposed].map((c) => c.codePointAt(0))).toContain(0x095b);
  expect(matchIntent(precomposed)?.intent).toBe("queue_depth");
});
