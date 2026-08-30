import { Controller, Get, Inject, Param, Post, Body, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { labOrderables } from "../../kernel/db/schema";
import { analytesFor, getOrderable, rangesFor, upsertAnalyte, upsertOrderable } from "./catalogue";
import { duplicateWarnings } from "./duplicates";
import { idSchema, parsed, toHttp } from "./lab-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17b T8 — **THE CATALOGUE OVER HTTP**: what this hospital's laboratory can be asked for.
 *
 * Curation is `lab.catalogue.manage` (the pathologist's) and reading is `lab.catalogue.read`
 * (everybody at the counter). The split is DD16's and it is the reason the desk screen can render
 * a test list without giving a clerk the power to invent one.
 */
const analyteBody = z.object({
  code: z.string().min(1).max(32),
  nameEn: z.string().min(1).max(160),
  nameHi: z.string().max(160).nullish(),
  resultType: z.enum(["numeric", "text", "coded", "formula"]),
  unit: z.string().max(32).nullish(),
  decimals: z.number().int().min(0).max(6).optional(),
  formula: z.string().max(200).nullish(),
  formulaGuard: z.string().max(200).nullish(),
  absurdLow: z.string().max(24).nullish(),
  absurdHigh: z.string().max(24).nullish(),
  criticalLow: z.string().max(24).nullish(),
  criticalHigh: z.string().max(24).nullish(),
  deltaAbs: z.string().max(24).nullish(),
  deltaPct: z.string().max(24).nullish(),
  deltaWindowHours: z.number().int().positive().nullish(),
  loincCode: z.string().max(32).nullish(),
});

const orderableBody = z.object({
  serviceId: idSchema,
  code: z.string().min(1).max(32),
  nameEn: z.string().min(1).max(160),
  nameHi: z.string().max(160).nullish(),
  discipline: z.enum([
    "haematology", "biochemistry", "serology", "clinical_pathology", "microbiology", "histopathology",
  ]),
  specimenType: z.string().min(1).max(48),
  container: z.string().min(1).max(48),
  minVolumeMl: z.string().max(16).nullish(),
  benchKey: z.string().max(48).nullish(),
  tatMinutesRoutine: z.number().int().positive(),
  tatMinutesStat: z.number().int().positive().nullish(),
  requiresFasting: z.boolean().optional(),
  consentRequired: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  notifiable: z.boolean().optional(),
  /** E33 — accepted ONLY so it can be refused by name. PCPNDT Act 1994; not a configuration option. */
  reportsFoetalSex: z.boolean().optional(),
  active: z.boolean().optional(),
  analyteCodes: z.array(z.string().min(1).max(32)).min(1),
});

const duplicatesBody = z.object({
  patientId: idSchema,
  serviceIds: z.array(idSchema).min(1),
});

@Controller("lab/catalogue")
export class LabCatalogueController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The analytes an orderable reports, IN REPORT ORDER — what a bench screen reads down. */
  @Get("orderables/:serviceId")
  @RequirePermission("lab.catalogue.read", "hospital")
  async orderable(@Param("serviceId") serviceId: string): Promise<unknown> {
    try {
      const [row, analytes] = await Promise.all([
        getOrderable(this.db, serviceId),
        analytesFor(this.db, serviceId),
      ]);
      return { orderable: row, analytes };
    } catch (e) { toHttp(e); }
  }

  /** One analyte's reference bands — the range book a curator reads before editing it. */
  @Get("analytes/:analyteId/ranges")
  @RequirePermission("lab.catalogue.read", "hospital")
  async ranges(@Param("analyteId") analyteId: string): Promise<unknown> {
    try { return await rangesFor(this.db, analyteId); } catch (e) { toHttp(e); }
  }

  @Post("analytes")
  @RequirePermission("lab.catalogue.manage", "hospital")
  async putAnalyte(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(analyteBody, body);
    try {
      const id = await withTx(this.db, (tx) => upsertAnalyte(tx, actor, input));
      return { analyteId: id };
    } catch (e) { toHttp(e); }
  }

  @Post("orderables")
  @RequirePermission("lab.catalogue.manage", "hospital")
  async putOrderable(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(orderableBody, body);
    try {
      await withTx(this.db, (tx) => upsertOrderable(tx, actor, input));
      return { ok: true };
    } catch (e) { toHttp(e); }
  }

  /**
   * 02 D11 — WHAT THE COUNTER SHOWS BEFORE IT PLACES. The desk refuses an unacknowledged duplicate
   * outright (`duplicate_unacknowledged`), so this is the read that lets a clerk see the warning
   * and decide, rather than meeting the refusal with a basket they cannot fix.
   */
  @Post("duplicates")
  @RequirePermission("lab.catalogue.read", "hospital")
  async duplicates(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(duplicatesBody, body);
    try {
      return await withTx(this.db, (tx) =>
        duplicateWarnings(tx, actor, input.patientId, input.serviceIds, new Date()));
    } catch (e) { toHttp(e); }
  }

  /** The catalogue as a LIST — a desk screen's test picker. `q` narrows on code or English name. */
  @Get("search")
  @RequirePermission("lab.catalogue.read", "hospital")
  async search(@Query("q") q?: string): Promise<unknown> {
    const rows = await this.db.select({
      serviceId: labOrderables.serviceId, code: labOrderables.code, nameEn: labOrderables.nameEn,
      nameHi: labOrderables.nameHi, discipline: labOrderables.discipline,
      specimenType: labOrderables.specimenType, container: labOrderables.container,
      consentRequired: labOrderables.consentRequired, sensitive: labOrderables.sensitive,
      active: labOrderables.active,
    }).from(labOrderables).orderBy(labOrderables.code);
    const needle = (q ?? "").trim().toLowerCase();
    const matched = needle === ""
      ? rows
      : rows.filter((r) => r.code.toLowerCase().includes(needle) || r.nameEn.toLowerCase().includes(needle));
    /** ACTIVE ONLY at the counter: a withdrawn orderable is refused by the desk anyway. */
    return matched.filter((r) => r.active).slice(0, 100);
  }
}
