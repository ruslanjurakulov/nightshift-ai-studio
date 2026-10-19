// @vitest-environment jsdom
/**
 * The one-tap owner actions that now ask first: channel switches, extra credits, publish approvals, API activation and
 * limits, and claiming the team. (The video review panel's Approve is a database function with its own sheet: review-approve.test.tsx.)
 *
 * What would break: a stolen unlocked phone (or one stray thumb) turning auto publish on, spending bought credits,
 * approving a publish request, activating the API or changing a limit with a single tap. For each action: the first
 * tap writes nothing, the write happens after the sheet is confirmed (and the word typed where one is asked), Cancel,
 * Escape and a wrong word write nothing, and a second tap on the confirm key writes once. The server's own rules (RLS,
 * the publish gate, the two-person rule) are not touched here: the same call is made after the sheet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

type Op = [string, unknown[]];
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  refresh: vi.fn(),
  writes: [] as { table: string; op: string; args: unknown[] }[],
  reads: {} as Record<string, unknown>,
  writeError: null as { message: string } | null,
  /** When set, a write waits for it: a save that is still in flight. */
  hold: null as Promise<void> | null,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }), usePathname: () => "/chronos/channels" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: h.rpc,
    storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://x/y.mp4" }, error: null }) }) },
    from(table: string) {
      const ops: Op[] = [];
      const b: Record<string, unknown> = {};
      for (const name of ["select", "update", "insert", "eq", "order", "limit", "maybeSingle"]) {
        b[name] = (...args: unknown[]) => {
          ops.push([name, args]);
          if (name === "update" || name === "insert") h.writes.push({ table, op: name, args });
          return b;
        };
      }
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        const wrote = ops.some(([n]) => n === "update" || n === "insert");
        const out = wrote ? { data: null, error: h.writeError } : { data: h.reads[table] ?? [], error: null };
        const settled = wrote && h.hold ? h.hold.then(() => out) : Promise.resolve(out);
        return settled.then(res, rej);
      };
      return b;
    },
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { ChannelCard } from "@/components/channels/ChannelCard";
import { UsageView } from "@/components/usage/UsageView";
import { ApprovalsBoard } from "@/components/approvals/ApprovalsBoard";
import { MembersBoard } from "@/components/members/MembersBoard";
import { coerceUsageSummary, type UsageSummary } from "@/lib/usage";
import type { ChannelHealth } from "@/lib/channels";
import type { ChannelRow } from "@/lib/types";

const en = dictionaries.en;
const cs = en.confirmSheets;

function wrap(node: ReactNode, locale: Locale = "en") {
  return render(<I18nProvider locale={locale}>{node}</I18nProvider>);
}

beforeEach(() => {
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: null, error: null });
  h.refresh.mockReset();
  h.writes.length = 0;
  h.reads = {};
  h.writeError = null;
  h.hold = null;
});
afterEach(cleanup);

const dialog = () => screen.queryByRole("alertdialog");
/** The confirm key of the open sheet: the second button in it (Cancel is the first). */
function confirmKey(label: string) {
  return within(screen.getByRole("alertdialog")).getByRole("button", { name: label }) as HTMLButtonElement;
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Channel card
// ---------------------------------------------------------------------------------------------------------------------

const HEALTH: ChannelHealth = { channelId: "chronos", tone: "ok", actionRequired: false, subsystems: [] };
function channel(over: Partial<ChannelRow> = {}): ChannelRow {
  return {
    channel_id: "UC-chronos",
    name: "Chronos",
    niche: "history",
    status: "ACTIVE",
    agent_config: null,
    schedule_config: null,
    credential_ref: { verified_at: "2026-09-01T00:00:00Z", youtube_channel_id: "UC-chronos" } as ChannelRow["credential_ref"],
    auto_publish: false,
    created_at: null,
    updated_at: null,
    ...over,
  };
}
function card(over: Partial<ChannelRow> = {}, locale: Locale = "en") {
  return wrap(
    <ChannelCard channel={channel(over)} slug="chronos" health={HEALTH} queued={0} videos={3} canControl />,
    locale,
  );
}
const autoSwitch = () => screen.getAllByRole("switch")[0];
const reviewSwitch = () => screen.getAllByRole("switch")[1];

describe("channel card: auto publish", () => {
  it("turning it ON opens a sheet that says videos publish without asking, and writes nothing yet", () => {
    card();
    fireEvent.click(autoSwitch());
    const dlg = screen.getByRole("alertdialog");
    expect(dlg.textContent).toContain("Videos publish without asking you");
    expect(dlg.textContent).toContain(cs.autoModeAsk);
    expect(dlg.textContent).toContain(cs.autoModeSelf);
    expect(h.writes).toEqual([]);
  });

  it("needs the word typed: a wrong word, an empty box and Cancel all write nothing", async () => {
    card();
    fireEvent.click(autoSwitch());
    const key = confirmKey(cs.autoOnConfirm);
    expect(key.disabled).toBe(true);
    fireEvent.click(key);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "publis" } });
    expect(confirmKey(cs.autoOnConfirm).disabled).toBe(true);
    fireEvent.click(confirmKey(cs.autoOnConfirm));
    await settle();
    expect(h.writes).toEqual([]);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel }));
    await settle();
    expect(dialog()).toBeNull();
    expect(h.writes).toEqual([]);
    expect(autoSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("Escape closes the sheet without writing", async () => {
    card();
    fireEvent.click(autoSwitch());
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await settle();
    expect(dialog()).toBeNull();
    expect(h.writes).toEqual([]);
  });

  it("with the word typed it writes once, even when the confirm key is hit twice", async () => {
    card();
    fireEvent.click(autoSwitch());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "publish" } });
    const key = confirmKey(cs.autoOnConfirm);
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(h.writes.length).toBe(1));
    await settle();
    expect(h.writes[0].table).toBe("channels");
    expect((h.writes[0].args[0] as Record<string, unknown>).auto_publish).toBe(true);
    expect(autoSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("a second tap on the switch while the sheet is open does not open another or write", async () => {
    card();
    fireEvent.click(autoSwitch());
    fireEvent.click(autoSwitch());
    expect(screen.getAllByRole("alertdialog").length).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it("while a confirmed save is still in flight, another switch on the card cannot start a question or a second write", async () => {
    let release: () => void = () => {};
    h.hold = new Promise<void>((r) => {
      release = r;
    });
    card();
    fireEvent.click(autoSwitch());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "publish" } });
    fireEvent.click(confirmKey(cs.autoOnConfirm));
    await waitFor(() => expect(h.writes.length).toBe(1));
    // the write has not come back: the pause key is not disabled by the auto-publish save, only the card's lock stops it
    fireEvent.click(screen.getByRole("button", { name: en.channels.pause }));
    await settle();
    expect(dialog()).toBeNull();
    expect(h.rpc).not.toHaveBeenCalled();
    release();
    await settle();
  });

  it("turning it OFF is the safe direction and stays one tap", async () => {
    card({ auto_publish: true });
    fireEvent.click(autoSwitch());
    await waitFor(() => expect(h.writes.length).toBe(1));
    expect(dialog()).toBeNull();
    expect((h.writes[0].args[0] as Record<string, unknown>).auto_publish).toBe(false);
  });
});

describe("channel card: pause and resume", () => {
  it("pause asks first, then calls the same function", async () => {
    card();
    fireEvent.click(screen.getByRole("button", { name: en.channels.pause }));
    expect(h.rpc).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain(cs.pauseBody);
    fireEvent.click(confirmKey(cs.pauseConfirm));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("set_channel_status", { p_channel_id: "UC-chronos", p_status: "PAUSED" }));
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("Cancel on pause calls nothing", async () => {
    card();
    fireEvent.click(screen.getByRole("button", { name: en.channels.pause }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel }));
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("resume says that runs spend, and says so louder when auto publish is on", async () => {
    card({ status: "PAUSED", auto_publish: true });
    fireEvent.click(screen.getByRole("button", { name: en.channels.activate }));
    expect(h.rpc).not.toHaveBeenCalled();
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain(cs.resumeBody);
    expect(text).toContain(cs.resumeAutoOn);
    fireEvent.click(confirmKey(cs.resumeConfirm));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("set_channel_status", { p_channel_id: "UC-chronos", p_status: "ACTIVE" }));
  });
});

describe("channel card: storyboard review", () => {
  it("turning it OFF removes a checkpoint, so it asks; turning it ON is one tap", async () => {
    h.reads.channels = { agent_config: {} };
    card({ agent_config: { storyboard_review: true } as ChannelRow["agent_config"] });
    fireEvent.click(reviewSwitch());
    expect(h.writes).toEqual([]);
    expect(screen.getByRole("alertdialog").textContent).toContain(cs.reviewOffBody);
    fireEvent.click(confirmKey(cs.reviewOffConfirm));
    await waitFor(() => expect(h.writes.length).toBe(1));
    cleanup();
    h.writes.length = 0;
    card();
    fireEvent.click(reviewSwitch());
    await waitFor(() => expect(h.writes.length).toBe(1));
    expect(dialog()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Usage: extra credits
// ---------------------------------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-10-03T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
function summary(extraEnabled: boolean): UsageSummary {
  const s = coerceUsageSummary({
    exempt: false,
    extra_enabled: extraEnabled,
    plan: { id: "creator", name: "Creator", monthly_credits: 2000, is_default: false },
    subscription: { status: "active", current_period_start: day(-9), current_period_end: day(21), cancel_at_period_end: false },
    plan_credits: { granted: 2000, spent: 1240, held: 180, left: 580, period_start: day(-9), period_end: day(21) },
    last_plan_period_end: day(21),
    extra_credits: { available: 500, soonest_expiry: day(300) },
    bonus_credits: { available: 100, soonest_expiry: null },
    spendable_now: 1180,
    run_slots: { exempt: false, limit: 2, active: 1 },
    entitlements: { concurrency: 2, queue_priority: 1, api_access: true },
  });
  if (!s) throw new Error("fixture");
  return s;
}
const ORG = "11111111-1111-4111-8111-111111111111";
function usage(on: boolean) {
  return wrap(<UsageView summary={summary(on)} nowMs={NOW} orgId={ORG} canChange canBuy canUpgrade={false} gaps={[]} />);
}

describe("usage: extra credits", () => {
  it("turning it ON opens a sheet with the balance and asks for a word; the first tap saves nothing", () => {
    usage(false);
    fireEvent.click(screen.getByRole("switch"));
    expect(h.rpc).not.toHaveBeenCalled();
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain(cs.extraOnBody);
    expect(text).toContain("500");
    expect(confirmKey(cs.extraOnConfirm).disabled).toBe(true);
  });

  it("a wrong word or Cancel saves nothing; the typed word saves once, with a double tap", async () => {
    h.rpc.mockResolvedValue({ data: { use_extra_credits: true, changed: true }, error: null });
    usage(false);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "spent" } });
    fireEvent.click(confirmKey(cs.extraOnConfirm));
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel }));
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "SPEND" } });
    const key = confirmKey(cs.extraOnConfirm);
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("set_use_extra_credits", { p_org: ORG, p_on: true }));
    await settle();
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("while the confirmed save is in flight, another tap on the switch neither asks again nor saves twice", async () => {
    let release: (v: unknown) => void = () => {};
    h.rpc.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    usage(false);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "SPEND" } });
    fireEvent.click(confirmKey(cs.extraOnConfirm));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("switch"));
    await settle();
    expect(dialog()).toBeNull();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    release({ data: { use_extra_credits: true, changed: true }, error: null });
    await settle();
  });

  it("turning it OFF protects the packs and stays one tap", async () => {
    h.rpc.mockResolvedValue({ data: { use_extra_credits: false, changed: true }, error: null });
    usage(true);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("set_use_extra_credits", { p_org: ORG, p_on: false }));
    expect(dialog()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Publish approvals
// ---------------------------------------------------------------------------------------------------------------------

const ROW = {
  id: "a1",
  channel_id: "chronos",
  video_ref: "The fall of Rome",
  requested_by: "u-ana",
  requested_at: "2026-10-03T08:00:00Z",
  status: "pending",
  decided_by: null,
  decided_at: null,
  note: null,
};
function approvals() {
  h.reads.publish_approvals = [ROW];
  h.reads.app_members = [{ user_id: "u-ana", email: "ana@x.uz" }];
  return wrap(<ApprovalsBoard channelId="chronos" myRole="admin" myEmail="me@x.uz" myUserId="u-me" />);
}

describe("publish approvals", () => {
  it("Approve shows the video and the channel and says it lets the video go public; nothing is written on the first tap", async () => {
    approvals();
    fireEvent.click(await screen.findByRole("button", { name: en.approvals.approve }));
    const dlg = screen.getByRole("alertdialog");
    expect(dlg.textContent).toContain("The fall of Rome");
    expect(dlg.textContent).toContain("chronos");
    expect(dlg.textContent).toContain("ana@x.uz");
    expect(dlg.textContent).toContain("This lets the video go public");
    expect(h.writes).toEqual([]);
  });

  it("writes the same update after the sheet is confirmed, once, even when the key is hit twice", async () => {
    approvals();
    fireEvent.click(await screen.findByRole("button", { name: en.approvals.approve }));
    const key = confirmKey(cs.approveConfirm);
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(h.writes.length).toBe(1));
    await settle();
    expect(h.writes[0].table).toBe("publish_approvals");
    expect((h.writes[0].args[0] as Record<string, unknown>).status).toBe("approved");
    expect((h.writes[0].args[0] as Record<string, unknown>).decided_by).toBe("u-me");
    expect(h.writes.length).toBe(1);
  });

  it("Cancel and Escape write nothing", async () => {
    approvals();
    fireEvent.click(await screen.findByRole("button", { name: en.approvals.approve }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: en.approvals.reject }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await settle();
    expect(dialog()).toBeNull();
    expect(h.writes).toEqual([]);
  });

  it("Reject asks too, and writes 'rejected' only after the sheet", async () => {
    approvals();
    fireEvent.click(await screen.findByRole("button", { name: en.approvals.reject }));
    expect(h.writes).toEqual([]);
    fireEvent.click(confirmKey(cs.rejectConfirm));
    await waitFor(() => expect(h.writes.length).toBe(1));
    expect((h.writes[0].args[0] as Record<string, unknown>).status).toBe("rejected");
  });

  it("a request that was decided by someone else while the sheet was open is not decided again, and nothing is sent", async () => {
    const view = approvals();
    fireEvent.click(await screen.findByRole("button", { name: en.approvals.approve }));
    // another admin decides it, and the list reloads (a new channel prop reloads it) while our sheet is still open
    h.reads.publish_approvals = [{ ...ROW, status: "approved", decided_by: "u-other", decided_at: "2026-10-03T09:00:00Z" }];
    view.rerender(
      <I18nProvider locale="en">
        <ApprovalsBoard channelId="chronos2" myRole="admin" myEmail="me@x.uz" myUserId="u-me" />
      </I18nProvider>,
    );
    await settle();
    fireEvent.click(confirmKey(cs.approveConfirm));
    await settle();
    expect(h.writes).toEqual([]);
    expect(screen.getByText(cs.staleSheet)).toBeTruthy();
  });

  it("if the person can no longer decide when the sheet is answered (role changed), nothing is sent", async () => {
    const view = approvals();
    fireEvent.click(await screen.findByRole("button", { name: en.approvals.approve }));
    view.rerender(
      <I18nProvider locale="en">
        <ApprovalsBoard channelId="chronos" myRole="viewer" myEmail="me@x.uz" myUserId="u-me" />
      </I18nProvider>,
    );
    fireEvent.click(confirmKey(cs.approveConfirm));
    await settle();
    expect(h.writes).toEqual([]);
    expect(screen.getByText(cs.staleSheet)).toBeTruthy();
  });

  it("the keys are 44px tall", async () => {
    approvals();
    const key = await screen.findByRole("button", { name: en.approvals.approve });
    expect(key.className).toContain("min-h-11");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Claiming the team
// ---------------------------------------------------------------------------------------------------------------------

describe("claim ownership", () => {
  function claimBoard() {
    h.reads.app_members = [];
    return wrap(<MembersBoard myRole="owner" myEmail="me@a.uz" myUserId="u-me" />);
  }

  it("explains what owner means and inserts nothing on the first tap", async () => {
    claimBoard();
    fireEvent.click(await screen.findByRole("button", { name: en.members.claim }));
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain(cs.claimBody);
    expect(text).toContain("me@a.uz");
    expect(h.writes).toEqual([]);
  });

  it("inserts the owner row once after the sheet, and not after Cancel", async () => {
    claimBoard();
    fireEvent.click(await screen.findByRole("button", { name: en.members.claim }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel }));
    await settle();
    expect(h.writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: en.members.claim }));
    const key = confirmKey(cs.claimConfirm);
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(h.writes.length).toBe(1));
    await settle();
    expect(h.writes[0]).toMatchObject({ table: "app_members", op: "insert", args: [{ email: "me@a.uz", user_id: "u-me", role: "owner" }] });
    expect(h.writes.length).toBe(1);
  });
});
