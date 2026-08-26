import { and, gte, sql } from "drizzle-orm";
import { opdPrescriptions } from "../../kernel/db/schema";
import { listInteractionsAmong, resolveDrugTexts, resolveMedicines } from "./resolve";
import type { ResolvedDrug } from "./resolve";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 16a T8 — the curation loop: what the formulary does not yet know, and which warnings are
 * being clicked through.
 *
 * ═══ DD5 — THE THRESHOLD LIVES HERE AND NOWHERE ELSE ═══
 *
 * `noticeEnabled` is computed server-side and shipped as a BOOLEAN. The consult screen reads that
 * boolean and never sees this number, so there is exactly one place the policy can change and
 * exactly one place to look when somebody asks why the hint is off.
 */
export const COVERAGE_NOTICE_THRESHOLD = 0.8;

const COVERAGE_WINDOW_DAYS = 30;
const PAIR_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

type StoredLine = { drug: string; medicineId?: string | null };

export type Coverage = {
  coverage: number;
  noticeEnabled: boolean;
  /** The curation worklist: what the hospital prescribes that the formulary cannot resolve. */
  unresolvedTop: { drug: string; count: number }[];
};

async function resolveStoredLines(db: Db, lines: StoredLine[]): Promise<Map<StoredLine, ResolvedDrug | null>> {
  const ids = lines
    .map((l) => (typeof l.medicineId === "string" && l.medicineId !== "" ? l.medicineId : null))
    .filter((id): id is string => id !== null);
  const byId = ids.length > 0 ? await resolveMedicines(db, ids) : new Map<string, ResolvedDrug>();
  const byText = lines.length > 0
    ? await resolveDrugTexts(db, lines.map((l) => l.drug))
    : new Map<string, ResolvedDrug | null>();
  const out = new Map<StoredLine, ResolvedDrug | null>();
  for (const line of lines) {
    const id = typeof line.medicineId === "string" ? line.medicineId : null;
    const byIdHit = id === null || id === "" ? undefined : byId.get(id);
    out.set(line, byIdHit ?? byText.get(line.drug) ?? null);
  }
  return out;
}

/**
 * What share of the last thirty days' prescribed lines the formulary can resolve, and the
 * unresolved strings ranked by how often they were prescribed.
 *
 * THE PRESCRIBING STREAM IS THE WORKLIST (spec §1.2): coverage grows along the path of actual use
 * rather than by somebody trying to type an entire pharmacopoeia in. The pharmacist curates what
 * the hospital actually writes, most-frequent first.
 *
 * MEASURED AT KICKOFF (§3 Q4): the query is a sequential scan over `opd_prescriptions` with no
 * index available to it — 0.122 ms against a book of ONE prescription, which forecasts nothing.
 * It is computed directly rather than day-cached, and CLOSE records that the cache decision is
 * deferred to the first real-volume measurement rather than guessed at here.
 */
export async function getCoverage(db: Db, now: Date = new Date()): Promise<Coverage> {
  const since = new Date(now.getTime() - COVERAGE_WINDOW_DAYS * DAY_MS);
  const rows = await db
    .select({ lines: opdPrescriptions.lines })
    .from(opdPrescriptions)
    .where(gte(opdPrescriptions.issuedAt, since));

  const lines = rows.flatMap((row) => row.lines as StoredLine[]);
  if (lines.length === 0) {
    // NOT `noticeEnabled: true`. An empty book is not full coverage — it is no evidence at all, and
    // the hint must stay silent rather than fire on the first free-text line somebody writes.
    return { coverage: 0, noticeEnabled: false, unresolvedTop: [] };
  }

  const resolutions = await resolveStoredLines(db, lines);
  let resolved = 0;
  const unresolved = new Map<string, number>();
  for (const line of lines) {
    if (resolutions.get(line) !== null && resolutions.get(line) !== undefined) {
      resolved += 1;
      continue;
    }
    const key = line.drug.trim();
    if (key !== "") unresolved.set(key, (unresolved.get(key) ?? 0) + 1);
  }

  const coverage = resolved / lines.length;
  return {
    coverage,
    noticeEnabled: coverage >= COVERAGE_NOTICE_THRESHOLD,
    unresolvedTop: [...unresolved.entries()]
      .map(([drug, count]) => ({ drug, count }))
      .sort((a, b) => (b.count - a.count) || a.drug.localeCompare(b.drug))
      .slice(0, 20),
  };
}

export type PairUsage = {
  saltAId: string; saltBId: string;
  severity: "severe" | "moderate";
  note: string;
  /** Occurrences of this pair across prescriptions ISSUED in the window (in-rx pairs only). */
  timesOnIssued: number;
  /**
   * How many of those occurrences were cleared by an override.
   *
   * FOR A SEVERE PAIR THIS EQUALS `timesOnIssued`, STRUCTURALLY — the issue gate refuses a severe
   * hit that no override covers, so a severe pair cannot appear on a stored prescription unless
   * somebody clicked through it. That is not a bug in the arithmetic; it is what the data can say.
   */
  timesOverridden: number;
  /** `timesOverridden / timesOnIssued`, or 0 when the pair never appeared. Read the caveat above. */
  overriddenShare: number;
};

/**
 * ═══ WHAT §1.4 ASKS FOR, WHAT THIS RETURNS, AND THE GAP BETWEEN THEM (CLOSE F22) ═══
 *
 * The spec wants *"a severe pair overridden 95% of the time is mis-graded and is training doctors
 * to click through"*. That rate needs a DENOMINATOR — how often the warning fired at all — and the
 * times it fired and the doctor changed the prescription instead of overriding **are recorded
 * nowhere**: a refused issue writes no row and emits no event, and the pre-check writes nothing by
 * design. So the honest rate is unavailable and this function does not fake one.
 *
 * What it returns instead is real and still actionable: **how many issued prescriptions carry each
 * pair**. A severe pair on forty issued prescriptions means forty click-throughs, which is the
 * signal a curator needs even without the ratio. `overriddenShare` is reported because a MODERATE
 * pair genuinely can appear without an override (it is a notice, never a gate), so the number is
 * not always 1 — but for severe pairs it is, and the field's own doc-comment says so rather than
 * leaving a curator to infer that 100% means something alarming.
 *
 * **The missing mechanism, named for whoever builds it:** an event appended when a hard warning
 * REFUSES an issue would supply the denominator and cost one `appendEvent` in the gate.
 */
export async function getPairOverrideRates(db: Db, now: Date = new Date()): Promise<PairUsage[]> {
  const since = new Date(now.getTime() - PAIR_WINDOW_DAYS * DAY_MS);
  const rows = await db
    .select({ lines: opdPrescriptions.lines, allergyOverrides: opdPrescriptions.allergyOverrides })
    .from(opdPrescriptions)
    .where(and(gte(opdPrescriptions.issuedAt, since), sql`true`));

  const counts = new Map<string, number>();
  for (const row of rows) {
    const lines = row.lines as StoredLine[];
    const resolutions = await resolveStoredLines(db, lines);
    const perLineSalts = lines.map((line) => resolutions.get(line)?.salts.map((s) => s.saltId) ?? []);
    const saltIds = perLineSalts.flat();
    if (saltIds.length < 2) continue;
    const pairs = await listInteractionsAmong(db, saltIds);
    if (pairs.length === 0) continue;
    const byKey = new Map(pairs.map((p) => [`${p.saltAId}|${p.saltBId}`, p]));

    // IN-RX pairs only. A prior-scope hit depended on what else the patient was taking THAT DAY,
    // which is not reconstructable from a stored prescription, and guessing at it would put a
    // number on this screen that nobody could check.
    const seen = new Set<string>();
    for (let j = 0; j < perLineSalts.length; j += 1) {
      for (let i = 0; i < j; i += 1) {
        for (const a of perLineSalts[j] ?? []) {
          for (const b of perLineSalts[i] ?? []) {
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            if (byKey.has(key)) seen.add(key);
          }
        }
      }
    }
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  if (counts.size === 0) return [];
  const allSalts = [...counts.keys()].flatMap((k) => k.split("|"));
  const pairs = await listInteractionsAmong(db, allSalts);
  return pairs
    .map((pair) => {
      const timesOnIssued = counts.get(`${pair.saltAId}|${pair.saltBId}`) ?? 0;
      // Severe: it could not be here without an override. Moderate: it was never gated.
      const timesOverridden = pair.severity === "severe" ? timesOnIssued : 0;
      return {
        saltAId: pair.saltAId, saltBId: pair.saltBId, severity: pair.severity, note: pair.note,
        timesOnIssued, timesOverridden,
        overriddenShare: timesOnIssued === 0 ? 0 : timesOverridden / timesOnIssued,
      };
    })
    .filter((row) => row.timesOnIssued > 0)
    .sort((a, b) => b.timesOnIssued - a.timesOnIssued);
}
