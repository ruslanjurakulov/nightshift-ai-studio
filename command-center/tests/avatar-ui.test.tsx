// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { avatarJpeg, jpeg, png } from "./helpers/image-bytes";
import { en } from "../lib/i18n/en";

const h = vi.hoisted(() => ({
  update: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { updateUser: h.update } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: h.toast, error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

const { Avatar } = await import("../components/account/Avatar");
const { AvatarUploader } = await import("../components/account/AvatarUploader");

// jsdom has none of these; every browser the app supports does.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(this);
    });
  };
}
if (!("PointerEvent" in window)) {
  class PE extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "touch";
    }
  }
  (window as unknown as { PointerEvent: typeof PE }).PointerEvent = PE;
}

// A save runs a file read, a canvas encode and two awaited calls; on a busy machine the default 1 s is too tight.
configure({ asyncUtilTimeout: 8000 });

afterEach(() => cleanup());

describe("Avatar", () => {
  it("draws the letter in the account card's circle when there is no photo", () => {
    const { container } = render(<Avatar email="ruslan@example.com" size={32} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.textContent).toBe("R");
    expect(el.dataset.avatar).toBe("initial");
    // the same classes AccountMenu's user card uses today
    for (const cls of ["size-8", "rounded-full", "bg-[var(--color-accent-soft)]", "text-sm", "font-semibold", "text-[var(--color-primary)]"]) {
      expect(el.className).toContain(cls);
    }
    expect(container.querySelector("img")).toBeNull();
  });

  it("draws the neutral person mark when the address has no usable letter or there is no address", () => {
    for (const email of [null, "", ".x@y.test"]) {
      const { container, unmount } = render(<Avatar email={email} />);
      expect(container.querySelector("svg")).not.toBeNull();
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  it("draws the photo, through the route with the version as the only query", () => {
    const { container } = render(<Avatar email="ruslan@example.com" version={1700000000000} size={64} ring />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/avatar?v=1700000000000");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect(img.getAttribute("decoding")).toBe("async");
    expect((container.firstElementChild as HTMLElement).dataset.avatar).toBe("photo");
    expect((container.firstElementChild as HTMLElement).className).toContain("border-[var(--color-border)]");
  });

  it("falls back to the letter when the photo fails to load, and tries again on a new version", () => {
    const { container, rerender } = render(<Avatar email="ana@x.uz" version={5} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
    rerender(<Avatar email="ana@x.uz" version={6} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/avatar?v=6");
  });

  it("ignores a hand-edited version that is not a positive integer", () => {
    for (const v of [0, -1, 1.5, Number.NaN]) {
      const { container, unmount } = render(<Avatar email="ana@x.uz" version={v} />);
      expect(container.querySelector("img")).toBeNull();
      unmount();
    }
  });

  it("puts the e-mail nowhere an assistive technology or a tooltip would read it", () => {
    const email = "ruslan.secret@example.com";
    const { container } = render(<Avatar email={email} version={42} size={96} ring />);
    expect(container.innerHTML).not.toContain("ruslan.secret");
    expect(container.innerHTML).not.toContain("example.com");
    const root = container.firstElementChild!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("[title],[aria-label],[aria-labelledby]")).toBeNull();
    const letter = render(<Avatar email={email} />);
    expect(letter.container.innerHTML).not.toContain("example.com");
    expect(letter.container.querySelector("[title],[aria-label]")).toBeNull();
  });

  it.each([24, 32, 40, 64, 96] as const)("renders at %ipx", (size) => {
    const { container } = render(<Avatar email="a@b.test" size={size} />);
    expect((container.firstElementChild as HTMLElement).className).toMatch(/size-(6|8|10|16|24)\b/);
  });
});

// ── the uploader ────────────────────────────────────────────────────────────

const VERSION = 1_760_000_000_123;
let draw: ReturnType<typeof vi.fn>;
/** What the browser would report for the decoded picture (after EXIF rotation): jsdom decodes nothing. */
let natural: [number, number] = [800, 600];
Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { get: () => natural[0], configurable: true });
Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { get: () => natural[1], configurable: true });
Object.defineProperty(HTMLImageElement.prototype, "decode", { value: () => Promise.resolve(), configurable: true });

function browserStubs(opts: { encoder?: "jpeg" | "png"; natural?: [number, number] } = {}) {
  draw = vi.fn();
  natural = opts.natural ?? [800, 600];
  vi.stubGlobal("createImageBitmap", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({ drawImage: draw, fillRect: vi.fn() })) as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(((cb: BlobCallback, type?: string) => {
    expect(type).toBe("image/jpeg");
    // Safari-style fallback for a format it cannot encode: a PNG whatever was asked
    cb(opts.encoder === "png" ? new Blob([png(256, 256) as unknown as BlobPart], { type: "image/png" }) : new Blob([avatarJpeg() as unknown as BlobPart], { type: "image/jpeg" }));
  }) as never);
  URL.createObjectURL = vi.fn(() => "blob:avatar-preview");
  URL.revokeObjectURL = vi.fn();
}

function okFetch(body: unknown = { ok: true, version: VERSION }, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const photoFile = (bytes = jpeg(800, 600), type = "image/jpeg") => new File([bytes], "me.jpg", { type });

async function pick(file: File) {
  const input = screen.getByTestId("avatar-file") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  // Reading the file is a macrotask in jsdom (FileReader; a browser's Blob.arrayBuffer is quicker). It has to be
  // awaited OUTSIDE act(): React holds the DOM back until act returns, so polling inside it never sees an update.
  await waitFor(() => {
    if (!screen.queryByTestId("avatar-crop") && !screen.queryByTestId("avatar-error")) throw new Error("the picker has not answered yet");
  });
}
const viewport = () => screen.getByTestId("avatar-crop");

beforeEach(() => {
  h.update.mockReset().mockResolvedValue({ data: {}, error: null });
  h.refresh.mockReset();
  h.toast.mockReset();
  browserStubs();
  vi.stubGlobal("fetch", okFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AvatarUploader: idle", () => {
  it("shows the letter, an Add button and the privacy line; no Remove without a photo", () => {
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    expect(screen.getByRole("heading", { name: en.avatar.title })).toBeTruthy();
    expect(screen.getByText("Only you can see your photo.")).toBeTruthy();
    expect(screen.getByRole("button", { name: en.avatar.add })).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.avatar.remove })).toBeNull();
    expect(screen.queryByTestId("avatar-crop")).toBeNull();
    const input = screen.getByTestId("avatar-file") as HTMLInputElement;
    expect(input.accept).toBe("image/png,image/jpeg,image/webp");
  });

  it("with a photo: Change and Remove, and the photo itself", () => {
    const { container } = render(<AvatarUploader email="ruslan@example.com" version={VERSION} />);
    expect(screen.getByRole("button", { name: en.avatar.change })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.avatar.remove })).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`/api/avatar?v=${VERSION}`);
  });
});

describe("AvatarUploader: cropping and saving", () => {
  it("picking a photo opens the crop: focused viewport, circular mask, zoom slider, Save and Cancel", async () => {
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile());
    const vp = viewport();
    expect(document.activeElement).toBe(vp);
    expect(vp.getAttribute("aria-label")).toBe(en.avatar.cropArea);
    expect(vp.getAttribute("aria-describedby")).toBeTruthy();
    expect(vp.querySelector("img")?.getAttribute("src")).toBe("blob:avatar-preview");
    expect(vp.className).toContain("touch-none"); // so a finger drags the photo, not the page
    expect(screen.getByLabelText(en.avatar.zoom)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.avatar.save })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.avatar.cancel })).toBeTruthy();
    expect(screen.getByText(en.avatar.cropHelp)).toBeTruthy();
    // a phone is told about dragging only: the keyboard wording is hidden under a coarse pointer
    expect(screen.getByText(en.avatar.cropHelp).className).toContain("[@media(pointer:coarse)]:hidden");
    expect(screen.getByText(en.avatar.cropHelpTouch).className).toContain("[@media(pointer:coarse)]:inline");
  });

  it("Save re-encodes the chosen square, POSTs the JPEG, records the version and refreshes", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());

    // centre square of an 800x600 picture
    expect(draw).toHaveBeenCalledWith(expect.anything(), 100, 0, 600, 600, 0, 0, 256, 256);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/avatar");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("image/jpeg");
    expect((init.body as Blob).type).toBe("image/jpeg");
    const sent = new Uint8Array(await (init.body as Blob).arrayBuffer());
    expect(Array.from(sent)).toEqual(Array.from(avatarJpeg())); // the bytes the validator accepts
    expect(h.update).toHaveBeenCalledWith({ data: { avatar_v: VERSION } });
    expect(h.toast).toHaveBeenCalledWith(en.avatar.saved);
    expect(screen.queryByTestId("avatar-crop")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`/api/avatar?v=${VERSION}`);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:avatar-preview");
    // focus goes back to the button that opened the crop
    expect(document.activeElement).toBe(screen.getByRole("button", { name: en.avatar.change }));
  });

  it("while saving the section is busy and nothing can be pressed twice", async () => {
    let release: (r: Response) => void = () => {};
    const pending = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", pending);
    const { container } = render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: en.avatar.saving })).toBeTruthy());
    expect((container.querySelector("[data-testid=avatar-uploader]") as HTMLElement).getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: en.avatar.saving }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: en.avatar.cancel }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(en.avatar.zoom) as HTMLInputElement).disabled).toBe(true);
    // the image is re-encoded first (a file read in jsdom); the request is the last thing to be waited for
    await waitFor(() => expect(pending).toHaveBeenCalled());
    await act(async () => {
      release(new Response(JSON.stringify({ ok: true, version: VERSION }), { status: 200 }));
    });
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it("cancel leaves the crop without touching the network", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile());
    fireEvent.click(screen.getByRole("button", { name: en.avatar.cancel }));
    expect(screen.queryByTestId("avatar-crop")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    [429, { error: "rate_limited" }, "rate_limited"],
    [413, { error: "too_large" }, "too_large"],
    [400, { error: "bad_dimensions" }, "bad_dimensions"],
    [403, {}, "forbidden"],
    [401, null, "unauthorized"],
    [415, null, "not_jpeg"],
    [429, null, "rate_limited"],
    [502, { error: "storage_failed" }, "failed"],
    [500, { error: "new row violates row-level security policy for table objects" }, "failed"],
  ] as const)("a %i answer (%j) shows the fixed %s message and keeps the crop for another try", async (status, body, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body === null ? "" : JSON.stringify(body), { status })));
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(en.avatar.errors[code]);
    expect(alert.textContent).not.toMatch(/row-level|objects|storage/i);
    expect(screen.getByTestId("avatar-crop")).toBeTruthy();
    expect(h.update).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: en.avatar.save }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a network failure, or a version that could not be recorded, is the generic message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(en.avatar.errors.failed);

    vi.stubGlobal("fetch", okFetch());
    h.update.mockResolvedValue({ data: null, error: { message: "jwt expired" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    await waitFor(() => expect(h.update).toHaveBeenCalled());
    expect((await screen.findByRole("alert")).textContent).toBe(en.avatar.errors.failed);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("a browser whose canvas cannot encode JPEG says so, with what to do, and uploads nothing", async () => {
    browserStubs({ encoder: "png" });
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(en.avatar.errors.encode_failed);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AvatarUploader: refusing the picked file before anything decodes", () => {
  it("a file declaring 60000 x 60000 is image_too_large and never reaches the decoder or the crop", async () => {
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile(png(60000, 60000), "image/png"));
    expect((await screen.findByRole("alert")).textContent).toBe(en.avatar.errors.image_too_large);
    expect(screen.queryByTestId("avatar-crop")).toBeNull();
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(draw).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("a non-image named .png is unsupported; over 5 MB is too_large", async () => {
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(new File([new TextEncoder().encode("<svg onload=alert(1)>")], "x.png", { type: "image/png" }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.avatar.errors.unsupported);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.jpg", { type: "image/jpeg" });
    await pick(big);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.avatar.errors.too_large));
  });
});

describe("AvatarUploader: keyboard and touch", () => {
  it("arrow keys move the photo and + / - zoom, and Save sends exactly what is shown", async () => {
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile()); // 800x600
    const vp = viewport();
    const img = vp.querySelector("img")!;
    const before = img.style.left;

    fireEvent.keyDown(vp, { key: "ArrowLeft" }); // the photo moves left: the square moves right in the picture
    expect(img.style.left).not.toBe(before);
    fireEvent.keyDown(vp, { key: "ArrowDown" }); // zoom is 1 and the picture is landscape: vertical has no room
    const zoom = screen.getByLabelText(en.avatar.zoom) as HTMLInputElement;
    expect(Number(zoom.value)).toBe(1);
    fireEvent.keyDown(vp, { key: "+" });
    fireEvent.keyDown(vp, { key: "+" });
    expect(Number(zoom.value)).toBeCloseTo(1.2, 5);
    fireEvent.keyDown(vp, { key: "-" });
    expect(Number(zoom.value)).toBeCloseTo(1.1, 5);
    fireEvent.keyDown(vp, { key: "-" });
    fireEvent.keyDown(vp, { key: "-" });
    expect(Number(zoom.value)).toBe(1); // never below 1: the circle is always filled
    for (let i = 0; i < 60; i++) fireEvent.keyDown(vp, { key: "+" });
    expect(Number(zoom.value)).toBe(4);

    // back to a known state, then check the crop that Save sends
    for (let i = 0; i < 40; i++) fireEvent.keyDown(vp, { key: "-" });
    fireEvent.keyDown(vp, { key: "ArrowRight" }); // undo the earlier left move
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    await waitFor(() => expect(draw).toHaveBeenCalled());
    const [, x, y, size] = draw.mock.calls[0];
    expect(size).toBe(600);
    expect(y).toBe(0);
    expect(x).toBeCloseTo(100, 5);
  });

  it("an arrow key moves the crop by a step, and the photo cannot be dragged off the circle", async () => {
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile());
    const vp = viewport();
    fireEvent.keyDown(vp, { key: "ArrowLeft" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    await waitFor(() => expect(draw).toHaveBeenCalled());
    // 5% of the viewport = 5% of a 600px square = 30 source pixels
    expect(draw.mock.calls[0][1]).toBeCloseTo(130, 5);
    cleanup();
    draw.mockClear();
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile());
    for (let i = 0; i < 30; i++) fireEvent.keyDown(viewport(), { key: "ArrowRight", shiftKey: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    await waitFor(() => expect(draw).toHaveBeenCalled());
    expect(draw.mock.calls[0][1]).toBe(0); // stopped at the picture's edge
  });

  it("dragging with a finger (pointer events) moves the photo with it", async () => {
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile());
    const vp = viewport();
    vp.getBoundingClientRect = () => ({ width: 280, height: 280, top: 0, left: 0, right: 280, bottom: 280, x: 0, y: 0, toJSON() {} }) as DOMRect;
    vp.setPointerCapture = vi.fn();
    fireEvent.pointerDown(vp, { pointerId: 7, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerMove(vp, { pointerId: 7, pointerType: "touch", clientX: 172, clientY: 100 }); // 10% of the viewport to the left
    fireEvent.pointerMove(vp, { pointerId: 9, pointerType: "touch", clientX: 0, clientY: 0 }); // another finger: ignored
    fireEvent.pointerUp(vp, { pointerId: 7, pointerType: "touch" });
    fireEvent.pointerMove(vp, { pointerId: 7, pointerType: "touch", clientX: 0, clientY: 0 }); // after release: ignored
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    await waitFor(() => expect(draw).toHaveBeenCalled());
    // 10% of a 600 source-pixel square, to the right
    expect(draw.mock.calls[0][1]).toBeCloseTo(160, 4);
  });

  it("uses the browser's own (rotated) size when the image loads", async () => {
    render(<AvatarUploader email="ruslan@example.com" version={null} />);
    await pick(photoFile()); // header says 800x600
    const img = viewport().querySelector("img")!;
    Object.defineProperty(img, "naturalWidth", { value: 600, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 800, configurable: true });
    fireEvent.load(img);
    natural = [600, 800]; // the <img> the save decodes reports the same rotated size as the preview
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.save }));
    });
    await waitFor(() => expect(draw).toHaveBeenCalled());
    expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 100, 600, 600, 0, 0, 256, 256);
  });
});

describe("AvatarUploader: removing", () => {
  it("DELETEs, clears the version in the metadata, toasts and refreshes", async () => {
    const fetchMock = okFetch({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AvatarUploader email="ruslan@example.com" version={VERSION} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.remove }));
    });
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("DELETE");
    expect(h.update).toHaveBeenCalledWith({ data: { avatar_v: null } });
    expect(h.toast).toHaveBeenCalledWith(en.avatar.removed);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button", { name: en.avatar.remove })).toBeNull();
  });

  it("a failed removal shows a fixed message and keeps the photo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "storage_failed" }), { status: 502 })));
    const { container } = render(<AvatarUploader email="ruslan@example.com" version={VERSION} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.avatar.remove }));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(en.avatar.errors.failed);
    expect(h.update).not.toHaveBeenCalled();
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("follows a new version from the server after a refresh", () => {
    const { container, rerender } = render(<AvatarUploader email="a@b.test" version={null} />);
    expect(container.querySelector("img")).toBeNull();
    rerender(<AvatarUploader email="a@b.test" version={VERSION} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`/api/avatar?v=${VERSION}`);
  });
});
