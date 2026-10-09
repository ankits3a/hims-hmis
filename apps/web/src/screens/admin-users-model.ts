import type { WireAdminUser, WireRole, WireUserIdentity } from "../lib/admin-api";

/**
 * THE USERS SCREEN'S ARITHMETIC — pure, so 300 rows filter in memory without a request and every
 * rule here is testable without a screen. NOTHING here is a policy: who may do what, the password
 * floor and the username rule all stay the server's. A suggestion made here (a username, a first
 * password) is sent as typed and judged there.
 */

export const CHIPS = ["all", "active", "deactivated", "noRole", "passwordDue", "notLinked"] as const;
export type Chip = (typeof CHIPS)[number];

/** Lower-case, accents and punctuation kept out of the way; digits kept for staff codes and mobiles. */
const fold = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/**
 * Does this person match what was typed? Name, username and staff code by substring; the mobile by
 * its digits (so "98765" and "98 765" both find 9876501234). An empty query matches everyone.
 */
export function matchesQuery(u: WireAdminUser, query: string, mobile: string | null): boolean {
  const q = fold(query.trim());
  if (q === "") return true;
  // `staffCode` is typed as always there; an older server sent none, and a search must not throw on it.
  const code = typeof u.staffCode === "string" ? u.staffCode.toLowerCase() : "";
  if (fold(u.fullName).includes(q) || u.username.toLowerCase().includes(q) || code.includes(q)) return true;
  const digits = q.replace(/\D/g, "");
  return mobile !== null && digits.length >= 3 && digits === q.replace(/[\s-]/g, "") && mobile.includes(digits);
}

/** Which chip a person falls under. `notLinked` needs the identity list; without it nobody is counted. */
export function inChip(chip: Chip, u: WireAdminUser, identity: WireUserIdentity | null | undefined): boolean {
  switch (chip) {
    case "all": return true;
    case "active": return u.active;
    case "deactivated": return !u.active;
    case "noRole": return u.roles.length === 0;
    case "passwordDue": return u.mustChangePassword;
    case "notLinked": return identity !== undefined && (identity === null || identity.attendance !== "linked");
  }
}

/** "Dr. Neha Sharma" → "NS"; one word → its first two letters. */
export function initials(name: string): string {
  const words = name.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, "").trim().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/** A calm avatar colour per person, stable across renders (the board's palette). */
const AVATARS = ["#0e6b4e", "#3b7a8a", "#4a6b8a", "#6b4a8a", "#8a4a5e", "#7a5a3b", "#8a6d3b", "#132420"];
export function avatarColour(id: string, active: boolean): string {
  if (!active) return "#9aa8a1";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATARS[h % AVATARS.length]!;
}

/** "Doctor (OPD consultant)" → "Doctor". The catalogue's titles carry a note in brackets; a row has room for the name. */
export function shortTitle(title: string): string {
  const s = title.replace(/\s*\(.*\)\s*$/, "").trim();
  return s === "" ? title : s;
}

/** The area a role belongs to: the module most of its permissions are in ("opd", "pharmacy"…). */
export function areaOf(role: Pick<WireRole, "permissions">): string {
  const n = new Map<string, number>();
  for (const p of role.permissions) {
    const m = p.split(".")[0] ?? "";
    if (m !== "") n.set(m, (n.get(m) ?? 0) + 1);
  }
  let best = "";
  let most = 0;
  for (const [m, c] of n) if (c > most || (c === most && m < best)) { best = m; most = c; }
  return best === "" ? "other" : best;
}

/** A role's display title: the catalogue's, shortened; the key when the catalogue is not readable. */
export function roleTitle(roleKey: string, catalogue: readonly WireRole[] | undefined): string {
  const r = catalogue?.find((x) => x.key === roleKey);
  return r === undefined ? roleKey : shortTitle(r.title);
}

/**
 * A username made from a name: "Dr. Rekha Gupta" → "rekha.gupta". Only a SUGGESTION — the server
 * decides whether it is taken (`username_taken`) and whether its shape is allowed.
 */
export function suggestUsername(fullName: string): string {
  const words = fold(fullName).replace(/^(dr|mr|mrs|ms|prof)\.?\s+/, "").replace(/[^a-z\s]/g, " ").trim().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!;
  return `${words[0]!}.${words[words.length - 1]!}`;
}

/**
 * A first password, word-word-four digits ("Teal-Mango-4821"), from `crypto.getRandomValues` —
 * never `Math.random`. Two words from 64 and four digits is ~25 bits; it is a FIRST password the
 * person must change at sign-in, and its length (≥ 14) clears the server's floor.
 */
const WORDS = [
  "Amber", "Basil", "Cedar", "Coral", "Delta", "Ember", "Fable", "Garnet", "Hazel", "Indigo", "Jasper", "Kestrel", "Lotus", "Mango",
  "Maple", "Neem", "Olive", "Pearl", "Quartz", "Raven", "Saffron", "Teal", "Umber", "Violet", "Willow", "Zinnia", "Banyan", "Cobalt",
  "Dahlia", "Falcon", "Ginger", "Harbor", "Iris", "Jade", "Kiwi", "Lemon", "Marble", "Nectar", "Onyx", "Peacock", "Quill", "River",
  "Sparrow", "Tulip", "Velvet", "Walnut", "Yarrow", "Acorn", "Bamboo", "Canyon", "Dune", "Fern", "Grove", "Heron", "Ivory", "Juniper",
  "Lagoon", "Meadow", "Nimbus", "Orchid", "Pebble", "Ripple", "Summit", "Thistle",
] as const;
export function makePassword(random: (a: Uint32Array) => Uint32Array = (a) => crypto.getRandomValues(a)): string {
  const r = random(new Uint32Array(3));
  const w1 = WORDS[r[0]! % WORDS.length]!;
  let w2 = WORDS[r[1]! % WORDS.length]!;
  if (w2 === w1) w2 = WORDS[(r[1]! + 1) % WORDS.length]!;
  return `${w1}-${w2}-${String(r[2]! % 10000).padStart(4, "0")}`;
}

/** "9876543210" → "98•••••210". The full number is on the edit panel, one click away. */
export function maskMobile(mobile: string | null): string | null {
  if (mobile === null) return null;
  return mobile.length < 6 ? mobile : `${mobile.slice(0, 2)}${"•".repeat(mobile.length - 5)}${mobile.slice(-3)}`;
}

/** "XXXX XXXX 0124" → "•••• 0124". */
export function shortAadhaar(masked: string | null): string | null {
  return masked === null ? null : `•••• ${masked.slice(-4)}`;
}

/** Roles grouped by area for the type-ahead, filtered by what was typed, titles sorted within an area. */
export function roleGroups(roles: readonly WireRole[], query: string): { area: string; roles: WireRole[] }[] {
  const q = fold(query.trim());
  const hits = roles.filter((r) => q === "" || fold(r.title).includes(q) || r.key.includes(q.replace(/\s+/g, "_")));
  const by = new Map<string, WireRole[]>();
  for (const r of hits) {
    const a = areaOf(r);
    const list = by.get(a);
    if (list === undefined) by.set(a, [r]); else list.push(r);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([area, list]) => ({ area, roles: list.sort((x, y) => shortTitle(x.title).localeCompare(shortTitle(y.title))) }));
}

/** The quick picks on the New user drawer, by role key, in the board's order. */
export const QUICK_ROLES = ["doctor", "vitals_desk", "front_office", "cashier", "pharmacy", "lab_technician"] as const;
