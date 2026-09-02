import { api } from "./api";

/**
 * RC-3 T4 — THE WEB'S DECLARATION OF `GET /patients/search`, AND THE FIRST ONE TO CARRY `matchedOn`.
 *
 * ═══ WHY THIS MODULE EXISTS AT ALL ═══
 *
 * `matchedOn` shipped in RC-1 T4 and, measured this task, is **not declared in any web type**:
 * `patient-picker.tsx:17`, `registration-desk.tsx:16` and `merge-review.tsx:8` each declare their
 * own private `SearchHit`, all three identical, all three missing the field. The server has been
 * sending it over the wire the whole time — `patients.controller.ts:227` returns
 * `searchPatients(...)` as `unknown[]`, so nothing strips it; three copies of a narrow type simply
 * dropped it on the floor at the type boundary.
 *
 * Three private copies of one wire shape is how a field goes unnoticed for two phases, so the shape
 * gets ONE public home here. The three shipped screens are NOT migrated onto it in this phase —
 * D1 freezes them, and rewriting a proven search box in a wiring phase would put a refactor and a
 * first consumer in one diff. That residual duplication is recorded rather than silently left; it
 * is RC-4's, in the task that deletes one of the two counters.
 *
 * ═══ `dob` IS A STRING HERE AND A `Date` THERE ═══
 *
 * `PatientSearchResult.dob` is `Date | null` in `apps/core/src/modules/patients/search.ts:20`. It
 * arrives as a JSON string. This is the WIRE type, so it says string — the same choice the three
 * private copies already made, and the reason they are transcribed rather than imported.
 */

/**
 * The lanes the server's predicate is built of, named identically to `MatchLane` in
 * `apps/core/src/modules/patients/search.ts:27`. They are derived from the SAME SQL fragments the
 * `WHERE` is built from, per row — never a JS re-derivation that could drift from what matched.
 */
export type WireMatchLane = "uhid" | "mobile" | "name";

export type WirePatientHit = {
  id: string;
  uhid: string;
  name: string;
  phone: string | null;
  administrativeGender: string;
  dob: string | null;
  isConfidential: boolean;
  hasPhoto: boolean;
  /** RC-1 T4 / D6 — WHY this row matched. Rendered as reasons; see `matchReasonKeys`. */
  matchedOn: WireMatchLane[];
};

/**
 * D6 — MATCH REASONS, NEVER A SCORE, AND THIS FUNCTION IS WHERE THAT RULING IS ENFORCEABLE.
 *
 * The owner's design ruling, recorded in `desk-one.html`'s own legend: *"search results say what
 * matched (same mobile), never a confidence percentage; a clerk can act on a reason, not on 87%."*
 * A percentage invites a clerk to treat 87% as nearly-certain and pick the top row; "same mobile"
 * tells them the one thing they can go and check with the person standing in front of them.
 *
 * It returns KEYS, not sentences, so the ruling is asserted against a list the test can enumerate
 * exhaustively rather than against rendered prose in one language.
 *
 * ═══ THE EMPTY CASE IS REAL AND IT IS NOT AN ERROR ═══
 *
 * `laneFor` in `search.ts:240` returns a literal `false` for any lane the parsed query did not
 * build a condition for, so `matchedOn` is `[]` for any row that reached the result set by some
 * route other than the three lanes. The desk still has to render that row, and it must not render
 * it with NO explanation beside rows that have one — an unexplained row next to explained ones
 * reads as a stronger match, which is the confidence-ranking this ruling exists to forbid. It says
 * "on file", which is what the design does and what is true.
 */
export function matchReasonKeys(matchedOn: readonly WireMatchLane[]): string[] {
  if (matchedOn.length === 0) return ["registrationCounter.find.reason.onFile"];
  return matchedOn.map((lane) => `registrationCounter.find.reason.${lane}`);
}

/**
 * The seat's find. `limit` is the server's own cap language (`max(50)`); eight is what a counter
 * screen can show without scrolling, and a ninth row at a desk is a scroll a clerk does not do.
 */
export async function searchPatients(q: string, limit = 8): Promise<WirePatientHit[]> {
  const { items } = await api<{ items: WirePatientHit[] }>(
    "GET", `/patients/search?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
  return items;
}

/**
 * VD-2 T1 — the scanner door. The card payload is `q1.<patientId>.<uhid>.<qrVersion>.<sig>`
 * (`patients/qr.ts:15`); a keyboard-wedge scanner types it into whatever field has focus and
 * presses Enter, so the bay's identify box receives it exactly as a typed token would arrive.
 * A failed scan is a domain answer (`ok: false`) on HTTP 200, never a thrown transport error.
 */
export type WireQrVerifyResult =
  | { ok: true; patient: { id: string; uhid: string; name: string; administrativeGender: string; dob: string | null } }
  | { ok: false; reason: "malformed" | "invalid_signature" | "stale_version" | "unknown_patient" };
export function verifyQrScan(payload: string): Promise<WireQrVerifyResult> {
  return api("POST", "/patients/qr/verify", { payload });
}
