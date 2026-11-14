// @vitest-environment jsdom
/**
 * The landing composer's "+" (components/landing/PromptBar.tsx) and the file it keeps in this browser for the Studio
 * (lib/site/pending-attachment.ts). What would break without these: "+" that only opens a form with nothing attached (the owner's
 * complaint, 2026-11-14), a file sent somewhere from a page with no account, a picker that asks for the camera or drops HEIC, a
 * file the library takes refused here first, a kept file any later sign-in could pick up, a file kept for days, a size limit made
 * up in the browser, or the landing spending anything (CLAUDE.md #3).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

type Rec = import("@/lib/site/pending-attachment").PendingRecord;
const memory: { record: Rec | null; fail: boolean } = { record: null, fail: false };
vi.mock("@/lib/site/pending-attachment", async (orig) => {
  const real = await orig<typeof import("@/lib/site/pending-attachment")>();
  return {
    ...real,
    // The browser's IndexedDB, in memory: jsdom has none. The real adapter is a thin wrapper over the same calls.
    indexedDbStore: () => ({
      get: async () => memory.record,
      put: async (r: Rec) => {
        if (memory.fail) throw new Error("QuotaExceededError");
        memory.record = r;
      },
      delete: async () => {
        memory.record = null;
      },
      take: async (nonce: string) => {
        const r = memory.record;
        if (!r) return null;
        if (r.nonce !== nonce) return "mismatch" as const;
        memory.record = null;
        return r;
      },
    }),
  };
});

import { dictionaries, LOCALES } from "@/lib/i18n";
import { PromptBar } from "@/components/landing/PromptBar";
import {
  ATTACH_ACCEPT,
  NONCE_RE,
  PENDING_MARK,
  PENDING_TTL_MS,
  carriesPending,
  checkAttachment,
  discardPending,
  dropExpired,
  keepPending,
  newNonce,
  takePending,
  type PendingRecord,
  type PendingStore,
} from "@/lib/site/pending-attachment";
import { PENDING_PARAM, attachedHref } from "@/lib/site/prompt-link";
import { ALLOWED_MIME, EXT_MIME, MIME_ALIASES, UPLOAD_ACCEPT, UPLOAD_MAX_BYTES_DEFAULT, normalizeUploadMime } from "@/lib/media";
import { DEFAULT_AFTER_AUTH, afterSignupPath, studioNext } from "@/lib/safe-redirect";

const ROOT = join(__dirname, "..", "..");
const SQL_0044 = readFileSync(join(ROOT, "supabase/migrations/0044_media_heic.sql"), "utf8");
const t = dictionaries.en.site.prompt;

const file = (name: string, type: string, size = 1024) => {
  const f = new File([new Uint8Array(Math.min(size, 16))], name, { type });
  if (size !== Math.min(size, 16)) Object.defineProperty(f, "size", { value: size });
  return f;
};

let assign: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  memory.record = null;
  memory.fail = false;
  assign = vi.fn();
  fetchMock = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  vi.stubGlobal("fetch", fetchMock);
  let n = 0;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => `blob:local/${++n}`, revokeObjectURL: vi.fn() }));
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pick = (container: HTMLElement, f: File) => {
  const input = container.querySelector("input[type='file']") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [f] });
  fireEvent.change(input);
};

describe("the landing composer's \"+\" attaches a real file", () => {
  it("opens the system picker for the library's picture and video types, HEIC named so iOS keeps it, and asks for nothing else", () => {
    const { container } = render(<PromptBar copy={t} ideas={[]} />);
    const input = container.querySelector("input[type='file']") as HTMLInputElement;
    // Derived from the library's own list: its picture and video entries, nothing else.
    expect(ATTACH_ACCEPT).toBe(".jpg,.jpeg,.png,.webp,.gif,.heic,.heif,image/heic,image/heif,.mp4,.m4v,.mov,.webm,.mkv");
    for (const e of ATTACH_ACCEPT.split(",")) expect(UPLOAD_ACCEPT.split(",")).toContain(e);
    expect(input.getAttribute("accept")).toBe(ATTACH_ACCEPT);
    expect(input.hasAttribute("capture")).toBe(false);
    expect(input.hasAttribute("multiple")).toBe(false);
    const click = vi.spyOn(input, "click");
    fireEvent.click(within(container).getByRole("button", { name: t.attach }));
    expect(click).toHaveBeenCalledTimes(1);
    // Choosing reads nothing anywhere: no request, no navigation.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("checks the file against the library's own types and upload cap (0038's default, not a number made up here)", () => {
    const sql = readFileSync(join(ROOT, "supabase/migrations/0038_media_assets.sql"), "utf8");
    expect(sql).toMatch(new RegExp(`max_upload_bytes\\s+bigint not null default ${UPLOAD_MAX_BYTES_DEFAULT}\\b`));
    expect(checkAttachment({ type: "image/png", size: 10 })).toEqual({ ok: true, kind: "image", mime: "image/png" });
    expect(checkAttachment({ type: "video/quicktime", size: 10 })).toEqual({ ok: true, kind: "video", mime: "video/quicktime" });
    expect(checkAttachment({ type: "video/mp4", size: UPLOAD_MAX_BYTES_DEFAULT })).toMatchObject({ ok: true });
    expect(checkAttachment({ type: "video/mp4", size: UPLOAD_MAX_BYTES_DEFAULT + 1 })).toEqual({ ok: false, error: "size", max: UPLOAD_MAX_BYTES_DEFAULT });
    expect(checkAttachment({ type: "image/png", size: 0 })).toEqual({ ok: false, error: "empty" });
    // Not a picture or a video, a type the library does not take, or a nameless type with no extension to read.
    for (const type of ["audio/mpeg", "text/vtt", "image/bmp", "video/avi", "application/pdf", ""]) expect(checkAttachment({ type, size: 10, name: "x" }).ok, type).toBe(false);
    for (const [mime, kind] of Object.entries(ALLOWED_MIME)) if (kind === "image" || kind === "video") expect(checkAttachment({ type: mime, size: 1 })).toMatchObject({ ok: true, kind });
  });

  // Lens M1: Windows Chrome sends '' for a .heic, and browsers send image/jpg, image/pjpeg, image/x-heic, video/x-m4v; the library
  // (0044 media_normalize_mime) takes them all, so refusing them here (while the message named HEIC) refused real files.
  it("reads the type the way the library does: aliases folded, an empty or generic type from the extension", () => {
    expect(checkAttachment({ type: "", size: 10, name: "IMG_0001.HEIC" })).toEqual({ ok: true, kind: "image", mime: "image/heic" });
    expect(checkAttachment({ type: "application/octet-stream", size: 10, name: "clip.mov" })).toEqual({ ok: true, kind: "video", mime: "video/quicktime" });
    expect(checkAttachment({ type: "video/x-m4v", size: 10, name: "a.m4v" })).toEqual({ ok: true, kind: "video", mime: "video/mp4" });
    for (const [alias, to] of [["image/jpg", "image/jpeg"], ["image/pjpeg", "image/jpeg"], ["image/x-heic", "image/heic"], ["image/x-heif", "image/heif"], ["IMAGE/JPEG; q=1", "image/jpeg"]])
      expect(normalizeUploadMime(alias, "x"), alias).toBe(to);
    // The client's tables are 0044's, verbatim.
    for (const [ext, mime] of Object.entries(EXT_MIME)) expect(SQL_0044, ext).toContain(`when '${ext}' then '${mime}'`);
    for (const [alias, mime] of Object.entries(MIME_ALIASES)) expect(SQL_0044, alias).toContain(`when '${alias}' then '${mime}'`);
    expect((SQL_0044.match(/^\s+when '[a-z0-9]+' then '[a-z0-9/.+-]+'$/gm) ?? []).length).toBe(Object.keys(EXT_MIME).length);
  });

  it("an empty-type .heic is attached and kept with the type the upload will declare", async () => {
    const { container } = render(<PromptBar copy={t} ideas={[]} />);
    pick(container, file("IMG_0001.heic", ""));
    expect(container.querySelector("[role='alert']")).toBeNull();
    fireEvent.click(within(container).getByRole("button", { name: t.submit }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(memory.record?.type).toBe("image/heic");
    expect(memory.record?.kind).toBe("image");
  });

  it("shows a picture as a thumbnail chip with a × that removes it, and says a refused file in words", () => {
    const { container } = render(<PromptBar copy={t} ideas={[]} studioOpen />);
    pick(container, file("doc.pdf", "application/pdf"));
    expect(container.querySelector("[role='alert']")?.textContent).toBe(t.badType);
    expect(container.querySelector(".nx-pbar-file")).toBeNull();
    pick(container, file("huge.mp4", "video/mp4", UPLOAD_MAX_BYTES_DEFAULT + 1));
    expect(container.querySelector("[role='alert']")?.textContent).toBe(t.tooBig.replace("{max}", "95 MB"));
    pick(container, file("fox.jpg", "image/jpeg"));
    expect(container.querySelector("[role='alert']")).toBeNull();
    const chip = within(container).getByRole("group", { name: "Attached: fox.jpg" });
    expect(chip.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
    expect(chip.textContent).toContain(t.picture);
    expect((container.querySelector("form.nx-pbar") as HTMLElement).dataset.attached).toBe("image");
    expect(container.textContent).toContain(t.keptOut);
    fireEvent.click(within(chip).getByRole("button", { name: "Remove fox.jpg" }));
    expect(container.querySelector(".nx-pbar-file")).toBeNull();
    expect(container.textContent).not.toContain(t.keptOut);
    pick(container, file("walk.mov", "video/quicktime"));
    expect(within(container).getByRole("group", { name: "Attached: walk.mov" }).querySelector("video")?.getAttribute("src")).toMatch(/^blob:.*#t=0\.1$/);
  });

  it("while no Studio model is on sale the chip promises no video", () => {
    const { container } = render(<PromptBar copy={t} ideas={[]} />);
    pick(container, file("fox.jpg", "image/jpeg"));
    const chip = within(container).getByRole("group", { name: "Attached: fox.jpg" });
    expect(chip.textContent).toContain(t.pictureClosed);
    expect(chip.textContent).not.toContain(t.picture);
    for (const { code } of LOCALES) {
      const c = dictionaries[code].site.prompt;
      for (const closed of [c.pictureClosed, c.videoClosed]) expect(closed).toMatch(/not on sale yet|пока не продаётся|пока не продаются|hali sotuvda emas/);
    }
  });

  it("signed out: keeps the file in this browser only, bound to a fresh nonce the link carries, then goes to sign-up; nothing is sent", async () => {
    const now = Date.now();
    const { container } = render(<PromptBar copy={t} ideas={[]} />);
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "make the fox run through snow" } });
    pick(container, file("fox.jpg", "image/jpeg"));
    fireEvent.click(within(container).getByRole("button", { name: t.submit }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const kept = memory.record as PendingRecord;
    expect(kept.name).toBe("fox.jpg");
    expect(kept.kind).toBe("image");
    expect(kept.nonce).toMatch(NONCE_RE);
    expect(kept.expiresAt - kept.savedAt).toBe(PENDING_TTL_MS);
    expect(kept.savedAt).toBeGreaterThanOrEqual(now);
    const href = assign.mock.calls[0][0] as string;
    expect(href).toBe(attachedHref("make the fox run through snow", false, kept.nonce));
    expect(href.startsWith("/signup?next=")).toBe(true);
    const next = new URL(href, "https://x.test").searchParams.get("next")!;
    expect(studioNext(next)).toBe(next);
    expect(afterSignupPath(next)).not.toBe(DEFAULT_AFTER_AUTH);
    expect(carriesPending(next)).toBe(true);
    const q = new URL(next, "https://x.test").searchParams;
    expect(q.get(PENDING_PARAM)).toBe(kept.nonce);
    expect(q.get("prompt")).toBe("make the fox run through snow");
    expect(q.has("tool")).toBe(false);
    expect(q.has("model")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signed in: the same, straight to the Studio's composer", async () => {
    const { container } = render(<PromptBar copy={t} ideas={[]} signedIn />);
    pick(container, file("walk.mov", "video/quicktime"));
    expect(container.textContent).toContain(t.keptIn);
    fireEvent.keyDown(container.querySelector("textarea")!, { key: "Enter" });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign).toHaveBeenCalledWith(`/all-channels/create?${PENDING_PARAM}=${memory.record!.nonce}`);
    expect(memory.record?.kind).toBe("video");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Lens L1: the navigation left the send key busy; back from the next page (the browser's page cache) it stayed off for good.
  it("is usable again when the browser brings the page back from its cache", async () => {
    const { container } = render(<PromptBar copy={t} ideas={[]} />);
    pick(container, file("fox.jpg", "image/jpeg"));
    fireEvent.click(within(container).getByRole("button", { name: t.submit }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const go = within(container).getByRole("button", { name: t.submit }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    });
    expect(go.disabled).toBe(true);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });
    expect(go.disabled).toBe(false);
  });

  it("a browser that will not keep the file says so and stays (never a Studio that would then report the file missing)", async () => {
    memory.fail = true;
    const { container } = render(<PromptBar copy={t} ideas={[]} />);
    pick(container, file("fox.jpg", "image/jpeg"));
    await act(async () => {
      fireEvent.click(within(container).getByRole("button", { name: t.submit }));
    });
    await waitFor(() => expect(container.querySelector("[role='alert']")?.textContent).toBe(t.keepFailed));
    expect(assign).not.toHaveBeenCalled();
  });

  // The live audit (1440): the dock floated over the page's last rows and the footer, and its placeholder wrapped to a clipped line.
  it("leaves the page's end free: room the size of the dock, and an empty dock steps away over the footer (never with words in it)", () => {
    const sheet = readFileSync(join(ROOT, "command-center/components/site/site-next.css"), "utf8");
    let seen: IntersectionObserverCallback = () => undefined;
    vi.stubGlobal("IntersectionObserver", class { constructor(c: IntersectionObserverCallback) { seen = c; } observe() {} disconnect() {} unobserve() {} });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const foot = document.createElement("footer");
    foot.className = "st-footer";
    document.body.appendChild(foot);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 3000 });
    const { container } = render(<PromptBar copy={t} ideas={[]} />);
    const form = container.querySelector("form.nx-pbar") as HTMLFormElement;
    expect(form.dataset.docked).toBe("true");
    // (--nx-dock-h itself is written on <html> from the box's height; jsdom drops custom properties, so the browser run checks it.)
    expect(form.dataset.away).toBeUndefined();
    act(() => seen([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(form.dataset.away).toBe("true");
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "a fox" } });
    expect(form.dataset.away).toBeUndefined();
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "" } });
    act(() => seen([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(form.dataset.away).toBeUndefined();
    foot.remove();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    expect(sheet).toMatch(/\.nx-pbar\[data-docked="true"\]\[data-away="true"\] \{[^}]*visibility: hidden;/);
    expect(sheet).toMatch(/html\[data-composer="docked"\] \.nx \{ padding-bottom: calc\(var\(--nx-dock-h, 62px\) \+ 34px \+ env\(safe-area-inset-bottom\)\); \}/);
    expect(sheet).toMatch(/\.nx-pbar-box::placeholder \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
    expect(sheet).toMatch(/\.nx-pbar:has\(\.nx-pbar-box:focus-visible\) \{ outline: 3px solid/);
    for (const { code } of LOCALES) expect(dictionaries[code].site.prompt.placeholder.length, code).toBeLessThanOrEqual(32);
  });

  it("every string it shows is in en, ru and uz", () => {
    const keys = Object.keys(dictionaries.en.site.prompt).sort();
    for (const { code } of LOCALES) {
      const c = dictionaries[code].site.prompt as Record<string, string>;
      expect(Object.keys(c).sort()).toEqual(keys);
      for (const k of keys) expect(c[k].trim().length, `${code}.${k}`).toBeGreaterThan(0);
      expect(c.tooBig).toContain("{max}");
      expect(c.attached).toContain("{name}");
      expect(c.remove).toContain("{name}");
    }
  });
});

describe("the file kept for the Studio", () => {
  const memoryStore = (): PendingStore & { record: PendingRecord | null } => {
    const s = {
      record: null as PendingRecord | null,
      get: async () => s.record,
      put: async (r: PendingRecord) => {
        s.record = r;
      },
      delete: async () => {
        s.record = null;
      },
      take: async (nonce: string) => {
        const r = s.record;
        if (!r) return null;
        if (r.nonce !== nonce) return "mismatch" as const;
        s.record = null;
        return r;
      },
    };
    return s;
  };
  const mark = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it("is taken once, for its own link's nonce only, within the hour", async () => {
    const store = memoryStore();
    const m = mark();
    const nonce = await keepPending(file("fox.jpg", "image/jpeg"), "image", store, { now: 1000, mark: m });
    expect(nonce).toMatch(NONCE_RE);
    expect(m.m.get(PENDING_MARK)).toBe(String(1000 + PENDING_TTL_MS));
    // Lens M3: another link (another visitor's, an old one, a guess) takes nothing, and leaves it for its own link.
    expect(await takePending(store, newNonce(), 1000, m)).toEqual({ state: "missing" });
    expect(await takePending(store, "pending", 1000, m)).toEqual({ state: "missing" });
    expect(store.record).not.toBeNull();
    const got = await takePending(store, nonce, 1000 + PENDING_TTL_MS - 1, m);
    expect(got.state).toBe("ready");
    if (got.state === "ready") {
      expect(got.kind).toBe("image");
      expect(got.file.name).toBe("fox.jpg");
      expect(got.file.type).toBe("image/jpeg");
    }
    expect(store.record).toBeNull();
    expect(m.m.has(PENDING_MARK)).toBe(false);
    expect(await takePending(store, nonce, 1000, m)).toEqual({ state: "missing" });
  });

  it("two tabs taking at once: one gets it, the other is told it is missing", async () => {
    const store = memoryStore();
    const nonce = await keepPending(file("fox.jpg", "image/jpeg"), "image", store, { now: 1000, mark: null });
    const [a, b] = await Promise.all([takePending(store, nonce, 1000, null), takePending(store, nonce, 1000, null)]);
    expect([a.state, b.state].sort()).toEqual(["missing", "ready"]);
  });

  it("past the hour it is gone, and says so; no storage at all is its own answer", async () => {
    const store = memoryStore();
    const nonce = await keepPending(file("fox.jpg", "image/jpeg"), "image", store, { now: 1000, mark: null });
    expect(await takePending(store, nonce, 1000 + PENDING_TTL_MS, null)).toEqual({ state: "expired" });
    expect(store.record).toBeNull();
    expect(await takePending(null, nonce, 0, null)).toEqual({ state: "unavailable" });
    await expect(keepPending(file("fox.jpg", "image/jpeg"), "image", null, { now: 0, mark: null })).rejects.toThrow();
  });

  it("is cleared by a sign-in that does not carry its link, and by sign-out", async () => {
    const store = memoryStore();
    const m = mark();
    const nonce = await keepPending(file("fox.jpg", "image/jpeg"), "image", store, { now: 1000, mark: m });
    expect(carriesPending(`/all-channels/create?attach=${nonce}&prompt=x`)).toBe(true);
    expect(carriesPending("/command-center")).toBe(false);
    expect(carriesPending("/all-channels/create?attach=pending")).toBe(false);
    await discardPending(store, m);
    expect(store.record).toBeNull();
    expect(m.m.has(PENDING_MARK)).toBe(false);
    const login = readFileSync(join(ROOT, "command-center/app/login/page.tsx"), "utf8");
    expect(login).toContain("if (!carriesPending(destination)) await discardPending();");
    const signOut = readFileSync(join(ROOT, "command-center/components/account/AccountParts.tsx"), "utf8");
    expect(signOut).toContain("await discardPending();");
  });

  it("a stale one is cleared on the landing and on every app page, without opening storage when nothing is kept", async () => {
    const store = memoryStore();
    const m = mark();
    const del = vi.spyOn(store, "delete");
    await dropExpired(store, 5000, m);
    expect(del).not.toHaveBeenCalled();
    await keepPending(file("fox.jpg", "image/jpeg"), "image", store, { now: 1000, mark: m });
    await dropExpired(store, 1000 + PENDING_TTL_MS - 1, m);
    expect(store.record).not.toBeNull();
    await dropExpired(store, 1000 + PENDING_TTL_MS, m);
    expect(store.record).toBeNull();
    expect(m.m.has(PENDING_MARK)).toBe(false);
    const layout = readFileSync(join(ROOT, "command-center/app/(app)/layout.tsx"), "utf8");
    expect(layout).toContain("<PendingSweep />");
  });
});

describe("the prompt link's hidden-character set", () => {
  // Lens nit: the class held literal bidi overrides and zero-width marks (a trojan-source flag in review tools); it is written in
  // escapes, ASCII only.
  it("is written as \\u escapes, and the file holds no invisible or bidi characters", () => {
    const src = readFileSync(join(ROOT, "command-center/lib/site/prompt-link.ts"), "utf8");
    expect(src).toContain("const HIDDEN = /[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]/g;");
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(src)).toBe(false);
  });
});
