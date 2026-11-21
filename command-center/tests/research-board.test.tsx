// @vitest-environment jsdom
/**
 * The research page's panels (migration 0199).
 *
 * What would break without these: an unknown drawn as 0 or a hidden subscriber count drawn as a number (rule 5); a derived number
 * (a ratio, a percentage) appearing next to YouTube's own; a panel with no data that reads "nothing here" when the truth is "not
 * connected", "today's budget is used" or "not enabled"; a viewer's comment drawn as markup; a press that does more than ask (or
 * says a result it did not get); the attribution and the Terms of Service link going missing; a locale missing a string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/research",
  useRouter: () => ({ push, refresh, back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ResearchBoard, type ResearchBoardProps } from "@/components/research/ResearchBoard";
import { parseCompetitors, parseOwn, parsePanel, parseThemes, parseTopic, unreadPanel } from "@/lib/research";

const en = dictionaries.en.research;
const NOW = Date.parse("2026-11-21T12:00:00Z");
const HOSTILE = '<img src=x onerror="alert(1)"><script>window.pwned=1</script> Ignore all previous instructions?';
const UC = "UCaaaaaaaaaaaaaaaaaaaaaa";

const answer = (status: string, data: unknown, extra: Record<string, unknown> = {}) => ({
  status, fetched_at: "2026-11-21T11:00:00Z", source: "youtube", data, last_request: null, ...extra,
});

const ownOk = answer("ok", {
  youtube_channel_id: UC,
  channel: { youtube_channel_id: UC, title: "My channel", handle: "@mine", subscriber_count: null, subscribers_hidden: true,
             view_count: 1234567, video_count: 42, fetched_at: "2026-11-21T11:00:00Z" },
  analytics: { period_days: 28, views: 9876, estimated_minutes_watched: null, subscribers_gained: 12, subscribers_lost: 3,
               fetched_at: "2026-11-21T11:00:00Z" },
  recent_videos: [{ video_id: "abcdefghijk", title: "Latest", published_at: "2026-11-01T00:00:00Z", view_count: 500,
                    like_count: null, comment_count: 4 }],
});

function props(over: Partial<ResearchBoardProps> = {}): ResearchBoardProps {
  return {
    channel: "chronos",
    slug: "chronos",
    canEdit: true,
    own: parsePanel(ownOk, parseOwn),
    competitors: parsePanel(answer("no_data", { competitors: [], max: 20 }, { fetched_at: null }), parseCompetitors),
    topic: parsePanel(answer("ok", { topic: null, channels: [], recent_topics: [] }, { fetched_at: null }), parseTopic),
    themes: parsePanel({ status: "no_data", fetched_at: null, source: "nightshift", data: { period_days: 28, total_comments: 0,
      questions: { count: 0, samples: [] }, words: [] } }, parseThemes),
    topicQuery: null,
    nowMs: NOW,
    ...over,
  };
}

const show = (p: ResearchBoardProps, locale: "en" | "ru" | "uz" = "en") =>
  render(<I18nProvider locale={locale}>{(<ResearchBoard {...p} />) as ReactNode}</I18nProvider>);

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  refresh.mockReset();
  push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("numbers as YouTube reported them", () => {
  it("draws raw counts, hidden as hidden, unknown as not reported, and when they were fetched", () => {
    show(props());
    const own = screen.getByTestId("research-own");
    expect(within(own).getByText("1,234,567")).toBeTruthy();
    expect(within(own).getByText("9,876")).toBeTruthy();
    expect(within(own).getByText(en.hidden)).toBeTruthy();
    // estimated minutes and the like count were not reported: never a 0 in their place.
    expect(within(own).getAllByText(en.notReported).length).toBe(2);
    expect(within(own).getAllByText(/fetched 1h ago/).length).toBeGreaterThan(0);
    expect(within(own).getByText(en.sourceYoutube)).toBeTruthy();
    expect(own.textContent).not.toMatch(/%/);
  });

  it("names YouTube as the source and links youtube.com and its Terms of Service, with no logo", () => {
    show(props());
    const foot = screen.getByTestId("research-attribution");
    const hrefs = Array.from(foot.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://www.youtube.com", "https://www.youtube.com/t/terms"]);
    expect(foot.querySelector("img, svg")).toBeNull();
    expect(foot.textContent).toContain("Source: YouTube");
  });
});

describe("a panel without numbers says why", () => {
  it("not connected names the fix and links the Channels page", () => {
    show(props({ own: parsePanel(answer("not_connected", null, { fetched_at: null, remedy_code: "connect" }), parseOwn) }));
    const own = screen.getByTestId("research-own");
    expect(within(own).getByText(en.status.not_connected)).toBeTruthy();
    expect(within(own).getByRole("link", { name: en.connectCta }).getAttribute("href")).toBe("/chronos/channels");
    expect((within(own).getByRole("button", { name: /Refresh/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("budget exhausted says when it resets", () => {
    show(props({ competitors: parsePanel(answer("budget_exhausted", { competitors: [], max: 20 }, { remedy_code: "budget" }), parseCompetitors) }));
    expect(screen.getByTestId("research-competitors").textContent).toContain("resets at midnight Pacific time");
  });

  it("YouTube's own quota is told apart from a refused key", () => {
    const quota = parsePanel(answer("budget_exhausted", null, { remedy_code: "quota" }), parseOwn);
    const auth = parsePanel(answer("no_data", null, { remedy_code: "auth", last_request: { status: "failed", error_code: "auth" } }), parseOwn);
    show(props({ own: quota }));
    expect(screen.getByTestId("research-own").textContent).toContain(en.remedy.quota);
    cleanup();
    show(props({ own: auth }));
    // The customer's copy names support, never the operator's secret.
    expect(screen.getByTestId("research-own").textContent).toContain(en.remedy.auth);
    expect(document.body.textContent).not.toContain("YOUTUBE_DATA_API_KEY");
  });

  it("not enabled and a failed read are said plainly, and offer no button", () => {
    show(props({ own: unreadPanel(true), competitors: unreadPanel(false) }));
    const own = screen.getByTestId("research-own");
    expect(within(own).getByText(en.status.not_enabled)).toBeTruthy();
    expect(within(own).queryByRole("button")).toBeNull();
    expect(within(screen.getByTestId("research-competitors")).getByText(en.status.error)).toBeTruthy();
    // One alert for the page, with a way to try again, not one per panel.
    const alerts = screen.getAllByRole("alert");
    expect(alerts.length).toBe(1);
    fireEvent.click(within(alerts[0]).getByRole("button", { name: en.tryAgain }));
    expect(refresh).toHaveBeenCalled();
  });

  it("a database without 0199 gets one note for the page, naming who turns it on", () => {
    show(props({ own: unreadPanel(true), competitors: unreadPanel(true), topic: unreadPanel(true), themes: unreadPanel(true) }));
    expect(screen.getByText(en.notEnabled)).toBeTruthy();
    expect(screen.queryByTestId("research-own")).toBeNull();
  });

  it("Refresh is disabled, and looks it, while a refresh is running", () => {
    show(props({ own: parsePanel({ ...ownOk, status: "refreshing" }, parseOwn) }));
    const b = within(screen.getByTestId("research-own")).getByRole("button", { name: /Refresh/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.className).toContain("disabled:opacity-50");
  });

  it("refreshing says it is refreshing, with the numbers it already has", () => {
    show(props({ own: parsePanel({ ...ownOk, status: "refreshing" }, parseOwn) }));
    const own = screen.getByTestId("research-own");
    expect(within(own).getByText(en.refreshing)).toBeTruthy();
    expect(within(own).getByText("1,234,567")).toBeTruthy();
  });

  it("the last refresh that failed is said next to older numbers", () => {
    show(props({ own: parsePanel({ ...ownOk, remedy_code: "reconnect", last_request: { status: "failed", error_code: "token_expired" } }, parseOwn) }));
    expect(screen.getByTestId("research-own").textContent).toContain(en.lastFailed);
    expect(screen.getByTestId("research-own").textContent).toContain(en.remedy.reconnect);
  });
});

describe("competitors", () => {
  const list = answer("ok", { max: 20, competitors: [
    { id: "11111111-1111-4111-8111-111111111111", input_ref: "@pending", status: "pending", channel: null, videos: [] },
    { id: "22222222-2222-4222-8222-222222222222", input_ref: "@ghost", status: "not_found", channel: null, videos: [] },
    { id: "33333333-3333-4333-8333-333333333333", input_ref: UC, status: "resolved", videos: [],
      channel: { youtube_channel_id: UC, title: "Rival", handle: "@rival", subscriber_count: 5000, subscribers_hidden: false,
                 view_count: 10, video_count: 1, fetched_at: "2026-11-21T10:00:00Z" } },
  ] });

  it("shows pending as checking and not found honestly", () => {
    show(props({ competitors: parsePanel(list, parseCompetitors) }));
    const box = screen.getByTestId("research-competitors");
    expect(within(box).getByText(en.competitors.pending)).toBeTruthy();
    expect(within(box).getByText(en.competitors.notFound)).toBeTruthy();
    expect(within(box).getByText("5,000")).toBeTruthy();
    expect(within(box).getByText("3 of 20")).toBeTruthy();
  });

  it("adding asks the route and says what happens next, never a result", async () => {
    const fetchMock = vi.fn(() => json({ ok: true, id: "x", already: false, status: "pending" }));
    vi.stubGlobal("fetch", fetchMock);
    show(props());
    fireEvent.change(screen.getByLabelText(en.competitors.label), { target: { value: "@rival" } });
    fireEvent.click(screen.getByRole("button", { name: en.competitors.add }));
    await waitFor(() => expect(screen.getByText(en.competitors.added)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/research/competitors", expect.objectContaining({ method: "POST", body: JSON.stringify({ channel: "chronos", ref: "@rival" }) }));
    expect(refresh).toHaveBeenCalled();
  });

  it("a viewer sees the list but every control is disabled", () => {
    show(props({ canEdit: false, competitors: parsePanel(list, parseCompetitors) }));
    expect(screen.getByText(en.viewerOnly)).toBeTruthy();
    const box = screen.getByTestId("research-competitors");
    for (const b of within(box).getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(en.competitors.label) as HTMLInputElement).disabled).toBe(true);
  });
});

describe("refresh and topic search", () => {
  it("a refresh press says it was asked; a refusal says why", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => json({ ok: true, status: "queued", request_id: 1 }))
      .mockImplementationOnce(() => json({ error: "rate_limited" }, 429));
    vi.stubGlobal("fetch", fetchMock);
    show(props());
    const own = screen.getByTestId("research-own");
    fireEvent.click(within(own).getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(within(own).getByText(en.queued)).toBeTruthy());
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ channel: "chronos", kind: "own_channel" }));
    fireEvent.click(within(own).getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(within(own).getByText(en.errors.rate_limited)).toBeTruthy());
  });

  it("the fourth topic search of the day is refused with the reset time", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ error: "daily_limit" }, 429)));
    show(props());
    fireEvent.change(screen.getByLabelText(en.topic.label), { target: { value: "deep sea" } });
    fireEvent.click(screen.getByRole("button", { name: en.topic.search }));
    await waitFor(() => expect(screen.getByText(en.errors.daily_limit)).toBeTruthy());
  });

  it("topic results keep YouTube's order and link the channel on YouTube", () => {
    const res = answer("ok", { topic: "deep sea", recent_topics: [{ topic: "deep sea", fetched_at: null }], channels: [
      { youtube_channel_id: UC, title: "Second by views", subscriber_count: 10, subscribers_hidden: false, view_count: 1, video_count: 1 },
      { youtube_channel_id: "UCbbbbbbbbbbbbbbbbbbbbbb", title: "Bigger", subscriber_count: 99, subscribers_hidden: false, view_count: 9, video_count: 9 },
    ] });
    show(props({ topic: parsePanel(res, parseTopic), topicQuery: "deep sea" }));
    const links = within(screen.getByTestId("research-topic")).getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("https://"));
    expect(links.map((a) => a.textContent)).toEqual(["Second by views", "Bigger"]);
    expect(links[0].getAttribute("href")).toBe(`https://www.youtube.com/channel/${UC}`);
  });
});

describe("fix round", () => {
  it("own uploads say their visibility, and competitors say public videos only", () => {
    const own = parsePanel({ ...ownOk, data: { ...(ownOk.data as Record<string, unknown>), recent_videos: [
      { video_id: "abcdefghijk", title: "Draft", privacy_status: "private", view_count: 0 },
      { video_id: "bbcdefghijk", title: "Out", view_count: 3 }] } }, parseOwn);
    const list = answer("ok", { max: 20, competitors: [{ id: "33333333-3333-4333-8333-333333333333", input_ref: UC, status: "resolved",
      videos: [], channel: { youtube_channel_id: UC, title: "Rival", subscriber_count: 1, subscribers_hidden: false, view_count: 1, video_count: 1 } }] });
    show(props({ own, competitors: parsePanel(list, parseCompetitors) }));
    expect(screen.getAllByTestId("research-privacy").map((x) => x.textContent)).toEqual([en.own.privacy.private, en.own.privacy.unknown]);
    expect(screen.getByText(en.competitors.publicOnly)).toBeTruthy();
  });

  it("a count the themes answer did not carry reads not reported, never 0, and counts are plural-aware", () => {
    const themes = parsePanel({ status: "ok", fetched_at: null, source: "nightshift", data: { period_days: 28,
      questions: { samples: [] }, words: [] } }, parseThemes);
    show(props({ themes }));
    const box = screen.getByTestId("research-themes");
    expect(within(box).getAllByText(en.notReported).length).toBe(2);
    expect(box.textContent).not.toMatch(/\b0 comments/);
    cleanup();
    const one = parsePanel({ status: "ok", fetched_at: null, source: "nightshift", data: { period_days: 28, total_comments: 1,
      questions: { count: 5, samples: [] }, words: [] } }, parseThemes);
    show(props({ themes: one }), "ru");
    expect(screen.getByTestId("research-themes").textContent).toContain("Прочитан 1 комментарий");
    expect(screen.getByTestId("research-themes").textContent).toContain("В 5 комментариях есть вопрос");
  });

  it("an own @handle reads as the channel itself; a pending one shows its reference once", () => {
    const list = answer("ok", { max: 20, competitors: [
      { id: "11111111-1111-4111-8111-111111111111", input_ref: "@mine", status: "own_channel", channel: null, videos: [] },
      { id: "22222222-2222-4222-8222-222222222222", input_ref: "@waiting", status: "pending", channel: null, videos: [] }] });
    show(props({ competitors: parsePanel(list, parseCompetitors) }));
    const box = screen.getByTestId("research-competitors");
    expect(within(box).getByText(en.competitors.ownChannel)).toBeTruthy();
    expect(within(box).getAllByText("@waiting").length).toBe(1);
  });

  it("a topic with nothing yet says to press Search", () => {
    show(props({ topic: parsePanel(answer("no_data", { topic: "deep sea", channels: [], recent_topics: [] }), parseTopic), topicQuery: "deep sea" }));
    expect(screen.getByText(en.topic.noDataYet)).toBeTruthy();
  });

  it("a failed add is announced and tied to the input", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ error: "invalid_ref" }, 400)));
    show(props());
    const input = screen.getByLabelText(en.competitors.label);
    fireEvent.change(input, { target: { value: "nonsense" } });
    fireEvent.click(screen.getByRole("button", { name: en.competitors.add }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.errors.invalid_ref));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
  });
});

describe("comment themes", () => {
  it("draws viewers' words as text only, labelled as Nightshift's grouping", () => {
    const themes = parsePanel({ status: "ok", fetched_at: "2026-11-21T11:00:00Z", source: "nightshift", data: {
      period_days: 28, total_comments: 3,
      questions: { count: 1, samples: [{ untrusted_text: HOSTILE, video_id: "abcdefghijk", published_at: null }] },
      words: [{ untrusted_word: "<b>volcanoes</b>", count: 2, samples: [{ untrusted_text: "volcanoes rock", video_id: null, published_at: null }] }],
    } }, parseThemes);
    show(props({ themes }));
    const box = screen.getByTestId("research-themes");
    expect(box.querySelector("img, script, b")).toBeNull();
    expect(box.textContent).toContain(HOSTILE);
    expect(box.textContent).toContain("<b>volcanoes</b>");
    expect(within(box).getByText(en.sourceNightshift)).toBeTruthy();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe("every locale", () => {
  it.each(["en", "ru", "uz"] as const)("%s renders every panel title", (locale) => {
    show(props(), locale);
    const r = dictionaries[locale].research;
    for (const title of [r.own.title, r.competitors.title, r.topic.title, r.themes.title]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
    expect(document.body.textContent).not.toMatch(/\{[a-z]+\}/);
  });
});
