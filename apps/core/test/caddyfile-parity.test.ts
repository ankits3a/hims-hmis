import { readFileSync } from "node:fs";
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
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const VITE_CONFIG = resolve(REPO_ROOT, "apps", "web", "vite.config.ts");
const CADDYFILE = resolve(REPO_ROOT, "docker", "prod", "Caddyfile");

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

describe("Caddyfile / vite dev-proxy parity (Plan 11a D14)", () => {
  const viteSource = readFileSync(VITE_CONFIG, "utf8");
  const caddySource = readFileSync(CADDYFILE, "utf8");

  it("reads a non-vacuous prefix census out of the vite dev proxy", () => {
    const vite = viteProxyPrefixes(viteSource);
    expect(vite.length).toBeGreaterThan(0);
    expect(vite).toHaveLength(9);
    expect(vite).toContain("/ws");
  });

  it("routes exactly those prefixes through Caddy — no more, no fewer", () => {
    expect(caddyProxyPrefixes(caddySource)).toEqual(viteProxyPrefixes(viteSource));
  });

  it("reverse-proxies the matcher it declares to api:3000", () => {
    expect(caddySource).toMatch(/handle\s+@api\s*\{[^}]*\breverse_proxy\s+api:3000\b/);
  });
});
