import { Module } from "@nestjs/common";
import { AerbController } from "./aerb.controller";

/**
 * PLAN 18c T1 — the AERB register's Nest wiring.
 *
 * It registers no encounter resolver, owns no episode letter and subscribes to nothing: this module
 * holds tables and rules, and the one thing near it that could have been asynchronous is not —
 * radiology's `startAcquisition` calls `assertDeviceLicensed` synchronously, inside its own
 * transaction, on an HTTP path.
 *
 * **It is therefore installed in `app.module.ts` and NOT in `worker.module.ts`** — the `desk` shape
 * rather than the `pcpndt` one, and the difference is worth stating because the two modules
 * otherwise look alike. `pcpndt` is in the worker because radiology's `order.placed` consumer runs
 * there and asks `hasPermission` about a `pcpndt.*` string; nothing in that process asks about an
 * `aerb.*` one. `manifests.test.ts` pins that difference rather than trusting this paragraph.
 */
@Module({
  controllers: [AerbController],
})
export class AerbModule {}
