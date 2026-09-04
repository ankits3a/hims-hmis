import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Plan 11a / D14 — the drift pin between the SPA's dev proxy and the production edge.
 *
 * **READ THE 11g BLOCK AT THE FOOT OF THIS COMMENT FIRST.** The two paragraphs below describe the
 * world as it was until 2026-08-25 — twelve API prefixes mirrored between two files — and they are
 * kept because the legs they explain are still here and still doing that job. There is one prefix
 * now, and the reason is the whole point.
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
 * ~~The count in the first test is deliberate friction. A module that adds a prefix edits three
 * places in one commit: vite.config.ts, the Caddyfile, and that number.~~ **AMENDED 2026-08-25
 * (Plan 11g / DD1): there is exactly ONE prefix now and a new API module edits neither file, so
 * the friction has nothing left to buy. The count stays as a non-vacuity pin, not as friction.**
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
 *
 * ═══ PLAN 11g / DD1 — THE COLLISION NEITHER LIST COULD EVER HAVE SHOWN ═══
 *
 * Every leg above compares things that route API CALLS. The 2026-08-24 synthetic smoke test found
 * that 15 of the SPA's 20 screens did not load in a browser at all, because `router.tsx` declares
 * those screens on the SAME paths the `@api` matcher proxied — and the matcher is path-only, so a
 * browser GET of `/admin/users` was answered with the API's `{"statusCode":401}`. Three lists in
 * perfect agreement, one production outage, and this file green throughout.
 *
 * The fix is path-space separation: `/api/*` is the API, everything else is the application. That
 * changes what the legs below can honestly assert:
 *
 *   - the 11e leg's class — "a called prefix nothing proxies" — is now STRUCTURALLY IMPOSSIBLE,
 *     because every call goes through `lib/api.ts`'s single `fetch` under `API_BASE`, and
 *     `API_BASE` is the proxied prefix. So that leg is re-pointed: it pins the ONE DOOR (nothing
 *     else in `apps/web/src` calls `fetch`) and pins `API_BASE` against the Caddy matcher, which
 *     is what makes the impossibility true rather than asserted.
 *   - a NEW leg pins the SPA's own route table against the proxied prefixes. It is the leg that
 *     would have caught D1, and it fails on the pre-fix tree naming all fifteen dark screens.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const VITE_CONFIG = resolve(REPO_ROOT, "apps", "web", "vite.config.ts");
const CADDYFILE = resolve(REPO_ROOT, "docker", "prod", "Caddyfile");
const WEB_SRC = resolve(REPO_ROOT, "apps", "web", "src");
const ROUTER_TSX = resolve(WEB_SRC, "router.tsx");

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

/**
 * Every path the SPA's own route table declares, deduped and sorted. THROWS rather than returning
 * empty on a shape it does not recognise (§2.49) — a parser that finds no routes agrees with every
 * matcher ever written, which is the exact way this file's earlier legs could have passed
 * vacuously.
 *
 * The shape read is TanStack's `path: "/…"` property inside a `createRoute({ … })` call, which is
 * the single way a route path is declared anywhere in this app. `redirect({ to: "/…" })` uses
 * `to:` and is deliberately NOT matched: a redirect target is always itself a declared route.
 */
/**
 * `API_BASE`'s value, read out of `apps/web/src/lib/api.ts`. THROWS if the declaration is not
 * there in the shape this parser knows (§2.49) — a base path this file could not read is a base
 * path it must not silently treat as `""`.
 */
function spaApiBase(): string {
  const source = readFileSync(resolve(WEB_SRC, "lib", "api.ts"), "utf8");
  const match = /export const API_BASE = "(\/[^"]*)";/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error('lib/api.ts: no `export const API_BASE = "/…";` found — this parser is stale');
  }
  return match[1];
}

/**
 * Every non-test module under `apps/web/src` that calls `fetch(` directly, repo-relative to
 * `src/`. Exactly one is expected and it is the client itself; anything else has stepped around
 * `API_BASE`, the bearer token and the 401 handling at the same time.
 */
function fetchCallingModules(): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        if (/(?<![.\w])fetch\(/.test(readFileSync(full, "utf8"))) {
          hits.push(full.slice(WEB_SRC.length + 1).split("\\").join("/"));
        }
      }
    }
  };
  walk(WEB_SRC);
  return hits.sort();
}

function spaRoutePaths(source: string): string[] {
  const paths: string[] = [];
  for (const match of source.matchAll(/\bpath:\s*"(\/[^"]*)"/g)) {
    const path = match[1];
    if (path !== undefined) paths.push(path);
  }
  if (paths.length === 0) {
    throw new Error('router.tsx: no `path: "/…"` route declaration found — this parser is stale');
  }
  return [...new Set(paths)].sort();
}

describe("Caddyfile / vite dev-proxy parity (Plan 11a D14)", () => {
  const viteSource = readFileSync(VITE_CONFIG, "utf8");
  const caddySource = readFileSync(CADDYFILE, "utf8");
  const routerSource = readFileSync(ROUTER_TSX, "utf8");

  it("reads a non-vacuous prefix census out of the vite dev proxy", () => {
    const vite = viteProxyPrefixes(viteSource);
    expect(vite.length).toBeGreaterThan(0);
    // ONE key since Plan 11g / DD1 (it was twelve). `/ws` is no longer its own entry: the realtime
    // gateway rides `/api/ws` on the same key, with `ws: true`.
    expect(vite).toHaveLength(1);
    expect(vite).toEqual(["/api"]);
  });

  it("routes exactly those prefixes through Caddy — no more, no fewer", () => {
    expect(caddyProxyPrefixes(caddySource)).toEqual(viteProxyPrefixes(viteSource));
  });

  it("reverse-proxies the matcher it declares to api:3000", () => {
    expect(caddySource).toMatch(/handle\s+@api\s*\{[^}]*\breverse_proxy\s+api:3000\b/);
  });

  it("PLAN 11g — STRIPS the prefix it matched, so the API's own path space is unchanged", () => {
    // Without this the api container would receive `/api/billing` and answer 404 to everything,
    // while `/health`, the compose healthcheck, the Prometheus scrape and ~30 supertest e2e
    // suites would all still be written against the unprefixed path. The strip is what keeps the
    // prefix a fact about the ORIGIN rather than about the API.
    const [prefix] = caddyProxyPrefixes(caddySource);
    expect(caddySource).toMatch(
      new RegExp(`handle\\s+@api\\s*\\{[^}]*\\buri\\s+strip_prefix\\s+${prefix}\\b`),
    );
  });

  it("PLAN 11e/11g — every call goes through ONE door, and that door is what Caddy proxies", () => {
    const called = spaCalledPrefixes();
    // The census FIRST, before anything is compared (§2.49): a parser that found nothing would
    // satisfy every check below vacuously and for ever. `toBeGreaterThanOrEqual` rather than an
    // exact count since 11g — the exact number existed to force a Caddyfile edit, and there is no
    // longer a Caddyfile edit to force (DD1). It still fails on a parser that has gone silent.
    expect(called.length).toBeGreaterThanOrEqual(9);
    expect(called).toContain("/admin"); // 11e's surface — absent from both lists until 11e's close
    expect(called).toContain("/ops");   // Plan 11c's, absent since 11c shipped
    expect(called).toContain("/tariff");

    // THE ONE DOOR. `lib/api.ts` is the only module in the whole SPA that calls `fetch`, which is
    // what makes `API_BASE` total rather than a convention: a screen that reached for `fetch`
    // directly would bypass the prefix, the token header and the 401 handling in one line, and
    // in production its request would land on the SPA handler and come back as index.html/200.
    expect(fetchCallingModules()).toEqual(["lib/api.ts"]);

    // …and the door opens onto exactly what the edge proxies. Read from `lib/api.ts` — a third
    // source, independent of both the vite block and the Caddyfile (§3.42).
    expect(caddyProxyPrefixes(caddySource)).toContain(spaApiBase());
    expect(viteProxyPrefixes(viteSource)).toContain(spaApiBase());
  });
  /**
   * ═══ PLAN 11g / DD1 — THE LEG THAT WOULD HAVE CAUGHT THE SMOKE TEST'S D1 ═══
   *
   * Every leg above compares things that route API calls to each other. NONE of them can see the
   * collision that actually stopped the hospital: the SPA declares its SCREENS on the same paths
   * the edge proxies to the API. The matcher is path-only — no method, no `Accept` — so a browser
   * asking for `/admin/users` was handed the API's `{"statusCode":401}` and 15 of 20 screens were
   * dark in production while every test in this file was green.
   *
   * It cannot reproduce in dev, which is why it survived: the vite server resolves the same
   * collision the other way. So the pin has to be over the two FILES, not over a running system.
   */
  it("PLAN 11g — no SPA route falls inside a Caddy-proxied prefix (smoke-test D1)", () => {
    const routes = spaRoutePaths(routerSource);
    // The census FIRST, before anything is compared (§2.49). 24 since Plan 09 T8 added the channel
    // P&L screen, on top of T7's partner receivables desk, T5's holder-book reconcile queue and
    // T3's card recognition screen (§6.0 S11 — this file joins the Files list of every task that
    // moves the number, and the waves are sequential so four tasks touching one integer cannot
    // collide). MEASURED, not predicted: the previous value 23 was observed failing with
    // `Received length: 24` before it was moved.
    // PLAN 16a T7 — 25 with the formulary desk. This file joins the Files list of every task that
    // moves the number, and the number moved BY EXECUTION rather than by prediction: the verify run
    // that added `/formulary/admin` failed here with `Received length: 25` against the pinned 24,
    // which is the friction working exactly as its docstring promises.
    // PLAN 14 T9 / DD16 — 28 with the three materials screens (items, vendors, the GRN gate). The
    // number moved BY EXECUTION rather than by prediction, exactly as the paragraph above records
    // for 16a: the verify run that added them failed here with `Received length: 28` against 25.
    // PLAN 15 T8 — 32 with the mini-OT's four routes (list, book, the per-case cockpit, recovery).
    // The number moved BY EXECUTION rather than by prediction, exactly as the two paragraphs above
    // record for 16a and 14: the run that added them failed here with `Received length: 32`
    // against the pinned 28.
    // PLAN 07b T3 — 33 with the counter, the one screen a single-staffer desk works a walk-in on.
    // The number moved BY EXECUTION rather than by prediction, exactly as the paragraphs above
    // record for 16a, 14 and 15: the run that added it failed here with `Received length: 33`
    // against the pinned 32.
    // PLAN 07c T4 — 34 with `/my-day`, the person's own day: read it, print it, export it. `/` was
    // ALREADY in this census and stays at one entry — it stopped being a `throw redirect` and
    // became a component, which changes what the route DOES and not how many there are. The number
    // moved BY EXECUTION rather than by prediction, exactly as the paragraphs above record for 16a,
    // 14, 15 and 07b: the run that added `/my-day` failed here with `Received length: 34` against
    // the pinned 33.
    // PLAN 07c T9 — 35 with `/staff`, the supervisor's named-staff view (DD14: what, not whom).
    // The number moved BY EXECUTION rather than by prediction, as every paragraph above records:
    // the run that added it failed here with `Received length: 35` against the pinned 34.
    // PLAN 17b T8 — 39 with the laboratory's four (desk, collection, bench, verify-and-report).
    // MEASURED by running this file against the tree that carries them, which is what every
    // paragraph above means by "by execution": the parser was re-run and it counted 39. Unlike the
    // five phases above, the pin was raised in the same edit as the routes rather than after
    // watching it fail — so the evidence here is the passing run, and it is stated as such rather
    // than as a failure this session did not observe.
    // PLAN 18a T9 — 44 with imaging's five (reception, worklist, the study console, the report, and
    // the Form F). The number moved BY EXECUTION and this one WAS watched failing, unlike 17b's:
    // the run that added the routes reported `Received length: 44` against the pinned 39, which is
    // the friction working exactly as this file's docstring promises. Two of the five carry a NAV
    // entry; the other three are reached from a study, and `/pcpndt/form-f/$studyId` is unlisted on
    // purpose — a list of Form F rows is a list of pregnant women by name.
    // RC-3 T5 / D1 — 45 with `/counter/seat`, Desk One: the registration seat, mounted BESIDE
    // `/counter` rather than instead of it for exactly one phase, so that a proven money path and
    // an unproven layout are never in the same diff and a reviewer can tell which half a defect
    // came from. RC-4 deletes one of the two and the number comes back to 44. The pin was raised in
    // the same edit as the route rather than after watching it fail — like 17b's and unlike 18a's —
    // so the evidence is the passing run, stated as such rather than as a failure not observed.
    // VD-2 T1 / D1 — 46 with `/opd/vitals/bay`, Bay One: the vitals desk beside `/opd/vitals`, the
    // registration seat's pattern. The old screen's deletion is an owner item and brings it to 45.
    // FD-1 T4 / D4 — 47 with `/counter/seat/figures`, the clerk's own account inside the seat.
    // PLAN 17c T5 — 47 -> 48: the laboratory's report centre, `/lab/reports`. Joined in the same
    // edit as the route, per the rule above.
    // PLAN 16c T5 — 48 -> 50: /pharmacy/counter and /pharmacy/items.
    // FD-2 + FD-5 / THE OWNER'S RULING — 50 -> 48. Two screens deleted, each replaced by the design
    // that superseded it: `/counter/seat` is gone because the seat serves `/counter`, and
    // `/opd/vitals/bay` is gone because Bay One serves `/opd/vitals`. "Keep the new design not the
    // old one." `/counter/seat/figures` also became `/counter/figures` — a rename, net zero.
    // FD-7 T2 — 48 -> 49 with `/appointment`, the front desk's appointment SEAT. It is a NEW route
    // rather than a section of `/registration` because the owner ruled the appointment out of the
    // registration form (03-Sep): registration ends at the UHID and hands over here, by permission.
    // The number was WATCHED FAILING — the run that added the route reported `Received length: 49`
    // against the pinned 48 — and raised to what was measured, never predicted.
    // FD-9 / THE OWNER'S RULING, 2026-09-03 — 49 -> 47. TWO ROUTES DELETED AND NONE ADDED, which is
    // the first time this number has gone DOWN for a reason other than a screen being superseded by
    // its own replacement. `/registration` and `/appointment` are gone because the three front-desk
    // routes were one person's one job: *"remove the old design.. Let's only focus on one user right
    // now. This user has access to registration, appointment and billing."* Desk One serves
    // `/counter` with all three as STAGES of one session. Deleted rather than redirected — a second
    // name for one screen is what put the owner on the wrong counter in FD-1.
    // MEASURED against the tree rather than predicted, which is what pinning a count is for.
    // PLAN 18c T1 — 49 -> 50 with `/radiology/radiation-safety`, the AERB register. ONE route for
    // five registers (D11): the inspector asks for the licences, the QA records, the dose register,
    // the badge readings and what is overdue, and they are five tabs of one screen because they are
    // one file. MEASURED against the tree, raised to what the run reported, never predicted.
    // FD-23 REBASE, 2026-09-04 — the two histories meet here: 18c's 50 minus FD-9's two deletions
    // is 48, and the number below is what the merged tree MEASURED, not what this arithmetic
    // predicted. `/radiology/radiation-safety` arrives from main; `/appointment` and
    // `/registration` leave with FD-9.
    expect(routes).toHaveLength(48);
    expect(routes).toContain("/radiology/radiation-safety");
    expect(routes).not.toContain("/appointment");
    expect(routes).not.toContain("/registration");
    expect(routes).toContain("/counter");
    expect(routes).toContain("/lab/reports");
    expect(routes).toContain("/counter/figures");
    expect(routes).not.toContain("/counter/seat");
    expect(routes).toContain("/opd/vitals");
    expect(routes).not.toContain("/opd/vitals/bay");
    expect(routes).toContain("/radiology/reception");
    expect(routes).toContain("/radiology/worklist");
    // The three parameterised ones too: a parameterised path is still a SPA path, and if
    // `/radiology` ever became a proxied prefix these are the legs that would catch it.
    expect(routes).toContain("/radiology/studies/$studyId");
    expect(routes).toContain("/radiology/studies/$studyId/report");
    expect(routes).toContain("/pcpndt/form-f/$studyId");
    expect(routes).toContain("/counter");
    expect(routes).toContain("/my-day");
    // `/staff`, not `/staff/$userId`: the subject is picked on the screen and never enters a URL,
    // so a staff member's id stays out of browser history and out of the access log.
    expect(routes).toContain("/staff");
    expect(routes).toContain("/ot/list");
    expect(routes).toContain("/ot/book");
    expect(routes).toContain("/ot/recovery");
    // The per-case route too — a parameterised path is still a SPA path, and if `/ot` ever became a
    // proxied prefix this is the leg that would catch it alongside the other three.
    expect(routes).toContain("/ot/cockpit/$caseId");
    expect(routes).toContain("/materials/items");
    expect(routes).toContain("/materials/vendors");
    expect(routes).toContain("/materials/grn");
    expect(routes).toContain("/admin/users");
    expect(routes).toContain("/counter/instruments");
    expect(routes).toContain("/counter/reconcile");
    expect(routes).toContain("/partners/receivables");
    expect(routes).toContain("/partners/pnl");
    /**
     * AND THE ONE THAT NEEDED THIS LEG MOST. `/formulary/admin` is a SPA screen, and `formulary` is
     * ALSO the API controller's prefix (`@Controller("formulary")`) — the exact shape of the
     * collision that left 15 screens dark in production. It is safe here only because Plan 11g/DD1
     * left exactly ONE proxied prefix and the API lives under it; the `shadowed` assertion below is
     * what proves that rather than this comment.
     */
    expect(routes).toContain("/formulary/admin");

    const proxied = caddyProxyPrefixes(caddySource);
    // NAME the shadowed routes rather than comparing lengths: "15 !== 0" does not tell an operator
    // which screens are dark.
    const shadowed = routes.filter((route) => proxied.some((p) => route === p || route.startsWith(p)));
    expect(shadowed).toEqual([]);
  });
});
