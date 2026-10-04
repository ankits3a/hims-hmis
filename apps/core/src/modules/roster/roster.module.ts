import { Module } from "@nestjs/common";
import { RosterBoardController } from "./roster-board.controller";

/**
 * PHASE R (R1) — the module seam, shipped INERT: the screens that would call a controller were the
 * S-series, gated on the owner's sign-off of the four design boards (plan §8).
 *
 * 20-U U5a — the boards are approved (2026-09-20) and the first route is mounted: the "who is on
 * now" board (`GET /roster/on-now`), a read.
 */
@Module({ controllers: [RosterBoardController] })
export class RosterModule {}
