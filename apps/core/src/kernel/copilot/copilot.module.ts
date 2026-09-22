import { Module } from "@nestjs/common";
import { CopilotController } from "./copilot.controller";

/**
 * Controller only, matching `InferenceModule`, `SearchModule` and `OpsModule`: the global
 * `APP_GUARD`s registered by `AuthModule` do the authentication, and `DB`, `CONFIG` and
 * `MODULE_REGISTRY` are `@Global` from `AppModule`.
 */
@Module({ controllers: [CopilotController] })
export class CopilotModule {}
