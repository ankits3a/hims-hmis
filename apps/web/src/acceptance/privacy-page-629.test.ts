import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ACCEPTANCE — issue #629, spec docs/specs/629-privacy-page.md (owner APPROVED 2026-10-23): the staff app's
 * privacy policy is a static page in the web build, served at /privacy.html with no sign-in, and it says what
 * the app really does. The sentences are the owner's to word; these checks pin the FACTS each must carry.
 */
const PAGE = join(__dirname, "..", "..", "public", "privacy.html");
const CADDY = join(__dirname, "..", "..", "..", "..", "docker", "prod", "Caddyfile");

const html = (): string => readFileSync(PAGE, "utf8");
/** The words a reader sees: tags stripped, whitespace folded. */
const text = (): string => html().replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

/** The production site's block, cut at its last line. */
function siteBlock(): string {
  const all = readFileSync(CADDY, "utf8");
  const start = all.indexOf("hmis.crkmch.com {");
  expect(start).toBeGreaterThanOrEqual(0);
  const lines = all.slice(start).split("\n");
  let depth = 0;
  const out: string[] = [];
  for (const line of lines) {
    const bare = line.replace(/#.*$/, "");
    out.push(bare);
    depth += (bare.match(/\{/g) ?? []).length - (bare.match(/\}/g) ?? []).length;
    if (depth === 0 && out.length > 1) break;
  }
  return out.join("\n");
}
const glob = (g: string): RegExp => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

describe("spec #629 privacy page", () => {
  it("spec #629 D1: a static page with no script and nothing from another origin, served by the catch-all with no sign-in", () => {
    expect(existsSync(PAGE)).toBe(true);
    const h = html();
    expect(h).toMatch(/<title>[^<]+<\/title>/);
    expect(h).not.toMatch(/<script/i);
    expect(h).not.toMatch(/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(h).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);

    const site = siteBlock();
    const last = site.lastIndexOf("\n\thandle {");
    expect(last).toBeGreaterThan(0);
    const catchAll = site.slice(last);
    expect(catchAll).toMatch(/root \* \/srv/);
    expect(catchAll).toMatch(/try_files \{path\} \/index\.html/);
    expect(catchAll).not.toMatch(/basic_auth|forward_auth|jwt/);

    // No earlier matcher or handle path claims /privacy.html.
    const before = site.slice(0, last);
    const hits: string[] = [];
    for (const m of before.matchAll(/^\s*(?:@\w+\s+)?path_regexp\s+(?:\w+\s+)?(\S+)/gm)) if (new RegExp(m[1]!).test("/privacy.html")) hits.push(m[0]);
    for (const m of before.matchAll(/^\s*(?:@\w+\s+)?path\s+([^\n{]+)/gm)) for (const g of m[1]!.trim().split(/\s+/)) if (glob(g).test("/privacy.html")) hits.push(m[0]);
    for (const m of before.matchAll(/^\s*handle(?:_path)?\s+(\/\S*)\s*\{/gm)) if (glob(m[1]!).test("/privacy.html")) hits.push(m[0]);
    expect(hits).toEqual([]);
  });

  it("spec #629 D2: location once at Mark attendance with no coordinates kept; voice to speech-to-text, audio not kept; camera; notifications; Aadhaar", () => {
    const t = text();
    expect(t).toMatch(/Mark attendance/);
    expect(t).toMatch(/\bonce\b/i);
    expect(t).toMatch(/never in the background|not in the background|no background/i);
    expect(t).toMatch(/(?:coordinates|exact location)[^.]*(?:not|never) (?:stored|saved|kept)|(?:not|never) (?:store|save|keep)s? [^.]*(?:coordinates|exact location)/i);
    expect(t).toMatch(/speech-to-text/i);
    expect(t).toMatch(/(?:audio|recording)[^.]*(?:not|never) (?:stored|saved|kept)/i);
    expect(t).toMatch(/camera/i);
    expect(t).toMatch(/slip/i);
    expect(t).toMatch(/barcode|QR/i);
    expect(t).toMatch(/notification[^.]*(?:no|never|not)[^.]*patient/i);
    expect(t).toMatch(/Aadhaar[^.]*last four/i);
  });

  it("spec #629 D3: where it is kept, who sees it, how long, the DPDP Act 2023, and who to contact", () => {
    const t = text();
    expect(t).toMatch(/hospital's (?:own )?(?:HMIS )?servers?/i);
    expect(t).toMatch(/\bjob\b|\brole\b/i);
    expect(t).toMatch(/logged|recorded with/i);
    expect(t).toMatch(/180 days/);
    expect(t).toMatch(/90 days/);
    expect(t).toMatch(/medical record/i);
    expect(t).toMatch(/Digital Personal Data Protection Act,? 2023/);
    expect(t).toMatch(/hospital's IT office/i);
  });

  it("spec #629 D4: no email address, phone number, IP address or person's name", () => {
    const t = text();
    expect(t).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(t).not.toMatch(/\+91|\b\d{10}\b|\b\d{3,5}[- ]\d{6,8}\b/);
    expect(t).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(t).not.toMatch(/\b(?:Dr|Mr|Mrs|Ms|Shri|Smt)\.? [A-Z][a-z]+/);
    expect(html()).not.toMatch(/mailto:|tel:/i);
  });
});
