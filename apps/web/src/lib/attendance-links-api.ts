import { api } from "./api";

/**
 * #634 — the wire contract of `modules/attendance/links.controller.ts`, transcribed. No route here
 * answers a mobile number or a hash: a suggestion carries the LAST FOUR digits that match, a
 * login's Aadhaar is the masked form.
 */
export type WireLinkCounts = { active: number; linked: number; unlinked: number; needsAttention: number; loginsActive: number; loginsLinked: number };
export type WireUnlinkedReason = "no_match" | "aadhaar_shared" | "mobile_shared_on_machine" | "mobile_shared_by_logins" | "login_linked_elsewhere";
export type WireUnlinked = { pin: string; name: string; dept: string | null; post: string | null; reason: WireUnlinkedReason };
export type WireMatch = "aadhaar" | "mobile";
export type WireMachinePerson = {
  pin: string; name: string; dept: string | null; post: string | null; status: string;
  needsAttention: Exclude<WireUnlinkedReason, "no_match"> | null;
  login: { userId: string; username: string; fullName: string; source: WireMatch } | null;
};
export type WireLoginRow = { userId: string; username: string; fullName: string; staffCode: string; linkedPin: string | null; match: WireMatch | null; hasMobile: boolean; aadhaar: string | null };
export type WireSuggestion = {
  person: { pin: string; name: string; dept: string | null; post: string | null };
  login: { userId: string; username: string; fullName: string };
  last4: string;
  shared: boolean;
};

const qs = (params: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
};

/** The owner's and the committee's view (`attendance.all.read`). */
export function listUnlinked(q: string, offset = 0): Promise<{ counts: WireLinkCounts; total: number; offset: number; people: WireUnlinked[] }> {
  return api("GET", `/attendance/links${qs({ q: q.trim(), offset: offset === 0 ? undefined : offset })}`);
}

/** The Users administrator's (`auth.users.manage`). */
export function searchMachinePeople(q: string): Promise<{ counts: WireLinkCounts; people: WireMachinePerson[] }> {
  return api("GET", `/admin/users/attendance-links${qs({ q: q.trim() })}`);
}
export function listSuggestions(): Promise<{ suggestions: WireSuggestion[] }> {
  return api("GET", "/admin/users/attendance-links/suggestions");
}
export function linkCandidates(pin: string, q: string): Promise<{ person: WireMachinePerson; matches: WireLoginRow[]; found: WireLoginRow[] }> {
  return api("GET", `/admin/users/attendance-links/${encodeURIComponent(pin)}/candidates${qs({ q: q.trim() })}`);
}
export function linkPerson(pin: string, userId: string): Promise<{ pin: string; userId: string; source: WireMatch; counts: WireLinkCounts }> {
  return api("POST", "/admin/users/attendance-links", { pin, userId });
}
