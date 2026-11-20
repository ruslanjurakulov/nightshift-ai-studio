import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Cell, Table } from "@/lib/owner-analytics/export";

/**
 * A branded PDF of one or more tables, built on the server from the same Table objects the screen and the CSV/XLSX use, so
 * the three cannot disagree. An unknown cell is printed as the word the page uses ("unknown", "no rate stored"), never 0.
 *
 * The font is DejaVu Sans (data/fonts, Bitstream Vera licence, LICENSE-DejaVu.txt beside it): the brand's Onest ships only as
 * per-script WOFF2 subsets, which cannot be embedded in a PDF, and Uzbek needs ʻ (U+02BB) and Russian needs Cyrillic in one
 * face. It is read from disk, like the country table (Dockerfile copies data/fonts into the runtime image).
 */

/**
 * The most rows one PDF may hold. pdf-lib draws synchronously on the one Node process that serves every customer; a long
 * register would hold the event loop for minutes (security lab, test_sec_breach_owner_fx.py). Past this, the route refuses the
 * PDF and points to XLSX, which holds any number of rows. The drawing loop also yields every YIELD_EVERY rows.
 */
export const PDF_MAX_ROWS = 2000;
const YIELD_EVERY = 100;

const A4: [number, number] = [595.28, 841.89];
const LANDSCAPE: [number, number] = [841.89, 595.28];
const M = 36;
const NAVY = rgb(0x07 / 255, 0x0a / 255, 0x14 / 255);
const LIME = rgb(0xc8 / 255, 0xff / 255, 0x2e / 255);
const BLUE = rgb(0x2f / 255, 0x8b / 255, 0xff / 255);
const INK = rgb(0.1, 0.12, 0.18);
const DIM = rgb(0.38, 0.42, 0.5);
const RULE = rgb(0.86, 0.88, 0.92);

let fontBytes: Promise<[Uint8Array, Uint8Array]> | null = null;
function loadFonts(): Promise<[Uint8Array, Uint8Array]> {
  const dir = path.join(process.cwd(), "data", "fonts");
  fontBytes ??= Promise.all([readFile(path.join(dir, "DejaVuSans.ttf")), readFile(path.join(dir, "DejaVuSans-Bold.ttf"))]).catch((e) => {
    fontBytes = null; // a failed read is retried next time, not cached as a failure forever
    // Name the remedy, not just the 500: the runtime image must carry data/fonts (Dockerfile copies it beside the geoip table).
    console.error(`PDF FONT MISSING: ${dir}/DejaVuSans*.ttf could not be read (${(e as NodeJS.ErrnoException).code ?? "error"}); the image must COPY data/fonts`);
    throw e;
  });
  return fontBytes;
}

export interface PdfMeta {
  title: string;
  /** "Period: 2026-10-01 — 2026-10-31 (Asia/Tashkent)". */
  periodLine: string;
  /** Lines under the header: the caveats the file must carry (not a declaration, fees unknown, presentation mode…). */
  notes: string[];
  generatedLine: string;
  /** "Page {n} of {total}". */
  pageTemplate: string;
  unknownText: string;
}

/** The longest prefix that fits with an ellipsis, found by halving (a 300-character note is ~9 measurements, not 300). */
function fit(font: PDFFont, text: string, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let lo = 1;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(`${text.slice(0, mid)}…`, size) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

function cellText(v: Cell, unknown: string): string {
  if (v === null) return unknown;
  if (typeof v === "number")
    return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return v;
}

/** One PDF with every table, each starting on a fresh page when it does not fit. */
export async function tablesToPdf(tables: Table[], meta: PdfMeta): Promise<Uint8Array> {
  const [regular, bold] = await loadFonts();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(meta.title);
  doc.setProducer("Nightshift");
  doc.setCreator("Nightshift owner analytics");
  const font = await doc.embedFont(regular, { subset: true });
  const fontB = await doc.embedFont(bold, { subset: true });

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const wide = tables.some((t) => t.columns.length > 7);
  const size = wide ? LANDSCAPE : A4;
  const width = size[0] - 2 * M;

  const newPage = () => {
    page = doc.addPage(size);
    pages.push(page);
    // The brand band: navy, the wordmark in lime, the title and the period. On every page, so a loose page still says what it is.
    page.drawRectangle({ x: 0, y: size[1] - 54, width: size[0], height: 54, color: NAVY });
    page.drawText("Nightshift", { x: M, y: size[1] - 34, size: 16, font: fontB, color: LIME });
    page.drawText(fit(fontB, meta.title, 11, width - 140), { x: M + 120, y: size[1] - 30, size: 11, font: fontB, color: rgb(1, 1, 1) });
    page.drawText(fit(font, meta.periodLine, 9, width - 140), { x: M + 120, y: size[1] - 44, size: 9, font, color: rgb(0.8, 0.85, 0.95) });
    y = size[1] - 72;
  };
  newPage();
  for (const n of meta.notes) {
    for (const line of wrap(font, n, 8.5, width)) {
      page.drawText(line, { x: M, y, size: 8.5, font, color: DIM });
      y -= 11;
    }
  }
  y -= 6;

  for (const t of tables) {
    const cols = t.columns.length;
    // Text columns get more room than numbers; widths are proportional to the longest header or cell, within bounds.
    const sample = [t.columns, ...t.rows.slice(0, 200)];
    const weights = Array.from({ length: cols }, (_, i) =>
      Math.min(28, Math.max(6, ...sample.map((r) => cellText(r[i] ?? null, meta.unknownText).length))),
    );
    const total = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map((w) => (w / total) * width);
    const fs = cols > 9 ? 6.5 : cols > 6 ? 7.5 : 8.5;
    const rowH = fs + 6;

    if (y < M + 80) newPage();
    page.drawText(fit(fontB, t.name, 11, width), { x: M, y, size: 11, font: fontB, color: INK });
    y -= 6;
    page.drawRectangle({ x: M, y, width: 28, height: 2, color: BLUE });
    y -= 12;
    // Each table's own caveats (after its title and period lines), unless the header already printed them: a full report's
    // "a month with no entered costs has no result" belongs under the costs table, not only in the spreadsheet.
    for (const n of (t.preamble ?? []).slice(2)) {
      if (meta.notes.includes(n)) continue;
      for (const line of wrap(font, n, 7.5, width)) {
        if (y < M + 40) newPage();
        page.drawText(line, { x: M, y, size: 7.5, font, color: DIM });
        y -= 10;
      }
    }
    y -= 4;

    const header = () => {
      let x = M;
      t.columns.forEach((c, i) => {
        page.drawText(fit(fontB, c, fs, colW[i] - 4), { x: x + 2, y, size: fs, font: fontB, color: DIM });
        x += colW[i];
      });
      y -= 4;
      page.drawLine({ start: { x: M, y }, end: { x: M + width, y }, thickness: 0.6, color: RULE });
      y -= rowH - 2;
    };
    header();
    for (const [n, r] of t.rows.entries()) {
      // Let other requests run between batches of rows.
      if (n > 0 && n % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
      if (y < M + 20) {
        newPage();
        header();
      }
      let x = M;
      r.forEach((v, i) => {
        const isNum = typeof v === "number";
        const raw = cellText(v, meta.unknownText);
        // A number is never cut to "12,34…": it is set smaller until it fits (down to 5pt), and only text is shortened.
        let size = fs;
        if (isNum) while (size > 5 && font.widthOfTextAtSize(raw, size) > colW[i] - 4) size -= 0.5;
        const text = isNum ? raw : fit(font, raw, fs, colW[i] - 4);
        const tw = font.widthOfTextAtSize(text, size);
        page.drawText(text, { x: isNum ? x + colW[i] - 2 - tw : x + 2, y, size, font, color: v === null ? DIM : INK });
        x += colW[i];
      });
      y -= rowH;
    }
    if (t.rows.length === 0) {
      page.drawText("—", { x: M + 2, y, size: fs, font, color: DIM });
      y -= rowH;
    }
    y -= 16;
  }

  pages.forEach((p, i) => {
    const footer = `${meta.generatedLine} · ${meta.pageTemplate.replace("{n}", String(i + 1)).replace("{total}", String(pages.length))}`;
    p.drawText(fit(font, footer, 7.5, width), { x: M, y: 18, size: 7.5, font, color: DIM });
  });
  return doc.save();
}
