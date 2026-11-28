// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StudioCapability } from "../lib/creative/studio";
import type { ToolAvailability } from "../lib/tool-availability";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/studio/GeneratePanel", () => ({
  GeneratePanel: (props: { only: StudioCapability[]; initial: { sourceId?: string | null } | null }) =>
    <div data-testid="existing-composer" data-only={props.only.join(",")} data-source={props.initial?.sourceId ?? ""} />,
}));

import { Inspector } from "../components/studio-canvas/Inspector";
import { I18nProvider } from "../lib/i18n/context";
import { dictionaries, fmt } from "../lib/i18n";
import { ShellProvider } from "../components/shell/ShellContext";
import { newNode, type CanvasState } from "../lib/studio/canvas";

const fetchSpy = vi.fn(() => { throw new Error("No calls permitted in informational fixture"); });
beforeEach(() => { fetchSpy.mockClear(); vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe.each(["en", "ru", "uz"] as const)("Inspector action context in %s", (locale) => {
  it.each(["missing", "closed", "unknown", "ready"] as const)("renders %s context without an interactive control or call", (mode) => {
    const t = dictionaries[locale];
    const isImage = mode === "unknown";
    const node = newNode(isImage ? "image" : "animate", 0, 0, "synthetic-node", { draft: "Synthetic words" });
    const asset = newNode("asset", 0, 0, "synthetic-source", { assetId: "11111111-1111-4111-8111-111111111111", assetKind: "image" });
    const state: CanvasState = { nodes: mode === "ready" ? [node, asset] : [node], wires: mode === "ready" ? [{ id: "synthetic-wire", from: asset.id, to: node.id }] : [], view: { x: 0, y: 0, k: 1 } };
    const capability = isImage ? "t2i" : "i2v";
    const tools: ToolAvailability = mode === "unknown" ? { state: "unknown" } : { state: "known", sold: mode === "closed" ? [] : [capability] };
    const handlers = { onClose: vi.fn(), onDraft: vi.fn(), onCreated: vi.fn(), onWire: vi.fn(), onDisconnect: vi.fn(), onEffect: vi.fn() };
    render(
      <I18nProvider locale={locale}>
        <ShellProvider operator={false} tools={tools}>
          <Inspector node={node} state={state} jobs={new Map()} status={mode === "closed" ? "closed" : "idle"} closed={mode === "closed"}
            data={{ orgId: "synthetic-org", models: [], unavailable: [], plans: null, dna: null, defaultStyleKitId: null, effects: [] }}
            previews={new Map()} nodeName={() => "Synthetic node"} {...handlers} />
        </ShellProvider>
      </I18nProvider>,
    );
    const section = screen.getByTestId("inspector-action-context");
    expect(section.querySelector("strong")?.textContent).toBe(t.gen.kinds[capability]);
    expect(section.querySelector("button,a,input,select,textarea,[tabindex]")).toBeNull();
    const row = section.querySelector("li")!;
    if (mode === "closed") {
      expect(row.getAttribute("data-reason")).toBe("tool-unavailable");
      expect(section.textContent).toContain(t.studioCanvas.inspector.unavailable);
      expect(screen.queryByTestId("existing-composer")).toBeNull();
      expect(screen.getByTestId("inspector-unavailable")).toBeTruthy();
    } else {
      expect(screen.getByTestId("existing-composer").getAttribute("data-only")).toBe(capability);
      if (mode === "missing") {
        expect(row.getAttribute("data-reason")).toBe("source-missing");
        expect(section.textContent).toContain(fmt(t.studioCanvas.node.needsInput, { kinds: t.studioCanvas.ports.image }));
      } else {
        expect(row.hasAttribute("data-reason")).toBe(false);
        expect(section.textContent).not.toContain(t.studioCanvas.inspector.unavailable);
      }
      if (mode === "ready") expect(screen.getByTestId("existing-composer").getAttribute("data-source")).toBe(asset.assetId);
    }
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
