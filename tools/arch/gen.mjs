#!/usr/bin/env node
/**
 * Generates docs/architecture/ from the source tree. Nothing here is written by hand: every fact
 * is read from the code, so the map cannot drift from it. CI runs `--check` and fails when the
 * committed map differs from what this script produces.
 *
 *   node tools/arch/gen.mjs           # rewrite docs/architecture/ and docs/decisions/{index,README}.md
 *   node tools/arch/gen.mjs --check   # exit 1 if either is stale or a frontmatter is invalid
 *
 * Knowledge files follow the Open Knowledge Format (OKF) v0.2: YAML frontmatter whose only required
 * field is `type`. Decision records (`docs/decisions/NNNN-*.md`) and module notes (`MAP.md`) are
 * hand-written and validated here; the decisions index is generated from their frontmatter, so adding a
 * decision never edits a shared table. `stale_after` only ever WARNS: a date-driven failure would turn
 * main red on a calendar day with no code change.
 *
 * Static analysis only (regex over source). It never imports the app, never touches a database.
 * Output is deterministic and carries no counts that change on every commit (no line counts, no
 * import counts), so two lanes conflict here only when they change real structure.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const CORE = join(ROOT, "apps/core/src");
const MODULES = join(CORE, "modules");
const KERNEL = join(CORE, "kernel");
const SCHEMA = join(KERNEL, "db/schema");
const WEB_ROUTER = join(ROOT, "apps/web/src/router.tsx");
const OUT = join(ROOT, "docs/architecture");
const DECISIONS = join(ROOT, "docs/decisions");
const REGEN = "node tools/arch/gen.mjs";

// ---------- helpers ----------

const read = (p) => readFileSync(p, "utf8");
const isTest = (p) => /\.(test|spec)\.tsx?$/.test(p);
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const uniqSorted = (xs) => [...new Set(xs)].sort(byName);
const rel = (p) => relative(ROOT, p).split(sep).join("/");

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort(byName)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !isTest(p)) out.push(p);
  }
  return out;
}

const dirs = (p) => readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory()).sort(byName);

/**
 * Strip comments so commented-out code and prose never count as structure. A scanner, not a
 * regex: a glob like "modules/*" inside a string would otherwise open a block comment.
 * Regex literals are not tracked; none in this tree contain a quote or a comment opener.
 */
function stripComments(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      // ' and " cannot span lines; stopping at a newline keeps a JSX apostrophe ("don't") local.
      while (j < src.length && src[j] !== c && (c === "`" || src[j] !== "\n")) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else out += c;
  }
  return out;
}

/** Every module specifier a file imports or re-exports, including dynamic import(). */
function specifiers(src) {
  const s = stripComments(src);
  const out = [];
  for (const m of s.matchAll(/\bfrom\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of s.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  for (const m of s.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}

/** Which unit a resolved path belongs to: `module:x`, `kernel:y`, or null. */
function unitOf(absPath) {
  const r = relative(CORE, absPath).split(sep);
  if (r[0] === "modules" && r.length >= 2) return `module:${r[1]}`;
  if (r[0] === "kernel" && r.length >= 2) return `kernel:${r[1].replace(/\.tsx?$/, "")}`;
  return null;
}

/** Text inside a balanced bracket pair starting at `open` (index of the opening bracket). */
function balanced(src, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const close = pairs[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === src[open]) depth++;
    else if (c === close && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

// ---------- core: modules + kernel ----------

const moduleNames = dirs(MODULES);
/** Kernel units are its directories AND its top-level files (`config.ts`, `crypto.ts`, `tokens.ts`). */
const kernelFileUnits = readdirSync(KERNEL).filter((n) => /\.ts$/.test(n) && !isTest(n)).map((n) => n.replace(/\.ts$/, ""));
const kernelNames = uniqSorted([...dirs(KERNEL), ...kernelFileUnits]);
/** Source files of a unit, whether it is a directory or a single file. */
const unitFiles = (base, name) => (existsSync(join(base, name)) && statSync(join(base, name)).isDirectory() ? walk(join(base, name)) : [join(base, `${name}.ts`)]);

/** deps[unit] = Set of units it imports. */
const deps = new Map();
const addDep = (from, to) => {
  if (from === to) return;
  if (!deps.has(from)) deps.set(from, new Set());
  deps.get(from).add(to);
};

for (const [base, kind, names] of [[MODULES, "module", moduleNames], [KERNEL, "kernel", kernelNames]]) {
  for (const name of names) {
    const unit = `${kind}:${name}`;
    deps.set(unit, deps.get(unit) ?? new Set());
    for (const file of unitFiles(base, name)) {
      for (const spec of specifiers(read(file))) {
        if (!spec.startsWith(".")) continue;
        const target = unitOf(resolve(dirname(file), spec));
        if (target) addDep(unit, target);
      }
    }
  }
}

const depsOf = (unit, kind) => uniqSorted([...(deps.get(unit) ?? [])].filter((u) => u.startsWith(kind + ":")).map((u) => u.split(":")[1]));
const usedBy = (unit, kind) => uniqSorted([...deps.entries()].filter(([from, to]) => from.startsWith(kind + ":") && to.has(unit)).map(([from]) => from.split(":")[1]));

/** Resolve a relative specifier to a .ts/.tsx file, or null. */
function resolveTs(fromFile, spec) {
  const b = resolve(dirname(fromFile), spec);
  for (const c of [b + ".ts", b + ".tsx", join(b, "index.ts")]) if (existsSync(c)) return c;
  return null;
}

/** Collapse whitespace and cap length, so one export is one short line. */
function oneLine(text, max = 140) {
  const t = text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/,\s*\)/g, ")").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** A return-type annotation starting at `src[0] === ":"`, up to the body or `=>` at depth 0. */
function returnType(src, arrow = false) {
  if (!/^\s*:/.test(src)) return "";
  const start = src.indexOf(":") + 1;
  let depth = 0;
  let i = start;
  // At depth 0 a `{` opens the body only once the type so far is complete; after `:`, `|`, `&`, `<`,
  // `,`, `(` or `=>` it opens an object-literal type. `=>` ends the type only for an arrow const.
  const complete = () => {
    const t = src.slice(start, i).trim();
    return t !== "" && !/([:|&<,(]|=>)$/.test(t);
  };
  for (; i < src.length; i++) {
    const c = src[i];
    if (src.startsWith("=>", i)) {
      if (depth === 0 && arrow && complete()) break;
      i++;
    } else if ("<([".includes(c)) depth++;
    else if (">)]".includes(c)) depth--;
    else if (c === "{") {
      if (depth === 0 && complete()) break;
      depth++;
    } else if (c === "}") depth--;
    else if (c === ";" && depth === 0) break;
  }
  return ": " + src.slice(start, i).trim();
}

/** One-line declaration of exported `name` in `file`: a signature for functions, else its kind. */
function declOf(file, name) {
  const s = stripComments(read(file));
  const n = name.replace(/\$/g, "\\$");
  let m = s.match(new RegExp(`export\\s+(?:declare\\s+)?(?:async\\s+)?function\\*?\\s+${n}\\b\\s*(<[^(]*>)?\\s*\\(`));
  if (m) {
    const open = m.index + m[0].length - 1;
    const params = balanced(s, open);
    return oneLine(`${name}(${params})${returnType(s.slice(open + params.length + 2))}`);
  }
  m = s.match(new RegExp(`export\\s+(?:const|let)\\s+${n}\\b\\s*`));
  if (m) {
    const rest = s.slice(m.index + m[0].length);
    if (rest.startsWith(":")) return oneLine(`${name}${rest.slice(0, rest.indexOf("=")).trim()}`);
    const arrow = rest.match(/^=\s*(?:async\s*)?(<[^(]*>)?\s*\(/);
    if (arrow) {
      const open = arrow[0].length - 1;
      const params = balanced(rest, open);
      const after = rest.slice(open + params.length + 2);
      if (/^\s*(:[^=]*)?=>/.test(after) || /^\s*:/.test(after)) return oneLine(`${name}(${params})${returnType(after, true)}`);
    }
    return name;
  }
  if (new RegExp(`export\\s+(?:abstract\\s+)?class\\s+${n}\\b`).test(s)) return `class ${name}`;
  if (new RegExp(`export\\s+enum\\s+${n}\\b`).test(s)) return `enum ${name}`;
  return name;
}

/**
 * Public surface of a file, following re-exports: [{ name, type, file, decl }]. `file` is where the
 * name is declared, so a reader opens that file and not the index.
 */
function exportsOf(file, seen = new Set()) {
  if (!file || seen.has(file) || !existsSync(file)) return [];
  seen.add(file);
  const s = stripComments(read(file));
  const imported = new Map();
  for (const m of s.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
    for (const raw of m[1].split(",")) {
      const [orig, alias] = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).map((x) => x?.trim());
      if (orig) imported.set(alias ?? orig, { orig, spec: m[2] });
    }
  }
  const out = [];
  const add = (name, type, src, orig = name) => {
    const target = src && src !== file ? exportsOf(src, new Set(seen)).find((e) => e.name === orig) : null;
    if (target) out.push({ ...target, name });
    else out.push({ name, type, file: src ?? file, decl: type ? name : src ? declOf(src, orig).replace(orig, name) : name });
  };
  for (const m of s.matchAll(/export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s+["']([^"']+)["'])?/g)) {
    const from = m[3] ? resolveTs(file, m[3]) : null;
    for (const raw of m[2].split(",")) {
      const t = raw.trim();
      if (!t) continue;
      const type = Boolean(m[1]) || t.startsWith("type ");
      const [orig, alias] = t.replace(/^type\s+/, "").split(/\s+as\s+/).map((x) => x.trim());
      if (from) add(alias ?? orig, type, from, orig);
      else if (imported.has(orig)) {
        const imp = imported.get(orig);
        add(alias ?? orig, type, imp.spec.startsWith(".") ? resolveTs(file, imp.spec) : null, imp.orig);
      } else add(alias ?? orig, type, file, orig);
    }
  }
  for (const m of s.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(const|let|function\*?|class|enum|type|interface)\s+([A-Za-z0-9_$]+)/g)) {
    const type = m[1] === "type" || m[1] === "interface";
    out.push({ name: m[2], type, file, decl: type ? m[2] : declOf(file, m[2]) });
  }
  for (const m of s.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) out.push(...exportsOf(resolveTs(file, m[1]), seen));
  const unique = new Map();
  for (const e of out) if (!unique.has(e.name)) unique.set(e.name, e);
  return [...unique.values()].sort((a, b) => byName(a.name, b.name));
}

/** Events a module subscribes to, as named in its manifest (`{ event: x.name, consumer: … }`). */
function subscriptionsOf(m) {
  const p = join(MODULES, m, "manifest.ts");
  if (!existsSync(p)) return [];
  return uniqSorted([...stripComments(read(p)).matchAll(/\{\s*event:\s*([A-Za-z0-9_$.]+?)(?:\.name)?\s*,/g)].map((x) => x[1]));
}

/** HTTP routes declared by controllers under `dir`. */
function routesIn(base, name) {
  const routes = [];
  for (const file of unitFiles(base, name)) {
    const s = stripComments(read(file));
    const ctl = s.match(/@Controller\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/);
    if (!ctl) continue;
    const prefix = ctl[1] ?? "";
    for (const m of s.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g)) {
      const path = "/" + [prefix, m[2] ?? ""].filter(Boolean).join("/");
      routes.push({ verb: m[1].toUpperCase(), path: path.replace(/\/+/g, "/"), file: rel(file) });
    }
  }
  return routes.sort((a, b) => byName(a.path + a.verb, b.path + b.verb));
}

// ---------- schema: tables + foreign keys ----------

const schemaFiles = readdirSync(SCHEMA).filter((n) => n.endsWith(".ts") && !isTest(n) && n !== "index.ts").sort(byName);
/** tables[file] = [{ name, sql }]; varToFile maps a drizzle table variable to its schema file. */
const tables = new Map();
const varToFile = new Map();
for (const f of schemaFiles) {
  const s = stripComments(read(join(SCHEMA, f)));
  const list = [];
  for (const m of s.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*pgTable\(\s*["']([^"']+)["']/g)) {
    list.push({ name: m[1], sql: m[2] });
    varToFile.set(m[1], f);
  }
  tables.set(f, list.sort((a, b) => byName(a.sql, b.sql)));
}
/** fk[file] = Set of schema files whose tables it references. */
const fk = new Map();
for (const f of schemaFiles) {
  const s = stripComments(read(join(SCHEMA, f)));
  const refs = new Set();
  for (const m of s.matchAll(/references\(\s*\(\)\s*(?::\s*[A-Za-z]+\s*)?=>\s*([A-Za-z0-9_$]+)\./g)) {
    const target = varToFile.get(m[1]);
    if (target && target !== f) refs.add(target);
  }
  for (const m of s.matchAll(/foreignColumns:\s*\[\s*([A-Za-z0-9_$]+)\./g)) {
    const target = varToFile.get(m[1]);
    if (target && target !== f) refs.add(target);
  }
  fk.set(f, refs);
}
const schemaOwner = (f) => {
  const base = f.replace(/\.ts$/, "");
  return moduleNames.includes(base) ? `module ${base}` : "kernel";
};

// ---------- web: routes → screens ----------

function webRoutes() {
  if (!existsSync(WEB_ROUTER)) return [];
  const s = stripComments(read(WEB_ROUTER));
  const imports = new Map();
  for (const m of s.matchAll(/import\s+\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
    for (const n of m[1].split(",")) {
      const name = n.trim().split(/\s+as\s+/).pop().trim();
      if (name) imports.set(name, m[2]);
    }
  }
  const out = [];
  for (const m of s.matchAll(/createRoute\(\s*\{/g)) {
    const body = balanced(s, m.index + m[0].length - 1);
    const path = body.match(/\bpath:\s*["'`]([^"'`]+)["'`]/)?.[1];
    if (!path) continue;
    const comp = body.match(/\bcomponent:\s*([^\n]+)/)?.[1]?.trim() ?? "";
    const lazy = comp.match(/import\(\s*["']([^"']+)["']/)?.[1];
    // `component: X` names an import; `component: function S() { return <X … /> }` wraps one.
    const rest = body.slice(body.search(/\bcomponent:/));
    const name = /^(function|\()/.test(comp) ? rest.match(/<([A-Z][A-Za-z0-9_$]*)/)?.[1] : comp.match(/^[A-Za-z0-9_$]+/)?.[0];
    const src = lazy ?? (name ? imports.get(name) : undefined);
    const screen = src ? src.replace(/^\.\//, "apps/web/src/") : !comp ? "(redirect)" : name ?? "";
    out.push({ path, screen });
  }
  return out.sort((a, b) => byName(a.path, b.path));
}

// ---------- render ----------

const HEADER = `<!-- GENERATED by \`${REGEN}\` — do not edit by hand. CI fails when this file is stale. -->\n`;
/** OKF frontmatter for a generated page. No `generated.at`: the output must not change with the date. */
const yq = (s) => JSON.stringify(s);
function okf(type, title, resource, extra = []) {
  const L = ["---", `type: ${type}`, `title: ${yq(title)}`];
  if (resource) L.push(`resource: ${resource}`);
  L.push(...extra, "generated: { by: tools/arch/gen.mjs }", "---", "");
  return L.join("\n");
}
const mermaidId = (s) => s.replace(/[^A-Za-z0-9]/g, "_");
const list = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "—");

function renderReadme() {
  const L = [okf("architecture", "HMIS architecture map", "apps/core/src") + HEADER, "# HMIS architecture map\n"];
  L.push("Generated from the source tree. Read this before exploring code; open a module page for its");
  L.push("dependencies, public API, routes and tables. Regenerate after you change structure:");
  L.push("`" + REGEN + "`. After a rebase conflict in this folder, regenerate instead of merging by hand.\n");
  L.push("## System\n");
  L.push("```mermaid\nflowchart LR");
  L.push("  web[\"apps/web<br/>React 19 + Vite\"] -->|HTTP /api| core[\"apps/core<br/>NestJS\"]");
  L.push("  mobile[\"apps/mobile<br/>Expo\"] -->|HTTP /api| core");
  L.push("  contracts[\"packages/contracts<br/>zod\"] -.-> web");
  L.push("  contracts -.-> core");
  L.push("  core --> pg[(Postgres<br/>drizzle)]");
  L.push("  worker[\"apps/core worker.ts<br/>events + sweeps\"] --> pg");
  L.push("```\n");
  L.push("## Module dependencies (core)\n");
  L.push("Arrow = imports through the target's `index.ts`. Shared modules (many arrows in) are expensive to change.\n");
  L.push("```mermaid\nflowchart LR");
  for (const m of moduleNames) L.push(`  ${mermaidId(m)}[${m}]`);
  for (const m of moduleNames) for (const d of depsOf(`module:${m}`, "module")) L.push(`  ${mermaidId(m)} --> ${mermaidId(d)}`);
  L.push("```\n");
  L.push("## Modules\n");
  L.push("| module | depends on | used by | routes | tables |");
  L.push("|---|---|---|---|---|");
  for (const m of moduleNames) {
    const r = routesIn(MODULES, m).length;
    const t = (tables.get(`${m}.ts`) ?? []).length;
    L.push(`| [${m}](modules/${m}.md) | ${depsOf(`module:${m}`, "module").join(", ") || "—"} | ${usedBy(`module:${m}`, "module").join(", ") || "—"} | ${r} | ${t} |`);
  }
  L.push("\n## Kernel subsystems\n");
  L.push("Shared platform code in `apps/core/src/kernel/`. Coordinate before editing (see CLAUDE.md).\n");
  L.push("| subsystem | used by modules | depends on kernel | routes |");
  L.push("|---|---|---|---|");
  for (const k of kernelNames) {
    const r = routesIn(KERNEL, k).length;
    L.push(`| \`${k}\` | ${usedBy(`kernel:${k}`, "module").join(", ") || "—"} | ${depsOf(`kernel:${k}`, "kernel").join(", ") || "—"} | ${r || "—"} |`);
  }
  L.push("\nKernel HTTP routes: [kernel-routes.md](kernel-routes.md). Database: [schema.md](schema.md). Web screens: [web.md](web.md).\n");
  return L.join("\n");
}

function renderModule(m) {
  const unit = `module:${m}`;
  const ex = exportsOf(join(MODULES, m, "index.ts"));
  const routes = routesIn(MODULES, m);
  const own = tables.get(`${m}.ts`) ?? [];
  const L = [okf("architecture", `module ${m}`, `apps/core/src/modules/${m}`) + HEADER, `# module \`${m}\`\n`, `Source: \`apps/core/src/modules/${m}/\``];
  if (existsSync(join(MODULES, m, "MAP.md"))) L.push(`· Notes: [MAP.md](../../../apps/core/src/modules/${m}/MAP.md)`);
  L.push("");
  L.push(`- **Depends on modules:** ${list(depsOf(unit, "module"))}`);
  L.push(`- **Used by modules:** ${list(usedBy(unit, "module"))}`);
  L.push(`- **Kernel used:** ${list(depsOf(unit, "kernel"))}`);
  const subs = subscriptionsOf(m);
  if (subs.length) L.push(`- **Subscribes to events:** ${list(subs)}`);
  // Public API grouped by the file that DECLARES each name, so a reader opens that file, not index.ts.
  L.push("\n## Public API (`index.ts`), by declaring file\n");
  const byFile = new Map();
  for (const e of ex) {
    const f = rel(e.file).replace(`apps/core/src/modules/${m}/`, "").replace("apps/core/src/", "");
    if (!byFile.has(f)) byFile.set(f, { values: [], types: [] });
    byFile.get(f)[e.type ? "types" : "values"].push(e.decl);
  }
  if (!byFile.size) L.push("Nothing exported.");
  for (const f of [...byFile.keys()].sort(byName)) {
    const { values, types } = byFile.get(f);
    L.push(`- \`${f}\``);
    for (const v of values) L.push(`  - \`${v}\``);
    if (types.length) L.push(`  - types: ${list(types)}`);
  }
  L.push(`\n## Tables (\`kernel/db/schema/${m}.ts\`)\n`);
  L.push(own.length ? list(own.map((t) => t.sql)) : "None under this name.");
  if (own.length) L.push(`\nForeign keys into: ${list([...(fk.get(`${m}.ts`) ?? [])].sort(byName).map((f) => f.replace(/\.ts$/, "")))}`);
  // Routes are cheap to grep, so the page names each controller and the URL areas it serves, not every route.
  L.push(`\n## HTTP routes (${routes.length})\n`);
  const byCtl = new Map();
  for (const r of routes) {
    const f = r.file.replace(`apps/core/src/modules/${m}/`, "");
    if (!byCtl.has(f)) byCtl.set(f, []);
    byCtl.get(f).push(r);
  }
  if (!byCtl.size) L.push("None.");
  for (const f of [...byCtl.keys()].sort(byName)) {
    const rs = byCtl.get(f);
    const areas = uniqSorted(rs.map((r) => "/" + r.path.split("/").filter(Boolean).slice(0, 2).join("/")));
    L.push(`- \`${f}\` — ${rs.length}: ${areas.map((a) => `\`${a}\``).join(", ")}`);
  }
  L.push(`\nFull list: \`grep -rnE "@(Get|Post|Put|Patch|Delete)\\(" apps/core/src/modules/${m}\``);
  L.push("");
  return L.join("\n");
}

function renderKernelRoutes() {
  const L = [okf("architecture", "Kernel HTTP routes", "apps/core/src/kernel") + HEADER, "# Kernel HTTP routes\n"];
  for (const k of kernelNames) {
    const routes = routesIn(KERNEL, k);
    if (!routes.length) continue;
    L.push(`## \`${k}\`\n`, "| verb | path | controller |", "|---|---|---|");
    for (const r of routes) L.push(`| ${r.verb} | \`${r.path}\` | \`${r.file.replace("apps/core/src/kernel/", "")}\` |`);
    L.push("");
  }
  const other = routesIn(CORE, "health");
  if (other.length) {
    L.push("## `health`\n", "| verb | path | controller |", "|---|---|---|");
    for (const r of other) L.push(`| ${r.verb} | \`${r.path}\` | \`${r.file.replace("apps/core/src/", "")}\` |`);
    L.push("");
  }
  return L.join("\n");
}

function renderSchema() {
  const L = [okf("architecture", "Database schema", "apps/core/src/kernel/db/schema") + HEADER, "# Database schema\n"];
  L.push("One file per area in `apps/core/src/kernel/db/schema/`. Arrow = a foreign key from one file's tables into another's.\n");
  L.push("```mermaid\nflowchart LR");
  for (const f of schemaFiles) for (const t of [...fk.get(f)].sort(byName)) L.push(`  ${mermaidId(f.replace(/\.ts$/, ""))}[${f.replace(/\.ts$/, "")}] --> ${mermaidId(t.replace(/\.ts$/, ""))}[${t.replace(/\.ts$/, "")}]`);
  L.push("```\n");
  L.push("| file | owner | tables |", "|---|---|---|");
  for (const f of schemaFiles) {
    const ts = tables.get(f);
    L.push(`| \`${f}\` | ${schemaOwner(f)} | ${ts.length ? ts.map((t) => `\`${t.sql}\``).join(", ") : "—"} |`);
  }
  L.push("");
  return L.join("\n");
}

function renderWeb() {
  const routes = webRoutes();
  const L = [okf("architecture", "Web routes", "apps/web/src/router.tsx") + HEADER, "# Web routes\n", "From `apps/web/src/router.tsx`. Screen = the file the route's component comes from.\n"];
  L.push("| path | screen |", "|---|---|");
  for (const r of routes) L.push(`| \`${r.path}\` | ${r.screen ? "`" + r.screen + "`" : "—"} |`);
  L.push("");
  return L.join("\n");
}

// ---------- write / check ----------

const files = new Map();
files.set("README.md", renderReadme());
files.set("kernel-routes.md", renderKernelRoutes());
files.set("schema.md", renderSchema());
files.set("web.md", renderWeb());
for (const m of moduleNames) files.set(`modules/${m}.md`, renderModule(m));

/**
 * Hand-written module notes (`modules/<m>/MAP.md`) cannot be generated, but two things in them can be
 * checked: every file they name must exist, and they may not cite line numbers, which go stale on the
 * next edit with nothing to notice. A note that names a deleted file fails here instead of misleading.
 */
function mapNoteProblems() {
  const problems = [];
  for (const m of moduleNames) {
    const p = join(MODULES, m, "MAP.md");
    if (!existsSync(p)) continue;
    const src = read(p);
    const bases = [join(MODULES, m), MODULES, CORE, join(ROOT, "apps/core"), ROOT];
    for (const [ref] of src.matchAll(/[\w.-]+(?:\/[\w.-]+)*\.tsx?(?::\d+)?/g)) {
      if (/:\d+$/.test(ref)) problems.push(`${rel(p)}: cites a line number (${ref}); name the symbol instead`);
      const file = ref.replace(/:\d+$/, "");
      if (!bases.some((b) => existsSync(join(b, file)))) problems.push(`${rel(p)}: names ${file}, which does not exist`);
    }
  }
  return uniqSorted(problems);
}

// ---------- knowledge files: OKF frontmatter, decisions index ----------

/** Split `a, "b, c", { d: e }` on top-level commas, respecting quotes and brackets. */
function splitFlow(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** One YAML value of the subset these files use: "json strings", [flow lists], { flow: maps }, plain scalars. */
function yamlValue(v) {
  v = v.trim();
  if (v === "") return null;
  if (v.startsWith('"')) return JSON.parse(v);
  if (v.startsWith("[")) return splitFlow(v.slice(1, -1)).map(yamlValue);
  if (v.startsWith("{")) {
    const o = {};
    for (const pair of splitFlow(v.slice(1, -1))) {
      const k = pair.indexOf(":");
      o[pair.slice(0, k).trim()] = yamlValue(pair.slice(k + 1));
    }
    return o;
  }
  return v;
}

/**
 * The frontmatter of a knowledge file, or null when it has none. A deliberately small YAML reader (top-level
 * keys, flow values, block lists of flow values): it throws on anything else rather than guess.
 */
function frontmatter(src) {
  if (!src.startsWith("---\n")) return null;
  const end = src.indexOf("\n---\n", 3);
  if (end === -1) throw new Error("frontmatter is not closed by a `---` line");
  const data = {};
  let key = null;
  for (const line of src.slice(4, end).split("\n")) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    const kv = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (item && key && (data[key] === null || Array.isArray(data[key]))) (data[key] ??= []).push(yamlValue(item[1]));
    else if (kv) data[(key = kv[1])] = yamlValue(kv[2]);
    else throw new Error(`cannot read frontmatter line: ${line}`);
  }
  return data;
}

const isoDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d);
const RULINGS = { ruled: "stable", "partly-open": "draft", superseded: "deprecated" };
const RULING_LABEL = { ruled: "Ruled", "partly-open": "Partly open", superseded: "Superseded" };

/** Shared checks of OKF v0.2 provenance fields: `generated`, `verified`, `stale_after` (a warning, never a failure). */
function provenanceProblems(where, d, problems, warnings, { needAt }) {
  if (!d.generated || typeof d.generated !== "object" || !d.generated.by) problems.push(`${where}: generated.by is missing`);
  else if (needAt && !isoDate(d.generated.at)) problems.push(`${where}: generated.at "${d.generated.at}" is not an ISO date (YYYY-MM-DD)`);
  if (!Array.isArray(d.verified)) problems.push(`${where}: verified must be a list (empty until a person checks the file)`);
  else for (const v of d.verified) if (!v || !v.by || !isoDate(v.at)) problems.push(`${where}: each verified entry needs { by, at: YYYY-MM-DD }`);
  if (d.stale_after != null) {
    if (!isoDate(d.stale_after)) problems.push(`${where}: stale_after "${d.stale_after}" is not an ISO date`);
    // The ONLY date-dependent branch in this script, and it may only warn: never exit 1 on the calendar.
    else if (d.stale_after < new Date().toISOString().slice(0, 10)) warnings.push(`${where}: past stale_after ${d.stale_after}; re-read it against the code and bump the date`);
  }
}

const decisionFiles = readdirSync(DECISIONS).filter((n) => /^\d{4}-.+\.md$/.test(n)).sort(byName);

/** Decision records with parsed frontmatter, plus every problem found in them. */
function readDecisions() {
  const problems = [];
  const warnings = [];
  const recs = [];
  for (const f of decisionFiles) {
    const where = `docs/decisions/${f}`;
    let d;
    try {
      d = frontmatter(read(join(DECISIONS, f)));
    } catch (e) {
      problems.push(`${where}: ${e.message}`);
      continue;
    }
    if (!d) {
      problems.push(`${where}: no frontmatter (a decision starts with a --- block; see docs/decisions/README.md)`);
      continue;
    }
    if (d.type !== "decision") problems.push(`${where}: type must be "decision" (is ${d.type ?? "missing"})`);
    if (d.id !== f.slice(0, 4)) problems.push(`${where}: id "${d.id}" does not match the filename`);
    if (!d.title) problems.push(`${where}: title is missing`);
    if (!(d.ruling in RULINGS)) problems.push(`${where}: ruling "${d.ruling}" is not one of ${Object.keys(RULINGS).join(" | ")}`);
    if (!Object.values(RULINGS).includes(d.status)) problems.push(`${where}: status "${d.status}" is not one of ${Object.values(RULINGS).join(" | ")}`);
    else if (d.ruling in RULINGS && RULINGS[d.ruling] !== d.status) problems.push(`${where}: ruling ${d.ruling} means status ${RULINGS[d.ruling]}, not ${d.status}`);
    for (const k of ["tags", "supersedes", "superseded_by", "sources"]) {
      if (!Array.isArray(d[k])) problems.push(`${where}: ${k} must be a list (may be empty)`);
    }
    for (const s of Array.isArray(d.sources) ? d.sources : []) if (!s || typeof s !== "object" || !s.id) problems.push(`${where}: each source needs an id`);
    if (d.ruling === "superseded" && !(d.superseded_by ?? []).length) problems.push(`${where}: ruling superseded needs superseded_by`);
    provenanceProblems(where, d, problems, warnings, { needAt: true });
    recs.push({ file: f, ...d });
  }
  const byId = new Map(recs.map((r) => [r.id, r]));
  for (const r of recs) {
    const where = `docs/decisions/${r.file}`;
    for (const [k, back] of [["supersedes", "superseded_by"], ["superseded_by", "supersedes"]]) {
      for (const id of Array.isArray(r[k]) ? r[k] : []) {
        const other = byId.get(id);
        if (!other) problems.push(`${where}: ${k} names ${id}, which does not exist`);
        else if (!(Array.isArray(other[back]) && other[back].includes(r.id))) problems.push(`${where}: ${k} names ${id}, but ${id}'s ${back} does not name ${r.id}`);
      }
    }
  }
  return { recs: recs.sort((a, b) => byName(a.id, b.id)), problems, warnings };
}

/** Module notes: OKF frontmatter with a `type` and a `resource` that is a real directory. */
function mapFrontmatterProblems(problems, warnings) {
  for (const m of moduleNames) {
    const p = join(MODULES, m, "MAP.md");
    if (!existsSync(p)) continue;
    let d;
    try {
      d = frontmatter(read(p));
    } catch (e) {
      problems.push(`${rel(p)}: ${e.message}`);
      continue;
    }
    if (!d) {
      problems.push(`${rel(p)}: no frontmatter (type: module-notes, resource: apps/core/src/modules/${m}, ...)`);
      continue;
    }
    if (!d.type) problems.push(`${rel(p)}: type is missing`);
    if (!d.resource) problems.push(`${rel(p)}: resource is missing`);
    else if (!existsSync(join(ROOT, d.resource)) || !statSync(join(ROOT, d.resource)).isDirectory()) problems.push(`${rel(p)}: resource ${d.resource} is not a directory`);
    provenanceProblems(rel(p), d, problems, warnings, { needAt: true });
  }
}

const DECISION_RULE = [
  "**Rule: a ruling is added as a new numbered file; an old one is never rewritten, only marked Superseded.**",
  "Numbers run in the order the rulings were recorded: 0001–0025 follow the ruling date, and later batches may record",
  "an older ruling under a higher number (the Date column is the ruling date). A record whose rulings were partly overturned later says so",
  "in its Status line and names the record that overturned it.",
].join("\n");

const DECISION_FRONTMATTER = [
  "Each record starts with OKF frontmatter (Open Knowledge Format v0.2); `node tools/arch/gen.mjs --check` validates it:",
  "",
  "```yaml",
  "---",
  "type: decision",
  'id: "NNNN"                      # the filename\'s number',
  'title: "…"                      # the H1 without "NNNN — "',
  'description: "…"                # the decision in one sentence',
  "generated: { by: agent:claude, at: YYYY-MM-DD }   # who wrote the file; at = the ruling date",
  "verified: []                    # an owner review appends { by: human:owner, at: YYYY-MM-DD }",
  "status: stable                  # OKF: stable | draft | deprecated",
  "ruling: ruled                   # ours: ruled (stable) | partly-open (draft) | superseded (deprecated)",
  "tags: [billing, opd]",
  "supersedes: []                  # ids; the other record's superseded_by must name this one",
  "superseded_by: []",
  "sources: []                     # e.g. - { id: pr-531, resource: \"https://…/pull/531\", title: \"…\" }",
  "---",
  "```",
  "",
  "A partly overturned record keeps its ruling and lists the overturning record in `superseded_by`; only a record",
  "overturned whole is `superseded`.",
].join("\n");

function rulingCell(r) {
  if (r.ruling === "superseded") return `Superseded by ${r.superseded_by.join(", ")}`;
  const base = RULING_LABEL[r.ruling] ?? String(r.ruling);
  return r.superseded_by?.length ? `${base} — partly superseded by ${r.superseded_by.join(", ")}` : base;
}

function renderDecisionIndex(recs) {
  const L = [
    okf("index", "Decision records", "docs/decisions", ['description: "Every owner ruling on money, procurement, law and product scope, one file per ruling."']) + HEADER,
    "# Decision records\n",
    "The hospital owner's rulings on money, procurement, law and product scope, one numbered file per ruling, so people",
    "and agents working on HMIS can read why the system behaves as it does. This page is generated from each record's",
    "frontmatter: add a record, then run `" + REGEN + "`. Never edit this page by hand.\n",
    DECISION_RULE + "\n",
    "Records without ✓ were transcribed by an agent and await the owner's check.\n",
    "| # | Date | Title | Tags | Status | Verified |",
    "|---|---|---|---|---|---|",
  ];
  const cell = (s) => String(s).replace(/\|/g, "\\|");
  for (const r of recs) {
    const verified = Array.isArray(r.verified) && r.verified.some((v) => String(v?.by ?? "").startsWith("human:")) ? "✓" : "";
    L.push(`| ${r.id} | ${r.generated?.at ?? ""} | [${cell(r.title ?? "")}](${r.file}) | ${(r.tags ?? []).join(", ")} | ${rulingCell(r)} | ${verified} |`);
  }
  L.push("");
  return L.join("\n");
}

function renderDecisionReadme() {
  return [
    HEADER,
    "# Decision records\n",
    "The hospital owner's rulings on money, procurement, law and product scope, one numbered file per ruling.",
    "**The list is [index.md](index.md)**, generated from each record's frontmatter.\n",
    DECISION_RULE + "\n",
    "## Adding a decision\n",
    "1. Create `NNNN-short-slug.md` with the next free number (take it when you rebase, not when you start).",
    "2. Start it with the frontmatter below, then the H1 `# NNNN — Title` and the `Date / Status / Area` block.",
    "3. Run `" + REGEN + "` and commit the regenerated `index.md` with the record. Never edit `index.md` by hand;",
    "   a rebase conflict in it is resolved by regenerating.\n",
    DECISION_FRONTMATTER,
    "",
  ].join("\n");
}

const check = process.argv.includes("--check");
const notes = mapNoteProblems();
if (notes.length) {
  console.error(`module notes need attention:\n  ${notes.join("\n  ")}`);
  if (check) process.exit(1);
}
const { recs, problems: fmProblems, warnings } = readDecisions();
mapFrontmatterProblems(fmProblems, warnings);
for (const w of uniqSorted(warnings)) console.warn(`WARNING: ${w}`);
if (fmProblems.length) {
  console.error(`knowledge frontmatter needs attention:\n  ${uniqSorted(fmProblems).join("\n  ")}`);
  if (check) process.exit(1);
}
const decisionOut = new Map([
  ["index.md", renderDecisionIndex(recs)],
  ["README.md", renderDecisionReadme()],
]);
if (check) {
  const stale = [];
  for (const [name, body] of files) {
    const p = join(OUT, name);
    if (!existsSync(p) || read(p) !== body) stale.push(name);
  }
  const expected = new Set(files.keys());
  if (existsSync(join(OUT, "modules"))) {
    for (const n of readdirSync(join(OUT, "modules"))) if (!expected.has(`modules/${n}`)) stale.push(`modules/${n} (should not exist)`);
  }
  const staleDecisions = [...decisionOut].filter(([name, body]) => !existsSync(join(DECISIONS, name)) || read(join(DECISIONS, name)) !== body).map(([name]) => name);
  if (stale.length) console.error(`docs/architecture is stale: ${stale.join(", ")}\nRun: ${REGEN}  and commit the result.`);
  if (staleDecisions.length) console.error(`docs/decisions is stale: ${staleDecisions.join(", ")}\nRun: ${REGEN}  and commit the result.`);
  if (stale.length || staleDecisions.length) process.exit(1);
  console.log(`docs/architecture is current (${files.size} files); docs/decisions index is current (${recs.length} records).`);
} else {
  rmSync(join(OUT, "modules"), { recursive: true, force: true });
  mkdirSync(join(OUT, "modules"), { recursive: true });
  for (const [name, body] of files) writeFileSync(join(OUT, name), body);
  for (const [name, body] of decisionOut) writeFileSync(join(DECISIONS, name), body);
  console.log(`wrote ${files.size} files to ${rel(OUT)}/ and ${decisionOut.size} to ${rel(DECISIONS)}/`);
}
