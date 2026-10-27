/**
 * Capture mode (#1017 step 1): a stand-in analyser connects over real TCP on 127.0.0.1 and sends
 * what a Z3 would — HL7 over MLLP, or ASTM — split and joined across reads the way a LAN delivers it.
 * The messages are synthetic; no patient data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { astmAcks, hl7Ack, hl7Type, lanAddresses, sniff, startCapture, takeMllpFrames } from "./capture.mjs";

const VT = "\x0b", FS = "\x1c", CR = "\r";
const ORU = [
  "MSH|^~\\&|Analyzer|Z3|||20261027101500||ORU^R01|42|P|2.3.1||||||UNICODE",
  "PID|1||||TEST^SAMPLE||19900101|M",
  "OBR|1||S261027001|Analyzer^Z3",
  "OBX|1|NM|WBC||6.8|10^9/L|4.0-10.0|N|||F",
].join(CR) + CR;
const frame = (m) => Buffer.from(VT + m + FS + CR, "latin1");

const tmp = () => mkdtemp(join(tmpdir(), "hmis-lab-capture-"));

/** Connects, sends each chunk with a pause between, collects everything the bridge answers. */
async function talk(port, chunks, { waitMs = 150 } = {}) {
  const socket = connect(port, "127.0.0.1");
  const got = [];
  socket.on("data", (d) => got.push(d));
  await new Promise((r) => socket.once("connect", r));
  for (const c of chunks) {
    socket.write(c);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, waitMs));
  socket.end();
  await new Promise((r) => socket.once("close", r));
  return Buffer.concat(got);
}

test("MLLP frames: two in one read, one split across reads, leading noise ignored", () => {
  const a = frame("MSH|^~\\&|a"), b = frame("MSH|^~\\&|b");
  const one = takeMllpFrames(Buffer.concat([Buffer.from("\r\n"), a, b.subarray(0, 5)]));
  assert.deepEqual(one.messages.map(String), ["MSH|^~\\&|a"]);
  const two = takeMllpFrames(Buffer.concat([one.rest, b.subarray(5)]));
  assert.deepEqual(two.messages.map(String), ["MSH|^~\\&|b"]);
  assert.equal(two.rest.length, 0);
});

test("the ACK swaps sender and receiver and quotes the control id back", () => {
  const ack = hl7Ack(Buffer.from(ORU, "latin1"), new Date(2026, 9, 27, 10, 15, 1)).toString("latin1");
  assert.ok(ack.startsWith(VT) && ack.endsWith(FS + CR));
  const [msh, msa] = ack.slice(1, -2).split(CR);
  assert.equal(msh, "MSH|^~\\&|||Analyzer|Z3|20261027101501||ACK^R01|42|P|2.3.1");
  assert.equal(msa, "MSA|AA|42|Message accepted");
  assert.equal(hl7Type(Buffer.from(ORU)), "ORU^R01");
});

test("ASTM: ENQ and each complete frame are acknowledged; a frame without its trailer waits", () => {
  const head = Buffer.from("\x05\x021H|\\^&|||Z3\r\x0312\r\n\x022P|1", "latin1");
  const first = astmAcks(head);
  assert.equal(first.acks, 2);
  const second = astmAcks(Buffer.concat([first.rest, Buffer.from("\r\x03AB\r\n\x04", "latin1")]));
  assert.equal(second.acks, 1);
  assert.equal(second.rest.length, 0);
  assert.equal(sniff(Buffer.from("\x05")), "astm");
  assert.equal(sniff(Buffer.from("\r\n\x0bMSH")), "hl7");
  assert.equal(sniff(Buffer.from("hello")), "unknown");
  assert.equal(sniff(Buffer.from("\r\n")), null);
});

test("an HL7 result split across TCP reads is saved byte-exact, then ACKed once", async () => {
  const dir = await tmp();
  const lines = [];
  const cap = await startCapture({ port: 0, host: "127.0.0.1", dir, log: (m) => lines.push(m) });
  try {
    const bytes = frame(ORU);
    const answer = await talk(cap.port, [bytes.subarray(0, 40), bytes.subarray(40)]);
    assert.match(answer.toString("latin1"), /MSA\|AA\|42\|/);
    assert.equal(answer.toString("latin1").split("MSA|").length - 1, 1);
    const files = await readdir(dir);
    const hl7 = files.filter((f) => f.endsWith(".hl7"));
    assert.equal(hl7.length, 1);
    assert.equal(await readFile(join(dir, hl7[0]), "latin1"), ORU);
    const raw = files.find((f) => f.endsWith(".raw"));
    assert.ok(raw !== undefined);
    assert.deepEqual(await readFile(join(dir, raw)), bytes);
    assert.match(await readFile(join(dir, "capture.log"), "utf8"), /HL7 ORU\^R01 .* \(ACK sent\)/);
  } finally {
    await cap.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two results in one read become two files and two ACKs", async () => {
  const dir = await tmp();
  const cap = await startCapture({ port: 0, host: "127.0.0.1", dir, log: () => undefined });
  try {
    const second = ORU.replace("|42|", "|43|");
    const answer = await talk(cap.port, [Buffer.concat([frame(ORU), frame(second)])]);
    assert.match(answer.toString("latin1"), /MSA\|AA\|42\|[\s\S]*MSA\|AA\|43\|/);
    assert.equal((await readdir(dir)).filter((f) => f.endsWith(".hl7")).length, 2);
  } finally {
    await cap.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an ASTM sender gets its ACKs and every byte is kept in .raw", async () => {
  const dir = await tmp();
  const cap = await startCapture({ port: 0, host: "127.0.0.1", dir, log: () => undefined });
  try {
    const parts = ["\x05", "\x021H|\\^&|||Z3\r\x0312\r\n", "\x022R|1|^^^WBC|6.8\r\x03AB\r\n", "\x04"];
    const answer = await talk(cap.port, parts.map((p) => Buffer.from(p, "latin1")));
    assert.deepEqual([...answer], [0x06, 0x06, 0x06]);
    const raw = (await readdir(dir)).find((f) => f.endsWith(".raw"));
    assert.equal(await readFile(join(dir, raw), "latin1"), parts.join(""));
  } finally {
    await cap.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bytes in no known protocol are still kept, and nothing is answered", async () => {
  const dir = await tmp();
  const cap = await startCapture({ port: 0, host: "127.0.0.1", dir, log: () => undefined });
  try {
    const answer = await talk(cap.port, [Buffer.from("WBC=6.8;HGB=13.1\r\n")]);
    assert.equal(answer.length, 0);
    const raw = (await readdir(dir)).find((f) => f.endsWith(".raw"));
    assert.equal(await readFile(join(dir, raw), "utf8"), "WBC=6.8;HGB=13.1\r\n");
  } finally {
    await cap.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("only external IPv4 addresses are offered for the analyser's settings", () => {
  const got = lanAddresses({
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    Ethernet: [{ family: "IPv4", address: "10.0.0.5", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
  });
  assert.deepEqual(got, ["10.0.0.5  (Ethernet)"]);
});
