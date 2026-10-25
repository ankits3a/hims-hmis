import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { anyOfText } from "../../kernel/db/any-of";
import { withTx } from "../../kernel/db/client";
import { loadEnv } from "../../kernel/config";
import {
  formularyInteractions, formularyReferenceInteractions, formularySalts, opdPrescriptions,
} from "../../kernel/db/schema";
import { listInteractionsAmong, resolveDrugTexts, resolveMedicines } from "./resolve";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { InteractionPair, ResolvedDrug } from "./resolve";

/**
 * #617 (decision 0052; licence confirmed by the owner 2026-10-23) — DDINTER 2.0 MAJOR INTERACTIONS AS A REFERENCE LAYER.
 *
 * Major pairs only, in their own table (`formularyReferenceInteractions`), loaded from the DDInter export files the
 * owner supplies (`scripts/import-ddinter.ts`). The prescription check adds them only when `DDINTER_REFERENCE_ENABLED`
 * is exactly "true" — it SHIPS OFF — and then as severe hits whose note starts "Reference interaction (DDInter)": an
 * override needs a reason, like any severe pair. The curated book always wins: a curated row for the same two moieties,
 * active OR retired, hides the reference pair (a retired curated row is a pharmacist's decision that the pair does not
 * warn, and the reference layer never overturns a review). Reference pairs are systemic only: DDInter carries no route.
 *
 * Before the switch is turned on, `replayReferenceInteractions` replays stored prescriptions: if the warning rate more
 * than doubles, the numbers go back to the owner first (decision 0052).
 */

export const DDINTER_SOURCE = "DDInter 2.0";
export const DDINTER_LICENCE = "CC BY-NC-SA 4.0";
export const REFERENCE_INTERACTION_LABEL = "Reference interaction (DDInter)";

/**
 * The kill switch, read here and not through `loadConfig()` (which needs `DATABASE_URL` and `SECRET_KEY`, absent in CI
 * test processes — the `memberBenefitsEnabled` precedent in `modules/billing/invoices.ts`). The two-string spelling:
 * "false" must never read as true, and any other value refuses loudly rather than being guessed at.
 */
const enabledFlag = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

export function ddinterReferenceEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  if (env === process.env) loadEnv();
  return enabledFlag.parse(env.DDINTER_REFERENCE_ENABLED);
}

// ─── the export file ───────────────────────────────────────────────────────────────────────────────

export type DdinterPair = { idA: string | null; nameA: string; idB: string | null; nameB: string };
export type DdinterParse = {
  major: DdinterPair[];
  skipped: { moderate: number; minor: number; unknown: number };
  /** Rows with a missing name or a level that is none of DDInter's four. */
  malformed: number;
};

/** One physical CSV line into fields, RFC 4180 quoting — DDInter names carry commas ("Sodium chloride, hypertonic"). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === "\"") {
        if (line[i + 1] === "\"") { cur += "\""; i += 1; } else quoted = false;
      } else cur += ch;
      continue;
    }
    if (ch === "\"") { quoted = true; continue; }
    if (ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * A DDInter download (`DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level`) → its Major pairs and the counts of the rest. Pure.
 * Columns are found by header name, so a file with the ids dropped or reordered still reads.
 */
export function parseDdinterCsv(text: string): DdinterParse {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const out: DdinterParse = { major: [], skipped: { moderate: 0, minor: 0, unknown: 0 }, malformed: 0 };
  if (lines.length === 0) return out;
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (name: string): number => header.indexOf(name.toLowerCase());
  const [ia, na, ib, nb, lv] = [col("DDInterID_A"), col("Drug_A"), col("DDInterID_B"), col("Drug_B"), col("Level")];
  if (na < 0 || nb < 0 || lv < 0) throw new Error("not a DDInter export: the header needs Drug_A, Drug_B and Level");
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const nameA = cells[na] ?? "";
    const nameB = cells[nb] ?? "";
    const level = (cells[lv] ?? "").toLowerCase();
    if (nameA === "" || nameB === "") { out.malformed += 1; continue; }
    if (level === "major") {
      out.major.push({ idA: ia < 0 ? null : cells[ia] || null, nameA, idB: ib < 0 ? null : cells[ib] || null, nameB });
    } else if (level === "moderate" || level === "minor" || level === "unknown") {
      out.skipped[level] += 1;
    } else {
      out.malformed += 1;
    }
  }
  return out;
}

// ─── the import ────────────────────────────────────────────────────────────────────────────────────

export type DdinterImportReport = {
  /** Major rows read, across every file (a pair repeated across files counts once). */
  major: number;
  skipped: { moderate: number; minor: number; unknown: number };
  malformed: number;
  /** Major pairs whose two names both reached a moiety (distinct moiety pairs). */
  mapped: number;
  /** Major pairs with at least one name the formulary does not know. */
  unmappedPairs: number;
  /** The unknown names, most frequent first. */
  unmappedNames: { name: string; count: number }[];
  /** Pairs whose two names reached ONE moiety (two DDInter entries for one substance): not loaded. */
  sameMoiety: number;
  /** Mapped pairs the curated book already holds (active or retired): loaded, never shown while it does. */
  curatedOverlap: number;
  added: number;
  retired: number;
  unchanged: number;
  batch: string;
};

/**
 * DDInter names → moiety ids, exactly: the moiety's name or one of its aliases. Anything else is reported, never
 * guessed — a pharmacist adds the alias ("acetaminophen" on paracetamol) and the next run maps it.
 *
 * NOT the FDA label layer's US-name map (#616): that layer is reference text that never feeds a safety check, and a
 * census in `reference-labels.test.ts` keeps it so. The mapping that feeds this check stays on the reviewed moieties.
 */
async function moietyIndex(db: Db): Promise<Map<string, string>> {
  const salts = await db.select({ id: formularySalts.id, name: formularySalts.name, aliases: formularySalts.aliases })
    .from(formularySalts).where(eq(formularySalts.active, true));
  const out = new Map<string, string>();
  for (const s of salts) out.set(s.name.trim().toLowerCase(), s.id);
  for (const s of salts) {
    for (const a of s.aliases) {
      const k = a.trim().toLowerCase();
      if (k !== "" && !out.has(k)) out.set(k, s.id);
    }
  }
  return out;
}

/**
 * Load the Major pairs of one or more DDInter export files. Dry run unless `apply`. The table ends holding exactly the
 * mapped pairs of these files: a new pair is inserted, a pair the files no longer hold is retired, the rest is
 * unchanged — so a second run with the same files changes nothing.
 */
export async function importDdinterInteractions(
  db: Db,
  actor: Actor,
  input: { files: readonly string[]; retrievedOn: string; apply: boolean },
): Promise<DdinterImportReport> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.retrievedOn)) throw new Error("retrievedOn must be YYYY-MM-DD");
  const skipped = { moderate: 0, minor: 0, unknown: 0 };
  let malformed = 0;
  const majors = new Map<string, DdinterPair>();
  for (const text of input.files) {
    const parsed = parseDdinterCsv(text);
    skipped.moderate += parsed.skipped.moderate;
    skipped.minor += parsed.skipped.minor;
    skipped.unknown += parsed.skipped.unknown;
    malformed += parsed.malformed;
    for (const p of parsed.major) {
      const [x, y] = [p.nameA.toLowerCase(), p.nameB.toLowerCase()].sort();
      const key = `${x!}|${y!}`;
      if (!majors.has(key)) majors.set(key, p);
    }
  }

  const index = await moietyIndex(db);
  const unmapped = new Map<string, number>();
  const wanted = new Map<string, { saltAId: string; saltBId: string; pair: DdinterPair; swapped: boolean }>();
  let unmappedPairs = 0;
  let sameMoiety = 0;
  for (const p of majors.values()) {
    const a = index.get(p.nameA.toLowerCase());
    const b = index.get(p.nameB.toLowerCase());
    if (a === undefined || b === undefined) {
      unmappedPairs += 1;
      if (a === undefined) unmapped.set(p.nameA.toLowerCase(), (unmapped.get(p.nameA.toLowerCase()) ?? 0) + 1);
      if (b === undefined) unmapped.set(p.nameB.toLowerCase(), (unmapped.get(p.nameB.toLowerCase()) ?? 0) + 1);
      continue;
    }
    if (a === b) { sameMoiety += 1; continue; }
    const swapped = b < a;
    const key = swapped ? `${b}|${a}` : `${a}|${b}`;
    if (!wanted.has(key)) wanted.set(key, { saltAId: swapped ? b : a, saltBId: swapped ? a : b, pair: p, swapped });
  }

  const curatedKeys = await curatedPairKeys(db, [...new Set([...wanted.values()].flatMap((w) => [w.saltAId, w.saltBId]))]);
  const live = await db.select({ id: formularyReferenceInteractions.id, a: formularyReferenceInteractions.saltAId, b: formularyReferenceInteractions.saltBId })
    .from(formularyReferenceInteractions).where(isNull(formularyReferenceInteractions.retiredAt));
  const liveKeys = new Map(live.map((r) => [`${r.a}|${r.b}`, r.id]));
  const toAdd = [...wanted.entries()].filter(([k]) => !liveKeys.has(k));
  const toRetire = [...liveKeys.entries()].filter(([k]) => !wanted.has(k)).map(([, id]) => id);
  const batch = newId();

  if (input.apply && (toAdd.length > 0 || toRetire.length > 0)) {
    await withTx(db, async (tx) => {
      const now = new Date();
      for (let i = 0; i < toRetire.length; i += 1000) {
        await tx.update(formularyReferenceInteractions).set({ retiredAt: now, retiredBy: actor.id })
          .where(anyOfText(formularyReferenceInteractions.id, toRetire.slice(i, i + 1000)));
      }
      const rows = toAdd.map(([, w]) => ({
        id: newId(), saltAId: w.saltAId, saltBId: w.saltBId,
        drugAName: w.swapped ? w.pair.nameB : w.pair.nameA, drugBName: w.swapped ? w.pair.nameA : w.pair.nameB,
        ddinterIdA: w.swapped ? w.pair.idB : w.pair.idA, ddinterIdB: w.swapped ? w.pair.idA : w.pair.idB,
        level: "major", source: DDINTER_SOURCE, licence: DDINTER_LICENCE, retrievedOn: input.retrievedOn,
        importBatch: batch, importedBy: actor.id, importedAt: now,
      }));
      for (let i = 0; i < rows.length; i += 1000) await tx.insert(formularyReferenceInteractions).values(rows.slice(i, i + 1000));
    });
  }

  return {
    major: majors.size, skipped, malformed,
    mapped: wanted.size, unmappedPairs,
    unmappedNames: [...unmapped.entries()].map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name)),
    sameMoiety,
    curatedOverlap: [...wanted.keys()].filter((k) => curatedKeys.has(k)).length,
    added: toAdd.length, retired: toRetire.length, unchanged: wanted.size - toAdd.length,
    batch,
  };
}

// ─── the reads ─────────────────────────────────────────────────────────────────────────────────────

/** Every curated pair among these moieties, ACTIVE OR RETIRED — the set that hides a reference pair. */
async function curatedPairKeys(db: Db, saltIds: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(saltIds)].filter((id) => id !== "");
  if (wanted.length < 2) return new Set();
  const rows = await db.select({ a: formularyInteractions.saltAId, b: formularyInteractions.saltBId }).from(formularyInteractions)
    .where(and(anyOfText(formularyInteractions.saltAId, wanted), anyOfText(formularyInteractions.saltBId, wanted)));
  return new Set(rows.map((r) => (r.a < r.b ? `${r.a}|${r.b}` : `${r.b}|${r.a}`)));
}

const noteOf = (a: string, b: string): string =>
  `${REFERENCE_INTERACTION_LABEL}: ${a} + ${b}, major. Not reviewed by the hospital. Source: ${DDINTER_SOURCE} (${DDINTER_LICENCE}).`;

/**
 * The live reference pairs among these moieties that the curated book does not hold, as check pairs (severe, systemic
 * only, marked `reference: "ddinter"`). Reads the table whatever the switch says: the replay needs it OFF.
 */
export async function listReferenceInteractionsAmong(db: Db, saltIds: readonly string[]): Promise<InteractionPair[]> {
  const wanted = [...new Set(saltIds)].filter((id) => id !== "");
  if (wanted.length < 2) return [];
  const rows = await db.select({
    saltAId: formularyReferenceInteractions.saltAId, saltBId: formularyReferenceInteractions.saltBId,
    drugAName: formularyReferenceInteractions.drugAName, drugBName: formularyReferenceInteractions.drugBName,
  }).from(formularyReferenceInteractions).where(and(
    isNull(formularyReferenceInteractions.retiredAt),
    anyOfText(formularyReferenceInteractions.saltAId, wanted),
    anyOfText(formularyReferenceInteractions.saltBId, wanted),
  ));
  if (rows.length === 0) return [];
  const curated = await curatedPairKeys(db, wanted);
  return rows.filter((r) => !curated.has(`${r.saltAId}|${r.saltBId}`)).map((r) => ({
    saltAId: r.saltAId, saltBId: r.saltBId, severity: "severe" as const,
    note: noteOf(r.drugAName, r.drugBName), routeScope: "systemic_only" as const, reference: "ddinter" as const,
  }));
}

/**
 * THE PAIRS THE PRESCRIPTION CHECK USES: the curated book's active pairs, plus — only when `DDINTER_REFERENCE_ENABLED`
 * is "true" — the reference pairs the curated book does not hold. Off, this is `listInteractionsAmong` exactly.
 */
export async function listInteractionsForCheck(
  db: Db, saltIds: string[], env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<InteractionPair[]> {
  const curated = await listInteractionsAmong(db, saltIds);
  if (!ddinterReferenceEnabled(env)) return curated;
  return [...curated, ...(await listReferenceInteractionsAmong(db, saltIds))];
}

// ─── the replay ────────────────────────────────────────────────────────────────────────────────────

export type ReferenceReplay = {
  since: Date; until: Date;
  /** Active stored prescriptions issued in the window. */
  prescriptions: number;
  curatedOnly: { prescriptionsWarned: number; warnings: number };
  withReference: { prescriptionsWarned: number; warnings: number };
  /** Share of prescriptions with at least one warning, each way. */
  rateCurated: number; rateWithReference: number;
  /** `rateWithReference / rateCurated`; null when the curated book warned on none. */
  ratio: number | null;
  /** Decision 0052's line: true when the rate would more than double (or rise from zero) — the owner decides first. */
  moreThanDoubles: boolean;
  /** The reference pairs that fired most, for the owner's review. */
  topReferencePairs: { note: string; prescriptions: number }[];
};

type StoredLine = { drug: string; medicineId?: string | null };

/**
 * Replay stored prescriptions with and without the reference layer. READS ONLY, whatever the switch says.
 *
 * IN-PRESCRIPTION PAIRS ONLY, as `curation.getPairOverrideRates` counts them: what else a patient was taking on the day
 * is not reconstructable from a stored row. A line resolves by its picked medicine first, then its text; same-line
 * pairs (a fixed-dose combination) are skipped, and a systemic-only pair is skipped when either line is topical — the
 * prescription check's own rules.
 */
export async function replayReferenceInteractions(db: Db, window: { since: Date; until: Date }): Promise<ReferenceReplay> {
  const rows = await db.select({ lines: opdPrescriptions.lines }).from(opdPrescriptions).where(and(
    eq(opdPrescriptions.status, "active"), gte(opdPrescriptions.issuedAt, window.since), lt(opdPrescriptions.issuedAt, window.until),
  ));
  const allLines = rows.flatMap((r) => (Array.isArray(r.lines) ? (r.lines as StoredLine[]) : []));
  const ids = [...new Set(allLines.map((l) => l.medicineId).filter((id): id is string => typeof id === "string" && id !== ""))];
  const byId = ids.length > 0 ? await resolveMedicines(db, ids) : new Map<string, ResolvedDrug>();
  const byText = allLines.length > 0 ? await resolveDrugTexts(db, [...new Set(allLines.map((l) => l.drug))]) : new Map<string, ResolvedDrug | null>();
  const resolve = (l: StoredLine): ResolvedDrug | null =>
    (typeof l.medicineId === "string" && l.medicineId !== "" ? byId.get(l.medicineId) : undefined) ?? byText.get(l.drug) ?? null;

  const saltIds = [...new Set(allLines.flatMap((l) => resolve(l)?.salts.map((s) => s.saltId) ?? []))];
  const curated = new Map((await listInteractionsAmong(db, saltIds)).map((p) => [`${p.saltAId}|${p.saltBId}`, p]));
  const reference = new Map((await listReferenceInteractionsAmong(db, saltIds)).map((p) => [`${p.saltAId}|${p.saltBId}`, p]));

  const tally = { curatedOnly: { prescriptionsWarned: 0, warnings: 0 }, withReference: { prescriptionsWarned: 0, warnings: 0 } };
  const fired = new Map<string, number>();
  for (const row of rows) {
    const lines = (Array.isArray(row.lines) ? (row.lines as StoredLine[]) : []).map(resolve);
    const seenCurated = new Set<string>();
    const seenReference = new Set<string>();
    for (let j = 0; j < lines.length; j += 1) {
      for (let i = 0; i < j; i += 1) {
        const [x, y] = [lines[j], lines[i]];
        if (x === null || x === undefined || y === null || y === undefined) continue;
        for (const a of x.salts) {
          for (const b of y.salts) {
            const key = a.saltId < b.saltId ? `${a.saltId}|${b.saltId}` : `${b.saltId}|${a.saltId}`;
            const c = curated.get(key);
            const topical = x.routeClass === "topical" || y.routeClass === "topical";
            if (c !== undefined && !(c.routeScope === "systemic_only" && topical)) seenCurated.add(`${String(i)}|${key}`);
            if (reference.has(key) && !topical) seenReference.add(`${String(i)}|${key}`);
          }
        }
      }
    }
    if (seenCurated.size > 0) tally.curatedOnly.prescriptionsWarned += 1;
    if (seenCurated.size + seenReference.size > 0) tally.withReference.prescriptionsWarned += 1;
    tally.curatedOnly.warnings += seenCurated.size;
    tally.withReference.warnings += seenCurated.size + seenReference.size;
    for (const k of new Set([...seenReference].map((s) => s.slice(s.indexOf("|") + 1)))) fired.set(k, (fired.get(k) ?? 0) + 1);
  }

  const n = rows.length;
  const rateCurated = n === 0 ? 0 : tally.curatedOnly.prescriptionsWarned / n;
  const rateWithReference = n === 0 ? 0 : tally.withReference.prescriptionsWarned / n;
  const ratio = rateCurated === 0 ? null : rateWithReference / rateCurated;
  return {
    since: window.since, until: window.until, prescriptions: n, ...tally, rateCurated, rateWithReference, ratio,
    moreThanDoubles: ratio === null ? rateWithReference > 0 : ratio > 2,
    topReferencePairs: [...fired.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([k, count]) => ({ note: reference.get(k)!.note, prescriptions: count })),
  };
}

/** How many live reference pairs are loaded — for the replay script's header. */
export async function countReferenceInteractions(db: Db): Promise<number> {
  const r = await db.select({ n: sql<number>`count(*)::int` }).from(formularyReferenceInteractions).where(isNull(formularyReferenceInteractions.retiredAt));
  return r[0]?.n ?? 0;
}
