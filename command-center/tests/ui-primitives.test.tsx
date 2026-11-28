// @vitest-environment jsdom
/**
 * The adopted primitives (components/ui/{Dialog,Sheet,Popover,Tooltip,Tabs,Slider,Command}.tsx, components/ui/effects). What
 * would break without these:
 * - shadcn's theme sneaking in. Its --background/--primary/--muted names collide with ours (our --color-muted is dim TEXT,
 *   its bg-muted a SURFACE), so one stray class or variable repaints ~165 existing uses in both themes.
 * - A ported file losing its licence header, or THIRD_PARTY_NOTICES losing a source (rule: reuse before you build).
 * - A built-in English "Close" reaching a Russian or Uzbek reader.
 * - A reduced-motion reader still seeing panels slide and beams run.
 * - An effect drawn while nothing is running (motion must be true).
 * - The keyboard contract Radix brings: focus trapped, Escape closes, focus returns; tabs and slider on the arrow keys.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/Dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/Sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Slider } from "@/components/ui/Slider";
import { Command, CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/Command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/Tooltip";
import { AnimatedGradient, BorderBeam, TextShimmer } from "@/components/ui/effects";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const PORTED = ["Dialog", "Sheet", "Popover", "Tooltip", "Tabs", "Slider", "Command"].map((n) => `components/ui/${n}.tsx`);
const EFFECTS = ["components/ui/effects/index.tsx", "components/ui/effects/effects.css"];
const STYLES = ["components/ui/primitives.css", "components/ui/effects/effects.css"];

beforeAll(() => {
  // jsdom has no layout: Radix's Slider and Popper measure with ResizeObserver, and the slider captures the pointer.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

describe("shadcn's theme never enters the app", () => {
  // shadcn's semantic classes. Each one reads a variable we either do not define or define with another meaning.
  const SHADCN_CLASSES =
    /\b(?:bg|text|border|ring|ring-offset|outline|fill)-(?:background|foreground|popover|popover-foreground|card|card-foreground|primary-foreground|secondary-foreground|muted-foreground|accent-foreground|destructive|input|ring|sidebar[a-z-]*)\b|\bbg-(?:muted|accent|primary|secondary)\b/;

  it.each(PORTED)("%s paints with our tokens, not shadcn's classes", (file) => {
    expect(read(file)).not.toMatch(SHADCN_CLASSES);
  });

  it("no stylesheet defines shadcn's variables or re-maps our --color-* names", () => {
    const css = ["app/globals.css", "app/tokens.css", ...STYLES].map(read).join("\n");
    expect(css).not.toMatch(/^\s*--(?:background|foreground|popover|card|primary-foreground|muted-foreground|ring|input|radius)\s*:/m);
    for (const f of STYLES) {
      expect(read(f), f).not.toMatch(/@theme/);
      expect(read(f), f).not.toMatch(/^\s*--color-/m);
    }
  });

  it("the primitives' stylesheets use only --ds-* tokens: no palette, no hex, no rgb", () => {
    for (const f of [...STYLES, ...PORTED, "components/ui/effects/index.tsx"]) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, f).not.toMatch(/\brgba?\(/);
      expect(src, f).not.toMatch(/\b(?:text|bg|border|ring|fill)-(?:white|black|slate|gray|zinc|neutral|red|blue|green|sky|amber)(?:-\d{2,3})?\b/);
    }
    // Every custom property they read is ours (--ds-*), their own (--ui-*, --fx-*) or Radix's placement ones.
    const vars = STYLES.flatMap((f) => [...read(f).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    for (const v of vars) expect(v).toMatch(/^--(?:ds|ui|fx|radix)-/);
  });

  it("is in the token-only list of the light-theme guard", () => {
    const guard = read("tests/light-theme-tokens.test.ts");
    for (const f of [...PORTED, "components/ui/effects/index.tsx"]) expect(guard, f).toContain(`"${f}"`);
  });
});

describe("licences", () => {
  const notices = readFileSync(path.join(root, "..", "THIRD_PARTY_NOTICES"), "utf8");

  it.each(PORTED)("%s names its origin and licence in its header", (file) => {
    const head = read(file).slice(0, 600);
    expect(head).toMatch(/Ported from shadcn\/ui \(MIT, Copyright \(c\) 2023 shadcn\)/);
    expect(head).toContain("THIRD_PARTY_NOTICES");
  });

  it("the effects name Magic UI and motion-primitives", () => {
    for (const f of EFFECTS) {
      expect(read(f), f).toContain("Magic UI");
      expect(read(f), f).toContain("motion-primitives");
    }
  });

  it("THIRD_PARTY_NOTICES carries every source's full licence and copyright line", () => {
    for (const line of [
      "Copyright (c) 2023 shadcn",
      "Copyright (c) 2022 WorkOS",
      "Copyright (c) 2022 Paco Coursey",
      "Copyright (c) 2021 Dany Castillo",
      "Copyright (c) Magic UI",
      "Copyright (c) 2024 ibelick",
    ])
      expect(notices).toContain(line);
    expect(notices).toMatch(/Copyright \(c\) Luke Edwards/);
    expect(notices.match(/Permission is hereby granted, free of charge/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("states why Aceternity and React Bits are excluded, and the app depends on neither", () => {
    expect(notices).toMatch(/Aceternity/);
    expect(notices).toMatch(/React Bits[\s\S]*Commons Clause/);
    const pkg = read("package.json");
    expect(pkg).not.toMatch(/aceternity|react-bits/i);
  });
});

describe("reduced motion", () => {
  it("stops every primitive's arrival and every effect", () => {
    const prim = read("components/ui/primitives.css");
    const block = prim.slice(prim.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const c of [".ui-overlay", ".ui-dialog", ".ui-sheet", ".ui-popover", ".ui-tooltip"]) expect(block).toContain(c);
    expect(block).toMatch(/animation: none/);
    const fx = read("components/ui/effects/effects.css");
    const fxBlock = fx.slice(fx.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(fxBlock).toMatch(/\.fx-beam::after \{ content: none; \}/);
    expect(fxBlock).toMatch(/\.fx-shimmer \{ animation: none;/);
    expect(fxBlock).toMatch(/\.fx-gradient \{ animation: none;/);
  });

  it("times every arrival with the --ds-dur-* tokens, which tokens.css zeroes", () => {
    const prim = read("components/ui/primitives.css");
    for (const m of prim.matchAll(/animation: ui-[a-z-]+ ([^;]+);/g)) expect(m[1]).toMatch(/^var\(--ds-dur-/);
  });
});

describe("effects are drawn only while true", () => {
  it("BorderBeam draws nothing while no job runs, and is decoration when one does", () => {
    const { container, rerender } = render(<BorderBeam active={false} />);
    expect(container.querySelector("[data-fx]")).toBeNull();
    rerender(<BorderBeam active />);
    expect(container.querySelector("[data-fx=beam]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("TextShimmer keeps its words readable either way", () => {
    const { rerender } = render(<TextShimmer active={false}>Rendering</TextShimmer>);
    expect(screen.getByText("Rendering").dataset.fx).toBeUndefined();
    rerender(<TextShimmer active>Rendering</TextShimmer>);
    expect(screen.getByText("Rendering").dataset.fx).toBe("shimmer");
  });

  it("AnimatedGradient wraps its content without hiding it", () => {
    render(
      <AnimatedGradient>
        <p>Done</p>
      </AnimatedGradient>,
    );
    expect(screen.getByText("Done").closest("[data-fx=gradient]")).toBeTruthy();
  });
});

describe("Dialog and Sheet", () => {
  function Harness({ sheet = false }: { sheet?: boolean }) {
    const body = (
      <>
        <input aria-label="first" />
        <button type="button">last</button>
      </>
    );
    return sheet ? (
      <Sheet>
        <SheetTrigger>open</SheetTrigger>
        <SheetContent side="auto" closeLabel="Yopish">
          <SheetTitle>Title</SheetTitle>
          <SheetDescription>Why</SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    ) : (
      <Dialog>
        <DialogTrigger>open</DialogTrigger>
        <DialogContent closeLabel="Закрыть">
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Why</DialogDescription>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  it.each([false, true])("opens as a named dialog, closes on Escape and gives focus back (sheet: %s)", async (sheet) => {
    render(<Harness sheet={sheet} />);
    const trigger = screen.getByRole("button", { name: "open" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Title" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The close key is named by the caller, in the reader's language; there is no built-in English one.
    expect(screen.getByRole("button", { name: sheet ? "Yopish" : "Закрыть" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("draws no close key when the content brings its own", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent closeLabel={null}>
          <DialogTitle>T</DialogTitle>
          <DialogDescription>D</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector(".ui-close")).toBeNull();
  });

  it("the sheet tells the stylesheet its side, so the slide and the phone/desk switch live in CSS", async () => {
    render(<Harness sheet />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect((await screen.findByRole("dialog")).getAttribute("data-side")).toBe("auto");
  });
});

describe("Tabs", () => {
  it("is one tab stop, the arrows move the choice, and each panel is named by its tab", async () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Mode">
          <TabsTrigger value="a">Image</TabsTrigger>
          <TabsTrigger value="b">Video</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
        <TabsContent value="b">B</TabsContent>
      </Tabs>,
    );
    const [a, b] = screen.getAllByRole("tab");
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowRight" });
    // Radix moves focus on the next tick.
    await waitFor(() => expect(document.activeElement).toBe(b));
    // Roving focus: only the focused tab is a Tab stop, so Tab leaves the list instead of walking every tab.
    expect(b.getAttribute("tabindex")).toBe("0");
    expect(a.getAttribute("tabindex")).toBe("-1");
    // Radix activates on focus for a horizontal list.
    fireEvent.mouseDown(b);
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Video" }).textContent).toBe("B");
  });
});

describe("Slider", () => {
  function Range() {
    const [v, setV] = useState([20, 60]);
    return (
      <>
        <Slider value={v} onValueChange={setV} thumbLabels={["Start", "End"]} />
        <output>{v.join("-")}</output>
      </>
    );
  }

  it("names each thumb and moves on the arrow keys", () => {
    render(<Range />);
    const start = screen.getByRole("slider", { name: "Start" });
    expect(screen.getByRole("slider", { name: "End" })).toBeTruthy();
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(screen.getByText("21-60")).toBeTruthy();
  });
});

describe("Command", () => {
  it("filters as the person types and says when nothing matches", async () => {
    render(
      <Command label="Actions">
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandEmpty>Nothing found</CommandEmpty>
          <CommandItem>New canvas</CommandItem>
          <CommandItem>Open library</CommandItem>
        </CommandList>
      </Command>,
    );
    const input = screen.getByPlaceholderText("Search");
    fireEvent.change(input, { target: { value: "libr" } });
    await waitFor(() => expect(screen.queryByText("New canvas")).toBeNull());
    expect(screen.getByText("Open library")).toBeTruthy();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(await screen.findByText("Nothing found")).toBeTruthy();
  });
});

describe("no file in components/ui imports a library the licence gate excluded", () => {
  it("has no aceternity or react-bits import", () => {
    const dir = path.join(root, "components/ui");
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(tsx?|css)$/.test(f));
    for (const f of files) expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/aceternity|react-bits/i);
  });
});

describe("review fixes (react-reviewer on this PR)", () => {
  it("a command palette's search box is named by the dialog's title", async () => {
    render(
      <CommandDialog open title="Find anything" description="Type to search" closeLabel="Yopish">
        <CommandInput placeholder="…" />
        <CommandList>
          <CommandItem>New canvas</CommandItem>
        </CommandList>
      </CommandDialog>,
    );
    expect(await screen.findByRole("combobox", { name: "Find anything" })).toBeTruthy();
  });

  it("a tooltip renders on a page that mounts no provider", () => {
    expect(() =>
      render(
        <Tooltip open>
          <TooltipTrigger>i</TooltipTrigger>
          <TooltipContent>More</TooltipContent>
        </Tooltip>,
      ),
    ).not.toThrow();
    expect(screen.getAllByText("More").length).toBeGreaterThan(0);
  });

  it("a press on a toast does not close the dialog the person is in", async () => {
    render(
      <>
        <Dialog defaultOpen>
          <DialogContent closeLabel="x">
            <DialogTitle>T</DialogTitle>
            <DialogDescription>D</DialogDescription>
          </DialogContent>
        </Dialog>
        <section className="toast-viewport">
          <button type="button">dismiss</button>
        </section>
      </>,
    );
    await screen.findByRole("dialog");
    const dismiss = document.querySelector(".toast-viewport button")!;
    fireEvent.pointerDown(dismiss);
    fireEvent.focus(dismiss);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("toasts and the session-ended bar sit above the modal scale", () => {
    expect(read("components/feedback/ToastProvider.tsx")).toMatch(/toast-viewport[^"]*z-\[var\(--ds-z-toast\)\]/);
    expect(read("components/shell/SessionEndedBar.tsx")).toMatch(/data-notice-layer[\s\S]{0,80}z-\[var\(--ds-z-toast\)\]/);
    const tokens = read("app/tokens.css");
    const z = (n: string) => Number(tokens.match(new RegExp(`--ds-z-${n}: (\\d+)`))![1]);
    expect(z("toast")).toBeGreaterThan(z("modal"));
  });
});

describe("the cascade-layer trap (Lens on this PR)", () => {
  // globals.css is unlayered; the primitives sit in @layer components. An unlayered rule beats a layered one whatever its
  // specificity, so a .ui-* border colour or focus ring inside the layer silently never paints (confirmed in Chrome).
  const globals = read("app/globals.css");
  const borderDefault = globals.slice(globals.indexOf(":where(*:not(.st)"), globals.indexOf("html {", globals.indexOf(":where(*:not(.st)")));

  it("every primitive that draws its own edge is carved out of the global hairline, in both rules", () => {
    for (const f of STYLES) {
      const css = read(f);
      const withEdge = new Set<string>();
      for (const m of css.matchAll(/((?:\.(?:ui|fx)-[a-z-]+)(?:\[[^\]]+\])?)[^{}]*\{([^}]*)\}/g))
        // A colour-bearing border (not border-radius, not a "border-bottom: 0" that only removes one side).
        if (/\bborder(?:-(?:top|right|bottom|left))?(?:-color)?\s*:\s*(?!0;)/.test(m[2])) withEdge.add(m[1].replace(/\[.*$/, ""));
      expect(withEdge.size, f).toBeGreaterThan(0);
      for (const cls of withEdge) {
        const hits = borderDefault.split(cls + ",").length + borderDefault.split(cls + ")").length - 2;
        expect(hits, `${cls} (${f}) in both carve-outs`).toBe(2);
      }
    }
  });

  it("the focus rings are unlayered and keep their own corners", () => {
    const css = read("components/ui/primitives.css");
    const layerEnd = css.indexOf("\n}\n", css.indexOf("@layer components {"));
    for (const cls of [".ui-close:focus-visible", ".ui-tabs-trigger:focus-visible", ".ui-slider-thumb:focus-visible"]) {
      const at = css.indexOf(cls);
      expect(at, cls).toBeGreaterThan(layerEnd);
    }
    const rings = css.slice(layerEnd);
    expect(rings.match(/outline: 3px solid var\(--ds-focus\); outline-offset: 2px; border-radius: var\(--ds-r-(?:key|pill)\)/g)?.length).toBe(2);
  });

  it("a popover inside a dialog opens above its scrim, under toasts", () => {
    expect(read("components/ui/primitives.css")).toMatch(/\.ui-popover,\s*\.ui-command-surface \{\s*z-index: calc\(var\(--ds-z-modal\) \+ 50\);/);
  });

  it("the session bar takes presses while a modal has turned the page's pointer events off", () => {
    expect(read("components/shell/SessionEndedBar.tsx")).toMatch(/pointer-events-auto[^"]*z-\[var\(--ds-z-toast\)\]/);
  });
});

describe("focus goes back without a Trigger (the dialogs our app opens from state)", () => {
  // Radix returns focus only to a Dialog.Trigger; opened from a tile or a menu, it dropped focus on <body> and a keyboard
  // user landed at the top of the page.
  function Opener({ sheet }: { sheet: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          tile
        </button>
        {sheet ? (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent side="auto" closeLabel="x">
              <SheetTitle>T</SheetTitle>
              <SheetDescription>D</SheetDescription>
            </SheetContent>
          </Sheet>
        ) : (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent closeLabel="x">
              <DialogTitle>T</DialogTitle>
              <DialogDescription>D</DialogDescription>
            </DialogContent>
          </Dialog>
        )}
      </>
    );
  }

  it.each([false, true])("returns focus to the element that opened it (sheet: %s)", async (sheet) => {
    render(<Opener sheet={sheet} />);
    const tile = screen.getByRole("button", { name: "tile" });
    tile.focus();
    fireEvent.click(tile);
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tile));
  });
});
