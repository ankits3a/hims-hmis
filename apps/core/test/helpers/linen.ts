import { withTx } from "../../src/kernel/db/client";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../src/kernel/resources";
import { seedLinenItems } from "../../src/modules/linen";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";

/**
 * E2.4 LINEN — a small hospital for the linen tests: the standard catalogue and one floor with three wards.
 *   · General ward (`generalWard`): 10 general beds straight under the ward, plus one RETIRED bed (never counted).
 *   · Private wing (`mixedWard`): a room of 4 private beds and a room of 2 ICU beds (class on each bed).
 *   · ICU (`icuWard`): class `icu` on the WARD and 3 beds without a class of their own (they inherit it).
 * No clock is read here: every instant is the caller's.
 */
export const H1 = "01LINENHANDLER00000000000H1";
export const SUPA = "01LINENSUPERVISOR000000SA";
export const SUPB = "01LINENSUPERVISOR000000SB";
export const actorOf = (id: string): Actor => ({ type: "user", id });
const SEEDER: Actor = { type: "system", id: "linen-fixture" };

export type LinenHospital = { floorId: string; generalWard: string; mixedWard: string; icuWard: string; aGeneralBed: string };

export const hoursFrom = (t0: Date, h: number): Date => new Date(t0.getTime() + h * 3_600_000);

export async function seedLinenHospital(db: Db): Promise<LinenHospital> {
  await seedLinenItems(db);
  return withTx(db, async (tx) => {
    const mk = async (kind: string, code: string, name: string, parentId?: string, attributes?: Record<string, unknown>, status?: string) =>
      (await createResource(tx, SEEDER, KERNEL_RESOURCE_KINDS, {
        kind: kind as "bed", code, name, ...(parentId === undefined ? {} : { parentId }),
        ...(attributes === undefined ? {} : { attributes }), ...(status === undefined ? {} : { status }),
      })).resourceId;
    const floorId = await mk("floor", "LF3", "Floor 3");
    const generalWard = await mk("ward", "LW-GEN", "General ward", floorId);
    let aGeneralBed = "";
    for (let i = 1; i <= 10; i += 1) {
      const id = await mk("bed", `LG-${i}`, `General bed ${i}`, generalWard, { class: "general" });
      if (i === 1) aGeneralBed = id;
    }
    await mk("bed", "LG-X", "Old bed", generalWard, { class: "general" }, "retired");
    const mixedWard = await mk("ward", "LW-MIX", "Private wing", floorId);
    const pvtRoom = await mk("room", "LR-PVT", "Private rooms", mixedWard);
    for (let i = 1; i <= 4; i += 1) await mk("bed", `LP-${i}`, `Private bed ${i}`, pvtRoom, { class: "private" });
    const icuRoom = await mk("room", "LR-ICU", "Step-down ICU", mixedWard);
    for (let i = 1; i <= 2; i += 1) await mk("bed", `LI-${i}`, `ICU bed ${i}`, icuRoom, { class: "icu" });
    const icuWard = await mk("ward", "LW-ICU", "Medical ICU", floorId, { class: "icu" });
    for (let i = 1; i <= 3; i += 1) await mk("bed", `LM-${i}`, `MICU bed ${i}`, icuWard);
    return { floorId, generalWard, mixedWard, icuWard, aGeneralBed };
  });
}
