/**
 * Pure analysis over what the timing harness sampled (no browser, no I/O), so it can be unit tested and re-run over an old
 * raw.json. Every time is milliseconds on one clock: the harness's own start (t = 0), with in-page `performance.mark`s converted
 * from `timeOrigin + startTime` to the same clock, because a mark's own startTime restarts at every document load.
 *
 * Shapes:
 *   sample      { t, docId, url, counts: {name: n}, texts: {name: s}, attrs: {name: s}, regions: {name: hash}, scroll: {x, y},
 *                 viewport: {w, h} } or { t, error } while the page is between documents
 *   mark        { t, name, source: "page" | "script" }   page marks are the app's `ns:*`; script marks are the scenario's steps
 *   navigation  { t, url, document }                    document = a new document was loaded (not history.replaceState)
 *   window      { name, from, to, expect?: [event names] }   an interval in which the person is waiting on work
 *
 * Rule 5 applies here too: an event that never happened is reported as `null` ("never"), never as 0 or as the end of the run.
 */

/**
 * @typedef {{ t: number, error?: string, docId?: string | null, url?: string, counts?: Record<string, number>, texts?: Record<string, string | null>,
 *   attrs?: Record<string, string | null>, regions?: Record<string, string | null>, scroll?: { x: number, y: number }, viewport?: { w: number, h: number } }} Sample
 * @typedef {{ t: number, name: string, source: string }} Mark
 * @typedef {{ t: number, url: string, document: boolean }} Navigation
 * @typedef {{ name: string, from: number | null | undefined, to: number | null | undefined, expect?: string[] }} Window
 * @typedef {{ name: string, count?: string, min?: number, text?: string, attr?: string, match?: RegExp | string, after?: number }} EventDef
 * @typedef {{ name: string, t: number | null, source: string }} EventRow
 */

export const DEFAULT_STRETCH_MS = 1000;
export const TARGETS = Object.freeze({ firstEventMs: 1000, maxStretchMs: 3000, reloadsAfterCreate: 0 });

/** The value a sample has for one watched thing, so "did anything change" compares like with like. */
function signature(sample, keys) {
  const parts = [];
  for (const k of keys.counts) parts.push(sample.counts?.[k] ?? null);
  for (const k of keys.texts) parts.push(sample.texts?.[k] ?? null);
  for (const k of keys.attrs) parts.push(sample.attrs?.[k] ?? null);
  for (const k of keys.regions) parts.push(sample.regions?.[k] ?? null);
  if (keys.scroll) parts.push(sample.scroll ? `${sample.scroll.x},${sample.scroll.y}` : null);
  if (keys.viewport) parts.push(sample.viewport ? `${sample.viewport.w}x${sample.viewport.h}` : null);
  // The document, but not the URL: history.replaceState(?brain=) changes the address bar, not anything on the page, and counting it
  // once ended a "frozen board" stretch at the moment the answer arrived although the board had not changed.
  parts.push(sample.docId ?? null);
  return JSON.stringify(parts);
}

function keysOf(samples) {
  const keys = { counts: new Set(), texts: new Set(), attrs: new Set(), regions: new Set() };
  for (const s of samples) for (const g of ["counts", "texts", "attrs", "regions"]) for (const k of Object.keys(s[g] || {})) keys[g].add(k);
  return { counts: [...keys.counts], texts: [...keys.texts], attrs: [...keys.attrs], regions: [...keys.regions] };
}

/**
 * Times at which something sampled changed. `only` narrows the comparison to one region's hash (and the document), which is how
 * "the canvas never changed" is told apart from "the panel's dots changed". Error samples (between documents) are skipped: a
 * blank moment is not a change the person can read, and the next readable sample is compared with the last readable one.
 */
/** @param {Sample[]} samples @param {{ only?: string | null }} [opts] @returns {number[]} */
export function changeTimes(samples, { only = null } = {}) {
  const ok = samples.filter((s) => !s.error).sort((a, b) => a.t - b.t);
  const all = keysOf(ok);
  const keys = only
    ? { counts: [], texts: [], attrs: [], regions: [only], scroll: false, viewport: false }
    : { ...all, scroll: true, viewport: true };
  const out = [];
  let prev = null;
  for (const s of ok) {
    const sig = signature(s, keys);
    if (prev !== null && sig !== prev) out.push(s.t);
    prev = sig;
  }
  return out;
}

/**
 * Intervals inside the work windows longer than `thresholdMs` with no change, longest first. A stretch is cut at window edges, so
 * the scripted person's own pauses (which sit between windows) are never counted against the app.
 */
/** @param {Sample[]} samples @param {Window[]} windows @param {{ thresholdMs?: number, only?: string | null }} [opts] */
export function unchangedStretches(samples, windows, { thresholdMs = DEFAULT_STRETCH_MS, only = null } = {}) {
  const changes = changeTimes(samples, { only });
  const out = [];
  for (const w of windows) {
    if (w.from == null || w.to == null || w.to <= w.from) continue;
    const inside = changes.filter((t) => t > w.from && t < w.to);
    const edges = [w.from, ...inside, w.to];
    for (let i = 0; i + 1 < edges.length; i++) {
      const ms = edges[i + 1] - edges[i];
      if (ms > thresholdMs) out.push({ window: w.name, region: only ?? "screen", from: edges[i], to: edges[i + 1], ms });
    }
  }
  return out.sort((a, b) => b.ms - a.ms || a.from - b.from);
}

/**
 * The first time each named event was seen. DOM events come from `defs` ({ name, count?: key, min?: n, text?: key, match?: RegExp|string,
 * attr?: key, after?: t }); page marks are taken as they are (each `ns:*` name once, at its first occurrence); script marks are listed too so
 * the table reads as one story. Rows are sorted by time; events never seen are kept with t = null, at the end.
 */
/** @param {{ samples?: Sample[], marks?: Mark[], navigations?: Navigation[], defs?: EventDef[] }} input @returns {EventRow[]} */
export function eventTable({ samples = [], marks = [], navigations = [], defs = [] }) {
  const ok = samples.filter((s) => !s.error).sort((a, b) => a.t - b.t);
  const rows = [];
  for (const d of defs) {
    const hit = ok.find((s) => (d.after == null || s.t >= d.after) && matches(s, d));
    rows.push({ name: d.name, t: hit ? hit.t : null, source: "dom" });
  }
  const seen = new Set();
  for (const m of [...marks].sort((a, b) => a.t - b.t)) {
    const key = `${m.source}:${m.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ name: m.name, t: m.t, source: m.source === "page" ? "mark" : "script" });
  }
  for (const n of navigations) if (n.document) rows.push({ name: `document load ${n.url}`, t: n.t, source: "nav" });
  return rows.sort((a, b) => (a.t === null) - (b.t === null) || (a.t ?? 0) - (b.t ?? 0));
}

function matches(s, d) {
  if (d.count) return (s.counts?.[d.count] ?? 0) >= (d.min ?? 1);
  if (d.text) {
    const v = s.texts?.[d.text];
    if (v == null) return false;
    if (d.match == null) return v.length > 0;
    return d.match instanceof RegExp ? d.match.test(v) : v.includes(String(d.match));
  }
  if (d.attr) {
    const v = s.attrs?.[d.attr];
    if (v == null) return false;
    return d.match == null ? true : d.match instanceof RegExp ? d.match.test(v) : v.includes(String(d.match));
  }
  return false;
}

/**
 * Full document loads after `after` (Create's confirm). A same-document change (history.replaceState(?brain=)) is not a reload:
 * the person keeps the panel and the conversation. Only `document: true` counts.
 */
/** @param {Navigation[]} navigations @param {{ after?: number }} [opts] */
export function countReloads(navigations, { after = -Infinity } = {}) {
  return navigations.filter((n) => n.document && n.t > after).length;
}

/**
 * Plan §3.11's three targets. `firstEvent` per window is the earliest of its `expect` events (rows of the event table) after the
 * window opens; a window with no `expect` uses the first sampled change of the screen. `null` means it never happened, which fails.
 */
/**
 * @param {{ windows: Window[], table: EventRow[], samples: Sample[], navigations: Navigation[], createAt?: number | null,
 *   stretchRegions?: (string | null)[], targets?: { firstEventMs: number, maxStretchMs: number, reloadsAfterCreate: number } }} input
 */
export function checkTargets({ windows, table, samples, navigations, createAt, stretchRegions = [null], targets = TARGETS }) {
  const screenChanges = changeTimes(samples);
  const firstEvents = windows.map((w) => {
    // Informational: the first change anywhere (a bubble, the dots), so "nothing in the plan area" is not read as "nothing at all".
    const any = screenChanges.find((t) => t > w.from);
    const anyChangeMs = any === undefined ? null : any - w.from;
    let at = null;
    if (w.expect && w.expect.length) {
      const hits = table.filter((r) => w.expect.includes(r.name) && r.t !== null && r.t >= w.from).map((r) => r.t);
      at = hits.length ? Math.min(...hits) : null;
    } else {
      at = any ?? null;
    }
    const ms = at === null ? null : at - w.from;
    return { window: w.name, expect: w.expect ?? ["any screen change"], ms, anyChangeMs, ok: ms !== null && ms < targets.firstEventMs };
  });
  const longest = stretchRegions.map((only) => {
    const top = unchangedStretches(samples, windows, { thresholdMs: 0, only })[0] ?? null;
    const ms = top ? top.ms : 0;
    return { region: only ?? "screen", ms, at: top, ok: ms <= targets.maxStretchMs };
  });
  const reloads = createAt == null ? null : countReloads(navigations, { after: createAt });
  return {
    firstEvent: { target: `< ${targets.firstEventMs} ms`, rows: firstEvents, ok: firstEvents.every((r) => r.ok) },
    stretch: { target: `<= ${targets.maxStretchMs} ms`, rows: longest, ok: longest.every((r) => r.ok) },
    reloads: { target: `${targets.reloadsAfterCreate}`, count: reloads, ok: reloads !== null && reloads <= targets.reloadsAfterCreate },
  };
}

const fmtS = (ms) => (ms === null || ms === undefined ? "never" : `${(ms / 1000).toFixed(2)} s`);

/** REPORT.md body. Times in the event table are shown both from the run start and from the window that contains them. */
/**
 * @param {{ title: string, meta?: Record<string, unknown>, table: EventRow[], windows: Window[], stretches: any[], checks: any,
 *   strip?: { t: number, f: string }[], notes?: string[] }} input
 */
export function renderReport({ title, meta = {}, table, windows, stretches, checks, strip = [], notes = [] }) {
  const relTo = (t) => {
    if (t === null) return "";
    // Only inside a window: the person's own pauses between windows are not "time since" any work.
    const w = windows.find((x) => x.from != null && x.to != null && t >= x.from && t <= x.to);
    return w ? `${w.name} +${fmtS(t - w.from)}` : "";
  };
  const L = [];
  L.push(`# ${title}`, "");
  for (const [k, v] of Object.entries(meta)) L.push(`- ${k}: ${v}`);
  L.push("", "## Targets (LIVE_CREATION_PLAN §3.11)", "", "| Target | Result | Pass |", "| :-- | :-- | :-- |");
  for (const r of checks.firstEvent.rows) {
    const any = r.anyChangeMs === undefined ? "" : ` (any screen change: ${fmtS(r.anyChangeMs)})`;
    L.push(`| First event after ${r.window} (${r.expect.join(" or ")}) ${checks.firstEvent.target} | ${fmtS(r.ms)}${any} | ${r.ok ? "yes" : "NO"} |`);
  }
  for (const r of checks.stretch.rows) L.push(`| Longest unchanged stretch while work runs, ${r.region} ${checks.stretch.target} | ${fmtS(r.ms)}${r.at ? ` (${r.at.window})` : ""} | ${r.ok ? "yes" : "NO"} |`);
  L.push(`| Full-page reloads after Create = ${checks.reloads.target} | ${checks.reloads.count ?? "Create not reached"} | ${checks.reloads.ok ? "yes" : "NO"} |`);
  L.push("", "## Work windows", "", "| Window | From | To | Length |", "| :-- | --: | --: | --: |");
  for (const w of windows) L.push(`| ${w.name} | ${fmtS(w.from)} | ${fmtS(w.to)} | ${w.from != null && w.to != null ? fmtS(w.to - w.from) : "never"} |`);
  L.push("", "## Events (first seen)", "", "| t | Since | Event | Source |", "| --: | :-- | :-- | :-- |");
  for (const r of table) L.push(`| ${fmtS(r.t)} | ${relTo(r.t)} | ${r.name} | ${r.source} |`);
  L.push("", "## Unchanged stretches while work runs, longest first", "", "| # | Region | Window | From | To | Length |", "| --: | :-- | :-- | --: | --: | --: |");
  if (!stretches.length) L.push("| – | – | – | – | – | none over the threshold |");
  stretches.slice(0, 15).forEach((s, i) => L.push(`| ${i + 1} | ${s.region} | ${s.window} | ${fmtS(s.from)} | ${fmtS(s.to)} | ${fmtS(s.ms)} |`));
  if (strip.length) L.push("", `## Filmstrip`, "", `${strip.length} frames, first \`${strip[0].f}\`, last \`${strip[strip.length - 1].f}\`.`);
  if (notes.length) L.push("", "## Notes", "", ...notes.map((n) => `- ${n}`));
  return L.join("\n") + "\n";
}
