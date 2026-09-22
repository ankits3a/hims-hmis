import { Module } from "@nestjs/common";
import { ReachController } from "./reach.controller";

/**
 * PHASE O T4 — the FIRST api-side surface `kernel/notify` has ever had. The outbox and the pump
 * are worker machinery with no routes (`notifyManifest`'s docstring says so in as many words);
 * `/me/reach` is a person's own settings page and belongs to the api.
 *
 * It declares no manifest. The routes are identity-scoped and permissionless exactly like the
 * alerts routes (D6), so there is no permission to declare and no menu entry — the page is
 * linked from the bell's footer, not from the nav (`caddyfile-parity` gains the route, the NAV
 * census does not move).
 *
 * Guards are NOT registered here — AuthGuard and PermissionGuard are global APP_GUARDs.
 */
@Module({ controllers: [ReachController] })
export class ReachModule {}
