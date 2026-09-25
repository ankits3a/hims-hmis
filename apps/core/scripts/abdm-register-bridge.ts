/**
 * ABDM S0 — TELL ABDM WHERE TO SEND CALLBACKS. An operator runs this ONCE, after the sandbox (or
 * production) credentials exist and `ABDM_*` is set in the environment file:
 *
 *     pnpm --filter @hmis/core exec tsx scripts/abdm-register-bridge.ts
 *
 * It opens a gateway session and sends `PATCH {gateway}/gateway/v3/bridge/url` with
 * `{"url": ABDM_CALLBACK_BASE_URL}` — the body and path are the NHA wrapper README's §5 — then
 * prints ABDM's answer verbatim. Both requests are written to `abdm_messages`, secret-free.
 *
 * WHAT TO KNOW BEFORE RUNNING IT (spec summary §2):
 *   · The bridge URL is LAST-WRITER-WINS PER CLIENT ID — whoever patched it last receives every
 *     callback. Run it from the deployment that should receive them, never from a laptop.
 *   · No API reads the URL back; `GET /gateway/v3/bridge-services` lists the bridge but its
 *     `endpoints` come back empty. The sandbox portal UI shows it.
 *   · One vendor saw this PATCH blocked by ABDM's CloudFront WAF and set the URL in the portal UI.
 *   · ABDM-1150 "Bridge API version cannot be null" suggests a V1/V3 setting on the bridge, set in
 *     the portal — UNVERIFIED (nha-in only).
 *
 * It REFUSES when ABDM is not configured and sends nothing. Exit 0 on a 2xx, 1 otherwise.
 */
import { createDb } from "../src/kernel/db/client";
import { loadConfig } from "../src/kernel/config";
import { AbdmGatewayClient, abdmSettingsFrom } from "../src/modules/abdm";
import type { AbdmFetch } from "../src/modules/abdm";
import type { AppConfig } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

export type BridgeResult = { status: number; url: string; requestId: string; body: unknown };

export async function registerBridge(deps: {
  abdm: AppConfig["abdm"];
  db: Db;
  fetch?: AbdmFetch;
  now?: () => Date;
}): Promise<BridgeResult> {
  const settings = abdmSettingsFrom(deps.abdm);
  if (settings === null) {
    throw new Error(
      "ABDM not configured — set ABDM_BASE_URL, ABDM_CLIENT_ID, ABDM_CLIENT_SECRET, ABDM_HIP_ID and ABDM_CALLBACK_BASE_URL",
    );
  }
  const client = new AbdmGatewayClient(settings, {
    db: deps.db,
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    now: deps.now,
  });
  const res = await client.call("PATCH", "/gateway/v3/bridge/url", { url: settings.callbackBaseUrl }, { kind: "gateway.bridge_url" });
  return { status: res.status, url: settings.callbackBaseUrl, requestId: res.requestId, body: res.body };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { db, pool } = createDb(cfg.databaseUrl);
  try {
    const result = await registerBridge({ abdm: cfg.abdm, db });
    process.stdout.write(`ABDM answered HTTP ${result.status} to PATCH /gateway/v3/bridge/url (REQUEST-ID ${result.requestId})\n`);
    process.stdout.write(`  url:  ${result.url}\n`);
    process.stdout.write(`  body: ${result.body === null ? "(empty)" : JSON.stringify(result.body)}\n`);
    process.exitCode = result.status >= 200 && result.status < 300 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
