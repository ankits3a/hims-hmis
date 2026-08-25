import { Module } from "@nestjs/common";
import { SpeechController } from "./speech.controller";

/**
 * Controller only, matching `SearchModule`/`OpsModule`: the global `APP_GUARD`s registered by
 * `AuthModule` do the authentication, and `Db`/`CONFIG` are `@Global` from `AppModule`.
 */
@Module({ controllers: [SpeechController] })
export class InferenceModule {}
