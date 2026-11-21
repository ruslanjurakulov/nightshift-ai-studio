// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FormEvent } from "react";
import { SavedAssetComparison, type ComparisonAsset, type ComparisonLabels } from "@/components/media/SavedAssetComparison";

const preview = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="${color}"/></svg>`)}`;
const left: ComparisonAsset = Object.freeze({ id: "synthetic-left", name: "Synthetic original.png", version: 1, previewUrl: preview("blue") });
const right: ComparisonAsset = Object.freeze({ id: "synthetic-right", name: "Synthetic edit.png", version: 2, previewUrl: preview("green") });
const labels: ComparisonLabels = {
  title: "Compare saved images", left: "First image", right: "Second image", unnamed: "Unnamed image",
  unavailable: "Preview unavailable", dismiss: "Close comparison", version: (n) => `Version ${n}`,
};
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(() => { throw new Error("No network in props-only comparison"); }); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { expect(fetchMock).not.toHaveBeenCalled(); cleanup(); vi.unstubAllGlobals(); });

function mount(a = left, b = right, onDismiss = vi.fn()) {
  return render(<SavedAssetComparison left={a} right={b} labels={labels} onDismiss={onDismiss} />);
}

describe("props-only saved image comparison", () => {
  it("associates each full saved name, version and preview with its own figure", () => {
    mount();
    const figures = screen.getAllByRole("figure");
    expect(figures).toHaveLength(2);
    for (const [index, asset] of [left, right].entries()) {
      const caption = document.getElementById(figures[index].getAttribute("aria-labelledby")!);
      expect(caption?.textContent).toContain(asset.name);
      expect(caption?.textContent).toContain(labels.version(asset.version));
      expect(within(figures[index]).getByRole("img", { name: asset.name! }).getAttribute("src")).toBe(asset.previewUrl);
    }
  });

  it("keeps a long unbroken name accessible without truncating its content", () => {
    const name = `Synthetic_${"LongVersionName".repeat(30)}.png`;
    mount({ ...left, name });
    expect(screen.getByText(name).textContent).toBe(name);
    expect(screen.getByRole("img", { name }).getAttribute("alt")).toBe(name);
    const figure = screen.getAllByRole("figure")[0];
    const caption = document.getElementById(figure.getAttribute("aria-labelledby")!);
    expect(caption?.textContent).toContain(name);
  });

  it("shows a contextual accessible fallback for a missing preview, keeping both names and versions", () => {
    mount({ ...left, previewUrl: null });
    const [first, second] = screen.getAllByRole("figure");
    expect(within(first).getByRole("status").textContent).toBe(labels.unavailable);
    expect(within(first).queryByRole("img")).toBeNull();
    expect(within(first).getByText(left.name!)).toBeTruthy();
    expect(within(first).getByText("Version 1")).toBeTruthy();
    expect(within(second).getByRole("img", { name: right.name! })).toBeTruthy();
    expect(document.querySelector('img[src=""]')).toBeNull();
  });

  it("isolates a failed image to its own side, then resets for a different asset", () => {
    const view = mount();
    fireEvent.error(screen.getByRole("img", { name: left.name! }));
    expect(within(screen.getAllByRole("figure")[0]).getByRole("status").textContent).toBe(labels.unavailable);
    expect(screen.getByRole("img", { name: right.name! })).toBeTruthy();
    const next = { ...left, id: "synthetic-new-left", name: "New synthetic image.png" };
    view.rerender(<SavedAssetComparison left={next} right={right} labels={labels} onDismiss={vi.fn()} />);
    expect(screen.getByRole("img", { name: next.name })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("allows a refreshed preview for the same asset after an image failure", () => {
    const view = mount();
    fireEvent.error(screen.getByRole("img", { name: left.name! }));
    const refreshed = { ...left, previewUrl: preview("purple") };
    view.rerender(<SavedAssetComparison left={refreshed} right={right} labels={labels} onDismiss={vi.fn()} />);
    expect(screen.getByRole("img", { name: left.name! }).getAttribute("src")).toBe(refreshed.previewUrl);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses caller-provided labels for unnamed images and never groups by matching version numbers", () => {
    const local = { ...labels, title: "Saqlangan rasmlar", unnamed: "Nomsiz rasm", unavailable: "Oldindan ko‘rish mavjud emas", version: (n: number) => `Versiya ${n}` };
    render(<SavedAssetComparison left={{ ...left, name: null, previewUrl: null }} right={{ ...right, name: " ", version: 1 }} labels={local} onDismiss={vi.fn()} />);
    expect(screen.getByRole("region", { name: local.title })).toBeTruthy();
    expect(screen.getAllByRole("figure")).toHaveLength(2);
    expect(screen.getAllByText("Versiya 1")).toHaveLength(2);
    expect(screen.getAllByText(local.unnamed)).toHaveLength(2);
    expect(screen.getByRole("status").textContent).toBe(local.unavailable);
  });

  it("dismisses once without mutating supplied assets, parent form or persisted state", () => {
    const dismiss = vi.fn(), submit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    const storage = vi.spyOn(Storage.prototype, "setItem");
    try {
      const before = JSON.stringify([left, right]);
      render(<form onSubmit={submit}><SavedAssetComparison left={left} right={right} labels={labels} onDismiss={dismiss} /></form>);
      fireEvent.click(screen.getByRole("button", { name: labels.dismiss }));
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      expect(JSON.stringify([left, right])).toBe(before);
      expect(screen.getAllByRole("img")).toHaveLength(2);
    } finally { storage.mockRestore(); }
  });
});
