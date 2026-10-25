// @vitest-environment jsdom
/**
 * The region editor's controls (components/regionEdit): every field has a visible label, every control is at least
 * 44 px tall, a region with no words says it is skipped, and the version panel moves only to a parent / child.
 * What would break without these: an unlabeled number box a screen reader cannot name, a 32 px delete key on a
 * phone, a region without words silently charged, an undo that goes anywhere but the previous version.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en } from "../lib/i18n/en";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});

const { RegionFields } = await import("../components/regionEdit/RegionFields");
const { VersionPanel } = await import("../components/regionEdit/VersionPanel");
const { buildChain } = await import("../lib/regionEdit/versions");

afterEach(() => cleanup());

const region = { id: "r1", name: "Sky", prompt: "", x: 10, y: 20, w: 100, h: 80 };
const props = (over = {}) => ({
  region,
  selected: false,
  imageSize: { width: 800, height: 600 },
  disabled: false,
  onSelect: vi.fn(),
  onName: vi.fn(),
  onPrompt: vi.fn(),
  onRect: vi.fn(),
  onRemove: vi.fn(),
  ...over,
});

describe("RegionFields", () => {
  it("names every field and reads the numbers back", () => {
    render(<ul><RegionFields {...props()} /></ul>);
    expect(screen.getByLabelText(en.regionEdit.fieldName)).toHaveProperty("value", "Sky");
    expect(screen.getByLabelText(en.regionEdit.fieldPrompt)).toBeTruthy();
    for (const [label, v] of [[en.regionEdit.x, "10"], [en.regionEdit.y, "20"], [en.regionEdit.w, "100"], [en.regionEdit.h, "80"]]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(v);
    }
  });

  it("says a region without words is skipped and not charged; with words it gives the hint", () => {
    const { rerender } = render(<ul><RegionFields {...props()} /></ul>);
    expect(screen.getByText(en.regionEdit.skipped)).toBeTruthy();
    rerender(<ul><RegionFields {...props({ region: { ...region, prompt: "dusk" } })} /></ul>);
    expect(screen.queryByText(en.regionEdit.skipped)).toBeNull();
    expect(screen.getByText(en.regionEdit.promptHint)).toBeTruthy();
  });

  it("reports edits of the name, the words and each number; a non-number is ignored", () => {
    const p = props();
    render(<ul><RegionFields {...p} /></ul>);
    fireEvent.change(screen.getByLabelText(en.regionEdit.fieldName), { target: { value: "Sea" } });
    fireEvent.change(screen.getByLabelText(en.regionEdit.fieldPrompt), { target: { value: "calm" } });
    fireEvent.change(screen.getByLabelText(en.regionEdit.w), { target: { value: "150" } });
    fireEvent.change(screen.getByLabelText(en.regionEdit.x), { target: { value: "" } });
    expect(p.onName).toHaveBeenCalledWith("Sea");
    expect(p.onPrompt).toHaveBeenCalledWith("calm");
    expect(p.onRect).toHaveBeenCalledTimes(1);
    expect(p.onRect).toHaveBeenCalledWith({ w: 150 });
  });

  it("the delete key is named for its region and every control is 44 px or taller", () => {
    const p = props();
    const { container } = render(<ul><RegionFields {...p} /></ul>);
    const del = screen.getByRole("button", { name: "Remove Sky" });
    fireEvent.click(del);
    expect(p.onRemove).toHaveBeenCalled();
    expect(del.className).toMatch(/size-11/);
    for (const input of container.querySelectorAll("input")) expect(input.className).toMatch(/min-h-11/);
    for (const ta of container.querySelectorAll("textarea")) expect(ta.className).toMatch(/min-h-\[88px\]/);
  });

  it("everything is disabled while a run would be in flight", () => {
    const { container } = render(<ul><RegionFields {...props({ disabled: true })} /></ul>);
    for (const el of container.querySelectorAll("input, textarea, button")) expect((el as HTMLInputElement).disabled).toBe(true);
  });
});

describe("VersionPanel", () => {
  const rows = [
    { id: "a", parentId: null, version: 1, createdAt: "2026-01-01", width: 8, height: 6 },
    { id: "b", parentId: "a", version: 2, createdAt: "2026-01-02", width: 8, height: 6 },
    { id: "c", parentId: "b", version: 3, createdAt: "2026-01-03", width: 8, height: 6 },
  ];

  it("undo goes to the parent and redo to the child; the original is labelled as such", () => {
    const onOpen = vi.fn();
    render(<VersionPanel state={{ status: "ready", chain: buildChain(rows, "b")! }} current="b" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: en.regionEdit.undo }));
    expect(onOpen).toHaveBeenLastCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: en.regionEdit.redo }));
    expect(onOpen).toHaveBeenLastCalledWith("c");
    const list = screen.getByRole("list", { name: en.regionEdit.versionsTitle });
    expect(within(list).getByText(en.regionEdit.versionOriginal)).toBeTruthy();
    expect(within(list).getByText("Version 3")).toBeTruthy();
  });

  it("undo is disabled at the original; an honest line replaces the list when there is nothing else", () => {
    render(<VersionPanel state={{ status: "ready", chain: buildChain(rows.slice(0, 1), "a")! }} current="a" onOpen={() => {}} />);
    expect((screen.getByRole("button", { name: en.regionEdit.undo }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(en.regionEdit.versionsNone)).toBeTruthy();
  });

  it("a failed or unavailable read says so instead of reading as no versions", () => {
    const { rerender } = render(<VersionPanel state={{ status: "failed" }} current="a" onOpen={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe(en.regionEdit.versionsFailed);
    rerender(<VersionPanel state={{ status: "unavailable" }} current="a" onOpen={() => {}} />);
    expect(screen.getByText(en.regionEdit.versionsUnavailable)).toBeTruthy();
    expect(screen.queryByText(en.regionEdit.versionsNone)).toBeNull();
  });
});

describe("the editor's source (static)", () => {
  const dir = join(__dirname, "..", "components", "regionEdit");
  const editor = readFileSync(join(dir, "RegionEditor.tsx"), "utf8");
  const canvas = readFileSync(join(dir, "RegionCanvas.tsx"), "utf8");

  it("the run key is disabled and explains why; it is the only way to run and it does nothing", () => {
    expect(editor).toMatch(/className="btn-primary w-fit" disabled aria-disabled="true" aria-describedby="re-run-why"/);
    expect(editor).not.toMatch(/fetch\([^)]*region-edit\/run/);
  });

  it("imports Konva only on the client after mount, and never a hamburger", () => {
    expect(canvas).toMatch(/await import\("konva"\)/);
    expect(canvas).not.toMatch(/^import .* from "konva"/m);
    expect(editor + canvas).not.toMatch(/hamburger|Menu\b/i);
  });

  it("the canvas answers the keyboard and is described by the key list", () => {
    expect(canvas).toMatch(/tabIndex=\{0\}/);
    expect(canvas).toMatch(/aria-describedby=\{props\.keysId\}/);
    for (const key of ["ArrowLeft", "PageDown", "Delete"]) expect(canvas).toContain(key);
  });
});
