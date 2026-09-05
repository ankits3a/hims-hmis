import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — `SCHEME_CARD_KEYS` IS A COPY OF THE SERVER'S CARD KEYS, AND NOTHING PINNED IT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `desk.tsx` holds `new Set(["membership.schemes", "billing.panels", "partners.attribution"])` and
 * uses it twice: once to REMOVE those cards from the ordinary grid, and once to harvest their stats
 * into the schemes rail. It is a hand-written duplicate of a fact that lives in three server files,
 * and it had five occurrences in the screen and ZERO in any test.
 *
 * ═══ WHY THE FAILURE IS SILENT, WHICH IS THE WHOLE POINT ═══
 *
 * A fourth scheme provider — anybody adding a `desk.schemes.<something>.n` stat — is not in the
 * Set. So its card is NOT filtered out of the ordinary grid, and the grid renders it with the
 * server's `titleKey`, `desk.schemes.title`... which is a real key, so it looks fine. Meanwhile its
 * stats are not harvested into the rail, and the FIVE `desk.schemes.*.n` labels have no locale
 * leaves at all, so the tile prints a raw key at the counter.
 *
 * Every suite stays green throughout. There is no assertion anywhere that connects the client's Set
 * to the providers' card keys, which is exactly the class this lane keeps paying for: two correct
 * halves and nothing checking they agree.
 *
 * ═══ THE RULE, DERIVED RATHER THAN LISTED ═══
 *
 * A "scheme card" is not a name on a list — it is a card whose stats are `desk.schemes.*`. That is
 * the property the screen actually depends on, so it is the property this test derives from the
 * server source, and it is why adding a fourth provider makes this test fail rather than the
 * counter print a key.
 */
const MODULES = join(__dirname, "../../../core/src/modules");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (entry.endsWith("desk-provider.ts")) out.push(full);
  }
  return out;
}

/**
 * The card key a `desk.schemes.*` stat belongs to. A provider file declares `key: "<card>"` and then
 * its stats; the card key immediately preceding a scheme stat is the one that owns it.
 */
function schemeCardKeys(): { keys: string[]; files: string[] } {
  const files = sourceFiles(MODULES);
  const keys = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("desk.schemes.")) continue;
    /* Every `key: "x.y"` in order, then every `desk.schemes.` stat, matched by position. */
    const cardKeys = [...source.matchAll(/^\s*key: "([a-z_]+\.[a-z_]+)",/gm)];
    for (const stat of source.matchAll(/key: "desk\.schemes\.[a-z_]+\.n"/g)) {
      const owner = [...cardKeys].reverse().find((c) => (c.index ?? 0) < (stat.index ?? 0));
      if (owner !== undefined) keys.add(owner[1]!);
    }
  }
  return { keys: [...keys].sort(), files: files.map((f) => relative(MODULES, f)) };
}

/** The Set as `desk.tsx` actually spells it — read from the screen, not retyped. */
function clientSchemeCardKeys(): string[] {
  const source = readFileSync(join(__dirname, "desk.tsx"), "utf8");
  const block = /const SCHEME_CARD_KEYS = new Set\(\[([^\]]*)\]\)/.exec(source);
  if (block === null) {
    throw new Error("could not find SCHEME_CARD_KEYS in desk.tsx — the parser, not the screen, is out of date");
  }
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
}

describe("the desk's scheme cards: the client's Set is the server's card keys", () => {
  const { keys, files } = schemeCardKeys();

  it("found the provider files and the scheme cards in them", () => {
    /* The guard on the guard — a parser that matches nothing would pass this file forever. */
    expect(files.length).toBeGreaterThan(3);
    expect(keys.length).toBeGreaterThan(2);
  });

  /**
   * THIS IS THE ASSERTION. A fourth provider emitting `desk.schemes.*` fails here, with its card key
   * named, instead of printing a raw locale key at a counter with three suites green.
   */
  it("names exactly the cards whose stats are desk.schemes.*", () => {
    expect(clientSchemeCardKeys()).toEqual(keys);
  });
});
