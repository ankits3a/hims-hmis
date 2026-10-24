import { CONNECTIVES, applyRewordings, chooseLines, isAbnormal, quantitiesIn, renderLine, unverifiedWords, verifyFreeText, verifyReworded } from "../index";
import { mkFact } from "../copilot-lines";
import type { Fact, Line } from "../index";

/**
 * E5.3 (#740) — "DONE MEANS": EVERY LINE HAS A SOURCE, AND A NUMBER THAT DIFFERS FROM ITS RECORD FAILS CI
 * (spec SPEC-ipd-core §0A principle 6, §6 "an AI line whose number differs from its source fails the test suite").
 *
 * No database, no clock, no model: the fixtures are facts, exactly as `buildFacts` hands them over (their numbers are
 * the counts and values of their rows). A stub "model reply" is a string written here.
 *
 *   (i)   a template line prints only numbers and clock times its fact carries (property over 400 generated facts)
 *   (ii)  a model reply with a WRONG number is refused and the record's own line is used
 *   (iii) a model reply with an INVENTED number, a number word, or a borrowed number is refused
 *   (iv)  a reply that keeps the numbers and turns the meaning round, or moves a number to another label, is refused
 *   (v)   a faithful rewording is accepted; the abnormal line still comes first whatever order the model chose
 *   (vi)  free text may state only numbers that are in the notes it summarises; no proposal; no money; ASCII only; no
 *         negation, band or outcome word the notes do not carry; no name; an unknown word is "unverified"
 *   (vii) the reviewer's cases (band words, label binding, added medicine / advice / source, Devanagari numbers, NEWS2
 *         and SpO2): the allowlist — the line's own tokens in order plus a closed connective list — refuses each
 */

const rec = (id: string) => ({ id, at: new Date("2026-03-11T08:35:00Z"), label: `row ${id}` });

/** A small deterministic generator (no Math.random: the same 400 facts on every run). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

function generated(n: number): Fact[] {
  const r = lcg(20261014);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const one = (lo: number, hi: number): number => Math.round((lo + r() * (hi - lo)) * 10) / 10;
  const clock = (): string => `${String(int(0, 23)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}`;
  const drugs = ["Zemox 500 mg", "Paracip 650", "Insugen 30/70", "Cefta 1 g", "Pantocid 40"];
  const bands = ["low", "low_medium", "medium", "high"] as const;
  const out: Fact[] = [];
  for (let i = 0; i < n; i += 1) {
    const pick = int(0, 12);
    const records = [rec(`r${String(i)}`)];
    const names = [drugs[int(0, drugs.length - 1)]!, drugs[int(0, drugs.length - 1)]!];
    if (pick === 0) {
      const values = [one(35, 41), one(35, 41), one(35, 41)];
      const max = Math.max(...values); const min = Math.min(...values); const count = int(1, 24);
      out.push(mkFact({ kind: "vital", key: "vital:temperatureC", source: "vitals", param: "temperatureC", max, min, latest: values[2]!, count, abnormal: max > 38, numbers: [max, min, values[2]!, count], records }));
    } else if (pick === 1) {
      const vs = [int(40, 150), int(40, 150)]; const count = int(1, 12);
      out.push(mkFact({ kind: "vital", key: "vital:pulse", source: "vitals", param: "pulse", max: Math.max(...vs), min: Math.min(...vs), latest: vs[1]!, count, abnormal: r() > 0.5, numbers: [...vs, count], records }));
    } else if (pick === 2) {
      const at = clock(); const value = int(0, 14); const peakAt = clock(); const peakValue = int(value, 20); const to = int(0, 3);
      out.push(mkFact({
        kind: "ews", key: "ews", source: "ews", scoreKind: "news2", from: r() > 0.3 ? bands[int(0, 3)]! : null, to: bands[to]!, latestValue: value, latestAt: at,
        peak: bands[int(to, 3)]!, peakValue, peakAt, sets: int(1, 9), numbers: [value, peakValue], times: [at, peakAt], records,
      }));
    } else if (pick === 3) {
      const [missed, refused, held, given] = [int(0, 3), int(0, 2), int(0, 2), int(0, 12)];
      out.push(mkFact({ kind: "emar_exceptions", key: "emar:exceptions", source: "emar", missed, refused, held, given, numbers: [missed, refused, held, given], terms: missed + refused + held > 0 ? names : [], records }));
    } else if (pick === 4) {
      const count = int(1, 6);
      out.push(mkFact({ kind: "emar_prn", key: "emar:prn", source: "emar", count, numbers: [count], terms: names, records }));
    } else if (pick === 5) {
      const count = int(1, 5);
      out.push(mkFact({ kind: "orders_new", key: "orders:new", source: "order", count, numbers: [count], terms: names, records }));
    } else if (pick === 6) {
      const count = int(1, 4);
      out.push(mkFact({ kind: "orders_stopped", key: "orders:stopped", source: "order", count, numbers: [count], terms: names, records }));
    } else if (pick === 7) {
      const count = int(1, 9);
      out.push(mkFact({ kind: "results", key: "results:lab", source: "lab", department: "lab", count, numbers: [count], terms: ["CBC", "HbA1c", "Vitamin B12"], records }));
    } else if (pick === 8) {
      const count = int(1, 9); const flagged = int(0, count);
      out.push(mkFact({ kind: "notes", key: "notes", source: "note", count, flagged, numbers: [count, flagged], records }));
    } else if (pick === 9) {
      const inMl = int(0, 4000); const outMl = int(0, 4000);
      out.push(mkFact({ kind: "io", key: "io", source: "io", inMl, outMl, balanceMl: inMl - outMl, numbers: [inMl, outMl, inMl - outMl], records }));
    } else if (pick === 10) {
      const asked = int(0, 2); const answered = int(asked === 0 ? 1 : 0, 2);
      out.push(mkFact({ kind: "consults", key: "consults", source: "consult", asked, answered, numbers: [asked, answered], records }));
    } else if (pick === 11) {
      const at = clock();
      out.push(mkFact({ kind: "npo", key: "npo", source: "diet", since: at, numbers: [], times: [at], records }));
    } else {
      const count = int(1, 12);
      out.push(mkFact({ kind: "orders_active", key: "orders:active", source: "order", count, numbers: [count], records }));
    }
  }
  return out;
}

const lineOf = (f: Fact): Line => chooseLines([f])[0]!;
const has = (set: readonly number[], n: number): boolean => set.some((x) => Math.abs(x - n) < 1e-9);

describe("E5.3 the verifier — a number that differs from its record never reaches the screen", () => {
  const facts = generated(400);

  it("(i) every number and clock time a template line prints is one its fact carries, and every line names its records", () => {
    expect(new Set(facts.map((f) => f.kind)).size).toBeGreaterThanOrEqual(10);
    for (const f of facts) {
      const text = renderLine(f);
      const said = quantitiesIn(text);
      for (const n of said.numbers) expect({ text, n, ok: has(f.numbers, n) }).toEqual({ text, n, ok: true });
      for (const t of said.times) expect({ text, t, ok: f.times.includes(t) }).toEqual({ text, t, ok: true });
      // The template's own words are a rewording that passes: the verifier and the templates agree on what a line says.
      expect({ text, verdict: verifyReworded(text, lineOf(f)) }).toEqual({ text, verdict: { ok: true } });
      const line = lineOf(f);
      expect(line.source).toBe(f.source);
      expect(line.fact.records.length).toBeGreaterThan(0);
    }
  });

  it("(ii) a model reply whose number differs from the record is refused — for every digit run of every generated line, NEWS2 and SpO2 included", () => {
    let probes = 0;
    for (const f of facts) {
      const line = lineOf(f);
      for (const m of line.text.matchAll(/\d+(?:\.\d+)?/g)) {
        // The stub model's reply: the same line with ONE digit run changed (+1) — "NEWS2" → "NEWS3" is one of them.
        const wrong = `${line.text.slice(0, m.index)}${String(Math.round((Number(m[0]) + 1) * 10) / 10)}${line.text.slice(m.index + m[0].length)}`;
        probes += 1;
        const merged = applyRewordings([line], [{ key: line.key, text: wrong }]);
        expect({ wrong, by: merged.lines[0]!.by, text: merged.lines[0]!.text }).toEqual({ wrong, by: "template", text: line.text });
        expect(merged.accepted).toBe(0);
      }
    }
    expect(probes).toBeGreaterThan(600);
    expect(facts.some((f) => /NEWS2/.test(renderLine(f)))).toBe(true);
  });

  const fever = mkFact({
    kind: "vital", key: "vital:temperatureC", source: "vitals", param: "temperatureC", max: 38.9, min: 37.1, latest: 37.2, count: 6, abnormal: true,
    numbers: [38.9, 37.1, 37.2, 6], records: [rec("v1"), rec("v2")],
  });
  const quiet = mkFact({ kind: "emar_exceptions", key: "emar:exceptions", source: "emar", missed: 0, refused: 0, held: 0, given: 9, numbers: [0, 0, 0, 9], records: [rec("a1")] });

  const refusedBy = (text: string, line: Line): string => { const v = verifyReworded(text, line); return v.ok ? "accepted" : v.reason; };

  it("(iii) an invented number, a number word, a number in another script and a dropped number are refused", () => {
    const line = lineOf(fever);
    expect(line.text).toBe("Temperature max 38.9 °C, min 37.1 °C, latest 37.2 °C over 6 readings");
    expect(refusedBy("Temperature max 39.8 °C, min 37.1 °C, latest 37.2 °C over 6 readings", line)).toBe("number_not_in_record:39.8");
    expect(refusedBy("Temperature max 38.9 °C, min 37.1 °C, latest 37.2 °C over 6 readings, 3 days of fever", line)).toBe("number_not_in_record:3");
    expect(refusedBy("Temperature max 38.9 °C, min 37.1 °C, latest 37.2 °C over six readings in two days", line)).toBe("number_not_in_record:2");
    expect(refusedBy("Temperature max ३९.८ °C, min 37.1 °C, latest 37.2 °C over 6 readings", line)).toBe("number_not_in_record:39.8");
    // The record's own number in another script is still not the line's token; fullwidth digits are not even numbers.
    expect(refusedBy("Temperature max ३८.९ °C, min 37.1 °C, latest 37.2 °C over 6 readings", line)).toBe("character_not_allowed");
    expect(refusedBy("Temperature max ３８.９ °C, min 37.1 °C, latest 37.2 °C over 6 readings", line)).toBe("character_not_allowed");
    expect(refusedBy("Temperature max 38.9 °C over 6 readings", line)).toBe("token_not_allowed:over");
    expect(refusedBy("Temperature max 38.9 °C, min 37.1 °C, latest 37.2 °C", line)).toBe("content_dropped:over");
    expect(refusedBy("Fever, max 38.9 °C at 14:05, min 37.1 °C, latest 37.2 °C over 6 readings", line)).toBe("time_not_in_record:14:05");
    expect(refusedBy("Temperature max 38.9 °C, min 37.1 °C, latest 37.2 °C over 6 readings. Bill ₹500", line)).toBe("money");
  });

  it("(iv) the same numbers with the meaning turned round, or a number moved to another label, are refused", () => {
    const line = lineOf(quiet);
    expect(line.text).toBe("No change: no missed, refused or held doses — 9 given");
    expect(refusedBy("9 doses missed", line)).toBe("token_not_allowed:9");
    expect(refusedBy("Doses were missed; 9 given", line)).toBe("token_not_allowed:doses");
    expect(refusedBy("Change: missed, refused or held doses — 9 given", line)).toBe("token_not_allowed:change");
    expect(refusedBy("There is no change: no missed, refused or held doses, with 9 given", line)).toBe("accepted");
    const rising = lineOf(mkFact({ kind: "ews", key: "ews", source: "ews", scoreKind: "news2", from: "low", to: "medium", latestValue: 6, latestAt: "14:05", peak: "medium", peakValue: 6, peakAt: "14:05", sets: 3, numbers: [6], times: ["14:05"], records: [rec("v9")] }));
    expect(rising.text).toBe("NEWS2 rose from low to medium — latest 6 at 14:05");
    expect(refusedBy("NEWS2 fell from medium to low — latest 6 at 14:05", rising)).toBe("token_not_allowed:fell");
    expect(refusedBy("NEWS2 rose from low to medium, latest 6 at 14:05", rising)).toBe("accepted");
    const settled = lineOf(mkFact({ kind: "ews", key: "ews", source: "ews", scoreKind: "news2", from: "low", to: "low", latestValue: 2, latestAt: "16:05", peak: "medium", peakValue: 5, peakAt: "12:30", sets: 3, numbers: [2, 5], times: ["16:05", "12:30"], records: [rec("v9")] }));
    expect([settled.text, settled.abnormal]).toEqual(["NEWS2 reached medium (5 at 12:30), now low — latest 2 at 16:05", true]);
    // The record's own numbers, moved to each other's place: refused.
    expect(refusedBy("NEWS2 reached medium (2 at 12:30), now low — latest 5 at 16:05", settled)).toBe("token_not_allowed:2");
    const doses = lineOf(mkFact({ kind: "emar_exceptions", key: "emar:exceptions", source: "emar", missed: 2, refused: 0, held: 0, given: 9, numbers: [2, 0, 0, 9], records: [rec("a2")] }));
    expect(doses.text).toBe("Doses: 2 missed; 9 given");
    expect(refusedBy("Doses: 2 given; 9 missed", doses)).toBe("token_not_allowed:given");
    expect(refusedBy("9 given and 2 missed", doses)).toBe("token_not_allowed:9");
    expect(refusedBy("Doses: 2 missed and 9 given", doses)).toBe("accepted");
  });

  it("(v) a faithful rewording is accepted with its source kept; an abnormal line stays first whatever the model's order", () => {
    const lines = chooseLines([quiet, fever]);
    expect(lines.map((l) => [l.key, l.abnormal])).toEqual([["vital:temperatureC", true], ["emar:exceptions", false]]);
    expect(isAbnormal(fever)).toBe(true);
    const merged = applyRewordings(lines, [
      { key: "emar:exceptions", text: "There is no change: no missed, refused or held doses and 9 given" },
      { key: "vital:temperatureC", text: "Temperature max 38.9 °C, min 37.1 °C and latest 37.2 °C over 6 readings" },
      { key: "made:up", text: "Potassium 6.1" },
    ]);
    expect(merged.lines.map((l) => [l.key, l.by])).toEqual([["vital:temperatureC", "model"], ["emar:exceptions", "model"]]);
    expect(merged.lines[0]!.fact.records.map((r) => r.id)).toEqual(["v1", "v2"]);
    expect(merged.rejected).toEqual([{ key: "made:up", reason: "unknown_line" }]);
  });

  /**
   * THE REVIEW OF 1f7cc591 — the four ways a word-by-word check was beaten, each as the stub model's reply. The rule now
   * is an allowlist: the line's own tokens, all of them, in order, plus the closed connective list. Everything else falls
   * back to the record's line.
   */
  describe("(vii) the reviewer's cases: every token outside the line and the connective list refuses the line", () => {
    const rising = lineOf(mkFact({ kind: "ews", key: "ews", source: "ews", scoreKind: "news2", from: "low", to: "medium", latestValue: 6, latestAt: "14:05", peak: "medium", peakValue: 6, peakAt: "14:05", sets: 3, numbers: [6], times: ["14:05"], records: [rec("v9")] }));
    const doses = lineOf(mkFact({ kind: "emar_exceptions", key: "emar:exceptions", source: "emar", missed: 2, refused: 0, held: 0, given: 9, numbers: [2, 0, 0, 9], terms: ["Zemox 500 mg"], records: [rec("a2")] }));
    const spo2 = lineOf(mkFact({ kind: "vital", key: "vital:spo2", source: "vitals", param: "spo2", max: 96, min: 89, latest: 93, count: 4, abnormal: true, numbers: [96, 89, 93, 4], records: [rec("v3")] }));
    const fallsBack = (line: Line, text: string): void => {
      const merged = applyRewordings([line], [{ key: line.key, text }]);
      expect({ text, by: merged.lines[0]!.by, shown: merged.lines[0]!.text }).toEqual({ text, by: "template", shown: line.text });
    };

    it("1 · a band word changed, swapped or added", () => {
      expect(rising.text).toBe("NEWS2 rose from low to medium — latest 6 at 14:05");
      for (const text of [
        "NEWS2 rose from low to high — latest 6 at 14:05",
        "NEWS2 rose from medium to low — latest 6 at 14:05",
        "NEWS2 rose from low to medium, now high — latest 6 at 14:05",
        "NEWS2 rose to medium — latest 6 at 14:05",
        "NEWS2 rose from low–medium to medium — latest 6 at 14:05",
        "NEWS2 critical: rose from low to medium — latest 6 at 14:05",
      ]) fallsBack(rising, text);
    });

    it("2 · a number bound to another label", () => {
      expect(doses.text).toBe("Doses: 2 missed; 9 given: Zemox 500 mg");
      for (const text of [
        "Doses: 2 given; 9 missed: Zemox 500 mg",
        "Doses: 9 missed; 2 given: Zemox 500 mg",
        "Doses: 2 missed; 9 given: Zemox 9 mg",
        "Doses: 500 missed; 9 given: Zemox 2 mg",
        "Doses: 2 refused; 9 given: Zemox 500 mg",
        "Doses: 2 missed; 9 held: Zemox 500 mg",
      ]) fallsBack(doses, text);
      expect(spo2.text).toBe("SpO2 max 96%, min 89%, latest 93% over 4 readings");
      for (const text of ["SpO2 max 89%, min 96%, latest 93% over 4 readings", "SpO2 max 96%, min 93%, latest 89% over 4 readings", "Pulse max 96%, min 89%, latest 93% over 4 readings"]) fallsBack(spo2, text);
    });

    it("3 · an added medicine, advice, cause or source", () => {
      for (const text of [
        "Doses: 2 missed; 9 given: Zemox 500 mg and Paracetamol",
        "Doses: 2 missed; 9 given: Zemox 500 mg, started warfarin",
        "Doses: 2 missed; 9 given: Zemox 500 mg — consider review",
        "Doses: 2 missed; 9 given: Zemox 500 mg, patient asleep",
        "Doses: 2 missed; 9 given: Zemox 500 mg per pharmacy",
        "Doses: 2 missed; 9 given: Zemox 500 mg (lab)",
        "Dr Rao: Doses: 2 missed; 9 given: Zemox 500 mg",
      ]) fallsBack(doses, text);
      fallsBack(rising, "NEWS2 rose from low to medium — latest 6 at 14:05, sepsis likely");
    });

    it("4 · a number word or a digit in Devanagari or any other script", () => {
      for (const text of [
        "Doses: दो missed; 9 given: Zemox 500 mg",
        "Doses: 2 missed; नौ given: Zemox 500 mg",
        "Doses: २ missed; 9 given: Zemox 500 mg",
        "Doses: 2 missed; 9 given: Zemox 500 mg, तीन और छूटीं",
        "Doses: 2 missed; 9 given: Zemox ৫০০ mg",
        "Doses: 2 missed; ９ given: Zemox 500 mg",
        "खुराक: 2 missed; 9 given: Zemox 500 mg",
      ]) fallsBack(doses, text);
    });

    it("5 · the names that hold a digit are not numbers to change: NEWS2 and SpO2", () => {
      for (const text of ["NEWS3 rose from low to medium — latest 6 at 14:05", "NEWS rose from low to medium — latest 6 at 14:05", "MEOWS rose from low to medium — latest 6 at 14:05"]) fallsBack(rising, text);
      for (const text of ["SpO3 max 96%, min 89%, latest 93% over 4 readings", "SpO max 96%, min 89%, latest 93% over 4 readings", "O2 max 96%, min 89%, latest 93% over 4 readings"]) fallsBack(spo2, text);
      // And what a model MAY do: join the line's own words with the closed list.
      expect(refusedBy("The SpO2 max was 96%, min 89% and latest 93% over 4 readings", spo2)).toBe("accepted");
      expect(refusedBy("Doses: there were 2 missed and 9 given: Zemox 500 mg", doses)).toBe("accepted");
      expect([...CONNECTIVES.en].sort()).toEqual(["a", "also", "an", "and", "are", "at", "been", "had", "has", "is", "since", "the", "then", "there", "was", "were", "with"]);
    });
  });

  it("(vi) free text states only numbers that are in its notes; it proposes nothing and names no money", () => {
    const notes = ["08:30 general: Slept well. Temperature 37.4 at 06:00, ate half the breakfast.", "10:15 pain: Pain 4 on movement, eased with rest."];
    const verdict = (t: string): string => { const v = verifyFreeText(t, notes); return v.ok ? "ok" : v.reason; };
    expect(verdict("Slept well; temperature 37.4 at 06:00. Pain 4 on movement, eased with rest.")).toBe("ok");
    expect(verdict("Temperature 38.4 overnight, pain 4 on movement.")).toBe("number_not_in_record:38.4");
    expect(verdict("Pain 4 on movement at 11:00.")).toBe("time_not_in_record:11:00");
    expect(verdict("Pain 4 on movement; consider tramadol.")).toBe("proposal");
    expect(verdict("Pain 4 on movement. Deposit pending.")).toBe("money");
    expect(verdict("<<P1>> slept well.")).toBe("placeholder");
    // Review of 1f7cc591: free text fails closed on what it cannot check.
    expect(verdict("दो बार दर्द, pain 4 on movement.")).toBe("non_ascii");
    expect(verdict("No pain on movement; slept well.")).toBe("meaning_not_in_notes:neg");
    expect(verdict("Pain 4 on movement, severe at night.")).toBe("meaning_not_in_notes:band_high");
    expect(verdict("Pain 4 on movement; refused breakfast.")).toBe("meaning_not_in_notes:refused");
    const named = verifyFreeText("Sunita slept well; pain 4 on movement.", notes, undefined, undefined, ["Sunita Devi"]);
    expect(named).toEqual({ ok: false, reason: "name" });
    expect(unverifiedWords("Slept well; started amoxyclav for pain on movement.", notes)).toEqual(["started", "amoxyclav"]);
    expect(unverifiedWords("Slept well. Pain on movement eased with rest.", notes)).toEqual([]);
  });
});
