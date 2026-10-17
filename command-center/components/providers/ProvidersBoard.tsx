"use client";

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { setupFailureText } from "@/lib/setup-errors";
import { useI18n } from "@/lib/i18n/context";
import { useToast } from "@/components/feedback/ToastProvider";
import { StatusLamp } from "@/components/ui/StatusLamp";
import {
  PROVIDER_CATEGORIES,
  type ProviderCategory,
  type ProviderDef,
} from "@/lib/providers";

/**
 * The Providers board: one card per external provider, grouped by capability.
 *
 * Each card mirrors the provider's own API-key page — a link to its console and
 * a single field to paste the key — and reports whether a key is already set.
 * Saving POSTs to /api/setup/secrets, which seals the value into a GitHub
 * Actions secret and returns only whether it was created or updated: the value
 * never comes back, is never stored here, and is dropped from the browser the
 * moment GitHub accepts it. Providers marked "live" are used by the pipeline
 * today; the rest are opt-in adapters that stay off until a key is set.
 */
export function ProvidersBoard({
  groups,
  configured,
  githubConfigured,
}: {
  groups: { category: ProviderCategory; items: ProviderDef[] }[];
  configured: string[];
  githubConfigured: boolean;
}) {
  const { t } = useI18n();
  const [set, setSet] = useState<Set<string>>(() => new Set(configured));

  const catLabel = useMemo<Record<ProviderCategory, string>>(
    () => ({
      llm: t.providers.catLlm,
      research: t.providers.catResearch,
      voice: t.providers.catVoice,
      video: t.providers.catVideo,
      image: t.providers.catImage,
    }),
    [t],
  );

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const configuredCount = groups.reduce(
    (n, g) => n + g.items.filter((p) => set.has(p.secretName)).length,
    0,
  );

  function markSet(secretName: string) {
    setSet((prev) => {
      const next = new Set(prev);
      next.add(secretName);
      return next;
    });
  }

  return (
    <div className="g2-stack-lg">
      <p className="g2-note tnum">
        {configuredCount} / {total} · {t.providers.storedNote}
      </p>

      {!githubConfigured && (
        <p className="g2-warn border-l-2 border-[var(--color-warn)] pl-3" role="status">
          {t.providers.githubNotConfigured}
        </p>
      )}

      {PROVIDER_CATEGORIES.map((category) => {
        const group = groups.find((g) => g.category === category);
        if (!group) return null;
        return (
          <section key={category} className="g2-channel" aria-labelledby={`providers-${category}`}>
            <h2 id={`providers-${category}`} className="g2-h2">{catLabel[category]}</h2>
            <ul className="g2-keys">
              {group.items.map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  configured={set.has(p.secretName)}
                  canSave={githubConfigured}
                  onSaved={() => markSet(p.secretName)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";

function ProviderCard({
  provider,
  configured,
  canSave,
  onSaved,
}: {
  provider: ProviderDef;
  configured: boolean;
  canSave: boolean;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [errorKey, setErrorKey] = useState<"unauthorized" | "failed" | null>(null);
  const toast = useToast();

  async function save() {
    const key = value.trim();
    if (!key || state === "saving") return;
    setState("saving");
    setErrorKey(null);
    try {
      const res = await fetch("/api/setup/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { [provider.secretName]: key } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const unauthorized = data.error === "github_unauthorized";
        setState("error");
        setErrorKey(unauthorized ? "unauthorized" : "failed");
        toast.error(unauthorized ? t.providers.unauthorized : setupFailureText(t, data, t.providers.saveFailed), {
          title: provider.name,
        });
        return;
      }
      // Accepted by GitHub — drop the value from the browser at once.
      setValue("");
      setState("saved");
      toast.success(t.providers.saved, { title: provider.name });
      onSaved();
    } catch {
      setState("error");
      setErrorKey("failed");
      toast.error(t.providers.saveFailed, { title: provider.name });
    }
  }

  return (
    <li className="g2-key">
      <div className="g2-key-id">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h3 className="g2-strong">{provider.name}</h3>
          <StatusLamp
            tone={configured ? "ok" : "idle"}
            label={configured ? t.providers.statusSet : t.providers.statusUnset}
            live={false}
          />
        </div>
        <p className="g2-note tnum mt-1">
          {provider.live ? t.providers.statusLive : t.providers.statusOptIn}
          <span aria-live="polite" className="ml-2">
            {state === "saved"
              ? t.providers.saved
              : state === "error"
                ? errorKey === "unauthorized"
                  ? t.providers.unauthorized
                  : t.providers.saveFailed
                : <span className="mono">{provider.secretName}</span>}
          </span>
        </p>
        {/* One link straight to this provider's own API-key page. */}
        <a
          href={provider.consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${provider.name}: ${t.providers.consoleLink}`}
          className="tap-link g2-link text-sm"
        >
          {provider.name} <span aria-hidden>↗</span>
        </a>
      </div>

      <div className="g2-key-field">
        <div className="relative min-w-0 flex-1">
          {/* A key is on file: a green check stands in for the hidden value, so
              the field reads as "set" rather than "empty, paste here". */}
          {configured && !value && (
            <Check
              aria-hidden
              strokeWidth={2.5}
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
              style={{ color: "var(--color-ok)" }}
            />
          )}
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={!canSave || state === "saving"}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (state !== "idle") setState("idle");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            placeholder={configured ? t.providers.keySaved : t.providers.keyPlaceholder}
            aria-label={`${provider.name} API key`}
            className={`ns-field w-full ${configured && !value ? "!pl-9" : ""}`}
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={!canSave || !value.trim() || state === "saving"}
          className="btn-quiet shrink-0 disabled:opacity-40"
        >
          {state === "saving" ? t.providers.saving : configured ? t.providers.replace : t.providers.save}
        </button>
      </div>
    </li>
  );
}
