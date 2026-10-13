import { Module } from "@nestjs/common";
import { registerDocumentRenderer } from "../../kernel/printing/render";
import { BmwController } from "./bmw.controller";
import { BAG_LABEL_DOCUMENT, renderBagLabelJob } from "./label";
import type { OnModuleInit } from "@nestjs/common";

/** The bag label is drawn by THIS module and printed by the kernel's relay (the pharmacy shape). Returns the unregister. */
export function registerBmwPrinting(): () => void {
  return registerDocumentRenderer(BAG_LABEL_DOCUMENT, (db, params) => renderBagLabelJob(db, params));
}

/** Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs. The storage clock is the WORKER's (on `sweepTasks`). */
@Module({ controllers: [BmwController] })
export class BmwModule implements OnModuleInit {
  onModuleInit(): void {
    registerBmwPrinting();
  }
}
