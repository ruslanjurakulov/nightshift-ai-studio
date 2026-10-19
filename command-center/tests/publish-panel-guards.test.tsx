// @vitest-environment jsdom
/**
 * "Publish to platforms": the reason words the worker writes for a refused or failed cross-post, in all three
 * languages. A word without a sentence shows as a bare "Failed.", so each new word is pinned here: the TikTok
 * "unaudited app" error and the pre-upload file checks. The panel only reads rows; nothing here publishes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/components/videos/DownloadMenu", () => ({ DownloadMenu: () => null }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { PublishPanel, type PublishPanelProps } from "@/components/videos/PublishPanel";
import { PUBLISH_REASONS, type PublishRequestRow } from "@/lib/publish";
import type { SocialAccount } from "@/lib/social-accounts";
import type { Locale } from "@/lib/i18n";

const LOCALES: Locale[] = ["en", "ru", "uz"];
const ACC = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";

const account = (platform: "instagram" | "tiktok"): SocialAccount => ({
  id: ACC,
  org_id: "org",
  platform,
  external_id: "1",
  username: "night.owl",
  display_name: null,
  avatar_url: null,
  status: "connected",
  scopes: [],
  connected_at: null,
  connected_by_email: null,
  revoked_at: null,
});

const request = (over: Partial<PublishRequestRow> = {}): PublishRequestRow => ({
  id: 1,
  video_id: "vid1",
  account_id: ACC,
  target_channel_id: null,
  platform: "tiktok",
  status: "failed",
  reason: null,
  error: null,
  result_id: null,
  result_url: null,
  privacy: null,
  created_at: null,
  finished_at: null,
  ...over,
});

function panel(locale: Locale, over: Partial<PublishPanelProps> = {}) {
  const props: PublishPanelProps = {
    video: {
      video_id: "vid1",
      channel_id: "news",
      title: "T",
      privacy: "private",
      published_at: "2026-10-01T00:00:00Z",
      publish_state: "uploaded",
      review_state: "approved",
      preview_path: null,
    },
    channelName: "News",
    accounts: [account("tiktok")],
    youtube: [],
    requests: [],
    available: true,
    role: "editor",
    downloads: {} as PublishPanelProps["downloads"],
    ...over,
  };
  return render(
    <I18nProvider locale={locale}>
      <PublishPanel {...props} />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("every reason word has a sentence in en, ru and uz", () => {
  it.each(LOCALES)("%s: one non-empty sentence per word, and none without a word", (locale) => {
    const reasons = dictionaries[locale].publish.reasons as Record<string, string>;
    expect(Object.keys(reasons).sort()).toEqual([...PUBLISH_REASONS].sort());
    for (const word of PUBLISH_REASONS) expect(reasons[word].trim().length, word).toBeGreaterThan(3);
  });

  it("the three languages say it in their own words", () => {
    for (const word of PUBLISH_REASONS) {
      const en = (dictionaries.en.publish.reasons as Record<string, string>)[word];
      expect((dictionaries.ru.publish.reasons as Record<string, string>)[word], word).not.toBe(en);
      expect((dictionaries.uz.publish.reasons as Record<string, string>)[word], word).not.toBe(en);
    }
  });
});

describe("TikTok: the unaudited-app error", () => {
  const WORDS: Record<Locale, RegExp> = { en: /private TikTok account/, ru: /приватного аккаунта/, uz: /shaxsiy \(private\) akkaunt/ };

  it.each(LOCALES)("%s: the panel says to make the account private, with the worker's own detail", (locale) => {
    const detail = "tiktok init: HTTP 403, unaudited_client_can_only_post_to_private_accounts";
    panel(locale, { requests: [request({ reason: "tiktok_unaudited", error: detail })] });
    const sentence = (dictionaries[locale].publish.reasons as Record<string, string>).tiktok_unaudited;
    expect(sentence).toMatch(WORDS[locale]);
    expect(screen.getByText(`${sentence} — ${detail}`)).toBeTruthy();
    // It is a failure with a fix, not the generic "platform refused".
    expect(screen.queryByText(dictionaries[locale].publish.reasons.platform_error)).toBeNull();
  });

  it.each(LOCALES)("%s: the note under the account says the account must be private, and SELF_ONLY stays", (locale) => {
    panel(locale);
    const note = dictionaries[locale].publish.tiktokPrivate;
    expect(screen.getByText(note)).toBeTruthy();
    expect(note).toMatch({ en: /TikTok account itself to be private/, ru: /сам аккаунт TikTok был приватным/, uz: /akkauntning oʻzi ham shaxsiy/ }[locale]);
  });

  it("an unknown word still reads as the generic failure, never as the TikTok advice", () => {
    panel("en", { requests: [request({ reason: "something_else" })] });
    expect(screen.getByText(dictionaries.en.publish.reasons.worker_error)).toBeTruthy();
    expect(screen.queryByText(dictionaries.en.publish.reasons.tiktok_unaudited)).toBeNull();
  });
});

describe("the pre-upload file checks", () => {
  const WORDS = ["unreadable_video", "bad_codec", "bad_audio", "bad_framerate", "too_wide", "bad_resolution", "not_faststart"] as const;
  const KEY: Record<(typeof WORDS)[number], Record<Locale, RegExp>> = {
    unreadable_video: { en: /could not be read/, ru: /не удалось прочитать/, uz: /oʻqib boʻlmadi/ },
    bad_codec: { en: /picture format/, ru: /формат изображения/, uz: /tasvir formatini/ },
    bad_audio: { en: /AAC/, ru: /AAC/, uz: /AAC/ },
    bad_framerate: { en: /23 to 60/, ru: /23–60/, uz: /23–60/ },
    too_wide: { en: /1920/, ru: /1920/, uz: /1920/ },
    bad_resolution: { en: /360 to 4096/, ru: /360 до 4096/, uz: /360 dan 4096/ },
    not_faststart: { en: /index/, ru: /индекс/, uz: /indeks/ },
  };

  it.each(LOCALES)("%s: a refusal shows its own sentence and the worker's detail, as a refusal", (locale) => {
    for (const word of WORDS) {
      cleanup();
      const detail = `the file says ${word}`;
      panel(locale, { requests: [request({ platform: "instagram", status: "refused", reason: word, error: detail })] });
      const sentence = (dictionaries[locale].publish.reasons as Record<string, string>)[word];
      expect(sentence, word).toMatch(KEY[word][locale]);
      expect(screen.getByText(`${sentence} — ${detail}`), word).toBeTruthy();
      expect(screen.getByText(dictionaries[locale].publish.status.refused), word).toBeTruthy();
    }
  });
});

describe("the Channels page note", () => {
  it.each(LOCALES)("%s: names the private-account requirement", (locale) => {
    const note = dictionaries[locale].socialAccounts.tiktokPrivateNote;
    expect(note).toMatch({ en: /private TikTok account/, ru: /приватного аккаунта/, uz: /shaxsiy akkauntdan/ }[locale]);
    expect(note).toContain("SELF_ONLY");
  });
});
