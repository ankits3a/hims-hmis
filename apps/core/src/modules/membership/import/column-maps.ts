import { MembershipError } from "../errors";

/**
 * PLAN 09 T5 — VERSIONED COLUMN MAPS FOR A PARTNER HOLDER-BOOK DROP.
 *
 * ═══ THERE IS NO POSITIONAL FALLBACK ANYWHERE IN THIS FILE, AND THAT IS THE WHOLE POINT ═══
 *
 * A partner re-exports its holder book from a system nobody here controls. Between one drop and
 * the next a column is renamed, two are transposed, one is added. A parser that answers "column 3
 * is the date of birth" survives every one of those changes and is WRONG after each of them,
 * silently — a phone number becomes a date of birth, and nothing in the pipeline can tell.
 *
 * So the map is identified by the SET of header names it declares, and every cell is then read BY
 * NAME. Two consequences, both deliberate:
 *
 *   · A TRANSPOSED DROP IMPORTS CORRECTLY. Swapping two columns does not change the set, and the
 *     values still land in the fields their own headers name.
 *   · AN UNRECOGNISED SET REFUSES THE WHOLE FILE, loudly, with the headers it got and the versions
 *     it knows — `import_columns_unknown`. It does not guess, and it does not import the prefix of
 *     the file it happened to understand.
 *
 * The catalogs themselves are DATA (DD3/O-9): a map names COLUMN HEADINGS, which are a fact about
 * a file format, and it names no partner, no plan code, no rate and no person.
 */

/** The canonical fields a drop can carry. Everything downstream speaks these, never a header. */
export type HolderBookField =
  | "partnerSaleRef"
  | "cardCode"
  | "planCode"
  | "holderName"
  | "holderPhone"
  | "validFrom"
  | "validTo"
  | "members"
  | "activatedAt";

export type ColumnMap = {
  readonly version: string;
  /** header text (already folded by `foldHeader`) → canonical field. Its KEY SET identifies the map. */
  readonly headers: Readonly<Record<string, HolderBookField>>;
};

/**
 * Headers are compared case- and space-insensitively, because a partner's export tool capitalises
 * its own columns differently on every release and that is not a change of format. Nothing else is
 * normalised: an underscore and a space are different headings, and pretending otherwise is how a
 * map starts matching a file it does not describe.
 */
export function foldHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * THE MAPS. Two versions ship, and the second one exists so that "versioned" is a property of the
 * code rather than a claim in a comment: v2 is a genuinely different drop shape from the same
 * partner class, and it carries an ACTIVATION column that v1 has not got.
 *
 * `activated_on` is O-6's instant — the kicker counts ACTIVATIONS, never sale dates — so a drop
 * that does not carry it leaves `activated_at` null rather than borrowing `valid_from`.
 */
export const HOLDER_BOOK_COLUMN_MAPS: readonly ColumnMap[] = [
  {
    version: "holder-book-v1",
    headers: {
      "partner_sale_ref": "partnerSaleRef",
      "card_code": "cardCode",
      "plan_code": "planCode",
      "holder_name": "holderName",
      "holder_phone": "holderPhone",
      "valid_from": "validFrom",
      "valid_to": "validTo",
      "members": "members",
    },
  },
  {
    version: "holder-book-v2",
    headers: {
      "sale ref": "partnerSaleRef",
      "card no": "cardCode",
      "plan": "planCode",
      "name": "holderName",
      "phone": "holderPhone",
      "start date": "validFrom",
      "end date": "validTo",
      "family": "members",
      "activated on": "activatedAt",
    },
  },
];

export const COLUMN_MAP_VERSIONS: readonly string[] = HOLDER_BOOK_COLUMN_MAPS.map((m) => m.version);

function setOf(values: readonly string[]): Set<string> {
  return new Set(values);
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Which map describes this header row?
 *
 * A REPEATED HEADING IS AN UNKNOWN SHAPE, not a near-miss. Set equality cannot see the difference
 * between `ref,ref,code` and `ref,code` on its own — the second `ref` collapses into the first —
 * and a file with two columns of the same name has no by-name reading at all. It is refused here,
 * before any map is tried, so the refusal names the real problem.
 *
 * `requested` pins a version explicitly (the operator knows which drop this is). It still has to
 * MATCH: naming a version does not license reading a file that version does not describe.
 */
export function resolveColumnMap(headerCells: readonly string[], requested?: string): ColumnMap {
  const folded = headerCells.map(foldHeader);
  const distinct = setOf(folded);
  if (distinct.size !== folded.length) {
    throw new MembershipError(
      "import_columns_unknown",
      "the header row repeats a column name, so no column can be read by name",
      { headers: folded, knownVersions: COLUMN_MAP_VERSIONS },
    );
  }

  const candidates =
    requested === undefined
      ? HOLDER_BOOK_COLUMN_MAPS
      : HOLDER_BOOK_COLUMN_MAPS.filter((m) => m.version === requested);
  if (requested !== undefined && candidates.length === 0) {
    throw new MembershipError(
      "import_columns_unknown",
      `no column map named "${requested}"`,
      { headers: folded, knownVersions: COLUMN_MAP_VERSIONS },
    );
  }

  for (const map of candidates) {
    if (sameSet(distinct, setOf(Object.keys(map.headers)))) return map;
  }
  throw new MembershipError(
    "import_columns_unknown",
    "this drop's column shape matches no known map — it will NOT be read by position",
    { headers: folded, knownVersions: requested === undefined ? COLUMN_MAP_VERSIONS : [requested] },
  );
}

/**
 * One data row, read BY NAME. The header row is passed in with it because that is the only thing
 * that says which cell is which — the index of a cell in this array means nothing on its own, and
 * this function is the only place in the import lane that ever sees an index.
 */
export function mapRow(
  map: ColumnMap,
  headerCells: readonly string[],
  cells: readonly string[],
): Partial<Record<HolderBookField, string>> {
  const out: Partial<Record<HolderBookField, string>> = {};
  headerCells.forEach((rawHeader, i) => {
    const field = map.headers[foldHeader(rawHeader)];
    if (field === undefined) return;
    const cell = cells[i];
    if (cell === undefined) return;
    const value = cell.trim();
    if (value !== "") out[field] = value;
  });
  return out;
}
