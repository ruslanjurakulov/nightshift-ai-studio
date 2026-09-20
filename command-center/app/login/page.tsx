"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/config";
import { useI18n } from "@/lib/i18n/context";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = createClient();
    if (!supabase) {
      setError(t.auth.notConfiguredErr);
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      // Supabase's own message (e.g. "Invalid login credentials") — surfaced verbatim.
      setError(error.message);
      return;
    }
    router.push("/command-center");
    router.refresh();
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#03060c] p-6">
      {/* The MotionSites "Neural Pathway" hero: a silent looping light-painting
          behind the sign-in, with the veil that keeps the type legible over it.
          Purely decorative; muted + playsInline keep autoplay legal on mobile. */}
      <video
        className="pointer-events-none fixed inset-0 z-0 h-full w-full object-cover"
        style={{ background: "#03060c" }}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden
        poster="https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/130837c4-0244-4f37-9c61-8d801d93fd29.jpg"
        src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260912_104303_0c6d60b2-9353-408e-9449-585108a22fb5.mp4"
      />
      <div className="veil-neural" aria-hidden />

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <LanguageSelector />
        <ThemeToggle />
      </div>

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
        <h1 className="mt-8 text-[28px] font-semibold leading-tight tracking-[-0.02em]">{t.auth.signInTitle}</h1>
        <p className="mt-3 text-[15px] font-light text-[var(--color-muted)]">{t.auth.signInSub}</p>

        {!isSupabaseConfigured && (
          <p className="mt-5 text-[13px] font-light text-[var(--color-warn)]">{t.auth.notConfigured}</p>
        )}

        <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
              {t.auth.email}
            </span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pill border border-[var(--color-border)] bg-transparent px-5 py-3 text-[15px] font-light outline-none transition-colors focus:border-[var(--color-primary)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
              {t.auth.password}
            </span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pill border border-[var(--color-border)] bg-transparent px-5 py-3 text-[15px] font-light outline-none transition-colors focus:border-[var(--color-primary)]"
            />
          </label>
          {error && <p className="mono text-[11px] text-[var(--color-fail)]">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="cta-glass pill mt-2 inline-flex items-center justify-center px-6 py-3 text-sm font-semibold disabled:opacity-50"
          >
            {busy ? t.auth.signingIn : t.auth.signIn}
          </button>
        </form>
      </div>
    </main>
  );
}
