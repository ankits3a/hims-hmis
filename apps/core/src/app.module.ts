import { Module, Global } from "@nestjs/common";
import { createDb, Db } from "./kernel/db/client";

export const DB = Symbol("DB");

import { HealthController } from "./health/health.controller";

@Global()
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: DB,
      useFactory: (): Db => {
        const url = process.env.DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_dev";
        return createDb(url).db;
      },
    },
  ],
  exports: [DB],
})
export class AppModule {}
