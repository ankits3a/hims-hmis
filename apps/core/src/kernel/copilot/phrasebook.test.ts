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
