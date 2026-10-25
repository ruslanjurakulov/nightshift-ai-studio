// @vitest-environment jsdom
/**
 * The image editor in the browser layer, with the Konva canvas, the Konva export and the colour pass replaced by
 * stand-ins (jsdom has no canvas) and fetch faked: the states a picture can be in (loading, failed, unsupported, too
 * large, ready), the edits (turn, crop shape, colours, text, shapes, undo, redo), and saving (preparing, saving, saved,
 * every refusal, one request per press, the original never named in the upload).
 * What would break without these: a save button lit with nothing to save, a double press that uploads twice, a refusal
 * shown as success, a picture over 16 megapixels reaching the canvas, an AI link that points at the wrong tool or
 * picture, a sixth-and-twentieth-layer overflow, an undo that does not undo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { en } from "../lib/i18n/en";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("konva", () => ({ default: {} }));
const preview = vi.hoisted(() => ({ ok: true, opaque: [] as unknown[] }));
vi.mock("@/components/imageEditor/render", () => ({
  renderBase: (...a: unknown[]) => {
    preview.opaque.push(a[5]);
    return preview.ok ? document.createElement("canvas") : null;
  },
  previewScale: () => 1,
}));
const exporter = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/components/imageEditor/scene", () => ({ exportPicture: (...a: unknown[]) => exporter.fn(...a), addLayerNodes: () => new Map() }));
const keyed = vi.hoisted(() => ({ results: [] as unknown[] }));
vi.mock("@/components/imageEditor/EditorCanvas", () => ({
  EditorCanvas: (p: {
    tool: string; label: string; view: { w: number; h: number }; layers: unknown[]; ratio: number | null;
    onKey: (a: { type: string; dx?: number; dy?: number; dir?: number }) => boolean;
  }) => (
    <div data-testid="canvas" data-tool={p.tool} data-layers={p.layers.length} data-view={`${p.view.w}x${p.view.h}`} data-ratio={String(p.ratio)} aria-label={p.label}>
      <button onClick={() => keyed.results.push(p.onKey({ type: "move", dx: 1, dy: 0 }))}>key-move</button>
      <button onClick={() => keyed.results.push(p.onKey({ type: "resize", dx: 1, dy: 0 }))}>key-resize</button>
      <button onClick={() => keyed.results.push(p.onKey({ type: "cycle", dir: 1 }))}>key-cycle</button>
      <button onClick={() => keyed.results.push(p.onKey({ type: "remove" }))}>key-remove</button>
    </div>
  ),
}));

const { ImageEditor } = await import("../components/imageEditor/ImageEditor");

const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "33333333-3333-4333-8333-333333333333";
const TICKET = "55555555-5555-4555-8555-555555555555";

const media = { mime: "image/png", width: 400, height: 300, kind: "image", status: 200, served: true };
const natural = { width: 400, height: 300, fail: false };
const calls: { url: string; method?: string; body?: unknown }[] = [];
let uploadPlan: { ticket: Response | (() => Response); put: Response | (() => Response) };

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = natural.width;
  naturalHeight = natural.height;
  set src(_v: string) {
    setTimeout(() => (natural.fail ? this.onerror?.() : this.onload?.()), 0);
  }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  calls.length = 0;
  Object.assign(media, { mime: "image/png", width: 400, height: 300, kind: "image", status: 200, served: true });
  Object.assign(natural, { width: 400, height: 300, fail: false });
  preview.ok = true;
  preview.opaque.length = 0;
  keyed.results.length = 0;
  exporter.fn.mockReset();
  exporter.fn.mockResolvedValue(new Blob([new Uint8Array(500)], { type: "image/png" }));
  uploadPlan = { ticket: json(200, { ok: true, ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: "cat-edited.png" }), put: json(200, { ok: true }) };
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
      if (url.startsWith("/api/media/uploads/")) return typeof uploadPlan.put === "function" ? uploadPlan.put() : uploadPlan.put.clone();
      if (url === "/api/media/uploads") return typeof uploadPlan.ticket === "function" ? uploadPlan.ticket() : uploadPlan.ticket.clone();
      if (url.startsWith("/api/media/"))
        return json(media.status, { asset: { kind: media.kind, mime: media.mime, width: media.width, height: media.height }, urls: { original: "/f/x" }, served: media.served });
      return json(404, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const e = en.imageEditor;
async function open() {
  render(<ImageEditor assetId={PIC} orgId={ORG} name="cat.png" libraryHref="/chronos/library" />);
  return await screen.findByTestId("canvas");
}
const saveButton = () => screen.getByRole("button", { name: e.save }) as HTMLButtonElement;
const tool = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("the states of the picture", () => {
  it("says it is opening the picture first", () => {
    render(<ImageEditor assetId={PIC} orgId={ORG} name="cat.png" libraryHref="/l" />);
    expect(screen.getByText(e.loading)).toBeTruthy();
  });

  it("a picture that cannot be fetched is an error with Try again, and Try again asks again", async () => {
    media.status = 502;
    render(<ImageEditor assetId={PIC} orgId={ORG} name="cat.png" libraryHref="/l" />);
    expect(await screen.findByText(e.imageFailed)).toBeTruthy();
    media.status = 200;
    fireEvent.click(screen.getByRole("button", { name: e.retry }));
    expect(await screen.findByTestId("canvas")).toBeTruthy();
    expect(calls.filter((c) => c.url === `/api/media/${PIC}`)).toHaveLength(2);
  });

  it("a picture the browser cannot decode is the same error", async () => {
    natural.fail = true;
    render(<ImageEditor assetId={PIC} orgId={ORG} name="cat.png" libraryHref="/l" />);
    expect(await screen.findByText(e.imageFailed)).toBeTruthy();
  });

  it.each(["image/gif", "image/heic", "image/svg+xml"])("%s is unsupported: a sentence and the Library link, no canvas", async (mime) => {
    media.mime = mime;
    render(<ImageEditor assetId={PIC} orgId={ORG} name="x" libraryHref="/chronos/library" />);
    expect(await screen.findByText(e.unsupported)).toBeTruthy();
    expect(screen.queryByTestId("canvas")).toBeNull();
    expect(screen.getByRole("link", { name: e.libraryLink }).getAttribute("href")).toBe("/chronos/library");
  });

  it("a picture over 16 megapixels is refused with its size BEFORE it is downloaded", async () => {
    media.width = 5000;
    media.height = 4000;
    render(<ImageEditor assetId={PIC} orgId={ORG} name="x" libraryHref="/l" />);
    expect(await screen.findByText("This picture is 20 megapixels. The editor opens pictures up to 16 megapixels.")).toBeTruthy();
    expect(screen.queryByTestId("canvas")).toBeNull();
  });

  it("exactly 16 megapixels is accepted, 16.000001 is not; and the size the browser really decoded wins over the library's note", async () => {
    media.width = 4000;
    media.height = 4000;
    natural.width = 4000;
    natural.height = 4000;
    expect(await open()).toBeTruthy();
    cleanup();
    natural.width = 4001;
    render(<ImageEditor assetId={PIC} orgId={ORG} name="x" libraryHref="/l" />);
    expect(await screen.findByText(/This picture is 16 megapixels\. The editor opens pictures up to 16 megapixels\./)).toBeTruthy();
  });

  it("a library row with no size is its own sentence", async () => {
    media.width = 0;
    render(<ImageEditor assetId={PIC} orgId={ORG} name="x" libraryHref="/l" />);
    expect(await screen.findByText(e.noSize)).toBeTruthy();
  });

  it("a video or an unserved file is the generic failure", async () => {
    media.kind = "video";
    render(<ImageEditor assetId={PIC} orgId={ORG} name="x" libraryHref="/l" />);
    expect(await screen.findByText(e.imageFailed)).toBeTruthy();
  });
});

describe("editing", () => {
  it("starts with nothing to save: the Save key is off and says why", async () => {
    await open();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(e.nothingToSave)).toBeTruthy();
    expect(screen.getByRole("button", { name: e.undo }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("The new file will be 400 × 300 px.")).toBeTruthy();
  });

  it("turning swaps the saved size, lights Save, and undo / redo go back and forth", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: e.rotateRight }));
    expect(screen.getByText("The new file will be 300 × 400 px.")).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: e.undo }));
    expect(screen.getByText("The new file will be 400 × 300 px.")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: e.redo }));
    expect(screen.getByText("The new file will be 300 × 400 px.")).toBeTruthy();
  });

  it("Ctrl+Z undoes and Ctrl+Shift+Z redoes, also while a field, a slider or a select has focus", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: e.rotateLeft }));
    const canvas = screen.getByTestId("canvas");
    fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
    expect(screen.getByText("The new file will be 400 × 300 px.")).toBeTruthy();
    fireEvent.keyDown(canvas, { key: "z", ctrlKey: true, shiftKey: true });
    expect(screen.getByText("The new file will be 300 × 400 px.")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText(e.cropW), { key: "z", ctrlKey: true });
    expect(screen.getByText("The new file will be 400 × 300 px.")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText(e.cropW), { key: "Z", metaKey: true, shiftKey: true });
    expect(screen.getByText("The new file will be 300 × 400 px.")).toBeTruthy();
    tool(e.tools.adjust);
    fireEvent.change(screen.getByLabelText(e.brightness), { target: { value: "30" } });
    fireEvent.keyDown(screen.getByLabelText(e.brightness), { key: "z", ctrlKey: true });
    expect((screen.getByLabelText(e.brightness) as HTMLInputElement).value).toBe("0");
    fireEvent.keyDown(screen.getByLabelText(e.brightness), { key: "y", ctrlKey: true });
    expect((screen.getByLabelText(e.brightness) as HTMLInputElement).value).toBe("30");
    tool(e.tools.text);
    fireEvent.click(screen.getByRole("button", { name: e.addText }));
    fireEvent.keyDown(screen.getByLabelText(e.font), { key: "z", ctrlKey: true });
    expect(screen.getByTestId("canvas").getAttribute("data-layers")).toBe("0");
  });

  it("announces 'Undone.' every time, even twice in a row (the live region text must change)", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: e.rotateRight }));
    fireEvent.click(screen.getByRole("button", { name: e.rotateRight }));
    const region = () => document.querySelector("p.sr-only[aria-live]")!.textContent!;
    fireEvent.click(screen.getByRole("button", { name: e.undo }));
    const first = region();
    fireEvent.click(screen.getByRole("button", { name: e.undo }));
    const second = region();
    expect(first.trim()).toBe(e.announceUndo);
    expect(second.trim()).toBe(e.announceUndo);
    expect(second).not.toBe(first);
  });

  it("the canvas swallows a key only when it did something: not in Adjust or AI, not with no layer picked", async () => {
    await open();
    fireEvent.click(screen.getByText("key-move"));
    fireEvent.click(screen.getByText("key-resize"));
    fireEvent.click(screen.getByText("key-cycle"));
    fireEvent.click(screen.getByText("key-remove"));
    expect(keyed.results).toEqual([true, true, false, false]); // crop: move and resize yes; cycle / delete mean nothing there
    keyed.results.length = 0;
    for (const name of [e.tools.adjust, e.tools.ai]) {
      tool(name);
      for (const k of ["key-move", "key-resize", "key-cycle", "key-remove"]) fireEvent.click(screen.getByText(k));
    }
    expect(keyed.results).toEqual(Array(8).fill(false));
    keyed.results.length = 0;
    tool(e.tools.text);
    for (const k of ["key-move", "key-cycle", "key-remove"]) fireEvent.click(screen.getByText(k));
    expect(keyed.results).toEqual([false, false, false]); // no text yet
    keyed.results.length = 0;
    fireEvent.click(screen.getByRole("button", { name: e.addText }));
    fireEvent.click(screen.getByText("key-move"));
    fireEvent.click(screen.getByText("key-cycle"));
    expect(keyed.results).toEqual([true, true]);
    fireEvent.click(screen.getByText("key-remove"));
    expect(keyed.results.at(-1)).toBe(true);
    expect(screen.getByTestId("canvas").getAttribute("data-layers")).toBe("0");
  });

  it("a crop shape gives the largest centred crop of that shape; free keeps what there is; Remove crop clears it", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    expect(screen.getByText("The new file will be 300 × 300 px.")).toBeTruthy();
    expect(screen.getByTestId("canvas").getAttribute("data-ratio")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "9:16" }));
    expect(screen.getByText("The new file will be 168 × 300 px.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: e.cropReset }));
    expect(screen.getByText("The new file will be 400 × 300 px.")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("typing a width on a locked shape moves the height, and a crop is never larger than the picture", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    fireEvent.focus(screen.getByLabelText(e.cropW));
    fireEvent.change(screen.getByLabelText(e.cropW), { target: { value: "120" } });
    expect(screen.getByText("The new file will be 120 × 120 px.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(e.cropW), { target: { value: "9999" } });
    expect(screen.getByText("The new file will be 300 × 300 px.")).toBeTruthy();
  });

  it("turning drops a locked crop shape back to free (its sides swapped)", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "4:5" }));
    expect(screen.getByTestId("canvas").getAttribute("data-ratio")).toBe("0.8");
    fireEvent.click(screen.getByRole("button", { name: e.rotateRight }));
    expect(screen.getByTestId("canvas").getAttribute("data-ratio")).toBe("null");
  });

  it("the canvas shows the whole picture while cropping and only the crop in the other tools", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    expect(screen.getByTestId("canvas").getAttribute("data-view")).toBe("400x300");
    tool(e.tools.adjust);
    expect(screen.getByTestId("canvas").getAttribute("data-view")).toBe("300x300");
  });

  it("colours light Save and reset puts them back (and Save goes off again)", async () => {
    await open();
    tool(e.tools.adjust);
    expect(screen.getByRole("button", { name: e.adjustReset }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(e.brightness), { target: { value: "30" } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: e.adjustReset }));
    expect(saveButton().disabled).toBe(true);
  });

  it("a slider drag is one undo step", async () => {
    await open();
    tool(e.tools.adjust);
    const slider = screen.getByLabelText(e.brightness);
    for (const v of ["5", "10", "20", "40"]) fireEvent.change(slider, { target: { value: v } });
    fireEvent.click(screen.getByRole("button", { name: e.undo }));
    expect((screen.getByLabelText(e.brightness) as HTMLInputElement).value).toBe("0");
    expect(screen.getByRole("button", { name: e.undo }).hasAttribute("disabled")).toBe(true);
  });

  it("adds text, edits its words, moves it by number and removes it; at most 20 layers", async () => {
    await open();
    tool(e.tools.text);
    expect(screen.getByText(e.noText)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: e.addText }));
    expect(screen.getByTestId("canvas").getAttribute("data-layers")).toBe("1");
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(e.textLabel), { target: { value: "SALE" } });
    expect(screen.getByRole("button", { name: "Select Text: SALE" })).toBeTruthy();
    fireEvent.focus(screen.getByLabelText(e.posX));
    fireEvent.change(screen.getByLabelText(e.posX), { target: { value: "50" } });
    expect((screen.getByLabelText(e.posX) as HTMLInputElement).value).toBe("50");
    fireEvent.change(screen.getByLabelText(e.fontSize), { target: { value: "64" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove Text: SALE" }));
    expect(screen.getByTestId("canvas").getAttribute("data-layers")).toBe("0");
    for (let i = 0; i < 22; i += 1) {
      const add = screen.getByRole("button", { name: e.addText }) as HTMLButtonElement;
      if (!add.disabled) fireEvent.click(add);
    }
    expect(screen.getByTestId("canvas").getAttribute("data-layers")).toBe("20");
    expect((screen.getByRole("button", { name: e.addText }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("At most 20 layers.")).toBeTruthy();
  });

  it("text colour accepts a swatch; shapes come in three kinds with their own fields", async () => {
    await open();
    tool(e.tools.text);
    fireEvent.click(screen.getByRole("button", { name: e.addText }));
    fireEvent.click(screen.getByRole("button", { name: "Colour #ef4444" }));
    expect((screen.getByLabelText(e.color) as HTMLInputElement).value).toBe("#ef4444");
    tool(e.tools.shapes);
    fireEvent.click(screen.getByRole("button", { name: e.addRect }));
    expect(screen.getByLabelText(e.shapeW)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: e.addLine }));
    expect(screen.getByLabelText(e.lineLength)).toBeTruthy();
    expect(screen.getByLabelText(e.lineAngle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: e.addEllipse }));
    expect(screen.getByRole("button", { name: "Select Ellipse 1" })).toBeTruthy();
    expect(screen.getByTestId("canvas").getAttribute("data-layers")).toBe("4");
  });

  it("a layer is shown in its own tab only", async () => {
    await open();
    tool(e.tools.text);
    fireEvent.click(screen.getByRole("button", { name: e.addText }));
    tool(e.tools.shapes);
    expect(screen.getByText(e.noShapes)).toBeTruthy();
    expect(screen.queryByLabelText(e.textLabel)).toBeNull();
  });
});

describe("the AI tools", () => {
  it("are links into Studio for this very picture, one per existing operation, and nothing is called", async () => {
    await open();
    const before = calls.length;
    tool(e.tools.ai);
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["upscale", "remove_bg", "expand", "relight", "erase"].map((t) => `/chronos/create?tool=${t}&source=${PIC}`));
    expect(screen.getByText(e.aiNote)).toBeTruthy();
    expect(calls.length).toBe(before);
  });
});

describe("saving", () => {
  async function edited() {
    await open();
    fireEvent.click(screen.getByRole("button", { name: e.rotateRight }));
  }

  it("flattens, asks the existing ticket route for a NEW file named after the original, PUTs it, and says it is being checked", async () => {
    await edited();
    fireEvent.click(saveButton());
    expect(await screen.findByText("Saved. cat-edited.png is being checked and will appear in your Library in a moment.")).toBeTruthy();
    const post = calls.find((c) => c.url === "/api/media/uploads")!;
    expect(post.method).toBe("POST");
    expect(post.body).toEqual({ org_id: ORG, filename: "cat-edited.png", mime: "image/png", bytes: 500 });
    const put = calls.find((c) => c.url === `/api/media/uploads/${TICKET}`)!;
    expect(put.method).toBe("PUT");
    // the state exported is the state on screen: turned right, no crop, png
    const [, , src, state, format] = exporter.fn.mock.calls[0];
    expect(src).toEqual({ width: 400, height: 300 });
    expect(state).toMatchObject({ rotation: 90, mirrored: false, crop: null });
    expect(format).toBe("png");
    // the original is only ever READ: nothing is sent to its own address except the GET for its link
    expect(calls.filter((c) => c.url === `/api/media/${PIC}` && c.method !== undefined)).toEqual([]);
    expect(screen.getByRole("link", { name: e.savedLink }).getAttribute("href")).toBe("/chronos/library");
  });

  it("JPEG is chosen on purpose and named .jpg", async () => {
    await edited();
    fireEvent.change(screen.getByLabelText(e.formatLabel), { target: { value: "jpeg" } });
    exporter.fn.mockResolvedValue(new Blob([new Uint8Array(300)], { type: "image/jpeg" }));
    fireEvent.click(saveButton());
    await screen.findByText(/is being checked/);
    expect(calls.find((c) => c.url === "/api/media/uploads")!.body).toMatchObject({ filename: "cat-edited.jpg", mime: "image/jpeg", bytes: 300 });
    expect(exporter.fn.mock.calls[0][4]).toBe("jpeg");
  });

  it("shows preparing, then saving, with the key off, and a second press uploads nothing more", async () => {
    await edited();
    let release: (r: Response) => void = () => {};
    uploadPlan.put = () => new Response("{}", { status: 200 });
    const pending = new Promise<Response>((r) => (release = r));
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      if (url === "/api/media/uploads") return pending;
      return json(200, { asset: { kind: "image", mime: "image/png", width: 400, height: 300 }, urls: { original: "/f/x" }, served: true });
    });
    fireEvent.click(saveButton());
    await screen.findByRole("button", { name: e.saving });
    const busy = screen.getByRole("button", { name: e.saving }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    await act(async () => release(json(200, { ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}` })));
    await screen.findByText(/is being checked/);
    expect(calls.filter((c) => c.url === "/api/media/uploads")).toHaveLength(1);
    expect(exporter.fn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["quota_exceeded", e.errors.quota_exceeded],
    ["unauthorized", e.errors.unauthorized],
    ["media_unavailable", e.errors.media_unavailable],
    ["something_new", e.errors.failed],
  ])("a refused ticket (%s) is an alert with its own sentence, nothing was uploaded, and Try again asks again", async (word, sentence) => {
    await edited();
    uploadPlan.ticket = json(400, { error: word });
    fireEvent.click(saveButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(sentence);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    uploadPlan.ticket = () => json(200, { ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}` });
    fireEvent.click(screen.getByRole("button", { name: e.retry }));
    await screen.findByText(/is being checked/);
  });

  it("a file over the limit names the limit", async () => {
    await edited();
    uploadPlan.ticket = json(413, { error: "too_large", max_bytes: 25 * 1024 * 1024 });
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toContain("limit is 25 MB");
  });

  it("a refused PUT, a dropped connection and a browser that cannot build the picture are each their own sentence", async () => {
    await edited();
    uploadPlan.put = json(507, { error: "quota_exceeded" });
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toContain(e.errors.quota_exceeded);
    uploadPlan.put = () => {
      throw new TypeError("fetch failed");
    };
    fireEvent.click(screen.getByRole("button", { name: e.retry }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(e.errors.network));
    exporter.fn.mockRejectedValue(new Error("no canvas"));
    fireEvent.click(screen.getByRole("button", { name: e.retry }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(e.errors.export_failed));
  });

  it("a new change after saving takes the 'saved' line away", async () => {
    await edited();
    fireEvent.click(saveButton());
    await screen.findByText(/is being checked/);
    fireEvent.click(screen.getByRole("button", { name: e.rotateLeft }));
    expect(screen.queryByText(/is being checked/)).toBeNull();
  });

  it("after Saved the key is off: a second press cannot upload a duplicate; a change turns it on; undoing back to the saved picture turns it off again", async () => {
    await edited();
    fireEvent.click(saveButton());
    await screen.findByText(/is being checked/);
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(calls.filter((c) => c.url === "/api/media/uploads")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: e.flipH }));
    expect(saveButton().disabled).toBe(false);
    expect(screen.queryByText(/is being checked/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: e.undo }));
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/is being checked/)).toBeTruthy();
    expect(screen.queryByText(e.unsaved)).toBeNull();
  });

  it("a refusal is cleared by the next change: the old alert does not stay over a picture that is different now", async () => {
    await edited();
    uploadPlan.ticket = json(507, { error: "quota_exceeded" });
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toContain(e.errors.quota_exceeded);
    fireEvent.click(screen.getByRole("button", { name: e.flipH }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("will not save an unedited picture even if the key is forced", async () => {
    await open();
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(exporter.fn).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === "/api/media/uploads")).toBe(false);
  });
});

describe("leaving with unsaved edits", () => {
  const link = () => {
    const a = document.createElement("a");
    a.href = "/chronos/library";
    a.textContent = "elsewhere";
    document.body.appendChild(a);
    return a;
  };
  // jsdom cannot navigate: let the click finish, note whether the guard had cancelled it, then cancel it ourselves.
  const seen: boolean[] = [];
  const note = (ev: Event) => {
    seen.push(ev.defaultPrevented);
    ev.preventDefault();
  };
  beforeEach(() => {
    seen.length = 0;
    window.addEventListener("click", note);
  });
  afterEach(() => {
    window.removeEventListener("click", note);
    vi.restoreAllMocks();
  });

  it("asks before an in-app link is followed; Cancel keeps the page, OK lets it go", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: e.rotateRight }));
    const a = link();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    seen.length = 0;
    const stay = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(stay);
    expect(confirm).toHaveBeenCalledWith(e.unsavedConfirm);
    // cancelled before anything downstream (Next's Link, the browser) saw it: the bubble listener never ran
    expect(stay.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    confirm.mockReturnValue(true);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(seen).toEqual([false]);
    a.remove();
  });

  it("does not ask when nothing is unsaved, after a save, for a new tab, or for a same-page anchor", async () => {
    await open();
    const a = link();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: e.rotateRight }));
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    const same = document.createElement("a");
    same.href = "#top";
    document.body.appendChild(same);
    same.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(saveButton());
    await screen.findByText(/is being checked/);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(confirm).not.toHaveBeenCalled();
    a.remove();
    same.remove();
  });

  it("stops asking once the editor is closed", async () => {
    const r = render(<ImageEditor assetId={PIC} orgId={ORG} name="cat.png" libraryHref="/l" />);
    await screen.findByTestId("canvas");
    fireEvent.click(screen.getByRole("button", { name: e.rotateRight }));
    r.unmount();
    const a = link();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(confirm).not.toHaveBeenCalled();
    a.remove();
  });
});

describe("the picture pass", () => {
  it("a browser that cannot draw the picture gets an error with Try again, not a blank preview", async () => {
    preview.ok = false;
    render(<ImageEditor assetId={PIC} orgId={ORG} name="cat.png" libraryHref="/chronos/library" />);
    expect(await screen.findByText(e.previewFailed)).toBeTruthy();
    expect(screen.queryByTestId("canvas")).toBeNull();
    expect(screen.getByRole("link", { name: e.libraryLink })).toBeTruthy();
    preview.ok = true;
    fireEvent.click(screen.getByRole("button", { name: e.retry }));
    expect(await screen.findByTestId("canvas")).toBeTruthy();
  });

  it("shows white behind transparency exactly when JPEG is the chosen file type", async () => {
    await open();
    expect(preview.opaque.at(-1)).toBe(false);
    fireEvent.change(screen.getByLabelText(e.formatLabel), { target: { value: "jpeg" } });
    expect(preview.opaque.at(-1)).toBe(true);
    fireEvent.change(screen.getByLabelText(e.formatLabel), { target: { value: "png" } });
    expect(preview.opaque.at(-1)).toBe(false);
  });
});
