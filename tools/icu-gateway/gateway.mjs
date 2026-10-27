// @ts-check
/**
 * ICU IC-1 (#984, decision 0090, option A) — THE ICU GATEWAY, one per hall. It listens for the central station's HL7
 * over MLLP, ACKs each message, keeps every parsed message in an on-disk SPOOL (a power cut loses nothing), and every
 * 30 s posts what is spooled to `POST /api/icu/feed/<gateway>/batches` with its agent key. A batch is also its heartbeat
 * (the server's grey-out is 5 minutes of silence), so an empty batch is sent when nothing arrived. A replayed
 * `batchRef` is a duplicate on the server, so a crash between the post and the delete posts nothing twice.
 *
 *   HMIS_URL=https://<hmis host>  ICU_GATEWAY_ID=<id>  ICU_AGENT_KEY=<key>  MLLP_PORT=2575  SPOOL_DIR=/var/lib/icu-gateway
 *   node gateway.mjs
 *
 * The station's sampling is set to 5 s (decision 0090: waves and per-second detail stay on the maker's station).
 */
import { createServer } from "node:net";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ackFor, batchesOf, parseMessage, unframe } from "./hl7.mjs";

const BATCH_EVERY_MS = 30_000;

/** Write one parsed message to the spool atomically (write, then rename). */
export async function spool(dir, parsed) {
  await mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${randomUUID()}.json`;
  await writeFile(join(dir, `${name}.tmp`), JSON.stringify(parsed));
  await rename(join(dir, `${name}.tmp`), join(dir, name));
}

/** Everything spooled, oldest first; a torn file is skipped (and left for a person), never a wedge. */
export async function readSpool(dir) {
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  const out = [];
  for (const name of names) {
    try { out.push({ name, msg: JSON.parse(await readFile(join(dir, name), "utf8")) }); } catch { /* torn: skip */ }
  }
  return out;
}

/** One flush: post the spool in batches (at most 120 samples each), delete what the server accepted. */
export async function flush(cfg, post = fetch) {
  const items = await readSpool(cfg.spoolDir);
  const samples = items.flatMap((i) => i.msg.samples ?? []);
  const alarms = items.flatMap((i) => i.msg.alarms ?? []);
  const groups = samples.length === 0 ? [[]] : batchesOf(samples);
  for (const [n, group] of groups.entries()) {
    const body = { batchRef: `${items[0]?.name ?? `hb-${Date.now()}`}#${String(n)}`, sentAt: new Date().toISOString(), samples: group, alarms: n === 0 ? alarms : [] };
    const r = await post(`${cfg.hmisUrl}/api/icu/feed/${encodeURIComponent(cfg.gatewayId)}/batches`, {
      method: "POST", headers: { "content-type": "application/json", "x-agent-key": cfg.agentKey }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`feed refused: ${String(r.status)}`);
  }
  for (const i of items) await unlink(join(cfg.spoolDir, i.name)).catch(() => undefined);
  return { posted: samples.length, alarms: alarms.length };
}

export function startMllp(cfg) {
  return createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const { frames, rest } = unframe(buf + chunk);
      buf = rest;
      for (const f of frames) {
        void (async () => {
          try { await spool(cfg.spoolDir, parseMessage(f)); socket.write(ackFor(f, "AA")); } catch { socket.write(ackFor(f, "AE")); }
        })();
      }
    });
  }).listen(cfg.port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = {
    hmisUrl: process.env.HMIS_URL ?? "", gatewayId: process.env.ICU_GATEWAY_ID ?? "", agentKey: process.env.ICU_AGENT_KEY ?? "",
    port: Number(process.env.MLLP_PORT ?? "2575"), spoolDir: process.env.SPOOL_DIR ?? "./spool",
  };
  if (cfg.hmisUrl === "" || cfg.gatewayId === "" || cfg.agentKey === "") { console.error("set HMIS_URL, ICU_GATEWAY_ID and ICU_AGENT_KEY"); process.exit(2); }
  startMllp(cfg);
  setInterval(() => { flush(cfg).catch((e) => console.error(`flush failed (kept in the spool): ${e instanceof Error ? e.message : String(e)}`)); }, BATCH_EVERY_MS);
  console.log(`icu-gateway: MLLP on ${String(cfg.port)}, posting every 30 s`);
}
