/**
 * Breach (security lab only): attacks on GET /api/library/{asset}/download
 * (docs/EXPORT_DOWNLOADS.md). A PostgREST stand-in plays RLS: only the
 * caller's own organization's live rows come back. The attacks that the route
 * stops are pinned so they stay stopped; the two that get through are left
 * FAILING on purpose until the product code is fixed (see each test's note).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const OWN = "aaaaaaaa-2222-4222-8333-444444444444";
const OTHER_TENANT = "bbbbbbbb-2222-4222-8333-444444444444";
const SOFT_DELETED = "eeeeeeee-2222-4222-8333-444444444444";
const AUDIO = "ffffffff-2222-4222-8333-444444444444";
const SUBS = "12345678-2222-4222-8333-444444444444";
const SECRET = "k".repeat(48);

const h = vi.hoisted(() => ({
  user: { id: "attacker" } as { id: string } | null,
  rows: {} as Record<string, Record<string, unknown>>,
  captions: {} as Record<string, unknown>,
  filters: [] as Record<string, unknown>[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({
    rpc: vi.fn(),
    from: (name: string) => {
      const f: Record<string, unknown> = { table: name };
      h.filters.push(f);
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => ((f[c] = v), q),
        is: (c: string, v: unknown) => ((f[c] = v), q),
        order: () => q,
        limit: () => q,
        maybeSingle: async () => {
          if (name === "media_assets") return { data: h.rows[String(f.id)] ?? null, error: null };
          const c = h.captions[String(f.asset_id)];
          return { data: c === undefined ? null : { captions: c }, error: null };
        },
      };
      return q;
    },
  }),
}));

const { GET } = await import("../app/api/library/[asset]/download/route");

const media = mkdtempSync(join(tmpdir(), "ns-breach-media-"));
function put(id: string, files: Record<string, Buffer>) {
  const d = join(media, id.slice(0, 2), id);
  mkdirSync(d, { recursive: true });
  for (const [n, b] of Object.entries(files)) writeFileSync(join(d, n), b);
}
// Every id has bytes on disk: a 404 below is the row read refusing, not a missing file.
for (const id of [OWN, OTHER_TENANT, SOFT_DELETED, AUDIO, SUBS]) put(id, { original: Buffer.alloc(64, 1), "proxy.mp4": Buffer.alloc(8, 2) });

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, kind: "video", mime: "video/mp4", bytes: 64, width: 1920, height: 1080, duration_s: 3,
    source: "render", original_name: "export.mp4", variants: ["thumb", "proxy"], version: 1,
    created_at: "2026-11-20T10:00:00Z", ...extra,
  };
}

function get(id: string, variant: string, headers: Record<string, string> = {}) {
  return GET(new Request(`https://lab.test/api/library/${encodeURIComponent(id)}/download?variant=${variant}`, { headers }), {
    params: Promise.resolve({ asset: id }),
  });
}

beforeEach(() => {
  process.env.NIGHTSHIFT_MEDIA_DIR = media;
  process.env.MEDIA_URL_SECRET = SECRET;
  h.user = { id: "attacker" };
  // RLS: OTHER_TENANT and SOFT_DELETED are not returned to this caller.
  h.rows = {
    [OWN]: row(OWN),
    [AUDIO]: row(AUDIO, { kind: "audio", mime: "audio/mpeg", variants: [] }),
    [SUBS]: row(SUBS, { kind: "caption", mime: "application/x-subrip", variants: [] }),
  };
  h.captions = {};
  h.filters = [];
});
afterAll(() => rmSync(media, { recursive: true, force: true }));

describe("breach: tenancy and identifiers (held)", () => {
  it("another tenant's / a soft-deleted asset: 404 for every variant, no Location, no bytes", async () => {
    for (const id of [OTHER_TENANT, SOFT_DELETED])
      for (const v of ["original", "preview", "captions"]) {
        const res = await get(id, v);
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("cache-control")).toBe("private, no-store");
      }
  });

  it("captions of another tenant's export cannot be fetched through one's own asset id: the export read is keyed by the RLS-visible asset", async () => {
    h.captions[OTHER_TENANT] = { cues: [{ id: "x", start_s: 0, end_s: 1, text: "secret" }] };
    expect((await get(OTHER_TENANT, "captions")).status).toBe(404);
    expect(h.filters.some((f) => f.table === "editor_exports")).toBe(false);
  });

  it("traversal, NUL, uppercase and encoded ids are 400 before the database", async () => {
    for (const id of ["../../etc/passwd", `${OWN}/../${OTHER_TENANT}`, `${OWN}\0`, OWN.toUpperCase(), `${OWN}%2F..`]) {
      expect((await get(id, "original")).status).toBe(400);
    }
    expect(h.filters).toEqual([]);
  });

  it("variant smuggling: thumb/proxy/display, arrays and case variants are 400", async () => {
    for (const v of ["proxy", "thumb", "display", "ORIGINAL", "original&variant=proxy", "original%00"]) {
      const res = await get(OWN, v);
      // `original&variant=proxy` parses as variant=original (first wins): still only the original, never a different file.
      if (v === "original&variant=proxy") expect(res.headers.get("content-type")).toBe("video/mp4");
      else expect(res.status).toBe(400);
    }
  });

  it("signed out: 401 with no-store on every variant", async () => {
    h.user = null;
    for (const v of ["original", "preview", "captions"]) {
      const res = await get(OWN, v);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});

describe("breach: the 303 preview (held)", () => {
  it("is a same-origin relative path to the proxy only, never an absolute or protocol-relative URL", async () => {
    const loc = (await get(OWN, "preview")).headers.get("location") as string;
    expect(loc.startsWith(`/api/media/file/${OWN}/proxy?`)).toBe(true);
    expect(loc.startsWith("//")).toBe(false);
  });

  it("audio has no preview: never a 303 to a signed bearer link of the original", async () => {
    const res = await get(AUDIO, "preview");
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("breach: served bytes (held)", () => {
  it("original: attachment, nosniff, sandbox CSP, no-store; an .srt original is text/plain", async () => {
    for (const id of [OWN, SUBS]) {
      const res = await get(id, "original");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    expect((await get(SUBS, "original")).headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("an unlisted mime in the row (html, svg) is never served", async () => {
    for (const mime of ["text/html", "image/svg+xml"]) {
      h.rows[OWN] = row(OWN, { kind: "image", mime });
      expect((await get(OWN, "original")).status).toBe(400);
    }
  });

  it("Range abuse: multi-range gives the whole file once, huge/negative/reversed ranges are 416", async () => {
    const multi = await get(OWN, "original", { range: "bytes=0-1,2-3" });
    expect(multi.status).toBe(200);
    expect(multi.headers.get("content-length")).toBe("64");
    for (const r of ["bytes=99999999999999999999-", "bytes=5-1", "bytes=-0", "bytes=64-"]) {
      expect((await get(OWN, "original", { range: r })).status).toBe(416);
    }
  });

  it("header injection through original_name: CR/LF, quotes and ; never reach the header", async () => {
    for (const name of ['x"; filename="evil.html', "a\r\nSet-Cookie: s=1", "a b\u0085c.mp4", "%0d%0aX: y"]) {
      h.rows[OWN] = row(OWN, { original_name: name });
      const res = await get(OWN, "original");
      const cd = res.headers.get("content-disposition") as string;
      expect(cd).not.toMatch(/[\r\n]/);
      expect(res.headers.get("set-cookie")).toBeNull();
      // Exactly one quoted ASCII name (no quote inside it) and one encoded name: no second parameter can be smuggled.
      expect(cd).toMatch(/^attachment; filename="[^"]*\.mp4"; filename\*=UTF-8''[^"\s;]+\.mp4$/);
    }
  });
});

describe("breach: open holes (FAILING until fixed)", () => {
  // LOW. A cue's text is written into the SRT with only blank lines removed, so a
  // line shaped like a timing line survives inside it. SubRip readers that key on
  // the timing line (ffmpeg's srt demuxer, many players, YouTube's caption upload)
  // read it as a second cue with attacker-chosen times and text. buildVtt already
  // neutralises "-->"; buildSrt does not. Captions can come from transcription or
  // model output, not only from a person typing.
  it("a cue's text cannot forge an extra SRT cue (no timing line inside a cue body)", async () => {
    h.captions[OWN] = {
      cues: [{ id: "1", start_s: 0, end_s: 1, text: "Hello\n2\n00:00:00,000 --> 99:59:59,999\nFORGED: visit evil.example" }],
    };
    const srt = await (await get(OWN, "captions")).text();
    const timing = srt.split("\n").filter((l) => l.includes("-->"));
    expect(timing).toHaveLength(1);
  });

  // LOW. original_name keeps Unicode bidi controls (U+202E RIGHT-TO-LEFT OVERRIDE),
  // and downloadFileName only strips C0/C1 and path characters, so a member who
  // names an upload "invoice‮fdp.exe" makes every colleague's download show as
  // "invoice4pm.exe.pdf"-style spoofed names in UIs that do not neutralise bidi.
  // The real extension is still the media type's, which keeps this low.
  it("the saved name carries no bidi override or other format characters", async () => {
    h.rows[OWN] = row(OWN, { original_name: "invoice‮fdp.exe" });
    const cd = (await get(OWN, "original")).headers.get("content-disposition") as string;
    const star = decodeURIComponent(cd.split("filename*=UTF-8''")[1]);
    expect(star).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
  });
});
