import fs from "node:fs";
import path from "node:path";
import {
  MAX_EDGE, applyHomography, base64Bytes, detectDocument, fitToMaxEdge, fitsBudget, flatSize, frameQuad, homography, slipDoor, slipOfPatient,
} from "../src/slips/rules";
import type { Pixels, Quad, SlipRow } from "../src/slips/rules";

const WEB = path.join(__dirname, "../../web/src");
const SHARED = path.join(__dirname, "../../../packages/contracts/src");

describe("the slip desk's rules and the crop's arithmetic are ONE copy, shared with the web desk", () => {
  it("the web re-exports the shared files and keeps no arithmetic of its own", () => {
    expect(fs.readFileSync(path.join(WEB, "lib/doc-crop/geometry.ts"), "utf8")).toContain('export * from "../../../../../packages/contracts/src/doc-crop/geometry"');
    expect(fs.readFileSync(path.join(WEB, "lib/doc-crop/detect.ts"), "utf8")).toContain('export * from "../../../../../packages/contracts/src/doc-crop/detect"');
    for (const f of ["lib/doc-crop/geometry.ts", "lib/doc-crop/detect.ts"]) {
      expect(fs.readFileSync(path.join(WEB, f), "utf8")).not.toMatch(/export function /);
    }
    const desk = fs.readFileSync(path.join(WEB, "screens/slip-capture.tsx"), "utf8");
    expect(desk).toContain('from "../../../../packages/contracts/src/slip-desk"');
    for (const name of ["fitToMaxEdge", "base64Bytes", "fitsBudget"]) expect(desk).not.toMatch(new RegExp(`export function ${name}\\b`));
  });
  it("the shared crop files touch no DOM, so they run on the phone", () => {
    for (const f of ["doc-crop/geometry.ts", "doc-crop/detect.ts", "slip-desk.ts"]) {
      const src = fs.readFileSync(path.join(SHARED, f), "utf8");
      expect(src).not.toMatch(/\bdocument\.|\bwindow\.|HTMLImageElement|getContext\(/);
    }
  });
});

describe("the size budget", () => {
  it("never upscales, and caps the long edge at 1600", () => {
    expect(MAX_EDGE).toBe(1600);
    expect(fitToMaxEdge(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitToMaxEdge(400, 300)).toEqual({ width: 400, height: 300 });
  });
  it("counts a base64 payload's bytes without decoding it, against a budget under the server's 1.5 MB", () => {
    expect(base64Bytes("QUJD")).toBe(3);
    expect(fitsBudget("A".repeat(1_860_000))).toBe(true);   // 1.395 MB
    expect(fitsBudget("A".repeat(1_880_000))).toBe(false);  // 1.41 MB
  });
});

/** A light page, turned and seen at an angle, on a darker noisy counter. */
function scene(w: number, h: number, page: Quad): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  const hInv = homography(page, frameQuad(1, 1))!;
  let seed = 7;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = applyHomography(hInv, { x: x + 0.5, y: y + 0.5 });
      const on = p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
      const v = on ? 232 + rnd() * 12 : 70 + rnd() * 30;
      const i = (y * w + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = on ? v : v * 0.8; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

describe("finding the page — the web desk's detector, on the phone's JavaScript engine", () => {
  const page: Quad = [{ x: 96, y: 70 }, { x: 388, y: 96 }, { x: 372, y: 560 }, { x: 60, y: 520 }];
  it("finds a turned page's corners within a few pixels", () => {
    const found = detectDocument(scene(480, 640, page));
    expect(found).not.toBeNull();
    found!.quad.forEach((c, i) => { expect(Math.hypot(c.x - page[i]!.x, c.y - page[i]!.y)).toBeLessThan(8); });
  });
  it("says 'not found' for a bare counter", () => {
    expect(detectDocument(scene(480, 640, [{ x: -900, y: -900 }, { x: -800, y: -900 }, { x: -800, y: -800 }, { x: -900, y: -800 }]))).toBeNull();
  });
  it("straightens to an A-series page when the corners are one", () => {
    const size = flatSize(page, 1600);
    expect(size.height / size.width).toBeCloseTo(Math.SQRT2, 1);
  });
});

describe("what the desk types or scans (slipDoor)", () => {
  const row = (over: Partial<SlipRow>): SlipRow => ({
    encounterId: "e4", patientId: "p4", visitNo: "V2610060004", patient: { uhid: "U00110049", name: "Geeta Devi", alias: null },
    doctorCode: "DR-0031", roomName: "R2", state: "waiting", tokenNo: 4, departmentCode: "MED",
    consultDoneAt: null, filedAt: null, pages: 0, kinds: [], retakeRequestedAt: null, retakeReason: null, ...over,
  });
  const items = [row({}), row({ encounterId: "e7", patientId: "p7", visitNo: "V2610060007", tokenNo: 4, departmentCode: "ORT", patient: { uhid: "U00110060", name: "Aarav Kumar", alias: null } })];

  it("a visit number always goes to the server's read-back — on the list or not", () => {
    expect(slipDoor(items, " v2610060004 ")).toEqual({ to: "visit", visitNo: "V2610060004" });
    expect(slipDoor(items, "V2610050001")).toEqual({ to: "visit", visitNo: "V2610050001" });
  });
  it("the token as the slip prints it, a UHID, and a printed prescription's code name today's visit", () => {
    expect(slipDoor(items, "ORT-4")).toEqual({ to: "visit", visitNo: "V2610060007" });
    expect(slipDoor(items, "u00110049")).toEqual({ to: "visit", visitNo: "V2610060004" });
    expect(slipDoor(items, "rx1.RX1.e7.1.sig")).toEqual({ to: "visit", visitNo: "V2610060007" });
  });
  it("a bare token two patients hold is never guessed", () => {
    const r = slipDoor(items, "4");
    expect(r.to).toBe("ambiguous");
    if (r.to === "ambiguous") expect(r.rows.map((x) => x.visitNo).sort()).toEqual(["V2610060004", "V2610060007"]);
  });
  it("words are a search, a card is verified by the server, an unknown token is a plain miss", () => {
    expect(slipDoor(items, "Geeta")).toEqual({ to: "search", q: "Geeta" });
    expect(slipDoor(items, "q1.p4.U00110049.1.sig")).toEqual({ to: "verify", payload: "q1.p4.U00110049.1.sig" });
    expect(slipDoor(items, "MED-9")).toEqual({ to: "miss", door: { kind: "token", tokenNo: 9, departmentCode: "MED" } });
    expect(slipDoor(items, "  ")).toEqual({ to: "empty" });
  });
  it("a verified card's patient is their slip for today — the unfiled one first", () => {
    expect(slipOfPatient(items, "p7")?.visitNo).toBe("V2610060007");
    expect(slipOfPatient(items, "nobody")).toBeNull();
    const two = [row({ state: "filed", visitNo: "V2610060001", encounterId: "e1" }), row({})];
    expect(slipOfPatient(two, "p4")?.visitNo).toBe("V2610060004");
  });
});
