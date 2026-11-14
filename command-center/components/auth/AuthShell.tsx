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
import { Wordmark } from "@/components/site/Wordmark";
import { preloadSiteFonts } from "@/components/site/fonts";
import { ClipPause } from "@/components/site/ClipPause";
import { useMotionTap } from "@/lib/site/motion";
import { slotMedia, type SlotId } from "@/components/site/samples";
import { AiBadge, PlaceFill, placeBox } from "@/components/site/PlaceFill";
import { creditLine } from "@/lib/site/media";
import { FlowCard } from "@/components/auth/FlowCard";
import "@/components/site/site.css";
import "@/components/site/site-next.css";
import "@/components/site/site-motion.css";
import { SiteMotion } from "@/components/site/motion/SiteMotion";

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
  // The stage's picture (and its lamp) stop on a tap, as on the marketing pages (lib/site/motion.ts motionTap).
  useMotionTap();
  const a = t.site.auth;
  preloadSiteFonts(locale);
  const asideTitle = mode === "signup" ? a.asideTitleSignup : a.asideTitle;
  // The picture behind the stage is what the slot shows: one of our samples (credited with its model under the stage) or the stock fallback (credited with its contributor).
  const slot: SlotId = mode === "signup" ? "auth.signup" : "auth.login";
  const m = slotMedia(slot);
  const moving = m.kind === "ai" ? m.moving : m.clip !== null;
  const photo = m.kind === "stock" ? m.id : "sample";
  const caption = m.kind === "stock" && (m.id === "desert" || m.id === "floating") ? `${t.site.samples.captions[m.id]}. ` : "";
  const credit = m.kind === "stock" ? `${caption}${creditLine(m.id, t.site.samples.credit)}` : null;
  return (
    <div className="st nx st-auth">
      {/* The same first stop as the marketing pages: past the brand, the way back, language and theme, to the form. */}
      <a href="#main" className="st-skip">
        {t.landing.nav.skip}
      </a>
      <aside className="st-auth-aside" aria-label={asideTitle} data-photo={photo} {...placeBox(m)}>
        {/* A picture behind the house rules (decorative: darkened under the words, credited below); the flow card on it is the example. */}
        <PlaceFill media={m} s={t.site} alt="" className="nx-aside-bg" eager early labels={false} sizes="(min-width: 960px) 900px, 1px" />
        {moving && <ClipPause label={t.site.fx.pause} />}
        <Link href="/" className="st-brand self-start" aria-label={t.brand.name}>
          <Wordmark />
        </Link>
        <div className="flex flex-col gap-8">
          <p className="st-h2 max-w-[9em]">{asideTitle}</p>
          <FlowCard stage={t.site.stage} />
          <ul className="st-ledger max-w-[470px]">
            {a.asideItems.map((line) => (
              <li key={line} className="text-base">
                <span aria-hidden className="ns-lamp" data-tone="ok" />
                {line}
              </li>
            ))}
          </ul>
        </div>
        <div className="nx-aside-foot flex flex-col gap-3">
          <span className="flex items-center gap-3 text-[15px]">
            <span aria-hidden className="ns-lamp" data-tone="run" data-size="md" data-live="true" />
            {a.asideLamp}
          </span>
          <span className="st-small">{fmt(a.welcomeNote, { n: formatCredits(WELCOME_CREDITS, locale) })}</span>
          {credit !== null ? <span className="st-small nx-aside-note">{credit}</span> : m.kind === "ai" && <AiBadge g={t.site.gallery} className="nx-ai-credit nx-aside-note" />}
        </div>
      </aside>

      <main id="main" tabIndex={-1} className="st-auth-main focus:outline-none">
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

        {/* On a phone the stage is a band above the form: the same drawing, the brand over it, the brief and the approval playing on it. */}
        <div className="nx-auth-band lg:hidden" data-photo={photo} {...placeBox(m)}>
          <PlaceFill media={m} s={t.site} alt="" eager early labels={m.kind === "stock"} sizes="(max-width: 959px) 100vw, 1px" />
          {moving && <ClipPause label={t.site.fx.pause} />}
          {m.kind === "ai" && <AiBadge g={t.site.gallery} className="nx-ai-credit nx-result-ai" />}
          <Link href="/" className="st-brand" aria-label={t.brand.name}>
            <Wordmark />
          </Link>
          <FlowCard stage={t.site.stage} compact />
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
      <SiteMotion />
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
