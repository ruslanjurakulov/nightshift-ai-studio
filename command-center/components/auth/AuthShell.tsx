"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { formatCredits } from "@/lib/credits";
import { WELCOME_CREDITS } from "@/lib/pricing";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { LegalFooter } from "@/components/legal/LegalFooter";
import { BrandMark } from "@/components/site/BrandMark";
import { preloadSiteFonts } from "@/components/site/fonts";
import { SampleImg } from "@/components/site/samples";
import "@/components/site/site.css";
import "@/components/site/site-next.css";

/**
 * The frame around sign-in, sign-up and the email confirmation: on a wide
 * screen a console panel with the three house rules beside the form, on a
 * phone just the form. Both pages are where a new person first hands over
 * data, so the policies are linked from each (LegalFooter), and the way back
 * to the homepage is always in the top bar.
 */
export function AuthShell({
  title,
  subtitle,
  mode = "signin",
  children,
}: {
  title: string;
  subtitle?: string;
  /** Which form this frames, for the house rules' heading. */
  mode?: "signin" | "signup";
  children: React.ReactNode;
}) {
  const { t, locale } = usePublicI18n();
  const a = t.site.auth;
  preloadSiteFonts(locale);
  const asideTitle = mode === "signup" ? a.asideTitleSignup : a.asideTitle;
  // A bright, warm frame on each (not the dark moon): the lanterns to sign in, the golden dunes to start.
  const still = mode === "signup" ? "silkroad" : "nightmarket";
  return (
    <div className="st nx st-auth">
      <aside className="st-auth-aside" aria-label={asideTitle}>
        {/* An example frame behind the house rules (decorative; the note below says what it is). Lazy, and the aside is not shown on a phone, so it is never fetched there. */}
        <SampleImg id={still} className="nx-aside-bg" />
        <Link href="/" className="st-brand self-start">
          <BrandMark />
          {t.brand.name}
        </Link>
        <div className="flex flex-col gap-8">
          <p className="st-h2 max-w-[16ch]">{asideTitle}</p>
          <ul className="st-ledger max-w-[44ch]">
            {a.asideItems.map((line) => (
              <li key={line} className="text-base">
                <span aria-hidden className="ns-lamp" data-tone="ok" />
                {line}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-3">
          <span className="flex items-center gap-3 text-[15px]">
            <span aria-hidden className="ns-lamp" data-tone="run" data-size="md" data-live="true" />
            {a.asideLamp}
          </span>
          <span className="st-small">{fmt(a.welcomeNote, { n: formatCredits(WELCOME_CREDITS, locale) })}</span>
          <span className="nx-aside-note">{t.site.samples.note}</span>
        </div>
      </aside>

      <main className="st-auth-main">
        <div className="flex min-h-14 items-center justify-between gap-3">
          <Link href="/" className="st-link text-sm">
            <ArrowLeft aria-hidden />
            <span className="max-[380px]:sr-only">{a.back}</span>
          </Link>
          <div className="flex items-center gap-2">
            <LanguageSelector />
            <ThemeToggle />
          </div>
        </div>

        {/* On a phone the stage is a band above the form: the same frame, the brand over it. */}
        <div className="nx-auth-band lg:hidden">
          <SampleImg id={still} className="nx-art" eager />
          <Link href="/" className="st-brand">
            <BrandMark />
            {t.brand.name}
          </Link>
          <span className="nx-result-badge">{t.site.samples.tag}</span>
        </div>
        <div className="st-auth-form">
          <h1 className="st-h1-page">{title}</h1>
          {subtitle && <p className="st-body mt-4">{subtitle}</p>}
          {children}
          {/* On a phone the house rules sit under the form instead of beside it. */}
          <ul className="st-ledger mt-10 lg:hidden" aria-label={asideTitle}>
            {a.asideItems.map((line) => (
              <li key={line}>
                <span aria-hidden className="ns-lamp" data-tone="ok" />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <LegalFooter />
      </main>
    </div>
  );
}

/** A labelled field in the auth forms' style: an engraved label over a key-shaped well. */
export function AuthField({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="st-field">
      <span>{label}</span>
      <input {...input} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** The form's one action: the lit key, full width. */
export function AuthSubmit({ busy, children, disabled }: { busy?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="submit" disabled={busy || disabled} className="st-key mt-3 disabled:cursor-not-allowed disabled:opacity-55" data-block="true">
      {children}
    </button>
  );
}

/** A form-level problem, in words, with its tone. */
export function AuthAlert({ tone, children }: { tone: "fail" | "warn"; children: React.ReactNode }) {
  return (
    <p role="alert" className="st-alert" data-tone={tone}>
      <span aria-hidden className="ns-lamp mt-1.5" data-tone={tone} />
      <span>{children}</span>
    </p>
  );
}

/** A calm, non-error line above a form (an invite banner): same shape as AuthAlert, announced politely. */
export function AuthNotice({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="st-alert" data-tone="ok">
      <span aria-hidden className="ns-lamp mt-1.5" data-tone="ok" />
      <span>{children}</span>
    </p>
  );
}
