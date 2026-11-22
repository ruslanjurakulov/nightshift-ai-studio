import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { filmCaptionsPointer, isFilmCaptionsOf, vttCues, vttToSrt } from "@/lib/libraryDownload";

/**
 * S4 G3: a film master has no editor export, so `?variant=captions` used to be
 * 404 no_captions and the person could not take the film's subtitles with it.
 * The master's provenance names its captions file (film_assembly), and the
 * route now serves that file as SRT, but only when the file's own row, read
 * under the same session, agrees that it is this film's captions.
 */

const ORG = "0a0a0a0a-1111-4222-8333-444444444444";
const OTHER_ORG = "0b0b0b0b-1111-4222-8333-444444444444";
const SEG = "5e5e5e5e-1111-4222-8333-444444444444";
const OTHER_SEG = "5f5f5f5f-1111-4222-8333-444444444444";
const FILM = "f1f1f1f1-1111-4222-8333-444444444444";
const SHA = "a".repeat(64);

const MASTER = "aaaaaaaa-2222-4222-8333-444444444444";
const VTT = "bbbbbbbb-2222-4222-8333-444444444444";
const FOREIGN_VTT = "cccccccc-2222-4222-8333-444444444444"; // another workspace's: RLS returns no row
const WRONG_SEG_VTT = "dddddddd-2222-4222-8333-444444444444";
const NOT_CAPTION = "eeeeeeee-2222-4222-8333-444444444444";
const BROKEN_VTT = "ffffffff-2222-4222-8333-444444444444";
const PURGED_VTT = "abababab-2222-4222-8333-444444444444";

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>>,
  failIds: new Set<string>(),
  selects: [] as string[],
  rpc: vi.fn(),
  writes: vi.fn(),
  from: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "u-1" }),
  createClient: async () => ({ from: h.from, rpc: h.rpc }),
}));

/** PostgREST under RLS: only the caller's workspace's rows exist; no film master has an editor export. */
function table(name: string) {
  const filters: Record<string, unknown> = {};
  const q = {
    select: (cols: string) => {
      if (name === "media_assets") h.selects.push(cols);
      return q;
    },
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
      if (name === "media_assets") {
        const id = String(filters.id);
        if (h.failIds.has(id)) return { data: null, error: { message: "boom", code: "XX000" } };
        return { data: h.rows[id] ?? null, error: null };
      }
      return { data: null, error: null };
    },
  };
  return q;
}

const { GET } = await import("../app/api/library/[asset]/download/route");

const media = mkdtempSync(join(tmpdir(), "ns-film-captions-"));
function put(id: string, body: string | Buffer) {
  const d = join(media, id.slice(0, 2), id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "original"), body);
}

// Exactly what film_assembly.vtt_text writes: the SRT's cue numbers kept as identifiers.
const FILM_VTT = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\nThe river\n\n2\n00:00:02.500 --> 00:00:05.000\nruns west\n";
put(VTT, FILM_VTT);
put(WRONG_SEG_VTT, FILM_VTT);
put(NOT_CAPTION, FILM_VTT);
put(BROKEN_VTT, "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\nThe river\n\n2\n00:00:02,500 -> 00:00:05.000\nruns west\n");

const prov = (extra: Record<string, unknown> = {}) => ({
  film_segment_id: SEG,
  film_id: FILM,
  cut_sha256: SHA,
  tool: "film_assembly",
  ...extra,
});

function master(captionsAssetId: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: MASTER,
    org_id: ORG,
    kind: "video",
    mime: "video/mp4",
    bytes: 4096,
    width: 1920,
    height: 1080,
    duration_s: 5,
    source: "generated",
    original_name: "film.mp4",
    variants: ["thumb", "proxy"],
    version: 1,
    created_at: "2026-11-20T10:00:00Z",
    provenance: prov({ captions_asset_id: captionsAssetId }),
    ...extra,
  };
}

function caption(id: string, extra: Record<string, unknown> = {}, p: Record<string, unknown> = {}) {
  return {
    id,
    org_id: ORG,
    kind: "caption",
    mime: "text/vtt",
    bytes: FILM_VTT.length,
    width: null,
    height: null,
    duration_s: null,
    source: "generated",
    original_name: "captions.vtt",
    variants: [],
    version: 1,
    created_at: "2026-11-20T10:00:00Z",
    provenance: prov({ role: "captions", ...p }),
    ...extra,
  };
}

function get(id = MASTER, headers: Record<string, string> = {}) {
  return GET(new Request(`https://nightshift.test/api/library/${id}/download?variant=captions`, { headers }), {
    params: Promise.resolve({ asset: id }),
  });
}

async function refusal(res: Response) {
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  process.env.NIGHTSHIFT_MEDIA_DIR = media;
  h.rows = {
    [MASTER]: master(VTT),
    [VTT]: caption(VTT),
    [WRONG_SEG_VTT]: caption(WRONG_SEG_VTT, {}, { film_segment_id: OTHER_SEG }),
    [NOT_CAPTION]: caption(NOT_CAPTION, { kind: "audio", mime: "audio/mpeg" }),
    [BROKEN_VTT]: caption(BROKEN_VTT),
    [PURGED_VTT]: caption(PURGED_VTT),
  };
  h.failIds = new Set();
  h.selects = [];
  h.rpc.mockReset();
  h.writes.mockReset();
  h.from.mockReset().mockImplementation((name: string) => table(name));
});
afterAll(() => rmSync(media, { recursive: true, force: true }));

describe("a film master's captions download", () => {
  it("is the film's captions file as an SRT attachment, renumbered, with decimal commas", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-subrip; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="film\.srt"/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(
      "1\n00:00:00,000 --> 00:00:02,500\nThe river\n\n2\n00:00:02,500 --> 00:00:05,000\nruns west\n",
    );
    // Both rows were read as the member, and nothing was written or called.
    expect(h.selects.every((c) => c.includes("org_id") && c.includes("provenance"))).toBe(true);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.writes).not.toHaveBeenCalled();
  });

  it("another workspace's captions file (RLS returns no row) is no captions, not its bytes", async () => {
    put(FOREIGN_VTT, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nsecret\n");
    h.rows[MASTER] = master(FOREIGN_VTT);
    expect(await refusal(await get())).toEqual({ status: 404, body: { error: "no_captions" } });
  });

  it("a row of another workspace, were RLS ever to return it, is still refused", async () => {
    h.rows[VTT] = caption(VTT, { org_id: OTHER_ORG });
    expect(await refusal(await get())).toEqual({ status: 404, body: { error: "no_captions" } });
  });

  it("another film's captions file (a different film_segment_id) is refused", async () => {
    h.rows[MASTER] = master(WRONG_SEG_VTT);
    expect(await refusal(await get())).toEqual({ status: 404, body: { error: "no_captions" } });
  });

  it("another cut's captions of the same segment are refused", async () => {
    h.rows[VTT] = caption(VTT, {}, { cut_sha256: "b".repeat(64) });
    expect(await refusal(await get())).toEqual({ status: 404, body: { error: "no_captions" } });
  });

  it("a row that is not a caption is refused, even with matching provenance", async () => {
    h.rows[MASTER] = master(NOT_CAPTION);
    expect(await refusal(await get())).toEqual({ status: 404, body: { error: "no_captions" } });
  });

  it("a captions_asset_id that is not a canonical uuid is no captions, and is never looked up", async () => {
    for (const bad of ["../../etc/passwd", `${VTT}/../../x`, VTT.toUpperCase(), 42, null, { id: VTT }]) {
      h.selects = [];
      h.rows[MASTER] = master(bad);
      expect(await refusal(await get())).toEqual({ status: 404, body: { error: "no_captions" } });
      // Only the master was read: the bad value never reached a query or a path.
      expect(h.selects).toHaveLength(1);
    }
  });

  it("a master without a captions pointer is no captions, as before", async () => {
    h.rows[MASTER] = master(undefined);
    expect(await refusal(await get())).toEqual({ status: 404, body: { error: "no_captions" } });
  });

  it("a failed read of the captions row is 502 read_failed, never 'no captions'", async () => {
    h.failIds.add(VTT);
    expect(await refusal(await get())).toEqual({ status: 502, body: { error: "read_failed" } });
  });

  it("a malformed captions file is 502 read_failed with no partial body", async () => {
    h.rows[MASTER] = master(BROKEN_VTT);
    const res = await get();
    expect(res.status).toBe(502);
    expect(res.headers.get("content-disposition")).toBeNull();
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "read_failed" });
    expect(text).not.toContain("The river");
  });

  it("a captions row whose file was purged is 410 gone", async () => {
    h.rows[MASTER] = master(PURGED_VTT);
    expect(await refusal(await get())).toEqual({ status: 410, body: { error: "gone" } });
  });

  it("a host without the media volume says so (503)", async () => {
    process.env.NIGHTSHIFT_MEDIA_DIR = "/nonexistent/ns-media";
    expect(await refusal(await get())).toEqual({ status: 503, body: { error: "media_unavailable" } });
  });
});

describe("WebVTT to SRT", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("drops the header, NOTE, STYLE and REGION blocks, cue settings and voice tags; keeps <i>; renumbers", () => {
    const vtt = [
      "﻿WEBVTT - a film",
      "Kind: captions",
      "",
      "NOTE written by film_assembly",
      "",
      "STYLE",
      "::cue { color: red }",
      "",
      "intro",
      "00:01.250 --> 00:02.000 align:start line:0",
      "<v Narrator>Tom &amp; <i>Jerry</i> &lt;3</v>",
      "",
      "01:00:03.000 --> 01:00:04.000",
      "short <00:00:03.500>form",
      "",
    ].join("\r\n");
    expect(vttToSrt(enc(vtt))).toBe(
      "1\n00:00:01,250 --> 00:00:02,000\nTom & <i>Jerry</i> <3\n\n2\n01:00:03,000 --> 01:00:04,000\nshort form\n",
    );
  });

  it("refuses a file that is not WebVTT, as a whole", () => {
    expect(vttCues(enc("1\n00:00:00,000 --> 00:00:01,000\nan srt\n"))).toBeNull(); // no signature
    expect(vttCues(enc("WEBVTTX\n\n00:00:00.000 --> 00:00:01.000\nx\n"))).toBeNull();
    expect(vttCues(enc("WEBVTT\n\n00:00:01.000 --> 00:00:00.500\nbackwards\n"))).toBeNull();
    expect(vttCues(enc("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nok\n\njust words\nno timing\n"))).toBeNull();
    expect(vttCues(enc("WEBVTT\n\n"))).toBeNull(); // no cues
    expect(vttCues(new Uint8Array([0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x0a, 0xff, 0xfe]))).toBeNull(); // not UTF-8
    expect(vttCues(enc("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\na\u0000b\n"))).toBeNull();
    expect(vttCues(new Uint8Array(2 * 1024 * 1024 + 1))).toBeNull();
  });

  it("a forged timing line inside a cue's text cannot become a second cue", () => {
    const srt = vttToSrt(enc("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n00:00:05.000 --> 00:00:09.000\n"));
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:01,000\nhi\n00:00:05.000 - -> 00:00:09.000\n");
  });
});

describe("the pointer", () => {
  it("only a canonical uuid is a pointer", () => {
    expect(filmCaptionsPointer({ captions_asset_id: VTT })).toBe(VTT);
    expect(filmCaptionsPointer({ captions_asset_id: "../../etc/passwd" })).toBeNull();
    expect(filmCaptionsPointer([VTT])).toBeNull();
    expect(filmCaptionsPointer(null)).toBeNull();
  });

  it("a master without a film segment or a cut matches nothing", () => {
    const cap = { org_id: ORG, kind: "caption", mime: "text/vtt", provenance: prov({ role: "captions" }) };
    expect(isFilmCaptionsOf({ org_id: ORG, provenance: prov() }, cap)).toBe(true);
    expect(isFilmCaptionsOf({ org_id: ORG, provenance: prov({ film_segment_id: undefined }) }, cap)).toBe(false);
    expect(isFilmCaptionsOf({ org_id: ORG, provenance: prov({ cut_sha256: null }) }, cap)).toBe(false);
    expect(isFilmCaptionsOf({ org_id: null, provenance: prov() }, { ...cap, org_id: null })).toBe(false);
    expect(isFilmCaptionsOf({ org_id: ORG, provenance: prov() }, { ...cap, provenance: prov({ role: "film" }) })).toBe(false);
  });
});
