// @vitest-environment jsdom
/**
 * A picture or a video attached with the Studio composer's [+], and the one kept by the public home page picked up here
 * (lib/creative/attach.ts, components/studio/StudioHome.tsx, GeneratePanel's composer). What would break without these: a picture
 * on Enhance sent to animate instead of upscale, a tool switched without a word (CLAUDE.md #4), a file that skips the library's
 * checked upload, an upload that lands over what the person did meanwhile (or under a press of Generate: a second spend), the home
 * page's file uploaded into whoever signed up in that tab without asking, an attachment that starts a job by itself (CLAUDE.md #3),
 * or a missing home-page file shown as if it were attached (CLAUDE.md #5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
type Rec = import("@/lib/site/pending-attachment").PendingRecord;
const kept: { record: Rec | null } = { record: null };
vi.mock("@/lib/site/pending-attachment", async (orig) => {
  const real = await orig<typeof import("@/lib/site/pending-attachment")>();
  return {
    ...real,
    indexedDbStore: () => ({
      get: async () => kept.record,
      put: async (r: Rec) => {
        kept.record = r;
      },
      delete: async () => {
        kept.record = null;
      },
      take: async (nonce: string) => {
        const r = kept.record;
        if (!r) return null;
        if (r.nonce !== nonce) return "mismatch" as const;
        kept.record = null;
        return r;
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
import { PENDING_TTL_MS, newNonce } from "@/lib/site/pending-attachment";
import { DESK_TOOLS } from "@/lib/creative/desks";
import { needsVideo, type StudioModel } from "@/lib/creative/studio";

const t = dictionaries.en;
const th = t.studioHome;
const ORG = "11111111-1111-4111-8111-111111111111";
const TICKET = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const MODELS: StudioModel[] = [
  { id: "pic", displayName: "Picture", capabilities: ["t2i", "edit", "upscale"], beta: false },
  { id: "clip", displayName: "Clip", capabilities: ["t2v", "i2v"], beta: false },
  { id: "sharp", displayName: "Sharp", capabilities: ["video_upscale"], beta: false },
];

let fetchMock: ReturnType<typeof vi.fn>;
let registeredKind: string;
/** When set, the upload's status read waits for this (an upload still being checked). */
let hold: Promise<void> | null;
let statusAnswer: () => Promise<Response>;
let jobPost: (() => Promise<Response>) | null;
beforeEach(() => {
  kept.record = null;
  registeredKind = "image";
  hold = null;
  jobPost = null;
  statusAnswer = () => json({ status: "ingested", asset_id: ASSET });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/media/uploads" && init?.method === "POST") return json({ ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: "x" });
    if (url === `/api/media/uploads/${TICKET}` && init?.method === "PUT") return json({ ok: true });
    if (url === `/api/media/uploads/${TICKET}`) {
      if (hold) await hold;
      return statusAnswer();
    }
    if (url === `/api/media/${ASSET}`) return json({ asset: { id: ASSET, kind: registeredKind } });
    if (url === "/api/creative/quote") return json({ quote: { credits: 40 } });
    if (url.startsWith("/api/creative/jobs") && init?.method === "POST") return jobPost ? jobPost() : json({ job: { id: "new" } });
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
const uploads = () => calls().filter((c) => c.includes("/api/media/uploads"));
const home = (over: Partial<Parameters<typeof StudioHome>[0]> = {}) => (
  <I18nProvider locale="en">
    <StudioHome orgId={ORG} models={MODELS} credits={{ state: "unknown" }} projects={{ state: "ok", projects: [] }} {...over} />
  </I18nProvider>
);
const pic = () => new File([new Uint8Array(8)], "fox.jpg", { type: "image/jpeg" });
const clip = () => new File([new Uint8Array(8)], "walk.mov", { type: "video/quicktime" });
const composer = () => screen.getByTestId("composer");
const box = () => composer().querySelector("textarea") as HTMLTextAreaElement;
const chooseMode = (name: string) => fireEvent.click(within(screen.getByRole("radiogroup", { name: th.modesLabel })).getByRole("radio", { name: new RegExp(`^${name}`) }));
const attachVia = (f: File) => {
  // As a person does: [+] first (it takes focus out of the words), then the picker's answer.
  fireEvent.click(screen.getByTestId("composer-attach"));
  const input = screen.getByTestId("composer-file") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [f] });
  fireEvent.change(input);
};
const deferred = () => {
  let open: () => void = () => undefined;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const keep = (over: Partial<Rec> = {}): string => {
  const nonce = newNonce();
  kept.record = { blob: new Blob([new Uint8Array(8)], { type: "image/jpeg" }), name: "fox.jpg", type: "image/jpeg", kind: "image", nonce, savedAt: Date.now(), expiresAt: Date.now() + PENDING_TTL_MS, ...over };
  return nonce;
};

describe("the tool an attachment opens", () => {
  // Lens M4: the open desk decides first (Image edits a picture, Enhance upscales it), as its [+] did before the file picker.
  it("follows the open desk; only with no desk (the home page's file) does a picture animate and a video go to the video tool on sale", () => {
    expect(toolForAttachment("image", MODELS, "image")).toBe("edit");
    expect(toolForAttachment("image", MODELS, "video")).toBe("i2v");
    expect(toolForAttachment("image", MODELS, "enhance")).toBe("upscale");
    expect(toolForAttachment("video", MODELS, "enhance")).toBe("video_upscale");
    // A desk with no tool for it: the fallback.
    expect(toolForAttachment("video", MODELS, "image")).toBe("video_upscale");
    expect(toolForAttachment("image", MODELS, null)).toBe("i2v");
    expect(toolForAttachment("image", [], null)).toBe("i2v");
    expect(toolForAttachment("video", MODELS, null)).toBe("video_upscale");
    expect(toolForAttachment("video", [{ id: "e", displayName: "E", capabilities: ["video_edit", "video_upscale"], beta: false }], null)).toBe("video_edit");
    expect(toolForAttachment("video", [], null)).toBe("video_edit");
    for (const c of VIDEO_IN_TOOLS) {
      expect(needsVideo(c)).toBe(true);
      expect(Object.values(DESK_TOOLS).some((d) => d.includes(c))).toBe(true);
    }
  });

  // Re-review nit: Enhance whose upscale nobody sells opened a dead upscale form while its cut-out was on sale.
  it("on a desk, prefers that desk's tool for the file that a model is sold for; with none on sale, its first tool for it", () => {
    const sells = (...capabilities: string[]): StudioModel[] => [{ id: "m", displayName: "M", capabilities, beta: false }];
    expect(toolForAttachment("image", sells("remove_bg"), "enhance")).toBe("remove_bg");
    expect(toolForAttachment("image", sells("relight", "erase"), "enhance")).toBe("relight");
    expect(toolForAttachment("video", sells("video_reframe"), "enhance")).toBe("video_reframe");
    expect(toolForAttachment("image", sells("describe"), "image")).toBe("describe");
    // Nothing of the desk's on sale: its first tool for the file, whose form says it is not on sale (never another desk's tool).
    expect(toolForAttachment("image", [], "enhance")).toBe("upscale");
    expect(toolForAttachment("image", sells("t2i"), "image")).toBe("edit");
    expect(toolForAttachment("video", sells("t2v"), "enhance")).toBe("video_upscale");
    expect(toolForAttachment("image", sells("upscale"), "video")).toBe("i2v");
  });

  it("carries the words a tool takes, cut to its own limit, and none to a tool that takes none", () => {
    expect(attachWords("i2v", "  a fox runs  ")).toBe("a fox runs");
    expect(attachWords("video_upscale", "a fox runs")).toBe("");
    expect(Array.from(attachWords("video_edit", "x".repeat(900)))).toHaveLength(500);
  });
});

describe("the trip into the library", () => {
  const go = (over: Partial<Parameters<typeof uploadAttachment>[0]> = {}) =>
    uploadAttachment({ orgId: ORG, file: pic(), kind: "image", fetchImpl: fetchMock as unknown as typeof fetch, sleep: async () => undefined, ...over });

  it("is the library's own checked upload (ticket, PUT, the worker's verdict), declares the normalized type, and asks no price", async () => {
    const r = await go({ file: new File([new Uint8Array(8)], "IMG.heic", { type: "" }), mime: "image/heic" });
    expect(r).toEqual({ ok: true, assetId: ASSET, kind: "image" });
    expect(calls()).toEqual(["POST /api/media/uploads", `PUT /api/media/uploads/${TICKET}`, `GET /api/media/uploads/${TICKET}`, `GET /api/media/${ASSET}`]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ org_id: ORG, filename: "IMG.heic", mime: "image/heic", bytes: 8 });
    expect(calls().some((c) => c.includes("/api/creative/"))).toBe(false);
  });

  it("takes the kind the worker registered, and refuses a file it did not register as a picture or a video", async () => {
    registeredKind = "video";
    expect(await go()).toMatchObject({ ok: true, kind: "video" });
    registeredKind = "audio";
    expect(await go()).toEqual({ ok: false, error: "wrong_kind" });
  });

  // Lens L2: these answers do not change by asking again; they were "still checking" for three minutes.
  it("a 403, 404 or 410 about the upload is final at once, each with its own words", async () => {
    statusAnswer = () => json({ error: "forbidden" }, 403);
    expect(await go()).toEqual({ ok: false, error: "upload_forbidden" });
    for (const s of [404, 410]) {
      statusAnswer = () => json({ error: "not_found" }, s);
      expect(await go()).toEqual({ ok: false, error: "upload_gone" });
    }
    expect(fetchMock.mock.calls.filter(([u, i]) => u === `/api/media/uploads/${TICKET}` && !i?.method)).toHaveLength(3);
    expect(th.attachFlow.uploadForbidden).not.toBe(th.attachFlow.uploadGone);
  });

  it("stops asking once its signal is aborted (the page was left)", async () => {
    const ctl = new AbortController();
    let asked = 0;
    statusAnswer = () => {
      asked += 1;
      if (asked === 2) ctl.abort();
      return json({ status: "ingesting" });
    };
    expect(await go({ signal: ctl.signal })).toEqual({ ok: false, error: "still_checking" });
    expect(asked).toBe(2);
  });

  // Re-review nit: the signal stopped only the polling; a page left mid-transfer kept sending the file.
  it("hands its signal to the ticket request and the PUT, so an abort stops the transfer itself", async () => {
    const ctl = new AbortController();
    const seen: Array<[string, AbortSignal | undefined, RequestCredentials | undefined]> = [];
    const put = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      seen.push([`${init?.method ?? "GET"} ${url}`, init?.signal ?? undefined, init?.credentials]);
      if (init?.method !== "PUT") return put(url, init);
      // A transfer that runs until it is aborted, the way fetch rejects then.
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const r = go({ signal: ctl.signal });
    await waitFor(() => expect(seen.map((s) => s[0])).toContain(`PUT /api/media/uploads/${TICKET}`));
    ctl.abort();
    expect((await r).ok).toBe(false);
    expect(seen.find((s) => s[0] === "POST /api/media/uploads")?.[1]).toBe(ctl.signal);
    expect(seen.find((s) => s[0].startsWith("PUT "))?.[1]).toBe(ctl.signal);
    // Same-origin cookies as before: the request still sets no credentials mode of its own.
    expect(seen.every((s) => s[2] === undefined)).toBe(true);
    // Nothing was asked about an upload that never finished sending.
    expect(seen.some((s) => s[0] === `GET /api/media/uploads/${TICKET}`)).toBe(false);
  });
});

describe("the Studio composer's [+]", () => {
  it("opens the system picker, uploads through the library, and switches to the open desk's picture tool, said in the panel; nothing is created", async () => {
    render(home());
    const input = screen.getByTestId("composer-file") as HTMLInputElement;
    expect(input.getAttribute("accept")).toContain("image/heic");
    expect(input.hasAttribute("capture")).toBe(false);
    expect(screen.getByTestId("composer-attach").getAttribute("aria-label")).toBe(th.attachFlow.pick);
    fireEvent.change(box(), { target: { value: "the fox wakes up" } });
    attachVia(pic());
    // The Image desk is open: a picture is edited there, as its [+] did before.
    await waitFor(() => expect(composer().getAttribute("data-capability")).toBe("edit"));
    expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.switchedImage.replace("{tool}", t.desk.tools.edit));
    // Inside the panel, in its flow: drawn after it, the line lay over the page's own text under the pinned phone box.
    expect(composer().contains(screen.getByTestId("composer-attach-line"))).toBe(true);
    expect(box().value).toBe("the fox wakes up");
    expect(uploads()).toContain("POST /api/media/uploads");
    expect(creates()).toEqual([]);
  });

  it("on Video a picture animates; on Enhance it is upscaled, a video gets the video tool", async () => {
    render(home());
    chooseMode(th.modes.video);
    attachVia(pic());
    await waitFor(() => expect(composer().getAttribute("data-capability")).toBe("i2v"));
    chooseMode(th.modes.enhance);
    attachVia(pic());
    await waitFor(() => expect(composer().getAttribute("data-capability")).toBe("upscale"));
    registeredKind = "video";
    attachVia(clip());
    await waitFor(() => expect(composer().getAttribute("data-capability")).toBe("video_upscale"));
    expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.switchedVideo.replace("{tool}", t.desk.tools.video_upscale));
    expect(creates()).toEqual([]);
  });

  // Lens M2: the words typed while the file uploads are the ones the box gets. Re-review L2: typing meanwhile is touching the box,
  // so it is not swapped; "Use it in the box" then carries the words as typed, not the ones the upload started with.
  it("words typed while it uploads keep the box as it is; Use it in the box carries them as typed meanwhile", async () => {
    const d = deferred();
    hold = d.p;
    render(home());
    chooseMode(th.modes.video);
    fireEvent.change(box(), { target: { value: "first words" } });
    attachVia(pic());
    await waitFor(() => expect(screen.getByTestId("composer-uploading")).toBeTruthy());
    fireEvent.change(box(), { target: { value: "the fox walks into the light" } });
    const before = composer();
    await act(async () => d.open());
    await waitFor(() => expect(screen.getByTestId("composer-attach-ready")).toBeTruthy());
    expect(composer()).toBe(before);
    expect(composer().getAttribute("data-capability")).toBe("t2v");
    fireEvent.click(screen.getByTestId("composer-attach-use"));
    await waitFor(() => expect(composer().getAttribute("data-capability")).toBe("i2v"));
    expect(box().value).toBe("the fox walks into the light");
  });

  // Re-review L2: the switch is a fresh mount, so a length (or a model, a shape) picked during the upload was thrown away.
  it("a setting changed while it uploads is kept: the box is not remounted, the file is offered instead", async () => {
    const d = deferred();
    hold = d.p;
    render(home());
    chooseMode(th.modes.video);
    attachVia(pic());
    await waitFor(() => expect(screen.getByTestId("composer-uploading")).toBeTruthy());
    fireEvent.click(screen.getByTestId("composer-settings-key"));
    const ten = within(screen.getByRole("group", { name: t.gen.durationLabel })).getAllByRole("button")[1];
    fireEvent.click(ten);
    const before = composer();
    await act(async () => d.open());
    await waitFor(() => expect(screen.getByTestId("composer-attach-ready")).toBeTruthy());
    expect(composer()).toBe(before);
    expect(composer().getAttribute("data-capability")).toBe("t2v");
    expect(ten.getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByRole("group", { name: t.gen.durationLabel })).getAllByRole("button")[1]).toBe(ten);
    expect(creates()).toEqual([]);
  });

  // Re-review L2: the remount autofocused a new box, which takes focus out of the words and breaks an IME composition.
  it("the words box holding focus when it ends is not remounted; focus stays where it was", async () => {
    const d = deferred();
    hold = d.p;
    render(home());
    chooseMode(th.modes.video);
    attachVia(pic());
    await waitFor(() => expect(screen.getByTestId("composer-uploading")).toBeTruthy());
    const words = box();
    act(() => words.focus());
    expect(document.activeElement).toBe(words);
    await act(async () => d.open());
    await waitFor(() => expect(screen.getByTestId("composer-attach-ready")).toBeTruthy());
    expect(box()).toBe(words);
    expect(document.activeElement).toBe(words);
    expect(composer().getAttribute("data-capability")).toBe("t2v");
  });

  it("an untouched box, not focused, is still switched for the file (the automatic switch is kept for that case)", async () => {
    const d = deferred();
    hold = d.p;
    render(home());
    chooseMode(th.modes.video);
    attachVia(pic());
    await waitFor(() => expect(screen.getByTestId("composer-uploading")).toBeTruthy());
    await act(async () => d.open());
    await waitFor(() => expect(composer().getAttribute("data-capability")).toBe("i2v"));
    expect(screen.queryByTestId("composer-attach-ready")).toBeNull();
  });

  // Lens M2: a choice the person made while it uploaded is never overridden; the file is offered instead.
  it("a mode chosen while it uploads stays; the finished file is offered with \"Use it in the box\"", async () => {
    const d = deferred();
    hold = d.p;
    render(home());
    chooseMode(th.modes.video);
    attachVia(pic());
    await waitFor(() => expect(screen.getByTestId("composer-uploading")).toBeTruthy());
    chooseMode(th.modes.image);
    await act(async () => d.open());
    await waitFor(() => expect(screen.getByTestId("composer-attach-ready")).toBeTruthy());
    expect(composer().getAttribute("data-capability")).toBe("t2i");
    fireEvent.click(screen.getByTestId("composer-attach-use"));
    await waitFor(() => expect(composer().getAttribute("data-capability")).toBe("i2v"));
    expect(creates()).toEqual([]);
  });

  // Lens M2: the box is never swapped under a create in flight (a second press would spend twice).
  it("a press of Generate in flight is never swapped out: the file is offered, and the box keeps its one create", async () => {
    const d = deferred();
    hold = d.p;
    let finishJob: (r: Response) => void = () => undefined;
    jobPost = () => new Promise<Response>((r) => (finishJob = r));
    render(home());
    chooseMode(th.modes.video);
    fireEvent.change(box(), { target: { value: "a clip of the sea" } });
    attachVia(pic());
    await waitFor(() => expect(screen.getByTestId("composer-uploading")).toBeTruthy());
    const send = within(composer()).getAllByRole("button").find((b) => b.className.includes("ns-price-button"))!;
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(creates()).toHaveLength(1));
    const before = composer();
    await act(async () => d.open());
    await waitFor(() => expect(screen.getByTestId("composer-attach-ready")).toBeTruthy());
    expect(composer()).toBe(before);
    expect(composer().getAttribute("data-capability")).toBe("t2v");
    expect((screen.getByTestId("composer-attach-use") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finishJob(new Response(JSON.stringify({ job: { id: "new" } }), { status: 200, headers: { "content-type": "application/json" } })));
    expect(creates()).toHaveLength(1);
  });

  it("leaving the page stops asking about the upload", async () => {
    let asked = 0;
    // Each answer takes a moment (a real request does): with the test's instant sleep, a loop of instant answers never yields.
    statusAnswer = () => {
      asked += 1;
      return new Promise<Response>((r) => setTimeout(() => r(new Response(JSON.stringify({ status: "ingesting" }), { status: 200 })), 5));
    };
    const view = render(home());
    attachVia(pic());
    await waitFor(() => expect(asked).toBeGreaterThan(0));
    view.unmount();
    const at = asked;
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(asked).toBeLessThanOrEqual(at + 1);
  });

  it("leaving the page mid-transfer aborts the PUT itself", async () => {
    let putSignal: AbortSignal | null = null;
    const base = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return base(url, init);
      putSignal = init.signal ?? null;
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const view = render(home());
    attachVia(pic());
    await waitFor(() => expect(putSignal).not.toBeNull());
    expect(putSignal!.aborted).toBe(false);
    view.unmount();
    expect(putSignal!.aborted).toBe(true);
  });

  it("refuses a file that is not a picture or a video before anything is sent", () => {
    render(home());
    attachVia(new File(["x"], "a.mp3", { type: "audio/mpeg" }));
    expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.badType);
    expect(uploads()).toEqual([]);
  });

  // Lens L4: one live region, outside the box, that is not remounted when the box is.
  it("speaks through one live region outside the box", async () => {
    render(home());
    const live = screen.getByTestId("composer-attach-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(composer().contains(live)).toBe(false);
    attachVia(pic());
    await waitFor(() => expect(live.textContent).toBe(th.attachFlow.switchedImage.replace("{tool}", t.desk.tools.edit)));
    expect(screen.getByTestId("composer-attach-live")).toBe(live);
    expect(screen.getByTestId("composer-attach-line").getAttribute("role")).toBeNull();
  });
});

describe("the home page's kept file, after sign-up", () => {
  // Lens M3: the tab may not be the visitor's (someone else signed up in it): nothing is uploaded until the person says Use.
  it("is asked about first; Use uploads it through the library and opens the tool for it, prefilled with the words; nothing is created", async () => {
    const nonce = keep();
    render(home({ pending: { nonce, words: "make the fox run" } }));
    await waitFor(() => expect(screen.getByTestId("composer-pending-confirm")).toBeTruthy());
    expect(screen.getByTestId("composer-pending-confirm").textContent).toContain(th.attachFlow.confirmImage);
    expect(uploads()).toEqual([]);
    // Taken out of the browser at once (one transaction), whatever the answer.
    expect(kept.record).toBeNull();
    expect(box().value).toBe("make the fox run");
    fireEvent.click(screen.getByTestId("composer-pending-use"));
    await waitFor(() => expect(composer().getAttribute("data-capability")).toBe("i2v"));
    expect(box().value).toBe("make the fox run");
    expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.switchedImage.replace("{tool}", t.desk.tools.i2v));
    const ticket = JSON.parse(String(fetchMock.mock.calls.find(([u, i]) => u === "/api/media/uploads" && i?.method === "POST")![1].body));
    expect(ticket.filename).toBe("fox.jpg");
    expect(creates()).toEqual([]);
  });

  // Re-review L1: on a shared browser, whoever signs in next saw the first visitor's picture (or video frame) and its file name.
  it("shows neither the file's picture nor its name before Use, only its kind in words; both appear from Use on", async () => {
    const made = vi.fn(() => "blob:local/1");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: made, revokeObjectURL: vi.fn() }));
    const d = deferred();
    hold = d.p;
    const nonce = keep({ name: "passport-scan.jpg" });
    render(home({ pending: { nonce, words: "" } }));
    await waitFor(() => expect(screen.getByTestId("composer-pending-confirm")).toBeTruthy());
    const card = screen.getByTestId("composer-pending-confirm");
    expect(card.querySelector("img, video")).toBeNull();
    expect(card.textContent).toContain(th.attachFlow.confirmImage);
    expect(card.textContent).not.toContain("passport");
    expect(screen.getByTestId("composer-attach-live").textContent).toBe(th.attachFlow.confirmImage);
    expect(document.body.textContent).not.toContain("passport");
    expect(document.querySelector('img[src^="blob:"], video[src^="blob:"]')).toBeNull();
    // The file is never even turned into an address a picture could be drawn from.
    expect(made).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("composer-pending-use"));
    await waitFor(() => expect(screen.getByTestId("composer-uploading")).toBeTruthy());
    expect(screen.getByTestId("composer-uploading").querySelector("img")?.getAttribute("src")).toBe("blob:local/1");
    expect(screen.getByTestId("composer-uploading").textContent).toContain("passport-scan.jpg");
    await act(async () => d.open());
  });

  it("a video kept on the home page is asked about as a video, with no frame of it drawn", async () => {
    const nonce = keep({ name: "beach.mov", type: "video/quicktime", kind: "video", blob: new Blob([new Uint8Array(8)], { type: "video/quicktime" }) });
    render(home({ pending: { nonce, words: "" } }));
    await waitFor(() => expect(screen.getByTestId("composer-pending-confirm")).toBeTruthy());
    const card = screen.getByTestId("composer-pending-confirm");
    expect(card.textContent).toContain(th.attachFlow.confirmVideo);
    expect(card.textContent).not.toContain("beach");
    expect(card.querySelector("img, video")).toBeNull();
  });

  it("Discard uploads nothing and says so", async () => {
    const nonce = keep();
    render(home({ pending: { nonce, words: "" } }));
    await waitFor(() => expect(screen.getByTestId("composer-pending-confirm")).toBeTruthy());
    fireEvent.click(screen.getByTestId("composer-pending-discard"));
    expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.discarded);
    expect(uploads()).toEqual([]);
  });

  it("another link's nonce takes nothing: the file stays for its own link, and the page says none came", async () => {
    keep();
    render(home({ pending: { nonce: newNonce(), words: "" } }));
    await waitFor(() => expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.gone));
    expect(kept.record).not.toBeNull();
    expect(uploads()).toEqual([]);
  });

  it("a file that is not here (another browser, past the hour) is said plainly, and the words still open the clip box", async () => {
    render(home({ pending: { nonce: newNonce(), words: "make the fox run" } }));
    await waitFor(() => expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.gone));
    expect(composer().getAttribute("data-capability")).toBe("t2v");
    expect(box().value).toBe("make the fox run");
    cleanup();
    const nonce = keep({ savedAt: 0, expiresAt: 1 });
    render(home({ pending: { nonce, words: "" } }));
    await waitFor(() => expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.expired));
  });

  it("without a workspace nothing is sent, the kept file is removed, and the line says to attach it again", async () => {
    const nonce = keep();
    window.localStorage.setItem("nightshift.pendingAttach", String(Date.now() + PENDING_TTL_MS));
    render(home({ orgId: null, pending: { nonce, words: "" } }));
    await waitFor(() => expect(screen.getByTestId("composer-attach-line").textContent).toBe(th.attachFlow.noOrg));
    await waitFor(() => expect(kept.record).toBeNull());
    expect(th.attachFlow.noOrg).not.toMatch(/still in this browser/);
    expect(uploads()).toEqual([]);
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
      // Before Use nothing names the file: the question has no {name} to fill.
      expect(f.confirmImage).not.toContain("{");
      expect(f.confirmVideo).not.toContain("{");
      expect(f.confirmImage).not.toBe(f.confirmVideo);
      expect(f.ready).toContain("{name}");
    }
  });
});

describe("the landing's idea (lib/site/idea-handoff.ts, ?idea=1)", () => {
  it("fills the clip box with the kept words once, sends nothing, and leaves no idea behind", async () => {
    const { stashIdea, takeIdea } = await import("@/lib/site/idea-handoff");
    expect(stashIdea("A whale over the city at sunset")).toBe(true);
    window.history.replaceState(null, "", "/all-channels/create?idea=1");
    render(home({ idea: true }));
    await waitFor(() => expect(box().value).toBe("A whale over the city at sunset"));
    // Filled, not sent: no quote or create was asked for, and the address no longer says idea=1.
    expect(creates()).toEqual([]);
    expect(calls().some((c) => c.includes("/api/creative/quote"))).toBe(false);
    expect(window.location.search).not.toContain("idea=");
    expect(takeIdea()).toBeNull();
  });

  it("an image idea (`?idea=1&kind=image`, the start box's Image) fills the picture box (t2i), not the clip box", async () => {
    const { stashIdea } = await import("@/lib/site/idea-handoff");
    expect(stashIdea("A neon noodle bar in the rain")).toBe(true);
    render(home({ idea: true, ideaKind: "image" }));
    await waitFor(() => expect(box().value).toBe("A neon noodle bar in the rain"));
    const modes = within(screen.getByRole("radiogroup", { name: th.modesLabel }));
    expect(modes.getByRole("radio", { name: new RegExp(`^${th.modes.image}`) }).getAttribute("aria-checked")).toBe("true");
    expect(creates()).toEqual([]);
  });

  it("nothing kept (another browser, expired, storage off) is an empty box and no error", async () => {
    render(home({ idea: true }));
    await waitFor(() => expect(box()).toBeTruthy());
    expect(box().value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
