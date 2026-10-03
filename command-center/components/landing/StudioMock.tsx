import {
  AudioLines,
  Coins,
  Film,
  Image as ImageIcon,
  Mic,
  Play,
  RotateCcw,
  Scissors,
  ShieldCheck,
  Sparkles,
  Wand2,
  ZoomIn,
} from "lucide-react";
import type { Dictionary } from "@/lib/i18n";

/** Bar heights of the voice card's waveform, in percent. Decorative. */
const WAVE = [28, 52, 74, 46, 90, 62, 38, 70, 96, 58, 34, 66, 84, 50, 30, 60, 78, 44, 26, 54, 72, 40];

/** A per-element load-in delay for the .lp-in animation (globals.css). */
const delay = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

/**
 * The hero's product picture: the Studio as a signed-in customer sees it
 * (Studio v3) — the composer on the left with its tool tabs, model, prompt,
 * shape and the one Generate action, and on the right the results grid with
 * each card's status, including one whose credits came back. A finished video
 * waiting for approval floats over it.
 *
 * Built from HTML and CSS only (globals.css "Public landing v3"): no image
 * file, no external host, no provider or model name. It is labelled an
 * illustration and carries no price, balance or count — the Generate button
 * says where the price will appear instead of inventing one. The whole
 * picture is one labelled image for assistive tech; the parts inside are
 * hidden from it and none of them is focusable.
 *
 * The load-in (panels rising in turn, the prompt typing itself, the sweep on
 * the card still being made) runs only under prefers-reduced-motion:
 * no-preference; the still frame is the complete picture.
 */
export function StudioMock({ t }: { t: Dictionary }) {
  const m = t.landing.mock;
  return (
    <figure role="img" aria-label={m.label} className="lp-mock relative w-full min-w-0">
      <div
        aria-hidden
        className="lp-in overflow-hidden rounded-[24px] border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[var(--shadow-elevated)]"
        style={delay(0.1)}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2.5">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-[var(--color-border)]" />
            <span className="size-2.5 rounded-full bg-[var(--color-border)]" />
            <span className="size-2.5 rounded-full bg-[var(--color-border)]" />
          </span>
          <span className="text-xs font-medium">{m.title}</span>
          <span className="tnum pill whitespace-nowrap border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted)]">
            {m.tag}
          </span>
        </div>

        <div className="grid gap-3 p-3 sm:gap-4 sm:p-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <Composer t={t} />
          <Results t={t} />
        </div>
      </div>

      <div
        aria-hidden
        className="lp-in glass-card mt-3 flex items-center gap-3 rounded-2xl border border-[var(--color-border)] p-3 shadow-[var(--shadow-elevated)] lg:absolute lg:-bottom-7 lg:right-8 lg:mt-0 lg:w-[21rem]"
        style={delay(1.3)}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-primary)]">
          <ShieldCheck className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{m.approvalTitle}</span>
          <span className="block truncate text-xs text-[var(--color-muted)]">{m.approvalBody}</span>
        </span>
        <span className="pill shrink-0 bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-on-accent)]">
          {m.approve}
        </span>
      </div>
    </figure>
  );
}

function Composer({ t }: { t: Dictionary }) {
  const m = t.landing.mock;
  const tabs = [
    { icon: ImageIcon, label: m.tabs.image, on: true },
    { icon: Film, label: m.tabs.video, on: false },
    { icon: Mic, label: m.tabs.voice, on: false },
  ];
  const tools = [
    { icon: Wand2, label: m.tools.edit },
    { icon: Play, label: m.tools.animate },
    { icon: ZoomIn, label: m.tools.upscale },
    { icon: Scissors, label: m.tools.cutout },
  ];
  return (
    <div className="studio-surface lp-in flex min-w-0 flex-col gap-3 p-3 sm:p-4" style={delay(0.25)}>
      <div className="grid grid-cols-3 gap-1 rounded-[14px] bg-[var(--studio-field)] p-1">
        {tabs.map(({ icon: Icon, label, on }) => (
          <span key={label} className={`lp-tab ${on ? "is-on" : ""}`}>
            <Icon className="size-4" />
            <span className="max-w-full truncate">{label}</span>
          </span>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1 border-b border-[var(--color-border)] pb-2">
        {tools.map(({ icon: Icon, label }) => (
          <span key={label} className="flex min-w-0 flex-col items-center gap-1 py-1 text-xs text-[var(--color-muted)]">
            <Icon className="size-3.5" />
            <span className="max-w-full truncate">{label}</span>
          </span>
        ))}
      </div>

      <div className="studio-field flex items-center gap-3 px-3 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--studio-raised)] text-[var(--color-primary)]">
          <Sparkles className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="studio-label block">{m.model}</span>
          <span className="block truncate text-xs font-medium">{m.modelValue}</span>
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="studio-label">{m.describe}</span>
        <div className="studio-field flex min-h-[100px] flex-col justify-between gap-3 p-3">
          <p className="lp-type text-sm leading-snug">
            {m.prompt}
            <span className="lp-caret ml-0.5 inline-block h-[1.05em] w-px translate-y-[0.18em] bg-[var(--color-primary)]" />
          </p>
          <span className="lp-seg self-start">
            <span className="is-on">16:9</span>
            <span>9:16</span>
            <span>1:1</span>
          </span>
        </div>
      </div>

      <div className="hidden flex-col gap-1.5 sm:flex">
        <span className="studio-label">{m.style}</span>
        <div className="flex flex-wrap gap-1.5">
          {m.styles.map((s, i) => (
            <span
              key={s}
              className={`studio-chip min-h-7 text-xs ${
                i === 0 ? "border-[var(--color-primary)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]" : ""
              }`}
            >
              {s}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <span className="studio-cta min-h-11 text-sm">
          <Sparkles className="size-4" />
          {m.generate}
        </span>
        <span className="flex items-center justify-center gap-1.5 text-center text-xs text-[var(--color-muted)]">
          <Coins className="size-3.5 shrink-0 text-[var(--color-primary)]" />
          {m.priceNote}
        </span>
      </div>
    </div>
  );
}

function Results({ t }: { t: Dictionary }) {
  const m = t.landing.mock;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3 px-1 pt-1">
        <span className="text-sm font-semibold">{m.results}</span>
        <span className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          <span className="lp-pulse size-1.5 rounded-full bg-[var(--color-primary)]" />
          {m.live}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-3">
        <Card d={0.45} kind={m.kinds.video} icon={Film} status={m.making} tone="run" caption={m.captions.forest}>
          <span className="lp-art lp-making">
            <span className="lp-art-forest absolute inset-0 overflow-hidden opacity-40" />
            <span className="absolute inset-x-2.5 bottom-2.5 h-1 overflow-hidden rounded-full bg-white/25">
              <span className="lp-progress block h-full rounded-full bg-[var(--color-primary)]" />
            </span>
          </span>
        </Card>
        <Card d={0.55} kind={m.kinds.image} icon={ImageIcon} status={m.ready} tone="ok" caption={m.captions.sunset}>
          <span className="lp-art lp-art-sunset" />
        </Card>
        <Card d={0.65} kind={m.kinds.upscale} icon={ZoomIn} status={m.ready} tone="ok" caption={m.captions.upscale}>
          <span className="lp-art lp-art-portrait">
            <span className="absolute inset-y-0 left-0 w-1/2 backdrop-blur-[3px]" />
            <span className="absolute inset-y-0 left-1/2 w-px bg-white/80" />
            <span className="studio-on-media absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-xs font-medium">
              {m.before}
            </span>
            <span className="studio-on-media absolute right-2 top-2 rounded-md px-1.5 py-0.5 text-xs font-medium">
              {m.after}
            </span>
          </span>
        </Card>
        <Card d={0.75} kind={m.kinds.voice} icon={AudioLines} status={m.ready} tone="ok" caption={m.captions.voice}>
          {/* .lp-art is display:block (globals.css), so the row lays out on an inner box. */}
          <span className="lp-art bg-[var(--color-accent-soft)]">
            <span className="absolute inset-0 flex items-center justify-center gap-[3px] px-3">
              {WAVE.map((h, i) => (
                <span
                  key={i}
                  className="lp-wave w-[3px] rounded-full bg-[var(--color-primary)]"
                  style={{ height: `${h * 0.6}%`, animationDelay: `${(i % 7) * 0.12}s` }}
                />
              ))}
            </span>
          </span>
        </Card>
        <Card d={0.85} kind={m.kinds.video} icon={Film} status={m.ready} tone="ok" caption={m.prompt} hideOnPhone>
          <span className="lp-art lp-art-sea">
            <span className="lp-beam" />
            <span className="lp-tower" />
            <span className="absolute inset-0 grid place-items-center">
              <span className="grid size-8 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
                <Play className="ml-0.5 size-3.5" fill="currentColor" />
              </span>
            </span>
          </span>
        </Card>
        <Card d={0.95} kind={m.kinds.cutout} icon={Scissors} status={null} tone="ok" caption={m.captions.failed} hideOnPhone>
          <span className="lp-art border border-dashed border-[color-mix(in_srgb,var(--color-fail)_55%,transparent)] bg-[var(--studio-field)]">
            <span className="absolute inset-0 flex items-center justify-center gap-1.5 px-2 text-center text-xs font-medium text-[var(--color-ok)]">
              <RotateCcw className="size-3.5 shrink-0" />
              {m.returned}
            </span>
          </span>
        </Card>
      </div>
    </div>
  );
}

function Card({
  kind,
  icon: Icon,
  status,
  tone,
  caption,
  d,
  hideOnPhone = false,
  children,
}: {
  kind: string;
  icon: typeof Film;
  /** null: the artwork itself says what happened (the returned-credits card). */
  status: string | null;
  tone: "ok" | "run";
  caption: string;
  d: number;
  /** Two of the six cards stay off a phone, so the picture keeps its height. */
  hideOnPhone?: boolean;
  children: React.ReactNode;
}) {
  const color = tone === "ok" ? "var(--color-ok)" : "var(--color-primary)";
  return (
    <span
      className={`lp-in min-w-0 flex-col gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 ${
        hideOnPhone ? "hidden sm:flex" : "flex"
      }`}
      style={delay(d)}
    >
      {children}
      <span className="flex flex-col gap-1 px-1.5 pb-1">
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
            <Icon className="size-3.5 shrink-0 text-[var(--color-muted)]" />
            {/* On a phone the icon names the kind; the status needs the room. */}
            <span className={`truncate ${status ? "hidden sm:inline" : ""}`}>{kind}</span>
          </span>
          {status && (
            <span
              className="tnum flex shrink-0 items-center gap-1 text-xs font-medium"
              style={{ color }}
            >
              <span className={`size-1.5 rounded-full ${tone === "run" ? "lp-pulse" : ""}`} style={{ background: color }} />
              {status}
            </span>
          )}
        </span>
        <span className="truncate text-xs text-[var(--color-muted)]">{caption}</span>
      </span>
    </span>
  );
}
