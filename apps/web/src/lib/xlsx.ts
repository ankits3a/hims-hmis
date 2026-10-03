/**
 * ═══ PHARMACY GAP CLOSURE, STAGE C — A REAL .xlsx, WITHOUT A LIBRARY ═══
 *
 * The office's reports exported CSV, which Excel opens but reads as text: a GSTIN or an HSN loses its
 * leading zero, a batch "1E5" becomes 100000, and money is a string. An .xlsx carries typed cells. The
 * format is a ZIP of five small XML parts (Office Open XML SpreadsheetML); this writes them with STORED
 * (uncompressed) entries and a CRC-32 — about 150 lines instead of a 400 kB dependency (SheetJS,
 * ExcelJS), for one flat sheet: a bold header row, text as inline strings (every text cell stays text),
 * numbers as numbers, money as rupees with a `#,##0.00` format, a bold totals row, a frozen header.
 */

export type XlsxCell = string | number | null;
export type XlsxSheet = {
  name: string;
  header: readonly string[];
  rows: readonly (readonly XlsxCell[])[];
  totals?: readonly XlsxCell[] | null;
  /** Columns whose numbers are money (rupees, two decimals). */
  money?: readonly boolean[];
};

const enc = new TextEncoder();

// ── CRC-32 (IEEE 802.3), the ZIP's checksum ──
let CRC_TABLE: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of STORED entries (method 0), UTF-8 names. */
export function zipStored(files: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // 1980-01-01 00:00 — a fixed stamp, so the same sheet is the same bytes.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

/** Text safe inside XML: escaped, and without the control characters XML 1.0 forbids. */
const xml = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A column's letters: 0 → A, 25 → Z, 26 → AA. */
export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel's sheet-name rules: at most 31 characters, none of `[]:*?/\`. */
const sheetName = (s: string): string => (s.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet1");

// Styles: 0 normal · 1 bold · 2 money · 3 bold money.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs></styleSheet>`;

function sheetXml(s: XlsxSheet): string {
  const money = s.money ?? [];
  const cell = (v: XlsxCell, r: number, c: number, bold: boolean): string => {
    const ref = `${colName(c)}${String(r)}`;
    if (v === null || v === "") return "";
    if (typeof v === "number" && Number.isFinite(v)) {
      const style = money[c] === true ? (bold ? 3 : 2) : bold ? 1 : 0;
      return `<c r="${ref}"${style === 0 ? "" : ` s="${String(style)}"`}><v>${String(v)}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ""}><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
  };
  const lines = [s.header, ...s.rows, ...(s.totals == null ? [] : [s.totals])];
  const last = lines.length;
  const rowsXml = lines.map((row, i) => {
    const r = i + 1;
    const bold = i === 0 || (s.totals != null && r === last);
    return `<row r="${String(r)}">${row.map((v, c) => cell(v, r, c, bold)).join("")}</row>`;
  }).join("");
  const widths = s.header.map((_, c) => Math.min(60, Math.max(8, ...lines.map((row) => String(row[c] ?? "").length + 2))));
  const cols = widths.map((w, c) => `<col min="${String(c + 1)}" max="${String(c + 1)}" width="${String(w)}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols === "" ? "" : `<cols>${cols}</cols>`}<sheetData>${rowsXml}</sheetData></worksheet>`;
}

/** One sheet as the bytes of an .xlsx file. */
export function toXlsx(sheet: XlsxSheet): Uint8Array {
  const files: { name: string; xml: string }[] = [
    { name: "[Content_Types].xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName(sheet.name))}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", xml: STYLES },
    { name: "xl/worksheets/sheet1.xml", xml: sheetXml(sheet) },
  ];
  return zipStored(files.map((f) => ({ name: f.name, data: enc.encode(f.xml) })));
}

/**
 * Owner 2026-10-03 — several sheets in one workbook (the accounts' "Export all"): the same parts as
 * `toXlsx`, one worksheet part per sheet, names kept unique (Excel refuses a repeated sheet name).
 */
export function toXlsxBook(sheets: readonly XlsxSheet[]): Uint8Array {
  const used = new Set<string>();
  const names = sheets.map((sh) => {
    let n = sheetName(sh.name);
    for (let i = 2; used.has(n.toLowerCase()); i++) n = sheetName(`${sh.name.slice(0, 27)} ${String(i)}`);
    used.add(n.toLowerCase());
    return n;
  });
  const overrides = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${String(i + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const files: { name: string; xml: string }[] = [
    { name: "[Content_Types].xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${String(i + 1)}" r:id="rId${String(i + 1)}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${String(i + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(i + 1)}.xml"/>`).join("")}<Relationship Id="rId${String(sheets.length + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", xml: STYLES },
    ...sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${String(i + 1)}.xml`, xml: sheetXml(sh) })),
  ];
  return zipStored(files.map((f) => ({ name: f.name, data: enc.encode(f.xml) })));
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Hands an .xlsx to the browser as a download. */
export function downloadXlsx(filename: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: XLSX_MIME }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
