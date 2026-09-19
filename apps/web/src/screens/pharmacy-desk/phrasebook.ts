import type { WireRxLine } from "../../lib/pharmacy-api";

/**
 * ═══ PD-7 C10 — THE HAND-OVER SENTENCE, IN DEVANAGARI, FROM A PHRASEBOOK ═══
 *
 * What the pharmacist says aloud at the window, built from the doctor's sig by table lookup and
 * NOTHING else (PD-D15: deterministic where it matters; no model writes a dose). It is the agent's
 * suggestion, so it is drawn on pine (PD-D16), and the pharmacist says it — the screen never does.
 *
 * WHAT IT REFUSES TO SAY. A sig it cannot say exactly gets no sentence at all, never part of one:
 * a sentence that drops "with warm water" or reads "15 mg/kg" as a tablet count is worse than
 * silence, because it sounds finished (E19). So: a dose that is not a count of tablets or capsules
 * or a single measured volume, a frequency that is not a morning-noon-night triplet or one of the
 * standard abbreviations, and an instruction not in `WHEN` all answer `null`, and the screen hands
 * that line back to the pharmacist in the doctor's own words.
 */

/** Indian convention: the triplet is morning – afternoon – night. */
const SLOT = ["सुबह", "दोपहर", "रात"] as const;

const COUNT: Record<string, string> = { "1": "एक", "2": "दो", "3": "तीन", "4": "चार" };

const UNIT: Record<string, string> = {
  tab: "गोली", tabs: "गोली", tablet: "गोली", tablets: "गोली",
  cap: "कैप्सूल", caps: "कैप्सूल", capsule: "कैप्सूल", capsules: "कैप्सूल",
};

const TIMES: Record<string, string> = {
  od: "दिन में एक बार", bd: "दिन में दो बार", bid: "दिन में दो बार", tds: "दिन में तीन बार", tid: "दिन में तीन बार",
  qid: "दिन में चार बार", hs: "रात को सोते समय", sos: "ज़रूरत पड़ने पर",
};

/** Instructions the book can say. Matched whole, after trimming and case-folding — never in part. */
const WHEN: Record<string, string> = {
  "after food": "खाने के बाद",
  "after meals": "खाने के बाद",
  "before food": "खाने से पहले",
  "before meals": "खाने से पहले",
  "before breakfast": "नाश्ते से पहले",
  "empty stomach": "खाली पेट",
  "on an empty stomach": "खाली पेट",
  "at bedtime": "रात को सोते समय",
  "one hour before food": "खाने से एक घंटा पहले",
};

type Dose = { kind: "count"; n: string; unit: string } | { kind: "measure"; text: string };

function doseOf(dose: string): Dose | null {
  const d = dose.trim().toLowerCase();
  const counted = /^(\d+)\s*([a-z]+)$/.exec(d);
  if (counted !== null && UNIT[counted[2]!] !== undefined && COUNT[counted[1]!] !== undefined) {
    return { kind: "count", n: counted[1]!, unit: UNIT[counted[2]!]! };
  }
  const measured = /^(\d+(?:\.\d+)?)\s*ml$/.exec(d);
  if (measured !== null) return { kind: "measure", text: `${measured[1]!} ml` };
  return null;
}

/** One taking: "एक गोली", "दो गोली", "10 ml". A measured dose is said once per taking, never multiplied. */
function taking(dose: Dose, per: string): string | null {
  if (dose.kind === "measure") return per === "1" ? dose.text : null;
  const n = Number(dose.n) * Number(per);
  const word = COUNT[String(n)];
  return word === undefined ? null : `${word} ${dose.unit}`;
}

export function hindiSig(rx: Pick<WireRxLine, "dose" | "frequency" | "durationDays" | "instructions">): string | null {
  const dose = doseOf(rx.dose);
  if (dose === null) return null;
  const freq = rx.frequency.trim();

  let body: string;
  const triplet = /^(\d)\s*-\s*(\d)\s*-\s*(\d)$/.exec(freq);
  if (triplet !== null) {
    if (dose.kind === "count" && dose.n !== "1") return null; // "2 tab 1-0-1" is ambiguous: say nothing
    const parts: string[] = [];
    for (const [i, per] of [triplet[1]!, triplet[2]!, triplet[3]!].entries()) {
      if (per === "0") continue;
      const said = taking(dose, per);
      if (said === null) return null;
      parts.push(`${SLOT[i]!} ${said}`);
    }
    if (parts.length === 0) return null;
    body = parts.join(", ");
  } else {
    const times = TIMES[freq.toLowerCase()];
    const said = taking(dose, "1");
    if (times === undefined || said === null) return null;
    body = `${said}, ${times}`;
  }

  const days = rx.durationDays === null ? "" : ` — ${String(rx.durationDays)} दिन`;
  const text = (rx.instructions ?? "").trim().toLowerCase();
  if (text === "") return `${body}${days}`;
  const when = WHEN[text];
  if (when === undefined) return null;
  return `${body}${days}, ${when}`;
}

/**
 * PD-7 C4 — WHAT WAS NOT GIVEN, SAID IN HINDI. A decline's reason is the pharmacist's free text, so
 * only a reason the book knows WHOLE is translated; anything else is handed back to the pharmacist
 * to say in their own words. Half a translation of "out of stock, try the shop on the corner" would
 * drop the half the patient needed.
 */
const REFUSED: Record<string, string> = {
  "out of stock": "यह दवा अभी स्टॉक में नहीं है",
  "not in stock": "यह दवा अभी स्टॉक में नहीं है",
  "not stocked here": "यह दवा हमारे यहाँ नहीं रखी जाती",
  "patient has it at home": "आपने बताया यह दवा घर पर है, इसलिए नहीं दी",
};

export function hindiRefusal(reason: string): string | null {
  return REFUSED[reason.trim().toLowerCase()] ?? null;
}
