import { Module } from "@nestjs/common";
import { CopilotController } from "./copilot.controller";
import { CopilotHaltController } from "./halt.controller";
import { COPILOT_EXTRA_TOOLS } from "./act";

/**
 * Controller only, matching `InferenceModule`, `SearchModule` and `OpsModule`: the global
 * `APP_GUARD`s registered by `AuthModule` do the authentication, and `DB`, `CONFIG` and
 * `MODULE_REGISTRY` are `@Global` from `AppModule`.
 */
@Module({
  controllers: [CopilotController, CopilotHaltController],
  /* E0.2 — empty in production; the confirm protocol's e2e test overrides it with its fixture tool. */
  providers: [{ provide: COPILOT_EXTRA_TOOLS, useValue: [] }],
})
export class CopilotModule {}
