import { chipToken, parseSearchQuery } from "./search";

const NOW = new Date("2026-08-25T04:00:00Z"); // 09:30 IST — a working morning

describe("parseSearchQuery", () => {
  it("plain text is plain text", () => {
    expect(parseSearchQuery("asha devi", 20)).toMatchObject({ raw: "asha devi", text: "asha devi", chips: [] });
  });

  it("a RESOLVED chip is part of the string, and leaves the rest as text", () => {
    const q = parseSearchQuery("@doctor:01ABC pending bills", 20);
    expect(q.chips).toEqual([{ entity: "doctor", id: "01ABC", label: "01ABC" }]);
    expect(q.text).toBe("pending bills");
  });

  it("aliases a desk actually types resolve to the same entity", () => {
    expect(parseSearchQuery("@dr:X", 20).chips[0]?.entity).toBe("doctor");
    expect(parseSearchQuery("@p:X", 20).chips[0]?.entity).toBe("patient");
    expect(parseSearchQuery("@bill:X", 20).chips[0]?.entity).toBe("invoice");
    expect(parseSearchQuery("@dept:X", 20).chips[0]?.entity).toBe("department");
  });

  it("several chips AND together", () => {
    const q = parseSearchQuery("@doctor:D1 @dept:P2 unpaid", 20);
    expect(q.chips.map((c) => c.entity)).toEqual(["doctor", "department"]);
    expect(q.text).toBe("unpaid");
  });

  it("a BARE @entity narrows rather than filters by id", () => {
    const q = parseSearchQuery("@invoice sharma", 20);
    expect(q.entities).toEqual(["invoice"]);
    expect(q.chips).toEqual([]);
    expect(q.text).toBe("sharma");
  });

  it("AN UNKNOWN @word IS TEXT, NEVER AN ERROR — a desk types an email address", () => {
    const q = parseSearchQuery("asha@example.com", 20);
    expect(q.chips).toEqual([]);
    expect(q.entities).toBeUndefined();
    expect(q.text).toBe("asha@example.com");
  });

  describe("date words", () => {
    it("today and yesterday resolve on the IST calendar, not UTC's", () => {
      expect(parseSearchQuery("today", 20, { now: NOW }).range).toEqual({ from: "2026-08-25", to: "2026-08-25" });
      expect(parseSearchQuery("yesterday", 20, { now: NOW }).range).toEqual({ from: "2026-08-24", to: "2026-08-24" });
    });

    it("an IST day is the hospital's day — 23:00 UTC is already tomorrow here", () => {
      const lateUtc = new Date("2026-08-25T22:00:00Z"); // 03:30 IST on the 26th
      expect(parseSearchQuery("today", 20, { now: lateUtc }).range).toEqual({ from: "2026-08-26", to: "2026-08-26" });
    });

    it("week ranges span the expected windows", () => {
      expect(parseSearchQuery("this week", 20, { now: NOW }).range).toEqual({ from: "2026-08-19", to: "2026-08-25" });
      expect(parseSearchQuery("last week", 20, { now: NOW }).range).toEqual({ from: "2026-08-12", to: "2026-08-18" });
    });

    it("Hindi date words work — the desk is bilingual", () => {
      expect(parseSearchQuery("आज", 20, { now: NOW }).range).toEqual({ from: "2026-08-25", to: "2026-08-25" });
    });

    it("the date word is REMOVED from the text it was found in", () => {
      const q = parseSearchQuery("@doctor:D1 today", 20, { now: NOW });
      expect(q.text).toBe("");
      expect(q.range).toEqual({ from: "2026-08-25", to: "2026-08-25" });
    });
  });

  it("chipToken round-trips through the parser", () => {
    const token = chipToken("patient", "01XYZ");
    expect(parseSearchQuery(`${token} bills`, 20).chips).toEqual([{ entity: "patient", id: "01XYZ", label: "01XYZ" }]);
  });

  it("labels decorate a chip without changing what the server parses", () => {
    const q = parseSearchQuery("@doctor:D1", 20, { labels: { D1: "Dr Mehra" } });
    expect(q.chips[0]).toEqual({ entity: "doctor", id: "D1", label: "Dr Mehra" });
    // The server parses the same string with no labels and gets the same ID — the label is chrome.
    expect(parseSearchQuery("@doctor:D1", 20).chips[0]?.id).toBe("D1");
  });
});
