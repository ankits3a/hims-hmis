/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LINE ON THE SIGN-IN SCREEN — AND WHY THE CITATION LIVES HERE AND NOT IN THE LOCALE FILES
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner's ruling replaced the capability pitch on the pine panel with a rotating line from the
 * Gita and its meaning, in Hinglish. The risk in that ruling is not layout, it is ACCURACY: a
 * hospital that prints scripture on the screen every member of its staff sees each morning cannot
 * print a verse that does not exist, a chapter:verse that belongs to a different verse, or a
 * proverb dressed up as scripture.
 *
 * So the Sanskrit and the citation are HERE, in one frozen table, and NOT in `en.json` / `hi.json`.
 * A citation copied into two locale files is a citation that can be corrected in one of them and
 * left wrong in the other, and nothing would catch it: `i18n.test.ts` pins that the two files have
 * the same KEYS, never that they carry the same verse number. One table cannot drift from itself.
 * Only the MEANING is translated, because only the meaning is language.
 *
 * ═══ EVERY LINE WAS CHECKED AGAINST SOURCE, AND ONE OF THEM IS NOT SCRIPTURE ═══
 *
 * Each `shloka` below is a complete pāda (half-line) transcribed from holy-bhagavad-gita.org's text
 * for that chapter and verse — not recalled, and not truncated mid-phrase, so nothing here is a
 * fragment that changes meaning when the rest of the line is missing.
 *
 * `सेवा ही परम धर्म है` is the line the owner asked for by name, and it is a PROVERB. It is not in
 * the Gita and it is not in any scripture; the saying it is usually confused with is
 * `अहिंसा परमो धर्मः`, which is Mahābhārata, not Gita. It ships because the owner asked for it, and
 * it ships with `source: "proverb"` and `cite: null` so the screen labels it a saying rather than
 * quoting a chapter and verse it does not have. 18.46 is the verse that carries its meaning
 * honestly — your own work IS the worship — and it is first in the table for that reason.
 */
export interface DeskLine {
  readonly id: string;
  /** `gita` prints `गीता <cite>`. `proverb` prints the saying label — it never claims a verse. */
  readonly source: "gita" | "proverb";
  /** `chapter.verse`, and `null` for anything that is not scripture. Never invent one. */
  readonly cite: string | null;
  /** Devanagari, exactly as the source prints it. Always Devanagari, in every UI language. */
  readonly shloka: string;
}

/** Typed as a non-empty tuple so `pickLine` can be total without a non-null assertion. */
export const DESK_LINES: readonly [DeskLine, ...DeskLine[]] = [
  { id: "g1846", source: "gita", cite: "18.46", shloka: "स्वकर्मणा तमभ्यर्च्य सिद्धिं विन्दति मानवः" },
  { id: "g0525", source: "gita", cite: "5.25", shloka: "छिन्नद्वैधा यतात्मानः सर्वभूतहिते रताः" },
  { id: "g0632", source: "gita", cite: "6.32", shloka: "आत्मौपम्येन सर्वत्र समं पश्यति योऽर्जुन" },
  { id: "g1213", source: "gita", cite: "12.13", shloka: "अद्वेष्टा सर्वभूतानां मैत्रः करुण एव च" },
  { id: "g0247", source: "gita", cite: "2.47", shloka: "कर्मण्येवाधिकारस्ते मा फलेषु कदाचन" },
  { id: "g0250", source: "gita", cite: "2.50", shloka: "तस्माद्योगाय युज्यस्व योगः कर्मसु कौशलम्" },
  { id: "g0319", source: "gita", cite: "3.19", shloka: "तस्मादसक्तः सततं कार्यं कर्म समाचर" },
  { id: "g1720", source: "gita", cite: "17.20", shloka: "दातव्यमिति यद्दानं दीयतेऽनुपकारिणे" },
  { id: "seva", source: "proverb", cite: null, shloka: "सेवा ही परम धर्म है" },
];

/**
 * ═══ ROTATION: ONE PICK PER PAGE LOAD, AND THE PICK IS HELD ═══
 *
 * The owner's ruling is that the line changes every time somebody opens the sign-in page. The trap
 * is that "per page load" and "per render" are not the same thing on this screen and the difference
 * is invisible until you sit in front of it: the clock re-renders `LoginScreen` every 20 SECONDS,
 * and so does every keystroke, the Caps Lock warning, the reveal button and the language toggle. A
 * `pick()` in the render body would therefore reroll the verse under a clerk who is halfway through
 * reading it, roughly three times a minute. `LoginScreen` holds the result in `useState`'s lazy
 * initialiser, which runs exactly once per mount — a page load — and never again.
 *
 * `index` exists so a test can pin the line. Production passes nothing.
 */
export function pickLine(index?: number): DeskLine {
  const n = DESK_LINES.length;
  const i = index ?? Math.floor(Math.random() * n);
  // The double modulo keeps any index — negative or past the end — inside the table. The `??` is
  // there for `noUncheckedIndexedAccess` and is unreachable, not a fallback anybody should rely on.
  return DESK_LINES[((i % n) + n) % n] ?? DESK_LINES[0];
}
