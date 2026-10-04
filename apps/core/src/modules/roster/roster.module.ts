import { Module } from "@nestjs/common";
import { RosterBoardController } from "./roster-board.controller";
import { registerRosterPrinting } from "./board-print";
import type { OnModuleInit } from "@nestjs/common";

/**
 * PHASE R (R1) — the module seam, shipped INERT: the screens that would call a controller were the
 * S-series, gated on the owner's sign-off of the four design boards (plan §8).
 *
 * 20-U U5a — the boards are approved (2026-09-20) and the first route is mounted: the "who is on
 * now" board (`GET /roster/on-now`), a read.
 *
 * 20-U infra (owner 2026-10-04) — the board's own paper (`roster_board`): its renderer is registered
 * here, so the print relay's claim (an API route) can draw the stored sheet. The pharmacy precedent.
 */
@Module({ controllers: [RosterBoardController] })
export class RosterModule implements OnModuleInit {
  onModuleInit(): void {
    registerRosterPrinting();
  }
}
