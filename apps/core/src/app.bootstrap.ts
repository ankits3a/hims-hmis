import type { NestExpressApplication } from "@nestjs/platform-express";
import { DEFAULT_TRUSTED_PROXY_CIDRS, FrameworkErrorFilter, noStore, trustOneProxyHop } from "./http-hardening";

/**
 * Shared HTTP configuration for main.ts AND e2e apps. Express's default json limit is 100 kb;
 * patient photos ride base64 JSON (512 kB cap ≈ 683 kB encoded), so the app registers its own
 * parsers. Callers MUST create the Nest app with { bodyParser: false } or two parsers stack.
 *
 * WASA M-05 / L-01 / L-09 settings live here for the same reason X-Powered-By's does: one call
 * site for production and every e2e app, so a test proves what production serves. Each is argued
 * in `http-hardening.ts`. `trustedProxyCidrs` comes from `TRUSTED_PROXY_CIDRS` in main.ts; an e2e
 * app gets the default, which trusts loopback — the hop supertest arrives on.
 */
export function configureApp(
  app: NestExpressApplication,
  opts: { trustedProxyCidrs?: readonly string[] } = {},
): void {
  const express = app.getHttpAdapter().getInstance();
  // ONE hop, and only from the compose network — never `true`, which believes the client.
  express.set("trust proxy", trustOneProxyHop(opts.trustedProxyCidrs ?? DEFAULT_TRUSTED_PROXY_CIDRS));
  // Before the parsers, so even a 400/413 the parser raises carries it.
  app.use(noStore);
  app.useBodyParser("json", { limit: "1mb" });
  app.useBodyParser("urlencoded", { extended: true });
  // Express stamps `X-Powered-By: Express` on every response: it names the stack to an attacker
  // and tells a user nothing. Disabled HERE, not in main.ts, so production and every e2e app get
  // it from the one shared place — a second call site is a second chance to forget.
  express.disable("x-powered-by");
  app.useGlobalFilters(new FrameworkErrorFilter(app.getHttpAdapter()));
}
