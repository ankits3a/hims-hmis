import { Module } from "@nestjs/common";

/**
 * PLAN 16c T1 — the module seam, INERT: no controller yet. T2 mounts the sale-items controller and
 * T3 the counter's (the `MaterialsModule`/`LabModule` precedent — the manifest ships first so the
 * permissions, the roles and the order kind exist before the first route does).
 */
@Module({ controllers: [] })
export class PharmacyModule {}
