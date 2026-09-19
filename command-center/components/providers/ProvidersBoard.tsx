"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { StatusPill } from "@/components/ui";
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
    <div className="rhythm stagger-enter">
      <div>
        <h1 className="t-hero">{t.providers.title}</h1>
        <p className="t-lead mt-4">{t.providers.subtitle}</p>
        <p className="mt-2 mono text-[12px] text-[var(--color-muted)]">
          {configuredCount} / {total} · {t.providers.storedNote}
        </p>
      </div>

      {!githubConfigured && (
        <div className="panel border-[var(--color-warn,#e2a03f)] p-4" role="status">
          <p className="text-sm text-[var(--color-fg)]">{t.providers.githubNotConfigured}</p>
        </div>
      )}

      {PROVIDER_CATEGORIES.map((category) => {
        const group = groups.find((g) => g.category === category);
        if (!group) return null;
        return (
          <section key={category} className="space-y-3">
            <h2 className="t-section">{catLabel[category]}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  configured={set.has(p.secretName)}
                  canSave={githubConfigured}
                  onSaved={() => markSet(p.secretName)}
                />
              ))}
            </div>
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
        setState("error");
        setErrorKey(data.error === "github_unauthorized" ? "unauthorized" : "failed");
        return;
      }
      // Accepted by GitHub — drop the value from the browser at once.
      setValue("");
      setState("saved");
      onSaved();
    } catch {
      setState("error");
      setErrorKey("failed");
    }
  }

  return (
    <div className="panel flex flex-col gap-2.5 p-4 transition-transform duration-200 hover:-translate-y-0.5 hover:border-[var(--color-primary-dim)]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-[var(--color-fg)]">{provider.name}</span>
        <StatusPill
          tone={configured ? "ok" : "idle"}
          label={configured ? t.providers.statusSet : t.providers.statusUnset}
          live={configured}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="pill border border-[var(--color-border)] px-2 py-0.5 mono text-[10px] text-[var(--color-muted)]">
          {provider.live ? t.providers.statusLive : t.providers.statusOptIn}
        </span>
      </div>

      {/* One button straight to this provider's own API-key page. */}
      <a
        href={provider.consoleUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${provider.name}: ${t.providers.consoleLink}`}
        className="btn-sky pill flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[12px]"
      >
        {provider.name} <span aria-hidden>↗</span>
      </a>

      <div className="flex gap-2">
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
          placeholder={configured ? t.providers.updateHint : t.providers.keyPlaceholder}
          aria-label={`${provider.name} API key`}
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 mono text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
        />
        <button
          type="button"
          onClick={save}
          disabled={!canSave || !value.trim() || state === "saving"}
          className="btn-sky pill px-3 py-1.5 text-[12px] disabled:opacity-40"
        >
          {state === "saving" ? t.providers.saving : t.providers.save}
        </button>
      </div>

      <p className="mono text-[11px] text-[var(--color-muted)]" aria-live="polite">
        {state === "saved"
          ? t.providers.saved
          : state === "error"
            ? errorKey === "unauthorized"
              ? t.providers.unauthorized
              : t.providers.saveFailed
            : provider.secretName}
      </p>
    </div>
  );
}
