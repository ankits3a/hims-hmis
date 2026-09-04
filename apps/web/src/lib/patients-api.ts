import { api, ApiError } from "./api";

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
  /**
   * FD-11 — the two fields that tell two people of the same name apart. `registeredOn` is an ISO
   * string here and a `Date` on the server, for the same reason `dob` is (see above).
   */
  district: string | null;
  registeredOn: string;
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
 * ═══ FD-11 — A REASON EVERY ROW SHARES IS NOT A REASON ═══
 *
 * FOUND BY LOOKING. A search for "Ramesh" returned eight rows, and all eight wore the same mint
 * `same name` chip. A chip that appears on every row carries no information at all: it is the
 * answer to a question nobody asked, occupying the width where the thing that DOES tell the rows
 * apart should be. Worse, it reads as corroboration — eight rows each asserting a match.
 *
 * The D6 ruling this must not break is that an unexplained row never sits beside an explained one,
 * because the unexplained one then reads as the stronger match. That ruling is about rows differing
 * from EACH OTHER, so it is preserved exactly: the reasons are shown when they differ across the
 * result set and hidden when every row carries the identical set. All or none, never some.
 *
 * A single hit keeps its reason — with nothing to compare against, "same mobile" still tells the
 * clerk the one thing they can go and check with the person in front of them.
 */
export function matchReasonsDiscriminate(hits: readonly { matchedOn: WireMatchLane[] }[]): boolean {
  if (hits.length < 2) return true;
  const signature = (h: { matchedOn: WireMatchLane[] }): string => matchReasonKeys(h.matchedOn).join("|");
  const first = signature(hits[0]!);
  return hits.some((h) => signature(h) !== first);
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

/* ── FD-9 — registration, as a counter act ───────────────────────────────────────────────────── */

/**
 * REGISTRATION ENDS AT THE UHID (the FD-8 ruling), which makes `POST /patients` the route the front
 * desk creates patients through — not `POST /opd/walk-in`'s embedded `register`, whose body also
 * demands a department and a doctor and so forced the appointment decision into the enrolment form.
 *
 * `sex` and not `administrativeGender`: the counter captures ONE of the two, and the server defaults
 * the legal marker from it (22c-A DD4). A client that sent both would be inventing an answer to a
 * question nobody at the desk was asked.
 */
export type WireRegisterBody = {
  name: string;
  sex: "male" | "female" | "other" | "unknown";
  phone?: string;
  ageYears?: number;
  dob?: string;
  addressLine?: string;
  /**
   * DD8 — the clerk SAW the near matches and is registering anyway. Sent only after the warning has
   * been rendered; sending it unconditionally would delete the check while leaving its code in place.
   */
  acknowledgedDuplicates?: boolean;
  /* ═══ FD-12 — the rest of the record, every field optional so the fast path is unchanged ═══ */
  altPhone?: string;
  title?: string;
  fatherHusbandName?: string;
  maritalStatus?: string;
  bloodGroup?: string;
  language?: "hi" | "en";
  district?: string;
  stateName?: string;
  pincode?: string;
  abhaNumber?: string;
  abhaAddress?: string;
  abhaVerificationStatus?: "none" | "self_declared" | "verified";
  nationality?: string;
  nationalIdType?: string;
  /** The clerk types what is printed on the card; the server keeps only the last four digits. */
  nationalIdMasked?: string;
  religion?: string;
  occupation?: string;
  monthlyIncomePaise?: number;
  legacyUhid?: string;
  isConfidential?: boolean;
  promotionalOptIn?: boolean;
  referredBySource?: string;
  referredByName?: string;
  referredByPhone?: string;
  referredBySpeciality?: string;
  guardian?: {
    name: string;
    relationship: "father" | "mother" | "spouse" | "sibling" | "legal_guardian" | "other";
    phone?: string;
    idType?: "aadhaar" | "pan" | "voter_id" | "other";
    idNumberMasked?: string;
  };
  coverages?: {
    kind: "pmjay" | "insurance" | "tpa" | "corporate" | "cghs" | "esic" | "other";
    payerName?: string;
    tpaName?: string;
    policyNumber?: string;
    cardNumber?: string;
    beneficiaryId?: string;
    employeeId?: string;
    planClass?: string;
    validFrom?: string;
    validTo?: string;
    verificationStatus?: "self_declared" | "card_seen" | "verified";
  }[];
};

/**
 * FD-12 — what this hospital can honestly offer for ABHA right now. Asked once, before the buttons
 * are drawn, so the counter never shows a live-looking control that only fails when pressed.
 */
export type WireAbhaCapability = {
  configured: boolean;
  canRecord: boolean;
  canCreate: boolean;
  canVerify: boolean;
  reason: string;
};

export function abhaCapability(): Promise<WireAbhaCapability> {
  return api("GET", "/patients/abha/capability");
}

/**
 * The row the server allocated, as `PatientRow`. Only the fields the desk shows are declared.
 *
 * `dob` is among them because the server DERIVES it: a counter sends `ageYears` (nobody at a window
 * knows their date of birth), and `registration.ts:87` turns that into a dob marked estimated. A
 * client that did not read it back would show the person it had just registered with no age at all,
 * which is what the first version of Desk One did — measured on the running preview.
 */
export type WireRegisterResult = {
  patient: { id: string; uhid: string; name: string; dob: string | null; phone: string | null; addressLine: string | null };
};

export function registerPatient(body: WireRegisterBody): Promise<WireRegisterResult> {
  return api("POST", "/patients", body);
}

/**
 * The near-matches a refused registration carries, under `detail.candidates`. Same shape and the
 * same `matchReasonKeys` the search row renders, so a candidate says WHY it is one.
 */
export function duplicateCandidates(e: unknown): WirePatientHit[] | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: string; detail?: { candidates?: unknown } } | null;
  if (body?.code !== "duplicate_suspected") return null;
  const candidates = body.detail?.candidates;
  return Array.isArray(candidates) ? (candidates as WirePatientHit[]) : null;
}

/* ══ FD-14 — THE PATIENT'S PHOTO ════════════════════════════════════════════════════════════════ */

/**
 * The server caps the stored image at 512,000 bytes and refuses anything larger with
 * `photo_too_large`, whose message says in as many words that "the client must downscale". So the
 * client downscales — see `downscaleToDataUrl` — and this function only carries what it is given.
 */
export const PHOTO_MAX_BYTES = 512_000;

export function putPatientPhoto(patientId: string, imageBase64: string): Promise<unknown> {
  return api("PUT", `/patients/${encodeURIComponent(patientId)}/photo`, { imageBase64 });
}

export function getPatientPhoto(patientId: string): Promise<{ mimeType: string; imageBase64: string }> {
  return api("GET", `/patients/${encodeURIComponent(patientId)}/photo`);
}
