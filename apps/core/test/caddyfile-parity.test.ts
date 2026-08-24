import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Plan 11a / D14 — the drift pin between the SPA's dev proxy and the production edge.
 *
 * The API path prefixes exist in exactly one place today: `apps/web/vite.config.ts`'s dev proxy.
 * Production serves the same origin through Caddy, so `docker/prod/Caddyfile` has to mirror that
 * list forever. Without a pin the drift is silent and one-directional — a module adds a prefix to
 * vite, works perfectly in dev, and in production its calls fall through to the SPA handler and
 * come back as index.html with HTTP 200. One enforcement point beats a convention.
 *
 * §2.49 — THIS TEST CAN PASS VACUOUSLY AND MUST NOT: two parsers that both return [] agree with
 * each other forever. Three things prevent it. Both parsers THROW rather than return empty on a
 * shape they do not recognise; the first test pins the vite side to a known census (nine
 * prefixes, `/ws` among them) BEFORE anything is compared; and the last test proves the matcher
 * the Caddyfile declares is actually the one it proxies, so a matcher nothing uses cannot pass.
 *
 * The count in the first test is deliberate friction. A module that adds a prefix edits three
 * places in one commit: vite.config.ts, the Caddyfile, and that number.
 *
 * ═══ PLAN 11e CLOSE — A THIRD SOURCE, BECAUSE TWO LISTS AGREED ABOUT NOTHING ═══
 *
 * The pin above compares vite to Caddy. It cannot see a prefix that is in NEITHER — and three
 * were: `/admin` (11e's own user-administration surface), `/ops` (Plan 11c's operating-mode and
 * downtime-kit screens, one letter from the proxied `/opd`, which is why it survived review) and
 * `/tariff` (the billing counter's service picker). All three shipped green through this test,
 * `pnpm verify` and CI, and in production every one of their calls fell through to the SPA handler
 * and came back as index.html with HTTP 200 — the precise failure mode the docstring above
 * describes, arriving through the one door the pin does not watch.
 *
 * The fourth test reads the prefixes the SPA ACTUALLY CALLS out of `apps/web/src/lib/*.ts`. That
 * source is independent of both lists, which is what §3.42's closing move requires: a leg must
 * read something that is not the thing under test. Direction is deliberate — called ⊆ proxied. A
 * proxied prefix nothing calls yet is harmless (`/approvals`, `/workflow`, `/health` are proxied
 * and reached by no `src/lib` client today); a called prefix nothing proxies is an outage.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const VITE_CONFIG = resolve(REPO_ROOT, "apps", "web", "vite.config.ts");
const CADDYFILE = resolve(REPO_ROOT, "docker", "prod", "Caddyfile");
const WEB_SRC = resolve(REPO_ROOT, "apps", "web", "src");

/** The keys of vite's `server.proxy` object, sorted. Throws if the block cannot be found. */
function viteProxyPrefixes(source: string): string[] {
  const start = source.indexOf("proxy: {");
  if (start < 0) {
    throw new Error("vite.config.ts: no `proxy: {` block found — this parser is stale");
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    throw new Error("vite.config.ts: the `proxy: {` block is never closed — this parser is stale");
  }
  const prefixes: string[] = [];
  for (const match of source.slice(open, end).matchAll(/^\s*"(\/[^"]*)"\s*:/gm)) {
    const key = match[1];
    if (key !== undefined) prefixes.push(key);
  }
  if (prefixes.length === 0) {
    throw new Error('vite.config.ts: the proxy block declares no "/…" keys — this parser is stale');
  }
  return prefixes.sort();
}

/** The paths of the Caddyfile's `@api` matcher, `*` stripped, sorted. Throws if it is absent. */
function caddyProxyPrefixes(source: string): string[] {
  const line = /^[ \t]*@api[ \t]+path[ \t]+(.+)$/m.exec(source);
  if (line === null) {
    throw new Error("Caddyfile: no `@api path …` matcher line found — this parser is stale");
  }
  const prefixes: string[] = [];
  for (const token of (line[1] ?? "").trim().split(/[ \t]+/)) {
    if (token === "") continue;
    if (!token.startsWith("/") || !token.endsWith("*")) {
      throw new Error(`Caddyfile: @api token ${token} is not a /prefix* path matcher`);
    }
    prefixes.push(token.slice(0, -1));
  }
  if (prefixes.length === 0) {
    throw new Error("Caddyfile: the @api matcher lists no paths");
  }
  return prefixes.sort();
}

/**
 * Every first path segment the SPA requests, sorted and deduped. THROWS rather than returning
 * empty on a tree it does not recognise (§2.49), because a parser that silently finds nothing
 * agrees with every proxy list ever written.
 *
 * IT WALKS THE WHOLE OF `apps/web/src`, NOT JUST `lib/`, and that is a correctness point rather
 * than thoroughness: `/patients` is requested from screen files and appears in no client module,
 * so a parser scoped to `lib/` would have declared it uncalled and let a real prefix go dark.
 * Test files are excluded — `lib/api.test.ts` calls `/patients` against a stub and would make the
 * census pass for a prefix the product never requests.
 *
 * The shape read is `api("METHOD", "/prefix…")`, string and template literal alike, which is the
 * single way `lib/api.ts` is invoked anywhere in this app.
 */
function spaCalledPrefixes(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(WEB_SRC);
  if (files.length === 0) {
    throw new Error("apps/web/src holds no non-test .ts/.tsx modules — this parser is stale");
  }
  const prefixes = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8")
      .matchAll(/"(?:GET|POST|PUT|PATCH|DELETE)",\s*[`"](\/[a-z-]+)/g)) {
      const prefix = match[1];
      if (prefix !== undefined) prefixes.add(prefix);
    }
  }
  if (prefixes.size === 0) {
    throw new Error(
      "no api(\"METHOD\", \"/prefix\") call was found in apps/web/src — this parser is stale",
    );
  }
  return [...prefixes].sort();
}

describe("Caddyfile / vite dev-proxy parity (Plan 11a D14)", () => {
  const viteSource = readFileSync(VITE_CONFIG, "utf8");
  const caddySource = readFileSync(CADDYFILE, "utf8");

  it("reads a non-vacuous prefix census out of the vite dev proxy", () => {
    const vite = viteProxyPrefixes(viteSource);
    expect(vite.length).toBeGreaterThan(0);
    expect(vite).toHaveLength(12);
    expect(vite).toContain("/ws");
  });

  it("routes exactly those prefixes through Caddy — no more, no fewer", () => {
    expect(caddyProxyPrefixes(caddySource)).toEqual(viteProxyPrefixes(viteSource));
  });

  it("reverse-proxies the matcher it declares to api:3000", () => {
    expect(caddySource).toMatch(/handle\s+@api\s*\{[^}]*\breverse_proxy\s+api:3000\b/);
  });

  it("PLAN 11e — every prefix the SPA actually CALLS is proxied, which two lists could not see", () => {
    const called = spaCalledPrefixes();
    // The census FIRST, before anything is compared (§2.49): a parser that found nothing would
    // satisfy the subset check vacuously and for ever.
    expect(called).toHaveLength(9);
    expect(called).toContain("/admin"); // 11e's surface — absent from both lists until this commit
    expect(called).toContain("/ops");   // Plan 11c's, absent since 11c shipped
    expect(called).toContain("/tariff");

    const proxied = viteProxyPrefixes(viteSource);
    // NAME the offenders rather than comparing lengths: "3 !== 0" does not tell an operator which
    // screen is dark in production.
    expect(called.filter((prefix) => !proxied.includes(prefix))).toEqual([]);
  });
});
