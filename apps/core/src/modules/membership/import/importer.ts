import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import {
  coveredMembers, holderBookImports, membershipInstances, membershipPlans,
} from "../../../kernel/db/schema";
import { appendEvent } from "../../../kernel/events/append";
import { withTx } from "../../../kernel/db/client";
import { holderBookImported } from "../events";
import { mapRow, resolveColumnMap } from "./column-maps";
import { enqueueMatches, findPatientCandidates } from "./match-queue";
import { primaryReason, quarantineRows } from "./quarantine";
import type { ColumnMap, HolderBookField } from "./column-maps";
import type { MatchCandidate } from "./match-queue";
import type { QuarantineReason } from "./quarantine";
import type { Db, Tx } from "../../../kernel/db/client";

/**
 * PLAN 09 T5 — THE HOLDER-BOOK IMPORT.
 *
 * A partner sends a file of the people it has sold cards to. Nothing about that file is trustworthy
 * except that somebody paid for each of its rows, so the whole lane is built around one question:
 * what does this importer do when the file is WRONG?
 *
 * ═══ THE FIVE ANSWERS, EACH RULED RATHER THAN CHOSEN HERE ═══
 *
 * 1. IDEMPOTENCY IS ON THE PARTNER'S OWN SALE REFERENCE, `(counterparty_id, partner_sale_ref)` —
 *    never on the card number. A partner REISSUES a card number to a different holder, so keying on
 *    it makes the second sale look like the first one arriving twice and the new holder's card
 *    never lands. The card code carries an ordinary index for exactly this reason and the schema's
 *    own header says so. The FILE HASH is a second guard behind it, not the key: `(counterparty_id,
 *    file_hash)` is unique so a re-sent drop is RECOGNISED and reported rather than re-read.
 *
 * 2. A DUPLICATE KEY WITHIN ONE DROP QUARANTINES BOTH ROWS. Never last-wins — see `quarantine.ts`,
 *    which carries the argument.
 *
 * 3. A FUZZY PATIENT MATCH NEVER AUTO-LINKS. It becomes a queue row for a human — see
 *    `match-queue.ts`.
 *
 * 4. OVER-CAP COVERED MEMBERS ARE HONOURED TO THE CAP, IN THE FILE'S OWN ROW ORDER, AND THE
 *    OVERFLOW IS RECORDED (O-5). The row is NOT quarantined: the member paid, the overflow is the
 *    partner's clerical error, and quarantining the row would convert that error into the
 *    hospital's refusal — a paying family invisible at the counter. Loud, never silent: the
 *    overflow lands on `membership_instances.cap_overflow` with its own provenance and in the
 *    reconcile queue.
 *
 * 5. AN UNKNOWN COLUMN SHAPE REFUSES THE WHOLE FILE. There is no positional fallback anywhere —
 *    see `column-maps.ts`.
 *
 * ═══ EVERY PRODUCED ROW CARRIES ITS PROVENANCE ═══
 *
 * `import_id` and `import_row_no` on the instance, `source_row_no` on each covered member, the
 * verbatim source line on each quarantine row. Dispute forensics is the entire point: when a
 * partner says "we sent you that member", the answer has to be a file, a line number and the text
 * of the line — not a recollection.
 *
 * NOTE FOR ANYONE ASSERTING THAT INVARIANT (§3.43): `membership_instances` has a SECOND production
 * writer. `recognition.ts`'s O-1 grace-honor path inserts with `origin = 'grace'` and NO import id,
 * correctly — no import produced it. The invariant is therefore scoped: **every instance with
 * `origin = 'import'` carries `import_id` and `import_row_no`.**
 *
 * ═══ THE FILE IS PARSED TO COMPLETION BEFORE ANYTHING IS WRITTEN ═══
 *
 * `modules/billing/recon.ts`'s shape, for its reason: a malformed drop must not leave half a
 * partner's book in the database. The whole import is one transaction, so a failure late in the
 * file leaves neither instances nor quarantine rows behind.
 */

// ─────────────────────────────── parsing ───────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The member list separator. A comma cannot be one: the file is comma-delimited (`recon.ts`). */
const MEMBER_SEP = "|";
/** `Name:relation` — the relation is optional and the hospital does not act on it. */
const MEMBER_RELATION_SEP = ":";

export type ParsedMember = { name: string; relation: string | null };

export type ParsedRow = {
  /** 1-indexed and matching what a text editor shows: the header is line 1. */
  rowNo: number;
  /** The source line, verbatim — what a quarantine row keeps. */
  line: string;
  fields: Partial<Record<HolderBookField, string>>;
  reasons: QuarantineReason[];
  partnerSaleRef: string;
  cardCode: string;
  planCode: string;
  holderName: string;
  holderPhone: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  activatedAt: Date | null;
  members: ParsedMember[];
};

export type ParsedHolderBook = { map: ColumnMap; headerCells: string[]; rows: ParsedRow[] };

function parseDate(raw: string | undefined): Date | null {
  if (raw === undefined || !DATE_RE.test(raw)) return null;
  const at = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

function parseMembers(raw: string | undefined): ParsedMember[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(MEMBER_SEP)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const cut = entry.indexOf(MEMBER_RELATION_SEP);
      if (cut < 0) return { name: entry, relation: null };
      const name = entry.slice(0, cut).trim();
      const relation = entry.slice(cut + 1).trim();
      return { name, relation: relation === "" ? null : relation };
    })
    .filter((m) => m.name !== "");
}

/**
 * Parses the whole drop. Throws only for the FILE-level refusal (`import_columns_unknown`); every
 * ROW-level defect becomes a reason on that row and is decided later, because a drop is not
 * worthless just because line 40 is malformed.
 */
export function parseHolderBook(csv: string, requestedVersion?: string): ParsedHolderBook {
  const lines = csv.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === "") {
    // An empty file has no header, so it has no column shape — the same refusal, not a new one.
    return { map: resolveColumnMap([], requestedVersion), headerCells: [], rows: [] };
  }
  const headerCells = headerLine.split(",").map((h) => h.trim());
  const map = resolveColumnMap(headerCells, requestedVersion);

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue; // a blank line inside the file is tolerated, never a data row
    const rowNo = i + 1;
    const cells = line.split(",").map((c) => c.trim());
    const reasons: QuarantineReason[] = [];
    if (cells.length < headerCells.length) reasons.push("short_row");

    const fields = mapRow(map, headerCells, cells);
    const partnerSaleRef = fields.partnerSaleRef ?? "";
    const cardCode = fields.cardCode ?? "";
    const planCode = fields.planCode ?? "";
    const holderName = fields.holderName ?? "";
    if (partnerSaleRef === "" || cardCode === "" || planCode === "" || holderName === "") {
      reasons.push("missing_required");
    }

    const validFrom = parseDate(fields.validFrom);
    const validTo = parseDate(fields.validTo);
    const activatedAt = parseDate(fields.activatedAt);
    if (validFrom === null || validTo === null) reasons.push("bad_date");
    else if (validTo.getTime() < validFrom.getTime()) reasons.push("inverted_validity");
    if (fields.activatedAt !== undefined && activatedAt === null) reasons.push("bad_date");

    rows.push({
      rowNo, line, fields, reasons,
      partnerSaleRef, cardCode, planCode, holderName,
      holderPhone: fields.holderPhone ?? null,
      validFrom, validTo, activatedAt,
      members: parseMembers(fields.members),
    });
  }
  return { map, headerCells, rows };
}

/**
 * IN-DROP DUPLICATES — the sale reference exactly, and the card code case-insensitively.
 *
 * WITHIN ONE DROP ONLY, and that boundary is what makes rules 1 and 2 above compatible. Across
 * drops the card code is EXPECTED to repeat (a reissue) and only the sale reference is a key.
 * Inside one file, two rows claiming the same card are two rows the partner cannot both have meant,
 * whatever their sale references say — so both go, exactly as if they had shared a sale reference.
 *
 * Case-insensitive on the card because a card number is read off a plastic card by a human and
 * "km-70" and "KM-70" are the same card; the sale reference is the partner's own machine key and is
 * compared exactly, because folding somebody else's key space is an assumption we cannot check.
 */
export function inDropDuplicateRowNos(rows: readonly ParsedRow[]): Set<number> {
  const dup = new Set<number>();
  const mark = (buckets: Map<string, number[]>): void => {
    for (const rowNos of buckets.values()) {
      if (rowNos.length > 1) for (const n of rowNos) dup.add(n);
    }
  };
  const bySaleRef = new Map<string, number[]>();
  const byCard = new Map<string, number[]>();
  for (const row of rows) {
    if (row.partnerSaleRef !== "") {
      bySaleRef.set(row.partnerSaleRef, [...(bySaleRef.get(row.partnerSaleRef) ?? []), row.rowNo]);
    }
    if (row.cardCode !== "") {
      const key = row.cardCode.toLowerCase();
      byCard.set(key, [...(byCard.get(key) ?? []), row.rowNo]);
    }
  }
  mark(bySaleRef);
  mark(byCard);
  return dup;
}

// ─────────────────────────────── the import ───────────────────────────────

export type HolderBookImportInput = {
  counterpartyId: string;
  fileName: string;
  csv: string;
  /** Pin the drop's map explicitly. It still has to match: naming a version licenses nothing. */
  columnMapVersion?: string;
};

export type ImportQuarantineReport = { rowNo: number; reason: QuarantineReason };
export type ImportQueueReport = { rowNo: number; instanceId: string; reason: string };

export type HolderBookImportResult = {
  importId: string;
  counterpartyId: string;
  fileName: string;
  fileHash: string;
  columnMapVersion: string;
  /** The re-sent file. `rowsAccepted` is 0 and this says why — the drop is not read a second time. */
  alreadyImported: boolean;
  rowsTotal: number;
  rowsAccepted: number;
  rowsQuarantined: number;
  /** Rows whose sale reference this counterparty already carries — recognised, never duplicated. */
  rowsAlreadyApplied: number;
  instanceIds: string[];
  quarantined: ImportQuarantineReport[];
  queued: ImportQueueReport[];
};

export function holderBookFileHash(csv: string): string {
  return createHash("sha256").update(csv, "utf8").digest("hex");
}

type PreparedRow = {
  row: ParsedRow;
  instanceId: string;
  planId: string;
  candidates: MatchCandidate[];
};

async function loadPlanIdsByCode(exec: Db | Tx, codes: readonly string[]): Promise<Map<string, { id: string; familyCap: number }>> {
  if (codes.length === 0) return new Map();
  const rows = await exec
    .select({ id: membershipPlans.id, code: membershipPlans.code, familyCap: membershipPlans.familyCap })
    .from(membershipPlans)
    .where(inArray(membershipPlans.code, [...codes]));
  return new Map(rows.map((r) => [r.code, { id: r.id, familyCap: r.familyCap }]));
}

/** Internal marker for the racing-upload branch below; never escapes this module. */
class AlreadyImported extends Error {
  constructor() {
    super("this drop was imported by a concurrent upload");
    this.name = "AlreadyImported";
  }
}

/**
 * Imports one drop. One transaction, all of it.
 *
 * THE COUNTERPARTY IS NOT VALIDATED HERE, and that is a disclosed gap rather than an oversight: the
 * closed `MembershipErrorCode` union carries no unknown-counterparty code (T1 owns that file and it
 * is closed for the phase), so the `holder_book_imports.counterparty_id` foreign key is the refusal.
 * It is a database error rather than a typed one; the route surfaces it as a 500 and the operator
 * sees the constraint's own name.
 */
export async function importHolderBook(
  db: Db,
  actor: Actor,
  input: HolderBookImportInput,
  now: Date = new Date(),
): Promise<HolderBookImportResult> {
  const fileHash = holderBookFileHash(input.csv);

  // Parsed to completion BEFORE any write, and before the re-send check, so a re-sent file whose
  // shape we no longer understand still refuses loudly rather than reporting a cheerful no-op.
  const parsed = parseHolderBook(input.csv, input.columnMapVersion);
  const rowsTotal = parsed.rows.length;

  const already = await db
    .select({ id: holderBookImports.id })
    .from(holderBookImports)
    .where(and(eq(holderBookImports.counterpartyId, input.counterpartyId), eq(holderBookImports.fileHash, fileHash)));
  const priorImport = already[0];
  if (priorImport !== undefined) {
    return {
      importId: priorImport.id,
      counterpartyId: input.counterpartyId,
      fileName: input.fileName,
      fileHash,
      columnMapVersion: parsed.map.version,
      alreadyImported: true,
      rowsTotal,
      rowsAccepted: 0,
      rowsQuarantined: 0,
      rowsAlreadyApplied: rowsTotal,
      instanceIds: [],
      quarantined: [],
      queued: [],
    };
  }

  const importId = newId();
  const duplicates = inDropDuplicateRowNos(parsed.rows);
  const planIndex = await loadPlanIdsByCode(db, [...new Set(parsed.rows.map((r) => r.planCode).filter((c) => c !== ""))]);

  // Which sale references does this counterparty already carry? Read BEFORE the loop: one query
  // instead of one per row, and the unique index is still the guard behind it.
  const refs = parsed.rows.map((r) => r.partnerSaleRef).filter((r) => r !== "");
  const existingRefs = new Set(
    refs.length === 0
      ? []
      : (
          await db
            .select({ ref: membershipInstances.partnerSaleRef })
            .from(membershipInstances)
            .where(
              and(
                eq(membershipInstances.counterpartyId, input.counterpartyId),
                inArray(membershipInstances.partnerSaleRef, [...new Set(refs)]),
              ),
            )
        ).map((r) => r.ref),
  );

  const quarantine: { rowNo: number; reason: QuarantineReason; line: string }[] = [];
  const prepared: PreparedRow[] = [];
  let rowsAlreadyApplied = 0;

  for (const row of parsed.rows) {
    const reasons = [...row.reasons];
    if (duplicates.has(row.rowNo)) reasons.push("duplicate_key");
    const plan = planIndex.get(row.planCode);
    if (reasons.length === 0 && plan === undefined) reasons.push("unknown_plan");
    if (reasons.length > 0) {
      quarantine.push({ rowNo: row.rowNo, reason: primaryReason(reasons), line: row.line });
      continue;
    }
    if (existingRefs.has(row.partnerSaleRef)) {
      rowsAlreadyApplied += 1;
      continue;
    }
    // The candidate scan is a READ and is done before the transaction opens: it is the slowest
    // thing in the loop and holding a write transaction open across it would serialise the whole
    // import behind a trigram scan per row.
    prepared.push({
      row,
      instanceId: newId(),
      planId: plan!.id,
      candidates: await findPatientCandidates(db, row.holderName),
    });
  }

  const queued: ImportQueueReport[] = [];

  let racedByAnotherUpload = false;
  try {
    await withTx(db, async (tx) => {
      const claimed = await tx
        .insert(holderBookImports)
        .values({
          id: importId,
          counterpartyId: input.counterpartyId,
          fileName: input.fileName,
          fileHash,
          columnMapVersion: parsed.map.version,
          rowsTotal,
          rowsAccepted: prepared.length,
          rowsQuarantined: quarantine.length,
          importedBy: actor.id,
          startedAt: now,
          finishedAt: now,
        })
        .onConflictDoNothing({ target: [holderBookImports.counterpartyId, holderBookImports.fileHash] })
        .returning({ id: holderBookImports.id });
      if (claimed.length === 0) {
        // Another operator uploaded the same drop while this one was parsing. Nothing has been
        // written yet, so there is nothing to undo — the reporting branch above is the answer.
        throw new AlreadyImported();
      }

      const enqueue: { instanceId: string; memberId?: string | null; reason: "fuzzy_match" | "cap_overflow"; candidates: MatchCandidate[]; note?: string }[] = [];

      for (const p of prepared) {
        const cap = planIndex.get(p.row.planCode)!.familyCap;
        /**
         * MEMBER 1 IS THE HOLDER, and the drop's own `members` list continues from 2. The cap is
         * therefore a count of PEOPLE the plan covers, which is what a family cap means to the
         * person who bought it — and it makes the honoured set decidable from the file alone, in
         * the file's order, so two imports of the same drop honour the same people (O-5).
         */
        const people = [
          { name: p.row.holderName, relation: null as string | null, phone: p.row.holderPhone },
          ...p.row.members.map((m) => ({ name: m.name, relation: m.relation, phone: p.row.holderPhone })),
        ];
        const overflow = people
          .map((person, i) => ({ ...person, memberNo: i + 1 }))
          .filter((person) => person.memberNo > cap);

        await tx.insert(membershipInstances).values({
          id: p.instanceId,
          planId: p.planId,
          counterpartyId: input.counterpartyId,
          cardCode: p.row.cardCode,
          // NEVER LINKED BY THE IMPORTER (E3). A candidate becomes a queue row below.
          patientId: null,
          holderName: p.row.holderName,
          holderPhone: p.row.holderPhone,
          validFrom: p.row.validFrom!,
          validTo: p.row.validTo!,
          // What the PARTNER said: this card is sold and not cancelled. Whether it is usable TODAY
          // is derived from the validity window at recognition time, which is the one clock in the
          // money path (O-2) — a second opinion stamped here would drift the moment it was stored.
          status: "active",
          origin: "import",
          // C-17: a row from the partner's own book IS the verification a grace-honored instance
          // waits for. `origin='grace' + verified=false` is the pair that means "not yet in the book".
          verified: true,
          partnerSaleRef: p.row.partnerSaleRef,
          importId,
          importRowNo: p.row.rowNo,
          capOverflow:
            overflow.length === 0
              ? null
              : {
                  cap,
                  covered: people.length,
                  // WITH ITS PROVENANCE (O-5): which people, at which member numbers, from which line.
                  overflow: overflow.map((o) => ({ memberNo: o.memberNo, name: o.name, sourceRowNo: p.row.rowNo })),
                },
          activatedAt: p.row.activatedAt,
          createdAt: now,
        });

        await tx.insert(coveredMembers).values(
          people.map((person, i) => ({
            id: newId(),
            instanceId: p.instanceId,
            memberNo: i + 1,
            name: person.name,
            relation: person.relation,
            phone: person.phone,
            patientId: null,
            // O-5 — the overflow is RECORDED, never dropped. `honoured = false` is the flag the
            // counter reads; the row exists so a human can see who the partner meant to cover.
            honoured: i + 1 <= cap,
            sourceRowNo: p.row.rowNo,
            addedAt: now,
          })),
        );

        if (p.candidates.length > 0) {
          enqueue.push({ instanceId: p.instanceId, reason: "fuzzy_match", candidates: p.candidates });
          queued.push({ rowNo: p.row.rowNo, instanceId: p.instanceId, reason: "fuzzy_match" });
        }
        if (overflow.length > 0) {
          enqueue.push({
            instanceId: p.instanceId,
            reason: "cap_overflow",
            candidates: [],
            note: `${String(people.length)} covered members declared against a cap of ${String(cap)}`,
          });
          queued.push({ rowNo: p.row.rowNo, instanceId: p.instanceId, reason: "cap_overflow" });
        }
      }

      await enqueueMatches(tx, enqueue);
      await quarantineRows(
        tx,
        quarantine.map((q) => ({ source: "holder_book" as const, batchId: importId, rowNo: q.rowNo, reason: q.reason, line: q.line })),
      );

      await appendEvent(
        tx,
        holderBookImported.make({
          actor,
          occurredAt: now,
          payload: {
            importId,
            counterpartyId: input.counterpartyId,
            fileName: input.fileName,
            columnMapVersion: parsed.map.version,
            rowsTotal,
            rowsAccepted: prepared.length,
            rowsQuarantined: quarantine.length,
            rowsAlreadyApplied,
          },
        }),
      );
    });
  } catch (e) {
    // The concurrent-upload branch above. Nothing was written — the transaction rolled back —
    // so the answer is the same one a re-sent file gets: zero new rows, and it says so.
    if (!(e instanceof AlreadyImported)) throw e;
    racedByAnotherUpload = true;
  }

  if (racedByAnotherUpload) {
    const won = await db
      .select({ id: holderBookImports.id })
      .from(holderBookImports)
      .where(and(eq(holderBookImports.counterpartyId, input.counterpartyId), eq(holderBookImports.fileHash, fileHash)));
    return {
      importId: won[0]?.id ?? importId,
      counterpartyId: input.counterpartyId,
      fileName: input.fileName,
      fileHash,
      columnMapVersion: parsed.map.version,
      alreadyImported: true,
      rowsTotal,
      rowsAccepted: 0,
      rowsQuarantined: 0,
      rowsAlreadyApplied: rowsTotal,
      instanceIds: [],
      quarantined: [],
      queued: [],
    };
  }

  return {
    importId,
    counterpartyId: input.counterpartyId,
    fileName: input.fileName,
    fileHash,
    columnMapVersion: parsed.map.version,
    alreadyImported: false,
    rowsTotal,
    rowsAccepted: prepared.length,
    rowsQuarantined: quarantine.length,
    rowsAlreadyApplied,
    instanceIds: prepared.map((p) => p.instanceId),
    quarantined: quarantine.map((q) => ({ rowNo: q.rowNo, reason: q.reason })),
    queued,
  };
}
