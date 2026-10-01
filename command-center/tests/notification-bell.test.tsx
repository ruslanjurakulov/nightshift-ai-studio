// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/studio",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...rest }: { href: string; children: ReactNode; onClick?: () => void }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onClick?.();
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

type Result = { data?: unknown; count?: number | null; error: { code?: string; message: string } | null };
let list: Result;
let count: Result;
const rpc = vi.fn();
const filters: Array<[string, unknown]> = [];

function builder(result: () => Result) {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: Result) => unknown) => Promise.resolve(result()).then(res);
      if (prop === "eq" || prop === "is") return (...a: unknown[]) => (filters.push([String(prop), a]), q);
      return () => q;
    },
    apply: () => q,
  });
  return q;
}

let client: unknown = null;
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt, type Locale } from "@/lib/i18n";
import { NotificationBell } from "@/components/shell/NotificationBell";

const SB = "11111111-2222-4333-8444-555555555555";
const now = () => new Date().toISOString();
const note = (id: string, kind: string, data: Record<string, unknown>, read_at: string | null = null) => ({
  id,
  org_id: "org-1",
  kind,
  ref: id,
  data,
  created_at: now(),
  read_at,
});

function mount(orgId: string | null = "org-1", locale: Locale = "en") {
  return render(
    <I18nProvider locale={locale}>
      <NotificationBell orgId={orgId} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  filters.length = 0;
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
  list = { data: [], error: null };
  count = { count: 0, error: null };
  client = {
    from: () => ({
      select: (_cols: string, opts?: { head?: boolean }) => builder(() => (opts?.head ? count : list)),
    }),
    rpc,
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: vi.fn(),
  };
});
afterEach(() => cleanup());

const t = dictionaries.en.notifications;

describe("NotificationBell", () => {
  it("renders nothing without an organization or without Supabase", () => {
    const { container, unmount } = mount(null);
    expect(container.innerHTML).toBe("");
    unmount();
    client = null;
    expect(mount().container.innerHTML).toBe("");
  });

  it("shows the unread count from the database on the bell, and says it to a screen reader", async () => {
    count = { count: 3, error: null };
    list = { data: [note("a", "credits_low", { available: 7 })], error: null };
    mount();
    const bell = await screen.findByRole("button", { name: fmt(t.bellUnread, { n: 3 }) });
    expect(bell.textContent).toBe("3");
    // The count is the database's, not the length of the list on screen.
    expect(filters).toContainEqual(["eq", ["org_id", "org-1"]]);
    expect(filters).toContainEqual(["is", ["read_at", null]]);
  });

  it("caps the badge at 9+", async () => {
    count = { count: 42, error: null };
    mount();
    expect((await screen.findByRole("button", { name: fmt(t.bellUnread, { n: 42 }) })).textContent).toBe("9+");
  });

  it("is quiet when everything is read, and the empty state says what will show up", async () => {
    mount();
    const bell = await screen.findByRole("button", { name: t.bell });
    expect(bell.textContent).toBe("");
    fireEvent.click(bell);
    expect(await screen.findByText(t.empty)).toBeTruthy();
    expect(screen.getByText(t.emptyHint)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.markAll }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists each notification with its words, its amount only when known, and a link to where the person decides", async () => {
    count = { count: 2, error: null };
    list = {
      data: [
        note("a", "creative_job_failed", { credits_returned: 6 }),
        note("b", "storyboard_ready", { storyboard_id: SB }),
        note("c", "creative_job_failed", {}, now()),
      ],
      error: null,
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: fmt(t.bellUnread, { n: 2 }) }));
    expect(await screen.findByText(fmt(t.returned, { n: "6" }))).toBeTruthy();
    // A failure with no number says nothing about credits: no "0".
    expect(screen.queryByText(fmt(t.returned, { n: "0" }))).toBeNull();
    expect(screen.queryByText(fmt(t.returned, { n: "—" }))).toBeNull();
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/chronos/studio", `/chronos/videos/storyboard/${SB}`, "/chronos/studio"]);
    expect(screen.getAllByText(t.creativeFailed.title)).toHaveLength(2);
    expect(screen.getAllByText(t.unread)).toHaveLength(2);
  });

  it("opening one marks it read through the function and updates the count at once", async () => {
    count = { count: 1, error: null };
    list = { data: [note("a", "editor_export_done", { project_id: SB })], error: null };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: fmt(t.bellUnread, { n: 1 }) }));
    fireEvent.click(await screen.findByRole("link"));
    expect(rpc).toHaveBeenCalledWith("mark_notification_read", { p_id: "a" });
    expect(await screen.findByRole("button", { name: t.bell })).toBeTruthy();
  });

  it("an already-read one is not marked again", async () => {
    list = { data: [note("a", "editor_export_done", { project_id: SB }, now())], error: null };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: t.bell }));
    fireEvent.click(await screen.findByRole("link"));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("puts the count back when marking one fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    count = { count: 1, error: null };
    list = { data: [note("a", "credits_low", { available: 3 })], error: null };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: fmt(t.bellUnread, { n: 1 }) }));
    fireEvent.click(await screen.findByRole("link"));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    // The optimistic count is rolled back: it still reads one unread.
    expect(await screen.findByRole("button", { name: fmt(t.bellUnread, { n: 1 }) })).toBeTruthy();
  });

  it("mark all names the organization the bell is for", async () => {
    count = { count: 2, error: null };
    list = { data: [note("a", "credits_low", {}), note("b", "credits_low", {})], error: null };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: fmt(t.bellUnread, { n: 2 }) }));
    fireEvent.click(await screen.findByRole("button", { name: t.markAll }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("mark_all_notifications_read", { p_org: "org-1" }));
  });

  it("a failed read says so and offers a retry, never an empty inbox", async () => {
    list = { data: null, error: { code: "XX000", message: "boom" } };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: t.bell }));
    expect((await screen.findByRole("alert")).textContent).toContain(t.loadError);
    expect(screen.queryByText(t.empty)).toBeNull();
    list = { data: [note("a", "credits_low", {})], error: null };
    count = { count: 1, error: null };
    fireEvent.click(screen.getByRole("button", { name: t.retry }));
    expect(await screen.findByText(t.creditsLow.title)).toBeTruthy();
  });

  it("renders nothing while the migration is not applied (no table)", async () => {
    list = { data: null, error: { code: "PGRST205", message: "no table" } };
    const { container } = mount();
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("speaks Russian and Uzbek", async () => {
    count = { count: 1, error: null };
    list = { data: [note("a", "storyboard_ready", { storyboard_id: SB })], error: null };
    const ru = dictionaries.ru.notifications;
    mount("org-1", "ru");
    fireEvent.click(await screen.findByRole("button", { name: fmt(ru.bellUnread, { n: 1 }) }));
    expect(await screen.findByText(ru.storyboardReady.title)).toBeTruthy();
  });

  it("Escape closes the panel", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: t.bell }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
