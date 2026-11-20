/**
 * CSV and XLSX for the owner analytics hub: every chart and table can leave as a file.
 *
 * Written here rather than pulled in as a dependency: the spreadsheet libraries on npm are either unmaintained on the
 * registry (SheetJS moved off it) or several megabytes for a feature that needs one sheet of strings and numbers. An
 * XLSX is a zip of five small XML files; a stored (uncompressed) zip is a header, the bytes and a CRC-32.
 *
 * Two rules every cell obeys:
 * - An unknown stays unknown. A null cell is written empty in CSV and as an empty cell in XLSX, never 0 (CLAUDE.md #5):
 *   an accountant summing a column must not be handed a zero that was never measured.
 * - A text cell that starts with = + - @ (or a tab/CR) is a formula to Excel and LibreOffice, and a customer's name is
 *   text the customer chose. It is prefixed with an apostrophe so it opens as text (CSV injection, OWASP).
 *
 * Pure: no server imports. Returns bytes; the route sets the headers.
 */

export type Cell = string | number | null;
export interface Table {
  /** Sheet name and file stem. */
  name: string;
  columns: string[];
  rows: Cell[][];
  /** Lines printed above the header in CSV and as the first rows in XLSX: the period, the timezone, the caveats. */
  preamble?: string[];
}

// A leading newline too: no spreadsheet runs "\n=HYPERLINK(…)" today, but nothing is lost by neutralising it.
const FORMULA_START = /^[=+\-@\t\r\n]/;

/** Text that a spreadsheet will not run. Numbers are left alone: -5 is a number, not a formula. */
export function neutralize(v: string): string {
  return FORMULA_START.test(v) ? `'${v}` : v;
}

function csvField(v: Cell): string {
  if (v === null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = neutralize(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a UTF-8 BOM, so Excel opens Cyrillic and Uzbek text as UTF-8 rather than the system code page. */
export function toCsv(t: Table): Uint8Array {
  const lines: string[] = [];
  for (const p of t.preamble ?? []) lines.push(csvField(p));
  if (t.preamble?.length) lines.push("");
  lines.push(t.columns.map(csvField).join(","));
  for (const r of t.rows) lines.push(r.map(csvField).join(","));
  return new TextEncoder().encode("﻿" + lines.join("\r\n") + "\r\n");
}

// --- XLSX -----------------------------------------------------------------------------------------------------------

function xmlEscape(s: string): string {
  // Characters XML 1.0 cannot carry at all are dropped; a control character in a name is not worth a corrupt file.
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[<>&"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;",
  );
}

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellXml(v: Cell, ref: string, bold: boolean): string {
  const style = bold ? ' s="1"' : "";
  if (v === null) return `<c r="${ref}"${style}/>`;
  if (typeof v === "number") {
    return Number.isFinite(v) ? `<c r="${ref}"${style}><v>${v}</v></c>` : `<c r="${ref}"${style}/>`;
  }
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(neutralize(v))}</t></is></c>`;
}

/** A sheet name Excel accepts: at most 31 characters, none of : \ / ? * [ ]. */
export function sheetName(name: string): string {
  const s = name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
  return s || "Sheet1";
}

function sheetXml(t: Table): string {
  const rows: string[] = [];
  let r = 1;
  for (const p of t.preamble ?? []) rows.push(`<row r="${r}">${cellXml(p, `A${r++}`, false)}</row>`);
  if (t.preamble?.length) r++;
  rows.push(`<row r="${r}">${t.columns.map((c, i) => cellXml(c, `${colName(i)}${r}`, true)).join("")}</row>`);
  r++;
  for (const row of t.rows) {
    rows.push(`<row r="${r}">${row.map((c, i) => cellXml(c, `${colName(i)}${r}`, false)).join("")}</row>`);
    r++;
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows.join("")}</sheetData></worksheet>`
  );
}

function xlsxFiles(tables: Table[]): Array<[string, string]> {
  const sheets = tables.map((t, i) => ({ t, id: i + 1, name: sheetName(t.name) }));
  // Two sheets that truncate to the same 31 characters would make Excel refuse the whole file.
  const seen = new Set<string>();
  for (const s of sheets) {
    let n = s.name;
    let k = 2;
    while (seen.has(n.toLowerCase())) n = `${s.name.slice(0, 28)} ${k++}`;
    s.name = n;
    seen.add(n.toLowerCase());
  }
  return [
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map(
            (s) =>
              `<Override PartName="/xl/worksheets/sheet${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        "</Types>",
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ],
    [
      "xl/workbook.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((s) => `<sheet name="${xmlEscape(s.name)}" sheetId="${s.id}" r:id="rId${s.id}"/>`).join("") +
        "</sheets></workbook>",
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (s) =>
              `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.id}.xml"/>`,
          )
          .join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>",
    ],
    [
      "xl/styles.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        "</styleSheet>",
    ],
    ...sheets.map((s): [string, string] => [`xl/worksheets/sheet${s.id}.xml`, sheetXml(s.t)]),
  ];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A stored (method 0) zip. Deterministic: a fixed timestamp, so the same data gives the same bytes. */
export function zipStore(files: Array<[string, Uint8Array]>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const [name, data] of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    locals.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One workbook, one sheet per table. */
export function toXlsx(tables: Table[]): Uint8Array {
  const enc = new TextEncoder();
  return zipStore(xlsxFiles(tables).map(([n, s]) => [n, enc.encode(s)]));
}

/** A file name that is safe in a Content-Disposition header: ASCII letters, digits, dot, dash, underscore. */
export function safeFileStem(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "export";
}
