"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import {
  HOME_LANGUAGES,
  HOME_LENGTHS,
  TOPIC_MAX,
  defaultLanguage,
  lengthSeconds,
  runHandoffHref,
  type HomeLanguage,
  type HomeLengthId,
} from "@/lib/home";

/** A channel the composer can hand a topic to (verified: rule 7). */
export interface ComposerChannel {
  slug: string;
  name: string;
  autoPublish: boolean;
}

export interface ComposerHandle {
  /** A format card's preset: the length, a starter brief, and the box in view. */
  preset(length: HomeLengthId, starter: string): void;
}

/**
 * "What should your channel post next?" — one box, three chips, one button.
 *
 * It starts nothing and spends nothing. The button is a link into the chosen
 * channel's run form (/create, CreateStudio) with the topic, length and
 * language filled in; that form shows the price and asks for confirmation,
 * and the channel's approval gate applies to what it makes, exactly as when
 * the form is opened by hand. With no connected channel the same button leads
 * to connecting one instead.
 */
export const HomeComposer = forwardRef<ComposerHandle, { channels: ComposerChannel[]; currentSlug: string | null }>(
  function HomeComposer({ channels, currentSlug }, ref) {
    const { t, locale } = useI18n();
    const path = useChannelPath();
    const router = useRouter();
    const box = useRef<HTMLTextAreaElement>(null);
    const [topic, setTopic] = useState("");
    const [length, setLength] = useState<HomeLengthId>("m5_10");
    const [language, setLanguage] = useState<HomeLanguage>(defaultLanguage(locale));
    const [slug, setSlug] = useState<string>(
      channels.find((c) => c.slug === currentSlug)?.slug ?? channels[0]?.slug ?? "",
    );

    useImperativeHandle(ref, () => ({
      preset(next, starter) {
        setLength(next);
        setTopic(starter.slice(0, TOPIC_MAX));
        const el = box.current;
        el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
        // Put the caret on the first [bracket], the part that is theirs to write.
        requestAnimationFrame(() => {
          if (!el) return;
          el.focus({ preventScroll: true });
          const at = starter.indexOf("[");
          if (at >= 0) el.setSelectionRange(at, Math.max(at, starter.indexOf("]", at) + 1));
        });
      },
    }));

    const channel = channels.find((c) => c.slug === slug) ?? null;
    const href = channel
      ? runHandoffHref(channel.slug, { topic, seconds: lengthSeconds(length), language })
      : path("/channels/new");

    const chip = (on: boolean) =>
      `rounded-[var(--ns-r-key)] inline-flex min-h-9 items-center px-3 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] ${
        on
          ? "bg-[var(--color-fg)] font-medium text-[var(--color-bg)]"
          : "border border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-fg)]"
      }`;

    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-[var(--ns-r-sheet)] border border-[var(--color-border)] bg-[var(--color-panel)] p-3 shadow-[var(--shadow-panel)] transition-colors focus-within:border-[color-mix(in_srgb,var(--color-primary)_60%,var(--color-border))] sm:p-4">
          <label htmlFor="home-topic" className="sr-only">
            {t.home.promptLabel}
          </label>
          <textarea
            id="home-topic"
            ref={box}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter goes on to the price; plain Enter is a newline.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                router.push(href);
              }
            }}
            rows={3}
            maxLength={TOPIC_MAX}
            placeholder={t.home.placeholder}
            // 16px: iOS zooms the page into any smaller text field.
            className="w-full resize-none bg-transparent px-1 text-[16px] leading-relaxed text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)]"
          />

          <div role="radiogroup" aria-label={t.home.lengthLabel} className="mt-2 flex flex-wrap gap-1.5">
            {HOME_LENGTHS.map((l) => (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={length === l.id}
                onClick={() => setLength(l.id)}
                className={chip(length === l.id)}
              >
                {t.home.lengths[l.id]}
              </button>
            ))}
          </div>

          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div role="radiogroup" aria-label={t.home.languageLabel} className="flex flex-wrap gap-1.5">
              {HOME_LANGUAGES.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={language === l.value}
                  lang={l.id}
                  onClick={() => setLanguage(l.value)}
                  className={chip(language === l.value)}
                >
                  {l.label}
                </button>
              ))}
            </div>
            {channels.length > 0 && (
              <label className="flex min-w-0 items-center gap-2 sm:ml-1">
                <span className="sr-only">{t.home.channelLabel}</span>
                <select
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="rounded-[var(--ns-r-key)] min-h-9 w-full max-w-full truncate border border-[var(--color-border)] bg-transparent px-3 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:w-auto sm:max-w-[14rem]"
                >
                  {channels.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Link
              href={href}
              className="btn-primary inline-flex min-h-11 items-center justify-center gap-2 px-5 text-[14px] font-semibold sm:ml-auto"
            >
              {channel ? (
                <>
                  {t.home.continue}
                  <ArrowRight aria-hidden className="size-4" />
                </>
              ) : (
                <>
                  <Plus aria-hidden className="size-4" />
                  {t.home.connect}
                </>
              )}
            </Link>
          </div>
        </div>

        <p className="px-1 text-[12px] leading-relaxed text-[var(--color-muted)]" aria-live="polite">
          {channel ? (
            <>
              {t.home.handoffNote} {channel.autoPublish ? t.home.approvalAuto : t.home.approvalPrivate}
              {length === "short" && <> {t.home.shortNote}</>}
            </>
          ) : (
            t.home.noChannel
          )}
        </p>
      </div>
    );
  },
);
