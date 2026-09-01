import { Module } from "@nestjs/common";
import { PcpndtController } from "./pcpndt.controller";

/**
 * PLAN 18a T6 — the PCPNDT register's Nest wiring.
 *
 * It registers no encounter resolver, owns no episode letter and subscribes to nothing: this module
 * holds tables and rules, and the only asynchronous thing near it is radiology's `order.placed`
 * consumer, which lives in radiology. `pcpndt_form_f_serials` is a counter rather than a series, so
 * even the numbering is local.
 *
 * **It is installed in the WORKER as well as the API** (`manifest.ts`), because the radiology
 * consumer that runs there evaluates DD14's applicability rule — so the worker's registry must
 * carry these permissions for `hasPermission` to answer about them at all.
 */
@Module({ controllers: [PcpndtController] })
export class PcpndtModule {}
