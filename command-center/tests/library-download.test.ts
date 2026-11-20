import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachmentDisposition,
  canRetryDownload,
  downloadFileName,
  downloadRefusal,
  exportCues,
  libraryDownloadUrl,
  parseDownloadVariant,
  previewVariantFor,
} from "@/lib/libraryDownload";

const OWN = "aaaaaaaa-1111-4222-8333-444444444444";
const OTHER_TENANT = "bbbbbbbb-1111-4222-8333-444444444444";
const NO_PROXY = "cccccccc-1111-4222-8333-444444444444";
const PURGED = "dddddddd-1111-4222-8333-444444444444";
const SECRET = "s".repeat(48);

const h = vi.hoisted(() => ({
  user: { id: "u-1" } as { id: string } | null,
  rows: {} as Record<string, Record<string, unknown>>,
  captions: {} as Record<string, unknown>,
  captionsError: null as null | { message: string },
  rpc: vi.fn(),
  writes: vi.fn(),
  from: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({ from: h.from, rpc: h.rpc }),
}));

/**
 * A stand-in for PostgREST under RLS: `media_assets` returns only the caller's
 * own organization's rows (another tenant's id reads as no row, which is what
 * RLS does), and every write method is a spy that must never be called.
 */
function table(name: string) {
  const filters: Record<string, unknown> = {};
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => {
      filters[col] = v;
      return q;
    },
    order: () => q,
    limit: () => q,
    insert: (...a: unknown[]) => h.writes(name, "insert", ...a),
    update: (...a: unknown[]) => h.writes(name, "update", ...a),
    upsert: (...a: unknown[]) => h.writes(name, "upsert", ...a),
    delete: (...a: unknown[]) => h.writes(name, "delete", ...a),
    maybeSingle: async () => {
      if (name === "media_assets") return { data: h.rows[String(filters.id)] ?? null, error: null };
      if (name === "editor_exports") {
        if (h.captionsError) return { data: null, error: h.captionsError };
        const c = h.captions[String(filters.asset_id)];
        return { data: c === undefined ? null : { captions: c }, error: null };
      }
      return { data: null, error: null };
    },
  };
  return q;
}

const { GET } = await import("../app/api/library/[asset]/download/route");
const { verifyMedia, mediaUrlSecret } = await import("../lib/server/media");

const media = mkdtempSync(join(tmpdir(), "ns-media-"));
const ORIGINAL_BYTES = Buffer.alloc(4096, 7);
const PROXY_BYTES = Buffer.alloc(512, 3);

function put(id: string, files: Record<string, Buffer>) {
  const d = join(media, id.slice(0, 2), id);
  mkdirSync(d, { recursive: true });
  for (const [n, b] of Object.entries(files)) writeFileSync(join(d, n), b);
}
put(OWN, { original: ORIGINAL_BYTES, "proxy.mp4": PROXY_BYTES, "thumb.jpg": Buffer.from([1]) });
put(OTHER_TENANT, { original: ORIGINAL_BYTES, "proxy.mp4": PROXY_BYTES });
put(NO_PROXY, { original: ORIGINAL_BYTES });

function row(id: string, variants: string[], extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "video",
    mime: "video/mp4",
    bytes: 4096,
    width: 1920,
    height: 1080,
    duration_s: 12,
    source: "render",
    original_name: "export.mp4",
    variants,
    version: 1,
    created_at: "2026-11-20T10:00:00Z",
    ...extra,
  };
}

function get(id: string, variant: string | null, headers: Record<string, string> = {}) {
  const q = variant === null ? "" : `?variant=${variant}`;
  return GET(new Request(`https://nightshift.test/api/library/${id}/download${q}`, { headers }), {
    params: Promise.resolve({ asset: id }),
  });
}

beforeEach(() => {
  process.env.NIGHTSHIFT_MEDIA_DIR = media;
  process.env.MEDIA_URL_SECRET = SECRET;
  h.user = { id: "u-1" };
  h.rows = {
    [OWN]: row(OWN, ["thumb", "proxy"]),
    [NO_PROXY]: row(NO_PROXY, ["thumb"]),
    [PURGED]: row(PURGED, ["thumb", "proxy"]),
  };
  h.captions = {};
  h.captionsError = null;
  h.rpc.mockReset();
  h.writes.mockReset();
  h.from.mockReset().mockImplementation((name: string) => table(name));
});
afterEach(() => vi.useRealTimers());
afterAll(() => rmSync(media, { recursive: true, force: true }));

// ── the address ─────────────────────────────────────────────────────────────

describe("original and preview are never the same address", () => {
  it("two different URLs for the same asset, and nothing but a canonical id builds one", () => {
    const o = libraryDownloadUrl(OWN, "original");
    const p = libraryDownloadUrl(OWN, "preview");
    expect(o).toBe(`/api/library/${OWN}/download?variant=original`);
    expect(p).toBe(`/api/library/${OWN}/download?variant=preview`);
    expect(o).not.toBe(p);
    expect(libraryDownloadUrl("../etc/passwd", "original")).toBeNull();
    expect(libraryDownloadUrl(OWN.toUpperCase(), "original")).toBeNull();
  });

  it("a video's preview is its proxy, and a video without one has no preview (never the original instead)", () => {
    expect(previewVariantFor({ kind: "video", variants: ["thumb", "proxy"] })).toBe("proxy");
    expect(previewVariantFor({ kind: "video", variants: ["thumb"] })).toBeNull();
    expect(previewVariantFor({ kind: "image", variants: ["thumb"] })).toBeNull();
    expect(previewVariantFor({ kind: "image", variants: ["display"] })).toBe("display");
    expect(previewVariantFor({ kind: "caption", variants: [] })).toBeNull();
  });

  it("only the three variants are understood", () => {
    expect(parseDownloadVariant("original")).toBe("original");
    expect(parseDownloadVariant("proxy")).toBeNull();
    expect(parseDownloadVariant(null)).toBeNull();
  });

  it("the saved name says the frame size and the real type; a hostile name cannot break the header", () => {
    expect(downloadFileName({ id: OWN, name: "export.mp4", mime: "video/mp4", width: 1080, height: 1920 })).toBe(
      "export 1080x1920.mp4",
    );
    const d = attachmentDisposition(downloadFileName({ id: OWN, name: 'a"b\r\n;c.mp4', mime: "video/mp4", width: null, height: null }));
    expect(d).not.toMatch(/[\r\n]/);
    expect(d.startsWith('attachment; filename="')).toBe(true);
  });

  it("refusals are words the panel knows; only a transient failure offers Try again", () => {
    expect(downloadRefusal(401, "unauthorized")).toBe("unauthorized");
    expect(downloadRefusal(410, "gone")).toBe("gone");
    expect(downloadRefusal(404, "whatever")).toBe("not_found");
    expect(downloadRefusal(500, undefined)).toBe("failed");
    expect(canRetryDownload("failed")).toBe(true);
    expect(canRetryDownload("gone")).toBe(false);
  });

  it("captions: only well-formed cues are kept", () => {
    expect(exportCues(null)).toEqual([]);
    expect(
      exportCues({ cues: [{ id: "a", start_s: 0, end_s: 1, text: "hi" }, { start_s: 2, end_s: 1, text: "bad" }, "x"] }),
    ).toEqual([{ id: "a", start_s: 0, end_s: 1, text: "hi" }]);
  });
});

// ── who may download ─────────────────────────────────────────────────────────

describe("who may download", () => {
  it("signed out: 401, and nothing is read", async () => {
    h.user = null;
    for (const v of ["original", "preview", "captions"]) {
      const res = await get(OWN, v);
      expect(res.status).toBe(401);
    }
    expect(h.from).not.toHaveBeenCalled();
  });

  it("another organization's asset is a 404, the same answer as a made-up id: its file is never streamed", async () => {
    for (const v of ["original", "preview", "captions"]) {
      const res = await get(OTHER_TENANT, v);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("a path, a non-canonical id or an unknown variant is a 400 before the database is asked", async () => {
    for (const [id, v] of [
      ["..%2F..%2Fetc", "original"],
      [OWN, "proxy"],
      [OWN, null],
    ] as const) {
      expect((await get(id, v)).status).toBe(400);
    }
    expect(h.from).not.toHaveBeenCalled();
  });
});

// ── the files ─────────────────────────────────────────────────────────────────

describe("download original", () => {
  it("streams the master itself as an attachment, its real size, never cached", async () => {
    const res = await get(OWN, "original");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(ORIGINAL_BYTES.length));
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="export 1920x1080\.mp4"/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(ORIGINAL_BYTES)).toBe(true);
  });

  it("answers a range (the panel's one-byte check, a resumed download)", async () => {
    const res = await get(OWN, "original", { range: "bytes=0-0" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-0/${ORIGINAL_BYTES.length}`);
    expect((await res.arrayBuffer()).byteLength).toBe(1);
    expect((await get(OWN, "original", { range: "bytes=99999-" })).status).toBe(416);
  });

  it("a live row whose file was purged is 410 gone, not an empty file", async () => {
    const res = await get(PURGED, "original");
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "gone" });
  });

  it("a host without the media volume says so (503) instead of pretending", async () => {
    process.env.NIGHTSHIFT_MEDIA_DIR = "/nonexistent/ns-media";
    const res = await get(OWN, "original");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "media_unavailable" });
  });
});

describe("preview", () => {
  it("is a 303 to a freshly signed link of the proxy, a different file from the original", async () => {
    const res = await get(OWN, "preview");
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location") as string, "https://nightshift.test");
    expect(loc.pathname).toBe(`/api/media/file/${OWN}/proxy`);
    expect(loc.pathname).not.toContain("original");
    const verdict = verifyMedia(mediaUrlSecret() as Buffer, {
      id: OWN,
      variant: "proxy",
      mime: loc.searchParams.get("t"),
      exp: loc.searchParams.get("exp"),
      sig: loc.searchParams.get("sig"),
    });
    expect(verdict).toBe("ok");
  });

  it("a video without a proxy is 404 no_preview: the original is not served in its place", async () => {
    const res = await get(NO_PROXY, "preview");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_preview" });
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("expiry", () => {
  it("the signed link behind a preview expires; the stable address signs a new one each time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
    const first = new URL((await get(OWN, "preview")).headers.get("location") as string, "https://x.test");
    vi.setSystemTime(new Date("2026-11-20T11:00:00Z"));
    const q = (u: URL) => ({ id: OWN, variant: "proxy", mime: u.searchParams.get("t"), exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") });
    // An hour later the first link is dead...
    expect(verifyMedia(mediaUrlSecret() as Buffer, q(first))).toBe("expired");
    // ...but pressing Preview again works: a new link with a later expiry.
    const again = new URL((await get(OWN, "preview")).headers.get("location") as string, "https://x.test");
    expect(Number(again.searchParams.get("exp"))).toBeGreaterThan(Number(first.searchParams.get("exp")));
    expect(verifyMedia(mediaUrlSecret() as Buffer, q(again))).toBe("ok");
    // And the original's address carries no expiry at all: it is checked against the session every time.
    expect(libraryDownloadUrl(OWN, "original")).not.toMatch(/exp=|sig=/);
    expect((await get(OWN, "original")).status).toBe(200);
  });
});

describe("subtitles", () => {
  it("the SRT of the captions the export was rendered with", async () => {
    h.captions[OWN] = { style: {}, cues: [{ id: "1", start_s: 1.5, end_s: 3, text: "Hello" }] };
    const res = await get(OWN, "captions");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/x-subrip/);
    expect(res.headers.get("content-disposition")).toMatch(/\.srt"/);
    expect(await res.text()).toBe("1\n00:00:01,500 --> 00:00:03,000\nHello\n");
  });

  it("no captions is 404 no_captions; a failed read is 502, never 'no captions'", async () => {
    expect(await (await get(OWN, "captions")).json()).toEqual({ error: "no_captions" });
    h.captionsError = { message: "boom" };
    expect((await get(OWN, "captions")).status).toBe(502);
  });
});

describe("reading never renders", () => {
  it("polling every variant many times calls no database function and writes no row", async () => {
    for (let i = 0; i < 5; i++) for (const v of ["original", "preview", "captions"]) await get(OWN, v);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.writes).not.toHaveBeenCalled();
  });
});
