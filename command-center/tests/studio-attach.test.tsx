// @vitest-environment jsdom
/**
 * A picture or a video attached with the Studio composer's [+], and the one kept by the public home page picked up here
 * (lib/creative/attach.ts, components/studio/StudioHome.tsx, GeneratePanel's composer). What would break without these: a video
 * opened in a picture tool, a tool switched without a word (CLAUDE.md #4), a file that skips the library's checked upload, an
 * attachment that starts a job by itself (CLAUDE.md #3), or a missing home-page file shown as if it were attached (CLAUDE.md #5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/all-channels/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/all-channels${p}` }));
const kept: { record: unknown } = { record: null };
vi.mock("@/lib/site/pending-attachment", async (orig) => {
  const real = await orig<typeof import("@/lib/site/pending-attachment")>();
  return {
    ...real,
    indexedDbStore: () => ({
      get: async () => kept.record as never,
      put: async (r: unknown) => {
        kept.record = r;
      },
      delete: async () => {
        kept.record = null;
      },
    }),
  };
});
// The page's wait between asking about the upload: no real 1.5 s pauses in a test.
vi.mock("@/lib/creative/attach", async (orig) => {
  const real = await orig<typeof import("@/lib/creative/attach")>();
  return { ...real, uploadAttachment: (i: Parameters<typeof real.uploadAttachment>[0]) => real.uploadAttachment({ ...i, sleep: async () => undefined }) };
});

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, LOCALES } from "@/lib/i18n";
import { StudioHome } from "@/components/studio/StudioHome";
import { VIDEO_IN_TOOLS, attachWords, toolForAttachment, uploadAttachment } from "@/lib/creative/attach";
import { PENDING_TTL_MS } from "@/lib/site/pending-attachment";
import { DESK_TOOLS } from "@/lib/creative/desks";
import { needsVideo, type StudioModel } from "@/lib/creative/studio";

const t = dictionaries.en;
const th = t.studioHome;
const ORG = "11111111-1111-4111-8111-111111111111";
const TICKET = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const MODELS: StudioModel[] = [
  { id: "pic", displayName: "Picture", capabilities: ["t2i", "edit"], beta: false },
  { id: "clip", displayName: "Clip", capabilities: ["t2v", "i2v"], beta: false },
  { id: "sharp", displayName: "Sharp", capabilities: ["video_upscale"], beta: false },
];

let fetchMock: ReturnType<typeof vi.fn>;
let registeredKind: string;
beforeEach(() => {
  kept.record = null;
  registeredKind = "image";
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/media/uploads" && init?.method === "POST") return json({ ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: "x" });
    if (url === `/api/media/uploads/${TICKET}` && init?.method === "PUT") return json({ ok: true });
    if (url === `/api/media/uploads/${TICKET}`) return json({ status: "ingested", asset_id: ASSET });
    if (url === `/api/media/${ASSET}`) return json({ asset: { id: ASSET, kind: registeredKind } });
    if (url === "/api/creative/quote") return json({ quote: { credits: 40 } });
    if (url.startsWith("/api/creative/jobs") && init?.method === "POST") return json({ job: { id: "new" } });
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
    if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:local/1", revokeObjectURL: vi.fn() }));
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const calls = () => fetchMock.mock.calls.map(([u, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${u}`);
const creates = () => calls().filter((c) => c.startsWith("POST /api/creative/jobs"));
const home = (over: Partial<Parameters<typeof StudioHome>[0]> = {}) => (
  <I18nProvider locale="en">
    <StudioHome orgId={ORG} models={MODELS} credits={{ state: "unknown" }} projects={{ state: "ok", projects: [] }} {...over} />
  </I18nProvider>
);
const pic = () => new File([new Uint8Array(8)], "fox.jpg", { type: "image/jpeg" });
const clip = () => new File([new Uint8Array(8)], "walk.mov", { type: "video/quicktime" });

describe("the tool an attachment opens", () => {
  it("a picture animates (picture to video); a video opens the first video tool a model is sold for, else the video edit, said as not on sale", () => {
    expect(toolForAttachment("image", MODELS)).toBe("i2v");
    expect(toolForAttachment("image", [])).toBe("i2v");
    expect(toolForAttachment("video", MODELS)).toBe("video_upscale");
    expect(toolForAttachment("video", [{ id: "e", displayName: "E", capabilities: ["video_edit", "video_upscale"], beta: false }])).toBe("video_edit");
    expect(toolForAttachment("video", [])).toBe("video_edit");
    // Every one of them starts from a library video, and lives on a composer desk.
    for (const c of VIDEO_IN_TOOLS) {
      expect(needsVideo(c)).toBe(true);
      expect(Object.values(DESK_TOOLS).some((d) => d.includes(c))).toBe(true);
    }
  });

  it("carries the words a tool takes, cut to its own limit, and none to a tool that takes none", () => {
    expect(attachWords("i2v", "  a fox runs  ")).toBe("a fox runs");
    expect(attachWords("video_upscale", "a fox runs")).toBe("");
    expect(Array.from(attachWords("video_edit", "x".repeat(900)))).toHaveLength(500);
  });
});

describe("the trip into the library", () => {
  it("is the library's own checked upload (ticket, PUT, the worker's verdict) and asks no price and starts nothing", async () => {
    const r = await uploadAttachment({ orgId: ORG, file: pic(), kind: "image", fetchImpl: fetchMock as unknown as typeof fetch, sleep: async () => undefined });
    expect(r).toEqual({ ok: true, assetId: ASSET, kind: "image" });
    expect(calls()).toEqual(["POST /api/media/uploads", `PUT /api/media/uploads/${TICKET}`, `GET /api/media/uploads/${TICKET}`, `GET /api/media/${ASSET}`]);
    const ticket = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(ticket).toEqual({ org_id: ORG, filename: "fox.jpg", mime: "image/jpeg", bytes: 8 });
    expect(calls().some((c) => c.includes("/api/creative/"))).toBe(false);
  });

  it("takes the kind the worker registered, and refuses a file it did not register as a picture or a video", async () => {
    registeredKind = "video";
    expect(await uploadAttachment({ orgId: ORG, file: pic(), kind: "image", fetchImpl: fetchMock as unknown as typeof fetch, sleep: async () => undefined })).toMatchObject({ ok: true, kind: "video" });
    registeredKind = "audio";
    expect(await uploadAttachment({ orgId: ORG, file: pic(), kind: "image", fetchImpl: fetchMock as unknown as typeof fetch, sleep: async () => undefined })).toEqual({ ok: false, error: "wrong_kind" });
  });
});

describe("the Studio composer's [+]", () => {
  it("opens the system picker for a picture or a video, uploads through the library, and switches to picture to video, said in one line; nothing is created", async () => {
    render(home());
    const input = screen.getByTestId("composer-file") as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe("image/*,video/*");
    expect(input.hasAttribute("capture")).toBe(false);
    expect(screen.getByTestId("composer-attach").getAttribute("aria-label")).toBe(th.attachFlow.pick);
    fireEvent.change(screen.getByTestId("composer").querySelector("textarea")!, { target: { value: "the fox wakes up" } });
    Object.defineProperty(input, "files", { configurable: true, value: [pic()] });
    fireEvent.change(input);
    await waitFor(() => expect(screen.getByTestId("composer").getAttribute("data-capability")).toBe("i2v"));
    expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.switchedImage.replace("{tool}", t.desk.tools.i2v));
    // Inside the panel, in its flow: drawn after it, the line lay over the page's own text under the pinned phone box.
    expect(screen.getByTestId("composer").contains(screen.getByTestId("composer-attach-line"))).toBe(true);
    expect((screen.getByTestId("composer").querySelector("textarea") as HTMLTextAreaElement).value).toBe("the fox wakes up");
    expect(calls()).toContain("POST /api/media/uploads");
    expect(creates()).toEqual([]);
  });

  it("a video goes to the video tool on sale; the person can still pick another tool", async () => {
    registeredKind = "video";
    render(home());
    const input = screen.getByTestId("composer-file") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [clip()] });
    fireEvent.change(input);
    await waitFor(() => expect(screen.getByTestId("composer").getAttribute("data-capability")).toBe("video_upscale"));
    expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.switchedVideo.replace("{tool}", t.desk.tools.video_upscale));
    const tabs = within(screen.getByTestId("composer-tools")).getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(1);
    expect(creates()).toEqual([]);
  });

  it("refuses a file that is not a picture or a video before anything is sent", () => {
    render(home());
    const input = screen.getByTestId("composer-file") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "a.mp3", { type: "audio/mpeg" })] });
    fireEvent.change(input);
    expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.badType);
    expect(calls().some((c) => c.includes("/api/media/uploads"))).toBe(false);
  });
});

describe("the home page's kept file, picked up after sign-up", () => {
  it("is uploaded through the library and opens the tool for it, prefilled with the words; nothing is created", async () => {
    kept.record = { blob: new Blob([new Uint8Array(8)], { type: "image/jpeg" }), name: "fox.jpg", type: "image/jpeg", kind: "image", savedAt: Date.now(), expiresAt: Date.now() + PENDING_TTL_MS };
    render(home({ pending: { words: "make the fox run" } }));
    await waitFor(() => expect(screen.getByTestId("composer").getAttribute("data-capability")).toBe("i2v"));
    expect((screen.getByTestId("composer").querySelector("textarea") as HTMLTextAreaElement).value).toBe("make the fox run");
    expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.switchedImage.replace("{tool}", t.desk.tools.i2v));
    // Taken out of the browser once.
    expect(kept.record).toBeNull();
    const ticket = JSON.parse(String(fetchMock.mock.calls.find(([u, i]) => u === "/api/media/uploads" && i?.method === "POST")![1].body));
    expect(ticket.filename).toBe("fox.jpg");
    expect(creates()).toEqual([]);
  });

  it("a file that is not here (another browser, past the hour) is said plainly, and the words still open the clip box", async () => {
    render(home({ pending: { words: "make the fox run" } }));
    await waitFor(() => expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.gone));
    expect(screen.getByTestId("composer").getAttribute("data-capability")).toBe("t2v");
    expect((screen.getByTestId("composer").querySelector("textarea") as HTMLTextAreaElement).value).toBe("make the fox run");
    expect(calls().some((c) => c.includes("/api/media/uploads"))).toBe(false);
    cleanup();
    kept.record = { blob: new Blob(["x"]), name: "old.jpg", type: "image/jpeg", kind: "image", savedAt: 0, expiresAt: 1 };
    render(home({ pending: { words: "" } }));
    await waitFor(() => expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.expired));
  });

  it("without a workspace nothing is taken or sent, and the line says why", async () => {
    kept.record = { blob: new Blob(["x"]), name: "fox.jpg", type: "image/jpeg", kind: "image", savedAt: Date.now(), expiresAt: Date.now() + PENDING_TTL_MS };
    render(home({ orgId: null, pending: { words: "" } }));
    await waitFor(() => expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.noOrg));
    expect(kept.record).not.toBeNull();
    expect(calls().some((c) => c.includes("/api/media/uploads"))).toBe(false);
  });

  it("every attach line is in en, ru and uz", () => {
    const keys = Object.keys(th.attachFlow).sort();
    for (const { code } of LOCALES) {
      const f = dictionaries[code].studioHome.attachFlow as Record<string, string>;
      expect(Object.keys(f).sort()).toEqual(keys);
      for (const k of keys) expect(f[k].trim().length, `${code}.${k}`).toBeGreaterThan(0);
      expect(f.switchedImage).toContain("{tool}");
      expect(f.switchedVideo).toContain("{tool}");
      expect(f.uploading).toContain("{name}");
    }
  });
});
