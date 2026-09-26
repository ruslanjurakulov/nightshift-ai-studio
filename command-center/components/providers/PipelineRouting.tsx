"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { PROVIDERS } from "@/lib/providers";
import { IMAGE_GENERATORS, imageGeneratorById } from "@/lib/imageProviders";

/**
 * Pipeline routing — choose which generator the pipeline actually uses.
 *
 * Entering a provider key (above) does not by itself switch the pipeline: the
 * bot reads which video/image generator to use from GitHub Actions *variables*
 * (config.py → CHRONOS_VIDEO_PROVIDER / CHRONOS_IMAGE_PROVIDER and their enable
 * flags), which the daily workflow forwards into the run. This panel writes
 * those variables through /api/setup/variables, so picking "Higgsfield" here is
 * what makes the next run render with Higgsfield.
 *
 * The enable wiring is provider-specific and mirrors config.py exactly:
 *   • a generic video provider needs CHRONOS_VIDEO_PROVIDER=<id> AND
 *     CHRONOS_ENABLE_VIDEO_GEN=1 (plus its key);
 *   • MiniMax is gated by its own CHRONOS_ENABLE_MINIMAX_BROLL flag instead;
 *   • "Stock only" turns both video flags off, so the pipeline uses Pexels;
 *   • image generation needs CHRONOS_IMAGE_PROVIDER=<id> AND
 *     CHRONOS_ENABLE_IMAGE_GEN=1.
 * Selecting an option writes the whole consistent set at once, so the flags can
 * never disagree with the chosen provider.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const truthy = (v: string | undefined) => !!v && TRUTHY.has(v.trim().toLowerCase());

const VIDEO_PROVIDERS = PROVIDERS.filter((p) => p.category === "video");
// Pexels is the stock fallback ("off"), not a generator option. Two generators
// reuse an LLM key (OpenAI, Gemini), so they come from their own list.
const IMAGE_PROVIDERS = IMAGE_GENERATORS;

function secretFor(id: string): string | undefined {
  return PROVIDERS.find((p) => p.id === id)?.secretName;
}

type Vars = Record<string, string>;
type SaveState = "idle" | "saving" | "saved" | "error";

export function PipelineRouting({
  initial,
  configured,
  githubConfigured,
}: {
  /** Current values of the routing variables, name→value (absent = default). */
  initial: Vars;
  /** Secret names GitHub reports as set — used to warn when a key is missing. */
  configured: string[];
  githubConfigured: boolean;
}) {
  const { t } = useI18n();
  const configuredSet = useMemo(() => new Set(configured), [configured]);

  // Derive the current selection from the raw variables, mirroring config.py.
  const initialVideo = (() => {
    const vp = (initial.CHRONOS_VIDEO_PROVIDER || "minimax").toLowerCase();
    if (truthy(initial.CHRONOS_ENABLE_VIDEO_GEN) && vp !== "minimax") return vp;
    if (truthy(initial.CHRONOS_ENABLE_MINIMAX_BROLL)) return "minimax";
    return "off";
  })();
  const initialImage = truthy(initial.CHRONOS_ENABLE_IMAGE_GEN)
    ? (initial.CHRONOS_IMAGE_PROVIDER || "leonardo").toLowerCase()
    : "off";

  const [video, setVideo] = useState(initialVideo);
  const [image, setImage] = useState(initialImage);
  const [autopilot, setAutopilot] = useState(truthy(initial.CHRONOS_AGENT_AUTOPILOT));
  const [state, setState] = useState<SaveState>("idle");
  const [errorKey, setErrorKey] = useState<"unauthorized" | "failed">("failed");

  async function save(variables: Vars) {
    if (!githubConfigured) return;
    setState("saving");
    setErrorKey("failed");
    try {
      const res = await fetch("/api/setup/variables", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variables }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorKey(data.error === "github_unauthorized" ? "unauthorized" : "failed");
        setState("error");
        return false;
      }
      setState("saved");
      return true;
    } catch {
      setState("error");
      return false;
    }
  }

  async function chooseVideo(id: string) {
    setVideo(id);
    if (id === "off") {
      await save({ CHRONOS_ENABLE_VIDEO_GEN: "0", CHRONOS_ENABLE_MINIMAX_BROLL: "0" });
    } else if (id === "minimax") {
      await save({
        CHRONOS_VIDEO_PROVIDER: "minimax",
        CHRONOS_ENABLE_MINIMAX_BROLL: "1",
        CHRONOS_ENABLE_VIDEO_GEN: "0",
      });
    } else {
      await save({
        CHRONOS_VIDEO_PROVIDER: id,
        CHRONOS_ENABLE_VIDEO_GEN: "1",
        CHRONOS_ENABLE_MINIMAX_BROLL: "0",
      });
    }
  }

  async function chooseImage(id: string) {
    setImage(id);
    if (id === "off") {
      await save({ CHRONOS_ENABLE_IMAGE_GEN: "0" });
    } else {
      await save({ CHRONOS_IMAGE_PROVIDER: id, CHRONOS_ENABLE_IMAGE_GEN: "1" });
    }
  }

  async function toggleAutopilot() {
    const next = !autopilot;
    setAutopilot(next);
    await save({ CHRONOS_AGENT_AUTOPILOT: next ? "1" : "0" });
  }

  // Warn when the selected generator has no key set — it would silently fall
  // back to stock. Only meaningful for a real generator, not "Stock only".
  const videoKeyMissing = video !== "off" && (() => {
    const s = secretFor(video);
    return s ? !configuredSet.has(s) : false;
  })();
  const imageKeyMissing = image !== "off" && (() => {
    const s = imageGeneratorById(image)?.secretName;
    return s ? !configuredSet.has(s) : false;
  })();

  const selectCls =
    "rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] disabled:opacity-50";

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t.providers.routingTitle}</h2>
        <p className="mt-1 max-w-[80ch] text-[13px] leading-relaxed text-[var(--color-muted)]">
          {t.providers.routingHint}
        </p>
      </div>

      {!githubConfigured && (
        <p className="text-[13px] text-[var(--color-warn)]">{t.providers.routingNotConfigured}</p>
      )}

      {/* Video generator */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="route-video" className="text-[12px] font-medium text-[var(--color-fg)]">
            {t.providers.routingVideo}
          </label>
          <select
            id="route-video"
            value={video}
            disabled={!githubConfigured || state === "saving"}
            onChange={(e) => chooseVideo(e.target.value)}
            className={selectCls}
          >
            <option value="off">{t.providers.routingStock}</option>
            {VIDEO_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {videoKeyMissing && (
          <p className="text-[11px] text-[var(--color-warn)]">{t.providers.routingKeyNeeded}</p>
        )}
      </div>

      {/* Image generator */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="route-image" className="text-[12px] font-medium text-[var(--color-fg)]">
            {t.providers.routingImage}
          </label>
          <select
            id="route-image"
            value={image}
            disabled={!githubConfigured || state === "saving"}
            onChange={(e) => chooseImage(e.target.value)}
            className={selectCls}
          >
            <option value="off">{t.providers.routingStock}</option>
            {IMAGE_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {imageKeyMissing && (
          <p className="text-[11px] text-[var(--color-warn)]">{t.providers.routingKeyNeeded}</p>
        )}
      </div>

      {/* Autopilot */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-3">
        <span className="text-[12px] font-medium text-[var(--color-fg)]">
          {t.providers.routingAutopilot}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={autopilot}
          disabled={!githubConfigured || state === "saving"}
          onClick={toggleAutopilot}
          className="btn-sky pill shrink-0 px-4 py-2 text-[12px] disabled:opacity-50"
          style={{
            borderColor: autopilot ? "var(--color-ok)" : "var(--color-border)",
            color: autopilot ? "var(--color-ok)" : "var(--color-muted)",
          }}
        >
          {autopilot ? t.providers.routingOn : t.providers.routingOff}
        </button>
      </div>

      <p className="mono text-[11px]" aria-live="polite">
        {state === "saving" ? (
          <span className="text-[var(--color-muted)]">{t.providers.routingSaving}</span>
        ) : state === "saved" ? (
          <span className="text-[var(--color-ok)]">{t.providers.routingSaved}</span>
        ) : state === "error" ? (
          <span className="text-[var(--color-fail)]">
            {errorKey === "unauthorized" ? t.providers.routingUnauthorized : t.providers.routingFailed}
          </span>
        ) : null}
      </p>
    </div>
  );
}
