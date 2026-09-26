import { BlockList, isIP } from "node:net";
import { STATUS_CODES } from "node:http";
import { ArgumentsHost, Catch, HttpException, Logger } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import type { NextFunction, Request, Response } from "express";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WASA M-05 / L-01 / L-09 — THE THREE HTTP SETTINGS EVERY API PROCESS TAKES FROM `configureApp`
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * ═══ M-05 — WHO MAY TELL THE APP WHERE A REQUEST CAME FROM ═══
 *
 * Without `trust proxy` every request's `req.ip` is the Caddy container, so no login could be tied
 * to a source. `trust proxy: true` would be worse than nothing: it believes the LEFTMOST
 * `X-Forwarded-For` entry, which is whatever the client typed.
 *
 * So exactly ONE hop is trusted, and only when that hop — the socket peer — sits inside these
 * ranges. `req.ip` then becomes the rightmost `X-Forwarded-For` entry, which is the one the edge
 * wrote; anything a client forged sits to its left and is never read. (Caddy's `reverse_proxy`
 * also REPLACES an incoming `X-Forwarded-For` from an untrusted client, so in production there is
 * only ever one entry; the hop limit is what keeps that true if the edge is ever configured
 * otherwise.)
 *
 * WHY THESE RANGES AND NOT ONE /16. The api container publishes nothing (`expose: 3000` only), so
 * the only peers that can reach it are containers on the compose network and the host. That
 * network is `hmis-prod_default`, and compose does not pin its subnet: Docker allocates it from its
 * default pools (172.17–31.0.0/16, then 192.168.0.0/20s) — `172.20.0.0/16` on the live box today,
 * and something else the day the network is recreated. Pinning today's value would silently turn
 * every IP into Caddy's own after such a recreate. The pools are the "Caddy network" as precisely
 * as the compose file lets us say it; `TRUSTED_PROXY_CIDRS` narrows it to the exact subnet if the
 * operator wants that. Loopback is in the default because the api's own healthcheck and every e2e
 * suite reach it that way.
 */
export const DEFAULT_TRUSTED_PROXY_CIDRS: readonly string[] = [
  "127.0.0.0/8",
  "::1/128",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

/** `::ffff:10.1.2.3` → `10.1.2.3`: Node reports IPv4 peers of a dual-stack socket in mapped form. */
export function unmappedIp(address: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m ? m[1]! : address;
}

/** Parses `a.b.c.d/n` / `x::/n` into a BlockList. THROWS on anything else — a typo here is a boot failure. */
export function compileCidrs(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [net, bits, extra] = cidr.trim().split("/");
    const family = net === undefined ? 0 : isIP(net);
    const prefix = Number(bits);
    const max = family === 6 ? 128 : 32;
    if (family === 0 || extra !== undefined || bits === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new Error(`TRUSTED_PROXY_CIDRS: "${cidr}" is not an address/prefix CIDR`);
    }
    list.addSubnet(net!, prefix, family === 6 ? "ipv6" : "ipv4");
  }
  return list;
}

/** The `trust proxy` function: hop 0 (the socket peer) only, and only from inside `cidrs`. */
export function trustOneProxyHop(cidrs: readonly string[]): (address: string, hop: number) => boolean {
  const list = compileCidrs(cidrs);
  return (address, hop) => {
    if (hop !== 0) return false;
    const ip = unmappedIp(address);
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 6 ? "ipv6" : "ipv4");
  };
}

/**
 * ═══ L-01 — NO API RESPONSE IS KEPT BY THE BROWSER ═══
 *
 * Hospital terminals are shared, and every JSON body here is PHI or near it. `no-store` forbids the
 * browser (and any intermediary) from writing the response down at all; `Pragma: no-cache` is the
 * HTTP/1.0 spelling the finding asks for.
 *
 * HERE, NOT AT CADDY, for two reasons: it then holds wherever the API runs — production's edge,
 * UAT's, the preview's own Caddyfile outside this repo, the dev proxy and every e2e app — and a
 * route that ever needs a caching rule of its own states it with `res.setHeader`, which runs later
 * and wins. Checked before choosing: no route sets `Cache-Control` today, and the downloads there
 * are (the CSV reports, the rendered print HTML, stored documents as base64 JSON) are all fetched
 * with a bearer token by the SPA, so none of them relies on an HTTP cache.
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

/**
 * ═══ L-09 — A FRAMEWORK ERROR SAYS ITS STATUS AND NOTHING ELSE ═══
 *
 * Nest answers an unrouted path with `{"message":"Cannot GET /metrics","error":"Not Found"}` —
 * which fingerprints the framework and echoes the probe — and turns a body-parser failure into a
 * 400 carrying the JSON parser's own sentence ("Expected property name or '}' in JSON at
 * position 1").
 *
 * THE LINE BETWEEN "FRAMEWORK" AND "APP" IS `req.route`, not a message pattern. Express sets it
 * only once a route has MATCHED, and every guard, pipe and handler in this app runs inside a
 * matched route. So an error raised before any route matched — the not-found handler, the body
 * parsers, a malformed `%`-escape in the path — is the framework's, and its body becomes
 * `{ statusCode, message: <the standard reason phrase> }`. An error raised inside a route is the
 * app's own and goes to Nest's default handling UNCHANGED: every coded refusal, every zod issue
 * list, every 401/403, and the generic 500 (which Nest already words without detail, and logs).
 */
@Catch()
export class FrameworkErrorFilter extends BaseExceptionFilter {
  private static readonly log = new Logger("HttpError");

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http") {
      super.catch(exception, host);
      return;
    }
    const req = host.switchToHttp().getRequest<Request>();
    if (req.route !== undefined) {
      super.catch(exception, host);
      return;
    }
    const status = statusOf(exception);
    if (status >= 500) {
      FrameworkErrorFilter.log.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    }
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    res.status(status).json({ statusCode: status, message: STATUS_CODES[status] ?? "Error" });
  }
}

function statusOf(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  if (typeof exception === "object" && exception !== null) {
    const e = exception as { status?: unknown; statusCode?: unknown };
    const s = typeof e.statusCode === "number" ? e.statusCode : e.status;
    if (typeof s === "number" && Number.isInteger(s) && s >= 400 && s <= 599) return s;
  }
  return 500;
}
