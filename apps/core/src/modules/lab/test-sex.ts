import { inArray, isNotNull } from "drizzle-orm";
import type { SexSpecificTest, TestSex } from "@hmis/contracts";
import { labAnalytes, labOrderableAnalytes, labOrderables } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * OWNER 2026-11-12 — the tests that are for one sex only (`packages/contracts/src/lab-sex.ts`): every parameter of
 * the test carries the same `applies_to_sex`. A panel that mixes, or has any parameter for both sexes, is not.
 * `serviceIds` narrows the answer; without it every such test in the catalogue is returned.
 */
export async function sexSpecificTests(exec: Db | Tx, serviceIds?: readonly string[]): Promise<SexSpecificTest[]> {
  if (serviceIds !== undefined && serviceIds.length === 0) return [];
  const marked = await exec.select({ id: labAnalytes.id, sex: labAnalytes.appliesToSex })
    .from(labAnalytes).where(isNotNull(labAnalytes.appliesToSex));
  if (marked.length === 0) return [];
  const sexOf = new Map(marked.map((a) => [a.id, a.sex as TestSex]));
  const links = await exec.select({ serviceId: labOrderableAnalytes.serviceId, analyteId: labOrderableAnalytes.analyteId })
    .from(labOrderableAnalytes)
    .where(serviceIds === undefined ? undefined : inArray(labOrderableAnalytes.serviceId, [...serviceIds]));
  const byService = new Map<string, string[]>();
  for (const l of links) byService.set(l.serviceId, [...(byService.get(l.serviceId) ?? []), l.analyteId]);
  const found: { serviceId: string; forSex: TestSex }[] = [];
  for (const [serviceId, ids] of byService) {
    const first = sexOf.get(ids[0]!);
    if (first !== undefined && ids.every((id) => sexOf.get(id) === first)) found.push({ serviceId, forSex: first });
  }
  if (found.length === 0) return [];
  const codes = new Map((await exec.select({ serviceId: labOrderables.serviceId, code: labOrderables.code })
    .from(labOrderables).where(inArray(labOrderables.serviceId, found.map((f) => f.serviceId)))).map((o) => [o.serviceId, o.code]));
  return found.map((f) => ({ ...f, code: codes.get(f.serviceId) ?? f.serviceId })).sort((a, b) => a.code.localeCompare(b.code));
}
