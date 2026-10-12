import { readReminder } from "./copilot-words";

/**
 * E2.3 — the words a reminder is read from. Every "now" is a fixed instant passed in: the function
 * reads no clock, so these dates are the test's own and cannot go stale.
 */
const IST = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00+05:30`);
const MON_10 = IST("2026-10-12", "10:00"); // a Monday
const MON_17 = IST("2026-10-12", "17:00");
const ok = (typed: string, now: Date) => {
  const r = readReminder(typed, now);
  if (!r.ok) throw new Error(`${typed}: ${r.why}`);
  return { text: r.text, at: r.at.toISOString(), repeat: r.repeat };
};

describe("readReminder (E2.3)", () => {
  it("the owner's sentence: a bare 4 is this afternoon, and bed 12 stays words", () => {
    expect(ok("remind me at 4 to see bed 12", MON_10)).toEqual({ text: "see bed 12", at: IST("2026-10-12", "16:00").toISOString(), repeat: "none" });
  });

  it("a bare hour already gone today is tomorrow's", () => {
    expect(ok("remind me at 4 to see bed 12", MON_17).at).toBe(IST("2026-10-13", "16:00").toISOString());
  });

  it("Hindi: kal subah 9 baje", () => {
    expect(ok("kal subah 9 baje yaad dilana BP check", MON_10)).toEqual({ text: "BP check", at: IST("2026-10-13", "09:00").toISOString(), repeat: "none" });
  });

  it("daily: roz 8 baje is 8 in the morning; the asking words are not the text", () => {
    expect(ok("roz 8 baje medicine round yaad karana", MON_10)).toEqual({ text: "medicine round", at: IST("2026-10-13", "08:00").toISOString(), repeat: "daily" });
  });

  it("weekly and Monday-to-Saturday", () => {
    expect(ok("every friday 11 am remind me to send the roster", MON_10)).toEqual({ text: "send the roster", at: IST("2026-10-16", "11:00").toISOString(), repeat: "weekly" });
    expect(ok("mon to sat 9:30 yaad dilana ward round", MON_10)).toMatchObject({ text: "ward round", repeat: "mon_sat", at: IST("2026-10-13", "09:30").toISOString() });
  });

  it("the half of the day overrides the bare-hour rule", () => {
    expect(ok("shaam 7 baje yaad dilana call wife", MON_10).at).toBe(IST("2026-10-12", "19:00").toISOString());
    expect(ok("remind me at 4 am to check drip", MON_10).at).toBe(IST("2026-10-13", "04:00").toISOString());
    expect(ok("raat 10 baje yaad dilana insulin", MON_10).at).toBe(IST("2026-10-12", "22:00").toISOString());
    expect(ok("remind me at 16:30 to sign the bills", MON_10).at).toBe(IST("2026-10-12", "16:30").toISOString());
  });

  it("from now: minutes and hours", () => {
    expect(ok("30 min baad yaad dilana call back", MON_10)).toMatchObject({ text: "call back", at: IST("2026-10-12", "10:30").toISOString() });
    expect(ok("remind me in 2 hours to check bed 4 report", MON_10)).toMatchObject({ text: "check bed 4 report", at: IST("2026-10-12", "12:00").toISOString() });
  });

  it("a day and a date", () => {
    expect(ok("friday 3 baje yaad dilana meeting", MON_10).at).toBe(IST("2026-10-16", "15:00").toISOString());
    expect(ok("remind me on 20 oct at 10 to renew licence", MON_10)).toMatchObject({ text: "renew licence", at: IST("2026-10-20", "10:00").toISOString() });
  });

  it("refuses in one word what cannot be set", () => {
    expect(readReminder("remind me to see bed 12", MON_10)).toEqual({ ok: false, why: "noTime" });
    expect(readReminder("aaj 9 baje yaad dilana BP", MON_10)).toEqual({ ok: false, why: "past" });
    expect(readReminder("ek ghante baad yaad dilana", MON_10)).toEqual({ ok: false, why: "noText" });
    expect(readReminder(`remind me at 4 to ${"x".repeat(81)}`, MON_10)).toEqual({ ok: false, why: "tooLong" });
  });
});
