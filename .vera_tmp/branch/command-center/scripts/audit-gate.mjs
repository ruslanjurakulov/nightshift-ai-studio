// The "Dependency advisories" CI gate (BR-S-004/005).
//
// Rules, in this order of strictness:
//   1. Anything that ships to production (`npm audit --omit=dev`) at moderate or worse fails the job.
//   2. A high or critical advisory in the dev tree fails the job UNLESS it is listed in
//      audit-allowlist.mjs with a reason and an expiry date. An expired entry fails the job again,
//      so an allowance is a dated decision, not a permanent mute.
//   3. Allowed advisories are still printed on every run.
//
// Why not `npm audit --audit-level=high` alone: braces <= 3.0.3 (GHSA-vfj7-8cjw-p6xm) has no patched
// release, and the lint toolchain reaches it through eslint-config-next -> @next/eslint-plugin-next
// -> fast-glob -> micromatch. An `overrides` entry cannot help (every published braces is in range),
// and npm's own suggestion, eslint-config-next@14, needs ESLint 8. It is a lint-time dependency
// that never runs in the deployed app, so it is named and dated instead of left to turn every PR red.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ALLOWLIST } from "./audit-allowlist.mjs";

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** The advisories of an `npm audit --json` report, one row per GHSA per package. Transitive rows
 *  (a package that only depends on a vulnerable one) carry no advisory of their own. */
export function advisories(report) {
  const rows = [];
  for (const [name, v] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (via && typeof via === "object" && via.url) {
        const id = String(via.url).split("/").pop();
        rows.push({ id, name, severity: String(via.severity), title: String(via.title ?? "") });
      }
    }
  }
  return rows;
}

/**
 * @returns {{ failures: string[], notes: string[] }}
 * @param {object} full   `npm audit --json`
 * @param {object} prod   `npm audit --omit=dev --json`
 * @param {Array<{id: string, reason: string, expires: string}>} allow
 * @param {string} today  YYYY-MM-DD
 */
export function evaluate(full, prod, allow, today) {
  const failures = [];
  const notes = [];
  for (const a of advisories(prod)) {
    if ((RANK[a.severity] ?? 0) >= RANK.moderate) failures.push(`production: ${a.id} (${a.severity}) in ${a.name}: ${a.title}`);
  }
  const allowed = new Map();
  for (const e of allow ?? []) {
    if (!e?.id || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.expires))) {
      failures.push(`audit-allowlist.mjs: an entry needs id, reason and expires (YYYY-MM-DD): ${JSON.stringify(e)}`);
      continue;
    }
    allowed.set(e.id, e);
  }
  const prodIds = new Set(advisories(prod).map((a) => a.id));
  for (const a of advisories(full)) {
    if ((RANK[a.severity] ?? 0) < RANK.high) continue;
    const e = allowed.get(a.id);
    if (e && prodIds.has(a.id)) failures.push(`${a.id} is in the production tree: an allowance covers the dev tree only`);
    else if (!e) failures.push(`dev: ${a.id} (${a.severity}) in ${a.name}: ${a.title}`);
    else if (e.expires < today) failures.push(`${a.id}: the allowance expired on ${e.expires} (${e.reason}). Fix it or renew it deliberately.`);
    else notes.push(`allowed until ${e.expires}: ${a.id} (${a.severity}) in ${a.name}: ${e.reason}`);
  }
  return { failures, notes };
}

function audit(args) {
  // npm audit exits 1 when it finds something; the JSON on stdout is what matters.
  try {
    return JSON.parse(execFileSync("npm", ["audit", "--json", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    if (e?.stdout) return JSON.parse(String(e.stdout));
    throw e;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { failures, notes } = evaluate(audit([]), audit(["--omit=dev"]), ALLOWLIST, new Date().toISOString().slice(0, 10));
  for (const n of notes) console.log(`note: ${n}`);
  for (const f of failures) console.log(`::error::${f}`);
  if (failures.length) process.exit(1);
  console.log("Dependency advisories: production tree clean at moderate; dev tree clean at high apart from the allowances above.");
}
