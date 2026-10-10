import { asc, eq } from "drizzle-orm";
import { outsideTests, services } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { outsideTestSaved } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { OutsideTestSite } from "../../kernel/db/schema";

/**
 * ═══ THE OUTSIDE-TEST CATALOGUE (owner 2026-10-10, decision 0065) ═══
 *
 * Each row is a tariff service of its own (`OUTSVC-<code>`, code `OUT-<code>`, category
 * `investigation`), so the doctor's advised test carries one id from the consult to the slip, the
 * lab catalogue's shape. Rows are never deleted: an advised test from last year still names one.
 */
export class OutsideTestError extends Error {
  constructor(readonly code: "not_found" | "bad_input" | "code_taken", message: string) {
    super(message);
    this.name = "OutsideTestError";
  }
}

export type OutsideTestRow = typeof outsideTests.$inferSelect;

export function serviceIdForOutsideCode(code: string): string {
  return `OUTSVC-${code}`;
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,23}$/;

export async function listOutsideTests(exec: Db | Tx, opts: { includeInactive?: boolean } = {}): Promise<OutsideTestRow[]> {
  const rows = await (exec as Db).select().from(outsideTests).orderBy(asc(outsideTests.nameEn));
  return opts.includeInactive === true ? rows : rows.filter((r) => r.active);
}

export type SaveOutsideTestInput = {
  code: string;
  nameEn: string;
  site?: OutsideTestSite;
  department?: string | null;
  active?: boolean;
};

function clean(input: SaveOutsideTestInput): Required<SaveOutsideTestInput> {
  const code = input.code.trim().toUpperCase();
  const nameEn = input.nameEn.trim();
  const site = input.site ?? "outside";
  const department = input.department?.trim() ? input.department.trim() : null;
  if (!CODE_RE.test(code)) throw new OutsideTestError("bad_input", "the code is 1–24 capital letters, digits, - or _");
  if (nameEn.length === 0 || nameEn.length > 120) throw new OutsideTestError("bad_input", "the name is 1–120 characters");
  if (site === "in_hospital" && department === null) {
    throw new OutsideTestError("bad_input", "a test done in the hospital names the department that does it");
  }
  return { code, nameEn, site, department, active: input.active ?? true };
}

/** Add a test, or change one found by its code. The `services` row follows the name and the active flag. */
export async function saveOutsideTest(db: Db, actor: Actor, input: SaveOutsideTestInput, now: Date = new Date()): Promise<OutsideTestRow> {
  const v = clean(input);
  return await withTx(db, async (tx) => {
    const serviceId = serviceIdForOutsideCode(v.code);
    const existing = (await tx.select().from(outsideTests).where(eq(outsideTests.code, v.code)))[0];
    if (existing !== undefined && existing.serviceId !== serviceId) {
      throw new OutsideTestError("code_taken", `code ${v.code} already names another test`);
    }
    const service = (await tx.select({ id: services.id }).from(services).where(eq(services.id, serviceId)))[0];
    if (service === undefined) {
      const taken = (await tx.select({ id: services.id }).from(services).where(eq(services.code, `OUT-${v.code}`)))[0];
      if (taken !== undefined) throw new OutsideTestError("code_taken", `service code OUT-${v.code} is already used`);
      await tx.insert(services).values({
        id: serviceId, code: `OUT-${v.code}`, name: v.nameEn, category: "investigation", active: v.active,
        createdBy: actor.id, updatedBy: actor.id,
      });
    } else {
      await tx.update(services).set({ name: v.nameEn, active: v.active, updatedBy: actor.id, updatedAt: now })
        .where(eq(services.id, serviceId));
    }
    const values = { code: v.code, nameEn: v.nameEn, site: v.site, department: v.site === "outside" ? null : v.department, active: v.active };
    if (existing === undefined) {
      await tx.insert(outsideTests).values({ serviceId, ...values, createdBy: actor.id, updatedBy: actor.id });
    } else {
      await tx.update(outsideTests).set({ ...values, updatedBy: actor.id, updatedAt: now }).where(eq(outsideTests.serviceId, serviceId));
    }
    await appendEvent(tx, outsideTestSaved.make({
      actor, payload: { serviceId, code: v.code, site: v.site, active: v.active, created: existing === undefined },
    }));
    return (await tx.select().from(outsideTests).where(eq(outsideTests.serviceId, serviceId)))[0]!;
  });
}

/** The owner's starting list (2026-10-10). The admin adds more on the Outside tests screen. */
export const OUTSIDE_TEST_SEEDS: readonly { code: string; nameEn: string }[] = [
  { code: "ECG", nameEn: "ECG (12-lead)" },
  { code: "ECHO", nameEn: "2D echocardiography" },
  { code: "TMT", nameEn: "Treadmill test (TMT)" },
  { code: "PFT", nameEn: "Pulmonary function test (PFT)" },
  { code: "EEG", nameEn: "EEG" },
  { code: "NCV", nameEn: "Nerve conduction study (NCV)" },
  { code: "UGIE", nameEn: "Upper GI endoscopy" },
  { code: "COLONO", nameEn: "Colonoscopy" },
  { code: "HOLTER", nameEn: "Holter monitoring (24 h)" },
  { code: "PTA", nameEn: "Audiometry (PTA)" },
];

/** Adds the starting list where a code is missing; never changes a row the admin has edited. */
export async function seedOutsideTests(db: Db, actor: Actor): Promise<{ added: number }> {
  let added = 0;
  for (const seed of OUTSIDE_TEST_SEEDS) {
    const have = (await db.select({ code: outsideTests.code }).from(outsideTests).where(eq(outsideTests.code, seed.code)))[0];
    if (have !== undefined) continue;
    await saveOutsideTest(db, actor, seed);
    added += 1;
  }
  return { added };
}
