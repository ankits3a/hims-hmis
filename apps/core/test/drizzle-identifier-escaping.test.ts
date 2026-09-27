import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WASA M-08 — GHSA-gpj5-g38j-94v9 (CVE-2026-39356): DRIZZLE DID NOT ESCAPE A QUOTE IN AN IDENTIFIER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `PgDialect.escapeName` wrapped a name in double quotes without doubling the quotes inside it, so
 * an identifier carrying `"` closed itself and the rest ran as SQL. Upstream fixed it in 0.45.2 with
 * one line. This tree runs 0.40.1 and does NOT take 0.45 in this change: from 0.44 drizzle wraps
 * every driver error in `DrizzleQueryError` (the pg error moves to `.cause`, the message becomes the
 * SQL plus its PARAMETERS), which breaks every `code === "23505"` refusal in the modules and would
 * put patient data into error logs. So the one line is back-ported as a pnpm patch
 * (`patches/drizzle-orm@0.40.1.patch`) and the advisory is exempted from `pnpm audit` — and this
 * file is what keeps both honest.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const GHSA = "GHSA-gpj5-g38j-94v9";

describe("M-08 — a drizzle identifier cannot close its own quotes", () => {
  const dialect = new PgDialect();

  it("doubles an embedded double quote, as Postgres's own quote_ident does", () => {
    expect(dialect.escapeName('a"b')).toBe('"a""b"');
    expect(dialect.escapeName("patients")).toBe('"patients"');
  });

  it("an injected identifier stays ONE identifier in the rendered statement", () => {
    const hostile = 'x"; DROP TABLE patients; --';
    const q = dialect.sqlToQuery(sql`select 1 from ${sql.identifier(hostile)}`);
    expect(q.sql).toBe('select 1 from "x""; DROP TABLE patients; --"');
  });

  it("the audit exemption lives exactly as long as the back-port it stands for", () => {
    const root = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      pnpm?: { auditConfig?: { ignoreGhsas?: string[] }; patchedDependencies?: Record<string, string> };
    };
    const installed = (JSON.parse(
      readFileSync(resolve(REPO_ROOT, "apps", "core", "node_modules", "drizzle-orm", "package.json"), "utf8"),
    ) as { version: string }).version;
    const [major, minor, patch] = installed.split(".").map(Number) as [number, number, number];
    const fixedUpstream = major > 0 || minor > 45 || (minor === 45 && patch >= 2);
    const exempted = root.pnpm?.auditConfig?.ignoreGhsas?.includes(GHSA) ?? false;
    // Upstream fixed: the exemption and the patch are stale, and a stale exemption hides a RE-regression.
    // Not fixed upstream: the exemption is only honest while the installed version carries the patch.
    expect({ installed, exempted, patched: root.pnpm?.patchedDependencies?.[`drizzle-orm@${installed}`] !== undefined })
      .toEqual({ installed, exempted: !fixedUpstream, patched: !fixedUpstream });
  });
});
