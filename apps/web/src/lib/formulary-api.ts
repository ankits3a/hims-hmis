import { api, ApiError } from "./api";

/**
 * PLAN 16a T7 — the formulary wire contract, transcribed from `formulary.controller.ts` exactly as
 * `membership-api.ts` and `ops-api.ts` transcribe theirs: this file DESCRIBES what those routes
 * ship and never re-derives or widens it.
 *
 * ═══ EVERY PAYLOAD HERE IS UNTRUSTED CONTENT ═══
 *
 * `WireStagingRow.payload` is scraped from a third-party site. The reviewer who reads it is a
 * PRIVILEGED user — a pharmacist with `formulary.staging.review` — which makes the staging screen
 * the highest-value XSS target in the application: a payload that executed would run with a
 * curator's session. It is typed `Record<string, unknown>` rather than anything structured on
 * purpose, so that no consumer can be tempted to treat a scraped field as a fact, and the screen
 * renders every one of them through React's text path. There is no `dangerouslySetInnerHTML`
 * anywhere in this feature and its test asserts a `<script>` payload renders inert.
 */

export type WireSalt = {
  id: string; name: string; aliases: string[]; drugClass: string | null;
  atcCode: string | null; active: boolean;
};

export type WireMedicine = {
  id: string; brandName: string; form: string; routeClass: string;
  strengthLabel: string | null; scheduleFlag: string | null; stagingId: string | null; active: boolean;
  salts: { saltId: string; strength: string | null }[];
};

export type WireInteraction = {
  id: string; saltAId: string; saltBId: string;
  severity: "severe" | "moderate"; note: string; source: string;
  routeScope: "systemic_only" | null; active: boolean;
};

export type WireStagingRow = {
  id: string; kind: string; name: string;
  /** SCRAPED. Untrusted. Rendered as text, never as markup — see the header. */
  payload: Record<string, unknown>;
  sourceUrl: string; minedAt: string;
  status: "pending" | "approved" | "rejected";
  reviewedBy: string | null; reviewedAt: string | null; medicineId: string | null;
};

export type WireCoverage = {
  coverage: number;
  /** DD5 — the SERVER decides. The client never re-derives the threshold from `coverage`. */
  noticeEnabled: boolean;
  unresolvedTop: { drug: string; count: number }[];
};

/**
 * ═══ THE THREE LIST ROUTES ARE PAGED, AND `fetchSalts` / `fetchMedicines` ARE GONE, NOT CAPPED ═══
 *
 * They used to be `GET /formulary/salts` and `GET /formulary/medicines`, each handing back the
 * whole table as an array. Both routes now answer `{ items, nextCursor }` — keyset, ascending,
 * forward-only; the four laws are written in `apps/core/src/kernel/db/page.ts` and this file does
 * not restate them, it obeys them.
 *
 * The array-shaped readers were DELETED rather than re-pointed at page one, which mirrors the
 * ruling on the server side. A surviving `fetchMedicines()` that quietly returned the first 50 of
 * 103,383 rows would keep the promise its NAME makes — "the catalogue" — and break it silently, and
 * the next caller to reach for it (an item-master bridge, a substitution check) would get a short
 * answer with nothing on screen to say so. A name that cannot be spelled cannot be misread.
 *
 * `nextCursor === null` IS THE END OF THE LIST, AND IT IS THE ONLY END. Never stop because a page
 * came back shorter than `limit`: the server over-fetches by one to decide, so a short page with a
 * cursor is a real state and a full page without one is the normal last page.
 */
export type WirePage<T> = { items: T[]; nextCursor: string | null };

/**
 * `limit` is CLAMPED server-side to [1, 200] with a default of 50 — never rejected, so asking for
 * 1,000 is answered with 200 rather than a 400. A `cursor` the server did not issue answers 400:
 * `decodeCursor` refuses rather than silently restarting at page one, because a client that thinks
 * it advanced and did not will page the same rows for ever with no error anywhere.
 */
type PageAsk = { limit?: number; cursor?: string | null };

/**
 * `active` is sent ONLY when narrowing to active rows. The server reads `active === "true"`, so
 * `active=false` and an absent `active` are the same request; sending the redundant one would
 * suggest a third state ("inactive only") that no route offers.
 */
function pageQuery(ask: PageAsk & { activeOnly?: boolean; moietiesOnly?: boolean; status?: string; q?: string }): string {
  const params = new URLSearchParams();
  if (ask.activeOnly === true) params.set("active", "true");
  if (ask.moietiesOnly === true) params.set("moieties", "true");
  if (ask.status !== undefined) params.set("status", ask.status);
  const q = (ask.q ?? "").trim();
  if (q !== "") params.set("q", q);
  if (ask.limit !== undefined) params.set("limit", String(ask.limit));
  if (ask.cursor !== undefined && ask.cursor !== null) params.set("cursor", ask.cursor);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/**
 * A page of moieties. `q` is a substring of the NAME — the server does not search aliases here.
 * `moietiesOnly` leaves out every release entry nobody has reviewed: the mapping worklist's picker,
 * where choosing one would be refused anyway.
 */
export async function fetchSaltsPage(
  ask: PageAsk & { activeOnly?: boolean; moietiesOnly?: boolean; q?: string } = {},
): Promise<WirePage<WireSalt>> {
  return api<WirePage<WireSalt>>("GET", `/formulary/salts${pageQuery(ask)}`);
}

/** A page of medicines with their composition, ordered by brand name. */
export async function fetchMedicinesPage(
  ask: PageAsk & { activeOnly?: boolean } = {},
): Promise<WirePage<WireMedicine>> {
  return api<WirePage<WireMedicine>>("GET", `/formulary/medicines${pageQuery(ask)}`);
}

/**
 * How big the catalogue is, in one statement and with no row on the wire.
 *
 * Keyset paging gives no total — that is the price of not paying for `offset` — so a screen that
 * wants to say how many medicines there are has to ask. `uncomposedActiveMedicines` is the figure
 * this module has never shown anyone: active products with no moiety, which no interaction,
 * allergy or substitution check can reason about.
 */
export type WireCensus = {
  salts: number; activeSalts: number;
  medicines: number; activeMedicines: number;
  compositionRows: number;
  uncomposedActiveMedicines: number;
  interactions: number; activeInteractions: number;
  /** The mapping loop: release substances by decision state, and how many waiting ones carry a draft. */
  substances: number; pendingSubstances: number; mappedSubstances: number; unmappableSubstances: number;
  draftedPendingSubstances: number;
  /** Active products with a component nobody has reviewed: the number the attestation sittings drive down. */
  unreviewedActiveMedicines: number;
};

export async function fetchCensus(): Promise<WireCensus> {
  return api<WireCensus>("GET", "/formulary/census");
}

/**
 * ═══ THE MAPPING LOOP (phase 2) — `mapping.ts` on the server, transcribed ═══
 *
 * A DRAFT IS UNTRUSTED CONTENT, like a scraped staging payload. `rationale` is a model's output and
 * `evidence.generics[].name` is the national release's text. The reader is a pharmacist holding
 * `formulary.manage`. Everything here is rendered through React's text path, and the component's
 * test drives a markup-bearing rationale through it.
 */
export type WireSubstanceStatus = "pending" | "mapped" | "unmappable";
export type WireExistingState = "moiety" | "own_entry" | "other_entry" | "none";

export type WireDraft = {
  id: string;
  moietyName: string;
  basis: "release_boss" | "release_base" | "agent";
  evidence: {
    generics?: { sctid: string; name: string }[];
    support?: number;
    alternatives?: { name: string; support: number }[];
    droppedWord?: string;
    model?: string;
    rationale?: string;
  };
  draftedBy: string;
  existingSaltId: string | null;
  existingState: WireExistingState;
};

export type WireWorklistItem = {
  id: string; sctid: string; name: string; synonyms: string[];
  status: WireSubstanceStatus;
  saltId: string | null; saltName: string | null;
  mappedBy: string | null; mappedAt: string | null;
  coverage: number;
  ownEntryId: string | null;
  sampleGenerics: string[];
  proposals: WireDraft[];
};

export async function fetchWorklistPage(
  ask: PageAsk & { status: WireSubstanceStatus; q?: string },
): Promise<WirePage<WireWorklistItem>> {
  return api<WirePage<WireWorklistItem>>("GET", `/formulary/substances${pageQuery(ask)}`);
}

export type AttestTarget = { saltId: string } | { newMoiety: { name: string; drugClass?: string | null } };

export type WireMappingDecision = {
  substanceId: string;
  status: "mapped" | "unmappable";
  saltId: string | null;
  projection: { rowsMoved: number; medicinesMoved: number; medicinesBlocked: number };
};

/** ONE substance per call. There is no bulk form of this, on the wire or here (owner ruling R1). */
export async function attestSubstance(
  substanceId: string,
  body: { target: AttestTarget; proposalId?: string | null; correctionReason?: string | null },
): Promise<WireMappingDecision> {
  return api<WireMappingDecision>("POST", `/formulary/substances/${substanceId}/attest`, body);
}

export async function ruleSubstanceUnmappable(
  substanceId: string, body: { reason: string; correction?: boolean },
): Promise<WireMappingDecision> {
  return api<WireMappingDecision>("POST", `/formulary/substances/${substanceId}/unmappable`, body);
}

/** Pull-based (spec §1.1): a name search. There is no route that lists every pending row. */
export async function searchStaging(q: string): Promise<WireStagingRow[]> {
  if (q.trim() === "") return [];
  return (await api<{ items: WireStagingRow[] }>(
    "GET", `/formulary/staging/search?q=${encodeURIComponent(q)}`,
  )).items;
}

export type AdmitInput = {
  brandName: string; form: string; routeClass: "systemic" | "topical";
  strengthLabel?: string | null; scheduleFlag?: string | null;
  salts: { saltId: string; strength?: string | null }[];
  acknowledgeIntraFdc?: boolean;
};

export async function admitStaging(stagingId: string, input: AdmitInput): Promise<{ medicineId: string }> {
  return api<{ medicineId: string }>("POST", `/formulary/staging/${stagingId}/admit`, input);
}

export async function rejectStaging(stagingId: string, reason: string): Promise<void> {
  await api<{ ok: true }>("POST", `/formulary/staging/${stagingId}/reject`, { reason });
}

export async function addMedicine(input: AdmitInput): Promise<{ medicineId: string }> {
  return api<{ medicineId: string }>("POST", "/formulary/medicines", input);
}

export async function addSalt(input: { name: string; drugClass?: string | null }): Promise<{ saltId: string }> {
  return api<{ saltId: string }>("POST", "/formulary/salts", input);
}

/** T8's endpoint. A 404 means "not deployed yet" and the caller treats it as OFF (DD5). */
export async function fetchCoverage(): Promise<WireCoverage | null> {
  try {
    return await api<WireCoverage>("GET", "/formulary/coverage");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export type WirePairUsage = {
  saltAId: string; saltBId: string;
  severity: "severe" | "moderate";
  note: string;
  timesOnIssued: number;
  timesOverridden: number;
  /**
   * FOR A SEVERE PAIR THIS IS 1 BY CONSTRUCTION — the issue gate refuses a severe hit no override
   * covers, so every occurrence on a stored prescription was clicked through. The screen shows the
   * COUNT as the headline for that reason; the share alone would look like a rate and is not one.
   */
  overriddenShare: number;
};

export async function fetchPairRates(): Promise<WirePairUsage[]> {
  return (await api<{ items: WirePairUsage[] }>("GET", "/formulary/pair-rates")).items;
}

/** The module's refusals, rendered as the message the server sent rather than re-worded here. */
export function formularyErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: string; code?: string } | null;
    return body?.message ?? body?.code ?? e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * ═══ THE DRUG TYPEAHEAD (owner, 2026-09-14) ═══
 *
 * *"even though the doctor doesn't enable AI suggestion in the prescription tab, auto complete will
 * work if doctor starts to type drug name."* — so this is the always-on road, and it takes ten rows
 * rather than the catalogue.
 *
 * A `<select>` over the catalogue is the instrument this replaced, and the size of that payload has
 * been quoted in three places in two different figures — "about 15 MB" here and in
 * `opd-consult.tsx`, "38 MiB" a hundred lines further down that same screen. Both were written as
 * "measured" and they cannot both be right, so it was measured again, to a method anyone can repeat.
 *
 * ═══ MEASURED 2026-09-16, AND THE METHOD IS THE CLAIM ═══
 *
 * Read-only against `hmis_cds_dev`, the database that holds the owner's imported national
 * catalogue (103,383 medicines, 142,759 composition rows, 3,283 moieties — the same corpus
 * `catalogue-scale.test.ts` reproduces the wire-protocol crash against). The exact JSON body the
 * old `GET /formulary/medicines` shipped was rebuilt in SQL — every column of
 * `formulary_medicines` under its drizzle camelCase name plus the `salts` array, wrapped in
 * `{ items, nextCursor }` — and its `octet_length` taken:
 *
 *     60,128,503 bytes = 57.3 MiB = 60.1 MB
 *
 * Trimmed to only the nine fields `WireMedicine` below transcribes, the same body is 38,762,461
 * bytes = 37.0 MiB. So "38 MiB" was measuring the trimmed shape and is close to right; "about
 * 15 MB" is not reproducible at any shape and should be read as superseded by this paragraph.
 * (`opd-consult.tsx` still carries the 15 MB figure in two comments — not this lane's file to edit.)
 *
 * Either number is the same conclusion: this is a payload no screen may fetch. Everything
 * interactive takes ten rows from the typeahead below; the admin catalogue takes one page.
 */
export type WireMedicineHit = {
  id: string;
  name: string;
  form: string;
  strength: string | null;
  /** The hospital's catalogue code — `D0230`. Only generics carry one; a branded row has none. */
  code: string | null;
  routeClass: string;
  salts: string[];
  /** True when the NAME starts with what was typed — the field bolds that much of it. */
  prefix: boolean;
  /**
   * False when a component is a release entry no pharmacist has reviewed. Such a component carries
   * no drug class and no interaction pairs, and the field says so beside the name.
   */
  reviewed: boolean;
};

export const searchMedicines = async (q: string, limit = 10): Promise<WireMedicineHit[]> =>
  (await api<{ items: WireMedicineHit[] }>(
    "GET", `/formulary/medicines/search?q=${encodeURIComponent(q)}&limit=${String(limit)}`,
  )).items;
