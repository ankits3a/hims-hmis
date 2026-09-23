import { Controller, Get, Inject, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { RequirePermission } from "../../kernel/auth/decorators";
import { parsed, toHttp } from "./pharmacy-http";
import { stockForDoctor } from "./doctor-stock";
import type { DoctorStock } from "./doctor-stock";
import type { Db } from "../../kernel/db/client";

/**
 * CONSULT V2 — the doctor's read of the shelf. Gated on `opd.consult`, the permission that means "this
 * person conducts consultations", not on a pharmacy permission: a doctor holds none and should not, and
 * what this returns is a count per medicine — no batch, no price, no patient.
 */
const stockQuery = z.object({
  medicineIds: z.string().min(1).max(4000).transform((s) => s.split(",").map((x) => x.trim()).filter((x) => x !== "")).pipe(z.array(z.string().min(1).max(64)).min(1).max(40)),
});

@Controller("pharmacy/doctor")
export class PharmacyDoctorController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("opd.consult", "hospital")
  @Get("stock")
  async stock(@Query() query: unknown): Promise<{ items: DoctorStock[] }> {
    const q = parsed(stockQuery, query);
    try {
      return { items: await stockForDoctor(this.db, q.medicineIds) };
    } catch (e) {
      toHttp(e);
    }
  }
}
