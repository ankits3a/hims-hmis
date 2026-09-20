import { Module } from "@nestjs/common";

/**
 * PLAN 20 T1 — the module seam, shipped INERT: no controller yet. The screens that would call one
 * are gated on the owner's sign-off of the design boards (phase 20-U §5), and T1's writers are
 * domain functions under test. The `MaterialsModule` / `ResourcesModule` / `PharmacyModule`
 * precedent: the seam lands with the tables, a later task mounts the routes.
 */
@Module({})
export class RosterModule {}
