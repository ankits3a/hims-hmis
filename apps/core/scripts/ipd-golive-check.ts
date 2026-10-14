import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { loadConfig } from "../src/kernel/config";
import { getApprovalType } from "../src/kernel/approvals/types";
import { getActiveDefinition } from "../src/kernel/workflow/definitions";
import { usersHoldingRoleAtScope } from "../src/kernel/workflow/roles";
import { notificationTemplates } from "../src/kernel/notify/templates";
import {
  IPD_OPEN_ADMISSION_STATES, ipdAdmissions, ipdBedBlocks, ipdBedReservations, ipdBedStays, patients, services, users,
} from "../src/kernel/db/schema";
import { ADMISSION_WORKFLOW_DEF_KEY, IPD_APPROVAL_TYPES, IpdBedAttributesSchema } from "../src/modules/ipd";
import { ipdRateCardGaps } from "../src/modules/tariff";
import { findStoreByCode } from "../src/modules/materials";
import { OPD_PHARMACY_STORE_CODE, PHARMACIST_ROLE } from "../src/modules/pharmacy";
import { listResourcesOfKind } from "../src/kernel/resources/read";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * `node dist/scripts/ipd-golive-check.js` (in the api container) — E3.4 (#732), THE IPD GO-LIVE READINESS CHECK.
 *
 * One line per item: PASS, FAIL (with the fix), WARN (with the fix; never fails) or SKIP. Exit code 1 on any FAIL.
 * The owner runs it at every rehearsal and on cutover morning: `docs/runbooks/ipd-go-live.md`.
 *
 * ═══ IT NEVER WRITES ═══
 * Every read runs inside ONE transaction opened `READ ONLY`, so Postgres itself refuses a write — a loader that grew a
 * side effect would make this script fail, never mutate. It takes no arguments and no `--apply`.
 *
 * ═══ WHAT "IMPOSSIBLE" MEANS FOR A BED (DECIDED, from the bed invariants in modules/ipd/MAP.md §3) ═══
 * An IPD bed (a `bed` the Beds board shows: attributes valid for `IpdBedAttributesSchema`) is impossible when: its
 * occupancy triad is partial; `occupied` without an occupant or an occupant without `occupied`; an `ipd_admission`
 * occupant with no matching open stay or whose admission is not open; an `incumbent` occupant without the
 * `incumbent` attribute or vice versa; an open stay on a bed that is not that admission's; `blocked` without an active
 * block row or an active block on a bed that is not `blocked`; a live hold on a bed that is occupied, blocked or retired.
 *
 * ═══ WHAT A "TEST OR SAMPLE PATIENT" IS (DECIDED) ═══
 * There is no test flag on a patient. A patient is a test or sample patient when the name carries a whole word test,
 * sample, demo, dummy, uat or trial, or the phone is in the synthetic range 900000xxxx every demo seed uses
 * (seed-lab-demo, dev-pharmacy-standup). Production must have no IPD admission open on one at switch-on.
 */
export type Verdict = "PASS" | "FAIL" | "WARN" | "SKIP";
export type CheckResult = { code: string; verdict: Verdict; detail: string; fix: string };

/** The people IPD cannot open without (hospital scope, active accounts). `cashier` is the IPD bill desk. */
export const IPD_REQUIRED_ROLES: readonly { role: string; who: string }[] = [
  { role: "front_office", who: "admission desk" },
  { role: "ward_nurse", who: "ward nurse" },
  { role: "nursing_supervisor", who: "nursing supervisor" },
  { role: "dietician", who: "dietician" },
  { role: "kitchen_staff", who: "kitchen" },
  { role: "cashier", who: "IPD bill desk" },
  { role: "billing_manager", who: "billing manager" },
  { role: PHARMACIST_ROLE, who: "pharmacist" },
  { role: "medical_superintendent", who: "medical superintendent" },
];

const TEST_NAME = /\b(test|sample|demo|dummy|uat|trial)\b/i;
const SYNTHETIC_PHONE = /^900000\d{4}$/;
const RUNBOOK = "docs/runbooks/ipd-go-live.md";

export type GoLiveItem = { code: string; fix: string; warnOnly?: boolean; run: (tx: Tx, env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; detail: string }> };

const asDb = (tx: Tx): Db => tx as unknown as Db;

/**
 * An IPD bed is what the Beds board shows: a `bed` whose attributes pass `IpdBedAttributesSchema` (the board's own
 * filter, `beds-board.ts`). The OT's recovery bays are `bed` rows too, with class `daycare_recovery`; they are not IPD's.
 */
async function ipdBeds(tx: Tx, includeRetired = false) {
  return (await listResourcesOfKind(asDb(tx), "bed", { includeRetired }))
    .filter((b) => IpdBedAttributesSchema.safeParse(b.attributes).success);
}

async function activeHolders(tx: Tx, roleKey: string): Promise<string[]> {
  const ids = await usersHoldingRoleAtScope(tx, roleKey, "hospital");
  if (ids.length === 0) return [];
  const rows = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.active, true)));
  return rows.map((r) => r.id);
}

/** Every impossible IPD bed, one line each. Retired beds are left out (the registry keeps them for history). */
export async function impossibleBeds(tx: Tx): Promise<string[]> {
  const beds = await ipdBeds(tx);
  const bedIds = beds.map((b) => b.id);
  if (bedIds.length === 0) return [];
  const stays = await tx.select().from(ipdBedStays).where(and(inArray(ipdBedStays.bedId, bedIds), isNull(ipdBedStays.endedAt)));
  const blocks = await tx.select().from(ipdBedBlocks).where(and(inArray(ipdBedBlocks.bedId, bedIds), inArray(ipdBedBlocks.status, ["active", "pending_release"])));
  const holds = await tx.select().from(ipdBedReservations).where(and(inArray(ipdBedReservations.bedId, bedIds), eq(ipdBedReservations.status, "active")));
  const admissionIds = [...new Set(stays.map((s) => s.admissionId))];
  const admissions = admissionIds.length === 0 ? [] : await tx.select({ id: ipdAdmissions.id, state: ipdAdmissions.state })
    .from(ipdAdmissions).where(inArray(ipdAdmissions.id, admissionIds));
  const stateOf = new Map(admissions.map((a) => [a.id, a.state]));
  const open = new Set<string>(IPD_OPEN_ADMISSION_STATES);
  const stayOn = new Map(stays.map((s) => [s.bedId, s]));
  const blockOn = new Map(blocks.map((b) => [b.bedId, b]));
  const holdOn = new Map(holds.map((h) => [h.bedId, h]));

  const out: string[] = [];
  for (const b of beds) {
    const say = (why: string): void => { out.push(`${b.code}: ${why}`); };
    const triad = [b.occupantType, b.occupantRef, b.since].filter((v) => v !== null && v !== undefined).length;
    if (triad !== 0 && triad !== 3) say("occupancy record is partial (occupant type, reference and since must be all or none)");
    const occupied = b.status === "occupied";
    if (occupied && b.occupantType === null) say("marked occupied with nobody on it");
    if (!occupied && b.occupantType !== null) say(`status ${b.status} but an occupant is recorded`);
    const stay = stayOn.get(b.id);
    const incumbentAttr = b.attributes.incumbent === true;
    if (b.occupantType === "ipd_admission") {
      if (stay === undefined || stay.admissionId !== b.occupantRef) say("occupied by an admission with no matching open stay");
      const state = stateOf.get(b.occupantRef ?? "");
      if (state !== undefined && !open.has(state)) say(`occupied by an admission that is ${state}`);
    } else if (b.occupantType === "incumbent") {
      if (!incumbentAttr) say("incumbent occupant without the incumbent mark");
      if (stay !== undefined) say("incumbent bed also has an open stay");
    } else if (b.occupantType !== null) {
      say(`unknown occupant type "${b.occupantType}"`);
    }
    if (incumbentAttr && b.occupantType !== "incumbent") say("incumbent mark on a bed the old system's patient does not occupy");
    if (stay !== undefined && b.occupantRef !== stay.admissionId) say("an open stay on this bed belongs to an admission not occupying it");
    if (stay !== undefined && stateOf.has(stay.admissionId) && !open.has(stateOf.get(stay.admissionId)!)) {
      say(`open stay for an admission that is ${stateOf.get(stay.admissionId)}`);
    }
    const block = blockOn.get(b.id);
    if (b.status === "blocked" && block?.status !== "active") say("blocked with no active block record");
    if (block?.status === "active" && b.status !== "blocked") say(`active block record but status ${b.status}`);
    if (block?.status === "pending_release" && !occupied) say("block waiting for release on a bed nobody occupies");
    const hold = holdOn.get(b.id);
    if (hold !== undefined && (occupied || b.status === "blocked")) say(`live hold on a ${b.status} bed`);
  }
  // A hold or a stay on a retired bed: the bed list above leaves retired beds out, so ask the rows.
  const retired = (await ipdBeds(tx, true)).filter((b) => b.status === "retired");
  if (retired.length > 0) {
    const rIds = retired.map((b) => b.id);
    const code = new Map(retired.map((b) => [b.id, b.code]));
    for (const s of await tx.select().from(ipdBedStays).where(and(inArray(ipdBedStays.bedId, rIds), isNull(ipdBedStays.endedAt)))) {
      out.push(`${code.get(s.bedId) ?? s.bedId}: retired bed with an open stay`);
    }
    for (const h of await tx.select().from(ipdBedReservations).where(and(inArray(ipdBedReservations.bedId, rIds), eq(ipdBedReservations.status, "active")))) {
      out.push(`${code.get(h.bedId) ?? h.bedId}: retired bed with a live hold`);
    }
  }
  return out;
}

/** Open IPD admissions on a test or sample patient, as "IP number or id: patient name". */
export async function admissionsOnTestPatients(tx: Tx): Promise<string[]> {
  const rows = await tx.select({ id: ipdAdmissions.id, state: ipdAdmissions.state, name: patients.name, phone: patients.phone, uhid: patients.uhid })
    .from(ipdAdmissions).innerJoin(patients, eq(patients.id, ipdAdmissions.patientId))
    .where(inArray(ipdAdmissions.state, [...IPD_OPEN_ADMISSION_STATES]));
  return rows.filter((r) => TEST_NAME.test(r.name) || SYNTHETIC_PHONE.test(r.phone ?? ""))
    .map((r) => `${r.uhid} "${r.name}" (${r.state})`);
}

function copilotConfigured(env: NodeJS.ProcessEnv): { baseUrl: string | null; apiKey: string | null } {
  try {
    const c = loadConfig(env).copilot;
    return { baseUrl: c.baseUrl, apiKey: c.apiKey };
  } catch {
    // An environment loadConfig refuses (a bare shell) still answers from the two keys it would read.
    return { baseUrl: env.COPILOT_BASE_URL?.trim() || null, apiKey: env.COPILOT_API_KEY?.trim() || null };
  }
}

function whatsappConfigured(env: NodeJS.ProcessEnv): boolean | null {
  try { return loadConfig(env).notifyWhatsapp !== null; } catch { return null; }
}

export const IPD_GOLIVE_ITEMS: readonly GoLiveItem[] = [
  {
    code: "admission_workflow_active",
    fix: `Admin → Workflows → ${ADMISSION_WORKFLOW_DEF_KEY}: the medical superintendent and the owner approve the draft (made by ipd-golive-setup --confirm), the owner activates it (${RUNBOOK} §4)`,
    run: async (tx) => {
      const def = await getActiveDefinition(tx, ADMISSION_WORKFLOW_DEF_KEY);
      return def === null ? { ok: false, detail: "no active version" } : { ok: true, detail: `version ${def.version} active` };
    },
  },
  {
    code: "approval_types_registered",
    fix: `run node dist/scripts/ipd-golive-setup.js (plan), then with --confirm: it registers the IPD approval types and drafts the workflow (${RUNBOOK} §3.3)`,
    run: async (tx) => {
      const missing: string[] = [];
      for (const t of IPD_APPROVAL_TYPES) if ((await getApprovalType(tx, t.typeKey)) === null) missing.push(t.typeKey);
      return missing.length === 0
        ? { ok: true, detail: `${IPD_APPROVAL_TYPES.length} registered` }
        : { ok: false, detail: `missing: ${missing.join(", ")}` };
    },
  },
  {
    code: "approvers_held",
    fix: "Admin → Users: give each approver role named above to at least one active person",
    run: async (tx) => {
      const roles = [...new Set(IPD_APPROVAL_TYPES.map((t) => t.approverRole))].sort();
      const empty: string[] = [];
      for (const r of roles) if ((await activeHolders(tx, r)).length === 0) empty.push(r);
      return empty.length === 0
        ? { ok: true, detail: `held: ${roles.join(", ")}` }
        : { ok: false, detail: `nobody active holds: ${empty.join(", ")}` };
    },
  },
  {
    code: "rate_card_complete",
    fix: `import the incumbent IPD tariff (scripts/import-ipd-tariff.ts), review it in Billing office → Prices → IPD rate card, submit, the owner approves and activates, then switches on the IPD_* services (${RUNBOOK} §3.2)`,
    run: async (tx) => {
      const card = await ipdRateCardGaps(asDb(tx), { at: new Date() });
      if (card.version === null) return { ok: false, detail: "no tariff version in force" };
      if (card.gaps.length > 0) {
        return { ok: false, detail: `version ${card.version.versionNo}: ${card.gaps.map((g) => `${g.bedClass} missing ${g.missing.join("/")}`).join("; ")}` };
      }
      return { ok: true, detail: `version ${card.version.versionNo}: ${card.ready} classes priced (room, nursing, visit)` };
    },
  },
  {
    code: "ipd_services_on",
    fix: "Billing office → Prices → Services: switch on every IPD_* service named above (the importer creates them off)",
    run: async (tx) => {
      const card = await ipdRateCardGaps(asDb(tx), { at: new Date() });
      const priced = card.classes.flatMap((c) => c.cells.filter((x) => x.state === "priced").map((x) => x.serviceCode));
      if (priced.length === 0) return { ok: false, detail: "no IPD rate is priced in the version in force" };
      const off = (await tx.select({ code: services.code }).from(services)
        .where(and(inArray(services.code, priced), eq(services.active, false)))).map((s) => s.code).sort();
      return off.length === 0 ? { ok: true, detail: `${priced.length} priced IPD services on` } : { ok: false, detail: `off: ${off.join(", ")}` };
    },
  },
  {
    code: "beds_loaded",
    fix: `load the bed list: scripts/load-bed-layout.ts --file <beds.csv> --by <username>, then again with --apply (${RUNBOOK} §3.1)`,
    run: async (tx) => {
      const beds = await ipdBeds(tx);
      if (beds.length === 0) return { ok: false, detail: "no IPD bed in the registry" };
      const byClass = new Map<string, number>();
      for (const b of beds) byClass.set(String(b.attributes.class), (byClass.get(String(b.attributes.class)) ?? 0) + 1);
      return { ok: true, detail: `${beds.length} beds (${[...byClass.entries()].map(([c, n]) => `${c} ${n}`).join(", ")})` };
    },
  },
  {
    code: "beds_consistent",
    fix: "send the list to IT: each bed above needs the act that matches the ward (release, unblock, discharge) — never a hand edit",
    run: async (tx) => {
      if ((await ipdBeds(tx)).length === 0) return { ok: false, detail: "no IPD bed loaded, so nothing to check (load the bed list first)" };
      const bad = await impossibleBeds(tx);
      return bad.length === 0 ? { ok: true, detail: "no bed in an impossible state" } : { ok: false, detail: bad.join("; ") };
    },
  },
  ...IPD_REQUIRED_ROLES.map(({ role, who }): GoLiveItem => ({
    code: `role_held:${role}`,
    fix: `Admin → Users: give the ${who} role (${role}) to the people who will work the first ward`,
    run: async (tx) => {
      const n = (await activeHolders(tx, role)).length;
      return n > 0 ? { ok: true, detail: `${n} active` } : { ok: false, detail: `nobody active holds ${role}` };
    },
  })),
  {
    code: "pharm_opd_store",
    fix: "run seed-pharmacy (every deploy does): it creates the PHARM-OPD store the wards draw from",
    run: async (tx) => {
      const store = await findStoreByCode(tx, OPD_PHARMACY_STORE_CODE);
      if (store === undefined) return { ok: false, detail: `${OPD_PHARMACY_STORE_CODE} not found` };
      return store.status === "retired" ? { ok: false, detail: `${OPD_PHARMACY_STORE_CODE} is retired` } : { ok: true, detail: `${OPD_PHARMACY_STORE_CODE} present` };
    },
  },
  {
    code: "no_test_patient_admitted",
    fix: "discharge or cancel each admission above (rehearsal leftovers) before switch-on; production must hold none",
    run: async (tx) => {
      const found = await admissionsOnTestPatients(tx);
      return found.length === 0 ? { ok: true, detail: "none open" } : { ok: false, detail: found.join("; ") };
    },
  },
  {
    code: "copilot_model",
    warnOnly: true,
    fix: "optional: set COPILOT_BASE_URL and COPILOT_API_KEY in the server's .env; without them the ward shows the plain timeline and template drafts",
    run: async (_tx, env) => {
      const c = copilotConfigured(env);
      return c.baseUrl !== null && c.apiKey !== null ? { ok: true, detail: "configured" } : { ok: false, detail: "no copilot model configured" };
    },
  },
  {
    code: "notify_templates",
    warnOnly: true,
    fix: "optional at go-live: approve the WhatsApp template and DLT id for each held message (issues #761 and the family OTP); until then they are recorded, not sent",
    run: async (_tx, env) => {
      const held = Object.values(notificationTemplates).filter((t) => t.key.startsWith("ipd.") && t.heldReason !== undefined).map((t) => t.key);
      const why: string[] = [];
      if (held.length > 0) why.push(`held: ${held.join(", ")}`);
      if ((env.IPD_FAMILY_OTP_DLT_TEMPLATE_ID ?? "").trim() === "") why.push("IPD_FAMILY_OTP_DLT_TEMPLATE_ID not set");
      if (whatsappConfigured(env) === false) why.push("WhatsApp not configured");
      return why.length === 0 ? { ok: true, detail: "configured" } : { ok: false, detail: why.join("; ") };
    },
  },
];

/** Runs every item inside one READ ONLY transaction. A throw is that item's FAIL (or WARN), with the error as detail. */
export async function runIpdGoLiveCheck(
  db: Db, env: NodeJS.ProcessEnv = process.env, items: readonly GoLiveItem[] = IPD_GOLIVE_ITEMS,
): Promise<CheckResult[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    const out: CheckResult[] = [];
    for (const item of items) {
      const bad: Verdict = item.warnOnly === true ? "WARN" : "FAIL";
      try {
        // Each item in its own savepoint, so one item's error does not abort the others.
        const r = await tx.transaction((sp) => item.run(sp, env));
        out.push({ code: item.code, verdict: r.ok ? "PASS" : bad, detail: r.detail, fix: item.fix });
      } catch (e) {
        out.push({ code: item.code, verdict: bad, detail: `check could not run: ${e instanceof Error ? e.message : String(e)}`, fix: item.fix });
      }
    }
    return out;
  });
}

export function formatGoLiveCheck(results: readonly CheckResult[]): string[] {
  const lines = results.flatMap((r) => [
    `${r.verdict.padEnd(4)}  ${r.code} — ${r.detail}`,
    ...(r.verdict === "FAIL" || r.verdict === "WARN" ? [`      fix: ${r.fix}`] : []),
  ]);
  const count = (v: Verdict): number => results.filter((r) => r.verdict === v).length;
  lines.push(`ipd-golive-check: ${count("PASS")} pass, ${count("FAIL")} fail, ${count("WARN")} warn, ${count("SKIP")} skip — ${count("FAIL") === 0 ? "READY" : "NOT READY"}`);
  return lines;
}

export const anyFail = (results: readonly CheckResult[]): boolean => results.some((r) => r.verdict === "FAIL");

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") throw new Error("ipd-golive-check: DATABASE_URL is not set");
  const { db, pool } = createDb(url);
  try {
    const results = await runIpdGoLiveCheck(db, process.env);
    for (const l of formatGoLiveCheck(results)) console.log(l);
    if (anyFail(results)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
