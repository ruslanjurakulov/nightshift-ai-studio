/**
 * Worker status in the UI (migration 0045): the operator's worker table on the
 * Integrations page, and the library's honest line for customers.
 *
 * Rendered to static markup against scripted Supabase answers (the approach of
 * read-failures-pages.test.ts). Pinned: a failed read is the error state with
 * Retry — never "healthy" or an empty list; silence reads "Not reporting";
 * a failure shows its reason; the library says checking is unavailable only
 * when it is down AND something is waiting, and says nothing when unknown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { EMPTY, FAILED, esc, supabaseStub, type StubResult } from "./helpers/supabaseStub";
import type { MediaLibraryData, MediaUpload } from "../lib/media";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ client: null as unknown, locale: "en" as "en" | "ru" | "uz" }));

vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/i18n/context", async () => {
  const { dictionaries, fmt } = await import("../lib/i18n");
  return {
    useI18n: () => ({ t: dictionaries[state.locale], locale: state.locale, fmt, setLocale: () => {} }),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/x/integrations" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.client,
  getUser: async () => ({ id: "u1", email: "me@example.com" }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/channels-server", async () => {
  const { unscopedScope } = await import("../lib/channels");
  const scope = unscopedScope();
  return { getChannelScope: async () => scope };
});

const NOW = Date.now();
const iso = (agoS: number) => new Date(NOW - agoS * 1000).toISOString();
const dbRow = (over: Record<string, unknown> = {}) => ({
  worker_id: "nightshift-media-01",
  kind: "media",
  state: "running",
  detail: null,
  version: null,
  started_at: iso(500),
  updated_at: iso(10),
  ...over,
});

const has = (html: string, text: string) => html.includes(esc(text));

beforeEach(() => {
  state.locale = "en";
  // The pages compute "Ns ago" from the clock at render time; freeze it at
  // NOW (Date only, timers stay real) so a slow run cannot turn 7s into 8s.
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  state.client = null;
  vi.useRealTimers();
});

async function integrations(workers: StubResult): Promise<string> {
  state.client = supabaseStub((name) => (name === "worker_status" ? workers : EMPTY));
  const page = (await import("../app/(app)/[channel]/integrations/page")).default;
  return renderToStaticMarkup(await page());
}

describe("operator: the worker table on the Integrations page", () => {
  it("shows kind, state, heartbeat age and the failure reason", async () => {
    const reason = "NIGHTSHIFT_MEDIA_DIR is not a writable directory: mount the volume and make it writable by uid 1000";
    const html = await integrations({
      data: [
        dbRow({ worker_id: "nightshift-media-01", state: "failed", detail: reason, updated_at: iso(7), version: "build-9" }),
        dbRow({ worker_id: "nightshift-creative-01", kind: "creative", state: "running", updated_at: iso(12) }),
      ],
      error: null,
    });
    expect(has(html, en.workers.title)).toBe(true);
    expect(has(html, en.workers.kinds.media)).toBe(true);
    expect(has(html, en.workers.kinds.creative)).toBe(true);
    expect(has(html, en.workers.states.failed)).toBe(true);
    expect(has(html, en.workers.states.running)).toBe(true);
    expect(has(html, reason)).toBe(true);
    expect(html).toContain("7s ago");
    expect(has(html, "Version build-9")).toBe(true);
    expect(html).not.toContain("data-read-error");
    // media is listed before creative
    expect(html.indexOf("nightshift-media-01")).toBeLessThan(html.indexOf("nightshift-creative-01"));
  });

  it("a silent worker is 'Not reporting', not running, whatever its last word was", async () => {
    const html = await integrations({ data: [dbRow({ state: "running", updated_at: iso(900) })], error: null });
    expect(has(html, en.workers.states.notReporting)).toBe(true);
    expect(has(html, en.workers.states.running)).toBe(false);
    expect(has(html, en.workers.hint)).toBe(true);
    expect(html).toContain('data-worker-state="notReporting"');
  });

  it("a failed read is the error state with Retry — not healthy, not empty", async () => {
    const html = await integrations(FAILED);
    expect(html).toContain("data-read-error");
    expect(has(html, en.common.retry)).toBe(true);
    expect(has(html, en.workers.empty)).toBe(false);
    expect(has(html, en.workers.states.running)).toBe(false);
    expect(has(html, en.workers.notEnabled)).toBe(false);
  });

  it("a permission error is a failed read too (not 'not enabled')", async () => {
    const html = await integrations({ data: null, error: { code: "42501", message: "permission denied for table worker_status" } });
    expect(html).toContain("data-read-error");
    expect(has(html, en.workers.notEnabled)).toBe(false);
  });

  it("the migration missing degrades honestly", async () => {
    const html = await integrations({ data: null, error: { code: "42P01", message: 'relation "public.worker_status" does not exist' } });
    expect(has(html, en.workers.notEnabled)).toBe(true);
    expect(html).not.toContain("data-read-error");
  });

  it("readable but empty says no worker has reported — and is not an error", async () => {
    const html = await integrations(EMPTY);
    expect(has(html, en.workers.empty)).toBe(true);
    expect(html).not.toContain("data-read-error");
  });

  it("is translated: the Russian and Uzbek panels use their own words", async () => {
    for (const [locale, d] of [["ru", ru], ["uz", uz]] as const) {
      state.locale = locale;
      const html = await integrations({ data: [dbRow({ state: "failed", detail: "reason text" })], error: null });
      expect(has(html, d.workers.title)).toBe(true);
      expect(has(html, d.workers.states.failed)).toBe(true);
      expect(has(html, en.workers.title)).toBe(false);
    }
  });

  it("the table is read for every row it holds (no channel scoping on a global table)", async () => {
    let seen = "";
    state.client = {
      from: (table: string) => {
        seen += table + ",";
        return supabaseStub(() => EMPTY).from(table);
      },
    };
    const page = (await import("../app/(app)/[channel]/integrations/page")).default;
    renderToStaticMarkup(await page());
    expect(seen).toContain("worker_status");
  });
});

// ── the customer's library ──────────────────────────────────────────────────

const upload = (status: MediaUpload["status"], id = status): MediaUpload =>
  ({ id, name: `${id}.png`, status, reason: null, bytes: 1000, receivedBytes: 1000, assetId: null, createdAt: iso(60) }) as unknown as MediaUpload;

const lib = (uploads: MediaUpload[], pipeline?: MediaLibraryData["pipeline"]): MediaLibraryData => ({
  available: true,
  host: { media: true, staging: true, signing: true },
  assets: [],
  uploads,
  quota: { usedBytes: 0, limitBytes: 1000000, maxUploadBytes: 100000 },
  ...(pipeline ? { pipeline } : {}),
});

async function library(data: MediaLibraryData): Promise<string> {
  const { MediaLibrary } = await import("../components/media/MediaLibrary");
  return renderToStaticMarkup(createElement(MediaLibrary, { orgId: "00000000-0000-4000-8000-000000000001", initial: data }));
}

describe("customer: the library tells the truth when file checking is down", () => {
  for (const s of ["stale", "failed"] as const) {
    it(`${s} + a waiting upload: the honest line replaces 'waiting for the server'`, async () => {
      const html = await library(lib([upload("uploaded")], { state: s, ageSeconds: 400 }));
      expect(html).toContain("data-pipeline-down");
      expect(has(html, en.media.pipelineDown)).toBe(true);
      expect(has(html, en.media.status.paused)).toBe(true);
      expect(has(html, en.media.status.uploaded)).toBe(false);
    });
  }

  it("a claimed ticket nobody is finishing is not 'checking the file' while checking is down", async () => {
    const html = await library(lib([upload("ingesting")], { state: "stale", ageSeconds: 400 }));
    expect(has(html, en.media.pipelineDown)).toBe(true);
    expect(has(html, en.media.status.ingesting)).toBe(false);
  });

  it("down but nothing is waiting: no banner (nothing to apologise for)", async () => {
    const html = await library(lib([upload("rejected"), upload("expired"), upload("receiving")], { state: "failed", ageSeconds: 3 }));
    expect(html).not.toContain("data-pipeline-down");
    expect(has(html, en.media.pipelineDown)).toBe(false);
    expect(has(html, en.media.status.receiving)).toBe(true);
  });

  it("ok keeps the normal wording", async () => {
    const html = await library(lib([upload("uploaded")], { state: "ok", ageSeconds: 5 }));
    expect(html).not.toContain("data-pipeline-down");
    expect(has(html, en.media.status.uploaded)).toBe(true);
    expect(has(html, en.media.status.paused)).toBe(false);
  });

  it("unknown (migration missing, read failed, nothing ever reported) shows nothing misleading", async () => {
    for (const pipeline of [{ state: "unknown", ageSeconds: null } as const, undefined]) {
      const html = await library(lib([upload("uploaded")], pipeline));
      expect(html).not.toContain("data-pipeline-down");
      expect(has(html, en.media.pipelineDown)).toBe(false);
      expect(has(html, en.media.status.uploaded)).toBe(true); // the plain, pre-0045 wording; no claim either way
    }
  });

  it("the line exists in Russian and Uzbek", async () => {
    for (const [locale, d] of [["ru", ru], ["uz", uz]] as const) {
      state.locale = locale;
      const html = await library(lib([upload("uploaded")], { state: "stale", ageSeconds: 400 }));
      expect(has(html, d.media.pipelineDown)).toBe(true);
      expect(has(html, en.media.pipelineDown)).toBe(false);
    }
  });
});

describe("loadMediaLibrary: the pipeline state comes from media_pipeline_state()", () => {
  const load = async (pipeline: StubResult) => {
    state.client = supabaseStub((name) => (name === "media_pipeline_state" ? pipeline : EMPTY));
    const { loadMediaLibrary } = await import("../lib/server/media");
    return loadMediaLibrary("00000000-0000-4000-8000-000000000001");
  };

  it("passes the database's answer through", async () => {
    const out = await load({ data: { state: "failed", age_seconds: 12 }, error: null });
    expect(out.available).toBe(true);
    expect(out.pipeline).toEqual({ state: "failed", ageSeconds: 12 });
  });

  it("a missing function or a failed call is unknown, never ok", async () => {
    for (const r of [FAILED, { data: null, error: { code: "PGRST202", message: "not found" } }, { data: { state: "ok" }, error: { message: "x" } }]) {
      const out = await load(r);
      expect(out.available).toBe(true);
      expect(out.pipeline).toEqual({ state: "unknown", ageSeconds: null });
    }
  });

  it("a call that throws does not break the library", async () => {
    state.client = {
      ...supabaseStub(() => EMPTY),
      rpc: () => {
        throw new Error("network down");
      },
    };
    const { loadMediaLibrary } = await import("../lib/server/media");
    const out = await loadMediaLibrary("00000000-0000-4000-8000-000000000001");
    expect(out.available).toBe(true);
    expect(out.error).toBe("read_failed"); // the outer guard; never reported as ok checking
    expect(out.pipeline?.state).toBe("unknown");
  });
});
