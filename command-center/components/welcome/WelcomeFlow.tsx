"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { ALL_CHANNELS_SLUG, CHANNEL_COOKIE, channelPath } from "@/lib/channels";
import { ORG_NAME_MAX, validateOrgName } from "@/lib/orgs";
import { SignOutButton } from "@/components/SignOutButton";
import { LanguageSelector } from "@/components/LanguageSelector";
import { newChannelHref, WELCOME_NICHE_MAX, WELCOME_LANGUAGE_MAX } from "@/lib/welcome";

type Step = "workspace" | "about" | "next";

// Suggestions only: the channel's language is free text the pipeline reads as
// written, and English names are what existing channels use.
const LANGUAGE_SUGGESTIONS = ["English", "Russian", "Uzbek", "Spanish", "German", "French", "Portuguese", "Turkish", "Arabic", "Hindi"];

const inputClass =
  "min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[14px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";

function rememberAllChannels() {
  // The org switch already happened server-side (/api/org/create sets the org
  // cookie); this is the channel memory, the same thing CreateOrganizationForm sets.
  document.cookie = `${CHANNEL_COOKIE}=${ALL_CHANNELS_SLUG}; path=/; max-age=31536000; samesite=lax`;
}

export function WelcomeFlow({
  needsWorkspace,
  unavailable,
  hasChannel,
  canConnectYouTube,
  showCredits,
  welcomeCredits,
  contactEmail,
}: {
  needsWorkspace: boolean;
  unavailable: boolean;
  hasChannel: boolean;
  canConnectYouTube: boolean;
  showCredits: boolean;
  welcomeCredits: number | null;
  contactEmail: string | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  // Fixed at first render: after the workspace is created the server props
  // change (router.refresh), but the step count the person saw must not.
  const [steps] = useState<Step[]>(() => (needsWorkspace ? ["workspace", "about", "next"] : ["about", "next"]));
  const [index, setIndex] = useState(0);
  const step = steps[index];

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [niche, setNiche] = useState("");
  const [language, setLanguage] = useState("");

  const home = channelPath(ALL_CHANNELS_SLUG, "/command-center");
  const at = (section: string) => channelPath(ALL_CHANNELS_SLUG, section);

  async function createWorkspace(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const clean = validateOrgName(name);
    if (!clean) {
      setError(t.org.nameInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/org/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: clean }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error === "limit_reached" ? t.org.limitReached : t.org.createFailed);
        setBusy(false);
        return;
      }
      rememberAllChannels();
      setIndex(1);
      setBusy(false);
      // Re-read the server half: the new organization, and its welcome credits.
      router.refresh();
    } catch {
      setError(t.org.createFailed);
      setBusy(false);
    }
  }

  if (unavailable) {
    return (
      <Frame>
        <p role="alert" className="text-[14px] text-[var(--color-warn)]">
          {t.signup.unavailable}
        </p>
      </Frame>
    );
  }

  return (
    <Frame>
      <div className="t-label">{fmt(t.signup.stepOf, { n: index + 1, total: steps.length })}</div>

      {step === "workspace" && (
        <form onSubmit={createWorkspace} className="mt-3 flex flex-col gap-4">
          <div>
            <h2 className="t-section">{t.signup.wsTitle}</h2>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.signup.wsHint}</p>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{t.signup.wsLabel}</span>
            <input
              type="text"
              autoFocus
              value={name}
              maxLength={ORG_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.signup.wsPh}
              className={inputClass}
            />
          </label>
          {error && (
            <p role="alert" className="mono text-[12px] text-[var(--color-fail)]">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy || validateOrgName(name) === null}
              className="btn-sky is-solid pill px-6 py-2.5 text-[13px] disabled:opacity-40"
            >
              {busy ? t.signup.wsCreating : t.signup.wsCreate}
            </button>
          </div>
        </form>
      )}

      {step === "about" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setIndex(index + 1);
          }}
          className="mt-3 flex flex-col gap-4"
        >
          {welcomeCredits !== null && <CreditsNote amount={welcomeCredits} />}
          <div>
            <h2 className="t-section">{t.signup.aboutTitle}</h2>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.signup.aboutHint}</p>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{t.signup.nicheLabel}</span>
            <input
              type="text"
              autoFocus
              value={niche}
              maxLength={WELCOME_NICHE_MAX}
              onChange={(e) => setNiche(e.target.value)}
              placeholder={t.signup.nichePh}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
              {t.signup.languageLabel}
            </span>
            <input
              type="text"
              list="welcome-languages"
              value={language}
              maxLength={WELCOME_LANGUAGE_MAX}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder={t.signup.languagePh}
              className={inputClass}
            />
            <datalist id="welcome-languages">
              {LANGUAGE_SUGGESTIONS.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </label>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setNiche("");
                setLanguage("");
                setIndex(index + 1);
              }}
              className="btn-sky ghost pill px-5 py-2.5 text-[13px]"
            >
              {t.signup.skip}
            </button>
            <button type="submit" className="btn-sky is-solid pill px-6 py-2.5 text-[13px]">
              {t.signup.continue}
            </button>
          </div>
        </form>
      )}

      {step === "next" && (
        <div className="mt-3 flex flex-col gap-4">
          {welcomeCredits !== null && <CreditsNote amount={welcomeCredits} />}
          <div>
            <h2 className="t-section">{t.signup.nextTitle}</h2>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.signup.nextHint}</p>
          </div>
          <ol className="flex flex-col gap-2">
            <Item
              n={1}
              title={t.signup.stepChannel}
              body={t.signup.stepChannelBody}
              done={hasChannel}
              href={hasChannel ? at("/channels") : newChannelHref(ALL_CHANNELS_SLUG, { niche, language })}
            />
            <Item
              n={2}
              title={t.signup.stepYoutube}
              body={canConnectYouTube ? t.signup.stepYoutubeBody : t.signup.stepYoutubeRestricted}
              href={canConnectYouTube ? at("/channels") : undefined}
            >
              {!canConnectYouTube &&
                (contactEmail ? (
                  <a
                    href={`mailto:${contactEmail}?subject=${encodeURIComponent(t.signup.requestSubject)}`}
                    className="btn-sky ghost pill mt-2 inline-flex px-4 py-1.5 text-[12px]"
                  >
                    {t.signup.requestConnection}
                  </a>
                ) : (
                  <p className="mt-2 text-[12px] text-[var(--color-muted)]">{t.signup.requestContact}</p>
                ))}
            </Item>
            <Item n={3} title={t.signup.stepStyle} body={t.signup.stepStyleBody} href={at("/studio")} />
            {showCredits && (
              <Item n={4} title={t.signup.stepCredits} body={t.signup.stepCreditsBody} href={at("/credits")} />
            )}
            <Item
              n={showCredits ? 5 : 4}
              title={t.signup.stepCreate}
              body={t.signup.stepCreateBody}
              href={at("/create")}
            />
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setIndex(index - 1)}
              className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              ← {t.signup.back}
            </button>
            <Link
              href={home}
              onClick={rememberAllChannels}
              className="btn-sky is-solid pill px-6 py-2.5 text-[13px]"
            >
              {t.signup.finish}
            </Link>
          </div>
        </div>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <>
      <div className="flex items-center justify-end gap-2">
        <LanguageSelector />
        <SignOutButton />
      </div>
      <div className="glass-card sheet-enter rounded-[22px] border border-[var(--color-border)] p-6 sm:p-8">
        <div
          className="font-display text-xl font-semibold tracking-[-0.02em] text-[var(--color-primary)]"
          style={{ textShadow: "0 0 28px var(--glow-primary)" }}
        >
          {t.brand.name}
        </div>
        <h1 className="mt-6 text-[26px] font-semibold leading-tight tracking-[-0.02em]">{t.signup.welcomeTitle}</h1>
        <p className="mt-2 text-[14px] font-light text-[var(--color-muted)]">{t.signup.welcomeSub}</p>
        <div className="mt-6">{children}</div>
      </div>
    </>
  );
}

function CreditsNote({ amount }: { amount: number }) {
  const { t } = useI18n();
  return (
    <p
      role="status"
      className="rounded-xl border border-[var(--color-primary)] px-4 py-3 text-[13px] text-[var(--color-fg)]"
      style={{ boxShadow: "0 0 24px var(--glow-primary)" }}
    >
      {fmt(t.signup.welcomeCredits, { n: amount })}
    </p>
  );
}

function Item({
  n,
  title,
  body,
  href,
  done = false,
  children,
}: {
  n: number;
  title: string;
  body: string;
  href?: string;
  done?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <li className="panel flex items-start gap-4 p-4">
      <span
        className="mono mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px]"
        style={{
          borderColor: done ? "var(--color-ok)" : "var(--color-border)",
          color: done ? "var(--color-ok)" : "var(--color-muted)",
        }}
        aria-hidden
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold">{title}</h3>
          {done ? (
            <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-ok)]">{t.signup.done}</span>
          ) : href ? (
            <Link href={href} className="btn-sky is-quiet pill px-4 py-1.5 text-[12px]">
              {t.signup.open} →
            </Link>
          ) : null}
        </div>
        <p className="mt-1 text-[13px] text-[var(--color-muted)]">{body}</p>
        {children}
      </div>
    </li>
  );
}
