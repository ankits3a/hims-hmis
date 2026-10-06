#!/usr/bin/env node
/**
 * Generates docs/architecture/ from the source tree. Nothing here is written by hand: every fact
 * is read from the code, so the map cannot drift from it. CI runs `--check` and fails when the
 * committed map differs from what this script produces.
 *
 *   node tools/arch/gen.mjs           # rewrite docs/architecture/
 *   node tools/arch/gen.mjs --check   # exit 1 if docs/architecture/ is stale
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
const kernelNames = dirs(KERNEL);

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
    for (const file of walk(join(base, name))) {
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

/** Public surface: names exported from a module's index.ts. */
function exportsOf(indexPath) {
  if (!existsSync(indexPath)) return { values: [], types: [] };
  const s = stripComments(read(indexPath));
  const values = [];
  const types = [];
  for (const m of s.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    for (const raw of m[2].split(",")) {
      const t = raw.trim();
      if (!t) continue;
      const isType = Boolean(m[1]) || t.startsWith("type ");
      const name = t.replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim();
      (isType ? types : values).push(name);
    }
  }
  for (const m of s.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(const|let|function\*?|class|enum|type|interface)\s+([A-Za-z0-9_$]+)/g)) {
    (m[1] === "type" || m[1] === "interface" ? types : values).push(m[2]);
  }
  for (const m of s.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) values.push(`* from ${m[1]}`);
  return { values: uniqSorted(values), types: uniqSorted(types) };
}

/** HTTP routes declared by controllers under `dir`. */
function routesIn(dir) {
  const routes = [];
  for (const file of walk(dir)) {
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
const mermaidId = (s) => s.replace(/[^A-Za-z0-9]/g, "_");
const list = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "—");

function renderReadme() {
  const L = [HEADER, "# HMIS architecture map\n"];
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
    const r = routesIn(join(MODULES, m)).length;
    const t = (tables.get(`${m}.ts`) ?? []).length;
    L.push(`| [${m}](modules/${m}.md) | ${depsOf(`module:${m}`, "module").join(", ") || "—"} | ${usedBy(`module:${m}`, "module").join(", ") || "—"} | ${r} | ${t} |`);
  }
  L.push("\n## Kernel subsystems\n");
  L.push("Shared platform code in `apps/core/src/kernel/`. Coordinate before editing (see CLAUDE.md).\n");
  L.push("| subsystem | used by modules | depends on kernel | routes |");
  L.push("|---|---|---|---|");
  for (const k of kernelNames) {
    const r = routesIn(join(KERNEL, k)).length;
    L.push(`| \`${k}\` | ${usedBy(`kernel:${k}`, "module").join(", ") || "—"} | ${depsOf(`kernel:${k}`, "kernel").join(", ") || "—"} | ${r || "—"} |`);
  }
  L.push("\nKernel HTTP routes: [kernel-routes.md](kernel-routes.md). Database: [schema.md](schema.md). Web screens: [web.md](web.md).\n");
  return L.join("\n");
}

function renderModule(m) {
  const unit = `module:${m}`;
  const ex = exportsOf(join(MODULES, m, "index.ts"));
  const routes = routesIn(join(MODULES, m));
  const own = tables.get(`${m}.ts`) ?? [];
  const L = [HEADER, `# module \`${m}\`\n`, `Source: \`apps/core/src/modules/${m}/\``];
  if (existsSync(join(MODULES, m, "MAP.md"))) L.push(`· Notes: [MAP.md](../../../apps/core/src/modules/${m}/MAP.md)`);
  L.push("");
  L.push(`- **Depends on modules:** ${list(depsOf(unit, "module"))}`);
  L.push(`- **Used by modules:** ${list(usedBy(unit, "module"))}`);
  L.push(`- **Kernel used:** ${list(depsOf(unit, "kernel"))}`);
  L.push("\n## Public API (`index.ts`)\n");
  L.push(`Values: ${list(ex.values)}\n`);
  L.push(`Types: ${list(ex.types)}\n`);
  L.push(`## Tables (\`kernel/db/schema/${m}.ts\`)\n`);
  L.push(own.length ? own.map((t) => `- \`${t.sql}\` (\`${t.name}\`)`).join("\n") : "None under this name.");
  if (own.length) L.push(`\nReferences tables in: ${list([...(fk.get(`${m}.ts`) ?? [])].sort(byName).map((f) => f.replace(/\.ts$/, "")))}`);
  L.push(`\n## HTTP routes (${routes.length})\n`);
  if (routes.length) {
    L.push("| verb | path | controller |\n|---|---|---|");
    for (const r of routes) L.push(`| ${r.verb} | \`${r.path}\` | \`${r.file.replace(`apps/core/src/modules/${m}/`, "")}\` |`);
  } else L.push("None.");
  L.push("");
  return L.join("\n");
}

function renderKernelRoutes() {
  const L = [HEADER, "# Kernel HTTP routes\n"];
  for (const k of kernelNames) {
    const routes = routesIn(join(KERNEL, k));
    if (!routes.length) continue;
    L.push(`## \`${k}\`\n`, "| verb | path | controller |", "|---|---|---|");
    for (const r of routes) L.push(`| ${r.verb} | \`${r.path}\` | \`${r.file.replace("apps/core/src/kernel/", "")}\` |`);
    L.push("");
  }
  const other = routesIn(join(CORE, "health"));
  if (other.length) {
    L.push("## `health`\n", "| verb | path | controller |", "|---|---|---|");
    for (const r of other) L.push(`| ${r.verb} | \`${r.path}\` | \`${r.file.replace("apps/core/src/", "")}\` |`);
    L.push("");
  }
  return L.join("\n");
}

function renderSchema() {
  const L = [HEADER, "# Database schema\n"];
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
  const L = [HEADER, "# Web routes\n", "From `apps/web/src/router.tsx`. Screen = the file the route's component comes from.\n"];
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

const check = process.argv.includes("--check");
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
  if (stale.length) {
    console.error(`docs/architecture is stale: ${stale.join(", ")}\nRun: ${REGEN}  and commit the result.`);
    process.exit(1);
  }
  console.log(`docs/architecture is current (${files.size} files).`);
} else {
  rmSync(join(OUT, "modules"), { recursive: true, force: true });
  mkdirSync(join(OUT, "modules"), { recursive: true });
  for (const [name, body] of files) writeFileSync(join(OUT, name), body);
  console.log(`wrote ${files.size} files to ${rel(OUT)}/`);
}
