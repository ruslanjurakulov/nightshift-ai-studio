/**
 * lib/visibilityRequest.ts: what the panel may say about a video's publish-when-approved request (migration 0113).
 *
 * What would break: "published" said for anything but a request the database ended as applied with a read-back of public; a
 * request of an earlier approval speaking for the current one; an expired approval read as "waiting"; an unknown word from the
 * database shown raw; the vocabulary drifting from the database's list and the worker's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  knownRetryError,
  knownVisibilityReason,
  MAX_LIFETIME_ATTEMPTS,
  parseVisibilityRow,
  RETRY_ERRORS,
  visibilityView,
  VISIBILITY_COLUMNS,
  VISIBILITY_REASONS,
  type VisibilityRequestRow,
} from "../lib/visibilityRequest";

const CUT = "ab".repeat(32);
const DECIDED = "2026-10-19T10:00:00.000Z";
const NOW = new Date("2026-10-19T12:00:00.000Z").getTime();
const VIDEO = { approved_cut_sha256: CUT, decided_at: "2026-10-19T10:00:00+00:00", review_state: "approved" };

function row(over: Partial<VisibilityRequestRow> = {}): VisibilityRequestRow {
  return {
    id: 1, status: "queued", reason: null, attempts: 0, lifetime_attempts: 0, approved_cut_sha256: CUT, decided_at: DECIDED,
    expires_at: "2026-10-20T10:00:00.000Z", next_attempt_at: DECIDED, before_privacy: null, after_privacy: null,
    finished_at: null, created_at: DECIDED, ...over,
  };
}

describe("visibilityView", () => {
  it("no request is no view", () => {
    expect(visibilityView(null, VIDEO, NOW)).toEqual({ kind: "none" });
  });

  it("published needs an applied request whose read-back said public: nothing else is ever published", () => {
    expect(visibilityView(row({ status: "applied", after_privacy: "public", finished_at: "2026-10-19T10:05:00Z" }), VIDEO, NOW))
      .toEqual({ kind: "published", at: "2026-10-19T10:05:00Z" });
    for (const after of ["private", "unlisted", null, "PUBLIC", ""]) {
      expect(visibilityView(row({ status: "applied", after_privacy: after }), VIDEO, NOW), String(after)).toEqual({ kind: "none" });
    }
    for (const status of ["queued", "refused", "failed", "expired"] as const) {
      // even with after_privacy = public on the row (it can be, for a refusal: "already public"), these are not "published"
      const v = visibilityView(row({ status, reason: status === "queued" ? null : "already_public", after_privacy: "public", finished_at: status === "queued" ? null : DECIDED }), VIDEO, NOW);
      expect(v.kind, status).not.toBe("published");
    }
  });

  it("a read-back of public is shown as what it is even when the approval on screen is another one", () => {
    const v = visibilityView(row({ status: "applied", after_privacy: "public", decided_at: "2026-10-01T10:00:00Z", finished_at: DECIDED }), VIDEO, NOW);
    expect(v.kind).toBe("published");
  });

  it("queued, refused and failed speak only for the approval they were queued for", () => {
    expect(visibilityView(row(), VIDEO, NOW).kind).toBe("queued");
    expect(visibilityView(row({ decided_at: "2026-10-18T10:00:00.000Z" }), VIDEO, NOW)).toEqual({ kind: "none" });
    expect(visibilityView(row({ approved_cut_sha256: "cd".repeat(32) }), VIDEO, NOW)).toEqual({ kind: "none" });
    expect(visibilityView(row(), { ...VIDEO, approved_cut_sha256: null }, NOW)).toEqual({ kind: "none" });
    expect(visibilityView(row(), { ...VIDEO, decided_at: null }, NOW)).toEqual({ kind: "none" });
    // the same instant written two ways is the same approval
    expect(visibilityView(row(), { ...VIDEO, decided_at: "2026-10-19T12:00:00+02:00" }, NOW).kind).toBe("queued");
  });

  it("a queued or failed request whose approval ended reads as expired, never as waiting for ever", () => {
    const past = { expires_at: "2026-10-19T11:59:59.000Z" };
    expect(visibilityView(row(past), VIDEO, NOW).kind).toBe("expired");
    expect(visibilityView(row({ ...past, status: "failed", reason: "token_expired", finished_at: DECIDED }), VIDEO, NOW).kind).toBe("expired");
    expect(visibilityView(row({ status: "expired", reason: "approval_expired", finished_at: DECIDED }), VIDEO, NOW).kind).toBe("expired");
    expect(visibilityView(row({ status: "refused", reason: "approval_expired", finished_at: DECIDED }), VIDEO, NOW).kind).toBe("expired");
  });

  it("refused carries its word; failed is retryable only while the approval holds", () => {
    expect(visibilityView(row({ status: "refused", reason: "platform_kept_private", finished_at: DECIDED }), VIDEO, NOW))
      .toEqual({ kind: "refused", reason: "platform_kept_private" });
    expect(visibilityView(row({ status: "failed", reason: "token_expired", finished_at: DECIDED }), VIDEO, NOW))
      .toEqual({ kind: "failed", reason: "token_expired", retryable: true });
    // "try again" is offered while the request is under the database's lifetime cap (migration 0113), not after it
    expect(visibilityView(row({ status: "failed", reason: "token_expired", finished_at: DECIDED, lifetime_attempts: MAX_LIFETIME_ATTEMPTS - 1 }), VIDEO, NOW))
      .toEqual({ kind: "failed", reason: "token_expired", retryable: true });
    expect(visibilityView(row({ status: "failed", reason: "token_expired", finished_at: DECIDED, lifetime_attempts: MAX_LIFETIME_ATTEMPTS }), VIDEO, NOW))
      .toEqual({ kind: "failed", reason: "token_expired", retryable: false });
    // a refusal with no known word is the worker's generic one, never a raw string
    expect(visibilityView(row({ status: "refused", reason: null, finished_at: DECIDED }), VIDEO, NOW))
      .toEqual({ kind: "refused", reason: "worker_error" });
  });

  it("queued keeps the last try's word and when it was asked", () => {
    expect(visibilityView(row({ attempts: 2, reason: "rate_limited" }), VIDEO, NOW))
      .toEqual({ kind: "queued", since: DECIDED, attempts: 2, lastReason: "rate_limited" });
  });
});

describe("parseVisibilityRow", () => {
  it("reads the closed shape and nothing else", () => {
    const raw = { id: 5, status: "refused", reason: "gate_blocked", attempts: 1, approved_cut_sha256: CUT, decided_at: DECIDED,
                  expires_at: DECIDED, finished_at: DECIDED, created_at: DECIDED, extra: "ignored" };
    expect(parseVisibilityRow(raw)).toMatchObject({ id: 5, status: "refused", reason: "gate_blocked", attempts: 1 });
    expect(parseVisibilityRow(null)).toBeNull();
    expect(parseVisibilityRow("x")).toBeNull();
    expect(parseVisibilityRow({ ...raw, status: "approved" })).toBeNull();
    expect(parseVisibilityRow({ ...raw, id: null })).toBeNull();
    expect(parseVisibilityRow({ ...raw, decided_at: 5 })).toBeNull();
  });

  it("an unknown reason is no reason (the panel then says the generic one), a missing count is zero", () => {
    const p = parseVisibilityRow({ id: "7", status: "failed", reason: "HttpError 403: secret", decided_at: DECIDED, expires_at: DECIDED });
    expect(p?.reason).toBeNull();
    expect(p?.attempts).toBe(0);
    expect(p?.id).toBe("7");
  });
});

describe("the vocabulary", () => {
  it("is the database's list and the worker's, word for word", () => {
    const repo = join(__dirname, "..", "..");
    const sql = readFileSync(join(repo, "supabase", "migrations", "0113_visibility_requests.sql"), "utf8");
    const fn = /function public\.visibility_reason_words\(\).*?select array\[(.*?)\]::text\[\]/s.exec(sql)![1];
    const sqlWords = [...fn.split("\n").map((l) => l.split("--")[0]).join("\n").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...VISIBILITY_REASONS].sort()).toEqual(sqlWords.sort());
    const py = readFileSync(join(repo, "modules", "visibility_publish.py"), "utf8");
    const block = /REASONS = \((.*?)\n\)/s.exec(py)![1];
    expect([...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...VISIBILITY_REASONS].sort());
  });

  it("knows its own words and nothing else", () => {
    for (const w of VISIBILITY_REASONS) expect(knownVisibilityReason(w)).toBe(w);
    for (const w of ["", "Quota exceeded", "gate_blocked ", null, 5, undefined, {}]) expect(knownVisibilityReason(w)).toBeNull();
    for (const w of RETRY_ERRORS) expect(knownRetryError(w)).toBe(w);
    expect(knownRetryError("ok")).toBeNull();
  });

  it("reads only the columns a member is granted (no worker internals)", () => {
    const cols = VISIBILITY_COLUMNS.split(",");
    for (const hidden of ["claimed_by", "claimed_at", "lease_until", "submitting_at"]) expect(cols).not.toContain(hidden);
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0113_visibility_requests.sql"), "utf8");
    const granted = /grant select \((.*?)\)\s+on public\.video_visibility_requests/s.exec(sql)![1].split(",").map((s) => s.trim());
    for (const c of cols) expect(granted, c).toContain(c);
  });
});
