import { and, eq, inArray, like } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { hasPermission } from "../src/kernel/auth/permissions";
import { services, tariffItems, tariffVersions, users } from "../src/kernel/db/schema";
import { activateVersionDirectly, createDraftVersion, resolveActiveTariffVersion, setTariffItem } from "../src/modules/tariff";
import { LAB_PRICES_2026_10 } from "./data/lab-prices-2026-10";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * `node dist/scripts/set-lab-prices.js --by <username> [--apply]`
 *
 * ═══ OWNER 2026-10-12 — THE LAB'S PRICE LIST, PUT INTO FORCE BY A NAMED PERSON ═══
 *
 * *"Add lab test prices inspired from Lal PathLabs and Apollo lab. I authorize you to add prices on my
 * behalf (user admin)."* Prices are money, so this goes through the tariff's own road and no other:
 * a NEW tariff version copied from the one in force, the lab services' items set on it, and the
 * version activated on the DIRECT road (`activateVersionDirectly`, the same road the owner's consult
 * price change takes) with the owner's authorisation as its reason. Every other price is carried
 * over unchanged; the old version stays readable, so every bill already issued keeps its price.
 *
 * `--by` is the person in whose name it is done; they must hold both `tariff.versions.draft` and
 * `tariff.versions.activate`. Only services that exist as lab services (`LABSVC-<code>`) are priced;
 * a code in the list with no service is reported, never invented. Dry run by default.
 */
export const LAB_PRICE_NOTE = "Owner 2026-10-12: lab test prices inspired by Lal PathLabs and Apollo, authorised by the owner";

export async function setLabPrices(
  db: Db, by: string, apply: boolean, now: Date = new Date(),
): Promise<{ applied: boolean; priced: number; unchanged: number; noService: string[]; versionNo: number | null }> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, by));
  if (!u) throw new Error(`no user ${by}`);
  for (const p of ["tariff.versions.draft", "tariff.versions.activate"]) {
    if (!(await hasPermission(db, u.id, p, "hospital"))) throw new Error(`${by} does not hold ${p}`);
  }
  const pending = await db.select({ id: tariffVersions.id }).from(tariffVersions)
    .where(inArray(tariffVersions.status, ["draft", "submitted"]));
  if (pending.length > 0) throw new Error("REFUSED — a tariff version is already being drafted or waits for approval; finish it first");
  const active = await resolveActiveTariffVersion(db, now);
  if (active === null) throw new Error("no tariff version is in force");

  const labServices = new Set((await db.select({ id: services.id }).from(services).where(like(services.id, "LABSVC-%"))).map((s) => s.id));
  const current = new Map((await db.select({ serviceId: tariffItems.serviceId, price: tariffItems.pricePaise }).from(tariffItems)
    .where(and(eq(tariffItems.versionId, active.versionId), like(tariffItems.serviceId, "LABSVC-%")))).map((r) => [r.serviceId, r.price]));
  const noService: string[] = [];
  const changes: { serviceId: string; paise: number }[] = [];
  let unchanged = 0;
  for (const [code, rupees] of Object.entries(LAB_PRICES_2026_10)) {
    const serviceId = `LABSVC-${code}`;
    if (!labServices.has(serviceId)) { noService.push(code); continue; }
    const paise = rupees * 100;
    if (current.get(serviceId) === paise) { unchanged += 1; continue; }
    changes.push({ serviceId, paise });
  }
  if (!apply || changes.length === 0) return { applied: false, priced: changes.length, unchanged, noService, versionNo: null };

  const actor: Actor = { type: "user", id: u.id } as Actor;
  const { versionId } = await withTx(db, async (tx) => {
    const draft = await createDraftVersion(tx, actor, { notes: LAB_PRICE_NOTE, copyFromVersionId: active.versionId });
    for (const c of changes) await setTariffItem(tx, actor, draft.versionId, c.serviceId, c.paise);
    return draft;
  });
  const done = await activateVersionDirectly(db, actor, versionId, now, LAB_PRICE_NOTE);
  return { applied: true, priced: changes.length, unchanged, noService, versionNo: done.versionNo };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("set-lab-prices: DATABASE_URL is not set");
  const args = process.argv.slice(2);
  const at = args.indexOf("--by");
  const by = at >= 0 ? args[at + 1] : undefined;
  if (by === undefined || by.startsWith("--")) throw new Error("usage: --by <username> [--apply]");
  const { db, pool } = createDb(url);
  try {
    const r = await setLabPrices(db, by, args.includes("--apply"));
    console.log(`set-lab-prices — ${JSON.stringify(r)}${r.applied ? "" : " (dry run: add --apply to put them in force)"}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
