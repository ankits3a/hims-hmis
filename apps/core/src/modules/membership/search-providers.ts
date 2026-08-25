import { and, desc, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Actor, SearchHit } from "@hmis/contracts";
import { membershipInstances, membershipPlans } from "../../kernel/db/schema";
import { escapeLike } from "../../kernel/search/text";
import { normalizeForSearch } from "../../kernel/search/normalize";
import { resolvePatientId, visiblePatientIds } from "../patients";
import type { SearchProvider, SearchProviderCtx, SearchProviderResult } from "../../kernel/search/types";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T3 — THE `membership.instrument` SEARCH PROVIDER, on the 11h seam.
 *
 * A desk finds a card by its CODE, by the holder's PHONE, by the holder's NAME, or by the patient
 * it is already linked to. It is declared on the membership manifest and collected by
 * `kernel/search/registry.ts`; the permission (`membership.instrument.read`) is DECLARED rather
 * than checked inside `run`, which is what lets the fan-out decide before the query is issued.
 *
 * ═══ THE SEALED GATE IS IN THE SQL, AND `total` IS COUNTED BY THE SAME QUERY (C1 / §2.89) ═══
 *
 * 11h's independent review found a sealed patient reachable through a chip-scoped query whose two
 * halves were each individually correct: the hits were gated and the COUNT was not, so the exact
 * number of a confidential patient's records leaked as an integer. This provider is built so that
 * cannot recur:
 *
 *   1. the match predicate is computed;
 *   2. the DISTINCT patient ids that predicate can reach are asked for — ids only, nothing shown;
 *   3. `visiblePatientIds()` — the patients module's single gate, never re-implemented here —
 *      answers which of them this caller may see;
 *   4. that answer becomes ONE SQL predicate, `patient_id is null or patient_id in (…)`, and BOTH
 *      the row query and the count query are built from the same `where`.
 *
 * There is no post-filter anywhere: a row this caller may not see is never selected, so it cannot
 * be counted, ordered by, or dropped afterwards. An instrument with NO patient is visible — it is
 * an unlinked holder-book row and there is no patient's confidentiality to protect yet.
 *
 * ═══ BOTH SCRIPTS, BOTH DIRECTIONS (F7 / C5) ═══
 *
 * `\b` IS ASCII-ONLY — `/\b(word|शब्द)\b/` never matches the Devanagari half, silently, because the
 * English half still works — so no regex boundary appears anywhere in this file. The folding is
 * `normalizeForSearch`, the shipped one, used verbatim; see `holderNameLanes` for why it takes two
 * lanes plus a third, and why the third one exists at all.
 */

/** The Devanagari block, as CHARACTERS rather than as `\u` escapes: Postgres does not read those. */
const DEVANAGARI_CLASS = `[${String.fromCharCode(0x0900)}-${String.fromCharCode(0x097f)}]`;
const DEVANAGARI_RE = new RegExp(DEVANAGARI_CLASS);

/** Digits only, the `patientMatchCondition` shape: a phone is a phone, never a name. */
const PHONE_RE = /^\d{3,14}$/;

/**
 * THE THREE NAME LANES, AND WHY THE SHIPPED TWO ARE NOT ENOUGH HERE.
 *
 * `patients/search.ts` matches the FOLDED query or the RAW one, which covers two of the four
 * script combinations: a Devanagari query finds a Latin record (the query folds to Latin), and a
 * Devanagari query finds a Devanagari record (the raw spelling still matches). What it cannot do
 * is find a DEVANAGARI-STORED record from a LATIN query — the query folds to Latin, the column
 * still holds Devanagari, and Latin-versus-Devanagari trigrams score ~0 so no fuzzy branch rescues
 * it. On `patients` that gap is covered by a desk typing the name it registered; on a partner's
 * HOLDER BOOK the hospital did not choose the script, and this phase's acceptance is explicitly
 * both directions.
 *
 * The third lane closes it by folding the STORED side with the SAME shipped function:
 * `membership_instances` has no normalised column and no trigram index (adding either is a second
 * migration, which is a halt), so the fold happens in this process over the rows that can possibly
 * need it — the ones that actually contain Devanagari. It runs ONLY for a query with no Devanagari
 * in it, because a query that already carries the script is served by the raw lane.
 *
 * It yields IDS ONLY. Nothing it reads is returned or counted: every id it produces still has to
 * pass the sealed gate in the main query below, which is what keeps "the gate is in the SQL" true.
 *
 * ITS COST IS REAL AND IS RECORDED RATHER THAN HIDDEN: it is a scan of the Devanagari-named subset
 * of the holder book, and the right fix — a stored folded column with its own trigram index — is a
 * migration this task may not write. See the T3 report and `.plan-09-relay.md`.
 */
async function devanagariHolderIds(db: Db, folded: string): Promise<string[]> {
  const rows = await db
    .select({ id: membershipInstances.id, holderName: membershipInstances.holderName })
    .from(membershipInstances)
    .where(sql`${membershipInstances.holderName} ~ ${DEVANAGARI_CLASS}`);
  return rows.filter((r) => normalizeForSearch(r.holderName).startsWith(folded)).map((r) => r.id);
}

async function holderNameLanes(db: Db, text: string): Promise<SQL[]> {
  const folded = normalizeForSearch(text);
  const rawLower = text.trim().toLowerCase();
  if (folded === "") return [];
  const lanes: SQL[] = [sql`lower(${membershipInstances.holderName}) like ${`${escapeLike(folded)}%`}`];
  if (folded !== rawLower) {
    lanes.push(sql`lower(${membershipInstances.holderName}) like ${`${escapeLike(rawLower)}%`}`);
  }
  if (!DEVANAGARI_RE.test(text)) {
    const ids = await devanagariHolderIds(db, folded);
    if (ids.length > 0) lanes.push(inArray(membershipInstances.id, ids));
  }
  return lanes;
}

/**
 * What this text can match, or `undefined` when it can match nothing.
 *
 * A digit string is a PHONE and never a name — the `patientMatchCondition` split, kept — and every
 * text lane is a PREFIX, because a leading wildcard cannot use an index and this table is the one
 * that grows with the partner's book rather than with the hospital's master data.
 */
async function textCondition(db: Db, text: string): Promise<SQL | undefined> {
  const trimmed = text.trim();
  if (trimmed.length < 2) return undefined;
  if (PHONE_RE.test(trimmed)) {
    return sql`${membershipInstances.holderPhone} like ${`${escapeLike(trimmed)}%`}`;
  }
  const lanes: SQL[] = [
    // The card code, case-insensitively: a desk types what it reads off the card.
    sql`lower(${membershipInstances.cardCode}) like ${`${escapeLike(trimmed.toLowerCase())}%`}`,
    ...(await holderNameLanes(db, trimmed)),
  ];
  return or(...lanes);
}

/**
 * THE GATE, AS A PREDICATE. Built from `visiblePatientIds()`'s answer and nothing else.
 *
 * `patient_id is null` is included on purpose: an unlinked holder-book row belongs to nobody yet,
 * so there is no confidentiality decision to make about it — refusing it would hide the very rows
 * T5's reconcile queue exists to get a human to link.
 */
function visibilityPredicate(visibleIds: string[]): SQL {
  const linked = visibleIds.length === 0
    ? sql`false`
    : inArray(membershipInstances.patientId, visibleIds);
  return or(isNull(membershipInstances.patientId), linked)!;
}

/**
 * Which patients can the match predicate reach, and which of those may this caller see?
 *
 * Ids only — no name, no card, no count is produced from this step, and its result is used for
 * exactly one thing: building the SQL predicate the real query is counted under.
 */
async function visibleFor(db: Db, actor: Actor, match: SQL): Promise<string[]> {
  const rows = await db
    .selectDistinct({ patientId: membershipInstances.patientId })
    .from(membershipInstances)
    .where(and(match, isNotNull(membershipInstances.patientId)));
  const ids = rows.map((r) => r.patientId).filter((id): id is string => id !== null);
  return ids.length === 0 ? [] : visiblePatientIds(db, actor, ids);
}

export const INSTRUMENT_SEARCH_PROVIDER_KEY = "membership.instrument";

export const instrumentSearchProvider: SearchProvider = {
  key: INSTRUMENT_SEARCH_PROVIDER_KEY,
  entity: "instrument",
  permission: "membership.instrument.read",

  async run(ctx: SearchProviderCtx): Promise<SearchProviderResult> {
    const text = ctx.query.text.trim();
    const patientChip = ctx.query.chips.find((c) => c.entity === "patient")?.id;
    const instrumentChip = ctx.query.chips.find((c) => c.entity === "instrument")?.id;

    const conditions: SQL[] = [];
    if (instrumentChip !== undefined) conditions.push(eq(membershipInstances.id, instrumentChip));
    if (patientChip !== undefined) {
      /**
       * A PATIENT ID IS NOT A CAPABILITY (11h close, CRITICAL 1). The chip lane is gated exactly
       * as the text lane is, and it is resolved through the merge chain first: an id read off an
       * older screen may name a patient the hospital has since merged away, and DD11 says
       * instruments are never re-linked, so both spellings have to reach the same rows.
       */
      const survivor = await resolvePatientId(ctx.db, patientChip);
      const visible = survivor === null ? [] : await visiblePatientIds(ctx.db, ctx.actor, [survivor]);
      if (visible.length === 0) return { hits: [], total: 0 };
      conditions.push(eq(membershipInstances.patientId, visible[0]!));
    }
    if (text.length >= 2) {
      const byText = await textCondition(ctx.db, text);
      if (byText !== undefined) conditions.push(byText);
    } else if (conditions.length === 0) {
      return { hits: [], total: 0 };
    }
    if (conditions.length === 0) return { hits: [], total: 0 };

    const match = and(...conditions)!;
    // Steps 2–4 of the C1 contract: ids → the single gate → ONE predicate → one `where`, shared by
    // the rows and the count. A `total` computed from `match` alone would count a sealed patient's
    // instruments, which is the leak this shape exists to make impossible.
    const where = and(match, visibilityPredicate(await visibleFor(ctx.db, ctx.actor, match)))!;

    const [rows, counted] = await Promise.all([
      ctx.db
        .select({
          id: membershipInstances.id,
          cardCode: membershipInstances.cardCode,
          holderName: membershipInstances.holderName,
          status: membershipInstances.status,
          origin: membershipInstances.origin,
          validTo: membershipInstances.validTo,
          planTitle: membershipPlans.title,
        })
        .from(membershipInstances)
        .innerJoin(membershipPlans, eq(membershipPlans.id, membershipInstances.planId))
        .where(where)
        .orderBy(desc(membershipInstances.seq)) // arrival order — ULIDs cannot carry it (§3.26)
        .limit(ctx.limit),
      ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(membershipInstances)
        .innerJoin(membershipPlans, eq(membershipPlans.id, membershipInstances.planId))
        .where(where),
    ]);

    return {
      hits: rows.map((r): SearchHit => ({
        entity: "instrument",
        id: r.id,
        title: r.cardCode,
        subtitle: `${r.holderName} · ${r.planTitle}`,
        // Display-only strings, and DELIBERATELY NO MONEY: E-32's guardrail is that no counter
        // surface shows a sales figure, and a palette row is a counter surface.
        meta: { status: r.status, origin: r.origin, validTo: r.validTo.toISOString().slice(0, 10) },
        href: "/counter/instruments",
      })),
      total: counted[0]?.n ?? 0,
    };
  },
};
