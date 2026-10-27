/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * HMIS Lab Bridge — capture mode (#1017, step 1)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The Zybio Z3's operation manual has no LIS chapter, and the protocol document we were offered
 * belongs to a different analyser. So before a parser is written, the analyser itself is asked:
 * this program listens on the lab LAN, lets the Z3 connect and send one result, and keeps the
 * bytes exactly as they arrived. The parser is then written from a real message, not a guess.
 *
 * It speaks just enough of both common analyser dialects that the machine finishes its send
 * instead of retrying or raising "Communication Abn":
 *
 *   HL7 over MLLP   <VT> message <FS><CR>   -> saved, then answered with ACK (MSA|AA|<control id>)
 *   ASTM E1381      <ENQ> <STX>frame<ETX|ETB>… <EOT>   -> each byte group answered with <ACK>
 *
 * Anything else is still kept: every connection's whole byte stream is written to `.raw` as it
 * arrives, so an unknown protocol costs a reading, never the data.
 *
 * It posts NOTHING to HMIS and needs no account. A message is written to disk BEFORE it is
 * acknowledged — an analyser that has been told "received" does not send again.
 *
 * Dependency-free: Node 22 alone (`node capture.mjs [--port 10001] [--dir captures]`).
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The port already set on the hospital's Z3 (LIS settings photographed 2026-10-24), so it needs no change.
export const DEFAULT_PORT = 10001;

const VT = 0x0b, FS = 0x1c, CR = 0x0d;
const ENQ = 0x05, ACK = 0x06, STX = 0x02, ETX = 0x03, ETB = 0x17, EOT = 0x04, LF = 0x0a;

/* ── HL7 ─────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Splits complete MLLP frames off the front of `buf`. Returns the messages (without <VT>/<FS><CR>)
 * and what is left over — a frame split across two TCP reads waits for its second half.
 */
export function takeMllpFrames(buf) {
  const messages = [];
  let rest = buf;
  for (;;) {
    const start = rest.indexOf(VT);
    if (start < 0) return { messages, rest: Buffer.alloc(0) };
    const end = rest.indexOf(FS, start + 1);
    if (end < 0) return { messages, rest: rest.subarray(start) };
    messages.push(rest.subarray(start + 1, end));
    rest = rest.subarray(rest[end + 1] === CR ? end + 2 : end + 1);
  }
}

/** HL7 timestamp in the PC's local time, `YYYYMMDDHHMMSS`. */
export function hl7Time(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * The acknowledgement for one HL7 message: sender and receiver swapped, the trigger echoed, and the
 * message control id (MSH-10) quoted back in MSA-2 — which is how the analyser knows WHICH send
 * was accepted. Uses the message's own field separator and encoding characters.
 */
export function hl7Ack(message, now = new Date()) {
  const text = message.toString("latin1");
  const msh = text.split(/\r\n|\r|\n/).find((s) => s.startsWith("MSH")) ?? "";
  const sep = msh.length > 3 ? msh[3] : "|";
  const f = msh.split(sep);
  // f[1] = encoding characters, f[2] app, f[3] facility, f[8] type^trigger, f[9] control id, f[11] version
  const trigger = (f[8] ?? "").split(f[1]?.[0] ?? "^")[1] ?? "R01";
  const seg = [
    ["MSH", f[1] ?? "^~\\&", f[4] ?? "", f[5] ?? "", f[2] ?? "", f[3] ?? "", hl7Time(now), "", `ACK${f[1]?.[0] ?? "^"}${trigger}`,
      f[9] ?? "", f[10] ?? "P", f[11] ?? "2.3.1"].join(sep),
    ["MSA", "AA", f[9] ?? "", "Message accepted"].join(sep),
  ];
  return Buffer.concat([Buffer.from([VT]), Buffer.from(seg.join("\r") + "\r", "latin1"), Buffer.from([FS, CR])]);
}

/** `ORU^R01`, `QRY^Q02` … from MSH-9, for the log line. */
export function hl7Type(message) {
  const msh = message.toString("latin1").split(/\r\n|\r|\n/).find((s) => s.startsWith("MSH")) ?? "";
  return msh.length > 3 ? (msh.split(msh[3])[8] ?? "?") : "?";
}

/* ── ASTM ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The ASTM low-level handshake, answered from the receiver's side. ENQ asks "may I send?", each
 * frame ends <ETX|ETB> checksum <CR><LF>, and EOT ends the session. The receiver says <ACK> to the
 * ENQ and to every complete frame. Returns how many ACKs to send and the bytes still waiting.
 */
export function astmAcks(buf) {
  let acks = 0;
  let i = 0;
  let frameStart = -1;
  for (; i < buf.length; i++) {
    const b = buf[i];
    if (frameStart < 0) {
      if (b === ENQ) acks++;
      else if (b === STX) frameStart = i;
    } else if (b === ETX || b === ETB) {
      // <ETX> c1 c2 <CR> <LF> — wait for the whole trailer before acknowledging
      const lf = buf.indexOf(LF, i);
      if (lf < 0) return { acks, rest: buf.subarray(frameStart) };
      acks++;
      frameStart = -1;
      i = lf;
    }
  }
  return { acks, rest: frameStart < 0 ? Buffer.alloc(0) : buf.subarray(frameStart) };
}

/** A connection is ASTM when its first meaningful byte is ENQ; HL7 when it is VT. */
export function sniff(buf) {
  for (const b of buf) {
    if (b === ENQ) return "astm";
    if (b === VT) return "hl7";
    if (b !== CR && b !== LF && b !== 0x20) return "unknown";
  }
  return null;
}

/* ── the listener ────────────────────────────────────────────────────────────────────────────── */

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");

/**
 * Starts the capture server. Resolves once listening, with `{ server, port, close }`.
 * Every file goes under `dir`: `<stamp>-<conn>.raw` (all bytes of a connection, appended as they
 * arrive), `<stamp>-<conn>-<n>.hl7` (one per HL7 message) and `capture.log`.
 */
export async function startCapture({ port = DEFAULT_PORT, host = "0.0.0.0", dir, log = (m) => { console.log(m); }, now = () => new Date() }) {
  await mkdir(dir, { recursive: true });
  const say = async (m) => {
    const line = `${now().toISOString()} ${m}`;
    log(line);
    await appendFile(join(dir, "capture.log"), line + "\n");
  };
  let conns = 0;
  const server = createServer((socket) => {
    const id = `${stamp(now())}-c${String(++conns)}`;
    const raw = join(dir, `${id}.raw`);
    const who = `${socket.remoteAddress ?? "?"}:${String(socket.remotePort ?? "?")}`;
    let kind = null;
    let pending = Buffer.alloc(0);
    let n = 0;
    // One chain per connection: bytes are written in the order they arrived, and each message is
    // on disk before its ACK leaves.
    let chain = say(`connected ${who} -> ${id}.raw`);
    socket.on("data", (chunk) => {
      chain = chain.then(async () => {
        await appendFile(raw, chunk);
        pending = Buffer.concat([pending, chunk]);
        kind ??= sniff(pending);
        if (kind === "hl7") {
          const { messages, rest } = takeMllpFrames(pending);
          pending = rest;
          for (const m of messages) {
            const file = `${id}-${String(++n)}.hl7`;
            await writeFile(join(dir, file), m);
            socket.write(hl7Ack(m, now()));
            await say(`HL7 ${hl7Type(m)} ${String(m.length)} bytes -> ${file} (ACK sent)`);
          }
        } else if (kind === "astm") {
          const { acks, rest } = astmAcks(pending);
          pending = rest;
          if (acks > 0) socket.write(Buffer.alloc(acks, ACK));
          if (chunk.includes(EOT)) await say(`ASTM session ended (EOT); bytes in ${id}.raw`);
        } else if (kind === "unknown") {
          pending = Buffer.alloc(0);
          await say(`${String(chunk.length)} bytes in no protocol this program knows -> kept in ${id}.raw`);
        }
      }).catch((e) => say(`error on ${id}: ${String(e)}`));
    });
    socket.on("error", (e) => { chain = chain.then(() => say(`socket error ${who}: ${e.message}`)); });
    socket.on("close", () => { chain = chain.then(() => say(`disconnected ${who}`)); });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  return { server, port: bound, close: () => new Promise((r) => { server.close(() => { r(); }); }) };
}

/** This PC's LAN addresses — the one to type into the analyser's LIS settings is among them. */
export function lanAddresses(ifaces = networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(`${a.address}  (${name})`);
  }
  return out;
}

export async function main(argv) {
  const arg = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
  const port = Number(arg("--port", String(DEFAULT_PORT)));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a number from 1 to 65535`);
  const dir = arg("--dir", join(dirname(fileURLToPath(import.meta.url)), "captures"));
  const { port: bound } = await startCapture({ port, dir });
  const ips = lanAddresses();
  console.log("");
  console.log("HMIS Lab Bridge - CAPTURE MODE. Nothing is sent to HMIS.");
  console.log("");
  console.log("On the analyser's LIS / communication settings, enter:");
  for (const ip of ips.length > 0 ? ips : ["(no network address found - is the network cable in?)"]) console.log(`  Server IP : ${ip}`);
  console.log(`  Port      : ${String(bound)}`);
  console.log("");
  console.log(`Captured messages are saved in: ${dir}`);
  console.log("Leave this window open. Close it to stop.");
  console.log("");
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  main(process.argv.slice(2)).catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; });
}
