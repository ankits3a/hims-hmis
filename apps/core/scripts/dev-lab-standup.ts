import { eq, sql } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { withTx } from "../src/kernel/db/client";
import { approveRequest } from "../src/kernel/approvals/decisions";
import { opdDepartments, services, tariffItems, tariffVersions, users } from "../src/kernel/db/schema";
import { activateDefinition, approveDefinition, createDraft, getActiveDefinition } from "../src/kernel/workflow/definitions";
import { createDepartment, createDoctor } from "../src/modules/opd/masters";
import { OPD_VISIT_DEFINITION_JSON, OPD_VISIT_DEF_KEY } from "../src/modules/opd/workflow-def";
import { activateVersion, createDraftVersion, setTariffItem, submitVersion } from "../src/modules/tariff/versions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ THE LABORATORY'S STAND-UP, AS AN EXECUTABLE — FOR A DEV DATABASE AND NOTHING ELSE ═══
 *
 * ██ THIS SCRIPT MUST NEVER BE RUN AGAINST PRODUCTION, AND IT REFUSES TO BE. ██
 *
 * `docs/runbooks/lab-go-live.md` §1–§4 name four acts a human performs before a laboratory can take
 * its first order: declare the LAB department, appoint a pathologist of record, activate the
 * `opd_visit` workflow definition, and price the catalogue through an ACTIVATED tariff version.
 * Every one of them is a real ceremony with real separation-of-duties controls, and **none of them
 * has a shell entry point** — which is why nobody had ever walked the five seats end to end.
 *
 * This is the DEV half of that, so a lane can stand a laboratory up in two minutes and LOOK at it.
 * The production half stays exactly where it is: the owner's own hands, on his own data, through the
 * shipped screens. The two must not be confused, and a recipe without this paragraph is how they get
 * confused — so the refusal below is load-bearing and not a courtesy.
 *
 * ═══ WHAT IT DOES NOT DO, AND WILL NOT BE MADE TO DO ═══
 *
 *  · It creates no user and no credential. `seed:staff` owns that, on stdin, deliberately (its D4).
 *  · It invents no clinical value. `seed:lab-catalogue`'s ranges are kit-insert numbers and that
 *    script refuses production for the same reason this one does.
 *  · It grants nothing that is not needed to satisfy a control it cannot route around. The tariff
 *    ceremony has THREE separation-of-duties checks and direct SQL satisfies none of them; the
 *    honest answer is to perform the ceremony with two real users, not to bypass it.
 *
 * USAGE (from `apps/core`, with the demo staff already created by `seed:staff`):
 *
 *     DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_lims_dev \
 *       pnpm tsx scripts/dev-lab-standup.ts
 */

/**
 * ═══ THREE REAL USERS, AND THE THIRD IS A MEASUREMENT RATHER THAN A PREFERENCE ═══
 *
 * `approveDefinition` refuses `duplicate_approval` on `(definitionId, approverId)` — **per PERSON,
 * not per role key** (`definitions.ts:145-154`). So a single account holding both `owner` and
 * `medical_superintendent` cannot supply both keys: activating `opd_visit` needs **two distinct
 * humans**, and the runbook's talk of a "two-key ceremony" is literal.
 *
 * That is the same control the register's Class-A two-key rule and the lab's own DD11 separation of
 * duties express, and it is why **owner item O1 — a second approving actor — is a real gate on this
 * laboratory and not a nicety**. Measured here by being refused, not inferred from the schema.
 */
const CURATOR = "dr.meera"; // pathologist — drafts the definition, drafts and submits the tariff
const APPROVER = "ramesh.front"; // owner — approves, and activates
const SUPERINTENDENT = "supt.rao"; // medical_superintendent — the SECOND pair of hands

async function actorFor(db: Db, username: string): Promise<Actor> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
  if (!row) {
    throw new Error(
      `dev-lab-standup: no user "${username}". Create the demo staff first with seed:staff — this ` +
        "script deliberately creates no credentials.",
    );
  }
  return { type: "user", id: row.id };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("dev-lab-standup: DATABASE_URL is not set");

  /**
   * ═══ THE REFUSAL ═══
   *
   * `:5434` is `hmis-prod-db-1`; `:5433` is the dev instance. The port check and the NODE_ENV check
   * are BOTH here rather than either alone, because each catches a case the other misses: a
   * production URL reached through a different port, and a dev port on a production image.
   */
  if (url.includes(":5434") || process.env.NODE_ENV === "production") {
    throw new Error(
      "dev-lab-standup: REFUSED. This performs the laboratory's stand-up ceremonies with synthetic " +
        "actors and a placeholder price list. On production every one of those acts belongs to the " +
        "owner, through the shipped screens, on his own data — see docs/runbooks/lab-go-live.md.",
    );
  }

  const { db, pool } = createDb(url);
  try {
    const curator = await actorFor(db, CURATOR);
    const approver = await actorFor(db, APPROVER);
    const superintendent = await actorFor(db, SUPERINTENDENT);

    /* ── 1. THE LAB DEPARTMENT (runbook §3) ─────────────────────────────────────────────── */
    let [lab] = await db.select().from(opdDepartments).where(eq(opdDepartments.code, "LAB"));
    if (!lab) {
      await withTx(db, (tx) => createDepartment(tx, approver, { code: "LAB", name: "Laboratory" }));
      [lab] = await db.select().from(opdDepartments).where(eq(opdDepartments.code, "LAB"));
      console.log("LAB department: created");
    } else {
      console.log("LAB department: already present");
    }

    /* ── 2. THE PATHOLOGIST OF RECORD (runbook §3) ──────────────────────────────────────── */
    try {
      const { doctorId } = await withTx(db, (tx) => createDoctor(tx, approver, {
        username: CURATOR,
        displayName: "Dr Meera Iyer",
        /** The council number the e-Rx prints and the lab report now prints beside the name. */
        registrationNo: "UPMC-45219",
        departmentId: lab!.id,
        specialty: "Pathology",
      }));
      console.log(`pathologist of record: ${doctorId}`);
    } catch (e) {
      console.log(`pathologist of record: ${(e as Error).message}`);
    }

    /* ── 3. THE `opd_visit` DEFINITION — a real two-key ceremony (runbook §1) ───────────── */
    /** `getActiveDefinition` takes a `Tx`, so the read rides one — it is a read either way. */
    if (await withTx(db, (tx) => getActiveDefinition(tx, OPD_VISIT_DEF_KEY)).catch(() => null)) {
      console.log(`${OPD_VISIT_DEF_KEY}: already active`);
    } else {
      const { definitionId } = await createDraft(db, curator, OPD_VISIT_DEFINITION_JSON);
      /** Two DIFFERENT people. One account holding both roles is refused `duplicate_approval`. */
      await approveDefinition(db, approver, {
        definitionId, roleKey: "owner", note: "dev stand-up — synthetic environment",
      });
      await approveDefinition(db, superintendent, {
        definitionId, roleKey: "medical_superintendent", note: "dev stand-up — synthetic environment",
      });
      await activateDefinition(db, approver, definitionId);
      console.log(`${OPD_VISIT_DEF_KEY}: drafted, approved by TWO PEOPLE, ACTIVATED`);
    }

    /* ── 4. THE `investigation` GST CATEGORY — A DEV PLACEHOLDER, AND THE REASON IT IS ONE ─── */
    /**
     * ═══ THIS ROW'S REAL VALUE IS NOT MINE TO CHOOSE ═══
     *
     * `seed-lab-catalogue.ts:98` creates every lab `services` row with `category: "investigation"`,
     * and `seed:tariff` seeds EIGHT categories, none of them that one. So the first lab order refuses
     * `gst_config_missing` — reached AFTER `tariff_item_missing`, which is why a stand-up meets the
     * tariff refusal first and the GST one second, and why the two get confused.
     *
     * **The rate and the SAC code are a money-and-law question**: a diagnostic service supplied by a
     * clinical establishment is exempt healthcare under Notification 12/2017, but which SAC it is
     * booked against and whether a given laboratory qualifies is the hospital's CA's answer and the
     * owner's ruling, not a developer's. `seed-tariff.ts` says the same of its own eight rows —
     * *"ALL DEV PLACEHOLDERS — CA sign-off required (§19)"*.
     *
     * So this mirrors `procedure` exactly, is labelled a placeholder in the row itself, and exists
     * only so a dev walk can price a tube. **`seed:tariff` needs this row for real**, and that is a
     * commissioning task with an owner ruling attached — reported, not decided here.
     */
    await db.execute(sql`
      insert into gst_config (category, sac_code, exempt, rate_bps, updated_by)
      values ('investigation', '999312', true, 1800, ${'dev-lab-standup PLACEHOLDER — CA sign-off required'})
      on conflict (category) do nothing
    `);
    console.log("gst_config 'investigation': present (DEV PLACEHOLDER — the real rate is a CA/owner ruling)");

    /* ── 5. AN ACTIVATED TARIFF VERSION, PRICING EVERY LAB SERVICE (runbook §4) ─────────── */
    /**
     * `"activated"`, not `"active"` — measured from the row, after this guard's first draft got the
     * literal wrong and cheerfully built a SECOND version on a re-run. An idempotency check that
     * tests the wrong string is not idempotent, and it fails in the direction that makes more state.
     */
    const active = await db.select().from(tariffVersions).where(eq(tariffVersions.status, "activated"));
    if (active.length > 0) {
      console.log(`tariff: version ${active[0]!.versionNo} already active`);
    } else {
      const priceable = await db.select({ id: services.id, code: services.code }).from(services);
      const { versionId, versionNo } = await withTx(db, (tx) => createDraftVersion(tx, curator, {
        notes: "dev stand-up — PLACEHOLDER PRICES, never a real price list",
      }));
      /**
       * An empty version is refused (`empty_version`), and a lab order whose service carries no
       * `tariff_items` row refuses with `tariff_item_missing` long before GST is consulted — which is
       * the refusal a walk meets first and the one people misdiagnose as a GST problem.
       */
      for (const s of priceable) {
        await withTx(db, (tx) => setTariffItem(tx, curator, versionId, s.id, 30000));
      }
      const { approvalId } = await withTx(db, (tx) => submitVersion(tx, curator, versionId, "dev stand-up"));
      await approveRequest(db, approver, { approvalId, note: "dev stand-up — synthetic environment" });
      /**
       * BACKDATED, because `resolveActiveTariffVersion` wants `effectiveFrom <= the moment being
       * priced` and the demo encounters this walks already exist with earlier service dates.
       */
      await activateVersion(db, approver, versionId, new Date("2026-01-01T00:00:00Z"));
      console.log(`tariff: version ${versionNo} ACTIVATED with ${priceable.length} priced services`);
    }

    const priced = await db.select().from(tariffItems);
    console.log(`\nstand-up complete — ${priced.length} priced services, LAB department live.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e); process.exit(1); });
}
