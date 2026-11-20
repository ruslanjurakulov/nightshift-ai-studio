// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { unscopedScope } from "../lib/channels";
import type { SystemEventRow } from "../lib/types";
import { SystemStatus } from "../components/SystemStatus";
import { en } from "../lib/i18n/en";

type Subscription = {
  name: string;
  insert?: (payload: { new: SystemEventRow }) => void;
  status?: (status: string) => void;
  on: (...args: unknown[]) => Subscription;
  subscribe: (callback: (status: string) => void) => Subscription;
};
const recorder = vi.hoisted(() => ({ subscriptions: [] as Subscription[], removed: [] as Subscription[] }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  channel: (name: string) => {
    const sub: Subscription = {
      name,
      on: (_kind, _filter, callback) => { sub.insert = callback as Subscription["insert"]; return sub; },
      subscribe: callback => { sub.status = callback; return sub; },
    };
    recorder.subscriptions.push(sub);
    return sub;
  },
  removeChannel: (sub: Subscription) => { recorder.removed.push(sub); },
}) }));
afterEach(cleanup);


vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  return { useI18n: () => ({ locale: "en", t: en }) };
});
it("replaces A evidence with B seed on a mounted Owner scope switch", () => {
  const row = (key: string, channel: string, event: string) => ({ event_key: key, channel_id: channel, event, status: "completed", ts: new Date(Date.now() - 3600000).toISOString() } as SystemEventRow);
  const scopeA = unscopedScope("a");
  const scopeB = unscopedScope("b");
  const { rerender, unmount } = render(<SystemStatus initial={[row("a-seed", "a", "upload.completed")]} dbOk scope={scopeA} />);
  const tile = (name: string) => within(screen.getByText(name).closest("li")!);
  expect(tile(en.ops.subYoutube).getByText(en.ops.stOperational)).toBeTruthy();
  const a = recorder.subscriptions[0];
  act(() => a.status!("SUBSCRIBED"));
  rerender(<SystemStatus initial={[]} dbOk scope={{ ...scopeA }} />);
  expect(recorder.subscriptions).toHaveLength(1);
  expect(tile(en.ops.subYoutube).getByText(en.ops.stOperational)).toBeTruthy();
  rerender(<SystemStatus initial={[row("b-seed", "b", "script.completed")]} dbOk scope={scopeB} />);
  expect(recorder.removed).toEqual([a]);
  expect(recorder.subscriptions).toHaveLength(2);
  expect(tile(en.ops.subYoutube).getByText(en.ops.stUnknown)).toBeTruthy();
  expect(tile(en.ops.subAi).getByText(en.ops.stOperational)).toBeTruthy();
  const b = recorder.subscriptions[1];
  act(() => { b.status!("SUBSCRIBED"); b.insert!({ new: row("b-live", "b", "upload.completed") }); });
  expect(tile(en.ops.subYoutube).getByText(en.ops.stOperational)).toBeTruthy();
  unmount();
  expect(recorder.removed).toEqual([a, b]);
});
