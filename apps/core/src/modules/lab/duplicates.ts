import { inArray } from "drizzle-orm";
import { findRecentItems } from "../../kernel/orders/read";
import { labOrderableAnalytes, labOrderables } from "../../kernel/db/schema";
// §4 — through the patients module's declared interface, never its internals. Both helpers
// are on that index already and `modules/membership/recognition.ts` uses the same pair the
// same way, for the same reason: the merge tree is the patients module's fact to answer.
import { listMergedLoserIds, resolvePatientId } from "../patients";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 17a T3 / DD1 — THE DUPLICATE DETECTOR, AND IT CLOSES TWO GAPS THE KERNEL NAMED IN ITS OWN
 * CONTRACT (phase 0 §6A.3 and §6A.4).
 *
 * Phase 0 shipped `findRecentItems` and wrote down, in as many words, what it cannot do:
 *
 *   · §6A.3 — *"it matches `service_id` EXACTLY, so it does not catch a duplicate inside a
 *     profile. 'Fever Profile' containing CBC, then a standalone CBC, are two different
 *     `service_id` values and the window sees neither from the other."*
 *   · §6A.4 — *"it also matches `patient_id` exactly, so it does not see across a pre-merge
 *     duplicate registration. It reads a patient ROW, not a person."*
 *
 * **Both are closed HERE rather than in the kernel, and that is the design.** The composition model
 * that knows a Fever Profile contains a CBC is the LAB's (`lab_orderable_analytes`), and the kernel
 * cannot be given it without the envelope learning what an analyte is. So the kernel answers "what
 * was ordered for this patient row" and the lab asks it the right questions.
 *
 * ═══ THE ORDER OF THE TWO EXPANSIONS IS LOAD-BEARING ═══
 *
 * The merge chain is resolved FIRST, then the analyte overlap, and only then is the window queried —
 * once per DISTINCT candidate orderable per patient in the chain, never once per requested item
 * (see the note above that loop). Doing it the other way — expanding services, then merges —
 * produces the same set but re-resolves the chain per service, which is N round-trips for one fact
 * about a person.
 */

/** Every orderable that shares at least one analyte with `serviceId`, INCLUDING itself. */
export async function overlappingAnalytes(
  exec: Db | Tx,
  serviceIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (serviceIds.length === 0) return out;

  const mine = await (exec as Db)
    .select({ serviceId: labOrderableAnalytes.serviceId, analyteId: labOrderableAnalytes.analyteId })
    .from(labOrderableAnalytes)
    .where(inArray(labOrderableAnalytes.serviceId, [...serviceIds]));

  const analyteIds = [...new Set(mine.map((r) => r.analyteId))];
  if (analyteIds.length === 0) {
    for (const id of serviceIds) out.set(id, [id]);
    return out;
  }

  // Everything that carries any of those analytes — the reverse direction of the same join.
  const theirs = await (exec as Db)
    .select({ serviceId: labOrderableAnalytes.serviceId, analyteId: labOrderableAnalytes.analyteId })
    .from(labOrderableAnalytes)
    .where(inArray(labOrderableAnalytes.analyteId, analyteIds));

  const byAnalyte = new Map<string, string[]>();
  for (const row of theirs) {
    byAnalyte.set(row.analyteId, [...(byAnalyte.get(row.analyteId) ?? []), row.serviceId]);
  }
  for (const serviceId of serviceIds) {
    const own = mine.filter((r) => r.serviceId === serviceId).map((r) => r.analyteId);
    const siblings = new Set<string>([serviceId]);
    for (const a of own) for (const s of byAnalyte.get(a) ?? []) siblings.add(s);
    out.set(serviceId, [...siblings]);
  }
  return out;
}

export type DuplicateWarning = {
  /** The orderable the desk is about to place. */
  serviceId: string;
  /** The EXISTING item it duplicates — what `origin:'duplicate_confirmed'` points at if placed. */
  duplicateOfItemId: string;
  duplicateOfOrderNo: string;
  /** The orderable that item was: the SAME code, or the profile that contains it. */
  matchedServiceId: string;
  placedAt: Date;
  /** Rendered for the counter: "CBC was ordered 20 h ago inside Fever Profile (L2608280014)". */
  reason: string;
};

/**
 * ═══ THE WINDOW, AND FINDING F1: `lab_orderables` HAS NO COLUMN FOR IT ═══
 *
 * 17a §5 T3 says *"window from the catalogue (default 24 h; troponin 6 h — 02 D11)"*, and T1's
 * thirteen tables carry no `duplicate_window_hours`. The phase document's §2 row 1 rules that a
 * needed column is **a plan defect to REPORT, not a migration to write**, so it is reported: the
 * default is a constant here and the one clinical exception 02 D11 states is a named map beside it.
 *
 * **This is a stopgap and it is labelled as one.** A repeat troponin at three hours is clinically
 * normal and a repeat CT the same day is not — that is per-ORDERABLE knowledge, it belongs in the
 * row a curator edits, and a code constant means changing it needs a deploy. The proper fix is one
 * nullable `duplicate_window_hours` column, which whichever phase next writes a lab migration should
 * carry. Until then this map is small, visible and reviewable, which a silent 24 h for a troponin
 * would not be.
 */
const DEFAULT_WINDOW_HOURS = 24;
const WINDOW_BY_CODE: Readonly<Record<string, number>> = {
  /**
   * 02 D11 — a troponin is repeated deliberately at 3 and 6 hours to read the CURVE. Warning about
   * the previous one would train the ward to click through the warning that matters.
   *
   * **THE KEY IS THE ORDERABLE'S CODE, NOT THE ANALYTE'S**, and the first version of this map got
   * that wrong: it was keyed `TROP_I`/`TROP_T`, which are the ANALYTES, while `windowFor` looks up
   * `lab_orderables.code` — so every troponin silently fell back to the 24 h default and a repeat
   * at four hours was flagged as a duplicate. Caught by the test that exists for this rule, which
   * is the only reason it is not shipping: nothing about the code READ wrong.
   */
  TROPI: 6,
  TROPT: 6,
  CARDIAC: 6,
};

/**
 * WARN THE DESK ABOUT WHAT THIS PATIENT ALREADY HAS ON ORDER.
 *
 * The patient id is resolved through the merge chain HERE rather than trusted from the caller: a
 * desk holding a pre-merge id is exactly the case §6A.4 describes, and it is the case where a
 * warning matters most — the same test ordered twice under two registrations of one person is a
 * double charge nobody notices, because the two records look unrelated.
 *
 * It returns findings, never a refusal. **The clinician decides**, and proceeding stores
 * `duplicate_of_item_id` + a reason on the new item (`origin:'duplicate_confirmed'`), which is what
 * billing's "post once" rule reads and what a later audit reads to see that somebody chose.
 */
export async function duplicateWarnings(
  exec: Db | Tx,
  actor: Actor,
  patientId: string,
  serviceIds: readonly string[],
  now: Date = new Date(),
): Promise<DuplicateWarning[]> {
  if (serviceIds.length === 0) return [];

  // (1) THE PERSON, not the row. `resolvePatientId` follows the merge chain to the winner; the
  //     losers are searched too, because their orders keep their original `patient_id`.
  const canonical = (await resolvePatientId(exec, patientId)) ?? patientId;
  const chain = [canonical, ...(await listMergedLoserIds(exec, canonical))];

  // (2) THE COMPOSITION. Each requested orderable expands to every orderable sharing an analyte.
  const overlap = await overlappingAnalytes(exec, serviceIds);
  const candidatesOf = new Map<string, string[]>();
  for (const serviceId of serviceIds) candidatesOf.set(serviceId, overlap.get(serviceId) ?? [serviceId]);

  // (3) NAMES AND WINDOWS, in ONE read over every orderable on either side of the comparison.
  const everyService = [...new Set([...serviceIds, ...[...candidatesOf.values()].flat()])];
  const rows = await (exec as Db)
    .select({ serviceId: labOrderables.serviceId, code: labOrderables.code, nameEn: labOrderables.nameEn })
    .from(labOrderables)
    .where(inArray(labOrderables.serviceId, everyService));
  const named = new Map(rows.map((r) => [r.serviceId, r] as const));
  const windowFor = (serviceId: string): number =>
    WINDOW_BY_CODE[named.get(serviceId)?.code ?? ""] ?? DEFAULT_WINDOW_HOURS;

  /**
   * ═══ ONE QUERY PER (DISTINCT CANDIDATE × PATIENT IN CHAIN), NOT PER REQUESTED ITEM ═══
   *
   * `findRecentItems` takes ONE `service_id`, so a naive triple loop asks the same question about
   * the same orderable once for every requested item that overlaps it. A five-item order against a
   * profile sharing twenty analytes is 200 round-trips **at a counter, while a patient waits**
   * (E48 sizes this desk at 900 orders/day). Collapsing to the DISTINCT candidate set makes it ~25,
   * and the mapping back to the requesting orderable happens in memory below.
   *
   * The kernel could answer this in ONE query if `findRecentItems` took an array of service ids. It
   * is not widened here — that is a kernel edit this phase is not permitted (§8) — and 17a §6
   * records it as the optimisation the first caller who measures a slow desk should ask for.
   */
  const distinctCandidates = [...new Set([...candidatesOf.values()].flat())];
  const hitsByCandidate = new Map<string, Awaited<ReturnType<typeof findRecentItems>>>();
  for (const candidate of distinctCandidates) {
    // The WIDEST window any requester of this candidate asks for; each requester's own narrower
    // window is applied to the shared result set below, against each hit's real age.
    const widest = Math.max(
      ...serviceIds.filter((s) => (candidatesOf.get(s) ?? []).includes(candidate)).map(windowFor),
    );
    const found: Awaited<ReturnType<typeof findRecentItems>> = [];
    for (const pid of chain) found.push(...await findRecentItems(exec, actor, pid, candidate, widest, now));
    hitsByCandidate.set(candidate, found);
  }

  const warnings: DuplicateWarning[] = [];
  const seen = new Set<string>();
  for (const serviceId of serviceIds) {
    const windowMs = windowFor(serviceId) * 3_600_000;
    for (const candidate of candidatesOf.get(serviceId) ?? []) {
      for (const hit of hitsByCandidate.get(candidate) ?? []) {
        // A troponin's 6 h does not become 24 because a CBC in the same basket asked for a wider
        // window — the shared query is an optimisation, never a widening of anybody's rule.
        if (now.getTime() - hit.placedAt.getTime() > windowMs) continue;
        // One warning per (requested orderable, existing item): the same item reached through two
        // shared analytes is one duplicate, not two, and a counter shown it twice stops reading.
        const key = `${serviceId} ${hit.itemId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const mineName = named.get(serviceId)?.code ?? serviceId;
        const theirName = named.get(candidate)?.nameEn ?? candidate;
        const hours = Math.round((now.getTime() - hit.placedAt.getTime()) / 3_600_000);
        warnings.push({
          serviceId,
          duplicateOfItemId: hit.itemId,
          duplicateOfOrderNo: hit.orderNo,
          matchedServiceId: candidate,
          placedAt: hit.placedAt,
          reason: candidate === serviceId
            ? `${mineName} was ordered ${String(hours)} h ago (${hit.orderNo})`
            : `${mineName} was ordered ${String(hours)} h ago inside ${theirName} (${hit.orderNo})`,
        });
      }
    }
  }
  return warnings;
}
