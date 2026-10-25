/**
 * The image editor's ownership check (lib/server/image-editor.ts) and its page.
 * What would break without these: another organization's picture opened for editing, a deleted or video row opened,
 * a GIF / HEIC handed to a canvas, a recorded size trusted when it is missing or over 16 megapixels, the page rendering
 * (or calling the database) while the switch is off, and a made-up id looking different from a foreign one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PIC = "33333333-3333-4333-8333-333333333333";

const { readEditableAsset } = await import("../lib/server/image-editor");

function client(row: unknown, error: unknown = null) {
  const calls: { table: string; select: string; id: string }[] = [];
  const supabase = {
    from(table: string) {
      return {
        select(cols: string) {
          return {
            eq(_col: string, id: string) {
              calls.push({ table, select: cols, id });
              return { maybeSingle: async () => ({ data: row, error }) };
            },
          };
        },
      };
    },
  };
  return { supabase: supabase as never, calls };
}
const row = (over: Record<string, unknown> = {}) => ({ org_id: ORG, kind: "image", mime: "image/jpeg", width: 1200, height: 800, original_name: "cat.jpg", ...over });

describe("readEditableAsset", () => {
  it("reads one media_assets row by id under the caller's own client and returns the library's size and name", async () => {
    const { supabase, calls } = client(row());
    expect(await readEditableAsset(supabase, ORG, PIC)).toEqual({ ok: true, asset: { width: 1200, height: 800, mime: "image/jpeg", name: "cat.jpg" } });
    expect(calls).toEqual([{ table: "media_assets", select: "org_id, kind, mime, width, height, original_name", id: PIC }]);
  });

  it("another organization's picture, a missing row and a non-image all read exactly like not_found", async () => {
    for (const data of [row({ org_id: OTHER }), null, row({ kind: "video" }), row({ kind: "audio" }), row({ org_id: undefined })]) {
      expect(await readEditableAsset(client(data).supabase, ORG, PIC)).toEqual({ ok: false, error: "not_found" });
    }
  });

  it("types a canvas cannot take are unsupported, whatever else is true of the row", async () => {
    for (const mime of ["image/gif", "image/heic", "image/heif", "image/svg+xml", "application/octet-stream", undefined]) {
      expect(await readEditableAsset(client(row({ mime })).supabase, ORG, PIC), String(mime)).toEqual({ ok: false, error: "unsupported_type" });
    }
    expect((await readEditableAsset(client(row({ mime: "IMAGE/WEBP" })).supabase, ORG, PIC)).ok).toBe(true);
  });

  it("a missing, zero or non-numeric size is no_size; over 16 megapixels is source_too_large with its size; exactly 16 is fine", async () => {
    for (const bad of [{ width: null }, { height: 0 }, { width: "800" }, { width: -1 }, { width: NaN }]) {
      expect(await readEditableAsset(client(row(bad)).supabase, ORG, PIC), JSON.stringify(bad)).toEqual({ ok: false, error: "no_size" });
    }
    expect(await readEditableAsset(client(row({ width: 5000, height: 4000 })).supabase, ORG, PIC)).toEqual({ ok: false, error: "source_too_large", megapixels: 20 });
    expect((await readEditableAsset(client(row({ width: 4000, height: 4000 })).supabase, ORG, PIC)).ok).toBe(true);
    expect((await readEditableAsset(client(row({ width: 4001, height: 4000 })).supabase, ORG, PIC)).ok).toBe(false);
  });

  it("a failed read is 'failed', never 'not found' (a database hiccup must not look like a missing file)", async () => {
    expect(await readEditableAsset(client(null, { message: "boom" }).supabase, ORG, PIC)).toEqual({ ok: false, error: "failed" });
  });
});

// ── the page ─────────────────────────────────────────────────────────────────────────────────

const page = vi.hoisted(() => ({ reads: 0, org: { supported: true, current: { id: "11111111-1111-4111-8111-111111111111" } } as { supported: boolean; current: { id: string } | null }, row: null as unknown, user: { id: "u" } as { id: string } | null }));
class NotFound extends Error {}
vi.mock("next/navigation", () => ({ notFound: () => { throw new NotFound("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true }));
vi.mock("@/lib/channels-server", () => ({ getChannelContext: async () => ({ slug: "chronos" }) }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ ...page.org }) }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ t: en }) };
});
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => page.user,
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { page.reads += 1; return { data: page.row, error: null }; } }) }) }),
  }),
}));
vi.mock("@/components/imageEditor/ImageEditor", () => ({ ImageEditor: (p: Record<string, unknown>) => ({ type: "ImageEditor", props: p }) }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/NotConfigured", () => ({ NotConfigured: () => null }));

const { default: ImageEditorPage } = await import("../app/(app)/[channel]/editor/image/[assetId]/page");

const run = (assetId: string) => ImageEditorPage({ params: Promise.resolve({ assetId }) });
type El = { type: unknown; props: Record<string, unknown> };
/** Every React element and every string in a rendered tree, following props.children only (never a component's type). */
function parts(node: unknown, out: { els: El[]; text: string[] } = { els: [], text: [] }) {
  if (typeof node === "string") out.text.push(node);
  else if (Array.isArray(node)) node.forEach((n) => parts(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as El;
    out.els.push(el);
    parts(el.props?.children, out);
  }
  return out;
}

describe("the page", () => {
  beforeEach(() => {
    page.reads = 0;
    page.org = { supported: true, current: { id: ORG } };
    page.row = row();
    page.user = { id: "u" };
    delete process.env.NIGHTSHIFT_IMAGE_EDITOR;
  });

  it("is a 404 while the switch is off, before any database read", async () => {
    for (const v of [undefined, "", "off", "0"]) {
      if (v === undefined) delete process.env.NIGHTSHIFT_IMAGE_EDITOR;
      else process.env.NIGHTSHIFT_IMAGE_EDITOR = v;
      await expect(run(PIC)).rejects.toBeInstanceOf(NotFound);
    }
    expect(page.reads).toBe(0);
  });

  it("is a 404 for an id that is not a uuid, without a database read", async () => {
    process.env.NIGHTSHIFT_IMAGE_EDITOR = "on";
    for (const bad of ["abc", "../../etc", "1", "' or 1=1 --", PIC.toUpperCase().slice(0, 30)]) await expect(run(bad)).rejects.toBeInstanceOf(NotFound);
    expect(page.reads).toBe(0);
  });

  it("is the SAME 404 for another organization's picture and for a made-up one", async () => {
    process.env.NIGHTSHIFT_IMAGE_EDITOR = "on";
    page.row = row({ org_id: OTHER });
    await expect(run(PIC)).rejects.toBeInstanceOf(NotFound);
    page.row = null;
    await expect(run(PIC)).rejects.toBeInstanceOf(NotFound);
    expect(page.reads).toBe(2);
  });

  it("opens the editor for the open organization's own picture, handing it the library's name and the organization", async () => {
    process.env.NIGHTSHIFT_IMAGE_EDITOR = "on";
    const tree = await run(PIC);
    const { ImageEditor } = await import("../components/imageEditor/ImageEditor");
    const editor = parts(tree).els.find((el) => el.type === ImageEditor);
    expect(editor?.props).toMatchObject({ assetId: PIC, orgId: ORG, name: "cat.jpg", libraryHref: "/chronos/library" });
  });

  it("says why an unsupported or oversized picture cannot be opened instead of mounting the editor", async () => {
    process.env.NIGHTSHIFT_IMAGE_EDITOR = "on";
    const { en } = await import("../lib/i18n/en");
    page.row = row({ mime: "image/gif" });
    const { ImageEditor } = await import("../components/imageEditor/ImageEditor");
    const gif = parts(await run(PIC));
    expect(gif.text).toContain(en.imageEditor.unsupported);
    expect(gif.els.some((el) => el.type === ImageEditor)).toBe(false);
    page.row = row({ width: 5000, height: 4000 });
    const big = parts(await run(PIC));
    expect(big.text).toContain("This picture is 20 megapixels. The editor opens pictures up to 16 megapixels.");
    expect(big.els.some((el) => el.type === ImageEditor)).toBe(false);
  });

  it("asks for a workspace when none is open, without reading the picture", async () => {
    process.env.NIGHTSHIFT_IMAGE_EDITOR = "on";
    page.org = { supported: true, current: null };
    const { en } = await import("../lib/i18n/en");
    expect(parts(await run(PIC)).text).toContain(en.imageEditor.orgRequired);
    expect(page.reads).toBe(0);
  });
});
