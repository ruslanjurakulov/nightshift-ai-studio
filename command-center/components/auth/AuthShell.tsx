"use client";

import { useI18n } from "@/lib/i18n/context";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { NeuralBackdrop } from "@/components/NeuralBackdrop";
import { LegalFooter } from "@/components/legal/LegalFooter";

/**
 * The frame around sign-in and sign-up: the Neural Pathway backdrop, the
 * language and theme controls, the brand, one card, and the legal footer —
 * both pages are where a new person first hands over data, so the policies are
 * linked from each.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <main className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-[#03060c]">
      <NeuralBackdrop />

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <LanguageSelector />
        <ThemeToggle />
      </div>

      <div className="relative z-10 flex w-full flex-1 items-center justify-center p-6">
        <div className="glass-card sheet-enter stagger-enter relative z-10 w-full max-w-sm rounded-[22px] border border-[var(--color-border)] p-8">
          <div
            className="font-display text-2xl font-semibold tracking-[-0.02em] text-[var(--color-primary)]"
            style={{ textShadow: "0 0 28px var(--glow-primary)" }}
          >
            {t.brand.name}
          </div>
          <div className="mt-1 text-[11px] font-light tracking-[0.14em] text-[var(--color-muted)]">
            {t.brand.tagline}
          </div>
          <h1 className="mt-8 text-[28px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
          {subtitle && <p className="mt-3 text-[15px] font-light text-[var(--color-muted)]">{subtitle}</p>}
          {children}
        </div>
      </div>

      <LegalFooter />
    </main>
  );
}

/** A labelled field in the auth forms' style. */
export function AuthField({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">{label}</span>
      <input
        {...input}
        className="pill border border-[var(--color-border)] bg-transparent px-5 py-3 text-[15px] font-light outline-none transition-colors focus:border-[var(--color-primary)]"
      />
      {hint && <span className="px-2 text-[11px] font-light text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}
