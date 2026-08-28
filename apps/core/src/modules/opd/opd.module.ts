import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { registerEncounterResolver } from "../billing";
import { EPISODE_SERIES } from "../../kernel/episodes/series";
import { getEncounter } from "./encounters";
import { RealtimeGateway } from "../../kernel/realtime/gateway";
import { RealtimeModule } from "../../kernel/realtime/realtime.module";
import { OpdMastersController } from "./opd-masters.controller";
import { OpdQueueController } from "./opd-queue.controller";
import { OpdVisitsController } from "./opd-visits.controller";
import { OPD_TOPIC_SPACES, opdTopicRouter } from "./realtime";

/**
 * The module tells the kernel gateway which topic prefixes exist (each with the permission a subscriber must
 * hold) and how an OPD event maps to topics. The kernel knows no module; registration happens at module init,
 * before the gateway's onApplicationBootstrap starts the tail.
 */
@Injectable()
class OpdRealtimeRegistrar implements OnModuleInit {
  constructor(private readonly gateway: RealtimeGateway) {}

  onModuleInit(): void {
    for (const s of OPD_TOPIC_SPACES) this.gateway.registerTopicSpace(s);
    this.gateway.registerRouter(opdTopicRouter);
  }
}

/**
 * PLAN 15 T7 / DD11-F2 — **OPD CLAIMS THE `V` PREFIX with billing's encounter resolver.**
 *
 * Billing used to reach into `getEncounter` directly, which made `opd_encounters` the ONLY thing an
 * invoice could name. The registry inverts it: OPD hands billing a reader for its own letter, the
 * mini-OT does the same for `D`, and billing knows neither module.
 *
 * `registerEncounterResolver` is keyed, so a second module init — a second jest testing module in
 * one worker — REPLACES rather than double-registers. `registerConsultStartGuard`'s reasoning,
 * pointed the other way.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [OpdMastersController, OpdVisitsController, OpdQueueController],
  providers: [OpdRealtimeRegistrar],
})
export class OpdModule implements OnModuleInit {
  onModuleInit(): void {
    registerOpdEncounterResolver();
  }
}

/**
 * Exported so a SUITE can register it without booting Nest. `onModuleInit` is the production path
 * and `opd.e2e` proves that wiring; a unit suite that needs billing to resolve a `V` number should
 * not have to stand up a module graph to get one, and a private copy of the resolver in a fixture
 * would be a second answer to "how does billing find an OPD encounter".
 */
export function registerOpdEncounterResolver(): () => void {
  return registerEncounterResolver(EPISODE_SERIES.visit, async (db, encounterId) => {
    const encounter = await getEncounter(db, encounterId);
    if (!encounter) return null;
    return { patientId: encounter.patientId, intendedPayer: encounter.intendedPayer };
  });
}
