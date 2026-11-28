// @vitest-environment jsdom
/**
 * The Agent Builder's React Flow canvas (components/agent-builder), mounted.
 *
 * React Flow's pointer gestures cannot be performed in jsdom, so the test takes the props the builder hands <ReactFlow>
 * (isValidConnection, onConnect, onNodesChange, onNodeDragStop, onEdgesChange) and calls them the way React Flow does.
 * What would break without these: a wire React Flow drew being added though checkConnection refused it, a duplicate
 * drop adding a second edge, a removed node leaving its wires or saved position behind, a card's handles not matching
 * its type's PORTS, a drag saving a position off the canvas, a draft losing its layout, and any canvas interaction
 * reaching the network (CLAUDE.md rule 3: nothing here may run, spend or call a provider).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { Connection, EdgeChange, NodeChange, ReactFlowProps } from "@xyflow/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

type FlowProps = ReactFlowProps<AgentFlowNode, AgentFlowEdge>;
const flow = vi.hoisted(() => ({ props: null as unknown }));
vi.mock("@xyflow/react", async importOriginal => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    // The real ReactFlow renders; the wrapper only remembers the last props it was given.
    ReactFlow: (p: FlowProps) => {
      flow.props = p;
      return createElement(actual.ReactFlow as unknown as (q: FlowProps) => ReactNode, p);
    },
  };
});

import { dictionaries } from "@/lib/i18n";
import { NODE_TYPES, createCampaignWorkflow } from "@/lib/agent-graph";
import { PORTS } from "@/lib/agent-graph-editor";
import { defaultNodePosition, importWorkflowDraft } from "@/lib/agent-draft";
import type { AgentFlowEdge, AgentFlowNode } from "@/lib/agent-flow";
import { AgentBuilder, type ProviderPreviews } from "@/components/agent-builder/AgentBuilder";

const copy = dictionaries.en.agentBuilder;
const previews = { ideogram: { error: "x" }, byteplus: { error: "x" } } as ProviderPreviews;
const props = () => flow.props as FlowProps;
const edgeIds = () => (props().edges ?? []).map(e => e.id);
const nodeAt = (id: string) => props().nodes?.find(n => n.id === id)?.position;
const status = () => screen.getByRole("status").textContent;

// React Flow measures with ResizeObserver, DOMMatrix and offset sizes, none of which jsdom has (reactflow.dev/learn/advanced-use/testing).
class FakeResizeObserver {
  constructor(private cb: (entries: { target: Element }[], o: unknown) => void) {}
  observe(target: Element) { this.cb([{ target }], this); }
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
  m22 = 1;
};
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 1; } },
  offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 1; } },
});
(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
// jsdom's Blob (and so File) has no text(); browsers do, and the builder reads an imported draft and the download with it.
if (!Blob.prototype.text) {
  Blob.prototype.text = function (this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network in a canvas test")));
  vi.stubGlobal("fetch", fetchSpy);
  flow.props = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(<AgentBuilder providerPreviews={previews} copy={copy} />);
const addNodeOfType = (type: string) => {
  fireEvent.change(screen.getByLabelText("Node type"), { target: { value: type } });
  fireEvent.click(screen.getByRole("button", { name: "+ Add node" }));
};
const connect = (source: string, target: string, handles: Partial<Connection> = {}) =>
  act(() => props().onConnect!({ source, target, sourceHandle: null, targetHandle: null, ...handles }));
const nodesChange = (changes: NodeChange<AgentFlowNode>[]) => act(() => props().onNodesChange!(changes));
const edgesChange = (changes: EdgeChange<AgentFlowEdge>[]) => act(() => props().onEdgesChange!(changes));

/** The draft the Download button would save, read back through importWorkflowDraft like a later upload. */
async function downloadedDraft() {
  let blob: Blob | null = null;
  vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: (b: Blob) => { blob = b; return "blob:test"; }, revokeObjectURL: () => {} }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: /Download validated draft/ }));
  click.mockRestore();
  expect(blob).not.toBeNull();
  return importWorkflowDraft(await (blob as unknown as Blob).text());
}

describe("Agent Builder canvas on React Flow", () => {
  it("a disallowed connection leaves graph.edges unchanged and shows the reason, whatever the handle ids say", () => {
    mount();
    const before = edgeIds();
    // Handle ids that claim a matching port: they must not matter, only the two node types do.
    expect(props().isValidConnection!({ source: "brand", target: "export", sourceHandle: "approval", targetHandle: "approval" })).toBe(false);
    connect("brand", "export", { sourceHandle: "approval", targetHandle: "approval" });
    expect(edgeIds()).toEqual(before);
    expect(status()).toBe("These node types cannot be connected.");
    // A drop that skipped isValidConnection (a stale render) is refused on the drop too.
    connect("image", "image");
    expect(edgeIds()).toEqual(before);
  });

  it("a drop React Flow refused (it never reaches onConnect) still names the reason, and adds nothing", () => {
    mount();
    const before = edgeIds();
    const node = (id: string) => ({ id }) as unknown as NonNullable<Parameters<NonNullable<FlowProps["onConnectEnd"]>>[1]["fromNode"]>;
    act(() => props().onConnectEnd!(new MouseEvent("mouseup"), {
      isValid: false, fromNode: node("brand"), toNode: node("export"), fromHandle: { type: "source" }, toHandle: null,
    } as unknown as Parameters<NonNullable<FlowProps["onConnectEnd"]>>[1]));
    expect(status()).toBe("These node types cannot be connected.");
    expect(edgeIds()).toEqual(before);
  });

  it("an allowed connection adds exactly one edge, and a duplicate drop adds none", () => {
    mount();
    addNodeOfType("video.generate");
    const before = edgeIds();
    expect(props().isValidConnection!({ source: "prompt", target: "video_generate_1", sourceHandle: null, targetHandle: null })).toBe(true);
    connect("prompt", "video_generate_1");
    expect(edgeIds()).toEqual([...before, "prompt->video_generate_1"]);
    expect(status()).toBe("Connection added.");
    expect(props().isValidConnection!({ source: "prompt", target: "video_generate_1", sourceHandle: null, targetHandle: null })).toBe(false);
    connect("prompt", "video_generate_1");
    expect(edgeIds()).toEqual([...before, "prompt->video_generate_1"]);
    expect(status()).toBe("Connection already exists.");
  });

  it("removing a node (its Remove button, or Delete through React Flow) removes its edges and its saved position", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Move Image task placeholder right" }));
    expect(nodeAt("image")).toEqual({ x: defaultNodePosition(3).x + 20, y: defaultNodePosition(3).y });
    fireEvent.click(screen.getByRole("button", { name: "Remove Image task placeholder" }));
    expect(props().nodes?.some(n => n.id === "image")).toBe(false);
    expect(edgeIds().some(id => id.includes("image"))).toBe(false);
    // A node of the same id added later starts at its grid slot, not where the removed one was moved to.
    addNodeOfType("image.generate");
    const re = props().nodes!.findIndex(n => n.id === "image_generate_1");
    expect(nodeAt("image_generate_1")).toEqual(defaultNodePosition(re));

    nodesChange([{ type: "remove", id: "ghost" }, { type: "remove", id: "review" }]);
    expect(props().nodes?.map(n => n.id)).toEqual(["brand", "products", "prompt", "export", "image_generate_1"]);
    expect(edgeIds()).toEqual(["brand->prompt", "products->prompt"]);
  });

  it("renders one labelled handle per PORTS entry for every node type", () => {
    mount();
    for (const type of NODE_TYPES) addNodeOfType(type);
    const added = props().nodes!.slice(6);
    expect(added.map(n => n.data.node.type)).toEqual([...NODE_TYPES]);
    for (const n of added) {
      const card = document.querySelector(`[data-agent-node="${n.id}"]`)!;
      expect(card, n.id).not.toBeNull();
      const ids = (side: string) => [...card.querySelectorAll(`.react-flow__handle.${side}`)].map(h => h.getAttribute("data-handleid"));
      expect(ids("target"), n.id).toEqual([...PORTS[n.data.node.type].input]);
      expect(ids("source"), n.id).toEqual([...PORTS[n.data.node.type].output]);
      for (const port of PORTS[n.data.node.type].input) {
        expect(card.querySelector(`[aria-label="Input: ${copy.ports[port]}"]`), `${n.id} ${port}`).not.toBeNull();
        expect(card.textContent).toContain(copy.ports[port]);
      }
      for (const port of PORTS[n.data.node.type].output) expect(card.querySelector(`[aria-label="Output: ${copy.ports[port]}"]`)).not.toBeNull();
    }
  });

  it("a drag is clamped, drawn while it moves, and saved only when it stops", async () => {
    mount();
    nodesChange([{ type: "position", id: "brand", position: { x: -300, y: 40 }, dragging: true }]);
    expect(nodeAt("brand")).toEqual({ x: 0, y: 40 });
    let draft = await downloadedDraft();
    expect(draft.positions.brand).toEqual(defaultNodePosition(0));
    const node = props().nodes!.find(n => n.id === "brand")!;
    act(() => props().onNodeDragStop!(new MouseEvent("mouseup"), node, [{ ...node, position: { x: 9999, y: 41.6 } }]));
    expect(nodeAt("brand")).toEqual({ x: 2200, y: 42 });
    draft = await downloadedDraft();
    expect(draft.positions.brand).toEqual({ x: 2200, y: 42 });
  });

  it("export -> import round-trips positions, and an old draft without them loads at the default slots", async () => {
    mount();
    nodesChange([{ type: "position", id: "review", position: { x: 700, y: 820 }, dragging: false }]);
    const draft = await downloadedDraft();
    expect(draft.positions.review).toEqual({ x: 700, y: 820 });

    const old = { ...draft, positions: { review: { x: 300, y: 300 } } };
    const input = screen.getByLabelText("Import Nightshift workflow JSON draft") as HTMLInputElement;
    const file = new File([JSON.stringify(old)], "old.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(status()).toBe("Validated workflow draft imported. No execution or server upload."));
    expect(nodeAt("review")).toEqual({ x: 300, y: 300 });
    expect(nodeAt("brand")).toEqual(defaultNodePosition(0));
  });

  it("deleting a wire (React Flow's Delete, its × on the canvas, or the list's ×) filters graph.edges; an unknown wire id changes nothing", () => {
    mount();
    edgesChange([{ type: "remove", id: "ghost->prompt" }]);
    expect(edgeIds()).toHaveLength(5);
    edgesChange([{ type: "remove", id: "image->review" }]);
    expect(edgeIds()).not.toContain("image->review");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Human review required from Export after approval in list" }));
    expect(edgeIds()).toEqual(["brand->prompt", "products->prompt", "prompt->image"]);
  });

  it("a wire's canvas × exists only while the wire is selected (never an invisible Tab stop under a card), and selecting it shows it", async () => {
    mount();
    const onCanvas = "Disconnect Image task placeholder from Human review required on canvas";
    expect(screen.queryByRole("button", { name: onCanvas })).toBeNull();
    edgesChange([{ type: "select", id: "image->review", selected: true }]);
    expect(props().edges!.find(e => e.id === "image->review")!.selected).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: onCanvas }));
    expect(edgeIds()).not.toContain("image->review");
  });

  it("Delete / Backspace removes a selected node only while focus is on the canvas, not on a sidebar button", async () => {
    mount();
    const nodes = props().nodes!.filter(n => n.id === "brand");
    (screen.getByRole("button", { name: "Connect selected nodes" }) as HTMLElement).focus();
    expect(await props().onBeforeDelete!({ nodes, edges: [] })).toBe(false);
    (document.querySelector('.react-flow__node[data-id="brand"]') as HTMLElement).focus();
    expect(await props().onBeforeDelete!({ nodes, edges: [] })).toBe(true);
  });

  it("a real Delete keypress with a node selected and focus on \"Connect selected nodes\" leaves the node; on the card it removes it", async () => {
    mount();
    nodesChange([{ type: "select", id: "products", selected: true }]);
    expect(props().nodes!.find(n => n.id === "products")!.selected).toBe(true);
    const button = screen.getByRole("button", { name: "Connect selected nodes" });
    button.focus();
    fireEvent.keyDown(button, { key: "Delete", code: "Delete" });
    fireEvent.keyUp(button, { key: "Delete", code: "Delete" });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(props().nodes!.some(n => n.id === "products")).toBe(true);
    const card = document.querySelector('.react-flow__node[data-id="products"]') as HTMLElement;
    card.focus();
    fireEvent.keyDown(card, { key: "Delete", code: "Delete" });
    fireEvent.keyUp(card, { key: "Delete", code: "Delete" });
    await waitFor(() => expect(props().nodes!.some(n => n.id === "products")).toBe(false));
    expect(edgeIds()).not.toContain("products->prompt");
  });

  it("removing a node clears it and its wires from React Flow's selection: a node re-added under the same id starts unselected", () => {
    mount();
    addNodeOfType("video.generate");
    connect("prompt", "video_generate_1");
    nodesChange([{ type: "select", id: "video_generate_1", selected: true }]);
    edgesChange([{ type: "select", id: "prompt->video_generate_1", selected: true }, { type: "select", id: "brand->prompt", selected: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Remove video / generate" }));
    expect(props().edges!.filter(e => e.selected).map(e => e.id)).toEqual(["brand->prompt"]);
    // addNode hands out the first free id, so the next video node is video_generate_1 again, and so is its wire.
    addNodeOfType("video.generate");
    connect("prompt", "video_generate_1");
    expect(props().nodes!.find(n => n.id === "video_generate_1")!.selected).toBe(false);
    expect(props().edges!.find(e => e.id === "prompt->video_generate_1")!.selected).toBe(false);
  });

  it("after a delete, focus moves to the next card, else the previous one, else the canvas", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Remove Image task placeholder" }));
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.id).toBe("review"));
    for (const label of ["Brand kit", "Approved products", "Campaign concept", "Human review required"]) {
      fireEvent.click(screen.getByRole("button", { name: `Remove ${label}` }));
    }
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.id).toBe("export"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Export after approval" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: copy.canvasLabel })));
  });

  it("with no nodes the canvas says how to add one, and Download, Save and the badge treat the plan as not ready", () => {
    mount();
    for (const label of ["Brand kit", "Approved products", "Campaign concept", "Image task placeholder", "Human review required", "Export after approval"]) {
      fireEvent.click(screen.getByRole("button", { name: `Remove ${label}` }));
    }
    expect(screen.getByText(copy.empty)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download validated draft/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Save private draft to cloud" })).toHaveProperty("disabled", true);
    expect(screen.getByText("NEEDS REVIEW").getAttribute("title")).toBe(copy.emptyReason);
    expect(screen.getAllByText(copy.emptyReason).length).toBeGreaterThan(0);
  });

  it("onConnectEnd: a drag started on an input names the reason by type; output on output says to drag output to input", () => {
    mount();
    const state = (s: Record<string, unknown>) => s as unknown as Parameters<NonNullable<FlowProps["onConnectEnd"]>>[1];
    // Started on export's input, dropped on brand's output: the pair is brand -> export, refused by type.
    act(() => props().onConnectEnd!(new MouseEvent("mouseup"), state({
      isValid: false, fromNode: { id: "export" }, toNode: { id: "brand" }, fromHandle: { type: "target" }, toHandle: { type: "source" },
    })));
    expect(status()).toBe(copy.reasons.types);
    act(() => props().onConnectEnd!(new MouseEvent("mouseup"), state({
      isValid: false, fromNode: { id: "prompt" }, toNode: { id: "image" }, fromHandle: { type: "source" }, toHandle: { type: "source" },
    })));
    expect(status()).toBe(copy.dragOutToIn);
    // Click-to-connect refusals go through the same words.
    act(() => props().onClickConnectEnd!(new MouseEvent("click"), state({
      isValid: false, fromNode: { id: "image" }, toNode: { id: "review" }, fromHandle: { type: "source" }, toHandle: { type: "target" },
    })));
    expect(status()).toBe(copy.reasons.exists);
  });

  it("isValidConnection: named handles must be the ports the wire is drawn on, so a wire never jumps to another input", () => {
    mount();
    addNodeOfType("video.generate");
    const valid = (sourceHandle: string | null, targetHandle: string | null) =>
      props().isValidConnection!({ source: "prompt", target: "video_generate_1", sourceHandle, targetHandle });
    expect(valid("prompt", "prompt")).toBe(true);
    expect(valid(null, null)).toBe(true);
    expect(valid("prompt", "image")).toBe(false);
    edgesChange([{ type: "remove", id: "image->review" }]);
    expect(props().isValidConnection!({ source: "image", target: "review", sourceHandle: "image", targetHandle: "video" })).toBe(false);
    expect(props().isValidConnection!({ source: "image", target: "review", sourceHandle: "image", targetHandle: "image" })).toBe(true);
    // Handles never widen: a pair the types refuse stays refused whatever the handles claim.
    expect(props().isValidConnection!({ source: "brand", target: "export", sourceHandle: "approval", targetHandle: "approval" })).toBe(false);
  });

  it("refusals, From / To and \"Connection added.\" are in the reader's language", () => {
    const ru = dictionaries.ru.agentBuilder;
    render(<AgentBuilder providerPreviews={previews} copy={ru} />);
    expect(screen.getByLabelText(ru.from)).toBeTruthy();
    expect(screen.getByLabelText(ru.to)).toBeTruthy();
    connect("brand", "export");
    expect(status()).toBe(ru.reasons.types);
    connect("brand", "prompt");
    expect(status()).toBe(ru.reasons.exists);
    fireEvent.click(screen.getByRole("button", { name: "Connect selected nodes" }));
    expect(status()).toBe(ru.reasons.exists);
    edgesChange([{ type: "remove", id: "brand->prompt" }]);
    connect("brand", "prompt");
    expect(status()).toBe(ru.connected);
  });

  it("the notice is announced from exactly one live region, inside the canvas", () => {
    mount();
    connect("brand", "export");
    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(1);
    expect(screen.getByRole("region", { name: copy.canvasLabel }).contains(regions[0])).toBe(true);
    // React Flow keeps its own (empty unless a node is moved by keyboard) region; no other one repeats the notice.
    expect([...document.querySelectorAll("[aria-live]")].filter(n => n.textContent === regions[0].textContent)).toEqual([regions[0]]);
  });

  it("no canvas interaction calls fetch: add, connect, move, rename, disconnect and remove", () => {
    mount();
    addNodeOfType("video.generate");
    connect("prompt", "video_generate_1");
    connect("brand", "export");
    nodesChange([{ type: "position", id: "brand", position: { x: 50, y: 60 }, dragging: true }]);
    const node = props().nodes!.find(n => n.id === "brand")!;
    act(() => props().onNodeDragStop!(new MouseEvent("mouseup"), node, [node]));
    for (const dir of ["left", "up", "down", "right"]) fireEvent.click(screen.getByRole("button", { name: `Move Brand kit ${dir}` }));
    fireEvent.change(screen.getByLabelText("Rename brand"), { target: { value: "Renamed brand" } });
    expect(props().nodes!.find(n => n.id === "brand")!.data.node.label).toBe("Renamed brand");
    edgesChange([{ type: "select", id: "prompt->image", selected: true }]);
    edgesChange([{ type: "remove", id: "prompt->image" }]);
    nodesChange([{ type: "select", id: "review", selected: true }]);
    nodesChange([{ type: "remove", id: "review" }]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Renamed brand" }));
    for (const b of screen.getAllByRole("button", { name: /Zoom|Fit/ })) fireEvent.click(b);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names the canvas, its zoom keys and its cards' controls in the reader's language", () => {
    const ru = dictionaries.ru.agentBuilder;
    render(<AgentBuilder providerPreviews={previews} copy={ru} />);
    expect(screen.getByRole("region", { name: ru.canvasLabel }).querySelector(".react-flow")).not.toBeNull();
    expect(screen.getByRole("button", { name: ru.zoomIn })).toBeTruthy();
    expect(screen.getByRole("button", { name: ru.fitView })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: ru.removeLabel.replace("{label}", "Brand kit") })).toHaveLength(1);
    expect(screen.getByText(ru.canvasHint)).toBeTruthy();
  });
});
