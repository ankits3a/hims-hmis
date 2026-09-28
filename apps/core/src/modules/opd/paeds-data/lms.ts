/**
 * ═══ COLE'S LMS METHOD, AS THE WHO COMPUTES IT (01-CONSULT-ENGINE.md §6.2) ═══
 *
 * A growth reference is three smooth curves against age: L (the Box-Cox power), M (the median) and
 * S (the coefficient of variation). A measurement y at that age has
 *
 *     z = ((y / M)^L − 1) / (L · S)           (L ≠ 0)
 *     z = ln(y / M) / S                         (L = 0)
 *
 * THE WHO's RESTRICTED Z-SCORE. For weight-for-age and BMI-for-age (skewed indicators, L ≠ 1) the
 * WHO does not trust the LMS curve beyond ±3 SD, where the Box-Cox tail compresses the distances.
 * Beyond +3 it measures in units of the 2→3 SD distance instead:
 *
 *     z = 3 + (y − SD3pos) / (SD3pos − SD2pos)    and symmetrically below −3.
 *
 * Source of the method: WHO Multicentre Growth Reference Study Group. WHO Child Growth Standards:
 * Length/height-for-age, weight-for-age, weight-for-length, weight-for-height and body mass
 * index-for-age: Methods and development. Geneva: WHO, 2006 — chapter "Computation of centiles and
 * z-scores"; and the WHO's reference implementation, `anthro` (R), `compute_zscore_adjusted`:
 * https://github.com/WorldHealthOrganization/anthro/blob/master/R/z-score-helper.R
 * Length/height-for-age and head circumference-for-age use the plain formula (the WHO's `anthro`
 * passes `compute_zscore` for both).
 *
 * This file holds no reference values — only the arithmetic. Every table is its own data file.
 */

export type LmsRow = readonly [l: number, m: number, s: number];
export type LmsTable = { source: string; boys: readonly LmsRow[]; girls: readonly LmsRow[] };
export type Sex = "boy" | "girl";

/** The plain LMS z-score. */
export function lmsZ(y: number, [l, m, s]: LmsRow): number {
  if (l === 0) return Math.log(y / m) / s;
  return (Math.pow(y / m, l) - 1) / (l * s);
}

/** The measurement at a given z — the centile curve. */
export function lmsValueAt(z: number, [l, m, s]: LmsRow): number {
  if (l === 0) return m * Math.exp(s * z);
  return m * Math.pow(1 + l * s * z, 1 / l);
}

/** The WHO's restricted z-score (weight-for-age, BMI-for-age): beyond ±3 SD, the 2→3 SD distance is the unit. */
export function lmsZRestricted(y: number, row: LmsRow): number {
  const z = lmsZ(y, row);
  if (z > 3) {
    const sd3 = lmsValueAt(3, row);
    return 3 + (y - sd3) / (sd3 - lmsValueAt(2, row));
  }
  if (z < -3) {
    const sd3 = lmsValueAt(-3, row);
    return -3 + (y - sd3) / (lmsValueAt(-2, row) - sd3);
  }
  return z;
}

/** The row for an age in completed days, or null outside the table. */
export function rowAt(table: LmsTable, sex: Sex, ageDays: number): LmsRow | null {
  const rows = sex === "boy" ? table.boys : table.girls;
  if (!Number.isInteger(ageDays) || ageDays < 0 || ageDays >= rows.length) return null;
  return rows[ageDays] ?? null;
}

/**
 * The standard normal CDF — the centile a z-score stands for. W. J. Cody's rational Chebyshev
 * approximation of erfc (Math. Comp. 1969;23:631-7), accurate to about 1e-14; far past the
 * one decimal a centile is shown to.
 */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

function erfc(x: number): number {
  const ax = Math.abs(x);
  let r: number;
  if (ax < 0.5) {
    const t = x * x;
    const top = (((0.185777706184603153 * t + 3.16112374387056560) * t + 113.864154151050156) * t + 377.485237685302021) * t + 3209.37758913846947;
    const bot = (((t + 23.6012909523441209) * t + 244.024637934444173) * t + 1282.61652607737228) * t + 2844.23683343917062;
    return 1 - x * top / bot;
  }
  if (ax < 4) {
    const top = (((((((2.15311535474403846e-8 * ax + 0.564188496988670089) * ax + 8.88314979438837594) * ax + 66.1191906371416295) * ax
      + 298.635138197400131) * ax + 881.952221241769090) * ax + 1712.04761263407058) * ax + 2051.07837782607147) * ax + 1230.33935479799725;
    const bot = (((((((ax + 15.7449261107098347) * ax + 117.693950891312499) * ax + 537.181101862009858) * ax + 1621.38957456669019) * ax
      + 3290.79923573345963) * ax + 4362.61909014324716) * ax + 3439.36767414372164) * ax + 1230.33935480374942;
    r = Math.exp(-ax * ax) * top / bot;
  } else {
    const z = 1 / (ax * ax);
    const top = ((((0.0163153871373020978 * z + 0.305326634961232344) * z + 0.360344899949804439) * z + 0.125781726111229246) * z + 0.0160837851487422766) * z + 6.58749161529837803e-4;
    const bot = ((((z + 2.56852019228982242) * z + 1.87295284992346725) * z + 0.527905102951428412) * z + 0.0605183413124413191) * z + 0.00233520497626869185;
    r = Math.exp(-ax * ax) / ax * (0.564189583547756287 - z * top / bot);
  }
  return x < 0 ? 2 - r : r;
}
