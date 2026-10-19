// @vitest-environment jsdom
/**
 * The review panel on a channel whose "publish when approved" switch is ON (migration 0113), and the same panel with it off.
 *
 * What would break: the button saying "Approve and publish" on a channel that did not switch it on (the old over-claim, back),
 * the sheet or the hint promising a publish that YouTube may refuse, "Published" shown for a request that is only queued, that
 * was refused, that failed or expired, or whose read-back did not say public; a refusal shown as a raw word or a provider's text;
 * a person who may not approve being offered "Try again"; a retry that writes a row from the browser. The database's own rules
 * (who may switch, the queue, the truth rule) are attacked in tests/security/test_sec_visibility.py.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  refresh: vi.fn(),
  writes: [] as { table: string; args: unknown[] }[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }), usePathname: () => "/chronos/videos/x" }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: h.rpc,
    storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://x/y.mp4" }, error: null }) }) },
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const name of ["select", "update", "insert", "delete", "eq", "order", "limit", "maybeSingle"]) {
        b[name] = (...args: unknown[]) => {
          if (name === "insert" || name === "update" || name === "delete") h.writes.push({ table, args });
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
import type { VisibilityRequestRow } from "@/lib/visibilityRequest";
import type { VideoRow } from "@/lib/types";

const en = dictionaries.en;
const cs = en.confirmSheets;
const CUT = "c0ffee".repeat(10) + "abcd";
const DECIDED = "2026-10-19T10:00:00.000Z";
const NOW = new Date("2026-10-19T12:00:00.000Z").getTime();
const GATE = { allowed: true, reasons: [], flagged: null };

function wrap(node: ReactNode, locale: Locale = "en") {
  return render(<I18nProvider locale={locale}>{node}</I18nProvider>);
}

function video(over: Partial<VideoRow> = {}): VideoRow {
  return {
    video_id: "dQw4w9WgXcQ",
    channel_id: "chronos",
    title: "The fall of Rome",
    privacy: "private",
    published_at: "2026-10-19T09:00:00Z",
    publish_state: "uploaded",
    review_state: "pending",
    preview_path: "chronos/dQw4w9WgXcQ.mp4",
    script_text: null,
    cut_sha256: CUT,
    gate_verdict: { allowed: true, blocks: [], warnings: [], checks_run: ["rights"] },
    ...over,
  } as unknown as VideoRow;
}

/** An approved video (approved at DECIDED, good for 24 hours) the way the database leaves it after approve_video_publish. */
const APPROVED: Partial<VideoRow> = {
  review_state: "approved",
  approved_cut_sha256: CUT,
  decided_by_email: "owner@x.test",
  decided_at: DECIDED,
  approval_expires_at: "2026-10-20T10:00:00.000Z",
} as Partial<VideoRow>;

function request(over: Partial<VisibilityRequestRow> = {}): VisibilityRequestRow {
  return {
    id: 41,
    status: "queued",
    reason: null,
    attempts: 0,
    lifetime_attempts: 0,
    approved_cut_sha256: CUT,
    decided_at: DECIDED,
    expires_at: "2026-10-20T10:00:00.000Z",
    next_attempt_at: DECIDED,
    before_privacy: null,
    after_privacy: null,
    finished_at: null,
    created_at: DECIDED,
    ...over,
  };
}

function panel(opts: {
  v?: Partial<VideoRow>;
  on?: boolean;
  req?: VisibilityRequestRow | null;
  access?: ApproveAccess;
  autoPublish?: boolean;
  locale?: Locale;
} = {}) {
  return wrap(
    <ReviewPanel
      video={video(opts.v)}
      autoPublish={opts.autoPublish ?? false}
      gate={GATE}
      staleRequest={null}
      access={opts.access ?? "ok"}
      channelName="Chronos"
      publishOnApprove={opts.on ?? false}
      request={opts.req ?? null}
    />,
    opts.locale ?? "en",
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: { ok: true, already: false, queued: true, request_id: 41 }, error: null });
  h.refresh.mockReset();
  h.writes.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const dlg = () => screen.getByRole("alertdialog");
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}
const visBlock = () => screen.queryByTestId("visibility");

describe("the label and the sheet say publish only where the channel's switch is on", () => {
  it("switch OFF: the key is Approve, the hint says it does not make the video public, and 'publish' is nowhere on the panel", () => {
    panel({ on: false });
    expect(screen.getByRole("button", { name: en.review.approve })).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.review.approvePublish })).toBeNull();
    expect(screen.getByTestId("approve-note").textContent).toBe(en.review.queueHint);
    expect(document.body.textContent).not.toMatch(/Approve and publish/);
    fireEvent.click(screen.getByRole("button", { name: en.review.approve }));
    expect(dlg().textContent).toContain(cs.rvApproveBody);
    expect(dlg().textContent).not.toContain(cs.rvApprovePublishBody);
    expect(dlg().textContent).not.toContain(cs.rvApprovePublishEffect);
  });

  it.each(["en", "ru", "uz"] as const)("%s, switch OFF: the old label, never the new one", (loc) => {
    const d = dictionaries[loc];
    panel({ on: false, locale: loc });
    expect(screen.getByRole("button", { name: d.review.approve })).toBeTruthy();
    expect(screen.queryByRole("button", { name: d.review.approvePublish })).toBeNull();
  });

  it.each(["en", "ru", "uz"] as const)("%s, switch ON: the key reads Approve and publish, and the hint says YouTube may still keep it private", (loc) => {
    const d = dictionaries[loc];
    panel({ on: true, locale: loc });
    expect(screen.getByRole("button", { name: d.review.approvePublish })).toBeTruthy();
    expect(screen.queryByRole("button", { name: d.review.approve })).toBeNull();
    expect(screen.getByTestId("approve-note").textContent).toBe(d.review.queueHintPublish);
  });

  it("switch ON: the sheet says what happens, in words, and what is sent is exactly the approval (no publish call from the browser)", async () => {
    panel({ on: true });
    fireEvent.click(screen.getByRole("button", { name: en.review.approvePublish }));
    const text = dlg().textContent ?? "";
    expect(text).toContain(cs.rvApprovePublishBody);
    expect(text).toContain("YouTube may still keep it private");
    expect(text).toContain("switch the setting off for the channel at any time");
    expect(text).toContain(cs.rvApprovePublishEffect);
    expect(text).not.toContain(cs.rvApproveBody);
    expect(h.rpc).not.toHaveBeenCalled();
    fireEvent.click(within(dlg()).getByRole("checkbox"));
    fireEvent.click(within(dlg()).getByRole("button", { name: en.review.approvePublish }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc).toHaveBeenCalledWith("approve_video_publish", { p_video_id: "dQw4w9WgXcQ", p_cut_sha256: CUT, p_ack: { rights_and_labels: true } });
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.writes).toEqual([]);
  });

  it("a channel that publishes by itself shows no key at all, whatever the switch says", () => {
    panel({ on: true, autoPublish: true, v: { review_state: "approved", approved_cut_sha256: null } as Partial<VideoRow> });
    expect(screen.queryByRole("button", { name: en.review.approvePublish })).toBeNull();
    // what is left is the disabled old key and the sentence that says the channel publishes on its own
    expect((screen.getByRole("button", { name: en.review.approve }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("approve-note").textContent).toBe(en.review.autoHint);
  });
});

describe("what the panel says about the request: queued, refused, failed, expired, and published only from a read-back", () => {
  it("queued: says it is waiting, that nothing is published yet, never the word Published", () => {
    panel({ on: true, v: APPROVED, req: request() });
    expect(visBlock()?.getAttribute("data-state")).toBe("queued");
    const text = visBlock()?.textContent ?? "";
    expect(text).toContain("Queued");
    expect(text).toContain("Nothing is published yet");
    expect(text).not.toMatch(/Published/);
    expect(screen.getByTestId("approved").textContent).toContain("Approved by owner@x.test");
    expect(screen.getByTestId("approved").textContent).not.toContain("does not make it public");
    // while it waits the page asks again
    expect(h.refresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("queued after a try that did not finish: names the last try's word", () => {
    panel({ on: true, v: APPROVED, req: request({ attempts: 1, reason: "rate_limited" }) });
    expect(visBlock()?.textContent).toContain(en.review.visibility.reasons.rate_limited);
  });

  it("published: only for an applied request whose read-back said public", () => {
    panel({ on: true, v: { ...APPROVED, privacy: "public" } as Partial<VideoRow>, req: request({ status: "applied", after_privacy: "public", finished_at: "2026-10-19T10:05:00.000Z" }) });
    expect(visBlock()?.getAttribute("data-state")).toBe("published");
    expect(visBlock()?.textContent).toContain("Published. YouTube reported this video as public");
    expect(h.refresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(h.refresh).not.toHaveBeenCalled();           // nothing is waiting: no polling
  });

  it.each([
    ["queued", {}],
    ["failed", { status: "failed", reason: "token_expired", finished_at: DECIDED }],
    ["refused", { status: "refused", reason: "platform_kept_private", finished_at: DECIDED, after_privacy: "private" }],
    ["expired", { status: "expired", reason: "approval_expired", finished_at: DECIDED }],
    ["applied with no read-back of public (the database refuses it; the panel must not believe it either)", { status: "applied", after_privacy: "private", finished_at: DECIDED }],
    ["applied with no read-back at all", { status: "applied", after_privacy: null, finished_at: DECIDED }],
  ] as const)("%s: the panel never says Published", (_name, over) => {
    panel({ on: true, v: APPROVED, req: request(over as Partial<VisibilityRequestRow>) });
    expect(document.body.textContent).not.toMatch(/Published\./);
    expect(document.body.textContent).not.toMatch(/reported this video as public/);
  });

  it("refused: the reason in words, not the raw word, and the way out through YouTube Studio", () => {
    panel({ on: true, v: APPROVED, req: request({ status: "refused", reason: "platform_kept_private", finished_at: DECIDED, after_privacy: "private" }) });
    const text = visBlock()?.textContent ?? "";
    expect(text).toContain("Not published.");
    expect(text).toContain(en.review.visibility.reasons.platform_kept_private);
    expect(text).not.toContain("platform_kept_private");
    expect(screen.getByTestId("approved").textContent).toContain(en.review.makePublicFallbackBody);
    expect(screen.getByRole("link", { name: en.review.studioLink })).toBeTruthy();
  });

  it("every reason word has its own sentence on the panel, in all three languages", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const d = dictionaries[loc];
      for (const word of Object.keys(d.review.visibility.reasons) as (keyof typeof d.review.visibility.reasons)[]) {
        cleanup();
        panel({ on: true, v: APPROVED, req: request({ status: "refused", reason: word, finished_at: DECIDED }), locale: loc });
        const text = word === "approval_expired" ? d.review.visibility.expired : d.review.visibility.reasons[word];
        expect(visBlock()?.textContent, `${loc}.${word}`).toContain(text);
        if (word.includes("_")) expect(visBlock()?.textContent, `${loc}.${word}`).not.toContain(word);
      }
    }
  });

  it("expired: says the approval ended and nothing was published, and offers approving again", () => {
    panel({ on: true, v: { ...APPROVED, approval_expires_at: "2026-10-19T11:00:00.000Z" } as Partial<VideoRow>, req: request({ status: "expired", reason: "approval_expired", expires_at: "2026-10-19T11:00:00.000Z", finished_at: "2026-10-19T11:00:01.000Z" }) });
    expect(visBlock()?.getAttribute("data-state")).toBe("expired");
    expect(visBlock()?.textContent).toContain(en.review.visibility.expired);
    expect(screen.getByTestId("expired").textContent).toContain("has expired");
    expect(screen.getByRole("button", { name: en.review.approvePublish })).toBeTruthy();
  });

  it("a request still queued when its approval ends reads as expired, not as waiting for ever", () => {
    panel({ on: true, v: { ...APPROVED, approval_expires_at: "2026-10-19T11:00:00.000Z" } as Partial<VideoRow>, req: request({ expires_at: "2026-10-19T11:00:00.000Z" }) });
    expect(visBlock()?.getAttribute("data-state")).toBe("expired");
  });

  it("a request queued for an EARLIER approval does not speak for this one", () => {
    panel({ on: true, v: APPROVED, req: request({ status: "refused", reason: "cut_changed", decided_at: "2026-10-18T10:00:00.000Z", finished_at: DECIDED }) });
    expect(visBlock()).toBeNull();
    panel({ on: true, v: APPROVED, req: request({ status: "failed", reason: "token_expired", approved_cut_sha256: "ab".repeat(32) }) });
    expect(visBlock()).toBeNull();
  });

  it("turned off since: a request that exists still says what happened to it, in the same words", () => {
    panel({ on: false, v: APPROVED, req: request({ status: "refused", reason: "not_enabled", finished_at: DECIDED }) });
    expect(visBlock()?.textContent).toContain(en.review.visibility.reasons.not_enabled);
    // the key is never the publishing one on a channel whose switch is off, and the banner does not claim a publish
    expect(screen.queryByRole("button", { name: en.review.approvePublish })).toBeNull();
    expect(screen.getByTestId("approved").textContent).not.toMatch(/Published/);
  });
});

describe("try again", () => {
  const failed = () => request({ status: "failed", reason: "token_expired", attempts: 3, finished_at: DECIDED });

  it("is offered to the people who may approve, for a failed request, and calls the function with the request's id, then refreshes", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, request_id: 41, status: "queued" }, error: null });
    panel({ on: true, v: APPROVED, req: failed() });
    expect(visBlock()?.textContent).toContain("Not published yet.");
    expect(visBlock()?.textContent).toContain(en.review.visibility.reasons.token_expired);
    fireEvent.click(screen.getByRole("button", { name: en.review.visibility.tryAgain }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("retry_video_visibility", { p_request_id: 41 }));
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.writes).toEqual([]);
  });

  it("is not offered to someone the database would refuse, nor for a refused or expired request", () => {
    panel({ on: true, v: APPROVED, req: failed(), access: "not_admin" });
    expect(screen.queryByRole("button", { name: en.review.visibility.tryAgain })).toBeNull();
    cleanup();
    panel({ on: true, v: APPROVED, req: failed(), access: "not_member" });
    expect(screen.queryByRole("button", { name: en.review.visibility.tryAgain })).toBeNull();
    cleanup();
    panel({ on: true, v: APPROVED, req: request({ status: "refused", reason: "gate_blocked", finished_at: DECIDED }) });
    expect(screen.queryByRole("button", { name: en.review.visibility.tryAgain })).toBeNull();
  });

  it("is not offered once the request has been carried out as often as the database allows, and the database's refusal is read out", async () => {
    panel({ on: true, v: APPROVED, req: request({ status: "failed", reason: "token_expired", attempts: 3, lifetime_attempts: 6, finished_at: DECIDED }) });
    expect(visBlock()?.textContent).toContain("Not published yet.");
    expect(screen.queryByRole("button", { name: en.review.visibility.tryAgain })).toBeNull();
    cleanup();
    h.rpc.mockResolvedValue({ data: { ok: false, error: "retry_limit" }, error: null });
    panel({ on: true, v: APPROVED, req: request({ status: "failed", reason: "token_expired", attempts: 3, lifetime_attempts: 5, finished_at: DECIDED }) });
    fireEvent.click(screen.getByRole("button", { name: en.review.visibility.tryAgain }));
    await waitFor(() => expect(screen.getByTestId("retry-error").textContent).toBe(en.review.visibility.retryErrors.retry_limit));
    await settle();
  });

  it("a refusal is read out in words, a transport error is a generic failure, never the raw message", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, error: "approval_superseded" }, error: null });
    panel({ on: true, v: APPROVED, req: failed() });
    fireEvent.click(screen.getByRole("button", { name: en.review.visibility.tryAgain }));
    await waitFor(() => expect(screen.getByTestId("retry-error").textContent).toBe(en.review.visibility.retryErrors.approval_superseded));
    expect(h.refresh).not.toHaveBeenCalled();
    h.rpc.mockResolvedValue({ data: { ok: false, error: "drop table videos" }, error: null });
    fireEvent.click(screen.getByRole("button", { name: en.review.visibility.tryAgain }));
    await waitFor(() => expect(screen.getByTestId("retry-error").textContent).toBe(en.review.visibility.retryErrors.failed));
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "internal: password=hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: en.review.visibility.tryAgain }));
    await waitFor(() => expect(screen.getByTestId("retry-error").textContent).toBe(en.review.visibility.retryErrors.failed));
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    fireEvent.click(screen.getByRole("button", { name: en.review.visibility.tryAgain }));
    await waitFor(() => expect(screen.getByTestId("retry-error").textContent).toBe(en.review.visibility.retryErrors.forbidden));
    expect(document.body.textContent).not.toContain("hunter2");
    await settle();
  });
});
