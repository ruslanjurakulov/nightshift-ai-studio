// @vitest-environment jsdom
/**
 * The Channels page's "Publish when approved" switch (migration 0116): off by default, administrators only, an honest sheet
 * before it is turned on, one tap to turn it off, written ONLY through the database function.
 *
 * What would break: the switch shown as on (or writable) for someone who is not an administrator, turned on by a single tap
 * without the word typed, written straight into the channels table from the browser (the column is closed to it, and the
 * service key's write is refused by a trigger: tests/security/test_sec_visibility.py), shown before the migration is applied,
 * or explained in words that promise a publish.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  refresh: vi.fn(),
  writes: [] as { table: string; op: string; args: unknown[] }[],
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
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const name of ["select", "update", "insert", "delete", "eq", "order", "limit", "maybeSingle"]) {
        b[name] = (...args: unknown[]) => {
          if (name === "update" || name === "insert" || name === "delete") h.writes.push({ table, op: name, args });
          return b;
        };
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
      return b;
    },
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { ChannelCard } from "@/components/channels/ChannelCard";
import type { ChannelHealth } from "@/lib/channels";
import type { ChannelRow } from "@/lib/types";

const en = dictionaries.en;
const cs = en.confirmSheets;
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

function card(over: Partial<ChannelRow> = {}, opts: { canControl?: boolean; locale?: Locale; released?: boolean } = {}) {
  return render(
    <I18nProvider locale={opts.locale ?? "en"}>
      <ChannelCard
        channel={channel(over)}
        slug="chronos"
        health={HEALTH}
        queued={0}
        videos={3}
        canControl={opts.canControl ?? true}
        publishReleased={opts.released ?? true}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: { ok: true, channel_id: "UC-chronos", publish_on_approve: true, changed: true }, error: null });
  h.refresh.mockReset();
  h.writes.length = 0;
});
afterEach(cleanup);

const publishSwitch = () => screen.getByRole("switch", { name: new RegExp(en.channels.publishOnLabel) });
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("not released (the server flag is off)", () => {
  it("a channel whose switch is OFF has no switch at all: nothing offers to turn it on, and no typed-word sheet can open", () => {
    card({ publish_on_approve: false }, { released: false });
    expect(screen.queryByRole("switch", { name: new RegExp(en.channels.publishOnLabel) })).toBeNull();
    expect(document.body.textContent).not.toContain(en.channels.publishOnLabel);
    expect(document.body.textContent).not.toContain(en.channels.publishOnHintOff);
  });

  it("a channel whose switch is ON shows it truthfully, and it can be turned OFF in one tap (no sheet)", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, channel_id: "UC-chronos", publish_on_approve: false, changed: true }, error: null });
    card({ publish_on_approve: true }, { released: false });
    expect(publishSwitch().getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain(en.channels.publishOnHintOn);
    fireEvent.click(publishSwitch());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("set_channel_publish_on_approve", { p_channel_id: "UC-chronos", p_on: false }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // and once it is off the control is gone: there is never a control to turn it back on
    await waitFor(() => expect(screen.queryByRole("switch", { name: new RegExp(en.channels.publishOnLabel) })).toBeNull());
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("the default of the prop is not released: a caller that forgets it does not expose the feature", () => {
    render(
      <I18nProvider locale="en">
        <ChannelCard channel={channel({ publish_on_approve: false })} slug="chronos" health={HEALTH} queued={0} videos={3} canControl />
      </I18nProvider>,
    );
    expect(screen.queryByRole("switch", { name: new RegExp(en.channels.publishOnLabel) })).toBeNull();
  });
});

describe("the switch", () => {
  it("is not shown before migration 0116 is applied (the column is absent): nothing is offered that is not there", () => {
    card({});
    expect(screen.queryByRole("switch", { name: new RegExp(en.channels.publishOnLabel) })).toBeNull();
    expect(document.body.textContent).not.toContain(en.channels.publishOnLabel);
  });

  it("is OFF by default, says so in words, and says approving records a decision only", () => {
    card({ publish_on_approve: false });
    expect(publishSwitch().getAttribute("aria-checked")).toBe("false");
    const text = document.body.textContent ?? "";
    expect(text).toContain(en.channels.publishOnHintOff);
    expect(en.channels.publishOnHintOff).toContain("Off by default");
    expect(en.channels.publishOnHintOff).toContain("records your decision only");
    expect(text).not.toContain(en.channels.publishOnHintOn);
  });

  it("ON explains what happens, that YouTube may still keep the video private, and that it can be switched off any time", () => {
    card({ publish_on_approve: true });
    expect(publishSwitch().getAttribute("aria-checked")).toBe("true");
    const hint = en.channels.publishOnHintOn;
    expect(document.body.textContent).toContain(hint);
    expect(hint).toContain("queues it");
    expect(hint).toContain("YouTube may still keep it private");
    expect(hint).toContain("switch this off at any time");
    expect(hint).not.toMatch(/will be published|goes public on its own/i);
  });

  it("is disabled for anyone who does not administer the workspace, and does nothing when pressed", async () => {
    card({ publish_on_approve: false }, { canControl: false });
    expect((publishSwitch() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(publishSwitch());
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("turning it on", () => {
  it("opens an honest sheet first and calls nothing", () => {
    card({ publish_on_approve: false });
    fireEvent.click(publishSwitch());
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain("Chronos");
    expect(text).toContain(cs.publishOnBody);
    expect(text).toContain("YouTube may still keep a video private");
    expect(text).toContain("off by default");
    expect(text).toContain("switch it off at any time");
    expect(text).toContain(cs.publishOnModeRecord);
    expect(text).toContain(cs.publishOnModePublish);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("needs the word typed: an empty box, a wrong word, Cancel and Escape change nothing", async () => {
    card({ publish_on_approve: false });
    fireEvent.click(publishSwitch());
    const key = () => within(screen.getByRole("alertdialog")).getByRole("button", { name: cs.publishOnConfirm }) as HTMLButtonElement;
    expect(key().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "publis" } });
    expect(key().disabled).toBe(true);
    fireEvent.click(key());
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel }));
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(publishSwitch());
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(publishSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("with the word typed it calls the database function once, with the channel and on, writes no row, and refreshes", async () => {
    card({ publish_on_approve: false });
    fireEvent.click(publishSwitch());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "publish" } });
    const key = within(screen.getByRole("alertdialog")).getByRole("button", { name: cs.publishOnConfirm });
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc).toHaveBeenCalledWith("set_channel_publish_on_approve", { p_channel_id: "UC-chronos", p_on: true });
    await waitFor(() => expect(publishSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(h.writes).toEqual([]);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a refusal is said in words and the switch stays where it was", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    card({ publish_on_approve: false });
    fireEvent.click(publishSwitch());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "publish" } });
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: cs.publishOnConfirm }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(en.channels.publishOnForbidden));
    expect(publishSwitch().getAttribute("aria-checked")).toBe("false");
    h.rpc.mockResolvedValue({ data: { ok: false, error: "rate_limited" }, error: null });
    fireEvent.click(publishSwitch());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "publish" } });
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: cs.publishOnConfirm }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(en.channels.publishOnRateLimited));
    // a channel that requires a second person to publish cannot have it turned on (the database says so in a closed word)
    h.rpc.mockResolvedValue({ data: { ok: false, error: "two_person_required" }, error: null });
    fireEvent.click(publishSwitch());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "publish" } });
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: cs.publishOnConfirm }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(en.channels.publishOnTwoPerson));
    expect(publishSwitch().getAttribute("aria-checked")).toBe("false");
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "internal: password=hunter2" } });
    fireEvent.click(publishSwitch());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "publish" } });
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: cs.publishOnConfirm }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(en.channels.publishOnFailed));
    expect(document.body.textContent).not.toContain("hunter2");
    expect(publishSwitch().getAttribute("aria-checked")).toBe("false");
  });
});

describe("turning it off", () => {
  it("is one tap, no sheet: the safe direction", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, channel_id: "UC-chronos", publish_on_approve: false, changed: true }, error: null });
    card({ publish_on_approve: true });
    fireEvent.click(publishSwitch());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("set_channel_publish_on_approve", { p_channel_id: "UC-chronos", p_on: false }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(publishSwitch().getAttribute("aria-checked")).toBe("false"));
  });
});

describe("in the other languages", () => {
  it.each(["ru", "uz"] as const)("%s: the label, the hints and the sheet are translated and carry the same caveats", (loc) => {
    const d = dictionaries[loc];
    card({ publish_on_approve: false }, { locale: loc });
    const sw = screen.getByRole("switch", { name: new RegExp(d.channels.publishOnLabel) });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain(d.confirmSheets.publishOnBody);
    expect(d.channels.publishOnLabel).not.toBe(en.channels.publishOnLabel);
  });
});

describe("the component never writes the switch itself", () => {
  it("only the database function changes it", () => {
    const src = readFileSync(join(__dirname, "..", "components", "channels", "ChannelCard.tsx"), "utf8");
    expect(src).toContain('supabase.rpc("set_channel_publish_on_approve"');
    expect(src).not.toMatch(/\.update\(\{[^}]*publish_on_approve/);
    expect(src).not.toMatch(/agent_config[^;]*publish_on_approve/);
    expect(src).toContain("disabled={publishBusy || pending || !canControl}");
    // asked before it is turned on, never before it is turned off
    expect(src).toContain("typeToConfirm: cs.publishOnWord");
  });

  it("no other client code even names the column: only the card (the function and the value it was given) and the video page (a read)", () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(__dirname, "..", dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const named = [...walk("components"), ...walk("app"), ...walk("lib")]
      .filter((f) => !/(^|\/)i18n\//.test(f))
      .filter((f) => /publish_on_approve/.test(readFileSync(join(__dirname, "..", f), "utf8")))
      .sort();
    expect(named).toEqual(["app/(app)/[channel]/videos/[id]/page.tsx", "components/channels/ChannelCard.tsx", "lib/server/release-flags.ts", "lib/types.ts"]);
    const page = readFileSync(join(__dirname, "..", "app/(app)/[channel]/videos/[id]/page.tsx"), "utf8");
    expect(page).not.toMatch(/publish_on_approve[^\n]*\.(update|insert|upsert|delete)\(/);
  });
});
