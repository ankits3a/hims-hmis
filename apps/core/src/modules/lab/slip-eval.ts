import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { mapSlipRows } from "./slip-map";
import { parseSlipReply, slipReplySchema } from "./slip-reader";
import type { SlipAnalyte, SlipCodeMapping } from "./slip-map";
import type { SlipReader, SlipReply } from "./slip-reader";

/**
 * ═══ SPEC #934 D13 — IS THE CONFIGURED MODEL GOOD ENOUGH TO SWITCH READING ON? ═══
 *
 * The repo is public, so the eval set is SYNTHETIC: slips written here with made-up names and
 * internally consistent values, never a patient's slip. Each is a truth file (`slip-eval-set/*.json`,
 * the reply a perfect reader would give). The eval shows the configured model each slip — a photograph
 * of the printed slip when one sits beside it (`<id>.jpg`), else the slip rendered here as a PNG —
 * and scores what comes back:
 *
 *   value accuracy   printed values copied character for character, by row
 *   code accuracy    printed codes copied exactly, by row
 *   check coverage   of the values it got WRONG, the share the bench would have flagged — through the
 *                    bench's own `mapSlipRows`, so "carried a check" means exactly what it means there
 *
 * Production reading is switched on only when values are ≥ 98 % on clear photos, every wrong value
 * carried a check, and #934 records that the key is on a paid-tier, no-training account (the last
 * is a person's fact; `productionGate` says so rather than pretending to know it).
 */
export type SlipEvalItem = {
  id: string;
  /** Always true: the guard that keeps a real slip out of a public repo is a person, and this flag is their promise. */
  synthetic: true;
  analyser: "3part" | "5part";
  /** "clear" photos are the ones the 98 % gate is measured on. */
  photo: "clear" | "poor";
  reply: SlipReply;
  /** A photograph of the printed slip, when one has been taken. */
  jpeg: Buffer | null;
};

/** Where the set lives: beside this file in the source tree; from `dist/`, the source tree under the working directory. */
export const SLIP_EVAL_DIR = [join(__dirname, "slip-eval-set"), join(process.cwd(), "src", "modules", "lab", "slip-eval-set")]
  .find((d) => existsSync(d)) ?? join(__dirname, "slip-eval-set");

export function loadSlipEvalSet(dir: string = SLIP_EVAL_DIR): SlipEvalItem[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    if (raw.synthetic !== true) throw new Error(`${f}: not marked synthetic — a real patient's slip never enters this repo`);
    const reply = slipReplySchema.parse(raw.reply);
    const id = String(raw.id);
    const photo = join(dir, `${id}.jpg`);
    return {
      id, synthetic: true, analyser: raw.analyser === "5part" ? "5part" : "3part", photo: raw.photo === "poor" ? "poor" : "clear",
      reply, jpeg: existsSync(photo) ? readFileSync(photo) : null,
    };
  });
}

/* ═══════════════════════════════ the analysers the set is printed by ═══════════════════════════════ */

const A = (code: string, unit: string | null, o: Partial<SlipAnalyte> = {}): SlipAnalyte =>
  ({ id: code, code, nameEn: code, unit, resultType: "numeric", absurdLow: null, absurdHigh: null, formula: null, ...o });
const F = (code: string, of: string): SlipAnalyte => A(code, "10^3/uL", { resultType: "formula", formula: `WBC * ${of} / 100` });
/** The standard catalogue's haematology analytes (`scripts/data/lab-catalogue-standard.ts`), as the eval needs them. */
const EVAL_ANALYTES: SlipAnalyte[] = [
  A("HB", "g/dL", { absurdLow: "1", absurdHigh: "25" }), A("RBC", "10^6/uL"), A("HCT", "%"), A("MCV", "fL"), A("MCH", "pg"), A("MCHC", "g/dL"),
  A("RDW", "%"), A("RDW_SD", "fL"), A("WBC", "10^3/uL", { absurdLow: "0.1", absurdHigh: "200" }),
  A("NEUT", "%"), A("LYMPH", "%"), A("MONO", "%"), A("EOS", "%"), A("BASO", "%"), A("GRAN", "%"), A("MID", "%"),
  F("ANC", "NEUT"), F("LYMPH_ABS", "LYMPH"), F("MONO_ABS", "MONO"), F("EOS_ABS", "EOS"), F("BASO_ABS", "BASO"), F("GRAN_ABS", "GRAN"), F("MID_ABS", "MID"),
  A("PLT", "10^3/uL", { absurdLow: "1", absurdHigh: "3000" }), A("MPV", "fL"),
];

const COMMON: [string, string, string][] = [
  ["WBC", "WBC", "10^9/L"], ["RBC", "RBC", "10^12/L"], ["HGB", "HB", "g/dL"], ["HCT", "HCT", "%"], ["MCV", "MCV", "fL"], ["MCH", "MCH", "pg"],
  ["MCHC", "MCHC", "g/dL"], ["RDW-CV", "RDW", "%"], ["RDW-SD", "RDW_SD", "fL"], ["PLT", "PLT", "10^9/L"], ["MPV", "MPV", "fL"],
];
/**
 * The spec's suggested code maps (spec #934, "Map for a 3-part haematology analyser"); the lab head
 * confirms each row on the instruments screen. `GRAN` never fills `NEUT`, and the slip's `PCT` is the
 * plateletcrit — ignored, never our Procalcitonin.
 */
export const SLIP_SUGGESTED_MAPS: Readonly<Record<"3part" | "5part", readonly [string, string, string][]>> = {
  "3part": [...COMMON, ["Lym%", "LYMPH", "%"], ["Lym#", "LYMPH_ABS", "10^9/L"], ["Gran%", "GRAN", "%"], ["Gran#", "GRAN_ABS", "10^9/L"], ["Mid%", "MID", "%"], ["Mid#", "MID_ABS", "10^9/L"]],
  "5part": [...COMMON, ["NEU%", "NEUT", "%"], ["NEU#", "ANC", "10^9/L"], ["LYM%", "LYMPH", "%"], ["LYM#", "LYMPH_ABS", "10^9/L"], ["MON%", "MONO", "%"],
    ["MON#", "MONO_ABS", "10^9/L"], ["EOS%", "EOS", "%"], ["EOS#", "EOS_ABS", "10^9/L"], ["BAS%", "BASO", "%"], ["BAS#", "BASO_ABS", "10^9/L"]],
};
export const SLIP_SUGGESTED_IGNORED: readonly string[] = ["PDW", "PCT", "P-LCR", "P-LCC"];

function evalContext(kind: "3part" | "5part") {
  return {
    codes: new Map<string, SlipCodeMapping>(SLIP_SUGGESTED_MAPS[kind].map(([code, ours, unit]) => [code, { analyteId: ours, unit, factor: "1" }])),
    ignored: new Map(SLIP_SUGGESTED_IGNORED.map((c) => [c, "platelet index the report does not carry"])),
    analytes: new Map(EVAL_ANALYTES.map((a) => [a.id, a])),
    report: null,
    prior: new Map(),
  };
}

/* ═══════════════════════════════ scoring ═══════════════════════════════ */

export type SlipEvalMetrics = {
  slips: number; rows: number;
  valueAccuracy: number; codeAccuracy: number;
  /** Value accuracy over the clear photos only — the number the 98 % gate reads. */
  clearValueAccuracy: number;
  wrongValues: number; wrongWithCheck: number;
  /** Of the wrong values, the share that carried a check; `null` when nothing was wrong. */
  wrongWithCheckShare: number | null;
  /** Replies that were not schema-valid JSON. */
  unreadable: number;
  perSlip: { id: string; values: number; correct: number; wrong: { code: string; truth: string | null; read: string | null; checked: boolean }[] }[];
};

/**
 * The set, read in order, ONE call per slip (a stub reader may answer by call order). Rows are
 * compared by printed position, which is what the prompt asks the model to keep.
 */
export async function scoreSlipEval(set: readonly SlipEvalItem[], reader: SlipReader): Promise<SlipEvalMetrics> {
  let rows = 0, values = 0, codes = 0, clearRows = 0, clearValues = 0, wrongValues = 0, wrongWithCheck = 0, unreadable = 0;
  const perSlip: SlipEvalMetrics["perSlip"] = [];
  for (const item of set) {
    const image = item.jpeg ?? renderSlipPng(item);
    const got = await reader.read({ image, mimeType: item.jpeg !== null ? "image/jpeg" : "image/png", analyserName: `Haematology ${item.analyser}` });
    const reply = parseSlipReply(got.text);
    if (reply === null) unreadable += 1;
    const mapped = reply === null ? [] : mapSlipRows(reply, evalContext(item.analyser)).rows;
    const slip = { id: item.id, values: item.reply.rows.length, correct: 0, wrong: [] as SlipEvalMetrics["perSlip"][number]["wrong"] };
    item.reply.rows.forEach((truth, i) => {
      rows += 1;
      if (item.photo === "clear") clearRows += 1;
      const read = reply?.rows[i];
      if (read !== undefined && read.code === truth.code) codes += 1;
      if (read !== undefined && read.value === truth.value) {
        values += 1; slip.correct += 1;
        if (item.photo === "clear") clearValues += 1;
        return;
      }
      wrongValues += 1;
      const m = mapped[i];
      const checked = m !== undefined && (m.checks.length > 0 || m.placement === "not_placed");
      if (checked) wrongWithCheck += 1;
      slip.wrong.push({ code: truth.code, truth: truth.value, read: read?.value ?? null, checked });
    });
    perSlip.push(slip);
  }
  const share = (a: number, b: number): number => (b === 0 ? 1 : a / b);
  return {
    slips: set.length, rows, valueAccuracy: share(values, rows), codeAccuracy: share(codes, rows), clearValueAccuracy: share(clearValues, clearRows),
    wrongValues, wrongWithCheck, wrongWithCheckShare: wrongValues === 0 ? null : wrongWithCheck / wrongValues, unreadable, perSlip,
  };
}

/** The two conditions the eval can judge; the third (a paid-tier, no-training key recorded on #934) is a person's. */
export function productionGate(m: SlipEvalMetrics): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (m.clearValueAccuracy < 0.98) reasons.push(`clear-photo value accuracy ${(m.clearValueAccuracy * 100).toFixed(1)}% is below 98%`);
  if (m.wrongValues > 0 && m.wrongWithCheck < m.wrongValues) reasons.push(`${String(m.wrongValues - m.wrongWithCheck)} wrong value(s) carried no check`);
  if (m.unreadable > 0) reasons.push(`${String(m.unreadable)} reply(ies) did not match the schema`);
  return { ok: reasons.length === 0, reasons };
}

/* ═══════════════════════════════ rendering a synthetic slip ═══════════════════════════════ */

/**
 * The classic 5×7 dot-matrix font (ASCII 0x20–0x7E; five columns per glyph, bit 0 the top row) — what a
 * thermal analyser printer looks like — plus the two arrows analysers print beside a value.
 */
const FONT5X7 = [
  "000000000000005f00000007000700147f147f14242a7f2a12231308646236495522500005030000",
  "001c2241000041221c00082a1c2a0808083e08080050300000080808080800606000002010080402",
  "3e5149453e00427f400042615149462141454b311814127f1027454545393c4a4949300171090503",
  "3649494936064949291e003636000000563600000008142241141414141441221408000201510906",
  "324979413e7e1111117e7f494949363e414141227f4141221c7f494949417f090901013e41415132",
  "7f0808087f00417f41002040413f017f081422417f404040407f0204027f7f0408107f3e4141413e",
  "7f090909063e4151215e7f09192946464949493101017f01013f4040403f1f2040201f7f2018207f",
  "63140814630304780403615149454300007f4141020408102041417f000004020102044040404040",
  "000102040020545454787f484444383844444420384444487f3854545418087e090102081454543c",
  "7f0804047800447d40002040443d00007f10284400417f40007c041804787c080404783844444438",
  "7c14141408081414187c7c080404084854545420043f4440203c4040207c1c2040201c3c4030403c",
  "44281028440c5050503c4464544c44000836410000007f0000004136080008082a1c08",
].join("");

function glyphTable(): Map<string, number[]> {
  const hex = FONT5X7;
  const out = new Map<string, number[]>();
  for (let c = 0x20; c <= 0x7e; c += 1) {
    const at = (c - 0x20) * 10;
    const cols: number[] = [];
    for (let k = 0; k < 5; k += 1) cols.push(parseInt(hex.slice(at + k * 2, at + k * 2 + 2), 16));
    out.set(String.fromCharCode(c), cols);
  }
  out.set("↑", [0x04, 0x02, 0x7f, 0x02, 0x04]);
  out.set("↓", [0x10, 0x20, 0x7f, 0x20, 0x10]);
  return out;
}
let GLYPHS: Map<string, number[]> | null = null;

function slipLines(item: SlipEvalItem): string[] {
  const h = item.reply.header;
  const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s + " ".repeat(n - s.length));
  const out = [
    item.reply.analyserText ?? "HAEMATOLOGY ANALYSER",
    "------------------------------",
    `Name: ${h.name ?? ""}`,
    `Gender: ${pad(h.gender ?? "", 8)}Age: ${h.age ?? ""}`,
    `Sample ID: ${h.sampleId ?? ""}`,
    `Patient ID: ${h.patientId ?? ""}`,
    `Time: ${h.printedAt ?? ""}`,
    "------------------------------",
    `${pad("Para", 9)}${pad("Result", 10)}Unit`,
  ];
  for (const r of item.reply.rows) {
    const mark = r.flag === "H" ? " ↑" : r.flag === "L" ? " ↓" : "";
    out.push(`${pad(r.code, 9)}${pad(`${r.value ?? "----"}${mark}`, 10)}${r.unit ?? ""}`);
  }
  out.push("------------------------------", "SYNTHETIC TEST SLIP - NOT A PATIENT");
  return out;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A synthetic slip as a grey PNG: dark dots on thermal-white paper, 4 px a dot, long edge well under 2400 px. */
export function renderSlipPng(item: SlipEvalItem): Buffer {
  GLYPHS ??= glyphTable();
  const S = 4, CW = 6, LH = 10, M = 6;
  const lines = slipLines(item);
  const cols = Math.max(...lines.map((l) => [...l].length));
  const width = (cols * CW + M * 2) * S, height = (lines.length * LH + M * 2) * S;
  const px = Buffer.alloc(width * height, 0xf2);
  lines.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      const g = GLYPHS!.get(ch) ?? GLYPHS!.get("?")!;
      g.forEach((bits, gx) => {
        for (let gy = 0; gy < 7; gy += 1) {
          if (((bits >> gy) & 1) === 0) continue;
          const x0 = (M + col * CW + gx) * S, y0 = (M + row * LH + gy) * S;
          for (let dy = 0; dy < S - 1; dy += 1) for (let dx = 0; dx < S - 1; dx += 1) px[(y0 + dy) * width + x0 + dx] = 0x22;
        }
      });
    });
  });
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) { raw[y * (width + 1)] = 0; px.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}
