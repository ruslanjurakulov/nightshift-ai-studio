"use client";

import { useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useToast } from "@/components/feedback/ToastProvider";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
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
 *
 * The screen follows the saved state, not the tap: a choice is shown as chosen
 * only after the write landed, so a failed save leaves the old generator on
 * screen (it is the one the pipeline will still use). Switching a generator and
 * turning autopilot on ask first; turning it off does not.
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
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const lock = useRef(false);

  /**
   * Writes the variables. Returns null on success, or the message to show when
   * it did not go through. The caller changes what the screen shows only after
   * a null: a failed save leaves the old choice on screen, because that is what
   * the pipeline will still use.
   */
  async function save(variables: Vars): Promise<string | null> {
    if (!githubConfigured) return t.providers.routingNotConfigured;
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
        const unauthorized = data.error === "github_unauthorized";
        setErrorKey(unauthorized ? "unauthorized" : "failed");
        setState("error");
        return unauthorized ? t.providers.routingUnauthorized : t.providers.routingFailed;
      }
      setState("saved");
      return null;
    } catch {
      setState("error");
      return t.providers.routingFailed;
    }
  }

  const videoVars = (id: string): Vars =>
    id === "off"
      ? { CHRONOS_ENABLE_VIDEO_GEN: "0", CHRONOS_ENABLE_MINIMAX_BROLL: "0" }
      : id === "minimax"
        ? { CHRONOS_VIDEO_PROVIDER: "minimax", CHRONOS_ENABLE_MINIMAX_BROLL: "1", CHRONOS_ENABLE_VIDEO_GEN: "0" }
        : { CHRONOS_VIDEO_PROVIDER: id, CHRONOS_ENABLE_VIDEO_GEN: "1", CHRONOS_ENABLE_MINIMAX_BROLL: "0" };
  const imageVars = (id: string): Vars =>
    id === "off" ? { CHRONOS_ENABLE_IMAGE_GEN: "0" } : { CHRONOS_IMAGE_PROVIDER: id, CHRONOS_ENABLE_IMAGE_GEN: "1" };

  const videoName = (id: string) => (id === "off" ? t.providers.routingStock : (VIDEO_PROVIDERS.find((p) => p.id === id)?.name ?? id));
  const imageName = (id: string) => (id === "off" ? t.providers.routingStock : (imageGeneratorById(id)?.name ?? id));

  /** One change at a time; the lock is set before the first await, so a second tap is ignored. */
  async function change(kind: "video" | "image", id: string) {
    if (lock.current || !githubConfigured) return;
    const current = kind === "video" ? video : image;
    if (id === current) return;
    const name = kind === "video" ? videoName(id) : imageName(id);
    const secret = id === "off" ? undefined : kind === "video" ? secretFor(id) : imageGeneratorById(id)?.secretName;
    const noKey = secret ? !configuredSet.has(secret) : false;
    lock.current = true;
    const ok = await confirm({
      title: fmt(kind === "video" ? t.ownerSafety.routeSwitchTitleVideo : t.ownerSafety.routeSwitchTitleImage, { name }),
      message: noKey ? `${t.ownerSafety.routeSwitchBody} ${t.ownerSafety.routeSwitchKeyMissing}` : t.ownerSafety.routeSwitchBody,
      confirmLabel: t.ownerSafety.routeSwitchConfirm,
      tone: "primary",
      details: [
        { label: t.ownerSafety.dNow, value: kind === "video" ? videoName(current) : imageName(current) },
        { label: t.ownerSafety.dNew, value: name },
      ],
      successMessage: t.providers.routingSaved,
      run: async () => (await save(kind === "video" ? videoVars(id) : imageVars(id))) ?? true,
    });
    lock.current = false;
    if (!ok) return;
    if (kind === "video") setVideo(id);
    else setImage(id);
  }

  async function toggleAutopilot() {
    if (lock.current || !githubConfigured) return;
    lock.current = true;
    if (!autopilot) {
      // Turning it on hands the daily topic to the machine: ask first.
      const ok = await confirm({
        title: t.ownerSafety.routeAutopilotTitle,
        message: t.ownerSafety.routeAutopilotBody,
        confirmLabel: t.ownerSafety.routeAutopilotConfirm,
        tone: "primary",
        successMessage: t.providers.routingSaved,
        run: async () => (await save({ CHRONOS_AGENT_AUTOPILOT: "1" })) ?? true,
      });
      lock.current = false;
      if (ok) setAutopilot(true);
      return;
    }
    // Turning it off is the safe direction: no sheet, but the switch moves only once the save landed.
    const problem = await save({ CHRONOS_AGENT_AUTOPILOT: "0" });
    lock.current = false;
    if (problem) {
      toast.error(`${problem} ${t.ownerSafety.routeNotSaved}`, { title: t.providers.routingTitle });
      return;
    }
    setAutopilot(false);
    toast.success(t.providers.routingSaved, { title: t.providers.routingTitle });
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

  const selectCls = "ns-field min-w-[14rem] disabled:opacity-50";

  return (
    <section className="g2-channel" aria-labelledby="routing-title">
      {dialog}
      <div>
        <h2 id="routing-title" className="g2-h2">{t.providers.routingTitle}</h2>
        <p className="g2-sub max-w-[80ch]">{t.providers.routingHint}</p>
      </div>

      {!githubConfigured && <p className="g2-warn">{t.providers.routingNotConfigured}</p>}

      <div className="flex flex-col">
        {/* Video generator */}
        <div className="g2-switchrow">
          <div className="min-w-0" style={{ flexBasis: "16rem", flexGrow: 1 }}>
            <label htmlFor="route-video" className="g2-strong">
              {t.providers.routingVideo}
            </label>
            {videoKeyMissing && <p className="g2-warn mt-1">{t.providers.routingKeyNeeded}</p>}
          </div>
          <select
            id="route-video"
            value={video}
            disabled={!githubConfigured || state === "saving"}
            onChange={(e) => change("video", e.target.value)}
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

        {/* Image generator */}
        <div className="g2-switchrow">
          <div className="min-w-0" style={{ flexBasis: "16rem", flexGrow: 1 }}>
            <label htmlFor="route-image" className="g2-strong">
              {t.providers.routingImage}
            </label>
            {imageKeyMissing && <p className="g2-warn mt-1">{t.providers.routingKeyNeeded}</p>}
          </div>
          <select
            id="route-image"
            value={image}
            disabled={!githubConfigured || state === "saving"}
            onChange={(e) => change("image", e.target.value)}
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

        {/* Autopilot */}
        <div className="g2-switchrow">
          <span id="route-autopilot" className="g2-strong">
            {t.providers.routingAutopilot}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={autopilot}
            aria-labelledby="route-autopilot"
            aria-describedby="route-autopilot-word"
            disabled={!githubConfigured || state === "saving"}
            onClick={toggleAutopilot}
            className="g2-switch"
          >
            <span aria-hidden className="g2-switch-track">
              <span className="g2-switch-thumb" />
            </span>
            <span id="route-autopilot-word" className="g2-switch-word">{autopilot ? t.providers.routingOn : t.providers.routingOff}</span>
          </button>
        </div>
      </div>

      <p className="tnum text-sm" aria-live="polite">
        {state === "saving" ? (
          <span className="text-[var(--color-muted)]">{t.providers.routingSaving}</span>
        ) : state === "saved" ? (
          <span className="g2-ok">{t.providers.routingSaved}</span>
        ) : state === "error" ? (
          <span className="g2-fail">
            {errorKey === "unauthorized" ? t.providers.routingUnauthorized : t.providers.routingFailed}
          </span>
        ) : null}
      </p>
    </section>
  );
}
