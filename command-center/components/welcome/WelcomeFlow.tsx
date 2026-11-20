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
import { deskHref } from "@/lib/creative/desks";
import { Wordmark } from "@/components/site/Wordmark";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Button, buttonClass } from "@/components/ds/Button";
import { newChannelHref } from "@/lib/welcome";
import { AudioLines, Clapperboard, Image as ImageIcon } from "lucide-react";
import { createHref } from "@/lib/customer/create";

type Step = "workspace" | "create" | "next";

/**
 * The flow is always the same three steps, so a reload never changes the count under the person ("Step 2 of 3" stays
 * "of 3"): a workspace that already exists is a step done, not a step gone. Where they are is in the address (?step=),
 * written with replaceState, so a reload returns to the same step instead of the first.
 */
const STEPS: readonly Step[] = ["workspace", "create", "next"];

export function startIndex(needsWorkspace: boolean, asked: string | null): number {
  if (needsWorkspace) return 0;
  return asked === "next" ? 2 : 1;
}

/** The Studio-first start: a priced result needs no channel, so the first choice is what to make. */
const MAKE = [
  { kind: "image", icon: ImageIcon },
  { kind: "video", icon: Clapperboard },
  { kind: "audio", icon: AudioLines },
] as const;

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
  next = null,
  initialStep = null,
}: {
  needsWorkspace: boolean;
  unavailable: boolean;
  hasChannel: boolean;
  canConnectYouTube: boolean;
  showCredits: boolean;
  welcomeCredits: number | null;
  contactEmail: string | null;
  /** A Studio form to open at the end (app/welcome/page.tsx, already checked by lib/safe-redirect.ts studioNext), or null. */
  next?: string | null;
  /** `?step=` from the address (only "next" means anything), so a reload lands on the step the person was on. */
  initialStep?: string | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const steps = STEPS;
  const [index, setIndexState] = useState(() => startIndex(needsWorkspace, initialStep));
  const step = steps[index];
  const setIndex = (i: number) => {
    setIndexState(i);
    try {
      const url = new URL(window.location.href);
      if (STEPS[i] === "next") url.searchParams.set("step", "next");
      else url.searchParams.delete("step");
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      // The address is a convenience: without it a reload returns to the create step.
    }
  };

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Home, named outright: the bare segment's redirect chooses the console for an operator (app/(app)/[channel]/page.tsx).
  const home = channelPath(ALL_CHANNELS_SLUG, "/home");
  const at = (section: string) => channelPath(ALL_CHANNELS_SLUG, section);
  const firstChannelStep = hasChannel ? 1 : 2;

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

  const stepName: Record<Step, string> = { workspace: t.signup.wsTitle, create: t.customerApp.welcome.title, next: t.signup.nextTitle };

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
            <Button type="submit" variant="primary" loading={busy} busyLabel={t.signup.wsCreating} disabled={validateOrgName(name) === null}>
              {t.signup.wsCreate}
            </Button>
          </div>
        </form>
      )}

      {step === "create" && (
        <div className="mt-3 flex flex-col gap-5">
          {welcomeCredits !== null && <CreditsNote amount={welcomeCredits} />}
          <div>
            <h2 className="g5-h">{t.customerApp.welcome.title}</h2>
            <p className="g5-sub">{t.customerApp.welcome.hint}</p>
          </div>
          <ul className="g5-rows" data-testid="welcome-make">
            {MAKE.map(({ kind, icon: Icon }) => (
              <li key={kind} className="g5-row g5-next-step">
                <span className="g5-num" aria-hidden>
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0">
                  <h3 className="g5-row-title">{t.customerApp.kinds[kind]}</h3>
                  <p className="g5-row-meta">{t.customerApp.welcome[kind]}</p>
                </div>
                {/* A full load: the app's layout reads the workspace just made (its cookie) on the server. It opens a form only. */}
                <a href={at(createHref(kind))} onClick={rememberAllChannels} className={buttonClass({ variant: "secondary", size: "sm" })}>
                  {t.signup.open} →
                </a>
              </li>
            ))}
          </ul>
          <div className="g5-actions" style={{ justifyContent: "flex-end" }}>
            <button type="button" onClick={() => setIndex(index + 1)} className={buttonClass({ variant: "quiet" })}>
              {t.signup.skip}
            </button>
          </div>
        </div>
      )}

      {step === "next" && (
        <div className="mt-3 flex flex-col gap-5">
          {welcomeCredits !== null && <CreditsNote amount={welcomeCredits} />}
          <div>
            <h2 className="g5-h">{t.signup.nextTitle}</h2>
            <p className="g5-sub">{t.signup.nextHint}</p>
          </div>
          <ol className="g5-rows">
            {/* Someone with no channel yet can still reach a first priced result: the image, clip and voice desks need no channel (a full YouTube video does). */}
            {!hasChannel && <Item n={1} title={t.signup.stepMedia} body={t.signup.stepMediaBody} href={at(deskHref("image"))} />}
            <Item
              n={firstChannelStep}
              title={t.signup.stepChannel}
              body={t.signup.stepChannelBody}
              done={hasChannel}
              href={hasChannel ? at("/channels") : newChannelHref(ALL_CHANNELS_SLUG, {})}
            />
            <Item
              n={firstChannelStep + 1}
              title={t.signup.stepYoutube}
              body={canConnectYouTube ? t.signup.stepYoutubeBody : t.signup.stepYoutubeRestricted}
              href={canConnectYouTube ? at("/channels") : undefined}
            >
              {!canConnectYouTube &&
                (contactEmail ? (
                  <a
                    href={`mailto:${contactEmail}?subject=${encodeURIComponent(t.signup.requestSubject)}`}
                    className={buttonClass({ variant: "secondary", size: "sm", className: "mt-3" })}
                  >
                    {t.signup.requestConnection}
                  </a>
                ) : (
                  <p className="g5-note mt-2">{t.signup.requestContact}</p>
                ))}
            </Item>
            <Item n={firstChannelStep + 2} title={t.signup.stepStyle} body={t.signup.stepStyleBody} href={at("/studio/look")} />
            {showCredits && <Item n={firstChannelStep + 3} title={t.signup.stepCredits} body={t.signup.stepCreditsBody} href={at("/credits")} />}
            <Item n={firstChannelStep + (showCredits ? 4 : 3)} title={t.signup.stepCreate} body={hasChannel ? t.signup.stepCreateBody : `${t.signup.stepCreateBody} ${t.signup.stepCreateNeedsChannel}`} href={at("/create")} />
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" onClick={() => setIndex(index - 1)} className="g5-link" style={{ background: "none", border: 0, cursor: "pointer" }}>
              ← {t.signup.back}
            </button>
            {/* A full load, not a client navigation: the (app) layout must read the new workspace's cookie on the server, and
                a client transition could replay an answer cached before the workspace existed. */}
            <a href={next ?? home} onClick={rememberAllChannels} className={buttonClass({ variant: "primary" })}>
              {next ? t.signup.finishStudio : t.signup.finish}
            </a>
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
        <div className="inline-flex items-center text-[var(--color-fg)] [--wm-h:30px] max-[359px]:[--wm-h:22px]">
          <Wordmark />
          <span className="sr-only">{t.brand.name}</span>
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
        <Link href={href} className={buttonClass({ variant: "secondary", size: "sm" })}>
          {t.signup.open} →
        </Link>
      ) : (
        <span aria-hidden />
      )}
    </li>
  );
}
