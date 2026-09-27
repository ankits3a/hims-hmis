import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WASA M-04 + L-09 — WHAT THE EDGE WRITES DOWN, AND WHAT IT SAYS ABOUT ITSELF
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * M-04 was measured, not supposed: on caddy:2-alpine v2.11.4 a request carrying `X-Agent-Key` and
 * `X-Totp-Code` was written to `/data/logs/access.log` with both values in the clear, because
 * Caddy's built-in redaction covers `Authorization` and `Cookie` and nothing else. The fix is a
 * `format filter` in the `log` block — and a filter is exactly the kind of thing a later edit
 * drops without noticing, because the site keeps working perfectly with it gone.
 *
 * So the redaction list is NOT typed into this test. It is DERIVED from the API's own source:
 * every request header a guard or controller reads (`req.headers["…"]`, `headers.authorization`,
 * `@Headers("…")`) must be redacted in the log. A new credential header added to the app without a
 * matching line in the Caddyfile turns this red, which is the property a hand-written list cannot
 * have. The census is asserted non-vacuous FIRST (§2.49): a parser that found nothing would agree
 * with any Caddyfile ever written.
 *
 * The block parser below reads the Caddyfile's shape (a line ending ` {` opens a block, a lone `}`
 * closes it, `#` starts a comment) — enough for these two files, and it THROWS on an unbalanced
 * file rather than returning a partial tree.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const CADDYFILE = resolve(REPO_ROOT, "docker", "prod", "Caddyfile");
const UAT_CADDYFILE = resolve(REPO_ROOT, "docker", "prod", "Caddyfile.uat");
const CORE_SRC = resolve(REPO_ROOT, "apps", "core", "src");

type Block = { header: string; lines: string[]; children: Block[] };

function parseCaddyfile(source: string): Block {
  const root: Block = { header: "<root>", lines: [], children: [] };
  const stack: Block[] = [root];
  for (const raw of source.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    const top = stack[stack.length - 1]!;
    if (line === "}") {
      if (stack.length === 1) throw new Error("Caddyfile: a `}` closes nothing — this parser is stale");
      stack.pop();
      continue;
    }
    if (line === "{" || line.endsWith(" {")) {
      const child: Block = { header: line.slice(0, -1).trim(), lines: [], children: [] };
      top.children.push(child);
      stack.push(child);
      continue;
    }
    top.lines.push(line.replace(/\s+/g, " "));
  }
  if (stack.length !== 1) throw new Error("Caddyfile: an unclosed block — this parser is stale");
  return root;
}

function find(block: Block, header: RegExp): Block[] {
  const out: Block[] = [];
  for (const child of block.children) {
    if (header.test(child.header)) out.push(child);
    out.push(...find(child, header));
  }
  return out;
}

function only(block: Block, header: RegExp, what: string): Block {
  const hits = find(block, header);
  if (hits.length !== 1) throw new Error(`Caddyfile: expected exactly one ${what}, found ${String(hits.length)}`);
  return hits[0]!;
}

/** Go canonicalises header keys (`x-agent-key` → `X-Agent-Key`), and Caddy's log keys are Go's. */
function canonical(header: string): string {
  return header.toLowerCase().split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("-");
}

/**
 * Headers the API reads that are NOT credentials, each with its reason. A header lands here only by
 * a decision someone wrote down; everything else the API reads is assumed secret and must be
 * redacted. The list staying short is the point.
 */
const NOT_SECRET: ReadonlyMap<string, string> = new Map([
  ["User-Agent", "read by kernel/auth/auth-audit.ts for the M-05 audit rows; the browser's name, not a credential"],
  // ABDM S0 (#323). The census matches `headers["…"]` in either direction, and these three are the
  // gateway client SETTING its outbound headers (modules/abdm/gateway-client.ts). None is a secret:
  ["Content-Type", "the media type of the ABDM gateway call (modules/abdm/gateway-client.ts); not a credential"],
  ["X-Hip-Id", "this facility's public HFR/HIP id on ABDM calls and callbacks (modules/abdm); an identifier, not a credential"],
  ["X-Hiu-Id", "this facility's public HIU id on ABDM calls and callbacks (modules/abdm); an identifier, not a credential"],
  // ABDM S1–S3. Again one read and one write, neither a secret:
  ["Request-Id", "ABDM's per-request UUID, read by modules/abdm/hiu.ts to de-duplicate a push page; correlation, not a credential"],
  ["X-Cm-Id", "the consent-manager id (\"sbx\"/\"abdm\") that modules/abdm/gateway-client.ts sets on gateway calls; not a credential"],
]);

/** Every request header the API reads, from its source, canonicalised and sorted. */
function headersTheApiReads(): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(/\bheaders\[\s*"([A-Za-z0-9-]+)"\s*\]/g)) found.add(canonical(m[1]!));
        for (const m of text.matchAll(/\bheaders\.(authorization|cookie)\b/g)) found.add(canonical(m[1]!));
        for (const m of text.matchAll(/@Headers\(\s*"([A-Za-z0-9-]+)"\s*\)/g)) found.add(canonical(m[1]!));
      }
    }
  };
  walk(CORE_SRC);
  return [...found].sort();
}

describe("WASA M-04 — the edge access log redacts every credential the API accepts", () => {
  const prod = parseCaddyfile(readFileSync(CADDYFILE, "utf8"));
  const snippet = only(prod, /^\(access_log\)$/, "(access_log) snippet");
  const log = only(snippet, /^log$/, "log block inside the snippet");

  it("the census of headers the API reads is non-vacuous, and names the two M-04 measured", () => {
    const read = headersTheApiReads();
    expect(read).toEqual(expect.arrayContaining(["Authorization", "X-Agent-Key", "X-Totp-Code", "Idempotency-Key"]));
    expect(read.length).toBeGreaterThanOrEqual(4);
    // And the exemption list is not stale: every header it excuses is one the API really reads.
    expect([...NOT_SECRET.keys()].filter((h) => !read.includes(h))).toEqual([]);
  });

  it("logs JSON through a filter, still to the rolled file on the caddy_data volume", () => {
    expect(only(log, /^output file \/data\/logs\/access\.log$/, "file output").lines).toEqual(
      expect.arrayContaining(["roll_size 10MiB", "roll_keep 5", "roll_keep_for 720h"]),
    );
    const filter = only(log, /^format filter$/, "format filter");
    expect(filter.lines).toContain("wrap json");
  });

  it("replaces EVERY header the API reads — plus Cookie — with REDACTED", () => {
    const fields = only(log, /^fields$/, "filter fields block");
    const redacted = new Set(
      fields.lines
        .map((l) => /^request>headers>([A-Za-z0-9-]+) replace REDACTED$/.exec(l)?.[1])
        .filter((h): h is string => h !== undefined),
    );
    const secret = headersTheApiReads().filter((h) => !NOT_SECRET.has(h));
    const missing = [...secret, "Cookie"].filter((h) => !redacted.has(h));
    // NAME them: "3 !== 5" does not tell an operator which secret is going to disk.
    expect(missing).toEqual([]);
  });

  it("redacts the free-text query values that carry patient names and complaints, keeping the path", () => {
    const query = only(log, /^request>uri query$/, "uri query filter");
    for (const key of ["q", "text", "complaint", "term"]) {
      expect(query.lines).toContain(`replace ${key} REDACTED`);
    }
    // The PATH is deliberately kept — it is most of what makes a 5xx line diagnosable (file header).
    expect(find(log, /^request>uri (?!query)/)).toEqual([]);
  });

  it("redacts `pt`, the ABDM HIU push token — the one credential that rides a query string", () => {
    const query = only(log, /^request>uri query$/, "uri query filter");
    expect(query.lines).toContain("replace pt REDACTED");
  });

  it("both the HTTPS site and the :80 redirect site write through that one snippet", () => {
    for (const site of [/^hmis\.crkmch\.com$/, /^http:\/\/$/]) {
      expect(only(prod, site, `site ${site.source}`).lines).toContain("import access_log");
    }
    // And nothing logs around it: a second, unfiltered `log` would reopen the leak.
    expect(find(prod, /^log$/)).toHaveLength(1);
  });
});

/**
 * ABDM S3 — THE PUSH TOKEN MUST NOT RETURN TO THE PATH. The HIU's data-push address carries a 256-bit
 * token that authenticates the push. S3 first put it in the PATH (`…/data-push/<token>`), and the
 * access log above keeps the path in the clear by design — so the credential went to disk. It now
 * rides the `pt` query parameter, which the uri query filter replaces. These pin both halves: no ABDM
 * route takes a token as a path parameter, and the name the push reads is the name the log redacts.
 */
describe("WASA M-04 — the ABDM push token rides the query, where the edge log redacts it", () => {
  const prod = parseCaddyfile(readFileSync(CADDYFILE, "utf8"));
  const log = only(only(prod, /^\(access_log\)$/, "(access_log) snippet"), /^log$/, "log block inside the snippet");
  const ABDM = resolve(CORE_SRC, "modules", "abdm");
  const sources = readdirSync(ABDM)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((file) => ({ file, text: readFileSync(resolve(ABDM, file), "utf8") }));
  const source = (file: string): string => {
    const hit = sources.find((s) => s.file === file);
    if (hit === undefined) throw new Error(`modules/abdm/${file} is gone — this census is stale`);
    return hit.text;
  };
  // Every path parameter an ABDM string declares (`":id"`, `"patients/:patientId/records"`), and every
  // `@Param("…")` a handler takes — from the source, so a new route is in the census without an edit.
  const pathParams = sources.flatMap(({ file, text }) => [...text.matchAll(/(?<=["'`/]):([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => ({ file, name: m[1]! })));
  const paramReads = sources.flatMap(({ file, text }) => [...text.matchAll(/@Param\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => ({ file, name: m[1]! })));

  it("the census is non-vacuous: the three ABDM controllers and the path parameters they do declare", () => {
    expect(sources.filter((s) => /@Controller\(/.test(s.text)).map((s) => s.file)).toEqual(expect.arrayContaining(["abha.controller.ts", "callbacks.controller.ts", "hiu.controller.ts"]));
    expect(pathParams.map((p) => p.name)).toEqual(expect.arrayContaining(["id", "patientId"]));
    expect(paramReads.map((p) => p.name)).toEqual(expect.arrayContaining(["id", "patientId"]));
  });

  it("no ABDM route declares a path parameter named token, and no handler reads one", () => {
    expect(pathParams.filter((p) => /token/i.test(p.name))).toEqual([]);
    expect(paramReads.filter((p) => /token/i.test(p.name))).toEqual([]);
    for (const { file, text } of sources.filter((s) => /@Controller\(/.test(s.text))) expect([file, /:token\b/.test(text)]).toEqual([file, false]);
  });

  it("the push reads its token from the query parameter the edge log redacts", () => {
    const name = /export const HIU_PUSH_TOKEN_PARAM = "([A-Za-z0-9_]+)";/.exec(source("hiu-client.ts"))?.[1];
    expect(name).toBe("pt");
    expect(source("hiu.controller.ts")).toMatch(/@Query\(HIU_PUSH_TOKEN_PARAM\)/);
    expect(only(log, /^request>uri query$/, "uri query filter").lines).toContain(`replace ${name!} REDACTED`);
  });
});

describe("WASA L-09 — the edge does not name its software", () => {
  const prod = parseCaddyfile(readFileSync(CADDYFILE, "utf8"));
  const uat = parseCaddyfile(readFileSync(UAT_CADDYFILE, "utf8"));

  it("the site header block deletes Server and Via, on production and UAT alike", () => {
    for (const [name, tree, site] of [
      ["prod", prod, /^hmis\.crkmch\.com$/],
      ["uat", uat, /^https:\/\/\{\$HMIS_UAT_SITE\}:8443$/],
    ] as const) {
      const header = only(only(tree, site, `${name} site`), /^header$/, `${name} header block`);
      expect([name, header.lines]).toEqual([name, expect.arrayContaining(["-Server", "-Via"])]);
    }
  });

  it("Caddy's own error responses (a 405 on OPTIONS /, a 502 with the api down) drop Server too", () => {
    const errors = only(only(prod, /^hmis\.crkmch\.com$/, "prod site"), /^handle_errors$/, "handle_errors");
    expect(errors.lines).toContain("header -Server");
    // The status is Caddy's own and the body stays empty, exactly as before the block existed.
    expect(errors.lines).toContain('respond "" {err.status_code}');
  });

  it("the :80 redirect is still a 308 to the same URL, now without the banner", () => {
    const http = only(prod, /^http:\/\/$/, "http:// site");
    expect(http.lines).toEqual(expect.arrayContaining(["header -Server", "redir https://{host}{uri} 308"]));
  });
});
