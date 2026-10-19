// @vitest-environment jsdom
/**
 * The review panel's Approve (migration 0112): a real decision, bound to the exact cut, and honest about what it is.
 *
 * What would break: Approve filing a row nothing reads (the old button), approving a held, blocked or unverified video,
 * approving without the rights-and-labels tick, approving a different version than the one the sheet named, a viewer or a
 * platform admin on a customer's channel being offered a key the database refuses, the panel saying "published" for a video
 * that is still private on YouTube, and the two re-render buttons (which spend credits and which nothing reads) filing
 * anything. The database's own rules are attacked in tests/security/test_sec_approve_video.py.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  refresh: vi.fn(),
  inserts: [] as { table: string; args: unknown[] }[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }), usePathname: () => "/chronos/videos/x" }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: h.rpc,
    storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://x/y.mp4" }, error: null }) }) },
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const name of ["select", "update", "insert", "eq", "order", "limit", "maybeSingle"]) {
        b[name] = (...args: unknown[]) => {
          if (name === "insert" || name === "update") h.inserts.push({ table, args });
          return b;
        };
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return b;
    },
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import type { ApproveAccess } from "@/lib/videoApproval";
import type { ReviewIntentRow, VideoRow } from "@/lib/types";

const en = dictionaries.en;
const cs = en.confirmSheets;
const CUT = "c0ffee".repeat(10) + "abcd"; // 64 hex characters
const PASS = { allowed: true, reasons: [], flagged: null };

function wrap(node: ReactNode, locale: Locale = "en") {
  return render(<I18nProvider locale={locale}>{node}</I18nProvider>);
}

function video(over: Partial<VideoRow> = {}): VideoRow {
  return {
    video_id: "dQw4w9WgXcQ",
    channel_id: "chronos",
    title: "The fall of Rome",
    privacy: "private",
    published_at: "2026-10-19T10:00:00Z",
    publish_state: "uploaded",
    review_state: "pending",
    preview_path: "chronos/dQw4w9WgXcQ.mp4",
    script_text: null,
    cut_sha256: CUT,
    gate_verdict: { allowed: true, blocks: [], warnings: [], checks_run: ["rights"] },
    ...over,
  } as unknown as VideoRow;
}

function panel(
  over: Partial<VideoRow> = {},
  props: { autoPublish?: boolean; access?: ApproveAccess; gate?: typeof PASS | null; staleRequest?: ReviewIntentRow | null } = {},
  locale: Locale = "en",
) {
  return wrap(
    <ReviewPanel
      video={video(over)}
      autoPublish={props.autoPublish ?? false}
      gate={props.gate === undefined ? PASS : props.gate}
      staleRequest={props.staleRequest ?? null}
      access={props.access ?? "ok"}
      channelName="Chronos"
    />,
    locale,
  );
}

beforeEach(() => {
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: { ok: true, already: false }, error: null });
  h.refresh.mockReset();
  h.inserts.length = 0;
});
afterEach(cleanup);

const approveKey = () => screen.getByRole("button", { name: en.review.approve }) as HTMLButtonElement;
const dialog = () => screen.queryByRole("alertdialog");
function sheetKey() {
  return within(screen.getByRole("alertdialog")).getByRole("button", { name: en.review.approve }) as HTMLButtonElement;
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("the sheet", () => {
  it("opens first and names the channel, the video, the short version, the privacy and the gate; nothing is sent on the first tap", () => {
    panel();
    fireEvent.click(approveKey());
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain("The fall of Rome");
    expect(text).toContain("Chronos");
    expect(text).toContain(CUT.slice(0, 10));
    expect(text).not.toContain(CUT);
    expect(text).toContain("private");
    expect(text).toContain(en.review.gatePassed);
    expect(text).toContain(cs.rvApproveBody);
    expect(text).toContain("does not make it public");
    expect(text).toContain("make it public on YouTube");
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });

  it("the key stays dead until the rights-and-labels box is ticked", async () => {
    panel();
    fireEvent.click(approveKey());
    expect(sheetKey().disabled).toBe(true);
    fireEvent.click(sheetKey());
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("checkbox", { name: cs.rvApproveAck }));
    expect(sheetKey().disabled).toBe(false);
  });

  it("calls the function once with the exact version the sheet named and the acknowledgement, never writing a row", async () => {
    panel();
    fireEvent.click(approveKey());
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("checkbox"));
    const key = sheetKey();
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    await settle();
    expect(h.rpc).toHaveBeenCalledWith("approve_video_publish", {
      p_video_id: "dQw4w9WgXcQ",
      p_cut_sha256: CUT,
      p_ack: { rights_and_labels: true },
    });
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.inserts).toEqual([]);
  });

  it("Cancel and Escape send nothing", async () => {
    panel();
    fireEvent.click(approveKey());
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel }));
    await settle();
    expect(dialog()).toBeNull();
    fireEvent.click(approveKey());
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a refusal from the database is read out in the sheet, in words, and nothing is refreshed", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, error: "cut_changed" }, error: null });
    panel();
    fireEvent.click(approveKey());
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("checkbox"));
    fireEvent.click(sheetKey());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.review.reasons.cut_changed));
    expect(h.refresh).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it("an unknown word or a transport error is a generic failure, never the raw message", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, error: "select * from secrets" }, error: null });
    panel();
    fireEvent.click(approveKey());
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("checkbox"));
    fireEvent.click(sheetKey());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.review.reasons.failed));
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "internal: password=hunter2" } });
    fireEvent.click(sheetKey());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.review.reasons.failed));
    expect(document.body.textContent).not.toContain("hunter2");
  });

  it("not allowed and not visible are told apart from a failure", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    panel();
    fireEvent.click(approveKey());
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("checkbox"));
    fireEvent.click(sheetKey());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.review.reasons.forbidden));
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "not_found" } });
    fireEvent.click(sheetKey());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.review.reasons.not_found));
  });

  it("if the gate verdict or the version changes while the sheet is open, nothing is sent and the person is told", async () => {
    const view = panel();
    fireEvent.click(approveKey());
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("checkbox"));
    view.rerender(
      <I18nProvider locale="en">
        <ReviewPanel video={video({ cut_sha256: "d".repeat(64) })} autoPublish={false} gate={PASS} staleRequest={null} access="ok" channelName="Chronos" />
      </I18nProvider>,
    );
    fireEvent.click(sheetKey());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(cs.staleSheet));
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("when the key is dead, it says why", () => {
  const cases: [string, Partial<VideoRow>, Parameters<typeof panel>[1], keyof typeof en.review.blocker | "autoHint"][] = [
    ["held (never uploaded)", { publish_state: "held", published_at: null, privacy: null } as Partial<VideoRow>, {}, "held"],
    ["gate blocked", { gate_verdict: { allowed: false, blocks: ["rights"] } } as Partial<VideoRow>, { gate: { allowed: false, reasons: ["rights"], flagged: null } }, "gate_blocked"],
    ["no stored verdict", { gate_verdict: null } as Partial<VideoRow>, { gate: null }, "gate_unknown"],
    ["no preview", { preview_path: null } as Partial<VideoRow>, {}, "no_preview"],
    ["recorded before approvals", { cut_sha256: null } as Partial<VideoRow>, {}, "cut_unknown"],
    ["a viewer or editor", {}, { access: "not_admin" }, "not_admin"],
    ["a platform admin on a customer's channel", {}, { access: "not_member" }, "not_member"],
    ["rejected", { review_state: "rejected" }, {}, "rejected"],
    ["a channel that publishes on its own", {}, { autoPublish: true }, "autoHint"],
  ];
  it.each(cases)("%s", (_name, over, props, key) => {
    panel(over, props);
    expect(approveKey().disabled).toBe(true);
    const note = screen.getByTestId("approve-note").textContent;
    expect(note).toBe(key === "autoHint" ? en.review.autoHint : en.review.blocker[key]);
    fireEvent.click(approveKey());
    expect(dialog()).toBeNull();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("an unknown verdict is said as unknown, never as passed", () => {
    panel({ gate_verdict: null } as Partial<VideoRow>, { gate: null });
    expect(screen.getByText(en.review.gateUnknown)).toBeTruthy();
    expect(screen.queryByText(en.review.gatePassed)).toBeNull();
  });
});

describe("after the decision", () => {
  const approved = (over: Partial<VideoRow> = {}) =>
    ({
      review_state: "approved",
      approved_cut_sha256: CUT,
      decided_by_email: "anna@example.com",
      decided_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      approval_expires_at: new Date(Date.now() + 22 * 3600_000).toISOString(),
      ...over,
    }) as Partial<VideoRow>;

  it("says who approved, that the video is STILL PRIVATE on YouTube, and how to make it public today", () => {
    panel(approved());
    const box = screen.getByTestId("approved");
    expect(box.textContent).toContain("Approved by anna@example.com");
    expect(box.textContent).toContain("The video is still private on YouTube.");
    expect(box.textContent).toContain(en.review.makePublicBody);
    const link = within(box).getByRole("link", { name: en.review.studioLink }) as HTMLAnchorElement;
    expect(link.href).toBe("https://studio.youtube.com/video/dQw4w9WgXcQ/edit");
    expect(link.rel).toContain("noopener");
    expect(screen.queryByRole("button", { name: en.review.approve })).toBeNull();
  });

  it("an expired approval shows as expired and can be given again", () => {
    panel(approved({ approval_expires_at: new Date(Date.now() - 1000).toISOString() }));
    expect(screen.getByTestId("expired").textContent).toContain("has expired");
    expect(screen.queryByTestId("approved")).toBeNull();
    expect(approveKey().disabled).toBe(false);
  });

  it("an approval of a version that is no longer this one is not shown as approved", () => {
    panel(approved({ approved_cut_sha256: "e".repeat(64) }));
    expect(screen.queryByTestId("approved")).toBeNull();
    expect(approveKey().disabled).toBe(false);
  });

  it("nothing on the page says the video was published", () => {
    panel(approved());
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bpublished\b/i);
    expect(text).not.toMatch(/Approve and publish/);
  });
});

describe("the two re-render buttons", () => {
  it("are shown as not available yet, disabled, and write nothing", () => {
    panel();
    for (const label of [en.review.regenerate, en.review.regenerateScript]) {
      const key = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(key.disabled).toBe(true);
      fireEvent.click(key);
    }
    expect(screen.getAllByText(en.review.notAvailableYet).length).toBe(2);
    expect(dialog()).toBeNull();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });
});

describe("an old request of the dead buttons", () => {
  const stale = (action: ReviewIntentRow["action"]) =>
    ({ id: 1, channel_id: "chronos", video_id: "dQw4w9WgXcQ", action, note: null, created_at: "2026-09-01T00:00:00Z", consumed_at: null, outcome: null }) as ReviewIntentRow;

  it("is shown as superseded and does not block a new approval", () => {
    panel({}, { staleRequest: stale("approve") });
    expect(screen.getByTestId("stale-request").textContent).toBe(en.review.staleApprove);
    expect(approveKey().disabled).toBe(false);
    cleanup();
    panel({}, { staleRequest: stale("regenerate") });
    expect(screen.getByTestId("stale-request").textContent).toBe(en.review.staleRender);
    expect(approveKey().disabled).toBe(false);
  });
});

describe("all three languages", () => {
  it.each(["ru", "uz"] as const)("%s names the key, the reason and the sheet in its own words", (loc) => {
    const d = dictionaries[loc];
    panel({ gate_verdict: null } as Partial<VideoRow>, { gate: null, access: "not_member" }, loc);
    const key = screen.getByRole("button", { name: d.review.approve }) as HTMLButtonElement;
    expect(key.disabled).toBe(true);
    expect(screen.getByTestId("approve-note").textContent).toBe(d.review.blocker.gate_unknown);
    expect(d.review.approve).not.toBe(en.review.approve);
    expect(screen.getAllByText(d.review.notAvailableYet).length).toBe(2);
    cleanup();
    panel({}, {}, loc);
    fireEvent.click(screen.getByRole("button", { name: d.review.approve }));
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain(d.confirmSheets.rvApproveAck);
    expect(text).toContain(CUT.slice(0, 10));
  });
});
