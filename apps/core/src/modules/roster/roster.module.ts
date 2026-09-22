import { Module } from "@nestjs/common";

/**
 * PHASE R (R1) — the module seam, shipped INERT: no controller yet. The screens that would call one
 * are the S-series, gated on the owner's sign-off of the four design boards (plan §8), and R1's
 * writers are a seed script and domain functions under test. The `MaterialsModule` /
 * `ResourcesModule` / `PharmacyModule` precedent: the seam lands with the tables, a later task
 * mounts the routes.
 */
@Module({})
export class RosterModule {}
