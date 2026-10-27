// @ts-check
/**
 * ICU IC-1 (#984) — the gateway against a RECORDED ORU^R01 (synthetic, IntelliVue-style MDC codes) and an ORU^R40 alarm.
 * Run it:  node --test tools/icu-gateway/gateway.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MLLP_END, MLLP_START, ackFor, batchesOf, hl7Time, parseMessage, unframe } from "./hl7.mjs";
import { flush, readSpool, spool } from "./gateway.mjs";

const ORU = [
  "MSH|^~\\&|CENTRAL|MICU-H1|HMIS|CRK|20261027103005||ORU^R01^ORU_R01|MSG00042|P|2.6",
  "PID|||CRK-26-00103||Test^Anil",
  "PV1||I|MICU^HALL1^BED03",
  "OBR|1|||182777000^monitoring of patient^SCT|||20261027103000",
  "OBX|1|NM|147842^MDC_ECG_HEART_RATE^MDC|1.2.1.1|112|264864^MDC_DIM_BEAT_PER_MIN^MDC|||||F|||20261027103000",
  "OBX|2|NM|150456^MDC_PULS_OXIM_SAT_O2^MDC|1.3.1.1||262688^MDC_DIM_PERCENT^MDC|||||X|||20261027103000",
  "OBX|3|NM|150301^MDC_PRESS_CUFF_SYS^MDC|1.4.1.1|104|266016^MDC_DIM_MMHG^MDC|||||F|||20261027103000",
  "OBX|4|ST|0^NOTE|1|free text|||||F",
].join("\r");
const R40 = [
  "MSH|^~\\&|CENTRAL|MICU-H1|HMIS|CRK|20261027103010||ORU^R40^ORU_R40|ALM0007|P|2.6",
  "PV1||I|MICU^HALL1^BED03",
  "OBX|1|ST|196670^MDC_EVT_ECG_V_TACHY^MDC|1.2.1.1|^VTach|||PH|||F|||20261027103008",
].join("\r");

test("an ORU^R01 becomes samples with the raw code, the bed slot and the device clock; a probe-off is technical", () => {
  const p = parseMessage(ORU);
  assert.equal(p.type, "ORU^R01");
  assert.equal(p.controlId, "MSG00042");
  assert.equal(p.samples.length, 3);
  assert.deepEqual(p.samples[0], { slot: "BED03", code: "147842^MDC_ECG_HEART_RATE^MDC", value: 112, unit: "MDC_DIM_BEAT_PER_MIN", at: "2026-10-27T05:00:00.000Z" });
  assert.deepEqual(p.samples[1], { slot: "BED03", code: "150456^MDC_PULS_OXIM_SAT_O2^MDC", value: null, unit: "MDC_DIM_PERCENT", at: "2026-10-27T05:00:00.000Z", technical: "probe_off" });
  assert.equal(p.alarms.length, 0);
});

test("an ORU^R40 is an alarm with the device's priority (PH = life-threatening)", () => {
  const p = parseMessage(R40);
  assert.deepEqual(p.alarms, [{ slot: "BED03", code: "196670^MDC_EVT_ECG_V_TACHY^MDC", severity: "life_threatening", message: "VTach", at: "2026-10-27T05:00:08.000Z" }]);
});

test("MLLP framing, the ACK, the HL7 clock and the 120-sample cut", () => {
  const { frames, rest } = unframe(`${MLLP_START}${ORU}${MLLP_END}${MLLP_START}partial`);
  assert.equal(frames.length, 1);
  assert.equal(rest, `${MLLP_START}partial`);
  const ack = ackFor(ORU, "AA", new Date("2026-10-27T05:00:05Z"));
  assert.match(ack, /\rMSA\|AA\|MSG00042\r/);
  assert.equal(hl7Time("20261027103000+0000"), "2026-10-27T10:30:00.000Z");
  assert.equal(hl7Time("garbage"), null);
  assert.deepEqual(batchesOf(Array.from({ length: 250 }, (_, i) => i)).map((b) => b.length), [120, 120, 10]);
});

test("the spool survives a torn file, posts in batches with the agent key, and empties only after the post", async () => {
  const dir = await mkdtemp(join(tmpdir(), "icu-gw-"));
  await spool(dir, parseMessage(ORU));
  await spool(dir, parseMessage(R40));
  await writeFile(join(dir, "0000-torn.json"), "{\"samples\": [");
  assert.equal((await readSpool(dir)).length, 2);
  const calls = [];
  const post = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
  const r = await flush({ hmisUrl: "https://hmis.test", gatewayId: "GW1", agentKey: "k-1", spoolDir: dir }, /** @type {any} */ (post));
  assert.deepEqual(r, { posted: 3, alarms: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hmis.test/api/icu/feed/GW1/batches");
  assert.equal(calls[0].init.headers["x-agent-key"], "k-1");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.samples.length, 3);
  assert.equal(body.alarms.length, 1);
  assert.deepEqual((await readdir(dir)).sort(), ["0000-torn.json"]);
  // A refused post keeps the spool.
  await spool(dir, parseMessage(ORU));
  await assert.rejects(flush({ hmisUrl: "https://hmis.test", gatewayId: "GW1", agentKey: "k-1", spoolDir: dir }, /** @type {any} */ (async () => ({ ok: false, status: 503 }))));
  assert.equal((await readSpool(dir)).length, 1);
});
