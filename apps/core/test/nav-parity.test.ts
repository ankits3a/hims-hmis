import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";

/**
 * PLAN 14 CLOSE, SECOND-PASS FINDING F1 — **THE SPA's NAVIGATION TABLE AGAINST THE MANIFESTS IT
 * SAYS IT COPIES.**
 *
 * ═══ THE INVARIANT WAS STATED IN BOTH FILES AND GUARDED BY NEITHER ═══
 *
 * `apps/web/src/router.tsx` opens its `NAV` table with *"The strings match the `menu` entries the
 * server's module manifests declare, which is where the authoritative pairing lives … this table is
 * the client's copy of that pairing and nothing more."* `materials/manifest.ts` says the same thing
 * from the other side: *"Each path matches `apps/web/src/router.tsx`'s own route exactly … so the
 * permission-gated link and the screen it opens cannot drift apart."*
 *
 * **They drifted, in the commit that was fixing a defect about exactly this.** Close review M6
 * moved the GRN entry from `materials.grn.capture` to `materials.stock.read` in the manifest and in
 * the controller, so DD11's QC signatory could reach the GRN it is ruled to sign. `router.tsx` —
 * the table the shell actually renders — was not moved with them. The server said yes; the
 * pharmacist still had no link; the remediation's commit message said the menu entry had moved.
 * The second-pass reviewer found it, and found it in one grep, because **nothing in the repository
 * compared these two lists.**
 *
 * That is §2.122's lesson with the roles reversed: not a comment that names a test which does not
 * exist, but a comment that names an INVARIANT no test asserts. Both are claims a reader believes.
 *
 * ═══ WHY THIS LIVES IN `apps/core` AND READS `apps/web` AS TEXT ═══
 *
 * The authoritative half is `ALL_MANIFESTS`, which is core's; the copy is web's. A test in `apps/web`
 * would have to import from `apps/core` across a package boundary that does not exist, and — more
 * to the point — it would fail in the package that is CORRECT. The `caddyfile-parity.test.ts`
 * precedent parses this very file's route table from a core test for the same reason, and
 * `membership/guardrails.test.ts` reads web screen sources as text. This is that discipline, one
 * table over.
 *
 * ═══ WHAT IS AND IS NOT ASSERTED ═══
 *
 * Only entries whose PATH appears in both lists are compared, and the permission is what is
 * compared. `NAV` legitimately carries entries no manifest declares (`/` and the login shell's own
 * links are not module menus), and a manifest may legitimately declare a menu entry for a screen
 * the SPA has not mounted yet — `materialsManifest` shipped exactly that for seven commits by
 * design. **A path in both lists with two different permissions is never legitimate**: it means the
 * link the shell shows and the authority the server records disagree about who this screen is for.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const ROUTER_TSX = resolve(REPO_ROOT, "apps", "web", "src", "router.tsx");

/**
 * The `{ to, label, permission }` rows of `router.tsx`'s `NAV`.
 *
 * **Scoped to the `NAV` array and not to the whole file**, because `router.tsx` also declares route
 * objects with a `path`, and a file-wide regex would mix the two. §2.49: it THROWS rather than
 * returning `[]`, so a parser that has gone stale fails loudly instead of asserting nothing — the
 * failure mode that let the original defect through was silence, and a vacuous guard is silence
 * with a green tick on it.
 */
function navEntries(source: string): { to: string; permission: string }[] {
  const start = source.indexOf("const NAV:");
  if (start < 0) throw new Error("router.tsx: no `const NAV:` table — this parser is stale");
  const end = source.indexOf("];", start);
  if (end < 0) throw new Error("router.tsx: `const NAV:` is not terminated — this parser is stale");
  const block = source.slice(start, end);

  const rows: { to: string; permission: string }[] = [];
  /**
   * PLAN 07b T8 — the trailing `[^}]*` is new, and it was bought by this parser THROWING.
   *
   * The pattern used to require `permission` to be the LAST field of the object, so adding a third
   * one (`group`, for the nav's section headings) made every entry stop matching and the census
   * came back empty. The guard did exactly what §2.49 built it to do — it threw "parsed to zero
   * entries" rather than reporting no drift over a list it had failed to read, which is the silent
   * false green this file exists to prevent. `[^}]*` cannot cross a `}`, so widening it keeps the
   * match bounded to one object literal and cannot pair a path with a neighbour's permission.
   */
  for (const m of block.matchAll(/\{\s*to:\s*"([^"]+)"[^}]*?permission:\s*"([^"]+)"[^}]*\}/g)) {
    rows.push({ to: m[1] as string, permission: m[2] as string });
  }
  if (rows.length === 0) {
    throw new Error("router.tsx: NAV parsed to zero entries — this parser is stale");
  }
  return rows;
}

/** Every `menu` entry every installed manifest declares, as `path → permission`. */
function manifestMenu(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of ALL_MANIFESTS) {
    for (const entry of m.menu ?? []) out.set(entry.path, entry.permission);
  }
  if (out.size === 0) throw new Error("ALL_MANIFESTS declared no menu entries — this parser is stale");
  return out;
}

describe("SPA navigation ↔ module manifest parity (Plan 14 close, F1)", () => {
  const nav = navEntries(readFileSync(ROUTER_TSX, "utf8"));
  const menu = manifestMenu();

  it("reads a NON-VACUOUS census from both sides", () => {
    // Pinned before anything is compared (§2.49). If either census collapses, every assertion
    // below would pass on an empty intersection — which is how this invariant went unguarded.
    expect(nav.length).toBeGreaterThan(15);
    expect(menu.size).toBeGreaterThan(15);
    const shared = nav.filter((n) => menu.has(n.to));
    expect(shared.length).toBeGreaterThan(15);
  });

  it("every path in BOTH lists carries the SAME permission — the client's copy cannot drift", () => {
    const drift = nav
      .filter((n) => menu.has(n.to))
      .filter((n) => menu.get(n.to) !== n.permission)
      .map((n) => ({ path: n.to, router: n.permission, manifest: menu.get(n.to) }));
    /**
     * On the tree this test was written against, before `router.tsx:92` was corrected, this read:
     *   [{ path: "/materials/grn", router: "materials.grn.capture", manifest: "materials.stock.read" }]
     * — one row, and it is a role locked out of a screen it was ruled to sign.
     */
    expect({ drift }).toEqual({ drift: [] });
  });

  /**
   * The materials three, named explicitly rather than left to the general rule above.
   *
   * A general assertion over an intersection can be satisfied by an empty intersection, and these
   * are the entries a close review has already found wrong once. Naming them costs three lines and
   * survives a refactor of the parser.
   */
  it("the three materials entries pair as DD11 and DD16 rule them", () => {
    const byPath = new Map(nav.map((n) => [n.to, n.permission]));
    expect({
      items: byPath.get("/materials/items"),
      vendors: byPath.get("/materials/vendors"),
      // `stock.read`, NOT `grn.capture`: the GRN screen LISTS and CAPTURES, DD8 puts those in two
      // different hands, and the menu carries the weaker of the two so the QC signatory has a way
      // in at all. The DD16 deviation is recorded in `materials/manifest.ts`.
      grn: byPath.get("/materials/grn"),
    }).toEqual({
      items: "materials.items.manage",
      vendors: "materials.vendors.manage",
      grn: "materials.stock.read",
    });
  });
});
