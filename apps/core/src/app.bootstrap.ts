import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * Shared HTTP configuration for main.ts AND e2e apps. Express's default json limit is 100 kb;
 * patient photos ride base64 JSON (512 kB cap ≈ 683 kB encoded), so the app registers its own
 * parsers. Callers MUST create the Nest app with { bodyParser: false } or two parsers stack.
 */
export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser("json", { limit: "1mb" });
  app.useBodyParser("urlencoded", { extended: true });
}
