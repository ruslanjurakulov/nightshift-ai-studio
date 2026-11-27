// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHistoryFrame, type ChatHistoryLabels, type ChatHistorySource } from "@/components/chat/ChatHistory";

/**
 * The shared history frame (components/chat/ChatHistory.tsx): where a pick's refusal is said. What breaks if these fail: the Studio's
 * Nightshift AI (a drawer that closes on a pick) says "busy", "gone" or "could not open" inside the closed drawer, where nobody reads
 * it; or the owner console, which passes no `onPickMessage`, loses the notice it has always shown in the frame.
 */

const labels: ChatHistoryLabels = {
  heading: "Chats", newChat: "New", loading: "Loading", empty: "Nothing yet", error: "Could not load", retry: "Try again", more: "More",
  gone: "That chat is gone", untitled: "Untitled", open: "Open chats", close: "Close", collapse: "Collapse", expand: "Expand",
  justNow: "now", minutesAgo: "{n} min", hoursAgo: "{n} h", yesterday: "yesterday", daysAgo: "{n} d",
  months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};
const source: ChatHistorySource = {
  list: async () => ({ ok: true, value: { items: [{ id: "s1", title: "First chat", updatedAt: new Date().toISOString() }], nextBefore: null } }),
};

afterEach(() => cleanup());

function mount(onSelect: () => Promise<{ ok: false; message: string; gone?: boolean }>, onPickMessage?: (m: string) => void) {
  return render(
    <ChatHistoryFrame labels={labels} source={source} storageKey="test.history" activeId={null} busy={false} reloadKey={0}
      onSelect={onSelect} onNewChat={() => undefined} onRemoved={() => undefined} renderChat={(lead) => <div data-testid="chat">{lead}</div>}
      onPickMessage={onPickMessage} />,
  );
}

describe("a pick's refusal", () => {
  it("goes to the caller when it takes it (the Studio panel), and is not left inside the frame", async () => {
    const said = vi.fn();
    mount(async () => ({ ok: false, message: "An answer is on its way" }), said);
    const item = await screen.findByRole("button", { name: /First chat/ });
    await act(async () => fireEvent.click(item));
    expect(said).toHaveBeenCalledWith("An answer is on its way");
    expect(screen.queryByText("An answer is on its way")).toBeNull();
  });

  it("a gone chat is taken off the list and said to the caller in the frame's own words", async () => {
    const said = vi.fn();
    mount(async () => ({ ok: false, message: "x", gone: true }), said);
    const item = await screen.findByRole("button", { name: /First chat/ });
    await act(async () => fireEvent.click(item));
    expect(said).toHaveBeenCalledWith("That chat is gone");
    expect(screen.queryByRole("button", { name: /First chat/ })).toBeNull();
  });

  it("without onPickMessage (the owner console) the notice stays in the frame, as it always has", async () => {
    mount(async () => ({ ok: false, message: "Could not open that chat" }));
    const item = await screen.findByRole("button", { name: /First chat/ });
    await act(async () => fireEvent.click(item));
    expect(await screen.findByText("Could not open that chat")).toBeTruthy();
  });
});
