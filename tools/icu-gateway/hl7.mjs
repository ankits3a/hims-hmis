// @ts-check
/**
 * ICU IC-1 (#984, decision 0090, option A) — THE ICU GATEWAY'S HL7 HALF. Dependency-free (the print relay's shape): it
 * copies onto the hall's gateway box and runs on Node 22 alone.
 *
 * The maker's central station sends HL7 v2 over MLLP: ORU^R01 for numbers (one OBX per parameter, the bed in PV1-3) and,
 * where the vendor exports them (a purchase requirement in 0090), ORU^R40 alarms (IHE PCD ACM: priority in OBX-8 —
 * PH high, PM medium, PL low). This file turns one message into the JSON HMIS takes — the RAW OBX code and unit, the
 * device's own clock — and builds the ACK. It maps nothing: the code map lives in HMIS (`icu_gateway_codes`), where an
 * unmapped code is quarantined and never dropped.
 */

export const MLLP_START = "\x0b";
export const MLLP_END = "\x1c\x0d";

/** HL7 TS (YYYYMMDDHHMM[SS][.S][+ZZZZ]) → ISO instant. No zone = IST (the hospital's clock). */
export function hl7Time(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?([+-]\d{4})?$/.exec(String(ts ?? "").trim());
  if (m === null) return null;
  const zone = m[7] === undefined ? "+05:30" : `${m[7].slice(0, 3)}:${m[7].slice(3)}`;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Split a message into segments of fields. */
export function segments(message) {
  return String(message).replace(/\r\n/g, "\r").replace(/\n/g, "\r").split("\r").filter((s) => s.trim() !== "")
    .map((s) => s.split("|"));
}

const TECHNICAL = { X: "probe_off", I: "calibrating" };
const PRIORITY = { PH: "life_threatening", PM: "medium", PL: "low" };

/**
 * One message → `{ type, controlId, samples[], alarms[] }`. The slot is PV1-3's bed component (else its last non-empty
 * component). A numeric OBX (NM) is a sample; OBX-11 `X` (cannot be obtained) is a technical reading with no value.
 * An ORU^R40 OBX is an alarm (its OBX-5 text, its OBX-8 priority).
 */
export function parseMessage(message) {
  const segs = segments(message);
  const msh = segs.find((s) => s[0] === "MSH");
  if (msh === undefined) throw new Error("not an HL7 message: no MSH");
  const type = (msh[8] ?? "").split("^").slice(0, 2).join("^");
  const controlId = msh[9] ?? "";
  const pv1 = segs.find((s) => s[0] === "PV1");
  const loc = (pv1?.[3] ?? "").split("^");
  const slot = (loc[2] ?? "").trim() || loc.filter((x) => x.trim() !== "").at(-1) || "";
  const samples = [];
  const alarms = [];
  const fallbackAt = hl7Time(msh[6]);
  for (const s of segs.filter((x) => x[0] === "OBX")) {
    const valueType = s[2] ?? "";
    const code = s[3] ?? "";
    const raw = s[5] ?? "";
    const unit = (s[6] ?? "").split("^")[1] ?? (s[6] ?? "");
    const status = s[11] ?? "";
    const at = hl7Time(s[14]) ?? fallbackAt;
    if (at === null || code === "" || slot === "") continue;
    if (type === "ORU^R40") {
      const severity = PRIORITY[(s[8] ?? "").split("~")[0]] ?? "medium";
      alarms.push({ slot, code, severity, message: String(raw).split("^").filter(Boolean).at(-1) ?? "alarm", at });
      continue;
    }
    if (valueType !== "NM") continue;
    const technical = TECHNICAL[status];
    const value = technical === undefined && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
    samples.push({ slot, code, value, ...(unit === "" ? {} : { unit }), at, ...(technical === undefined ? (value === null ? { technical: "artefact" } : {}) : { technical }) });
  }
  return { type, controlId, samples, alarms };
}

/** The ACK for a message (AA accepted, AE error), framed for MLLP. */
export function ackFor(message, code = "AA", now = new Date()) {
  const msh = segments(message).find((s) => s[0] === "MSH") ?? [];
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const fields = ["MSH", "^~\\&", "HMIS-ICU-GW", "HMIS", msh[2] ?? "", msh[3] ?? "", ts, "", "ACK", `ACK${ts}`, "P", "2.6"];
  return `${MLLP_START}${fields.join("|")}\rMSA|${code}|${msh[9] ?? ""}\r${MLLP_END}`;
}

/** Pull every complete MLLP frame out of a buffer; answers the frames and what is left over. */
export function unframe(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    const start = rest.indexOf(MLLP_START);
    const end = rest.indexOf(MLLP_END, start + 1);
    if (start < 0 || end < 0) break;
    frames.push(rest.slice(start + 1, end));
    rest = rest.slice(end + MLLP_END.length);
  }
  return { frames, rest };
}

/** Cut queued samples into batches of at most `max` (the server takes 120). */
export function batchesOf(samples, max = 120) {
  const out = [];
  for (let i = 0; i < samples.length; i += max) out.push(samples.slice(i, i + max));
  return out;
}
