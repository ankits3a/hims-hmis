#!/usr/bin/env node
/**
 * node tools/stage-standup.mjs — ONE COMMAND THAT STANDS STAGING UP AFTER A RESET (#776).
 *
 * A reset (docker/prod/uat-reset.sh) leaves staging with migrations, configuration seeds and nobody.
 * Every module the owner walks then stops at a census RED row: no opd_visit definition, no doctor,
 * no priced lab test, no drug on the shelf, no licence on file. This script performs those acts
 * with SYNTHETIC values, so a walk can start the same afternoon.
 *
 *   node tools/stage-standup.mjs            # every step, then the census
 *   STAGE_ONLY=pharmacy,lab node tools/stage-standup.mjs   # a subset of steps (names below)
 *
 * ═══ WHERE IT MAY RUN ═══
 * Staging only. It refuses unless the target host is stagehmis.* AND the api's own /api/health
 * reports an environment label that starts with "UAT", and it refuses a docker project or deploy
 * directory whose name carries "prod". It never runs against production.
 *
 * ═══ HOW IT ACTS ═══
 * Through the real HTTP API as named staging logins, or through the image's own compiled scripts
 * (`node dist/scripts/<x>.js`) behind the synthetic-data door. No raw SQL write, no bypassed
 * approval, guard, permission or audit write: every two-person rule is met by two people (`admin`
 * holds one key, `uat` the other, `stage.drafter` drafts what neither may draft).
 *
 * ═══ CREDENTIALS ═══
 * Read from the logins file (STAGE_LOGINS, default /opt/hmis-context/staging-logins-2026-10-25.txt,
 * mode 600, outside git): one `username  password  (note)` per line after a title line. Users this
 * script creates get a generated password that is appended to that file and to nothing else. No
 * password is ever printed.
 *
 * ═══ IDEMPOTENT ═══
 * Every step checks first and prints "already" or "done"; a failed step prints RED with the reason
 * and the run continues. The last lines are a summary and the census counts.
 *
 * ═══ SYNTHETIC VALUES ═══
 * Every invented value says so: names end "(staging)", licence numbers read
 * SYNTHETIC-LICENCE-<what>-2026-10-25, registration numbers SYNTHETIC-REG-<n>, GSTINs are
 * checksum-valid but made up (PAN letters ...S2026...). Rows that need a real outside contract
 * (an SMS/WhatsApp provider, DLT template ids, copilot model keys, a PACS archive) stay RED: no
 * provider key is invented here.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.STAGE_URL ?? "https://stagehmis.crkmch.com").replace(/\/+$/, "");
const LOGINS = process.env.STAGE_LOGINS ?? "/opt/hmis-context/staging-logins-2026-10-25.txt";
const PROJECT = process.env.HMIS_UAT_PROJECT ?? "hmis-uat";
const DEPLOY_DIR = process.env.HMIS_UAT_DEPLOY_DIR ?? "/opt/hmis-uat";
const ONLY = (process.env.STAGE_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const TAG = "2026-10-25";
const SYN = "SYNTHETIC (staging)";

// ═══ guards ═══════════════════════════════════════════════════════════════════════════════════
function die(msg) { console.error(`stage-standup: REFUSED — ${msg}`); process.exit(2); }
const host = new URL(BASE).hostname;
if (!/^stagehmis\./.test(host)) die(`target host is "${host}"; this script only runs against stagehmis.*`);
if (/prod/i.test(PROJECT) || /prod/i.test(DEPLOY_DIR)) die(`docker project "${PROJECT}" / "${DEPLOY_DIR}" looks like production`);

// ═══ dates (IST) ══════════════════════════════════════════════════════════════════════════════
const istNow = () => new Date(Date.now() + 330 * 60_000);
const istDate = (addDays = 0) => new Date(istNow().getTime() + addDays * 86_400_000).toISOString().slice(0, 10);
const addYears = (iso, n) => `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`;
const TODAY = istDate();

// ═══ logins ═══════════════════════════════════════════════════════════════════════════════════
function readLogins() {
  const mode = statSync(LOGINS).mode & 0o077;
  if (mode !== 0) die(`${LOGINS} is readable by group/other; chmod 600 it`);
  const out = {};
  for (const line of readFileSync(LOGINS, "utf8").split("\n").slice(1)) {
    const [u, p] = line.trim().split(/\s+/);
    if (u && p) out[u] = p;
  }
  return out;
}
let creds = readLogins();
for (const u of ["admin", "uat"]) if (!creds[u]) die(`${LOGINS} has no line for "${u}"`);

// ═══ HTTP ═════════════════════════════════════════════════════════════════════════════════════
const tokens = {};
async function login(user) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: creds[user] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error(`login as ${user} failed (${r.status} ${j.code ?? j.message ?? ""})`);
  tokens[user] = j.token;
}
/** `api(user, "POST", "/x", body)` → `{ status, ok, body }`; never throws on an HTTP status. */
async function api(user, method, path, body) {
  if (!tokens[user]) await login(user);
  const go = () => fetch(`${BASE}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[user]}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let r = await go();
  if (r.status === 401) { await login(user); r = await go(); }
  const text = await r.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, ok: r.ok, body: parsed };
}
/** Same, but throws with the server's own refusal on a non-2xx. */
async function must(user, method, path, body) {
  const r = await api(user, method, path, body);
  if (!r.ok) throw new Error(`${method} ${path} as ${user} → ${r.status} ${short(r.body)}`);
  return r.body;
}
const short = (b) => (typeof b === "string" ? b : JSON.stringify(b)).slice(0, 400);
const listOf = (j, k) => (Array.isArray(j) ? j : j?.[k] ?? j?.items ?? j?.rows ?? []);
const errCode = (r) => (r.body && typeof r.body === "object" ? r.body.code ?? r.body.error?.code ?? r.body.message?.code : undefined);

// ═══ the image's own scripts ═════════════════════════════════════════════════════════════════
const composeArgs = ["compose", "-p", PROJECT, "-f", `${DEPLOY_DIR}/docker-compose.prod.yml`,
  "-f", `${DEPLOY_DIR}/docker-compose.uat.yml`, "--project-directory", DEPLOY_DIR];
/** `compose run --rm` a dist script (a fresh container from the running image, with the deploy .env). */
function runScript(script, args = [], { env = {}, stdin, mounts = [] } = {}) {
  const a = [...composeArgs, "run", "--rm", "-T"];
  for (const [k, v] of Object.entries(env)) a.push("-e", `${k}=${v}`);
  for (const m of mounts) a.push("-v", m);
  a.push("api", "node", `dist/scripts/${script}`, ...args);
  const r = spawnSync("docker", a, { input: stdin, encoding: "utf8", maxBuffer: 64 << 20 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").filter((l) => !/^\s*Container \S+ (Creat|Start|Run|Wait|Health|Stop|Remov)/.test(l)).join("\n");
  return { code: r.status, out };
}
/** Read-only: evaluate an expression inside the running api container (definition JSON). */
function imageJson(expr) {
  const out = execFileSync("docker", [...composeArgs, "exec", "-T", "api", "node", "-e",
    `process.stdout.write(JSON.stringify(${expr}))`], { encoding: "utf8", maxBuffer: 64 << 20 });
  return JSON.parse(out);
}

// ═══ step runner ══════════════════════════════════════════════════════════════════════════════
const results = [];
async function step(name, group, fn) {
  if (ONLY.length > 0 && !ONLY.includes(group)) return;
  process.stdout.write(`── ${group}: ${name} … `);
  try {
    const r = (await fn()) ?? "done";
    console.log(r);
    results.push({ name, group, state: r.startsWith("already") ? "already" : r.startsWith("RED") ? "RED" : "done", note: r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`RED — ${msg}`);
    results.push({ name, group, state: "RED", note: msg });
  }
}

// ═══ people ═══════════════════════════════════════════════════════════════════════════════════
const ROLES = {
  // Every "assign role X" census row goes to admin; lab ones also to pathologist (owner 2026-10-25).
  admin: [
    "opd_admin", "materials_head", "storekeeper", "pharmacy_incharge", "pharmacy", "antimicrobial_steward",
    "ot_incharge", "surgeon", "anaesthetist", "daycare_coordinator", "ot_nurse", "recovery_nurse",
    "pcpndt_incharge", "radiation_safety_officer", "radiologist", "radiographer", "radiology_receptionist",
    "duty_manager", "front_office_supervisor", "vitals_desk", "quality_manager", "mrd_officer",
    "membership_admin", "attendance_committee",
  ],
  uat: ["tariff_editor", "surgeon"],
  pathologist: ["lab_technician", "lab_reception"],
};
/** Users this script creates (seed:staff, stdin). Doctors carry the role `doctor`. */
const NEW_USERS = [
  { username: "stage.drafter", fullName: "Workflow drafter (staging)", roles: ["opd_admin"] },
  { username: "dr.medicine", fullName: "Dr Medicine (staging)", roles: ["doctor"], dept: "MED" },
  { username: "dr.surgery", fullName: "Dr Surgery (staging)", roles: ["doctor", "surgeon"], dept: "SUR" },
  { username: "dr.ent", fullName: "Dr ENT (staging)", roles: ["doctor"], dept: "ENT" },
  { username: "dr.obg", fullName: "Dr Obstetrics (staging)", roles: ["doctor", "surgeon"], dept: "OBG" },
  { username: "dr.ortho", fullName: "Dr Orthopaedics (staging)", roles: ["doctor", "surgeon"], dept: "ORT" },
  { username: "dr.paeds", fullName: "Dr Paediatrics (staging)", roles: ["doctor"], dept: "PED" },
  { username: "dr.derm", fullName: "Dr Dermatology (staging)", roles: ["doctor"], dept: "DER" },
  { username: "dr.ophth", fullName: "Dr Ophthalmology (staging)", roles: ["doctor"], dept: "OPH" },
  { username: "dr.psych", fullName: "Dr Psychiatry (staging)", roles: ["doctor"], dept: "PSY" },
];
/** OPD doctor profiles: department → users. The pathologist of record sits in LAB. */
const DOCTORS = [
  ...NEW_USERS.filter((u) => u.dept).map((u) => ({ username: u.username, displayName: u.fullName, dept: u.dept })),
  { username: "uat", displayName: "Dr UAT (staging)", dept: "MED" },
  { username: "pathologist", displayName: "Dr Pathologist (staging)", dept: "LAB", specialty: "Pathology" },
];
/**
 * ONE doctor in LAB: with two, the lab walk-in counter refuses until a person names the pathologist
 * of record (encounters.ts), and seed-lab-demo stops there. `admin` holds the pathologist ROLE (it
 * verifies and releases) but no LAB doctor profile; an earlier run's profile is deactivated.
 */
const NOT_LAB_DOCTORS = ["admin"];

let userIds = {};
async function refreshUsers() {
  const j = await must("admin", "GET", "/admin/users");
  userIds = Object.fromEntries(j.users.map((u) => [u.username, { id: u.id, roles: new Set(u.roles.map((r) => r.roleKey)), active: u.active }]));
}
const uid = (u) => { const x = userIds[u]; if (!x) throw new Error(`no user ${u}`); return x.id; };

async function stepUsers() {
  await refreshUsers();
  const missing = NEW_USERS.filter((u) => !userIds[u.username]);
  if (missing.length === 0) return "already";
  const roster = missing.map((u) => {
    if (!creds[u.username]) {
      const pw = `Stg-${randomBytes(12).toString("base64url")}`;
      appendFileSync(LOGINS, `${u.username}  ${pw}  (${u.fullName}; created by tools/stage-standup.mjs)\n`, { mode: 0o600 });
      creds[u.username] = pw;
    }
    return { username: u.username, fullName: u.fullName, password: creds[u.username], roles: u.roles };
  });
  const r = runScript("seed-staff.js", [], { stdin: JSON.stringify(roster) });
  if (r.code !== 0) throw new Error(`seed-staff exit ${r.code}: ${r.out.split("\n").filter(Boolean).slice(-3).join(" | ")}`);
  await refreshUsers();
  return `done — created ${missing.map((u) => u.username).join(", ")}`;
}

async function stepRoles() {
  await refreshUsers();
  const added = [];
  const plan = { ...ROLES };
  for (const u of NEW_USERS) plan[u.username] = [...new Set([...(plan[u.username] ?? []), ...u.roles])];
  for (const [user, roles] of Object.entries(plan)) {
    for (const roleKey of roles) {
      if (userIds[user]?.roles.has(roleKey)) continue;
      await must("admin", "POST", `/admin/users/${uid(user)}/roles`, { roleKey, scopeType: "hospital" });
      added.push(`${user}+${roleKey}`);
    }
  }
  await refreshUsers();
  return added.length === 0 ? "already" : `done — ${added.join(", ")}`;
}

// ═══ establishment ═══════════════════════════════════════════════════════════════════════════
/** A syntactically valid GSTIN: 2-digit state, PAN, entity, Z, mod-36 checksum. */
function gstin(state, pan, entity = "1") {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const base = `${state}${pan}${entity}Z`;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const p = chars.indexOf(base[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return base + chars[(36 - (sum % 36)) % 36];
}
const HOSPITAL_GSTIN = gstin("10", "AAATS2026H");
const VENDOR_PAN = "AAACS2026V";
const VENDOR_GSTIN = gstin("10", VENDOR_PAN);

async function stepEstablishment() {
  const args = ["--gstin", HOSPITAL_GSTIN, "--legal-name", "Staging Hospital Trust (synthetic)", "--as", "admin"];
  const dry = runScript("set-establishment-gst.js", args);
  if (dry.code !== 0) throw new Error(oneLine(dry.out));
  const before = /before\s+(.*)/.exec(dry.out)?.[1]; const after = /after\s+(.*)/.exec(dry.out)?.[1];
  if (before !== undefined && before === after) return "already";
  const r = runScript("set-establishment-gst.js", [...args, "--apply"]);
  if (r.code !== 0) throw new Error(oneLine(r.out));
  return `done — GSTIN ${HOSPITAL_GSTIN}`;
}

// ═══ Class A workflow definitions: drafter ≠ approvers ≠ … ; owner activates ══════════════════
async function activateDefinition(defKey, json) {
  const list = (await must("admin", "GET", `/workflow/definitions?key=${defKey}`)).definitions ?? [];
  if (list.some((d) => d.status === "active")) return "already";
  let def = list.find((d) => d.status === "draft" || d.status === "approved");
  let id = def?.id ?? def?.definitionId;
  if (!id) {
    const body = typeof json === "function" ? await json() : json;
    id = (await must("stage.drafter", "POST", "/workflow/definitions", body)).definitionId;
  }
  for (const [user, roleKey] of [["admin", "medical_superintendent"], ["uat", "owner"]]) {
    const r = await api(user, "POST", `/workflow/definitions/${id}/approve`, { roleKey, note: `${SYN} stand-up approval` });
    if (!r.ok && errCode(r) !== "duplicate_approval") throw new Error(`approve as ${roleKey} → ${r.status} ${short(r.body)}`);
  }
  await must("uat", "POST", `/workflow/definitions/${id}/activate`);
  return "done";
}

// ═══ OPD ══════════════════════════════════════════════════════════════════════════════════════
let depts = {};
async function refreshDepts() {
  const j = await must("admin", "GET", "/opd/departments");
  depts = Object.fromEntries(listOf(j, "departments").map((d) => [d.code, d]));
}
async function stepDepartments() {
  await refreshDepts();
  const made = [];
  for (const [code, name] of [["LAB", "Laboratory"], ["MED", "General Medicine"], ["SUR", "General Surgery"],
    ["ENT", "ENT"], ["OBG", "Obstetrics & Gynaecology"], ["ORT", "Orthopaedics"], ["PED", "Paediatrics"],
    ["DER", "Dermatology"], ["OPH", "Ophthalmology"], ["PSY", "Psychiatry"]]) {
    const d = depts[code];
    if (!d) { await must("admin", "POST", "/opd/departments", { code, name }); made.push(code); }
    else if (d.active === false) { await must("admin", "PATCH", `/opd/departments/${d.id}`, { active: true }); made.push(`${code}(reactivated)`); }
  }
  await refreshDepts();
  return made.length === 0 ? "already" : `done — ${made.join(", ")}`;
}
async function stepDoctors() {
  await refreshDepts();
  const j = await must("admin", "GET", "/opd/doctors");
  const have = new Map(listOf(j, "doctors").flatMap((d) => [[d.username, d], [d.userId, d]]));
  const made = [];
  let n = 0;
  for (const doc of DOCTORS) {
    n += 1;
    const dept = depts[doc.dept];
    if (!dept) throw new Error(`no department ${doc.dept}`);
    const registrationNo = `SYNTHETIC-REG-${100 + n}`;
    const existing = have.get(doc.username) ?? have.get(userIds[doc.username]?.id);
    if (existing) {
      const patch = {};
      if (!existing.registrationNo) patch.registrationNo = registrationNo;
      if (existing.active === false) patch.active = true;
      if (Object.keys(patch).length > 0) { await must("admin", "PATCH", `/opd/doctors/${existing.id}`, patch); made.push(`${doc.username}(updated)`); }
      continue;
    }
    await must("admin", "POST", "/opd/doctors", {
      username: doc.username, displayName: doc.displayName, departmentId: dept.id, registrationNo,
      ...(doc.specialty ? { specialty: doc.specialty } : {}),
    });
    made.push(`${doc.username}@${doc.dept}`);
  }
  for (const u of NOT_LAB_DOCTORS) {
    const d = have.get(u) ?? have.get(userIds[u]?.id);
    if (d && d.active !== false && d.departmentId === depts.LAB?.id) {
      await must("admin", "PATCH", `/opd/doctors/${d.id}`, { active: false });
      made.push(`${u}@LAB(deactivated)`);
    }
  }
  return made.length === 0 ? "already" : `done — ${made.join(", ")}`;
}

// ═══ lab ══════════════════════════════════════════════════════════════════════════════════════
async function stepLabPrices() {
  const dry = runScript("set-lab-prices.js", ["--by", "uat"]);
  if (dry.code !== 0) throw new Error(dry.out.split("\n").filter(Boolean).slice(-2).join(" | "));
  const plan = JSON.parse(/\{.*\}/.exec(dry.out)?.[0] ?? "{}");
  if (plan.priced === 0) return `already — ${plan.unchanged} lab prices in force`;
  const r = runScript("set-lab-prices.js", ["--by", "uat", "--apply"]);
  if (r.code !== 0) throw new Error(r.out.split("\n").filter(Boolean).slice(-2).join(" | "));
  return `done — ${oneLine(r.out)}`;
}

/** Text bands for descriptive analytes, textbook bands for the few numeric ones the catalogue left bare. */
const NUMERIC_BANDS = {
  GRAN: ["40", "75"], MID: ["1", "15"], GRAN_ABS: ["2", "7.5"], MID_ABS: ["0.1", "1.5"], U24_UUN: ["12", "20"],
};
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
async function stepLabRanges() {
  const cat = await must("admin", "GET", "/lab/quick/catalogue");
  const analyteIds = [...new Set(cat.tests.flatMap((t) => t.analyteIds))];
  const bare = (await pool(analyteIds, 12, async (id) => {
    const r = await must("admin", "GET", `/lab/catalogue/analytes/${id}/ranges`);
    return (Array.isArray(r) ? r : r.ranges ?? []).length === 0 ? id : null;
  })).filter(Boolean);
  if (bare.length === 0) return "already";
  // analyte details (code, result type) come from an orderable that carries it
  const meta = {};
  for (const t of cat.tests) {
    if (!t.analyteIds.some((a) => bare.includes(a) && !meta[a])) continue;
    const o = await must("admin", "GET", `/lab/catalogue/orderables/${t.serviceId}`);
    for (const a of o.analytes ?? []) {
      const id = a.id ?? a.analyteId;
      if (bare.includes(id)) meta[id] = a;
    }
  }
  let written = 0;
  for (const id of bare) {
    const a = meta[id] ?? {};
    const band = NUMERIC_BANDS[a.code];
    const body = {
      sex: "any", ageMinDays: 0, ageMaxDays: 40000, effectiveFrom: TODAY,
      ...(band
        ? { low: band[0], high: band[1], source: `${SYN}: textbook adult interval, not verified by a pathologist` }
        : { text: "Descriptive — see report", source: `${SYN}: descriptive finding, no numeric reference interval` }),
    };
    await must("admin", "POST", `/lab/catalogue/analytes/${id}/ranges`, body);
    written += 1;
  }
  return `done — ${written} bands`;
}
async function stepLabBenches() {
  const pathologistLogin = userIds.pathologist ? "pathologist" : "admin";
  const r = runScript("seed-lab-synthetic.js", [], {
    env: { SYNTHETIC_PATHOLOGIST: pathologistLogin },
    mounts: [`${REPO}/apps/core/scripts/synthetic/lab:/app/apps/core/dist/scripts/synthetic/lab:ro`],
  });
  const line = r.out.split("\n").find((l) => l.includes('"lab-synthetic"'));
  if (!line) throw new Error(`seed-lab-synthetic exit ${r.code}: ${r.out.split("\n").filter(Boolean).slice(-2).join(" | ")}`);
  const j = JSON.parse(line);
  return j.benchesCreated.length + j.instrumentsRegistered.length === 0
    ? "already"
    : `done — ${j.benchesCreated.length} benches, ${j.instrumentsRegistered.length} analysers${j.unknownAnalytes.length ? ` (unknown codes: ${j.unknownAnalytes.length})` : ""}`;
}
async function stepLabDemo() {
  const r = runScript("seed-lab-demo.js", [], { env: { ALLOW_DEMO_DATA: "yes", SEED_ACTOR_ID: uid("admin") } });
  if (r.code !== 0) throw new Error(r.out.split("\n").filter(Boolean).slice(-2).join(" | "));
  return /already|0 created|skipped/i.test(r.out) && !/created: [1-9]/.test(r.out) ? `already — ${oneLine(r.out)}` : `done — ${oneLine(r.out)}`;
}
const oneLine = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean).slice(-4).join("; ").slice(0, 300);

// ═══ roster ═══════════════════════════════════════════════════════════════════════════════════
async function stepRosterMasters() {
  const r = runScript("seed-roster.js");
  if (r.code !== 0) throw new Error(oneLine(r.out));
  const added = [...r.out.matchAll(/: (\d+) added/g)].reduce((n, m) => n + Number(m[1]), 0);
  return added === 0 ? "already — departments, positions, units and rules present" : `done — ${added} master rows added`;
}
async function stepRosterDemo() {
  const r = runScript("seed-roster-demo.js", [], { env: { ALLOW_DEMO_DATA: "yes" } });
  if (r.code !== 0) throw new Error(oneLine(r.out));
  const n = (k) => /^\s*(\d+)/.exec(new RegExp(`${k}:([^\\n]*)`).exec(r.out)?.[1] ?? "")?.[1] ?? "0";
  const units = n("unitsConfirmed"); const slots = n("slotsAssigned");
  return units === "0" && slots === "0" && /cyclesPublished: —/.test(r.out)
    ? "already — every department with a doctor has its cycle and roster"
    : `done — ${units} units confirmed, ${slots} duty slots assigned`;
}
async function stepAebas() {
  // A declared holiday a month out, marked entered in AEBAS straight away (else the row goes RED on its eve).
  const aebas = await must("admin", "GET", "/roster/aebas");
  if ((aebas.recentlyEntered ?? []).some((e) => e.kind === "holiday" && e.firstDay >= TODAY) && (aebas.items ?? []).length === 0) return "already";
  const decl = await must("admin", "GET", "/roster/declarations");
  let date = (decl.holidays ?? []).map((h) => h.istDate).find((d) => d >= TODAY);
  if (!date) {
    date = istDate(30);
    await must("admin", "POST", "/roster/holidays", { istDate: date, kind: "declared", pattern: "as_sunday" });
  }
  for (const it of aebas.items ?? []) {
    if (it.kind === "holiday") await api("admin", "POST", `/roster/aebas/holidays/${it.firstDay}/entered`);
  }
  const r = await api("admin", "POST", `/roster/aebas/holidays/${date}/entered`);
  if (!r.ok && r.status !== 409) throw new Error(`${r.status} ${short(r.body)}`);
  return "done";
}

// ═══ pharmacy ═════════════════════════════════════════════════════════════════════════════════
const DRUGS = [
  { code: "STG-PCM500", name: "Paracetamol 500 mg tablet (staging)", base: "tablet", mrp: 2500, cost: 150, q: "paracetamol 500 mg oral tablet", form: "Oral tablet" },
  { code: "STG-AMX500", name: "Amoxicillin 500 mg capsule (staging)", base: "capsule", mrp: 8500, cost: 500, q: "amoxicillin 500 mg oral capsule", form: "Oral capsule" },
  { code: "STG-PAN040", name: "Pantoprazole 40 mg tablet (staging)", base: "tablet", mrp: 11000, cost: 620, q: "pantoprazole 40 mg gastro-resistant oral tablet", form: "Gastro-resistant oral tablet" },
  { code: "STG-MET500", name: "Metformin 500 mg tablet (staging)", base: "tablet", mrp: 6000, cost: 340, q: "metformin hydrochloride 500 mg oral tablet", form: "Oral tablet" },
  { code: "STG-CTZ010", name: "Cetirizine 10 mg tablet (staging)", base: "tablet", mrp: 3500, cost: 180, q: "cetirizine hydrochloride 10 mg oral tablet", form: "Oral tablet" },
  { code: "STG-AML005", name: "Amlodipine 5 mg tablet (staging)", base: "tablet", mrp: 4500, cost: 250, q: "amlodipine 5 mg oral tablet", form: "Oral tablet" },
];
let stores = {};
async function refreshStores() {
  const j = await must("admin", "GET", "/materials/stores");
  stores = Object.fromEntries((Array.isArray(j) ? j : j.stores ?? []).map((s) => [s.code, s]));
}
let itemIds = {};
async function findItem(code) {
  return listOf(await must("admin", "GET", `/materials/items?class=drug&search=${encodeURIComponent(code)}`), "items")
    .find((i) => i.code === code);
}
async function ensureItemIds() {
  for (const d of DRUGS) if (!itemIds[d.code]) { const f = await findItem(d.code); if (f) itemIds[d.code] = f.id; }
  const missing = DRUGS.filter((d) => !itemIds[d.code]).map((d) => d.code);
  if (missing.length > 0) throw new Error(`drug items missing: ${missing.join(", ")}`);
}
/** The formulary product an item stocks (DD3: composition and schedule live there, never on the item). */
async function formularyMedicine(d) {
  const hits = listOf(await must("uat", "GET", `/formulary/medicines/search?q=${encodeURIComponent(d.q)}&limit=10`), "items");
  const strength = /(\d+(?:\.\d+)?) mg/.exec(d.q)?.[1];
  const hit = hits.find((h) => h.form === d.form && (!strength || h.strength === `${strength} mg`)) ?? hits[0];
  if (!hit) throw new Error(`no formulary medicine for "${d.q}" — load the formulary first (step formulary)`);
  return hit.id;
}
async function stepDrugItems() {
  const made = [];
  for (const d of DRUGS) {
    const found = await findItem(d.code);
    if (found) { itemIds[d.code] = found.id; continue; }
    const r = await must("admin", "POST", "/materials/items", {
      code: d.code, name: d.name, class: "drug", baseUom: d.base, batchTracked: true, hsnCode: "3004", shelfLifeDays: 1095,
      formularyMedicineId: await formularyMedicine(d),
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
    });
    itemIds[d.code] = r.id ?? r.itemId;
    made.push(d.code);
  }
  return made.length === 0 ? "already" : `done — ${made.join(", ")}`;
}
async function stepSaleItems() {
  await ensureItemIds();
  const made = [];
  for (const d of DRUGS) {
    const r = await api("uat", "POST", "/pharmacy/sale-items", { itemId: itemIds[d.code] });
    if (r.ok) made.push(d.code);
    else if (errCode(r) !== "sale_item_exists") throw new Error(`${d.code} → ${r.status} ${short(r.body)}`);
  }
  return made.length === 0 ? "already" : `done — ${made.join(", ")}`;
}
async function stepGstSlabs() {
  const r = await must("uat", "POST", "/pharmacy/sale-items/gst-plan/apply", {});
  if (!r.slabsSet && !r.categoriesSynced) return "already — every drug has its slab";
  return `done — ${r.slabsSet} slabs, ${r.categoriesSynced} sale categories`;
}
async function stepVendor() {
  const found = listOf(await must("admin", "GET", "/materials/vendors?search=STG-PHARMA"), "vendors").find((v) => v.code === "STG-PHARMA-DIST");
  let id = found?.id;
  if (found?.status === "active" || found?.active === true) return "already";
  if (!id) {
    id = (await must("admin", "POST", "/materials/vendors", {
      code: "STG-PHARMA-DIST", legalName: "Synthetic Pharma Distributors (staging)", tradeName: "Synthetic Pharma (staging)",
      gstin: VENDOR_GSTIN, pan: VENDOR_PAN, paymentTermsDays: 30, classFlags: { drugLicensed: true },
    })).vendorId;
  }
  for (const [type, number] of [["gst_certificate", VENDOR_GSTIN], ["pan", VENDOR_PAN],
    ["drug_licence_20b", `SYNTHETIC-LICENCE-20B-${TAG}`], ["drug_licence_21b", `SYNTHETIC-LICENCE-21B-${TAG}`]]) {
    const r = await api("admin", "POST", `/materials/vendors/${id}/documents`, { type, number, validFrom: null, validTo: null });
    if (!r.ok && r.status !== 409) throw new Error(`document ${type} → ${r.status} ${short(r.body)}`);
  }
  await must("admin", "POST", `/materials/vendors/${id}/activate`);
  return "done";
}
async function stepGrn() {
  await refreshStores();
  const store = stores["PHARM-OPD"];
  if (!store) throw new Error("no PHARM-OPD store");
  const vendor = listOf(await must("admin", "GET", "/materials/vendors?search=STG-PHARMA"), "vendors").find((v) => v.code === "STG-PHARMA-DIST");
  if (!vendor) throw new Error("no synthetic vendor");
  await ensureItemIds();
  const grns = listOf(await must("admin", "GET", `/materials/grns?vendorId=${vendor.id}&storeResourceId=${store.id}`), "grns");
  let grn = grns.find((g) => g.challanNo === "STG/2026/001");
  if (grn && grn.status === "posted") return "already";
  if (!grn) {
    const expiry = istDate(730);
    grn = await must("admin", "POST", "/materials/grns", {
      vendorId: vendor.id, source: "challan", storeResourceId: store.id, challanNo: "STG/2026/001", challanDate: TODAY,
      invoiceNo: "STG-INV-0001",
      lines: DRUGS.map((d, i) => ({
        itemId: itemIds[d.code], uom: "strip", qtyInUom: 50, batchNo: `STG-${d.code.slice(4)}-B${i + 1}`,
        expiryDate: expiry, mrpPaise: d.mrp, mrpUom: "strip", unitCostPaise: d.cost,
      })),
    });
  }
  const id = grn.id ?? grn.grnId;
  const qc = await api("uat", "POST", `/materials/grns/${id}/qc`, {});
  if (!qc.ok && qc.status !== 409) throw new Error(`qc → ${qc.status} ${short(qc.body)}`);
  await must("uat", "POST", `/materials/grns/${id}/post`, {});
  return "done";
}
async function stepPharmacists() {
  const made = [];
  const list = await must("admin", "GET", "/pharmacy/pharmacists");
  const rows = listOf(list, "pharmacists");
  let n = 0;
  for (const [filer, target] of [["uat", "admin"], ["admin", "uat"]]) {
    n += 1;
    const row = rows.find((p) => (p.userId ?? p.id) === uid(target));
    if (row && (row.registration ?? row.current ?? row.registrationNo)) continue;
    const r = await api(filer, "POST", `/pharmacy/pharmacists/${uid(target)}/registrations`, {
      council: "Bihar State Pharmacy Council (synthetic)", registrationNo: `SYNTHETIC-REG-PH-${n}`, validUntil: null,
    });
    if (!r.ok && !["registration_in_use", "registration_exists"].includes(errCode(r))) throw new Error(`${target} → ${r.status} ${short(r.body)}`);
    if (r.ok) made.push(target);
  }
  return made.length === 0 ? "already" : `done — ${made.join(", ")}`;
}
async function stepRetailLicence() {
  const cur = await must("admin", "GET", "/pharmacy/retail/licences");
  if (cur?.state === "current" || listOf(cur, "licences").some((l) => l.validFrom <= TODAY && TODAY <= l.validTo)) return "already";
  await must("admin", "POST", "/pharmacy/retail/licences", {
    form20No: `SYNTHETIC-LICENCE-FORM20-${TAG}`, form21No: `SYNTHETIC-LICENCE-FORM21-${TAG}`,
    validFrom: istDate(-30), validTo: addYears(istDate(-30), 5), pharmacistInCharge: "Pharmacist in charge (staging)",
    note: SYN,
  });
  return "done";
}
async function stepControlledLicences() {
  const cur = await must("admin", "GET", "/pharmacy/controlled/licences");
  const rows = listOf(cur, "licences");
  const made = [];
  for (const [kind, form, years] of [["ndps_rmi", "3G", 3], ["schedule_x", "20F", 5]]) {
    if (rows.some((l) => l.kind === kind && (l.state ?? "current") === "current")) continue;
    await must("admin", "POST", "/pharmacy/controlled/licences", {
      kind, form, licenceNo: `SYNTHETIC-LICENCE-${form}-${TAG}`, issuingAuthority: "State Drugs Controller (synthetic)",
      holderName: "Staging Hospital Trust (synthetic)", responsiblePerson: "Pharmacist in charge (staging)",
      validFrom: istDate(-30), validUntil: addYears(istDate(-31), years), note: SYN,
    });
    made.push(form);
  }
  return made.length === 0 ? "already" : `done — ${made.join(", ")}`;
}
async function stepEndPrescriber() {
  const j = await must("admin", "GET", "/pharmacy/controlled/prescribers");
  if (listOf(j, "current").length > 0) return "already";
  const doc = (j.doctors ?? []).find((d) => /medicine|uat/i.test(`${d.displayName ?? d.name ?? ""}`)) ?? (j.doctors ?? [])[0];
  if (!doc) throw new Error("no doctor to record");
  await must("admin", "POST", "/pharmacy/controlled/prescribers", {
    doctorId: doc.id ?? doc.doctorId, training: `${SYN}: essential narcotic drugs / pain management course, 2026`,
  });
  return "done";
}
async function stepTally() {
  // pharmacy.tally.export: the owner's and the billing manager's (uat), not the pharmacy in-charge's
  const cur = await api("uat", "GET", "/pharmacy/office/tally/ledgers");
  if (cur.ok && cur.body?.confirmed === true) return "already";
  await must("uat", "PUT", "/pharmacy/office/tally/ledgers", {
    companyName: "Staging Hospital Trust (synthetic)", sales: "Pharmacy Sales", salesReturns: "Pharmacy Sales Returns",
    outputCgst: "Output CGST", outputSgst: "Output SGST", purchases: "Pharmacy Purchases", purchaseReturns: "Purchase Returns",
    inputCgst: "Input CGST", inputSgst: "Input SGST", inputIgst: "Input IGST", cash: "Cash", bank: "Bank Account",
    roundOff: "Round Off", returnShortfall: "Return Shortfall", counterSales: "Counter Sales",
  });
  return "done";
}

// ═══ formulary: the owner's drug catalogue (same importer production ran), when its bundle is on this host ═══
const CDS_BUNDLE = process.env.CDS_BUNDLE ?? "/opt/hmis-context/cds-bundle/cds-bundle.sql";
async function stepFormulary() {
  const probe = listOf(await must("uat", "GET", "/formulary/medicines/search?q=paracetamol&limit=1"), "items");
  if (probe.length > 0) return "already";
  try { statSync(CDS_BUNDLE); } catch { return `RED — formulary empty and no catalogue bundle at ${CDS_BUNDLE} (set CDS_BUNDLE)`; }
  const r = runScript("import-cds-catalogue.js", ["--bundle", "/bundle/cds-bundle.sql", "--apply"], {
    mounts: [`${CDS_BUNDLE}:/bundle/cds-bundle.sql:ro`],
  });
  if (r.code !== 0) throw new Error(oneLine(r.out));
  return `done — ${r.out.split("\n").find((l) => l.startsWith("APPLIED")) ?? oneLine(r.out)}`;
}
async function stepScheduleFlags() {
  const dry = runScript("set-schedule-flags.js", ["--as", "uat"]);
  if (dry.code !== 0) throw new Error(oneLine(dry.out));
  if (/verdicts: set 0 /.test(dry.out)) return "already";
  const r = runScript("set-schedule-flags.js", ["--as", "uat", "--apply"]);
  if (r.code !== 0) throw new Error(oneLine(r.out));
  return `done — ${oneLine(r.out)}`;
}

// ═══ ER satellite store: a transfer from PHARM-OPD, issued by one person, received by another ══
async function stepErStock() {
  await refreshStores();
  const from = stores["PHARM-OPD"]; const to = stores["ER-SAT"];
  if (!to) throw new Error("no ER-SAT store (stage-er-setup not run?)");
  await ensureItemIds();
  const bal = listOf(await must("admin", "GET", `/materials/stock/balances?resourceId=${to.id}`), "balances");
  if (bal.some((b) => Number(b.qtyOnHand ?? 0) > 0)) return "already";
  const pending = listOf(await must("admin", "GET", `/materials/transfers?toResourceId=${to.id}`), "transfers")
    .find((t) => t.status === "in_transit");
  let t = pending;
  if (!t) {
    t = await must("admin", "POST", "/materials/transfers", {
      fromResourceId: from.id, toResourceId: to.id, note: `${SYN} ER satellite opening stock`,
      lines: ["STG-PCM500", "STG-PAN040", "STG-CTZ010"].map((c) => ({ itemId: itemIds[c], qtyBase: 100 })),
    });
  }
  const id = t.transferId ?? t.id;
  const detail = await must("admin", "GET", `/materials/transfers/${id}`);
  await must("uat", "POST", `/materials/transfers/${id}/receive`, {
    lines: (detail.transfer ?? detail).lines.map((l) => ({ lineId: l.id, qtyReceived: Number(l.qtyIssued) })),
  });
  return "done";
}

// ═══ OT ═══════════════════════════════════════════════════════════════════════════════════════
async function otPublish(kind, body) {
  const cur = await api("admin", "GET", `/ot/definitions/${kind}`);
  if (cur.ok && cur.body && (cur.body.id || cur.body.definitionId || cur.body.status === "active")) return "already";
  const d = await must("admin", "POST", "/ot/definitions/draft", { kind, body });
  const defId = d.id ?? d.definitionId;
  const { approvalId } = await must("admin", "POST", `/ot/definitions/${defId}/request-publish`, {});
  await must("uat", "POST", `/approvals/${approvalId}/approve`, { note: `${SYN} stand-up approval` });
  await must("admin", "POST", `/ot/definitions/${defId}/publish`, { approvalId });
  return "done";
}

// ═══ radiology / AERB / PCPNDT ══════════════════════════════════════════════════════════════
async function radiologyBook(kind, body) {
  const cur = await api("admin", "GET", `/radiology/definitions/${kind}/active`);
  if (cur.ok && cur.body && (cur.body.definitionId || cur.body.id)) return "already";
  const d = await must("admin", "POST", "/radiology/definitions/draft", { kind, body });
  await must("uat", "POST", `/approvals/${d.approvalId}/approve`, { note: `${SYN} stand-up approval` });
  await must("admin", "POST", "/radiology/definitions/publish", { definitionId: d.definitionId, approvalId: d.approvalId });
  return "done";
}
async function devices() {
  const j = await must("admin", "GET", "/radiology/setup/devices");
  return listOf(j, "devices");
}
async function stepPcpndt() {
  const regs = listOf(await must("admin", "GET", "/pcpndt/registrations"), "registrations")
    .map((x) => ({ ...x.registration, machines: x.machines ?? [], persons: x.persons ?? [] }));
  let reg = regs.find((r) => r.registrationNo === `SYNTHETIC-LICENCE-PCPNDT-${TAG}`);
  const made = [];
  if (!reg) {
    const r = await must("admin", "POST", "/pcpndt/registrations", {
      site: "Staging Hospital imaging suite (synthetic)", registrationNo: `SYNTHETIC-LICENCE-PCPNDT-${TAG}`,
      validFrom: "2026-04-01", validTo: "2031-03-31", inchargeUserId: uid("admin"),
    });
    reg = { id: r.id ?? r.registrationId, machines: [], persons: [] };
    made.push("registration");
  }
  const regId = reg.id ?? reg.registrationId;
  const haveMachines = new Set((reg.machines ?? []).map((m) => m.deviceResourceId));
  for (const d of (await devices()).filter((x) => /^USG/.test(x.code ?? ""))) {
    const devId = d.id ?? d.resourceId;
    if (haveMachines.has(devId)) continue;
    const r = await api("admin", "POST", `/pcpndt/registrations/${regId}/machines`, {
      deviceResourceId: devId, make: "Synthetic Imaging (staging)", model: `${d.code}-model`, serial: `SYNTHETIC-SN-${d.code}`,
      formBRef: `SYNTHETIC-FORM-B-${TAG}`,
    });
    if (r.ok) made.push(d.code); else if (r.status !== 409) throw new Error(`machine ${d.code} → ${r.status} ${short(r.body)}`);
  }
  const havePersons = new Set((reg.persons ?? []).map((p) => p.userId));
  let n = 0;
  for (const u of ["admin", "uat", "dr.obg"]) {
    n += 1;
    if (!userIds[u] || havePersons.has(uid(u))) continue;
    const r = await api("admin", "POST", `/pcpndt/registrations/${regId}/persons`, {
      userId: uid(u), qualification: "MD Radiodiagnosis (synthetic)", councilRegNo: `SYNTHETIC-REG-PN-${n}`,
    });
    if (r.ok) made.push(u); else if (r.status !== 409) throw new Error(`person ${u} → ${r.status} ${short(r.body)}`);
  }
  return made.length === 0 ? "already" : `done — ${made.join(", ")}`;
}

// ═══ census ═══════════════════════════════════════════════════════════════════════════════════
function census() {
  const r = spawnSync("docker", [...composeArgs, "exec", "-T", "api", "node", "dist/scripts/standup-check.js", "all"], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { red: out.split("\n").filter((l) => l.startsWith("RED")), last: out.trim().split("\n").slice(-1)[0] ?? "" };
}

// ═══ main ═════════════════════════════════════════════════════════════════════════════════════
async function main() {
  const h = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!h || typeof h.environment !== "string" || !h.environment.startsWith("UAT")) {
    die(`${BASE}/api/health does not report a UAT environment (got ${JSON.stringify(h?.environment ?? null)})`);
  }
  console.log(`stage-standup → ${BASE} (${h.environment}), ${TODAY} IST`);
  await refreshUsers();

  await step("synthetic users (seed-staff)", "people", stepUsers);
  await step("role assignments", "people", stepRoles);
  await step("establishment legal name + GSTIN (synthetic)", "people", stepEstablishment);

  await step("opd_visit workflow definition", "opd", async () =>
    activateDefinition("opd_visit", () => must("stage.drafter", "GET", "/opd/definition")));
  await step("departments", "opd", stepDepartments);
  await step("doctor profiles with synthetic registration numbers", "opd", stepDoctors);

  await step("lab prices in the active tariff (set-lab-prices)", "lab", stepLabPrices);
  await step("reference bands carry a source", "lab", stepLabRanges);
  await step("benches + analysers (seed-lab-synthetic)", "lab", stepLabBenches);
  await step("a lab day (seed-lab-demo)", "lab", stepLabDemo);

  await step("roster masters (seed-roster)", "roster", stepRosterMasters);
  await step("demo roster (seed-roster-demo)", "roster", stepRosterDemo);
  await step("a declared holiday marked entered in AEBAS", "roster", stepAebas);

  await step("formulary catalogue (import-cds-catalogue)", "pharmacy", stepFormulary);
  await step("schedule H/H1/X flags (set-schedule-flags)", "pharmacy", stepScheduleFlags);
  await step("drug items", "pharmacy", stepDrugItems);
  await step("registered for sale", "pharmacy", stepSaleItems);
  await step("GST slabs", "pharmacy", stepGstSlabs);
  await step("drug-licensed vendor", "pharmacy", stepVendor);
  await step("GRN into PHARM-OPD", "pharmacy", stepGrn);
  await step("pharmacist council registrations", "pharmacy", stepPharmacists);
  await step("retail licence Form 20/21", "pharmacy", stepRetailLicence);
  await step("NDPS Form 3G + Schedule X Form 20F", "pharmacy", stepControlledLicences);
  await step("end prescriber", "pharmacy", stepEndPrescriber);
  await step("Tally ledgers", "pharmacy", stepTally);
  await step("ER-SAT stocked by transfer", "er", stepErStock);

  const ot = () => imageJson(`require("./dist/src/modules/ot/workflow-def.js")`);
  await step("daycare_case workflow definition", "ot", async () => activateDefinition("daycare_case", () => ot().daycareCaseDefinition));
  await step("ot_gate workflow definition", "ot", async () => activateDefinition("ot_gate", () => ot().otGateDefinition));
  const otSeeds = () => imageJson(`(({CRITERIA_SEED_BODY:c,DEPOSIT_POLICY_SEED_BODY:d,PACU_THRESHOLDS_SEED_BODY:p,PROCEDURE_CLASS_VALUES:v})=>({c,d,p,v}))(require("./dist/src/modules/ot/definitions.js"))`);
  await step("OT criteria", "ot", async () => otPublish("criteria", otSeeds().c));
  await step("OT deposit policy", "ot", async () => otPublish("deposit_policy", otSeeds().d));
  await step("OT PACU thresholds", "ot", async () => otPublish("pacu_thresholds", otSeeds().p));
  await step("OT surgeon privileges", "ot", async () => {
    const v = otSeeds().v;
    const surgeons = ["dr.surgery", "dr.obg", "dr.ortho", "uat", "admin"].filter((u) => userIds[u]?.roles.has("surgeon"));
    return otPublish("privileges", { surgeons: surgeons.map((u) => ({ surgeonId: uid(u), procedureClasses: v })) });
  });

  await step("radiology study types + machines (seed-radiology)", "radiology", async () => {
    const r = runScript("seed-radiology.js", [], { env: { SEED_ACTOR_ID: uid("admin") } });
    if (r.code !== 0) throw new Error(oneLine(r.out));
    return `${/ 0 device\(s\) created/.test(r.out) ? "already" : "done"} — ${oneLine(r.out)}`;
  });
  const rad = () => imageJson(`require("./dist/src/modules/radiology/workflow-def.js")`);
  await step("imaging_study workflow definition", "radiology", async () => activateDefinition("imaging_study", () => rad().imagingStudyDefinition));
  await step("imaging_gate workflow definition", "radiology", async () => activateDefinition("imaging_gate", () => rad().imagingGateDefinition));
  await step("RSO + AERB licences (seed-aerb-demo)", "radiology", async () => {
    const r = runScript("seed-aerb-demo.js");
    if (r.code !== 0) throw new Error(oneLine(r.out));
    const j = JSON.parse(/\{"seed":"aerb-demo".*\}/.exec(r.out)?.[0] ?? "{}");
    if ((j.filed ?? []).length === 0 && (j.appointed ?? []).length === 0) return `already — RSO appointed, ${j.gapsAfter ?? "?"} licence gaps`;
    return `done — appointed ${(j.appointed ?? []).join(",") || "none"}, filed ${(j.filed ?? []).length} DEMO licences`;
  });
  await step("report signatories book", "radiology", async () => radiologyBook("report_signatories", {
    signatories: ["admin", "uat"].map((u, i) => ({
      user_id: uid(u), qualification: "MD Radiodiagnosis (synthetic)", designation: "Consultant Radiologist (staging)",
      council_reg_no: `SYNTHETIC-REG-RAD-${i + 1}`,
    })),
  }));
  await step("PCPNDT registration, machines, persons", "pcpndt", stepPcpndt);

  // ── summary ──
  const red = results.filter((r) => r.state === "RED");
  console.log(`\n══ steps: ${results.filter((r) => r.state === "done").length} done, ${results.filter((r) => r.state === "already").length} already, ${red.length} RED`);
  for (const r of red) console.log(`RED   ${r.group}: ${r.name} — ${r.note}`);
  const c = census();
  console.log(`\n══ census: ${c.last}`);
  for (const l of c.red) console.log(`  ${l.split(" — ")[0]}`);
  console.log("\nStays RED by design (needs a real outside contract or a human in person): messaging provider,");
  console.log("DLT template ids, PACS archive, roster unit ratification by each HOD; see the PR body.");
  process.exitCode = red.length > 0 ? 1 : 0;
}

main().catch((e) => { console.error(`stage-standup: ${e instanceof Error ? e.stack : e}`); process.exit(1); });
