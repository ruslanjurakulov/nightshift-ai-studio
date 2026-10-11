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
import { BrandMark } from "@/components/site/BrandMark";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { newChannelHref, WELCOME_NICHE_MAX, WELCOME_LANGUAGE_MAX } from "@/lib/welcome";

type Step = "workspace" | "about" | "next";

// Suggestions only: the channel's language is free text the pipeline reads as
// written, and English names are what existing channels use.
const LANGUAGE_SUGGESTIONS = ["English", "Russian", "Uzbek", "Spanish", "German", "French", "Portuguese", "Turkish", "Arabic", "Hindi"];

const inputClass = "ns-field min-w-0";

function rememberAllChannels() {
  // The org switch already happened server-side (/api/org/create sets the org
  // cookie); this is the channel memory a new workspace starts with.
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

  // The bare segment lands on the first channel (app/(app)/[channel]/page.tsx).
  const home = `/${ALL_CHANNELS_SLUG}`;
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
      <Frame steps={[]} index={0}>
        <p role="alert" className="g5-state-body" style={{ color: "var(--color-warn)" }}>
          {t.signup.unavailable}
        </p>
      </Frame>
    );
  }

  const stepName: Record<Step, string> = { workspace: t.signup.wsTitle, about: t.signup.aboutTitle, next: t.signup.nextTitle };

  return (
    <Frame steps={steps.map((k) => stepName[k])} index={index}>
      <p className="g5-k">{fmt(t.signup.stepOf, { n: index + 1, total: steps.length })}</p>

      {step === "workspace" && (
        <form onSubmit={createWorkspace} className="mt-3 flex flex-col gap-5">
          <div>
            <h2 className="g5-h">{t.signup.wsTitle}</h2>
            <p className="g5-sub">{t.signup.wsHint}</p>
          </div>
          <label className="g5-field">
            <span className="g5-k">{t.signup.wsLabel}</span>
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
            <p role="alert" className="g5-note g5-fail-text">
              {error}
            </p>
          )}
          <div className="g5-actions" style={{ justifyContent: "flex-end" }}>
            <button type="submit" disabled={busy || validateOrgName(name) === null} className="btn-primary disabled:opacity-40">
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
          className="mt-3 flex flex-col gap-5"
        >
          {welcomeCredits !== null && <CreditsNote amount={welcomeCredits} />}
          <div>
            <h2 className="g5-h">{t.signup.aboutTitle}</h2>
            <p className="g5-sub">{t.signup.aboutHint}</p>
          </div>
          <label className="g5-field">
            <span className="g5-k">{t.signup.nicheLabel}</span>
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
          <label className="g5-field">
            <span className="g5-k">{t.signup.languageLabel}</span>
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
          <div className="g5-actions" style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => {
                setNiche("");
                setLanguage("");
                setIndex(index + 1);
              }}
              className="btn-quiet"
            >
              {t.signup.skip}
            </button>
            <button type="submit" className="btn-primary">
              {t.signup.continue}
            </button>
          </div>
        </form>
      )}

      {step === "next" && (
        <div className="mt-3 flex flex-col gap-5">
          {welcomeCredits !== null && <CreditsNote amount={welcomeCredits} />}
          <div>
            <h2 className="g5-h">{t.signup.nextTitle}</h2>
            <p className="g5-sub">{t.signup.nextHint}</p>
          </div>
          <ol className="g5-rows">
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
                    className="btn-quiet mt-3 inline-flex"
                  >
                    {t.signup.requestConnection}
                  </a>
                ) : (
                  <p className="g5-note mt-2">{t.signup.requestContact}</p>
                ))}
            </Item>
            <Item n={3} title={t.signup.stepStyle} body={t.signup.stepStyleBody} href={at("/studio")} />
            {showCredits && <Item n={4} title={t.signup.stepCredits} body={t.signup.stepCreditsBody} href={at("/credits")} />}
            <Item n={showCredits ? 5 : 4} title={t.signup.stepCreate} body={t.signup.stepCreateBody} href={at("/create")} />
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" onClick={() => setIndex(index - 1)} className="g5-link" style={{ background: "none", border: 0, cursor: "pointer" }}>
              ← {t.signup.back}
            </button>
            <Link href={home} onClick={rememberAllChannels} className="btn-primary">
              {t.signup.finish}
            </Link>
          </div>
        </div>
      )}
    </Frame>
  );
}

/**
 * The first-run frame: the page's room (grid and warm glow, like the app), the wordmark and language/sign-out above, and
 * two columns from tablet up. On the left the welcome and the steps as a rail; on the right the one lit desk holding the
 * step in hand. On a phone the rail gives way to the "Step n of m" line inside the desk.
 */
function Frame({ steps, index, children }: { steps: string[]; index: number; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="g5-welcome-in">
      <div className="g5-welcome-bar">
        <div className="ns-wordmark inline-flex items-center gap-2">
          <BrandMark size={32} />
          {t.brand.name}
        </div>
        <div className="flex items-center gap-2">
          <LanguageSelector />
          <SignOutButton />
        </div>
      </div>
      <div className="g5-welcome-grid">
        <div className="g5-welcome-lead">
          <h1 className="g5-welcome-title">{t.signup.welcomeTitle}</h1>
          <p className="t-lead">{t.signup.welcomeSub}</p>
          {steps.length > 0 && (
            <ol className="g5-rail" aria-label={t.signup.welcomeTitle}>
              {steps.map((label, i) => (
                <li key={label} aria-current={i === index ? "step" : undefined} data-done={i < index ? "true" : undefined}>
                  <span className="g5-num" aria-hidden>
                    {i < index ? "✓" : String(i + 1).padStart(2, "0")}
                  </span>
                  <span>{label}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <section className="ns-desk g5-welcome-desk sheet-enter">{children}</section>
      </div>
    </div>
  );
}

function CreditsNote({ amount }: { amount: number }) {
  const { t } = useI18n();
  return (
    <p role="status" className="g5-credit-note">
      <span aria-hidden className="ns-lamp" data-tone="run" data-size="md" />
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
    <li className="g5-row g5-next-step">
      <span className="g5-num" aria-hidden style={done ? { color: "var(--color-ok)" } : undefined}>
        {done ? "✓" : String(n).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <h3 className="g5-row-title">{title}</h3>
        <p className="g5-row-meta">{body}</p>
        {children}
      </div>
      {done ? (
        <StatusLamp tone="ok" label={t.signup.done} />
      ) : href ? (
        <Link href={href} className="btn-quiet">
          {t.signup.open} →
        </Link>
      ) : (
        <span aria-hidden />
      )}
    </li>
  );
}
