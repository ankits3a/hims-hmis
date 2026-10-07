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
      ["staging", prod, /^stagehmis\.crkmch\.com$/],
      ["uat", uat, /^http:\/\/\{\$HMIS_UAT_SITE\}:8080$/],
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

/**
 * WASA M-01 — A CONTENT-SECURITY-POLICY, REPORT-ONLY FIRST. The SPA keeps its bearer token in
 * `localStorage`, so any XSS reads it; a CSP is the control that makes an injected script fail to
 * run at all. It ships as `-Report-Only` so a directive the app really needs shows up as a console
 * report rather than a broken screen, and the NEXT change flips the header name to enforce it.
 */
describe("WASA M-01 — the site sends a Content-Security-Policy", () => {
  const prod = parseCaddyfile(readFileSync(CADDYFILE, "utf8"));
  const uat = parseCaddyfile(readFileSync(UAT_CADDYFILE, "utf8"));
  const HEADER = "Content-Security-Policy-Report-Only";

  /** The one CSP line in a site's `header` block, as directive → sources. */
  function policyOf(tree: Block, site: RegExp, name: string): Map<string, string[]> {
    const header = only(only(tree, site, `${name} site`), /^header$/, `${name} header block`);
    const lines = header.lines.filter((l) => /^Content-Security-Policy/.test(l));
    expect([name, lines.length]).toEqual([name, 1]);
    const m = new RegExp(`^${HEADER} "([^"]+)"$`).exec(lines[0]!);
    if (m === null) throw new Error(`${name}: CSP line is not \`${HEADER} "<policy>"\`: ${lines[0]!}`);
    return new Map(m[1]!.split(";").map((d) => d.trim()).filter((d) => d !== "").map((d) => {
      const [directive, ...sources] = d.split(/\s+/);
      return [directive!, sources];
    }));
  }

  for (const [name, tree, site] of [
    ["prod", prod, /^hmis\.crkmch\.com$/],
    ["uat", uat, /^http:\/\/\{\$HMIS_UAT_SITE\}:8080$/],
  ] as const) {
    it(`${name}: no framing, no plugins, and scripts only from this origin`, () => {
      const p = policyOf(tree, site, name);
      expect(p.get("frame-ancestors")).toEqual(["'none'"]);
      expect(p.get("object-src")).toEqual(["'none'"]);
      expect(p.get("default-src")).toEqual(["'self'"]);
      expect(p.get("base-uri")).toEqual(["'self'"]);
      expect(p.get("form-action")).toEqual(["'self'"]);
      // The directive the whole policy exists for: no inline script and no eval, ever.
      expect(p.get("script-src")).toEqual(["'self'"]);
    });
  }

  it("production and UAT send the SAME policy, so UAT is where a violation shows first", () => {
    const text = (tree: Block, site: RegExp): string | undefined =>
      only(only(tree, site, "site"), /^header$/, "header block").lines.find((l) => l.startsWith("Content-Security-Policy"));
    const prodPolicy = text(prod, /^hmis\.crkmch\.com$/);
    expect(prodPolicy).toMatch(/^Content-Security-Policy/); // not two absences agreeing
    expect(text(uat, /^http:\/\/\{\$HMIS_UAT_SITE\}:8080$/)).toBe(prodPolicy);
  });
});

/**
 * OWNER RULING 2026-09-27: "the site should allow the webcam on its pages". Desk One photographs the
 * paper slip (`slip-capture.tsx`), and `camera=()` blocked getUserMedia on every page, which left only
 * the file-input fallback. `camera=(self)` lets our own origin use the camera and still refuses it to
 * any embedded third party. Geolocation and the microphone stay off: nothing here uses them.
 */
describe("Owner 2026-09-27 — the site's own pages may use the camera", () => {
  const prod = parseCaddyfile(readFileSync(CADDYFILE, "utf8"));

  it("Permissions-Policy grants camera to self only, and keeps geolocation and microphone off", () => {
    const header = only(only(prod, /^hmis\.crkmch\.com$/, "prod site"), /^header$/, "prod header block");
    const policy = header.lines.filter((l) => l.startsWith("Permissions-Policy "));
    expect(policy).toEqual(['Permissions-Policy "geolocation=(), microphone=(), camera=(self)"']);
  });
});

/**
 * OWNER 2026-09-30 — THE STAGING SITE. https://stagehmis.crkmch.com is served by PRODUCTION'S caddy
 * (80 and 443 are production's) and proxied to UAT's caddy on docker0, where basic auth, the
 * headers and the /api split are applied. Each assertion below is a way the hop breaks quietly:
 * the block moved ahead of production's (deploy.sh's edge gate reads the FIRST hostname site as
 * production's), the upstream re-pointed at a port UAT does not publish, or the hosts entry that
 * makes `host.docker.internal` resolve inside production's container dropped.
 */
describe("Owner 2026-09-30 — production's caddy fronts the staging site", () => {
  const source = readFileSync(CADDYFILE, "utf8");
  const prod = parseCaddyfile(source);
  const prodCompose = readFileSync(resolve(REPO_ROOT, "docker", "prod", "docker-compose.prod.yml"), "utf8");
  const uatCompose = readFileSync(resolve(REPO_ROOT, "docker", "prod", "docker-compose.uat.yml"), "utf8");

  it("proxies to UAT's docker0 port, which is the port UAT publishes", () => {
    const site = only(prod, /^stagehmis\.crkmch\.com$/, "staging site");
    expect(site.lines).toContain("reverse_proxy host.docker.internal:8444");
    expect(uatCompose).toMatch(/ports: !override \["172\.17\.0\.1:8444:8080"\]/);
  });

  it("comes AFTER production's own site, which deploy.sh reads as the first hostname block", () => {
    const prodAt = source.search(/^hmis\.crkmch\.com \{$/m);
    const stagingAt = source.search(/^stagehmis\.crkmch\.com \{$/m);
    expect(prodAt).toBeGreaterThanOrEqual(0);
    expect(stagingAt).toBeGreaterThan(prodAt);
  });

  it("production's caddy container can resolve host.docker.internal", () => {
    expect(prodCompose).toMatch(/extra_hosts:\n\s+- "host\.docker\.internal:host-gateway"/);
  });
});

/**
 * Owner 2026-10-05 / 2026-10-06 — THE STAFF ANDROID APP IS DOWNLOADED FROM PRODUCTION, WITH NO STORE
 * AND NO PASSWORD. An APK holds no secret and nothing in it works without a staff login; a phone's
 * installer and the app's update check cannot answer a password prompt. What stands between that
 * decision and an open file share is the SHAPE of the route, so the shape is pinned on shipped bytes:
 * one folder, three kinds of file, one name prefix, nothing browsable, and a 404 — not the SPA's
 * index.html — for everything else under /app/.
 *
 * The mount is the half a reload cannot give: a Caddyfile that names /downloads over a container that
 * does not mount it serves 404 for the app while deploy.sh exits 0.
 */
describe("Owner 2026-10-06 — production serves the staff app's files, and only those", () => {
  const source = readFileSync(CADDYFILE, "utf8");
  const prodCompose = readFileSync(resolve(REPO_ROOT, "docker", "prod", "docker-compose.prod.yml"), "utf8");
  const uatCompose = readFileSync(resolve(REPO_ROOT, "docker", "prod", "docker-compose.uat.yml"), "utf8");
  const live = source.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

  function appFileMatcher(): RegExp {
    const found = /^\t@app_file path_regexp (\S+)$/m.exec(live);
    if (found === null) throw new Error("no `@app_file path_regexp` line in docker/prod/Caddyfile");
    return new RegExp(found[1]!);
  }

  it("admits the build, the short link, the update feed and the poster's QR", () => {
    const re = appFileMatcher();
    for (const path of [
      "/app/hmis-staff-latest.apk",
      "/app/hmis-staff-production-0.4.0-vc1-ce5d7ae0.apk",
      "/app/hmis-staff-production-latest.json",
      "/app/hmis-staff-install-qr.png",
    ]) expect([path, re.test(path)]).toEqual([path, true]);
  });

  it("admits nothing else — no listing, no checksum file, no other name, no folder below, no screen", () => {
    const re = appFileMatcher();
    for (const path of [
      "/app/",
      "/app",
      "/app/other.apk",
      "/app/hmis-staff-x.apk.sha256",
      "/app/hmis-staff-a/b.apk",
      "/app/hmis-staff-x.txt",
      "/app/../etc/caddy/Caddyfile",
      "/appointment",
      "/approvals",
      "/api/app/hmis-staff-latest.apk",
    ]) expect([path, re.test(path)]).toEqual([path, false]);
  });

  it("answers every other /app/ path with a 404 before the SPA's index.html can", () => {
    const refuse = live.search(/^\thandle \/app\/\* \{\n\t\trespond 404\n\t\}$/m);
    const spa = live.search(/^\thandle \{\n\t\troot \* \/srv$/m);
    expect(refuse).toBeGreaterThanOrEqual(0);
    expect(spa).toBeGreaterThan(refuse);
    expect(live.search(/^\thandle @app_file \{$/m)).toBeLessThan(refuse);
  });

  it("never lists a directory on the production site", () => {
    expect(live).not.toMatch(/file_server\s+browse/);
  });

  it("sends an APK as a download of the APK type, and never lets the update feed be cached", () => {
    expect(live).toMatch(/header @apk Content-Type application\/vnd\.android\.package-archive/);
    expect(live).toMatch(/header @apk Content-Disposition attachment/);
    expect(live).toMatch(/header @feed Cache-Control "no-store"/);
  });

  /*
    Owner 2026-10-06 — an update "should happen automatically": a JavaScript change reaches the phones
    as a signed bundle from this same folder (apps/mobile/scripts/publish-ota.sh). Two more shapes are
    admitted, and each is pinned as tightly as the APK's: the runtime header becomes part of a PATH, so
    it is matched as forty hex digits first; a file is fetched only by its own SHA-256.
  */
  for (const [file, env] of [["Caddyfile", "production"], ["Caddyfile.uat", "staging"]] as const) {
    const text = readFileSync(resolve(REPO_ROOT, "docker", "prod", file), "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

    it(`${file}: the over-the-air manifest is one address, and the folder is chosen by a header that is forty hex digits and nothing else`, () => {
      const block = new RegExp(`^\\t@ota_manifest \\{\\n\\t\\tpath /app/ota/${env}/manifest\\n\\t\\theader_regexp ota_runtime Expo-Runtime-Version (\\S+)\\n\\t\\}$`, "m").exec(text);
      expect(block).not.toBeNull();
      const header = new RegExp(block![1]!);
      expect(header.test("88fefc9077e465c4a376b794a3f9b14b5fcfee9d")).toBe(true);
      for (const bad of ["", "../../etc/caddy", "88fefc9077e465c4a376b794a3f9b14b5fcfee9d/..", "88FEFC9077E465C4A376B794A3F9B14B5FCFEE9D", "88fefc90", "88fefc9077e465c4a376b794a3f9b14b5fcfee9d0"]) {
        expect([bad, header.test(bad)]).toEqual([bad, false]);
      }
      expect(text).toContain(`\t\trewrite * /ota/${env}/{re.ota_runtime.0}/manifest\n`);
      // The boundary the publish script wrote the body with (apps/mobile/scripts/ota-manifest.js), and protocol v1.
      const written = /const BOUNDARY = "([^"]+)";/.exec(readFileSync(resolve(REPO_ROOT, "apps", "mobile", "scripts", "ota-manifest.js"), "utf8"));
      expect(text).toContain(`\t\theader Content-Type "multipart/mixed; boundary=${written![1]}"\n\t\theader expo-protocol-version 1\n`);
    });

    it(`${file}: an over-the-air file is fetched by its own checksum, under its runtime, and by no other name`, () => {
      const found = /^\t@ota_file path_regexp (\S+)$/m.exec(text);
      expect(found).not.toBeNull();
      const re = new RegExp(found![1]!);
      const rt = "8".repeat(40), sum = "a".repeat(64);
      expect(re.test(`/app/ota/${env}/${rt}/files/${sum}.bundle`)).toBe(true);
      expect(re.test(`/app/ota/${env}/${rt}/files/${sum}.png`)).toBe(true);
      for (const path of [
        `/app/ota/${env}/${rt}/manifest`,
        `/app/ota/${env}/${rt}/files/`,
        `/app/ota/${env}/${rt}/files/../manifest`,
        `/app/ota/${env}/${rt}/files/${sum}`,
        `/app/ota/${env}/${rt}/files/x/${sum}.png`,
        `/app/ota/${env === "production" ? "staging" : "production"}/${rt}/files/${sum}.png`,
        `/app/ota/`,
      ]) expect([path, re.test(path)]).toEqual([path, false]);
    });
  }

  it("the caddy container mounts the production builds read-only, and staging mounts its own folder", () => {
    expect(prodCompose).toMatch(/^\s+- \/opt\/hmis-context\/mobile-apk-prod:\/downloads:ro$/m);
    expect(uatCompose).toMatch(/^\s+- \/opt\/hmis-context\/mobile-apk:\/downloads:ro$/m);
  });
});
