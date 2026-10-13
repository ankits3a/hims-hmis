import { and, eq, inArray, sql } from "drizzle-orm";
import {
  IPD_BED_CLASSES, IPD_BED_CLASS_INFO, IPD_RATE_COMPONENTS, IPD_REQUIRED_RATE_COMPONENTS, ipdRateServiceCode,
} from "@hmis/contracts";
import type { Actor, IpdBedClass, IpdRateComponent } from "@hmis/contracts";
import { services, tariffItems, tariffVersions, users } from "../../kernel/db/schema";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { listGstCategories } from "./gst-config";
import { assertPaise, rupeesTextToPaise } from "./money";
import { createService, updateService } from "./services";
import { createDraftVersion, getVersion, resolveActiveTariffVersion, setTariffItem } from "./versions";
import type { ConfigError } from "./context";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE IPD RATE CARD (epic E0.4, decision 0072 answer 2) ═══
 *
 * One tariff service per bed class × rate component, coded by `ipdRateServiceCode` (contracts), priced
 * through the ordinary tariff version road. Two halves live here:
 *
 *  · `importIpdTariff` carries the incumbent's IPD tariff over LINE BY LINE into a NEW DRAFT version
 *    copied from the one in force. It never submits and never activates: the owner reviews the draft in
 *    the billing office's price list and the draft → submit → approve → activate road (separation of
 *    duties) puts it in force. A file with one bad row is refused whole and writes nothing. A line that
 *    is not a class × component rate is reported back in full, never dropped.
 *  · `ipdRateCardGaps` is the go-live check: every class that `needsRates` must carry a room rent, a
 *    nursing charge and a visit fee. It is a WARNING today (IPD is not live): `ipdRateCardWarnings`
 *    feeds `scripts/validate-tariff-config.ts` and never touches `validateTariffConfig`'s `ok`.
 *
 * The services are created INACTIVE (by the importer, never by a deploy seed): an active service with no
 * price in the version in force turns `validateTariffConfig` red, and nothing may bill an IPD day before
 * IPD goes live. The IPD go-live (ipd-charges) switches them on.
 */

/** Critical-care classes: room rent is GST-exempt by law (ICU/CCU/ICCU/NICU), HDU and PICU read with them. */
const CRITICAL_CARE: ReadonlySet<IpdBedClass> = new Set<IpdBedClass>(["hdu", "icu", "nicu", "picu"]);

/** The GST category (gst_config key) of each IPD service. Rows are seeded by `scripts/seed-tariff.ts`. */
export const IPD_GST_CATEGORY = { room: "room_rent", roomCriticalCare: "room_rent_icu", care: "ipd_care" } as const;

export function ipdServiceCategory(cls: IpdBedClass, component: IpdRateComponent): string {
  if (component !== "room") return IPD_GST_CATEGORY.care;
  return CRITICAL_CARE.has(cls) ? IPD_GST_CATEGORY.roomCriticalCare : IPD_GST_CATEGORY.room;
}

const COMPONENT_NAME: Record<IpdRateComponent, string> = {
  room: "Room rent", nursing: "Nursing charge", rmo: "RMO charge", visit: "Consultant visit", cross_visit: "Cross-consultation visit",
};

export function ipdServiceName(cls: IpdBedClass, component: IpdRateComponent): string {
  return `${COMPONENT_NAME[component]} — ${IPD_BED_CLASS_INFO[cls].label}`;
}

/** A class that bills at another's rates (overflow → general) carries no rates of its own. */
export const IPD_RATED_CLASSES: readonly IpdBedClass[] = IPD_BED_CLASSES.filter((c) => IPD_BED_CLASS_INFO[c].billsAs === undefined);

// ——— the CSV ———

export const IPD_TARIFF_CSV_COLUMNS = ["incumbent_code", "incumbent_name", "bed_class", "component", "rate_rupees"] as const;

export type IpdTariffRate = {
  line: number; incumbentCode: string; incumbentName: string;
  bedClass: IpdBedClass; component: IpdRateComponent; pricePaise: number;
};
export type IpdTariffUnmapped = { line: number; incumbentCode: string; incumbentName: string; rateRupees: string };
export type IpdTariffRowError = { line: number | null; problem: string };
export type IpdTariffParse = { rates: IpdTariffRate[]; unmapped: IpdTariffUnmapped[]; errors: IpdTariffRowError[] };

/** RFC 4180 enough for a spreadsheet export: quoted fields, doubled quotes, CRLF. */
function splitCsvLine(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") { cur += "\""; i += 1; }
      else if (ch === "\"") quoted = false;
      else cur += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Reads the whole file and judges every row. A row with BOTH `bed_class` and `component` blank is an
 * incumbent line that is not a class × component rate (oxygen, monitor, a package): it goes to
 * `unmapped`. A row naming either must be a valid rate, else it is an error. Blank lines are skipped.
 */
export function parseIpdTariffCsv(text: string): IpdTariffParse {
  const rates: IpdTariffRate[] = [];
  const unmapped: IpdTariffUnmapped[] = [];
  const errors: IpdTariffRowError[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.toLowerCase());
  const col: Record<string, number> = {};
  for (const name of new Set(header.filter((h, i) => h !== "" && header.indexOf(h) !== i))) {
    errors.push({ line: 1, problem: `header names "${name}" more than once` });
  }
  for (const name of IPD_TARIFF_CSV_COLUMNS) {
    const at = header.indexOf(name);
    if (at < 0) errors.push({ line: 1, problem: `header has no "${name}" column (needs ${IPD_TARIFF_CSV_COLUMNS.join(", ")})` });
    col[name] = at;
  }
  if (errors.length > 0) return { rates, unmapped, errors };

  const seen = new Map<string, number>();
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") continue;
    const line = i + 1;
    const f = splitCsvLine(raw);
    if (f.length !== header.length) {
      // An unquoted "1,000" splits into two cells and would read as ₹1 (review #744): the shape is refused.
      errors.push({ line, problem: `row has ${f.length} cells but the header has ${header.length} — quote a rate written with commas ("1,000")` });
      continue;
    }
    const get = (name: (typeof IPD_TARIFF_CSV_COLUMNS)[number]): string => f[col[name] ?? -1] ?? "";
    const incumbentCode = get("incumbent_code");
    const incumbentName = get("incumbent_name");
    const cls = get("bed_class").toLowerCase();
    const component = get("component").toLowerCase();
    const rateText = get("rate_rupees");

    if (cls === "" && component === "") {
      unmapped.push({ line, incumbentCode, incumbentName, rateRupees: rateText });
      continue;
    }
    const problems: string[] = [];
    const knownClass = (IPD_BED_CLASSES as readonly string[]).includes(cls);
    if (cls === "") problems.push("bed_class is blank but component is not");
    else if (!knownClass) problems.push(`unknown bed_class "${cls}"`);
    else if (!IPD_RATED_CLASSES.includes(cls as IpdBedClass)) {
      problems.push(`bed_class "${cls}" bills at ${String(IPD_BED_CLASS_INFO[cls as IpdBedClass].billsAs)} rates and carries none of its own`);
    }
    const knownComponent = (IPD_RATE_COMPONENTS as readonly string[]).includes(component);
    if (component === "") problems.push("component is blank but bed_class is not");
    else if (!knownComponent) problems.push(`unknown component "${component}" (one of ${IPD_RATE_COMPONENTS.join(", ")})`);
    const paise = rupeesTextToPaise(rateText);
    if (paise === null) problems.push(`rate_rupees "${rateText}" is not a sum of rupees (digits, up to 2 decimals)`);
    else if (paise <= 0) problems.push(`rate_rupees "${rateText}" is not above zero`);
    if (knownClass && knownComponent) {
      const key = `${cls}/${component}`;
      const first = seen.get(key);
      if (first !== undefined) problems.push(`duplicate ${cls} × ${component} (first on line ${first})`);
      else seen.set(key, line);
    }
    if (problems.length > 0) {
      errors.push({ line, problem: `${incumbentCode || "(no code)"} ${incumbentName}: ${problems.join("; ")}` });
      continue;
    }
    rates.push({ line, incumbentCode, incumbentName, bedClass: cls as IpdBedClass, component: component as IpdRateComponent, pricePaise: paise as number });
  }
  return { rates, unmapped, errors };
}

// ——— the import ———

export type IpdImportItem = IpdTariffRate & { serviceCode: string; oldPaise: number | null; serviceExists: boolean };
export type IpdImportReport =
  | { ok: false; errors: IpdTariffRowError[]; unmapped: IpdTariffUnmapped[] }
  | {
      ok: true; applied: boolean; items: IpdImportItem[]; unmapped: IpdTariffUnmapped[];
      copiedFromVersionNo: number | null; servicesCreated: string[];
      draft: { versionId: string; versionNo: number } | null;
    };

/** pg advisory lock key serialising IPD imports ("IPDR" as 4 bytes). */
const IPD_IMPORT_LOCK_KEY = 0x49504452;
class PendingVersion extends Error {
  constructor(readonly pending: { versionNo: number; status: string }[]) { super("pending tariff version"); }
}

/**
 * The person an import is recorded against: an ACTIVE account holding `tariff.versions.draft`
 * (the `resolvePerson` rule in scripts/pharmacy-shelf-common.ts). Throws with the reason.
 */
export async function resolveIpdImportActor(db: Db, username: string): Promise<Actor> {
  const [u] = await db.select({ id: users.id, active: users.active }).from(users).where(eq(users.username, username.trim()));
  if (u === undefined || !u.active) throw new Error(`--by ${username}: no active account with that username`);
  if (!(await hasPermission(db, u.id, "tariff.versions.draft", "hospital"))) throw new Error(`--by ${username} does not hold tariff.versions.draft`);
  return { type: "user", id: u.id } as Actor;
}

export const IPD_IMPORT_NOTE = "IPD rate card carried over from the incumbent tariff line by line (E0.4) — for the owner's review";

/**
 * Dry run unless `apply`. On apply, ONE transaction: create the missing services (inactive), a draft
 * copied from the version in force, and the IPD items on it. Refuses — writing nothing — when any row is
 * bad, a GST category the services need is missing, or another version is already draft/submitted.
 */
export async function importIpdTariff(
  db: Db, actor: Actor, csvText: string, opts: { apply: boolean; at?: Date; notes?: string },
): Promise<IpdImportReport> {
  const at = opts.at ?? new Date();
  const parsed = parseIpdTariffCsv(csvText);
  const errors = [...parsed.errors];

  const haveCategories = new Set((await listGstCategories(db)).map((c) => c.category));
  for (const cat of new Set(parsed.rates.map((r) => ipdServiceCategory(r.bedClass, r.component)))) {
    if (!haveCategories.has(cat)) errors.push({ line: null, problem: `no gst_config row for category "${cat}" — run seed:tariff first` });
  }
  const pending = await db.select({ versionNo: tariffVersions.versionNo, status: tariffVersions.status }).from(tariffVersions)
    .where(inArray(tariffVersions.status, ["draft", "submitted"]));
  for (const p of pending) {
    errors.push({ line: null, problem: `tariff version ${p.versionNo} is already ${p.status}; finish or reject it first` });
  }
  if (errors.length > 0) return { ok: false, errors, unmapped: parsed.unmapped };

  const active = await resolveActiveTariffVersion(db, at);
  const codes = parsed.rates.map((r) => ipdRateServiceCode(r.bedClass, r.component));
  const existing = codes.length === 0 ? [] : await db.select({ id: services.id, code: services.code }).from(services)
    .where(inArray(services.code, codes));
  const idByCode = new Map(existing.map((s) => [s.code, s.id]));
  const oldByService = new Map<string, number>();
  if (active !== null && existing.length > 0) {
    const rows = await db.select({ serviceId: tariffItems.serviceId, pricePaise: tariffItems.pricePaise }).from(tariffItems)
      .where(and(eq(tariffItems.versionId, active.versionId), inArray(tariffItems.serviceId, existing.map((s) => s.id))));
    for (const r of rows) oldByService.set(r.serviceId, r.pricePaise);
  }
  const items: IpdImportItem[] = parsed.rates.map((r) => {
    const serviceCode = ipdRateServiceCode(r.bedClass, r.component);
    const id = idByCode.get(serviceCode);
    return { ...r, serviceCode, serviceExists: id !== undefined, oldPaise: id === undefined ? null : oldByService.get(id) ?? null };
  });
  const toCreate = items.filter((i) => !i.serviceExists).map((i) => i.serviceCode);

  if (!opts.apply || items.length === 0) {
    return {
      ok: true, applied: false, items, unmapped: parsed.unmapped,
      copiedFromVersionNo: active?.versionNo ?? null, servicesCreated: toCreate, draft: null,
    };
  }

  let draft: { versionId: string; versionNo: number };
  try {
    draft = await withTx(db, async (tx) => {
      // Two imports at once must not both draft (review #744): serialise on one fixed key, then re-read the
      // pending versions INSIDE the lock — the check above ran outside any transaction.
      await tx.execute(sql`select pg_advisory_xact_lock(${IPD_IMPORT_LOCK_KEY})`);
      const pendingNow = await tx.select({ versionNo: tariffVersions.versionNo, status: tariffVersions.status }).from(tariffVersions)
        .where(inArray(tariffVersions.status, ["draft", "submitted"]));
      if (pendingNow.length > 0) throw new PendingVersion(pendingNow);
      const haveNow = await tx.select({ id: services.id, code: services.code }).from(services).where(inArray(services.code, codes));
      for (const s of haveNow) idByCode.set(s.code, s.id);
      for (const item of items) {
        if (idByCode.has(item.serviceCode)) continue;
        const { serviceId } = await createService(tx, actor, {
          code: item.serviceCode, name: ipdServiceName(item.bedClass, item.component), category: ipdServiceCategory(item.bedClass, item.component),
        });
        await updateService(tx, actor, serviceId, { active: false });
        idByCode.set(item.serviceCode, serviceId);
      }
      const d = await createDraftVersion(tx, actor, {
        notes: opts.notes ?? IPD_IMPORT_NOTE, ...(active === null ? {} : { copyFromVersionId: active.versionId }),
    });
    for (const item of items) {
      assertPaise(item.pricePaise, `${item.serviceCode} price`);
      await setTariffItem(tx, actor, d.versionId, idByCode.get(item.serviceCode) as string, item.pricePaise);
    }
    return d;
    });
  } catch (e) {
    if (!(e instanceof PendingVersion)) throw e;
    return {
      ok: false, unmapped: parsed.unmapped,
      errors: e.pending.map((p) => ({ line: null, problem: `tariff version ${p.versionNo} is already ${p.status}; finish or reject it first` })),
    };
  }
  return {
    ok: true, applied: true, items, unmapped: parsed.unmapped,
    copiedFromVersionNo: active?.versionNo ?? null, servicesCreated: toCreate, draft,
  };
}

// ——— the go-live check ———

export type IpdRateCellState = "priced" | "no_service" | "no_price" | "zero";
export type IpdRateCell = { component: IpdRateComponent; required: boolean; serviceCode: string; pricePaise: number | null; state: IpdRateCellState };
export type IpdRateCardClass = {
  bedClass: IpdBedClass; label: string; cells: IpdRateCell[]; missing: IpdRateComponent[];
};
export type IpdRateCard = {
  version: { versionId: string; versionNo: number; status: string } | null;
  classes: IpdRateCardClass[];
  /** Classes with every required component priced. */
  ready: number;
  /** Classes missing at least one required component. */
  missing: number;
  gaps: { bedClass: IpdBedClass; missing: IpdRateComponent[] }[];
};

/**
 * Every class that `needsRates`, every component (required and optional), priced or not, in the given
 * version — or the version in force at `at`. A required component is MISSING when its service does not
 * exist, the version carries no item for it, or the item is 0. With no version at all, everything is
 * missing. Read-only.
 */
export async function ipdRateCardGaps(db: Db, opts: { at: Date; tariffVersionId?: string }): Promise<IpdRateCard> {
  let version: IpdRateCard["version"] = null;
  const priceByService = new Map<string, number>();
  const versionId = opts.tariffVersionId ?? (await resolveActiveTariffVersion(db, opts.at))?.versionId;
  if (versionId !== undefined) {
    const found = await getVersion(db, versionId);
    if (found !== null) {
      version = { versionId: found.version.id, versionNo: found.version.versionNo, status: found.version.status };
      for (const item of found.items) priceByService.set(item.serviceId, item.pricePaise);
    }
  }
  const allCodes = IPD_BED_CLASSES.flatMap((c) => IPD_RATE_COMPONENTS.map((k) => ipdRateServiceCode(c, k)));
  const svcRows = await db.select({ id: services.id, code: services.code }).from(services).where(inArray(services.code, allCodes));
  const idByCode = new Map(svcRows.map((s) => [s.code, s.id]));

  const classes: IpdRateCardClass[] = IPD_BED_CLASSES.filter((c) => IPD_BED_CLASS_INFO[c].needsRates).map((bedClass) => {
    const cells: IpdRateCell[] = IPD_RATE_COMPONENTS.map((component) => {
      const serviceCode = ipdRateServiceCode(bedClass, component);
      const required = (IPD_REQUIRED_RATE_COMPONENTS as readonly string[]).includes(component);
      const id = idByCode.get(serviceCode);
      const price = id === undefined ? undefined : priceByService.get(id);
      const state: IpdRateCellState = id === undefined ? "no_service" : price === undefined ? "no_price" : price === 0 ? "zero" : "priced";
      return { component, required, serviceCode, pricePaise: price ?? null, state };
    });
    const missing = cells.filter((c) => c.required && c.state !== "priced").map((c) => c.component);
    return { bedClass, label: IPD_BED_CLASS_INFO[bedClass].label, cells, missing };
  });
  const gaps = classes.filter((c) => c.missing.length > 0).map((c) => ({ bedClass: c.bedClass, missing: c.missing }));
  return { version, classes, ready: classes.length - gaps.length, missing: gaps.length, gaps };
}

/**
 * The go-live check as WARNINGS for the config gate (boot-check rule: a data state an operator can be
 * halfway through warns, never refuses). Never throws: a failed read is itself one warning.
 */
export async function ipdRateCardWarnings(db: Db, at: Date): Promise<ConfigError[]> {
  try {
    const card = await ipdRateCardGaps(db, { at });
    return card.gaps.map((g) => ({
      code: "ipd_rate_missing",
      detail: `IPD class "${g.bedClass}" has no ${g.missing.join(", ")} rate in ${card.version === null ? "any tariff version (none in force)" : `version ${card.version.versionNo}`}`,
    }));
  } catch (e) {
    return [{ code: "ipd_rate_check_failed", detail: `IPD rate card check could not run: ${e instanceof Error ? e.message : String(e)}` }];
  }
}
