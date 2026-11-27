// @vitest-environment jsdom
/**
 * Breach on the i2v sample handoff (claude/nsai-s8-i2v-handoff): `sample=<job>` -> lib/site/sample-source.ts on the server ->
 * GenerateSection's "Use this picture" -> lib/creative/sample-preload.ts (fetch of the shipped poster, the library's ordinary
 * upload, dedupe by GET /api/media?org=&q=<name> and a sessionStorage memory, then `sample=` swapped for `source=`).
 *
 * What would break: the address making the Studio fetch or upload anything but the site's own poster; a crafted search answer, a
 * tampered tab memory or another member's file being adopted as "the sample picture" (and then animated on the victim's credits);
 * anything read, written or quoted for a visitor who never presses the key (CLAUDE.md #3); attacker text reaching the DOM.
 *
 * Two tests here FAIL on the branch as attacked and must stay failing until fixed (see each one's comment):
 *   - a co-member's planted file with the copy's name and size is adopted as the sample's picture;
 *   - pressing again after "still being checked" makes a second copy, though the key promises "copied into your library once".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/studio/GeneratePanel", () => ({
  GeneratePanel: (p: Record<string, unknown>) => {
    panel.props.push(p);
    return <div data-testid="panel" />;
  },
}));
const panel = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@/components/studio/JobFeed", () => ({ JobFeed: () => <div data-testid="feed" /> }));
vi.mock("@/components/studio/TemplateGallery", () => ({ TemplateGallery: () => null }));
vi.mock("@/components/studio/Availability", () => ({ DeskAvailabilityNote: () => null, NothingOnSaleNote: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/all-channels/create",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/all-channels${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { GenerateSection } from "@/components/studio/GenerateSection";
import { SHOWCASE_ENTRIES, type ShowcaseEntry } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { SAMPLE_PARAM, resolveSampleSource, sampleSourcePicture, type SampleSource } from "@/lib/site/sample-source";
import { SAMPLE_ASSET_KEY, copySample, findSampleCopy, type SamplePicture } from "@/lib/creative/sample-preload";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-0000-4000-8000-0000000000b6";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CO_MEMBER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ASSET = "22222222-2222-4222-8222-222222222222";
const PLANT = "66666666-6666-4666-8666-666666666666";
const FOREIGN = "7777abcd-7777-4777-8777-77777777abcd";
const TICKET = "33333333-3333-4333-8333-333333333333";

const I2V = SHOWCASE_ENTRIES.filter((e) => e.capability === "i2v");
const FILES = Object.fromEntries(Object.keys(SHOWCASE_FILES).map((k) => [k, { poster: `/_next/static/media/poster.${k.slice(0, 8)}.webp` }]));
const RESOLVABLE = I2V.filter((e) => resolveSampleSource(e.jobId, { capability: "i2v" }, SHOWCASE_ENTRIES, FILES)?.state === "ready");
const SOURCE_JOB = "e3da9148-f2f8-443e-95b1-8ed36ef3dea4";
const READY: Extract<SampleSource, { state: "ready" }> = {
  state: "ready",
  sampleId: "fc1fad12-16de-4cd5-9cd9-e77ed245f469",
  src: "/_next/static/media/poster.abc.webp",
  name: "sample-e3da9148.webp",
  sourceJobId: SOURCE_JOB,
  width: 1280,
  height: 720,
};
const PIC: SamplePicture = { sampleId: READY.sampleId, src: READY.src, name: READY.name, sourceJobId: SOURCE_JOB, width: 1280, height: 720 };
const I2V_FORM = { capability: "i2v" as const, model: "", prompt: "drift", aspect: "16:9", duration: 5, sourceId: null };

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

// ── the server half: `sample=` never names anything but a shipped poster ─────────────────────────────────────────────────

describe("resolveSampleSource: hostile `sample=` values (held)", () => {
  const id = RESOLVABLE[0].jobId;
  it.each([
    ["encoded slash", `${id}%2F..%2Fx`],
    ["double-encoded traversal", "..%252F..%252Fetc"],
    ["backslash host", "/\\evil.example/x.webp"],
    ["data: URL", "data:image/webp;base64,UklGRg=="],
    ["javascript: with an id after", `javascript:${id}`],
    ["id with a trailing newline", `${id}\n`],
    ["id with surrounding space", ` ${id} `],
    ["id with a NUL", `${id}\u0000`],
    ["id with a fullwidth digit", id.replace(/[0-9]/, "０")],
    ["a 1 MB value", "a".repeat(1 << 20)],
    ["constructor", "constructor"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["null", null],
    ["an object with toString", { toString: () => id }],
    ["a one-item array", [id]],
  ])("refused: %s", (_l, raw) => {
    expect(resolveSampleSource(raw, { capability: "i2v", sourceId: null }, SHOWCASE_ENTRIES, FILES)).toEqual({ state: "refused" });
  });

  it("a 1 MB value is refused quickly (no regex blow-up on the page's server render)", () => {
    const t = performance.now();
    resolveSampleSource(`${"0".repeat(8)}-`.repeat(100_000), { capability: "i2v" }, SHOWCASE_ENTRIES, FILES);
    expect(performance.now() - t).toBeLessThan(200);
  });

  it("an i2v entry whose input is a VIDEO entry, a site_art input, or itself, never resolves to a poster", () => {
    const clip = SHOWCASE_ENTRIES.find((e) => e.kind !== "image")!;
    const base = RESOLVABLE[0];
    const mk = (input: ShowcaseEntry["input"]): ShowcaseEntry => ({ ...base, jobId: "12345678-1234-4234-8234-123456789012", input });
    const files = { ...FILES, [clip.jobId]: { poster: "/_next/static/media/clip.webp" }, "12345678-1234-4234-8234-123456789012": { poster: "/_next/static/media/self.webp" } };
    for (const input of [
      { kind: "operator_job", jobId: clip.jobId, assetId: null },
      { kind: "operator_job", jobId: "12345678-1234-4234-8234-123456789012", assetId: null },
      { kind: "site_art", path: "/_next/static/media/art.webp" },
    ] as unknown as ShowcaseEntry["input"][]) {
      const e = mk(input);
      expect(sampleSourcePicture(e.jobId, [...SHOWCASE_ENTRIES, e], files), JSON.stringify(input)).toBeNull();
    }
  });

  it("a files map with an own `__proto__` key (JSON.parse makes one) is not a way in", () => {
    const files = JSON.parse('{"__proto__":{"poster":"//evil.example/x.webp"}}') as Record<string, { poster?: unknown }>;
    for (const e of RESOLVABLE) expect(sampleSourcePicture(e.jobId, SHOWCASE_ENTRIES, files)).toBeNull();
  });

  it("the form already has a source (the person's own `source=`): `sample=` cannot override it", () => {
    expect(resolveSampleSource(RESOLVABLE[0].jobId, { capability: "i2v", sourceId: FOREIGN }, SHOWCASE_ENTRIES, FILES)).toBeNull();
  });
});

// ── the client half, unit layer ────────────────────────────────────────────────────────────────────────────────────────

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("copySample: what the client fetches and trusts (held)", () => {
  it.each([
    "https://evil.example/x.webp",
    "//evil.example/x.webp",
    "/\\evil.example/x.webp",
    "data:image/webp;base64,UklGRg==",
    "javascript:alert(1)//.webp",
    "/_next/static/../../api/media/x.webp",
    "/api/media/22222222-2222-4222-8222-222222222222?variant=original",
  ])("a tampered src (%s) is never fetched and nothing is uploaded", async (src) => {
    const f = vi.fn(async (url: string) => (String(url).startsWith("/api/media?") ? json({ assets: [] }) : json({}, 404)));
    const r = await copySample({ orgId: ORG, sample: { ...PIC, src }, fetchImpl: f as unknown as typeof fetch, storage: memStore() });
    expect(r).toEqual({ ok: false, error: "picture_unavailable" });
    const urls = f.mock.calls.map(([u]) => String(u));
    expect(urls).not.toContain(src);
    expect(urls.every((u) => u.startsWith("/api/media?"))).toBe(true);
  });

  it("a tab memory naming ANOTHER org's asset: the read is refused by RLS (404) and it is not adopted", async () => {
    const store = memStore({ [`${SAMPLE_ASSET_KEY}:${ORG}:${SOURCE_JOB}`]: FOREIGN });
    const f = vi.fn(async (url: string) => {
      if (url === `/api/media/${FOREIGN}`) return json({ error: "not_found" }, 404);
      if (url.startsWith("/api/media?")) return json({ assets: [] });
      if (url === PIC.src) return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([82, 73, 70, 70])], { type: "image/webp" }) };
      if (url === "/api/media/uploads") return json({ ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: PIC.name });
      if (url === `/api/media/uploads/${TICKET}`) return json({ status: "ingested", asset_id: ASSET });
      if (url === `/api/media/${ASSET}`) return json({ asset: { id: ASSET, kind: "image" } });
      return json({}, 404);
    });
    const r = await copySample({ orgId: ORG, sample: PIC, fetchImpl: f as unknown as typeof fetch, storage: store, sleep: async () => {} });
    expect(r).toMatchObject({ ok: true, assetId: ASSET, reused: false });
    expect(store.m.get(`${SAMPLE_ASSET_KEY}:${ORG}:${SOURCE_JOB}`)).toBe(ASSET);
  });

  it.each(["x&tool=t2v", "../../api/admin", "<img src=x onerror=alert(1)>", FOREIGN.toUpperCase(), `${FOREIGN}?org=${OTHER_ORG}`])(
    "a tampered tab memory that is not an id (%s) never reaches a URL",
    async (bad) => {
      const store = memStore({ [`${SAMPLE_ASSET_KEY}:${ORG}:${SOURCE_JOB}`]: bad });
      const f = vi.fn(async () => json({ assets: [] }));
      await copySample({ orgId: ORG, sample: { ...PIC, src: "//evil.example/x.webp" }, fetchImpl: f as unknown as typeof fetch, storage: store });
      for (const [u] of f.mock.calls as unknown as [string][]) expect(String(u)).not.toContain(bad);
    },
  );

  it("the name search asks for the caller's own org (the prop), and a crafted answer is adopted only on an exact image match", async () => {
    const crafted = [
      { id: "../../x", kind: "image", name: PIC.name, width: 1280, height: 720 },
      { id: FOREIGN.toUpperCase(), kind: "image", name: PIC.name, width: 1280, height: 720 },
      { id: FOREIGN, kind: "video", name: PIC.name, width: 1280, height: 720 },
      { id: FOREIGN, kind: "image", name: PIC.name.toUpperCase(), width: 1280, height: 720 },
      { id: FOREIGN, kind: "image", name: `${PIC.name} `, width: 1280, height: 720 },
      { id: FOREIGN, kind: "image", name: `x${PIC.name}`, width: 1280, height: 720 },
      { id: FOREIGN, kind: "image", name: PIC.name, width: "1280", height: 720 },
      null,
      "string",
    ];
    const f = vi.fn(async () => json({ assets: crafted }));
    expect(await findSampleCopy(f as unknown as typeof fetch, ORG, PIC)).toBeNull();
    const asked = new URL(String((f.mock.calls as unknown as [string][])[0][0]), "https://app.example");
    expect(asked.pathname).toBe("/api/media");
    expect(asked.searchParams.get("org")).toBe(ORG);
    expect(asked.searchParams.get("q")).toBe(PIC.name);
    // A non-array, a 500, a thrown fetch: "not found", never an id.
    for (const ans of [json({ assets: { id: FOREIGN } }), json({}, 500)])
      expect(await findSampleCopy((async () => ans) as unknown as typeof fetch, ORG, PIC)).toBeNull();
    expect(await findSampleCopy((async () => { throw new Error("x"); }) as unknown as typeof fetch, ORG, PIC)).toBeNull();
  });

  /**
   * BROKEN (fails on the branch). Any member of the workspace (request_upload, 0128: `is_org_member`, so a viewer too) can upload
   * any 1280x720 picture named `sample-e3da9148.webp`. The dedupe trusts name + measured size alone, so when another member presses
   * "Use this picture" the planted file becomes the form's source, no upload happens, and the form says "The sample picture is in
   * your library and is this form's picture" (CLAUDE.md #5: an assumption shown as a fact). The victim then animates the
   * planter's picture on the workspace's credits. The planted row is marked as the co-member's (`created_by`); the victim's own
   * earlier copy is not adopted here either unless it is the victim's (fix: match the uploader as well, or keep a server-side marker).
   */
  it("BROKEN: a co-member's planted file with the copy's exact name and size is not adopted as the sample's picture", async () => {
    const planted = { id: PLANT, kind: "image", name: PIC.name, width: 1280, height: 720, source: "upload", created_by: CO_MEMBER, createdBy: CO_MEMBER };
    const f = vi.fn(async () => json({ assets: [planted] }));
    expect(await findSampleCopy(f as unknown as typeof fetch, ORG, PIC)).not.toBe(PLANT);
  });
});

// ── the client half, rendered ──────────────────────────────────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
let library: Array<Record<string, unknown>> = [];
let ingest: "ingested" | "pending" = "ingested";
const posts = () => fetchMock.mock.calls.filter(([, i]) => ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "POST").map(([u]) => String(u));
const nonGets = () => fetchMock.mock.calls.filter(([, i]) => ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() !== "GET");
const last = () => panel.props[panel.props.length - 1];
const sourceAsked = () => (last()?.sourceRequest as { id: string } | null | undefined)?.id ?? null;
const section = (sample: SampleSource | null) => (
  <I18nProvider locale="en">
    <GenerateSection orgId={ORG} models={[]} desk="video" initial={I2V_FORM} sample={sample} />
  </I18nProvider>
);

beforeEach(() => {
  panel.props = [];
  library = [];
  ingest = "ingested";
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  // The address also carries an `org=` an attacker added: the client must not read it.
  window.history.replaceState(null, "", `/all-channels/create?tool=i2v&org=${OTHER_ORG}&${SAMPLE_PARAM}=${READY.sampleId}`);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === READY.src) return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: "image/webp" }) };
    if (url.startsWith("/api/media?") && method === "GET") return json({ assets: library });
    if (url === "/api/media/uploads" && method === "POST") return json({ ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: READY.name });
    if (url === `/api/media/uploads/${TICKET}` && method === "PUT") return json({ ok: true });
    if (url === `/api/media/uploads/${TICKET}`) {
      if (ingest === "pending") return json({ status: "pending" });
      library = [{ id: ASSET, kind: "image", name: READY.name, width: 1280, height: 720, created_by: ME, createdBy: ME }];
      return json({ status: "ingested", asset_id: ASSET });
    }
    if (url === `/api/media/${ASSET}`) return json({ asset: { id: ASSET, kind: "image" } });
    if (url === `/api/media/${PLANT}`) return json({ asset: { id: PLANT, kind: "image" } });
    return json({ jobs: [], templates: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GenerateSection under attack", () => {
  it("held: a poisoned tab memory is not even read on load; nothing is fetched, written or quoted until the press", async () => {
    sessionStorage.setItem(`${SAMPLE_ASSET_KEY}:${ORG}:${SOURCE_JOB}`, FOREIGN);
    render(section(READY));
    await new Promise((r) => setTimeout(r, 200));
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.includes("/api/media") || u.includes("/api/creative") || u === READY.src)).toEqual([]);
    expect(nonGets()).toEqual([]);
    expect(sourceAsked()).toBeNull();
  });

  it("held: the search uses the workspace the server gave, not an `org=` in the address", async () => {
    render(section(READY));
    fireEvent.click(screen.getByTestId("sample-use"));
    await waitFor(() => expect(sourceAsked()).toBe(ASSET), { timeout: 4000 });
    const searches = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/media?"));
    expect(searches.length).toBeGreaterThan(0);
    for (const s of searches) expect(new URLSearchParams(s.split("?")[1]).get("org")).toBe(ORG);
    const upload = fetchMock.mock.calls.find(([u, i]) => u === "/api/media/uploads" && (i as RequestInit).method === "POST")!;
    expect(JSON.parse(String((upload[1] as RequestInit).body)).org_id).toBe(ORG);
    // The swap writes only a library id into the address.
    expect(new URL(window.location.href).searchParams.get("source")).toBe(ASSET);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/creative"))).toBe(false);
  }, 8000);

  it("held: no attacker-chosen text reaches the DOM (the note is dictionary text only; name and src are never printed)", () => {
    const evil = { ...READY, name: `<img src=x onerror="window.__xss=1">.webp`, sampleId: `"><script>window.__xss=1</script>` };
    const { container } = render(section(evil));
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.textContent).not.toContain("onerror");
    expect(container.textContent).not.toContain("<script>");
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  /** BROKEN (fails on the branch): the rendered consequence of the planted-file dedupe above. */
  it(
    "BROKEN: a co-member's planted same-name, same-size file does not become the form's source as 'the sample picture'",
    async () => {
      library = [{ id: PLANT, kind: "image", name: READY.name, width: 1280, height: 720, source: "upload", created_by: CO_MEMBER, createdBy: CO_MEMBER }];
      render(section(READY));
      fireEvent.click(screen.getByTestId("sample-use"));
      await waitFor(() => expect(sourceAsked()).not.toBeNull(), { timeout: 4000 });
      expect(sourceAsked()).not.toBe(PLANT);
      expect(new URL(window.location.href).searchParams.get("source")).not.toBe(PLANT);
    },
    8000,
  );
});

describe("the press while the worker is slow", () => {
  /**
   * BROKEN, low (fails on the branch). The key says "It is copied into your library once". An upload still being checked when the
   * page stops waiting (3 min) is in neither the tab memory nor the name search (assets only, not uploads), so the next press
   * uploads ANOTHER copy; each later press while the worker lags adds one more, each counted against the workspace's storage.
   * Fix: remember the pending ticket (sessionStorage) and poll it on the next press instead of starting a new upload.
   */
  it("BROKEN: pressing again after 'still being checked' does not upload a second copy", async () => {
    ingest = "pending";
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const store = memStore();
    const first = await copySample({ orgId: ORG, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: store, ...clock });
    expect(first).toMatchObject({ ok: false, error: "still_checking" });
    t = 0;
    await copySample({ orgId: ORG, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: store, ...clock });
    expect(posts().filter((u) => u === "/api/media/uploads")).toHaveLength(1);
  });
});
