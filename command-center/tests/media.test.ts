import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The module is `server-only`; in a test runner that guard has no meaning.
vi.mock("server-only", () => ({}));

// The routes talk to Supabase as the signed-in user; each test sets what the
// database answers.
const db = vi.hoisted(() => ({
  user: { id: "u-alice" } as { id: string } | null,
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: unknown }>,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  row: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => db.user,
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.calls.push({ fn, args });
      const h = db.rpc[fn];
      return h ? { data: null, error: null, ...h(args) } : { data: null, error: { code: "PGRST202", message: "not found" } };
    },
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: db.row, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => {} }));

import {
  ALLOWED_MIME,
  MEDIA_VARIANTS,
  UPLOAD_ACCEPT,
  UPLOAD_REASONS,
  cleanUploadName,
  coerceAssets,
  isVariant,
  mapMediaError,
  parseMediaId,
  parseQuotaDetail,
  variantContentType,
} from "@/lib/media";
import {
  MEDIA_URL_MAX_TTL_S,
  assetFilePath,
  mediaUrlSecret,
  parseRange,
  receiveUpload,
  signMedia,
  signedMediaPath,
  stagedUploadPath,
  verifyMedia,
  withUrls,
} from "@/lib/server/media";

const MIGRATIONS = join(__dirname, "..", "..", "supabase/migrations");
const SQL_0038 = readFileSync(join(MIGRATIONS, "0038_media_assets.sql"), "utf8");
const SQL_0044 = readFileSync(join(MIGRATIONS, "0044_media_heic.sql"), "utf8");
/** The LATEST definition of a function: 0044 redefines the type helpers, 0038 has the rest. */
function latestFunctionBody(name: string): string {
  const src = SQL_0044.includes(`function public.${name}(`) ? SQL_0044 : SQL_0038;
  return src.split(`function public.${name}(`, 2)[1].split("$$;", 1)[0];
}
const SECRET = Buffer.from("s".repeat(48));
const ID = "3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const NOW = 1_800_000_000;

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(typeof x === "string" ? new TextEncoder().encode(x) : x);
      c.close();
    },
  });
}

function query(path: string) {
  const u = new URL(`https://x${path}`);
  const [, , , , id, variant] = u.pathname.split("/");
  return { id, variant, mime: u.searchParams.get("t"), exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") };
}

describe("ids never become arbitrary paths", () => {
  it("accepts canonical lower-case uuids only", () => {
    expect(parseMediaId(ID)).toBe(ID);
    for (const bad of ["../x", ID.toUpperCase(), `${ID}/..`, `${ID}\u0000`, "", null, 7, `../${ID}`, ID.replace(/-/g, "")])
      expect(parseMediaId(bad), String(bad)).toBeNull();
  });

  it("builds <dir>/<aa>/<uuid>/<fixed name> and nothing else", () => {
    expect(assetFilePath("/data/media", ID, "original")).toBe(`/data/media/3f/${ID}/original`);
    expect(assetFilePath("/data/media/", ID, "thumb")).toBe(`/data/media/3f/${ID}/thumb.jpg`);
    expect(assetFilePath("/data/media", ID, "proxy")).toBe(`/data/media/3f/${ID}/proxy.mp4`);
    expect(assetFilePath("/data/media", "../../etc/passwd", "original")).toBeNull();
    expect(assetFilePath("/data/media", ID, "../../../etc/passwd")).toBeNull();
    expect(assetFilePath("/data/../etc", ID, "original")).toBeNull();
    expect(assetFilePath("relative", ID, "original")).toBeNull();
    expect(stagedUploadPath("/data/staging", ID)).toBe(`/data/staging/${ID}.upload`);
    expect(stagedUploadPath("/data/staging", "../../evil.mp4")).toBeNull();
    expect(stagedUploadPath("/data/staging", `${ID}\u0000.mp4`)).toBeNull();
  });

  it("keeps only a label of the browser's filename: no directories, no NUL", () => {
    expect(cleanUploadName("../../etc/passwd")).toBe("passwd");
    expect(cleanUploadName("..\\..\\win\\clip.mp4")).toBe("clip.mp4");
    expect(cleanUploadName("a\u0000b\u0007c.png")).toBe("abc.png");
    expect(cleanUploadName("..")).toBe("upload");
    expect(cleanUploadName(undefined)).toBe("upload");
    expect(cleanUploadName("x".repeat(500))).toHaveLength(200);
  });
});

describe("signed media links", () => {
  it("refuses a missing or short secret instead of signing with it", () => {
    expect(mediaUrlSecret("")).toBeNull();
    expect(mediaUrlSecret("short")).toBeNull();
    expect(mediaUrlSecret("k".repeat(31))).toBeNull();
    expect(mediaUrlSecret("k".repeat(32))).not.toBeNull();
  });

  it("verifies a fresh link and refuses it once expired", () => {
    const q = query(signedMediaPath(SECRET, ID, "thumb", "video/mp4", NOW, 600));
    expect(verifyMedia(SECRET, q, NOW)).toBe("ok");
    expect(verifyMedia(SECRET, q, NOW + 599)).toBe("ok");
    expect(verifyMedia(SECRET, q, NOW + 600)).toBe("expired");
  });

  it("is bound to the asset, the variant, the type and the expiry", () => {
    const q = query(signedMediaPath(SECRET, ID, "original", "video/mp4", NOW, 600));
    expect(verifyMedia(SECRET, { ...q, id: OTHER }, NOW)).toBe("bad_signature");
    expect(verifyMedia(SECRET, { ...q, variant: "proxy" }, NOW)).toBe("bad_signature");
    expect(verifyMedia(SECRET, { ...q, mime: "image/png" }, NOW)).toBe("bad_signature");
    expect(verifyMedia(SECRET, { ...q, exp: String(Number(q.exp) + 3000) }, NOW)).toBe("bad_signature");
    expect(verifyMedia(SECRET, { ...q, sig: `${q.sig}A` }, NOW)).toBe("bad_signature");
    expect(verifyMedia(SECRET, { ...q, sig: "" }, NOW)).toBe("bad_signature");
    expect(verifyMedia(Buffer.from("t".repeat(48)), q, NOW)).toBe("bad_signature");
    // An expired link that was also tampered with says "bad signature", not "expired".
    expect(verifyMedia(SECRET, { ...q, id: OTHER }, NOW + 10_000)).toBe("bad_signature");
  });

  it("refuses a validly signed link that reaches past the one-hour ceiling", () => {
    const exp = NOW + MEDIA_URL_MAX_TTL_S + 3600;
    const sig = signMedia(SECRET, ID, "original", "video/mp4", exp);
    expect(verifyMedia(SECRET, { id: ID, variant: "original", mime: "video/mp4", exp: String(exp), sig }, NOW)).toBe(
      "bad_request",
    );
    // The signer itself never mints one.
    const q = query(signedMediaPath(SECRET, ID, "original", "video/mp4", NOW, 999_999));
    expect(Number(q.exp) - NOW).toBe(MEDIA_URL_MAX_TTL_S);
  });

  it("refuses malformed links before touching a file", () => {
    const q = query(signedMediaPath(SECRET, ID, "original", "video/mp4", NOW));
    expect(verifyMedia(SECRET, { ...q, id: "../../etc" }, NOW)).toBe("bad_request");
    expect(verifyMedia(SECRET, { ...q, variant: "secret" }, NOW)).toBe("bad_request");
    expect(verifyMedia(SECRET, { ...q, mime: "text/html" }, NOW)).toBe("bad_request");
    expect(verifyMedia(SECRET, { ...q, exp: "1e12" }, NOW)).toBe("bad_request");
    expect(verifyMedia(SECRET, { ...q, sig: null }, NOW)).toBe("bad_request");
  });

  it("never serves an allowed file as something a browser would run", () => {
    expect(variantContentType("original", "text/html")).toBeNull();
    expect(variantContentType("original", "image/svg+xml")).toBeNull();
    expect(variantContentType("original", "application/x-subrip")).toBe("text/plain; charset=utf-8");
    expect(variantContentType("thumb", "video/mp4")).toBe("image/jpeg");
    expect(variantContentType("proxy", "video/quicktime")).toBe("video/mp4");
  });
});

describe("the link a browser opens (viewUrl)", () => {
  const base = { id: ID, bytes: 100, width: 100, height: 50, durationS: null, source: "upload" as const, name: "IMG_1.HEIC", version: 1, createdAt: null };
  const heic = { ...base, kind: "image" as const, mime: "image/heic" };

  function variantOf(url: string | null): string | null {
    return url ? (url.split("?")[0].split("/").pop() ?? null) : null;
  }

  it("prefers the JPEG display copy for a HEIC and shows its thumbnail", () => {
    const a = withUrls({ ...heic, variants: ["thumb", "display"] }, SECRET, true, NOW);
    expect(variantOf(a.viewUrl)).toBe("display");
    expect(variantOf(a.thumbUrl)).toBe("thumb");
  });

  it("offers nothing for a HEIC without a display copy, never the original", () => {
    for (const variants of [[], ["thumb"]] as const) {
      const a = withUrls({ ...heic, mime: "image/heif", variants: [...variants] }, SECRET, true, NOW);
      expect(a.viewUrl).toBeNull();
    }
    // and no thumbnail is invented when the file is not there
    expect(withUrls({ ...heic, variants: [] }, SECRET, true, NOW).thumbUrl).toBeNull();
  });

  it("is unchanged for everything else", () => {
    const png = withUrls({ ...base, kind: "image", mime: "image/png", variants: ["thumb"] }, SECRET, true, NOW);
    expect(variantOf(png.viewUrl)).toBe("original");
    const video = withUrls({ ...base, kind: "video", mime: "video/mp4", variants: ["thumb", "proxy"] }, SECRET, true, NOW);
    expect(variantOf(video.viewUrl)).toBe("proxy");
    const audio = withUrls({ ...base, kind: "audio", mime: "audio/mpeg", variants: [] }, SECRET, true, NOW);
    expect(variantOf(audio.viewUrl)).toBe("original");
  });

  it("links nothing when this host cannot serve files", () => {
    expect(withUrls({ ...heic, variants: ["thumb", "display"] }, SECRET, false, NOW)).toMatchObject({ thumbUrl: null, viewUrl: null });
    expect(withUrls({ ...heic, variants: ["thumb", "display"] }, null, true, NOW)).toMatchObject({ thumbUrl: null, viewUrl: null });
  });
});

describe("ranges", () => {
  it("parses what a <video> element sends", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=5-1", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
  });
});

describe("receiving an upload", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "media-rx-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes exactly the body when it fits", async () => {
    const dest = join(dir, `${ID}.upload`);
    expect(await receiveUpload(streamOf("hello ", "world"), dest, 11)).toEqual({ ok: true, bytes: 11 });
    expect(readFileSync(dest, "utf8")).toBe("hello world");
  });

  it("stops at the declared size and leaves nothing behind", async () => {
    const dest = join(dir, `${ID}.upload`);
    const out = await receiveUpload(streamOf("a".repeat(8), "b".repeat(8)), dest, 10);
    expect(out).toMatchObject({ ok: false, reason: "too_large" });
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses an empty body", async () => {
    const dest = join(dir, `${ID}.upload`);
    expect(await receiveUpload(streamOf(), dest, 10)).toMatchObject({ ok: false, reason: "empty" });
    expect(await receiveUpload(null, dest, 10)).toMatchObject({ ok: false, reason: "empty" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("never writes over a file that is already there (a second writer)", async () => {
    const dest = join(dir, `${ID}.upload`);
    writeFileSync(dest, "first");
    expect(await receiveUpload(streamOf("second"), dest, 10)).toMatchObject({ ok: false, reason: "write_failed" });
    expect(readFileSync(dest, "utf8")).toBe("first");
  });

  it("drops a half-received body when the client goes away", async () => {
    const dest = join(dir, `${ID}.upload`);
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("partial"));
        c.error(new Error("socket hang up"));
      },
    });
    expect(await receiveUpload(broken, dest, 100)).toMatchObject({ ok: false, reason: "client_aborted" });
    expect(existsSync(dest)).toBe(false);
  });
});

describe("errors and rows", () => {
  it("maps the database's refusals to words", () => {
    expect(mapMediaError({ code: "NS415", details: "reason=unsupported_type" })).toEqual({ error: "unsupported_type", status: 415 });
    expect(mapMediaError({ code: "NS415", details: "reason=extension_mismatch" })).toEqual({ error: "extension_mismatch", status: 415 });
    expect(mapMediaError({ code: "NS413" }).error).toBe("too_large");
    expect(mapMediaError({ code: "NS429" }).error).toBe("too_many_uploads");
    expect(mapMediaError({ code: "NS507" }).error).toBe("quota_exceeded");
    expect(mapMediaError({ code: "NS507", details: "reason=server_full" }).error).toBe("server_full");
    expect(mapMediaError({ code: "42501" }).status).toBe(403);
    expect(mapMediaError({ code: "P0002" }).status).toBe(404);
    expect(mapMediaError({ code: "PGRST202" }).error).toBe("not_available");
    expect(parseQuotaDetail("used=10 pending=5 limit=100 requested=90")).toEqual({ used: 10, pending: 5, limit: 100, requested: 90 });
    expect(parseQuotaDetail("nonsense")).toBeNull();
  });

  it("drops rows that are not assets", () => {
    const rows = coerceAssets([
      { id: ID, kind: "video", mime: "video/mp4", bytes: "100", variants: ["thumb", "../x"], source: "upload" },
      { id: "../x", kind: "video", mime: "video/mp4", bytes: 1 },
      { id: OTHER, kind: "program", mime: "application/x-msdownload", bytes: 1 },
    ]);
    expect(rows.map((r) => r.id)).toEqual([ID]);
    expect(rows[0].variants).toEqual(["thumb"]);
  });

  it("mirrors the SQL allowlist exactly", () => {
    const body = latestFunctionBody("media_mime_kind");
    const sqlKinds = Object.fromEntries([...body.matchAll(/when '([^']+)' then '([^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(sqlKinds).toEqual(ALLOWED_MIME);
    expect(latestFunctionBody("media_mime_kind")).toContain("when 'image/heic' then 'image'");
    expect(latestFunctionBody("media_ext_mime")).toContain("when 'heif' then 'image/heif'");
  });

  it("offers HEIC / HEIF in the file picker by extension and by type (iOS keeps the original)", () => {
    const tokens = UPLOAD_ACCEPT.split(",");
    for (const t of [".heic", ".heif", "image/heic", "image/heif"]) expect(tokens, t).toContain(t);
    // Everything the picker names by extension is something the SQL knows.
    const sqlExt = new Set(
      [...latestFunctionBody("media_ext_mime").matchAll(/when '([^']+)' then/g)].map((m) => `.${m[1]}`),
    );
    for (const t of tokens.filter((x) => x.startsWith("."))) expect(sqlExt.has(t), t).toBe(true);
    // Never something a browser would run.
    expect(tokens).not.toContain(".svg");
    expect(tokens).not.toContain("image/avif");
  });

  it("has a `display` variant, served as a JPEG, and a reason for a server without the decoder", () => {
    expect(MEDIA_VARIANTS).toContain("display");
    expect(isVariant("display")).toBe(true);
    expect(isVariant("display.jpg")).toBe(false);
    expect(variantContentType("display", "image/heic")).toBe("image/jpeg");
    expect(UPLOAD_REASONS).toContain("heic_unavailable");
    expect(SQL_0044).toContain("array['thumb', 'proxy', 'display']");
    expect(coerceAssets([{ id: ID, kind: "image", mime: "image/heic", bytes: 5, variants: ["thumb", "display", "zip"] }])[0].variants).toEqual([
      "thumb",
      "display",
    ]);
  });

  it("maps a signed `display` file to the worker's fixed name and nothing else", () => {
    expect(assetFilePath("/media", ID, "display")).toBe(`/media/${ID.slice(0, 2)}/${ID}/display.jpg`);
    expect(assetFilePath("/media", ID, "display.jpg")).toBeNull();
    const path = signedMediaPath(SECRET, ID, "display", "image/heic", NOW);
    expect(verifyMedia(SECRET, query(path), NOW)).toBe("ok");
    // bound to its variant: the same signature does not open the original
    expect(verifyMedia(SECRET, { ...query(path), variant: "original" }, NOW)).toBe("bad_signature");
  });
});

// ── routes ──────────────────────────────────────────────────────────────────

describe("GET /api/media/file/[id]/[variant]", () => {
  let media: string;
  beforeEach(() => {
    media = mkdtempSync(join(tmpdir(), "media-srv-"));
    mkdirSync(join(media, ID.slice(0, 2), ID), { recursive: true });
    writeFileSync(join(media, ID.slice(0, 2), ID, "original"), "0123456789");
    vi.stubEnv("NIGHTSHIFT_MEDIA_DIR", media);
    vi.stubEnv("MEDIA_URL_SECRET", SECRET.toString());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(media, { recursive: true, force: true });
  });

  async function get(path: string, headers: Record<string, string> = {}) {
    const { GET } = await import("@/app/api/media/file/[id]/[variant]/route");
    const q = query(path);
    return GET(new Request(`https://x${path}`, { headers }), { params: Promise.resolve({ id: q.id, variant: q.variant }) });
  }

  it("serves a validly signed file with safe headers", async () => {
    const res = await get(signedMediaPath(SECRET, ID, "original", "video/mp4"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("answers a range request with 206", async () => {
    const res = await get(signedMediaPath(SECRET, ID, "original", "video/mp4"), { range: "bytes=2-5" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
  });

  it("refuses a tampered, expired or malformed link", async () => {
    const good = signedMediaPath(SECRET, ID, "original", "video/mp4");
    expect((await get(good.replace(`/${ID}/`, `/${OTHER}/`))).status).toBe(403);
    expect((await get(good.replace("sig=", "sig=x"))).status).toBe(403);
    const old = signedMediaPath(SECRET, ID, "original", "video/mp4", Math.floor(Date.now() / 1000) - 7200, 600);
    expect((await get(old)).status).toBe(410);
    expect((await get(good.replace(`/${ID}/`, "/..%2F..%2Fetc/"))).status).toBe(400);
  });

  it("says gone when the asset's files were purged", async () => {
    const res = await get(signedMediaPath(SECRET, OTHER, "original", "video/mp4"));
    expect(res.status).toBe(410);
  });

  it("serves nothing without a signing key", async () => {
    vi.stubEnv("MEDIA_URL_SECRET", "");
    const res = await get(signedMediaPath(SECRET, ID, "original", "video/mp4"));
    expect(res.status).toBe(503);
  });
});

describe("PUT /api/media/uploads/[ticket]", () => {
  let staging: string;
  beforeEach(() => {
    staging = mkdtempSync(join(tmpdir(), "media-stg-"));
    vi.stubEnv("NIGHTSHIFT_MEDIA_STAGING_DIR", staging);
    db.user = { id: "u-alice" };
    db.calls = [];
    db.rpc = {
      begin_upload_receive: () => ({ data: { ok: true, status: "receiving", max_bytes: 8 } }),
      finish_upload_receive: (a) => ({ data: a.p_ok ? "uploaded" : "rejected" }),
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(staging, { recursive: true, force: true });
  });

  async function put(ticket: string, body: string, headers: Record<string, string> = {}) {
    const { PUT } = await import("@/app/api/media/uploads/[ticket]/route");
    return PUT(new Request(`https://x/api/media/uploads/${ticket}`, { method: "PUT", body, headers, duplex: "half" } as RequestInit), {
      params: Promise.resolve({ ticket }),
    });
  }

  it("writes the body under the ticket id and marks it uploaded", async () => {
    const res = await put(ID, "12345678");
    expect(res.status).toBe(200);
    expect(readFileSync(join(staging, `${ID}.upload`), "utf8")).toBe("12345678");
    expect(db.calls.map((c) => c.fn)).toEqual(["begin_upload_receive", "finish_upload_receive"]);
    expect(db.calls[1].args).toMatchObject({ p_ticket: ID, p_bytes: 8, p_ok: true });
  });

  it("refuses more than the ticket declared and keeps nothing", async () => {
    const res = await put(ID, "123456789");
    expect(res.status).toBe(413);
    expect(readdirSync(staging)).toEqual([]);
    expect(db.calls[1].args).toMatchObject({ p_ok: false, p_reason: "too_large" });
  });

  it("refuses an oversize Content-Length before reading", async () => {
    const res = await put(ID, "1", { "content-length": "999" });
    expect(res.status).toBe(413);
    expect(readdirSync(staging)).toEqual([]);
  });

  it("refuses a ticket that is someone else's, used or unknown", async () => {
    db.rpc.begin_upload_receive = () => ({ error: { code: "P0002", message: "no such upload" } });
    expect((await put(ID, "1")).status).toBe(404);
    db.rpc.begin_upload_receive = () => ({ data: { ok: false, status: "receiving" } });
    expect((await put(ID, "1")).status).toBe(409);
    expect(readdirSync(staging)).toEqual([]);
  });

  it("refuses a traversal ticket and an anonymous caller", async () => {
    expect((await put("..%2F..%2Fetc%2Fpasswd", "1")).status).toBe(400);
    db.user = null;
    expect((await put(ID, "1")).status).toBe(401);
    expect(db.calls).toEqual([]);
  });
});

describe("POST /api/media/uploads", () => {
  let dirs: string;
  beforeEach(() => {
    dirs = mkdtempSync(join(tmpdir(), "media-post-"));
    mkdirSync(join(dirs, "m"));
    mkdirSync(join(dirs, "s"));
    vi.stubEnv("NIGHTSHIFT_MEDIA_DIR", join(dirs, "m"));
    vi.stubEnv("NIGHTSHIFT_MEDIA_STAGING_DIR", join(dirs, "s"));
    db.user = { id: "u-alice" };
    db.calls = [];
    db.rpc = { request_upload: () => ({ data: { ticket: ID, kind: "video", mime: "video/mp4", max_bytes: 5 } }) };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dirs, { recursive: true, force: true });
  });

  async function post(body: unknown) {
    const { POST } = await import("@/app/api/media/uploads/route");
    return POST(new Request("https://x/api/media/uploads", { method: "POST", body: JSON.stringify(body) }));
  }

  it("sends a cleaned label, never a path, to request_upload", async () => {
    const res = await post({ org_id: OTHER, filename: "../../etc/pa\u0000sswd.mp4", mime: "video/mp4", bytes: 5 });
    expect(res.status).toBe(200);
    expect(db.calls[0].args).toMatchObject({ p_org: OTHER, p_filename: "passwd.mp4", p_bytes: 5 });
    expect(await res.json()).toMatchObject({ ticket: ID, upload_url: `/api/media/uploads/${ID}` });
  });

  it("passes the quota refusal through with its numbers", async () => {
    db.rpc.request_upload = () => ({ error: { code: "NS507", details: "used=90 pending=5 limit=100 requested=10" } });
    const res = await post({ org_id: OTHER, filename: "a.mp4", mime: "video/mp4", bytes: 10 });
    expect(res.status).toBe(507);
    expect(await res.json()).toMatchObject({ error: "quota_exceeded", quota: { used: 90, limit: 100 } });
  });

  it("refuses bad input before the database", async () => {
    expect((await post({ org_id: "x", filename: "a.mp4", mime: "video/mp4", bytes: 5 })).status).toBe(400);
    expect((await post({ org_id: OTHER, filename: "a.mp4", mime: "video/mp4", bytes: -1 })).status).toBe(400);
    expect((await post({ org_id: OTHER, filename: "a.mp4", mime: "video/mp4", bytes: 1.5 })).status).toBe(400);
    expect(db.calls).toEqual([]);
  });

  it("hands out no ticket on a host without the media volumes", async () => {
    vi.stubEnv("NIGHTSHIFT_MEDIA_STAGING_DIR", "");
    expect((await post({ org_id: OTHER, filename: "a.mp4", mime: "video/mp4", bytes: 5 })).status).toBe(503);
    expect(db.calls).toEqual([]);
  });
});

describe("GET /api/media/[id]", () => {
  beforeEach(() => {
    db.user = { id: "u-bob" };
    db.row = null;
  });

  it("is a 404 for an asset RLS does not return (another org's, or deleted)", async () => {
    const { GET } = await import("@/app/api/media/[id]/route");
    const res = await GET(new Request(`https://x/api/media/${ID}`), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(404);
  });

  it("needs a session", async () => {
    db.user = null;
    const { GET } = await import("@/app/api/media/[id]/route");
    const res = await GET(new Request(`https://x/api/media/${ID}`), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(401);
  });
});
