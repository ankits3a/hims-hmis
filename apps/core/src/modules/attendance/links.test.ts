import { matchOf, mobileSuggestions } from "./links";

/**
 * #634 — the pure halves of linking by hand: which key a pair matches by, and the exact-mobile
 * suggestion list. The database halves are in `test/attendance-links.e2e.test.ts`.
 */
describe("matchOf — the owner's two keys, nothing else", () => {
  it("Aadhaar first, then the same normalised mobile; a name or nothing is no match", () => {
    expect(matchOf({ mobile: "9811100001", aadhaarHash: "h1" }, { phone: null, aadhaarHash: "h1" })).toBe("aadhaar");
    expect(matchOf({ mobile: "+91 98111-00001", aadhaarHash: "h1" }, { phone: "9811100001", aadhaarHash: "h2" })).toBe("mobile");
    expect(matchOf({ mobile: "09811100001", aadhaarHash: null }, { phone: "9811100001", aadhaarHash: null })).toBe("mobile");
    expect(matchOf({ mobile: "9811100001", aadhaarHash: null }, { phone: "9811100002", aadhaarHash: null })).toBeNull();
    expect(matchOf({ mobile: null, aadhaarHash: null }, { phone: null, aadhaarHash: null })).toBeNull();
    expect(matchOf({ mobile: "12345", aadhaarHash: null }, { phone: "12345", aadhaarHash: null })).toBeNull(); // not a mobile
  });
});

describe("mobileSuggestions — exact mobile matches only, each one waiting for a click", () => {
  const staff = [
    { pin: "1", mobile: "9811100001", status: "active", userId: null },
    { pin: "2", mobile: "9811100002", status: "active", userId: null },
    { pin: "3", mobile: "9811100002", status: "active", userId: null }, // shares with pin 2
    { pin: "4", mobile: "9811100004", status: "left", userId: null }, // left: never suggested
    { pin: "5", mobile: "9811100005", status: "active", userId: "u-taken" }, // already linked
    { pin: "6", mobile: null, status: "active", userId: null },
    { pin: "7", mobile: "9811100007", status: "active", userId: null },
  ];
  const logins = [
    { id: "u-a", phone: "9811100001" },
    { id: "u-b", phone: "9811100002" },
    { id: "u-c", phone: "9811100004" },
    { id: "u-d", phone: "9811100005" },
    { id: "u-taken", phone: "9811100007" }, // this login is somebody's record already
    { id: "u-e", phone: null },
  ];

  it("pairs unlinked active people with unlinked logins by the same ten digits, and says when a number is shared", () => {
    expect(mobileSuggestions(staff, logins)).toEqual([
      { pin: "1", userId: "u-a", last4: "0001", shared: false },
      { pin: "2", userId: "u-b", last4: "0002", shared: true },
      { pin: "3", userId: "u-b", last4: "0002", shared: true },
    ]);
  });

  it("two logins holding one person's number are both offered, both marked shared", () => {
    expect(mobileSuggestions([staff[0]!], [...logins, { id: "u-a2", phone: "+91 98111 00001" }])).toEqual([
      { pin: "1", userId: "u-a", last4: "0001", shared: true },
      { pin: "1", userId: "u-a2", last4: "0001", shared: true },
    ]);
  });

  it("a linked active person still makes their number shared — the automatic rule's own count", () => {
    const s = [{ pin: "8", mobile: "9811100009", status: "active", userId: "u-x" }, { pin: "9", mobile: "9811100009", status: "active", userId: null }];
    expect(mobileSuggestions(s, [{ id: "u-y", phone: "9811100009" }])).toEqual([{ pin: "9", userId: "u-y", last4: "0009", shared: true }]);
  });
});
