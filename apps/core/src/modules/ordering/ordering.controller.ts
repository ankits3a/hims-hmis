import { Body, Controller, Get, HttpException, Inject, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { listOutsideTests, OutsideTestError, saveOutsideTest } from "./outside";
import { searchOrderableTests } from "./route";
import { orderTests } from "./seam";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";

/**
 * THE ORDERING DOOR (decision 0065). No new permission:
 *   · reading the test lists rides `tariff.read`, which every doctor and desk already holds for the price list;
 *   · curating the outside list rides `tariff.services.manage`, the service master's own grant;
 *   · ordering rides `orders.place`, and `placeOrder` then asks for each department's own permission.
 */
const id = z.string().min(1).max(64);
const saveBody = z.object({
  code: z.string().min(1).max(24),
  nameEn: z.string().min(1).max(120),
  site: z.enum(["outside", "in_hospital"]).optional(),
  department: z.string().max(80).nullable().optional(),
  active: z.boolean().optional(),
}).strict();
const orderBody = z.object({
  patientId: id,
  encounterNo: z.string().min(1).max(32),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  orderingClinicianId: id,
  serviceIds: z.array(id).min(1).max(60),
  indication: z.string().min(1).max(500),
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
}).strict();

function bad(message: string, code: string, status = 400): never {
  throw new HttpException({ statusCode: status, message, code }, status);
}

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) bad(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "bad_input");
  return r.data;
}

@Controller("ordering")
export class OrderingController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  @Get("outside-tests")
  @RequirePermission("tariff.read", "hospital")
  async outside(@Query("all") all?: string): Promise<unknown> {
    return { items: await listOutsideTests(this.db, { includeInactive: all === "1" }) };
  }

  @Put("outside-tests")
  @RequirePermission("tariff.services.manage", "hospital")
  async saveOutside(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try {
      return await saveOutsideTest(this.db, actor, parsed(saveBody, body));
    } catch (e) {
      if (e instanceof OutsideTestError) bad(e.message, e.code, e.code === "not_found" ? 404 : e.code === "code_taken" ? 409 : 400);
      throw e;
    }
  }

  @Get("tests")
  @RequirePermission("tariff.read", "hospital")
  async tests(@Query("q") q?: string): Promise<unknown> {
    return { items: await searchOrderableTests(this.db, (q ?? "").slice(0, 80)) };
  }

  /** The seam for the IPD and Emergency screens: each test goes to its department; refusals come back under `skipped`. */
  @Post("orders")
  @RequirePermission("orders.place", "hospital")
  async order(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    return orderTests(this.db, actor, collectOrderKinds(this.registry), parsed(orderBody, body));
  }
}
