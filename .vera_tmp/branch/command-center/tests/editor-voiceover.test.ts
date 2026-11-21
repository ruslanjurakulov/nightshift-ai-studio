import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Voice-over recorded in the editor, the non-visual half: lib/editor-voiceover.ts (the upload of a take and the wait
 * for the library to hold it), GET /api/media/uploads/<ticket> (where one upload is), and the document a placed take
 * makes.
 *
 * What would break without these: a take kept only in the browser, or placed on the timeline before the server
 * registered it (an asset id that is not a live file of the organization, which the save refuses); a take uploaded
 * with a `.webm` name (the database maps `.webm` to video and refuses it as an extension mismatch); a take over the
 * size cap sent anyway; the server's refusal (quota, size, the worker's reason word) lost or shown raw; polling that
 * never ends; a file the server did not register as a sound with a length placed anyway; a status read that answers
 * another organization's ticket, or the worker's free text; and a recorded sound on an A track that does not validate.
 */

vi.mock("server-only", () => ({}));

const ORG = "0a000000-0000-4000-8000-00000000000a";
const TICKET = "0c000000-0000-4000-8000-00000000000c";
const ASSET = "0e000000-0000-4000-8000-00000000000e";
const VID = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  row: null as Record<string, unknown> | null,
  error: null as { code?: string; message?: string } | null,
  reads: [] as Array<{ table: string; columns: string; eq: [string, unknown] }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (col: string, val: unknown) => ({
          maybeSingle: async () => {
            h.reads.push({ table, columns, eq: [col, val] });
            return { data: h.row, error: h.error };
          },
        }),
      }),
    }),
  }),
  getUser: async () => h.user,
}));

const {
  VOICEOVER_BITS_PER_SECOND,
  VOICEOVER_MAX_BYTES,
  VOICEOVER_MAX_SECONDS,
  VOICEOVER_POLL_MS,
  VOICEOVER_WAIT_MS,
  takeName,
  uploadVoiceOver,
  voiceTakeType,
} = await import("@/lib/editor-voiceover");
const { ALLOWED_MIME } = await import("@/lib/media");
const { GET } = await import("../app/api/media/uploads/[ticket]/route");
const editor = await import("@/lib/editor");

const ROOT = join(__dirname, "..", "..");
const SQL_0038 = readFileSync(join(ROOT, "supabase", "migrations", "0038_media_assets.sql"), "utf8");
const SQL_0044 = readFileSync(join(ROOT, "supabase", "migrations", "0044_media_heic.sql"), "utf8");

// ---- a fake network -----------------------------------------------------------------------------------------------------------
type Call = { url: string; init?: RequestInit };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function network(statuses: Array<Record<string, unknown> | number>, asset: Record<string, unknown> | number = { id: ASSET, kind: "audio", name: "Voice-over 2026-11-11 12-30-05", durationS: 4.2 }) {
  const calls: Call[] = [];
  let polls = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (url === "/api/media/uploads" && init?.method === "POST") return json({ ok: true, ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: "n" });
    if (url === `/api/media/uploads/${TICKET}` && init?.method === "PUT") return json({ ok: true, status: "uploaded" });
    if (url === `/api/media/uploads/${TICKET}`) {
      const s = statuses[Math.min(polls++, statuses.length - 1)];
      return typeof s === "number" ? json({ error: "x" }, s) : json(s);
    }
    if (url === `/api/media/${ASSET}`)
      return typeof asset === "number" ? json({ error: "x" }, asset) : json({ asset, urls: { original: `/api/media/file/${ASSET}/original?t=audio%2Fwebm&exp=1&sig=s` } });
    return json({ error: "unexpected" }, 500);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

let clock = 0;
const sleep = vi.fn(async (ms: number) => {
  clock += ms;
});
const now = () => clock;
const take = (bytes = 1000, type = "audio/webm") => new Blob([new Uint8Array(bytes)], { type });
const run = (net: ReturnType<typeof network>, extra: Partial<Parameters<typeof uploadVoiceOver>[0]> = {}) =>
  uploadVoiceOver({ orgId: ORG, blob: take(), type: "audio/webm", name: "Voice-over 2026-11-11 12-30-05", fetchImpl: net.fetchImpl, sleep, now, ...extra });

beforeEach(() => {
  clock = 0;
  sleep.mockClear();
  h.user = { id: "u1" };
  h.row = null;
  h.error = null;
  h.reads = [];
});

// =================================================================================================================================
describe("the take's type and name", () => {
  it("keeps what the recorder made, as a type the library accepts as audio", () => {
    expect(voiceTakeType("audio/webm;codecs=opus")).toEqual({ type: "audio/webm", ext: "" });
    expect(voiceTakeType("audio/ogg; codecs=opus")).toEqual({ type: "audio/ogg", ext: "ogg" });
    expect(voiceTakeType("audio/mp4")).toEqual({ type: "audio/mp4", ext: "m4a" });
    expect(voiceTakeType("audio/x-wav")).toEqual({ type: "audio/wav", ext: "wav" });
    for (const bad of ["video/webm", "video/mp4", "", null, undefined, "audio/mpeg;", "constructor", "__proto__"]) expect(voiceTakeType(bad)).toBeNull();
    for (const m of ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"]) expect(ALLOWED_MIME[m]).toBe("audio");
  });

  it("a WebM take carries no extension (the database reads `.webm` as video); the others an audio one", () => {
    const at = new Date(2026, 10, 11, 9, 5, 7);
    expect(takeName(at, "")).toBe("Voice-over 2026-11-11 09-05-07");
    expect(takeName(at, "m4a")).toBe("Voice-over 2026-11-11 09-05-07.m4a");
    // request_upload checks an extension only when the name ends in one (0038): this name has none.
    expect(/\.[A-Za-z0-9]{1,5}$/.test(takeName(at, ""))).toBe(false);
    // and every extension a take can carry is one the database maps to audio (0044's media_ext_mime).
    const extMime = (ext: string) => new RegExp(`when '${ext}' then '([^']+)'`).exec(SQL_0044)?.[1];
    expect(extMime("webm")).toBe("video/webm"); // the reason WebM gets none
    for (const t of ["audio/ogg", "audio/mp4", "audio/wav"]) {
      const { ext } = voiceTakeType(t)!;
      expect(ALLOWED_MIME[extMime(ext)!], ext).toBe("audio");
    }
  });

  it("the caps hold together: ten minutes at the asked rate fit twice over, and under the library's per-file cap", () => {
    expect(VOICEOVER_MAX_SECONDS).toBe(600);
    expect(2 * (VOICEOVER_MAX_SECONDS * VOICEOVER_BITS_PER_SECOND) / 8).toBeLessThanOrEqual(VOICEOVER_MAX_BYTES);
    const fileCap = Number(/max_upload_bytes\s+bigint not null default (\d+)/.exec(SQL_0038)?.[1]);
    expect(fileCap).toBeGreaterThan(0);
    expect(VOICEOVER_MAX_BYTES).toBeLessThan(fileCap);
  });
});

describe("uploading a take through the library", () => {
  it("asks for a ticket, sends the take, waits for the worker, and returns the registered sound", async () => {
    const net = network([{ status: "uploaded" }, { status: "ingesting" }, { status: "ingested", asset_id: ASSET }]);
    const out = await run(net);
    expect(out).toEqual({
      ok: true,
      asset: { id: ASSET, kind: "audio", name: "Voice-over 2026-11-11 12-30-05", durationS: 4.2, width: null, height: null, viewUrl: `/api/media/file/${ASSET}/original?t=audio%2Fwebm&exp=1&sig=s`, thumbUrl: null },
    });
    const [ticket, put] = net.calls;
    expect(JSON.parse(String(ticket.init?.body))).toEqual({ org_id: ORG, filename: "Voice-over 2026-11-11 12-30-05", mime: "audio/webm", bytes: 1000 });
    expect(put.init?.method).toBe("PUT");
    expect((put.init?.headers as Record<string, string>)["content-type"]).toBe("audio/webm");
    expect(net.calls.filter((c) => c.url === `/api/media/uploads/${TICKET}` && !c.init?.method)).toHaveLength(3);
    expect(sleep).toHaveBeenCalledWith(VOICEOVER_POLL_MS);
  });

  it("refuses a take over the cap before any request, and an empty one", async () => {
    const net = network([]);
    expect(await run(net, { blob: take(VOICEOVER_MAX_BYTES + 1) })).toEqual({ ok: false, error: "too_large", maxBytes: VOICEOVER_MAX_BYTES });
    expect(await run(net, { blob: new Blob([]) })).toEqual({ ok: false, error: "empty" });
    expect(net.calls).toEqual([]);
  });

  it("passes on the database's refusal of the ticket, with its limit", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "quota_exceeded" }, 507)) as unknown as typeof fetch;
    expect(await run({ calls: [], fetchImpl })).toMatchObject({ ok: false, error: "quota_exceeded" });
    const big = vi.fn(async () => json({ error: "too_large", max_bytes: 5000 }, 413)) as unknown as typeof fetch;
    expect(await run({ calls: [], fetchImpl: big })).toMatchObject({ ok: false, error: "too_large", maxBytes: 5000 });
  });

  it("says why the worker refused it, as a known word only", async () => {
    expect(await run(network([{ status: "rejected", reason: "not_media" }]))).toEqual({ ok: false, error: "rejected", reason: "not_media" });
    expect(await run(network([{ status: "rejected", reason: "<b>free text</b>" }]))).toEqual({ ok: false, error: "rejected", reason: null });
    expect(await run(network([{ status: "expired" }]))).toEqual({ ok: false, error: "expired" });
  });

  it("a failed status read is asked again; a signed-out one ends it", async () => {
    expect((await run(network([502, 500, { status: "ingested", asset_id: ASSET }]))).ok).toBe(true);
    expect(await run(network([401]))).toEqual({ ok: false, error: "unauthorized" });
  });

  it("stops waiting at the deadline, and says it is still being checked (it will be in the library)", async () => {
    const net = network([{ status: "ingesting" }]);
    const out = await run(net);
    expect(out).toEqual({ ok: false, error: "still_checking" });
    expect(clock).toBeGreaterThanOrEqual(VOICEOVER_WAIT_MS);
    expect(clock).toBeLessThan(VOICEOVER_WAIT_MS + 2 * VOICEOVER_POLL_MS);
  });

  it("a page that was left stops waiting at once", async () => {
    const ctrl = new AbortController();
    const net = network([{ status: "ingesting" }]);
    const s = vi.fn(async () => ctrl.abort());
    expect(await run(net, { sleep: s, signal: ctrl.signal })).toEqual({ ok: false, error: "still_checking" });
    expect(net.calls.filter((c) => !c.init?.method)).toHaveLength(0);
  });

  it("never places what the server did not register as a sound with a length", async () => {
    const ingested = [{ status: "ingested", asset_id: ASSET }];
    for (const bad of [
      { id: ASSET, kind: "video", name: "x", durationS: 3 },
      { id: ASSET, kind: "audio", name: "x", durationS: null },
      { id: ASSET, kind: "audio", name: "x", durationS: 0 },
      { id: VID, kind: "audio", name: "x", durationS: 3 },
    ])
      expect(await run(network(ingested, bad))).toEqual({ ok: false, error: "not_audio" });
    expect(await run(network(ingested, 404))).toEqual({ ok: false, error: "failed" });
  });

  it("keeps only a signed media link as the preview", async () => {
    const net = network([{ status: "ingested", asset_id: ASSET }]);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
      url === `/api/media/${ASSET}` ? json({ asset: { id: ASSET, kind: "audio", name: "n", durationS: 2 }, urls: { original: "https://evil.example/x" } }) : net.fetchImpl(url, init),
    ) as unknown as typeof fetch;
    const out = await run(net, { fetchImpl });
    expect(out.ok && out.asset.viewUrl).toBeNull();
  });
});

describe("GET /api/media/uploads/<ticket>", () => {
  const get = (ticket: string) => GET(new Request(`https://x/api/media/uploads/${ticket}`), { params: Promise.resolve({ ticket }) });

  it("answers the ticket's status, reason word and asset, read under the caller's session", async () => {
    h.row = { id: TICKET, status: "ingested", reason: null, asset_id: ASSET };
    const res = await get(TICKET);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ticket: TICKET, status: "ingested", reason: null, asset_id: ASSET });
    expect(h.reads).toEqual([{ table: "media_uploads", columns: "id, status, reason, asset_id", eq: ["id", TICKET] }]);
  });

  it("passes a known reason word and drops anything else", async () => {
    h.row = { id: TICKET, status: "rejected", reason: "too_long", asset_id: null };
    expect(await (await get(TICKET)).json()).toMatchObject({ reason: "too_long", asset_id: null });
    h.row = { id: TICKET, status: "rejected", reason: "ffprobe said: /srv/media/x", asset_id: null };
    expect(await (await get(TICKET)).json()).toMatchObject({ reason: null });
  });

  it("another organization's ticket (RLS returns no row) and a made-up one are the same 404", async () => {
    h.row = null;
    expect((await get(TICKET)).status).toBe(404);
  });

  it("refuses without a session and a non-id before the database", async () => {
    h.user = null;
    expect((await get(TICKET)).status).toBe(401);
    h.user = { id: "u1" };
    for (const bad of ["../x", "x", `${TICKET}x`]) expect((await get(bad)).status).toBe(400);
    expect(h.reads).toEqual([]);
  });
});

describe("a placed take is an ordinary sound", () => {
  const VIDEO = { id: VID, kind: "video" as const, name: "v.mp4", durationS: 20, width: 1920, height: 1080, viewUrl: null, thumbUrl: null };
  const VOICE = { id: ASSET, kind: "audio" as const, name: "Voice-over", durationS: 4.2, width: null, height: null, viewUrl: null, thumbUrl: null };

  it("goes on an A track at the playhead, and the document validates with the sound's kind", () => {
    const model = editor.toModel(editor.newDocForAsset(VIDEO)!);
    const out = editor.addSound(model, VOICE, 6.5)!;
    const doc = editor.toDoc(out.model);
    const a = doc.tracks.filter((t) => t.kind === "A");
    expect(a).toHaveLength(1);
    expect(a[0].clips[0]).toMatchObject({ asset_id: ASSET, start_s: 6.5, in_s: 0, out_s: 4.2 });
    expect(editor.validateTimeline(doc)).toEqual([]);
    expect(editor.docAssetProblems(doc, { [VID]: "video", [ASSET]: "audio" })).toEqual([]);
    expect(editor.docAssetIds(doc)).toContain(ASSET);
    // The same take could never go on the picture track.
    const onPicture = { ...doc, tracks: doc.tracks.map((t) => (t.kind === "V" ? { ...t, clips: [...t.clips, { ...t.clips[0], id: "cx", asset_id: ASSET }] } : t)) };
    expect(editor.docAssetProblems(onPicture as typeof doc, { [VID]: "video", [ASSET]: "audio" }).join()).toMatch(/V track takes video or image, not audio/);
  });

  it("a project with no room for another sound takes none", () => {
    let m = editor.toModel(editor.newDocForAsset(VIDEO)!);
    for (let i = 0; i < editor.MAX_EDITOR_SOUNDS; i++) m = editor.addSound(m, VOICE, 0)!.model;
    expect(editor.canAddSound(m)).toBe(false);
    expect(editor.addSound(m, VOICE, 0)).toBeNull();
  });
});
