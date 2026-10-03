"use client";

import Link from "next/link";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { BrandMark } from "@/components/site/BrandMark";
import { preloadSiteFonts } from "@/components/site/fonts";
import "@/components/site/site.css";

/**
 * The frame of the connection screens (/oauth/authorize): one column on every
 * width, phone first. No navigation out except the brand: a person here is in
 * the middle of an approval, and nothing on the page should invite them away
 * before they decide.
 */
export function OAuthShell({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  const { t, locale } = usePublicI18n();
  preloadSiteFonts(locale);
  return (
    <div className="st st-auth" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <main className="st-auth-main">
        <div className="flex min-h-14 items-center justify-between gap-3">
          <Link href="/" className="st-brand">
            <BrandMark />
            {t.brand.name}
          </Link>
          <div className="flex items-center gap-2">
            <LanguageSelector />
            <ThemeToggle />
          </div>
        </div>
        <div className="st-auth-form" style={{ maxWidth: 520, margin: "0 auto" }}>
          <h1 className="st-h1-page [overflow-wrap:anywhere]">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

/** A message with its tone: an error or a notice in the shell's alert style. */
export function OAuthNotice({ tone, children }: { tone: "fail" | "warn"; children: React.ReactNode }) {
  return (
    <p role="alert" className="st-alert mt-5" data-tone={tone}>
      <span aria-hidden className="ns-lamp mt-1.5" data-tone={tone} />
      <span>{children}</span>
    </p>
  );
}
