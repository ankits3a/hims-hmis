import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.bootstrap";
import { loadConfig } from "./kernel/config";
import { DB } from "./kernel/tokens";
import { applyApiDatabaseUrl, warnIfDatabaseSuperuser } from "./kernel/db/role-check";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "./kernel/db/client";

async function bootstrap(): Promise<void> {
  // WASA M-07 — FIRST, before any config is read: the API alone may run on the non-superuser role
  // (`API_DATABASE_URL`); the worker, migrator and scripts keep DATABASE_URL. See role-check.ts.
  applyApiDatabaseUrl(process.env);
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app, { trustedProxyCidrs: cfg.trustedProxyCidrs ?? undefined });
  app.enableShutdownHooks();
  // WASA M-07 — says so when the API holds a superuser connection. WARNS, never refuses, and
  // swallows its own failure: see kernel/db/role-check.ts. Here and not in AppModule because only
  // the API process belongs on the non-superuser role; e2e suites boot AppModule as a superuser.
  await warnIfDatabaseSuperuser(app.get<Db>(DB), { warn: (m) => { console.warn(`db: ${m}`); } });
  await app.listen(cfg.port);
}
void bootstrap();
