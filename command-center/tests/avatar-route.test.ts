import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { avatarJpeg, png, webp } from "./helpers/image-bytes";

const UID = "11111111-2222-4333-8444-555555555555";

const h = vi.hoisted(() => ({
  user: { id: "11111111-2222-4333-8444-555555555555" } as { id: string } | null,
  upload: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  from: vi.fn(),
  rate: vi.fn(),
  serviceClient: vi.fn(),
  configured: true,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => (h.configured ? { storage: { from: h.from } } : null),
}));
// The real rule and refusal shapes; only the database-backed counter is replaced.
vi.mock("@/lib/server/web-rate", async () => {
  const actual = await vi.importActual<typeof import("../lib/server/web-rate")>("../lib/server/web-rate");
  return { ...actual, takeWebRate: (...a: unknown[]) => h.rate(...a) };
});
// If anything ever reached for a service-role client it would come through supabase-js.
vi.mock("@supabase/supabase-js", () => ({ createClient: (...a: unknown[]) => h.serviceClient(...a) }));

const { GET, POST, DELETE } = await import("../app/api/avatar/route");

const ORIGIN = "https://nightshift.test";
const goodHeaders = (extra: Record<string, string> = {}) => ({ origin: ORIGIN, "content-type": "image/jpeg", ...extra });
const GOOD = avatarJpeg();

function post(body: BodyInit | null = GOOD as unknown as BodyInit, headers: Record<string, string> = goodHeaders()) {
  return POST(new Request(`${ORIGIN}/api/avatar`, { method: "POST", headers, body, ...(body ? { duplex: "half" } : {}) } as RequestInit));
}
const del = (headers: Record<string, string> = { origin: ORIGIN }) => DELETE(new Request(`${ORIGIN}/api/avatar`, { method: "DELETE", headers }));
const get = () => GET();

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
}

beforeEach(() => {
  h.user = { id: UID };
  h.configured = true;
  h.rate.mockReset().mockResolvedValue("ok");
  h.upload.mockReset().mockResolvedValue({ data: { path: `${UID}/avatar.jpg` }, error: null });
  h.remove.mockReset().mockResolvedValue({ data: [], error: null });
  h.download.mockReset().mockResolvedValue({ data: new Blob([GOOD], { type: "image/jpeg" }), error: null });
  h.from.mockReset().mockImplementation(() => ({ upload: h.upload, download: h.download, remove: h.remove }));
  h.serviceClient.mockReset();
});

describe("who may call", () => {
  it("every method needs a signed-in person, and touches nothing without one", async () => {
    h.user = null;
    for (const res of [await get(), await post(), await del()]) {
      expect(res.status).toBe(401);
      expect(await json(res)).toEqual({ error: "unauthorized" });
    }
    expect(h.from).not.toHaveBeenCalled();
    expect(h.rate).not.toHaveBeenCalled();
  });

  it("POST and DELETE are our own page only: no Origin, another site's Origin or a cross-site fetch are refused", async () => {
    for (const headers of [
      { "content-type": "image/jpeg" },
      goodHeaders({ origin: "https://evil.test" }),
      goodHeaders({ origin: "null" }),
      goodHeaders({ "sec-fetch-site": "cross-site" }),
      goodHeaders({ "sec-fetch-site": "same-site" }),
    ]) {
      const res = await post(GOOD as unknown as BodyInit, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await json(res)).toEqual({ error: "forbidden" });
    }
    expect((await del({})).status).toBe(403);
    expect((await del({ origin: "https://evil.test" })).status).toBe(403);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.rate).not.toHaveBeenCalled();
  });

  it("accepts a same-origin fetch that sends Sec-Fetch-Site", async () => {
    expect((await post(GOOD as unknown as BodyInit, goodHeaders({ "sec-fetch-site": "same-origin" }))).status).toBe(200);
  });
});

describe("POST: what is accepted", () => {
  it("stores a valid JPEG at exactly <uid>/avatar.jpg in the avatars bucket and answers a version", async () => {
    const before = Date.now();
    const res = await post();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.version).toBeGreaterThanOrEqual(before);
    expect(Object.keys(body).sort()).toEqual(["ok", "version"]);
    expect(h.from).toHaveBeenCalledWith("avatars");
    expect(h.upload).toHaveBeenCalledTimes(1);
    const [path, bytes, opts] = h.upload.mock.calls[0];
    expect(path).toBe(`${UID}/avatar.jpg`);
    expect(Array.from(bytes as Uint8Array)).toEqual(Array.from(GOOD));
    expect(opts).toMatchObject({ contentType: "image/jpeg", upsert: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("builds the path from the session, whatever the request says", async () => {
    const req = new Request(`${ORIGIN}/api/avatar?v=../../other-user&uid=99999999-0000-4000-8000-000000000000&path=x/y`, {
      method: "POST",
      headers: { ...goodHeaders(), "x-user-id": "99999999-0000-4000-8000-000000000000" },
      body: GOOD as unknown as BodyInit,
    });
    expect((await POST(req)).status).toBe(200);
    expect(h.upload.mock.calls[0][0]).toBe(`${UID}/avatar.jpg`);
  });

  it("accepts the other shapes a canvas encoder writes (colour profile, no JFIF, 64 and 512 px)", async () => {
    for (const o of [{ icc: true }, { jfif: false }, { width: 64, height: 64 }, { width: 512, height: 512 }, { dht: 4, dri: true }]) {
      expect((await post(avatarJpeg(o) as unknown as BodyInit)).status, JSON.stringify(o)).toBe(200);
    }
  });

  it("never uses the service role: only the user-scoped client is created", async () => {
    await post();
    await del();
    expect(h.serviceClient).not.toHaveBeenCalled();
    const src = readFileSync(join(__dirname, "..", "app", "api", "avatar", "route.ts"), "utf8");
    expect(src).not.toMatch(/service[_-]?role|SERVICE_ROLE|SERVICE_KEY|@supabase\/supabase-js/i);
  });
});

describe("POST: what is refused (fixed codes, no storage text)", () => {
  it("another content type, or multipart, is not_jpeg (415) before anything is read or counted", async () => {
    for (const type of ["image/webp", "image/png", "multipart/form-data; boundary=x", "application/octet-stream", ""]) {
      const res = await post(GOOD as unknown as BodyInit, goodHeaders({ "content-type": type }));
      expect(res.status, type).toBe(415);
      expect(await json(res)).toEqual({ error: "not_jpeg" });
    }
    expect(h.rate).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("accepts the type with a parameter or capitals", async () => {
    expect((await post(GOOD as unknown as BodyInit, goodHeaders({ "content-type": "Image/JPEG; charset=binary" }))).status).toBe(200);
  });

  it("a declared length over 256 KB is too_large (413) without reading the body or counting the try", async () => {
    const res = await post(GOOD as unknown as BodyInit, goodHeaders({ "content-length": "262145" }));
    expect(res.status).toBe(413);
    expect(await json(res)).toEqual({ error: "too_large" });
    expect(h.rate).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("the byte count that actually arrives is what counts, not the declared one", async () => {
    // no Content-Length (chunked): 3 chunks of 100 KB
    const chunk = new Uint8Array(100 * 1024);
    const res = await post(stream([chunk, chunk, chunk]) as unknown as BodyInit);
    expect(res.status).toBe(413);
    expect(await json(res)).toEqual({ error: "too_large" });
    // a small declared length with a longer body
    const lie = await post(stream([chunk, chunk, chunk]) as unknown as BodyInit, goodHeaders({ "content-length": "100" }));
    expect(lie.status).toBe(413);
    // a declared length that does not match what arrived
    const mismatch = await post(GOOD as unknown as BodyInit, goodHeaders({ "content-length": String(GOOD.length + 5) }));
    expect(mismatch.status).toBe(400);
    expect(await json(mismatch)).toEqual({ error: "bad_request" });
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("a Content-Length that is not a number is a bad request", async () => {
    const res = await post(GOOD as unknown as BodyInit, goodHeaders({ "content-length": "12abc" }));
    expect(res.status).toBe(400);
  });

  it("anything that is not the expected JPEG by its bytes is not_jpeg, whatever the header said", async () => {
    const text = new TextEncoder();
    const bads: Uint8Array[] = [
      new Uint8Array(),
      text.encode("<html><script>alert(1)</script></html>"),
      text.encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      png(256, 256),
      webp(256, 256),
      avatarJpeg().slice(0, 60), // truncated
      avatarJpeg({ exif: true }), // GPS and camera data
      avatarJpeg({ xmp: true }),
      avatarJpeg({ com: true }),
      avatarJpeg({ appn: 0xed }),
      avatarJpeg({ trailing: [0x50, 0x4b, 3, 4] }), // a second payload after the end
      avatarJpeg({ noEoi: true }),
      avatarJpeg({ sof: 0xc2 }), // progressive
      avatarJpeg({ twoScans: true }),
    ];
    for (const [i, bytes] of bads.entries()) {
      const res = await post(bytes as unknown as BodyInit);
      expect(res.status, `case ${i}`).toBe(400);
      expect(await json(res), `case ${i}`).toEqual({ error: "not_jpeg" });
    }
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("sides outside 64..512 or far from square are bad_dimensions", async () => {
    for (const [w, hgt] of [[32, 32], [63, 64], [513, 513], [1024, 1024], [256, 128], [512, 400], [65535, 65535]]) {
      const res = await post(avatarJpeg({ width: w, height: hgt }) as unknown as BodyInit);
      expect(res.status, `${w}x${hgt}`).toBe(400);
      expect(await json(res)).toEqual({ error: "bad_dimensions" });
    }
    // square-ish is fine
    expect((await post(avatarJpeg({ width: 256, height: 240 }) as unknown as BodyInit)).status).toBe(200);
  });

  it("a person who edits too often gets rate_limited (429, retry-after); an unreadable limiter is a plain failure", async () => {
    h.rate.mockResolvedValue("limited");
    let res = await post();
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: "rate_limited" });
    expect(res.headers.get("retry-after")).toBe("3600");
    expect((await del()).status).toBe(429);
    h.rate.mockResolvedValue("unavailable");
    res = await post();
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: "failed" });
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.rate).toHaveBeenCalledWith(UID, expect.objectContaining({ bucket: "avatar.write" }));
  });

  it("never passes storage text on: a failed upload is storage_failed, a throw too", async () => {
    h.upload.mockResolvedValue({ data: null, error: { message: 'new row violates row-level security policy for table "objects" (bucket avatars)', statusCode: "403" } });
    let res = await post();
    expect(res.status).toBe(502);
    let body = JSON.stringify(await json(res));
    expect(body).toBe('{"error":"storage_failed"}');
    expect(body).not.toMatch(/row-level|bucket|objects/i);
    h.upload.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    res = await post();
    body = JSON.stringify(await json(res));
    expect(body).toBe('{"error":"storage_failed"}');
  });

  it("is a 503 when Supabase is not configured", async () => {
    h.configured = false;
    expect((await post()).status).toBe(503);
  });
});

describe("DELETE", () => {
  it("removes exactly <uid>/avatar.jpg", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(h.from).toHaveBeenCalledWith("avatars");
    expect(h.remove).toHaveBeenCalledWith([`${UID}/avatar.jpg`]);
  });

  it("is idempotent: removing what is not there is still ok", async () => {
    h.remove.mockResolvedValue({ data: [], error: null });
    expect((await del()).status).toBe(200);
    expect((await del()).status).toBe(200);
    expect(h.remove).toHaveBeenCalledTimes(2);
  });

  it("a storage failure is storage_failed with no storage text", async () => {
    h.remove.mockResolvedValue({ data: null, error: { message: "Bucket not found: avatars" } });
    const res = await del();
    expect(res.status).toBe(502);
    expect(JSON.stringify(await json(res))).toBe('{"error":"storage_failed"}');
  });
});

describe("GET", () => {
  it("serves the person's own photo with the safe headers", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("vary")).toMatch(/cookie/i);
    expect(res.headers.get("content-length")).toBe(String(GOOD.length));
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(GOOD));
    expect(h.download).toHaveBeenCalledWith(`${UID}/avatar.jpg`);
  });

  it("ignores the query entirely: ?v= is a cache-buster, never a path", async () => {
    // the handler takes no request at all: there is nothing in it to read a path from
    const res = await (GET as unknown as (r: Request) => Promise<Response>)(new Request(`${ORIGIN}/api/avatar?v=../../victim/avatar.jpg&path=other`));
    expect(res.status).toBe(200);
    expect(h.download).toHaveBeenCalledTimes(1);
    expect(h.download).toHaveBeenCalledWith(`${UID}/avatar.jpg`);
  });

  it("is 404 when there is no photo or storage fails, with no detail", async () => {
    h.download.mockResolvedValue({ data: null, error: { message: "Object not found" } });
    let res = await get();
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
    h.download.mockRejectedValue(new Error("boom"));
    res = await get();
    expect(res.status).toBe(404);
  });

  it("never serves back something that is not the expected JPEG (the bucket's mime check trusts a header)", async () => {
    h.download.mockResolvedValue({ data: new Blob(["<html><script>alert(1)</script></html>"], { type: "image/jpeg" }), error: null });
    expect((await get()).status).toBe(404);
    h.download.mockResolvedValue({ data: new Blob([new Uint8Array(262145)], { type: "image/jpeg" }), error: null });
    expect((await get()).status).toBe(404);
    // a person can write their own object straight through Storage: EXIF, bytes after the end or another format
    for (const bytes of [avatarJpeg({ exif: true }), avatarJpeg({ trailing: [1] }), png(256, 256), webp(256, 256)]) {
      h.download.mockResolvedValue({ data: new Blob([bytes as unknown as BlobPart], { type: "image/jpeg" }), error: null });
      expect((await get()).status).toBe(404);
    }
    h.download.mockResolvedValue({ data: new Blob([], { type: "image/jpeg" }), error: null });
    expect((await get()).status).toBe(404);
  });
});
