import { and, eq } from "drizzle-orm";
import { createDb, withTx, type Db } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createResource } from "../src/kernel/resources/registry";
import { createService } from "../src/modules/tariff";
import { resources, services } from "../src/kernel/db/schema";
import {
  IMAGING_MODALITIES, RADIOLOGY_RESOURCE_KINDS, STUDY_TYPE_SEEDS, activateSeededDefinition,
  draftDefinition, registerRadiologyApprovalTypes,
} from "../src/modules/radiology";
import type { Actor } from "@hmis/contracts";
import type { StudyType } from "../src/modules/radiology";

/**
 * `pnpm --filter @hmis/core seed:radiology` — the go-live step that gives the imaging department
 * something to be. **PLAN 18a T4.**
 *
 * ═══ WHAT IT DOES, AND THE ONE THING IT DELIBERATELY DOES NOT ═══
 *
 * It creates the tariff services the twenty study types bind to, the five `device` resources the
 * scheduler books onto, and it drafts AND ACTIVATES the `study_types` definition.
 *
 * ═══ IT SELF-PUBLISHES — OWNER RULING, 2026-08-31 ═══
 *
 * T4 first shipped this drafting and stopping, on the argument that a seed granting its own approval
 * makes the governed-definition design decorative. **The owner ruled otherwise for the pilot**: a
 * department that cannot be stood up without a second human standing by is held on the same
 * second-administrator shortfall as Plan 17b, and that is too high a price for a seed step.
 *
 * The activation is honest rather than a rubber stamp. `activateSeededDefinition` re-parses the body
 * (a bad book is still refused), supersedes any previous active version in the same transaction, and
 * **leaves `approval_id` NULL** — so a seeded activation stays distinguishable from a governed one
 * for ever. It does NOT mint a second system actor to approve itself, which is the form that would
 * have destroyed the audit answer.
 *
 * **The governed path is untouched.** `radiology-definitions.controller.ts`'s publish route still
 * requires a granted MS approval, and it is still the only way a HUMAN changes the book. Every
 * version after this first one goes through it.
 *
 * ═══ PRICES ARE NOT INVENTED ═══
 *
 * Spike S6 measured production carrying SIX services in three categories and **no imaging service at
 * all**. This script creates the service ROWS so the study-type book has something to bind to, and
 * sets no price: a phase that invented prices would be inventing money, and the tariff is the
 * owner's data. The rate list is entered through the tariff screens afterwards.
 *
 * ═══ HARDWARE: "STANDARD MACHINERY EXISTS", AND NOTHING MORE ═══
 *
 * The owner's standing rule permits assuming standard machinery. So: one X-ray, one ultrasound, one
 * CT, one MRI and one mammography unit, each a `device` resource carrying its `modality` attribute —
 * which is what `scheduleStudy` matches a study type against. A hospital with two CTs adds the
 * second through the resources screen; this script does not guess at an inventory.
 *
 * **Idempotent**: every step is find-or-create, so a re-run after a partial failure completes rather
 * than duplicating. `seed:roles`' own posture.
 */

const MODALITY_MACHINES: { modality: (typeof IMAGING_MODALITIES)[number]; code: string; name: string }[] = [
  { modality: "xray", code: "XR-1", name: "X-ray room 1" },
  { modality: "usg", code: "USG-1", name: "Ultrasound room 1" },
  { modality: "ct", code: "CT-1", name: "CT scanner" },
  { modality: "mri", code: "MRI-1", name: "MRI scanner" },
  { modality: "mammography", code: "MMG-1", name: "Mammography unit" },
];

/** The actor a seed runs as. Named so an audit row says which script wrote the row. */
const SEEDER: Actor = { type: "system", id: "seed:radiology" };

async function ensureService(db: Db, code: string, name: string): Promise<string> {
  const existing = await db.select({ id: services.id }).from(services).where(eq(services.code, code));
  if (existing[0]) return existing[0].id;
  const { serviceId } = await withTx(db, (tx) => createService(tx, SEEDER, {
    code, name, category: "investigation",
  }));
  return serviceId;
}

async function ensureDevice(
  db: Db,
  spec: { modality: string; code: string; name: string },
): Promise<{ resourceId: string; created: boolean }> {
  const existing = await db.select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.kind, "device"), eq(resources.code, spec.code)));
  if (existing[0]) return { resourceId: existing[0].id, created: false };
  const { resourceId } = await withTx(db, (tx) => createResource(tx, SEEDER, RADIOLOGY_RESOURCE_KINDS, {
    kind: "device",
    code: spec.code,
    name: spec.name,
    attributes: { modality: spec.modality },
  }));
  return { resourceId, created: true };
}

export async function seedRadiology(db: Db): Promise<{
  services: number;
  devicesCreated: number;
  definitionId: string;
  version: number;
}> {
  /** The approval TYPE must exist before a publish can be requested against it. */
  await registerRadiologyApprovalTypes(db, SEEDER);

  const serviceIdByCode = new Map<string, string>();
  for (const seed of STUDY_TYPE_SEEDS) {
    serviceIdByCode.set(seed.service_code, await ensureService(db, seed.service_code, seed.name));
  }

  let devicesCreated = 0;
  for (const machine of MODALITY_MACHINES) {
    const { created } = await ensureDevice(db, machine);
    if (created) devicesCreated += 1;
  }

  /**
   * The book, with each seed's `service_code` replaced by the id its row actually got. This is why
   * the seeds carry a CODE: a `services.id` is a ULID minted at creation and cannot live in a
   * constant.
   */
  const types: StudyType[] = STUDY_TYPE_SEEDS.map(({ service_code, ...rest }) => ({
    ...rest,
    service_id: serviceIdByCode.get(service_code)!,
  }));

  const drafted = await withTx(db, (tx) =>
    draftDefinition(tx, SEEDER, { kind: "study_types", body: { types } }));
  await activateSeededDefinition(db, SEEDER, drafted.definitionId);

  return {
    services: serviceIdByCode.size,
    devicesCreated,
    definitionId: drafted.definitionId,
    version: drafted.version,
  };
}

async function main(): Promise<void> {
  const db = createDb(requireEnv("DATABASE_URL")).db;
  const result = await seedRadiology(db);
  console.log(
    `seed:radiology — ${String(result.services)} services ensured, `
    + `${String(result.devicesCreated)} device(s) created, `
    + `study_types v${String(result.version)} ACTIVE as ${result.definitionId}.`,
  );
  console.log(
    "Activated by the seed (owner ruling 2026-08-31), so `approval_id` is NULL on that row — "
    + "which is how a seeded activation stays distinguishable from a governed one. Every LATER "
    + "version goes through the medical superintendent's approval, and the publish route is "
    + "unchanged. Prices are NOT set: the tariff is the owner's data.",
  );
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
