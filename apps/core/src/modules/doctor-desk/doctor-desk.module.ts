import { Module } from "@nestjs/common";
import { DoctorDeskController } from "./doctor-desk.controller";

/** DD-0 (#626) — the Doctor Desk: a leaf module (plan D-A). It owns briefs, nudges, agent runs and reads; it writes no clinical row. */
@Module({ controllers: [DoctorDeskController] })
export class DoctorDeskModule {}
