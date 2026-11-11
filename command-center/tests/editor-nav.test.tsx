// @vitest-environment jsdom
/**
 * Into and out of the timeline editor's project page by a FULL document load (lib/editor-nav.ts).
 *
 * A page's Permissions-Policy is fixed when its document loads, and only the editor's project page may ask for the
 * microphone. What would break without these: a client-side link into the editor keeping the previous page's
 * `microphone=()` (Chromium then refuses the voice-over's microphone before the person is asked); a client-side link
 * out of the editor keeping `microphone=(self)` on later pages, the custom voice page included; a new-tab click, a
 * download, another site or a same-page anchor hijacked; the unsaved-changes guard skipped on the way out, or
 * nagging after the project was deleted.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Link from "next/link";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { documentNav, fullLoadTarget, isEditorProjectPath } from "@/lib/editor-nav";
import { useFullLoadLinks } from "@/components/editor/useFullLoadLinks";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { newDocForAsset, toDoc, toModel, type EditorAsset } from "@/lib/editor";

const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VID = "11111111-1111-4111-8111-111111111111";
const ORG = "0a000000-0000-4000-8000-00000000000a";
const VIDEO: EditorAsset = { id: VID, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const te = en.editor;

const assign = vi.fn();
beforeEach(() => {
  assign.mockReset();
  vi.spyOn(documentNav, "assign").mockImplementation(assign);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =================================================================================================================================
describe("which paths are the editor's project page", () => {
  it("matches next.config.ts EDITOR_MIC_SOURCE's shape", () => {
    for (const ok of [`/chronos/editor/${PID}`, `/all-channels/editor/${PID.toUpperCase()}`, `/c/editor/${PID}/`]) expect(isEditorProjectPath(ok), ok).toBe(true);
    for (const no of ["/chronos/editor", `/chronos/editor/image/${PID}`, `/api/editor/${PID}`, `/chronos/editor/${PID}x`, `/x/chronos/editor/${PID}`, "/chronos/agents/voice"])
      expect(isEditorProjectPath(no), no).toBe(false);
  });
});

describe("which clicks become a full load", () => {
  const here = new URL(`https://app.example/chronos/editor/${PID}`);
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  const a = (href: string, over: Partial<{ target: string; download: boolean }> = {}) => ({ href, target: "", download: false, ...over });

  it("an ordinary click on an in-app link of this origin", () => {
    expect(fullLoadTarget(click, a("https://app.example/chronos/agents/voice"), here)).toBe("https://app.example/chronos/agents/voice");
    expect(fullLoadTarget(click, a("/chronos/library?x=1"), here)).toBe("https://app.example/chronos/library?x=1");
    expect(fullLoadTarget(click, a("https://app.example/chronos/editor", { target: "_self" }), here)).toBe("https://app.example/chronos/editor");
  });

  it("leaves new tabs, downloads, other sites, other schemes, same-page anchors and handled clicks alone", () => {
    const inApp = a("https://app.example/chronos/videos");
    for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) expect(fullLoadTarget({ ...click, [k]: true }, inApp, here), k).toBeNull();
    expect(fullLoadTarget({ ...click, button: 1 }, inApp, here)).toBeNull();
    expect(fullLoadTarget({ ...click, defaultPrevented: true }, inApp, here)).toBeNull();
    expect(fullLoadTarget(click, a("https://app.example/x", { target: "_blank" }), here)).toBeNull();
    expect(fullLoadTarget(click, a("https://app.example/x", { download: true }), here)).toBeNull();
    expect(fullLoadTarget(click, a("https://evil.example/chronos/videos"), here)).toBeNull();
    expect(fullLoadTarget(click, a("mailto:a@b.example"), here)).toBeNull();
    expect(fullLoadTarget(click, a(`https://app.example/chronos/editor/${PID}#captions`), here)).toBeNull();
  });
});

function Page() {
  useFullLoadLinks();
  return (
    <div>
      <Link href="/chronos/agents/voice">voice</Link>
      <a href="#here">anchor</a>
      <a href="https://elsewhere.example/">away</a>
      <a href="/chronos/videos" target="_blank" rel="noreferrer">tab</a>
      <a href="/api/media/file/x/original" download>file</a>
    </div>
  );
}

describe("while the editor is open, leaving is a full load", () => {
  it("a Next <Link> becomes a full load, before its client transition starts", () => {
    render(<Page />);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    screen.getByText("voice").dispatchEvent(ev);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`${window.location.origin}/chronos/agents/voice`);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("a ctrl-click, a same-page anchor, another site, a new tab and a download are the browser's", () => {
    // jsdom cannot follow a link: the browser's own handling is stood in for after the hook has had its turn.
    const browser = (e: Event) => e.preventDefault();
    document.addEventListener("click", browser);
    try {
      render(<Page />);
      fireEvent.click(screen.getByText("voice"), { ctrlKey: true });
      for (const name of ["anchor", "away", "tab", "file"]) fireEvent.click(screen.getByText(name));
      expect(assign).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("click", browser);
    }
  });

  it("stops when the editor is left (unmount)", () => {
    const view = render(<Page />);
    view.unmount();
    render(<Link href="/chronos/videos">plain</Link>);
    const browser = (e: Event) => e.preventDefault();
    document.addEventListener("click", browser);
    fireEvent.click(screen.getByText("plain"));
    document.removeEventListener("click", browser);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("the editor page itself", () => {
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  function mount() {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => (String(url).endsWith(`/api/editor/projects/${PID}`) && init?.method === "DELETE" ? json({ ok: true }) : json({ error: "failed" }, 502))),
    );
    return render(
      <I18nProvider locale="en">
        <TimelineEditor projectId={PID} title="Trip" rev={1} doc={toDoc(toModel(newDocForAsset(VIDEO)!))} exports={[]} assets={{ [VID]: VIDEO }} videos={[VIDEO]} soundFiles={[]} orgId={ORG} />
      </I18nProvider>,
    );
  }
  const beforeUnload = () => {
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  it("its own in-app links (the library link under Add sound) leave by a full load", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: te.addSound }));
    fireEvent.click(screen.getByRole("link", { name: te.openLibrary }));
    expect(assign).toHaveBeenCalledWith(`${window.location.origin}/chronos/library`);
  });

  it("unsaved changes are still guarded on the way out; a deleted project goes back to the list without a nag", async () => {
    mount();
    expect(beforeUnload()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: te.addText })); // an unsaved change
    expect(beforeUnload()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: te.deleteProject }));
    fireEvent.click(screen.getByRole("button", { name: te.deleteYes }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/chronos/editor"));
    expect(beforeUnload()).toBe(false);
  });
});

describe("no client-side way into the editor's project page", () => {
  const ROOT = join(__dirname, "..");
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === "node_modules" || n.startsWith(".") ? [] : files(p);
      return /\.tsx?$/.test(n) ? [p] : [];
    });
  }
  const sources = [...files(join(ROOT, "components")), ...files(join(ROOT, "app"))].map((p) => ({ rel: relative(ROOT, p), src: readFileSync(p, "utf8") }));

  it("no <Link>, router.push or router.replace to /editor/<id> anywhere in the app", () => {
    const bad: string[] = [];
    for (const { rel, src } of sources) {
      if (/<Link\b[^>]*href=\{[^}]*\/editor\/\$\{/.test(src)) bad.push(`${rel}: <Link> into a project`);
      if (/router\.(push|replace)\([^)]*\/editor\/\$\{/.test(src)) bad.push(`${rel}: router into a project`);
    }
    expect(bad).toEqual([]);
  });

  it.each([
    ["components/editor/EditorHome.tsx", /<a href=\{path\(`\/editor\/\$\{p\.id\}`\)\}/, /loadDocument\(path\(`\/editor\/\$\{out\.value\.id\}`\)\)/],
    ["components/studio/Desks.tsx", /<a href=\{path\(`\/editor\/\$\{p\.id\}`\)\}/, null],
    ["components/studio/GenerateSection.tsx", /<a href=\{path\(`\/editor\/\$\{project\}`\)\}/, null],
    ["components/editor/SendToEditor.tsx", null, /loadDocument\(path\(`\/editor\/\$\{out\.value\.id\}/],
  ] as const)("%s goes in by a full load", (file, anchor, load) => {
    const src = readFileSync(join(ROOT, file), "utf8");
    if (anchor) expect(src).toMatch(anchor);
    if (load) expect(src).toMatch(load);
  });

  it("the editor page's way out of a deleted project is a full load too", () => {
    const src = readFileSync(join(ROOT, "components/editor/TimelineEditor.tsx"), "utf8");
    expect(src).toMatch(/loadDocument\(path\("\/editor"\)\)/);
    expect(src).not.toMatch(/router\.(push|replace)\(/);
    expect(src).toMatch(/useFullLoadLinks\(\);/);
  });
});
