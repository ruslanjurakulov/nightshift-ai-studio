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
import { documentNav, fullLoadTarget, isEditorProjectHref, isEditorProjectPath, navigate } from "@/lib/editor-nav";
import { useFullLoadLinks } from "@/components/editor/useFullLoadLinks";
import { PageLink } from "@/components/navigation/PageLink";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { RouterContext } from "next/dist/shared/lib/router-context.shared-runtime";
import type { ReactNode } from "react";
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

/**
 * A Next app router, as far as `<Link>` needs one to try a client-side transition. Whether it TRIED is read from
 * `onNavigate`, which Next calls only on the way to a client transition (and whose preventDefault cancels it, so a
 * regression here fails the assertion instead of reaching the real router).
 */
function WithRouter({ children }: { children: ReactNode }) {
  // Outside a Next build `next/link` is the pages-router Link (RouterContext); in the app it is the app-dir one
  // (AppRouterContext). Both run the onClick prop, then return on defaultPrevented, then call onNavigate.
  const pages = { beforePopState() {}, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(async () => {}) };
  return (
    <AppRouterContext.Provider value={{} as never}>
      <RouterContext.Provider value={pages as never}>{children}</RouterContext.Provider>
    </AppRouterContext.Provider>
  );
}

describe("a link's own onClick still runs (no stopPropagation)", () => {
  function EditorPage({ onClick, onNavigate }: { onClick: () => void; onNavigate: (e: { preventDefault(): void }) => void }) {
    useFullLoadLinks();
    return (
      <Link href="/chronos/library" onClick={onClick} onNavigate={(e) => { e.preventDefault(); onNavigate(e); }}>
        notification
      </Link>
    );
  }

  it("inside the editor, a Link with onClick runs its handler, a full load happens, and no client transition starts", () => {
    const onClick = vi.fn();
    const onNavigate = vi.fn();
    render(
      <WithRouter>
        <EditorPage onClick={onClick} onNavigate={onNavigate} />
      </WithRouter>,
    );
    fireEvent.click(screen.getByText("notification"));
    expect(onClick).toHaveBeenCalledTimes(1); // e.g. a notification marked read
    expect(assign).toHaveBeenCalledWith(`${window.location.origin}/chronos/library`);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("the probe works: the same Link outside the editor does try its client transition", () => {
    const onNavigate = vi.fn();
    render(
      <WithRouter>
        <Link href="/chronos/library" onNavigate={(e) => { e.preventDefault(); onNavigate(); }}>
          plain
        </Link>
      </WithRouter>,
    );
    fireEvent.click(screen.getByText("plain"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("PageLink: a link whose target is known only at run time", () => {
  it("into a project page it is a plain anchor (no client transition) and still runs its onClick", () => {
    const onClick = vi.fn((e: { preventDefault(): void }) => e.preventDefault()); // jsdom cannot follow it
    const onNavigate = vi.fn();
    render(
      <WithRouter>
        <PageLink href={`/chronos/editor/${PID}`} onClick={onClick} onNavigate={onNavigate} prefetch={false} className="x">
          export ready
        </PageLink>
      </WithRouter>,
    );
    const a = screen.getByText("export ready");
    expect(a.getAttribute("href")).toBe(`/chronos/editor/${PID}`);
    expect(a.className).toBe("x");
    expect(a.hasAttribute("prefetch")).toBe(false);
    fireEvent.click(a);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("anywhere else it is an ordinary Next Link", () => {
    const onNavigate = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <WithRouter>
        <PageLink href="/chronos/credits" onNavigate={onNavigate}>
          credits
        </PageLink>
      </WithRouter>,
    );
    fireEvent.click(screen.getByText("credits"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("recognises a project href with a query or hash, and nothing else", () => {
    expect(isEditorProjectHref(`/chronos/editor/${PID}?add=${VID}`)).toBe(true);
    expect(isEditorProjectHref(`https://app.example/chronos/editor/${PID}#x`)).toBe(true);
    expect(isEditorProjectHref("/chronos/editor")).toBe(false);
    expect(isEditorProjectHref("/chronos/library")).toBe(false);
  });
});

describe("navigate(): the command palette and the switchers", () => {
  const router = () => ({ push: vi.fn() });

  it("from the editor's project page anywhere: a full load, the router is not used", () => {
    const r = router();
    expect(navigate("/chronos/agents/voice", r, `/chronos/editor/${PID}`)).toBe("document");
    expect(assign).toHaveBeenCalledWith("/chronos/agents/voice");
    expect(r.push).not.toHaveBeenCalled();
  });

  it("from anywhere into a project page: a full load", () => {
    const r = router();
    expect(navigate(`/other/editor/${PID}`, r, "/chronos/videos")).toBe("document");
    expect(assign).toHaveBeenCalledWith(`/other/editor/${PID}`);
    expect(r.push).not.toHaveBeenCalled();
  });

  it("between other pages: the router's client transition, as before", () => {
    const r = router();
    expect(navigate("/chronos/library", r, "/chronos/editor")).toBe("client");
    expect(r.push).toHaveBeenCalledWith("/chronos/library");
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ["components/CommandPalette.tsx", 2],
    ["components/shell/ContextSwitcher.tsx", 2],
  ] as const)("%s navigates only through navigate()", (file, uses) => {
    const src = readFileSync(join(__dirname, "..", file), "utf8");
    expect(src).not.toMatch(/router\.push\(/);
    expect(src.match(/\bnavigate\(/g)?.length).toBe(uses);
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

  it("links whose project address is computed (Add to project, an export-done notification) are full loads too", () => {
    const feed = readFileSync(join(ROOT, "components/studio/JobFeed.tsx"), "utf8");
    expect(feed).toMatch(/<a\s+href=\{path\(editorAddHref\(/);
    expect(feed).not.toMatch(/<Link\s+href=\{path\(editorAddHref\(/);
    const bell = readFileSync(join(ROOT, "components/shell/NotificationBell.tsx"), "utf8");
    expect(bell.match(/<PageLink\s+href=\{href\}/g)).toHaveLength(2);
    expect(bell).not.toMatch(/<Link\s+href=\{href\}/);
    // tests/notification-bell.test.tsx, improve-ai-ui and studio-desks check the rendered (resolved) hrefs.
  });

  it("the editor page's way out of a deleted project is a full load too", () => {
    const src = readFileSync(join(ROOT, "components/editor/TimelineEditor.tsx"), "utf8");
    expect(src).toMatch(/loadDocument\(path\("\/editor"\)\)/);
    expect(src).not.toMatch(/router\.(push|replace)\(/);
    expect(src).toMatch(/useFullLoadLinks\(\);/);
  });
});
